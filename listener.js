// listener.js — persistent WhatsApp listener for the trade reader.
//
// Replaces the old connect→read→disconnect hourly pattern (which got the
// linked device's message sync paused by WhatsApp) with a single always-on
// browser session — the way WhatsApp expects a linked device to behave,
// like the desktop app.
//
// What it does:
//   - connects once and stays connected (supervised by systemd:
//     wa-trade-listener.service, Restart=always)
//   - on (re)connect, backfills every message since the checkpoint in
//     data/state.json (same scan logic as the old read.js one-shot pull)
//   - re-scans every 60s and on every incoming group message, appending new
//     messages to data/messages.jsonl in the same schema read.js used
//   - writes data/listener-heartbeat.json every minute; run-cycle.sh
//     restarts the service if the heartbeat goes stale
//   - does one graceful restart per day after 07:00 ET for a fresh Chromium
//     (systemd restarts it; the backfill covers the ~1-2 min gap)
//
// The hourly run-cycle.sh no longer touches the browser at all — it only
// parses, scores, and pushes. A manual one-shot read (read.js) must not run
// while the listener holds the LocalAuth profile lock; read.js refuses with
// a clear error if the listener heartbeat is fresh.
const { Client, LocalAuth } = require('whatsapp-web.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ensureProxy = require('./ensure-proxy');

const DATA = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA, 'messages.jsonl');
const STATE_FILE = path.join(DATA, 'state.json');
const HEARTBEAT_FILE = path.join(DATA, 'listener-heartbeat.json');
fs.mkdirSync(DATA, { recursive: true });

// On Hatch the VM needs the local CONNECT forwarder for Chromium egress.
// On a self-hosted box with direct internet, leave USE_PROXY unset.
const USE_PROXY = process.env.USE_PROXY === '1';
const GROUP_QUERY = (process.env.WA_GROUP_QUERY || 'your group name').toLowerCase();

// Ingestion guardrail (same as read.js): cap new messages per scan.
let CAP = parseInt(process.env.MAX_MESSAGES_PER_CYCLE || '200', 10);
if (!Number.isFinite(CAP)) CAP = 200;
CAP = Math.min(1000, Math.max(1, CAP));

const SCAN_INTERVAL_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
if (USE_PROXY) puppeteerArgs.push('--proxy-server=http://127.0.0.1:18080', '--ignore-certificate-errors');

// Browser binary: puppeteer's bundled Chrome may be missing/wrong-arch.
// Fall back to the snap Chromium REAL binary — not /snap/bin/chromium, whose
// snap-launcher wrapper fails under systemd (the listener always runs as a
// systemd service). UA is spoofed by wwebjs anyway.
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  const SNAP_CHROME = '/snap/chromium/current/usr/lib/chromium-browser/chrome';
  try {
    fs.accessSync(SNAP_CHROME, fs.constants.X_OK);
    process.env.PUPPETEER_EXECUTABLE_PATH = SNAP_CHROME;
    console.log('[listener] using snap Chromium:', SNAP_CHROME);
  } catch (e) { /* leave unset: puppeteer's default */ }
}

let client = null;
let targetGroup = null; // {id, name}, resolved on ready
let scanning = false;
let shuttingDown = false;
let totalIngested = 0;
let lastIngestedAt = null;
let disconnectResolve = null;
let scanTimer = null;

// ---- state / dedup (same schema as read.js) ----
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}
// Identity dedup (not just timestamp): >= on the checkpoint is needed
// because timestamps are second-resolution, so a re-scan can return a
// message already on disk. msgKeys prefers the WhatsApp message id and
// always includes a content hash (sender + second + body + quoted body).
const msgKeys = (m) => {
  const q = (m.quoted && (m.quoted.body || '')) || '';
  const h = 'h:' + crypto.createHash('sha1')
    .update([m.senderId || '', String(m.t || ''), m.body || '', q].join('\n'))
    .digest('hex').slice(0, 16);
  return m.id ? ['wa:' + m.id, h] : [h];
};

