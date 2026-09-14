// read.js — fetch latest N messages from a WhatsApp group, store as JSONL.
// Bypasses client.getChats()/getChatModel (hits an IndexedDB DataError on this
// WA Web build); works directly with the in-memory collections in page context.
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const ensureProxy = require('./ensure-proxy');

const DATA = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA, 'messages.jsonl');
const STATE_FILE = path.join(DATA, 'state.json');
fs.mkdirSync(DATA, { recursive: true });

// On Hatch the VM needs the local CONNECT forwarder for Chromium egress.
// On a self-hosted box with direct internet, leave USE_PROXY unset.
const USE_PROXY = process.env.USE_PROXY === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
if (USE_PROXY) puppeteerArgs.push('--proxy-server=http://127.0.0.1:18080', '--ignore-certificate-errors');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: puppeteerArgs,
  },
});

client.on('auth_failure', (m) => { console.error('[read] AUTH FAILURE:', m); process.exit(1); });
client.on('disconnected', (r) => { console.error('[read] disconnected:', r); process.exit(1); });

// whatsapp-web.js can throw a "Target closed" race during teardown: its own
// disconnect listener evaluates on the page while the browser is closing, and
// the throw escapes destroy()'s promise via the event emitter. Work is done
// by then, so exit with the intended code instead of crashing.
let intendedExit = 0;
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err);
  if (/Target closed|Target destroyed/i.test(msg)) {
    console.error('[read] teardown race (ignoring):', msg.split('\n')[0]);
    process.exit(intendedExit);
  }
  console.error('[read] FATAL:', err);
  process.exit(1);
});
async function finish(code) {
  intendedExit = code;
  try { await client.destroy(); } catch (_) { /* ignore teardown races */ }
  process.exit(code);
}

client.on('ready', async () => {
  try {
    const query = (process.argv[2] || '').toLowerCase();
    const limit = parseInt((process.argv.find((a) => a === '--limit') && process.argv[process.argv.indexOf('--limit') + 1]) || '200', 10);
    if (!query) { console.error('[read] usage: node read.js "<group name query>" --limit 200'); process.exit(1); }

    console.log('[read] app ready, waiting for chat list sync...');
    // poll until the in-memory chat collection populates (can take minutes)
    let synced = false;
    for (let i = 0; i < 30; i++) {
      const n = await client.pupPage.evaluate(
        () => window.require('WAWebCollections').Chat.getModelsArray().length
      ).catch(() => 0);
      if (n > 0) { console.log(`[read] chat list synced (${n} chats)`); synced = true; break; }
      await sleep(10000);
    }
    if (!synced) { console.error('[read] chat list never synced'); await finish(1); }

    const res = await client.pupPage.evaluate(async (q, lim) => {
      const W = window.require;
      const chats = W('WAWebCollections').Chat.getModelsArray();
      const groups = chats
        .filter((c) => c.groupMetadata != null)
        .map((c) => ({ id: c.id._serialized, name: c.name || c.formattedTitle || '' }));
      const matched = groups.filter((g) => g.name.toLowerCase().includes(q));
      if (!matched.length) return { groups, matched: [], messages: null };

      const WidFactory = W('WAWebWidFactory');
      const chat = W('WAWebCollections').Chat.get(WidFactory.createWid(matched[0].id));
      if (!chat) return { groups, matched, messages: null, err: 'chat not in collection' };

      let msgs = chat.msgs.getModelsArray().filter((m) => !m.isNotification);
      let guard = 0, newOnes = 1;
      while (msgs.length < lim && guard++ < 30 && newOnes > 0) {
        let loaded = [];
        try { loaded = await W('WAWebChatLoadMessages').loadEarlierMsgs({ chat }); } catch (e) { break; }
        newOnes = (loaded || []).filter((m) => !m.isNotification).length;
        if (newOnes) msgs = [...loaded.filter((m) => !m.isNotification), ...msgs];
        else break;
      }
      msgs.sort((a, b) => a.t - b.t);
      msgs = msgs.slice(-lim);

      const Contacts = W('WAWebCollections').Contact;
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
                       body: rawQuoted.body || rawQuoted.caption || '',
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
          id: s.id && s.id._serialized,
          t: s.t, ts: s.t * 1000,
          fromMe: s.id && s.id.fromMe,
          authorId: s.author,
          senderId, senderName,
          type: s.type, body: s.body || s.caption || '',
          hasMedia: !!s.hasMedia,
          quoted,
        };
      });
      return { groups, matched, messages: out };
    }, query, limit);

    console.log(`[read] groups found: ${res.groups.length}`);
    if (!res.matched.length) {
      console.log('[read] NO MATCH for query. Groups:');
      res.groups.forEach((g) => console.log('   -', g.name));
      await finish(2);
    }
    if (res.matched.length > 1) {
      console.log('[read] MULTIPLE matches, using first:');
      res.matched.forEach((g) => console.log('   -', g.name));
    }
    const group = res.matched[0];
    console.log(`[read] reading group: ${group.name} (${group.id})`);
    if (res.err || !res.messages) { console.error('[read] failed to load chat:', res.err); process.exit(1); }

    // checkpoint: only append messages newer than last run
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* fresh */ }
    const key = `lastTs:${group.id}`;
    const lastTs = state[key] || 0;
    console.log(`[read] checkpoint ts: ${lastTs}, fetched: ${res.messages.length}`);
    const fresh = res.messages.filter((m) => m.t > lastTs);
    if (fresh.length) {
      fs.appendFileSync(MSG_FILE, fresh.map((m) => JSON.stringify({ group: group.name, groupId: group.id, ...m })).join('\n') + '\n');
      state[key] = Math.max(...fresh.map((m) => m.t));
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
    console.log(`[read] DONE: ${fresh.length} new messages appended (${res.messages.length} fetched)`);
    await finish(0);
  } catch (e) {
    console.error('[read] ERROR:', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : JSON.stringify(e));
    await finish(1);
  }
});

(async () => {
  if (USE_PROXY) await ensureProxy();
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`[read] initialize attempt ${attempt}...`);
    try {
      await Promise.race([
        client.initialize(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('initialize watchdog timeout (150s)')), 150000)),
      ]);
      lastErr = null;
      console.log('[read] initialize resolved');
      break;
    } catch (e) {
      lastErr = e;
      console.log(`[read] attempt ${attempt} failed (${e.message}), retrying...`);
      // Tear down any half-started browser so the next attempt can take the profile lock.
      try { await client.destroy(); } catch (_) { /* ignore */ }
      await sleep(8000);
    }
  }
  if (lastErr) { console.error('[read] initialize failed 5x, aborting'); process.exit(1); }
})();
