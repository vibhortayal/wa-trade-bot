// Trade Flow bot server — setup & control UI.
// Serves public/ and a small JSON API. No npm dependencies (node built-ins only).
//
// API:
//   GET  /api/status            connection + pipeline state
//   POST /api/pair   {phone}   request a WhatsApp pairing code (one-time)
//   POST /api/keys   {gemini_key?, supabase_url?, supabase_service_key?,
//                     group_query?, reset?:[ENV_KEY...]}
//   GET  /api/config            current config (secrets masked, never raw)
//   POST /api/run              trigger a pull->parse->push cycle now
//   GET  /api/logs             tail of the cycle log
//
// Auth: if ADMIN_PASSWORD is set (required for 0.0.0.0 binds), all routes
// require HTTP Basic auth with any username and that password.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = __dirname;
const PORT = parseInt(process.env.BOT_PORT || '3001', 10);
const BIND = process.env.BOT_BIND || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (BIND !== '127.0.0.1' && !ADMIN_PASSWORD) {
  console.error('Refusing to bind %s without ADMIN_PASSWORD set.', BIND);
  process.exit(1);
}

// ---- tiny .env loader (KEY=VALUE lines, quote-aware) ----
// Values containing whitespace or shell-special chars are stored double-quoted
// (see envQuote); the loader strips one layer of matching quotes so bash,
// systemd EnvironmentFile, and this loader all agree on the value.
function envQuote(val) {
  if (/[\s"'`$\\#]/.test(val))
    return '"' + val.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return val;
}
function unquoteEnv(v) {
  v = v.trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"')
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'")
    return v.slice(1, -1);
  return v;
}
function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = unquoteEnv(m[2]);
  }
}
loadEnvFile();
// Read the .env file fresh (for the setup UI), without touching process.env.
function readEnvFile() {
  const env = {};
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)\s*$/);
    if (m) env[m[1]] = unquoteEnv(m[2]);
  }
  return env;
}

const pairing = { state: 'idle', code: null, codeAt: 0, error: null, client: null };
// idle|starting|waiting|paired|failed. The READY marker is the durable proof of
// a completed link: it is written only after WhatsApp fires 'ready', and
// deleted on force re-pair / auth failure. Session files alone mean nothing
// (Chromium creates them before any pairing completes).
const READY_MARKER = path.join(ROOT, '.wwebjs_auth', 'READY');

function log(msg) {
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(ROOT, 'logs', 'server.log'),
      new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}

function waPaired() {
  try { return fs.existsSync(READY_MARKER); } catch { return false; }
}

function killStrayBrowsers() {
  // A leftover pairing/read Chromium holding the LocalAuth profile lock makes
  // a fresh client.initialize() fail. Clear them before (re)pairing.
  // (Bracket trick: keeps pkill from matching its own command line.)
  for (const pat of ['[w]webjs_auth', '[n]ode read.js']) {
    try { execSync(`pkill -f "${pat}" 2>/dev/null || true`); } catch {}
  }
}

async function destroyPairingClient() {
  if (pairing.client) {
    const c = pairing.client; pairing.client = null;
    try { await c.destroy(); } catch {}
  }
}

function resetPairing() {
  pairing.state = 'idle'; pairing.code = null; pairing.codeAt = 0; pairing.error = null;
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
    wa_paired: waPaired(),
    pairing: pairing.state,
    pairing_code: pairing.state === 'waiting' ? pairing.code : null,
    pairing_error: pairing.error,
    last_pull: lastPull,
    parsed_messages: trades.length,
    parsed_actions: actions,
    last_parse: fs.existsSync(tradesPath) ? fs.statSync(tradesPath).mtime.toISOString() : null,
    llm_configured: !!(process.env.LLM_API_BASE || process.env.GEMINI_API_KEY),
    supabase_configured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    tv_connected: await tvConnected(),
    market_data_provider: process.env.MARKET_DATA_PROVIDER || 'tradingview',
    log_tail: tailFile(path.join(ROOT, 'logs', 'cycle.log')),
  };
}

