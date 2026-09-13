// Trade Flow bot server — setup & control UI.
// Serves public/ and a small JSON API. No npm dependencies (node built-ins only).
//
// API:
//   GET  /api/status            connection + pipeline state
//   POST /api/pair   {phone}   request a WhatsApp pairing code (one-time)
//   POST /api/keys   {gemini_key?, supabase_url?, supabase_service_key?}
//   POST /api/run              trigger a pull->parse->push cycle now
//   GET  /api/logs             tail of the cycle log
//
// Auth: if ADMIN_PASSWORD is set (required for 0.0.0.0 binds), all routes
// require HTTP Basic auth with any username and that password.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = parseInt(process.env.BOT_PORT || '3001', 10);
const BIND = process.env.BOT_BIND || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (BIND !== '127.0.0.1' && !ADMIN_PASSWORD) {
  console.error('Refusing to bind %s without ADMIN_PASSWORD set.', BIND);
  process.exit(1);
}

// ---- tiny .env loader (KEY=VALUE lines, no quoting games) ----
function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile();

const pairing = { state: 'idle', code: null, error: null }; // idle|waiting|paired|failed

function sessionExists() {
  try {
    const dir = path.join(ROOT, '.wwebjs_auth');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [1]);
    return walk(dir).length > 0;
  } catch { return false; }
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function tailFile(p, n = 80) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

// ---- TradingView (outcome scoring). Vendored CLI at vendor/tradingview/tv.py;
// OAuth tokens live in ~/.config/tradingview-mcp on this machine. ----
const TV_PY = path.join(ROOT, 'vendor', 'tradingview', 'tv.py');
const TV_CWD = path.join(ROOT, 'vendor', 'tradingview');
function tvRun(args) {
  return new Promise((resolve) => {
    const p = spawn('python3', [TV_PY, ...args], { cwd: TV_CWD });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.on('error', (e) => resolve({ code: -1, out: '', err: String(e) }));
  });
}
async function tvConnected() {
  try {
    const r = await tvRun(['status']);
    return /authorized:\s*True/.test(r.out);
  } catch { return false; }
}

async function getStatus() {
  const tradesPath = path.join(ROOT, 'data', 'trades.json');
  const trades = readJson(tradesPath, []);
  const actions = trades.reduce((a, m) => a + (m.trades || []).length, 0);
  let lastPull = null;
  try {
    const st = fs.statSync(path.join(ROOT, 'data', 'messages.jsonl'));
    lastPull = st.mtime.toISOString();
  } catch {}
  return {
    wa_paired: sessionExists(),
    pairing: pairing.state,
    pairing_error: pairing.error,
    last_pull: lastPull,
    parsed_messages: trades.length,
    parsed_actions: actions,
    last_parse: fs.existsSync(tradesPath) ? fs.statSync(tradesPath).mtime.toISOString() : null,
    gemini_configured: !!(process.env.GEMINI_API_KEY),
    supabase_configured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    tv_connected: await tvConnected(),
    log_tail: tailFile(path.join(ROOT, 'logs', 'cycle.log')),
  };
}

// ---- WhatsApp pairing (one-time). Keeps the client alive until the user
// types the code on their phone; 'ready' then flushes the session to disk. ----
async function startPairing(phone) {
  if (sessionExists()) { pairing.state = 'paired'; return { already: true }; }
  if (pairing.state === 'waiting') return { code: pairing.code };
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const USE_PROXY = process.env.USE_PROXY === '1';
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  if (USE_PROXY) args.push('--proxy-server=http://127.0.0.1:18080', '--ignore-certificate-errors');

  pairing.state = 'waiting'; pairing.code = null; pairing.error = null;
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(ROOT, '.wwebjs_auth') }),
    puppeteer: { headless: true, args },
  });
  const cleanup = async () => { try { await client.destroy(); } catch {} };
  client.on('auth_failure', async (m) => {
    pairing.state = 'failed'; pairing.error = String(m);
    await cleanup();
  });
  const onReady = async () => {
    pairing.state = 'paired';
    await cleanup(); // clean shutdown flushes the Chrome profile to disk
  };
  client.on('authenticated', onReady);
  client.on('ready', onReady);
  client.on('disconnected', async (r) => {
    if (pairing.state === 'waiting') { pairing.state = 'failed'; pairing.error = String(r); }
    await cleanup();
  });
  await client.initialize();
  await new Promise((r) => setTimeout(r, 8000));
  pairing.code = await client.requestPairingCode(phone);
  // client stays alive until the phone completes pairing (see onReady)
  return { code: pairing.code };
}