function heartbeat(status) {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      at: new Date().toISOString(),
      at_ts: Math.floor(Date.now() / 1000),
      pid: process.pid,
      status: status || 'ok',
      group: targetGroup && targetGroup.name,
      total_ingested: totalIngested,
      last_ingested_at: lastIngestedAt,
    }));
  } catch (e) { /* best effort */ }
}

// whatsapp-web.js can throw a "Target closed" race during teardown: its own
// disconnect listener evaluates on the page while the browser is closing, and
// the throw escapes destroy()'s promise via the event emitter.
let intendedExit = 0;
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err);
  if (/Target closed|Target destroyed/i.test(msg)) {
    console.error('[listener] teardown race (ignoring):', msg.split('\n')[0]);
    process.exit(intendedExit);
  }
  console.error('[listener] FATAL:', err);
  process.exit(1);
});

// One ingest scan: walk the target group's messages back past the checkpoint,
// serialize (same as read.js), dedup, append new ones oldest-first.
async function scanAndIngest(reason) {
  if (scanning || shuttingDown || !client || !targetGroup) return;
  scanning = true;
  try {
    const state = loadState();
    const sinceTs = state['lastTs:' + targetGroup.id] || 0;
    // Bound the backward scan: 5x the cap, max 3000 messages.
    const scanCap = Math.min(CAP * 5, 3000);
    const res = await client.pupPage.evaluate(async (groupId, scanCap, sinceTs) => {
      const W = window.require;
      const chat = W('WAWebCollections').Chat.get(W('WAWebWidFactory').createWid(groupId));
      if (!chat) return { messages: null, err: 'chat not in collection' };
      let msgs = chat.msgs.getModelsArray().filter((m) => !m.isNotification);
      let guard = 0, newOnes = 1;
      while (msgs.length < scanCap && guard++ < 60 && newOnes > 0) {
        const oldest = msgs.reduce((m, x) => Math.min(m, x.t || Infinity), Infinity);
        if (oldest < sinceTs) break;
        let loaded = [];
        try { loaded = await W('WAWebChatLoadMessages').loadEarlierMsgs({ chat }); } catch (e) { break; }
        newOnes = (loaded || []).filter((m) => !m.isNotification).length;
        if (newOnes) msgs = [...loaded.filter((m) => !m.isNotification), ...msgs];
        else break;
      }
      msgs.sort((a, b) => a.t - b.t);
      const truncated = msgs.length >= scanCap && msgs.length > 0 && msgs[0].t >= sinceTs;

      const Contacts = W('WAWebCollections').Contact;
      // Visible text of a message. Media messages carry it in `caption`;
      // after a caption *edit*, WA Web leaves the thumbnail bytes in `body`,
      // so prefer `caption` and never treat a base64 blob as message text.
      const BLOB_RE = /^[A-Za-z0-9+/]{120,}={0,2}$/;
      const visibleText = (o) => {
        const t = ((o && (o.caption || o.body)) || '').trim();
        return BLOB_RE.test(t) ? '' : t;
      };
      const out = msgs.map((m) => {
        // capture quoted BEFORE serialize (serialize() consumes __x_ props on the raw model)
        let rawQuoted = null, rawQuotedParticipant = null;
        try { rawQuoted = m.__x_quotedMsg || null; rawQuotedParticipant = m.__x_quotedParticipant || null; } catch (e) {}
        let quoted = null;
        try {
          if (rawQuoted) {
            // __x_quotedMsg is already a plain data object (no .serialize())
            const qid = rawQuoted.id;
            quoted = { id: (qid && qid._serialized) || String(qid || ''),
                       body: visibleText(rawQuoted),
                       senderId: (rawQuoted.author && rawQuoted.author._serialized) || String(rawQuoted.author || '') ||
                                 (rawQuotedParticipant && rawQuotedParticipant._serialized) || null,
                       t: rawQuoted.t || null };
          }
        } catch (e) { /* ignore */ }
        const s = window.WWebJS.getMessageModel(m);
        let senderName = m.notifyName || null;
        let senderId = null;
        try {
          const a = m.author || m.from;
          senderId = (a && a._serialized) || String(a);
          const c = Contacts.get(a);
          if (c) senderName = c.pushname || c.name || c.verifiedName || senderName;
        } catch (e) { /* ignore */ }
        return {
          id: (s.id && s.id._serialized) || null,
          t: s.t, ts: s.t * 1000,
          fromMe: s.id && s.id.fromMe,
          authorId: s.author,
          senderId, senderName,
          type: s.type, body: visibleText(s),
          hasMedia: !!s.hasMedia,
          quoted,
        };
      });
      return { messages: out, truncated };
    }, targetGroup.id, scanCap, sinceTs);

    if (!res.messages) { console.error('[listener] scan failed:', res.err); return; }
    const key = `lastTs:${targetGroup.id}`;
    const lastTs = state[key] || 0;
    const seen = new Set();
    try {
      for (const line of fs.readFileSync(MSG_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { for (const k of msgKeys(JSON.parse(line))) seen.add(k); }
        catch (e) { /* ignore bad lines */ }
      }
    } catch (e) { /* fresh file */ }
    const isNew = (m) => m.t >= lastTs && !msgKeys(m).some((k) => seen.has(k));
    const fresh = res.messages.filter(isNew);
    const toIngest = fresh.slice(0, CAP);
    for (const m of toIngest) for (const k of msgKeys(m)) seen.add(k);
    if (toIngest.length) {
      fs.appendFileSync(MSG_FILE,
        toIngest.map((m) => JSON.stringify({ group: targetGroup.name, groupId: targetGroup.id, ...m })).join('\n') + '\n');
      state[key] = Math.max(...toIngest.map((m) => m.t));
      totalIngested += toIngest.length;
      lastIngestedAt = new Date().toISOString();
      console.log(`[listener] +${toIngest.length} new message(s) (${reason}), checkpoint now ${state[key]}`);
    }
    state.ingestion = {
      cap: CAP, fresh: fresh.length, ingested: toIngest.length,
      deferred: fresh.length - toIngest.length,
      capped: fresh.length > CAP || !!res.truncated,
      truncated: !!res.truncated,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    if (res.truncated) console.log('[listener] WARNING: scan bound hit — older unseen messages skipped');
  } catch (e) {
    console.error('[listener] scan error:', e && e.message ? e.message : e);
  } finally {
    scanning = false;
  }
}

// ET calendar day (YYYY-MM-DD) — for the once-daily restart guard.
function etDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function etHour() {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(new Date()), 10) % 24;
}

async function onReady() {
  console.log('[listener] app ready, waiting for chat list sync...');
  let synced = false;
  for (let i = 0; i < 30 && !shuttingDown; i++) {
    const n = await client.pupPage.evaluate(
      () => window.require('WAWebCollections').Chat.getModelsArray().length
    ).catch(() => 0);
    if (n > 0) { console.log(`[listener] chat list synced (${n} chats)`); synced = true; break; }
    await sleep(10000);
  }
  if (!synced) throw new Error('chat list never synced');

  const groups = await client.pupPage.evaluate(() => {
    const W = window.require;
    return W('WAWebCollections').Chat.getModelsArray()
      .filter((c) => c.groupMetadata != null)
      .map((c) => ({ id: c.id._serialized, name: c.name || c.formattedTitle || '' }));
  });
  const matched = groups.filter((g) => g.name.toLowerCase().includes(GROUP_QUERY));
  if (!matched.length) {
    console.error('[listener] NO MATCH for query. Groups:');
    groups.forEach((g) => console.error('   -', g.name));
    throw new Error('no group matches query');
  }
  if (matched.length > 1) console.log('[listener] MULTIPLE matches, using first:', matched.map((g) => g.name).join(', '));
  targetGroup = matched[0];
  console.log(`[listener] watching group: ${targetGroup.name} (${targetGroup.id})`);

  await scanAndIngest('backfill');
  heartbeat('ok');

  // Steady state: scan + heartbeat every 60s. One graceful restart per day
  // after 07:00 ET keeps Chromium fresh (outside market hours).
  let restartedDay = etDay();
  await new Promise((resolve) => {
    disconnectResolve = () => { if (scanTimer) clearInterval(scanTimer); resolve(); };
    scanTimer = setInterval(async () => {
      if (shuttingDown) { disconnectResolve(); return; }
      if (etHour() >= 7 && etDay() !== restartedDay) {
        console.log('[listener] daily restart (past 07:00 ET)');
        restartedDay = etDay();
        shuttingDown = true;
        disconnectResolve();
        return;
      }
      await scanAndIngest('poll');
      heartbeat('ok');
    }, SCAN_INTERVAL_MS);
  });
}

function makeClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: { headless: true, args: puppeteerArgs },
  });
  c.on('auth_failure', (m) => {
    console.error('[listener] AUTH FAILURE:', m, '-- re-pair via the setup UI, then restart the listener');
    heartbeat('auth_failure');
    // This one needs a human: push an alert so it isn't found days later.
    try {
      const { execFileSync } = require('child_process');
      execFileSync('python3', [path.join(__dirname, 'alert.py'), 'listener_auth', 'failing',
        'Trade Flow: WhatsApp needs re-pairing',
        'Linked-device auth failed. Re-pair in the setup UI, then restart the listener.'], { timeout: 15000 });
    } catch (e) { /* best effort — alert failure must not mask the real error */ }
    intendedExit = 2;
    process.exit(2); // systemd StartLimitBurst stops the spin; human must re-pair
  });
  c.on('disconnected', (reason) => {
    console.log('[listener] disconnected:', reason);
    if (disconnectResolve) disconnectResolve();
  });
  // An incoming group message triggers an immediate re-scan (the 60s poll
  // is the backstop if the event is ever missed).
  c.on('message', async (msg) => {
    try {
      if (targetGroup && msg.from === targetGroup.id) {
        await sleep(3000); // let the chat collection settle
        await scanAndIngest('live message');
        heartbeat('ok');
      }
    } catch (e) { /* ignore */ }
  });
  return c;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (disconnectResolve) disconnectResolve();
  try { if (client) await client.destroy(); } catch (_) { /* ignore */ }
}
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
process.on('SIGINT', async () => { await shutdown(); process.exit(0); });