// ---- WhatsApp pairing (one-time). Runs in the background: the page polls
// /api/status for the code and for completion. The client is destroyed only
// after 'ready' (destroying on 'authenticated' loses the session), and a READY
// marker file records the completed link durably. ----
async function startPairing(phone, force) {
  await destroyPairingClient();
  killStrayBrowsers();
  if (force) {
    try { fs.rmSync(path.join(ROOT, '.wwebjs_auth'), { recursive: true, force: true }); } catch {}
    resetPairing();
  }
  if (pairing.state === 'waiting' && pairing.client) {
    // A code is already out — refresh it if it's stale (codes expire fast).
    if (pairing.code && Date.now() - pairing.codeAt < 90000) return;
    try {
      pairing.code = await pairing.client.requestPairingCode(phone);
      pairing.codeAt = Date.now(); pairing.error = null;
      log('pairing code refreshed');
    } catch (e) {
      pairing.state = 'failed'; pairing.error = e.message;
      await destroyPairingClient();
    }
    return;
  }
  resetPairing();
  pairing.state = 'starting';
  log('pairing start (force=' + force + ')');
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  if (process.env.USE_PROXY === '1') args.push('--proxy-server=http://127.0.0.1:18080', '--ignore-certificate-errors');

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(ROOT, '.wwebjs_auth') }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
      args,
    },
  });
  pairing.client = client;
  const fail = async (msg) => {
    log('pairing failed: ' + msg);
    pairing.state = 'failed'; pairing.error = msg;
    await destroyPairingClient();
  };
  client.on('code', (code) => {
    pairing.state = 'waiting'; pairing.code = code; pairing.codeAt = Date.now(); pairing.error = null;
    log('pairing code issued');
    // Watchdog: codes expire; don't hold Chromium forever if the user walks away.
    setTimeout(async () => {
      if (pairing.state === 'waiting' && pairing.client === client) {
        log('pairing code expired without completion, cleaning up');
        await destroyPairingClient();
        resetPairing();
      }
    }, 4 * 60 * 1000).unref();
  });
  // NOTE: never destroy on 'authenticated' — the session only flushes to disk on 'ready'.
  client.on('authenticated', () => { log('pairing client authenticated (waiting for ready)'); });
  client.on('ready', async () => {
    log('pairing client ready — link verified');
    try { fs.writeFileSync(READY_MARKER, new Date().toISOString()); } catch {}
    pairing.state = 'paired'; pairing.code = null; pairing.error = null;
    await new Promise((r) => setTimeout(r, 2000)); // let the profile flush
    await destroyPairingClient();
  });
  client.on('auth_failure', async (m) => {
    try { fs.rmSync(READY_MARKER, { force: true }); } catch {}
    await fail('auth_failure: ' + m);
  });
  client.on('disconnected', async (r) => {
    log('pairing client disconnected: ' + r);
    try { fs.rmSync(READY_MARKER, { force: true }); } catch {}
    if (pairing.state !== 'paired') await fail('disconnected: ' + r);
    else await destroyPairingClient();
  });
  try {
    await client.initialize();
  } catch (e) {
    await fail('initialize failed: ' + e.message);
    return;
  }
  // Cold starts need a moment before WhatsApp Web accepts the code request.
  await new Promise((r) => setTimeout(r, 5000));
  if (pairing.client !== client) return; // cleaned up while initializing
  try {
    const code = await client.requestPairingCode(phone);
    pairing.state = 'waiting'; pairing.code = code; pairing.codeAt = Date.now();
    log('pairing code issued');
  } catch (e) {
    await fail('requestPairingCode failed: ' + e.message);
  }
}

// ---- HTTP plumbing ----
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
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
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
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
      const force = body.force === true;
      // Genuinely linked (READY marker present)? Nothing to do.
      if (!force && waPaired()) return send(res, 200, { already: true });
      // Otherwise start clean: stale session files without a completed link are
      // wiped automatically. The page polls /api/status for the code and result.
      startPairing(phone, true).catch((e) => {
        pairing.state = 'failed'; pairing.error = e.message;
      });
      return send(res, 200, { started: true });
    }

    if (req.method === 'POST' && url === '/api/keys') {
      const body = await readBody(req);
      const map = {
        gemini_key: 'GEMINI_API_KEY',
        llm_api_base: 'LLM_API_BASE',
        llm_api_key: 'LLM_API_KEY',
        llm_model: 'LLM_MODEL',
        supabase_url: 'SUPABASE_URL',
        supabase_service_key: 'SUPABASE_SERVICE_KEY',
        group_query: 'WA_GROUP_QUERY',
        market_data_provider: 'MARKET_DATA_PROVIDER',
      };
      const envPath = path.join(ROOT, '.env');
      let lines = [];
      try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); } catch {}
      const saved = [], cleared = [];
      const resetList = Array.isArray(body.reset) ? body.reset : [];
      for (const [field, envKey] of Object.entries(map)) {
        const idx = lines.findIndex((l) => l.startsWith(envKey + '='));
        if (resetList.includes(envKey)) {
          if (idx >= 0) lines.splice(idx, 1);
          delete process.env[envKey];
          cleared.push(field);
          continue;
        }
        const val = String(body[field] || '').trim();
        if (!val) continue;
        process.env[envKey] = val; // live for this process
        const line = `${envKey}=${envQuote(val)}`;
        if (idx >= 0) lines[idx] = line; else lines.push(line);
        saved.push(field);
      }
      fs.writeFileSync(envPath, lines.filter((l) => l.trim()).join('\n') + '\n', { mode: 0o600 });
      return send(res, 200, { saved, cleared });
    }

    // Current configuration for the setup UI. Secrets are never returned —
    // only whether they're set plus a masked hint.
    if (req.method === 'GET' && url === '/api/config') {
      const env = readEnvFile();
      const hint = (v) => v ? '••••' + String(v).slice(-4) : '';
      return send(res, 200, {
        gemini_key: { set: !!env.GEMINI_API_KEY, hint: hint(env.GEMINI_API_KEY) },
        llm_api_base: { set: !!env.LLM_API_BASE, value: env.LLM_API_BASE || '' },
        llm_api_key: { set: !!env.LLM_API_KEY, hint: hint(env.LLM_API_KEY) },
        llm_model: { set: !!env.LLM_MODEL, value: env.LLM_MODEL || '' },
        supabase_url: { set: !!env.SUPABASE_URL, value: env.SUPABASE_URL || '' },
        supabase_service_key: { set: !!env.SUPABASE_SERVICE_KEY, hint: hint(env.SUPABASE_SERVICE_KEY) },
        group_query: { set: !!env.WA_GROUP_QUERY, value: env.WA_GROUP_QUERY || '' },
        market_data_provider: { set: !!env.MARKET_DATA_PROVIDER,
                                value: env.MARKET_DATA_PROVIDER || 'tradingview' },
      });
    }

    if (req.method === 'POST' && url === '/api/run') {
      const log = path.join(ROOT, 'logs', 'cycle.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      const out = fs.openSync(log, 'a');
      const child = spawn('bash', [path.join(ROOT, 'run-cycle.sh')], {
        detached: true, stdio: ['ignore', out, out],
        // A manual run is an explicit user action: bypass the 06:00-18:00 gate.
        env: { ...process.env, MANUAL_RUN: '1' },
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