// ---- HTTP plumbing ----
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, 'public', p));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'forbidden' });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } });
  });
}
function checkAuth(req, res) {
  if (!ADMIN_PASSWORD) return true;
  const h = req.headers.authorization || '';
  const m = h.match(/^Basic (.+)$/);
  if (!m) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="trade-flow-bot"' });
    res.end('auth required');
    return false;
  }
  const pass = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
  if (pass !== ADMIN_PASSWORD) { send(res, 403, { error: 'wrong password' }); return false; }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!checkAuth(req, res)) return;
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/api/status') return send(res, 200, await getStatus());

    if (req.method === 'POST' && url === '/api/tv-auth-start') {
      const r = await tvRun(['auth', '--start']);
      const m = r.out.match(/https:\/\/www\.tradingview\.com\/mcp\/oauth\/authorize\?[^\s"']+/);
      if (!m) return send(res, 500, { error: (r.err || r.out || 'auth start failed').slice(0, 300) });
      return send(res, 200, { url: m[0] });
    }

    if (req.method === 'POST' && url === '/api/tv-auth-callback') {
      const body = await readBody(req);
      const cb = String(body.url || '').trim();
      if (!/^https?:\/\/\S*code=\S+/.test(cb)) {
        return send(res, 400, { error: 'paste the full callback URL containing ?code=…' });
      }
      const r = await tvRun(['auth', '--callback', cb]);
      if (r.code !== 0) return send(res, 500, { error: (r.err || r.out || 'callback failed').slice(0, 300) });
      return send(res, 200, { ok: true, connected: await tvConnected() });
    }

    if (req.method === 'GET' && url === '/api/logs') {
      return send(res, 200, { log: tailFile(path.join(ROOT, 'logs', 'cycle.log'), 120) });
    }

    if (req.method === 'POST' && url === '/api/pair') {
      const body = await readBody(req);
      const phone = String(body.phone || '').replace(/\D/g, '');
      if (!/^\d{7,15}$/.test(phone)) return send(res, 400, { error: 'phone must be 7-15 digits with country code' });
      try {
        const r = await startPairing(phone);
        return send(res, 200, r);
      } catch (e) {
        pairing.state = 'failed'; pairing.error = e.message;
        return send(res, 500, { error: e.message });
      }
    }

    if (req.method === 'POST' && url === '/api/keys') {
      const body = await readBody(req);
      const map = {
        gemini_key: 'GEMINI_API_KEY',
        supabase_url: 'SUPABASE_URL',
        supabase_service_key: 'SUPABASE_SERVICE_KEY',
      };
      const envPath = path.join(ROOT, '.env');
      let lines = [];
      try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
      const saved = [];
      for (const [field, envKey] of Object.entries(map)) {
        const val = String(body[field] || '').trim();
        if (!val) continue;
        process.env[envKey] = val; // live for this process
        const idx = lines.findIndex((l) => l.startsWith(envKey + '='));
        const line = `${envKey}=${val}`;
        if (idx >= 0) lines[idx] = line; else lines.push(line);
        saved.push(field);
      }
      fs.writeFileSync(envPath, lines.filter((l) => l.trim()).join('\n') + '\n', { mode: 0o600 });
      return send(res, 200, { saved });
    }

    if (req.method === 'POST' && url === '/api/run') {
      const log = path.join(ROOT, 'logs', 'cycle.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      const out = fs.openSync(log, 'a');
      const child = spawn('bash', [path.join(ROOT, 'run-cycle.sh')], {
        detached: true, stdio: ['ignore', out, out], env: process.env,
      });
      child.unref();
      return send(res, 200, { started: true });
    }

    if (req.method === 'GET') return serveStatic(req, res);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[bot] setup UI on http://${BIND}:${PORT}  (auth ${ADMIN_PASSWORD ? 'on' : 'off'})`);
});