async function main() {
  if (USE_PROXY) await ensureProxy();
  let backoff = 15000;
  while (!shuttingDown) {
    heartbeat('connecting');
    client = makeClient();
    let connected = false;
    for (let attempt = 1; attempt <= 5 && !shuttingDown; attempt++) {
      console.log(`[listener] initialize attempt ${attempt}...`);
      try {
        await Promise.race([
          client.initialize(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('initialize watchdog timeout (150s)')), 150000)),
        ]);
        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('ready timeout (180s)')), 180000);
          client.once('ready', () => { clearTimeout(to); resolve(); });
          client.once('disconnected', (r) => { clearTimeout(to); reject(new Error('disconnected before ready: ' + r)); });
        });
        console.log('[listener] ready');
        connected = true;
        break;
      } catch (e) {
        console.log(`[listener] attempt ${attempt} failed (${e.message}), retrying...`);
        try { await client.destroy(); } catch (_) { /* ignore */ }
        if (shuttingDown) break;
        client = makeClient();
        await sleep(8000);
      }
    }
    if (connected && !shuttingDown) {
      backoff = 15000; // reset on success
      try { await onReady(); } // resolves on disconnect or daily restart
      catch (e) { console.error('[listener] session error:', e.message); }
    } else if (!shuttingDown) {
      console.error('[listener] initialize failed 5x');
    }
    try { if (client) await client.destroy(); } catch (_) { /* ignore */ }
    client = null;
    targetGroup = null;
    if (shuttingDown) break;
    console.log(`[listener] reconnecting in ${backoff / 1000}s...`);
    heartbeat('reconnecting');
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 300000);
  }
  console.log('[listener] shutting down');
  intendedExit = 0;
  process.exit(0);
}

main().catch((e) => { console.error('[listener] FATAL:', e); process.exit(1); });
