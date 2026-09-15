# AGENTS.md — Trade Flow bot

Operating manual for anyone (human or agent) working in this repo. The product
README is `README.md`; this file is the *how we work here* companion: the
non-obvious facts that cost real debugging time to learn.

## Golden rules

1. **Privacy is the product.** Never commit, log, or paste: `.env` contents,
   `data/messages.jsonl` (raw WhatsApp text), the pseudonym map, phone numbers,
   sender names, group IDs, Gemini/Supabase keys, the setup-UI password, or
   pairing codes. These are all gitignored — keep them that way. When debugging
   with message data, describe counts and shapes, never content.
2. **Debug on the VM, ship via GitHub.** Iterate directly on the Oracle VM
   (`~/wa-trade-bot`, a git repo tracking `origin/master`) when debugging —
   it's fast. But once a fix is confirmed and tested, commit + push it
   immediately; the repo must always end in sync. Never leave VM-only changes
   sitting. (2026-09-15: converted from scp-deploys, which caused drift.)
3. **Prove it working before calling it done.** Every fix gets a live
   verification on the VM (status endpoint, real pull, real cycle) — not just
   "code looks right."

## Services & commands

```bash
# on the VM (ubuntu@<vm-ip>), via the Hatch CONNECT proxy from dev:
ssh -i ~/.ssh/id_ed25519 -o ProxyCommand='socat - PROXY:hatch-egress-proxy:%h:%p,proxyport=3128,proxyauth=$PROXY_CREDS' ubuntu@<vm-ip>

systemctl status wa-trade-bot.service        # setup UI (:3001)
systemctl status wa-trade-listener.service   # always-on WhatsApp listener
systemctl status wa-trade-bot-cycle.timer    # hourly pipeline 08:30–17:00 ET + midnight ET
journalctl -u wa-trade-listener --since -30m | tail -40

# manual full cycle (bypasses the time gate, like the UI button does):
MANUAL_RUN=1 bash ~/wa-trade-bot/run-cycle.sh

# one-off pull sanity check (refuses if the listener is active — stop it first):
node read.js "your group name" --limit 3
```

Setup UI: `http://<vm-ip>:3001/setup.html` (Basic Auth, any username + the
admin password). Dashboard: the bot serves it at `http://<vm-ip>:3001/`
unless `SERVE_DASHBOARD=0` is set in `.env`;
production is https://wa-trade-flow.vercel.app.

## Architecture notes (read before touching the pipeline)

- **Ingestion is always-on** (`listener.js`, `wa-trade-listener.service`).
  The old hourly connect→read→disconnect pattern got the linked device's
  message sync paused by WhatsApp (2026-09-15: 12h of missed messages). The
  listener keeps one persistent browser session, backfills on (re)connect,
  re-scans every 60s + on incoming group messages, and writes
  `data/listener-heartbeat.json` every minute. It does one graceful restart
  per day after 07:00 ET for a fresh Chromium. The hourly `run-cycle.sh`
  never touches the browser — it only watchdogs the listener (restarts it if
  the heartbeat is >10 min stale), then parses/scores/pushes. `read.js` is
  kept for manual backfills but refuses to run while the listener heartbeat
  is fresh (profile lock).
- **Chromium on ARM has no puppeteer-bundled build.** We use the `chromium`
  snap. Critical: `PUPPETEER_EXECUTABLE_PATH` must point at the **real binary**
  `/snap/chromium/current/usr/lib/chromium-browser/chrome`, NOT the
  `/snap/bin/chromium` wrapper — snap's launcher refuses to run inside a
  systemd service (`not a snap cgroup`), while working fine from an SSH shell.
  That asymmetry cost a full debugging session; don't regress it.
- **Chromium UA must stay whatsapp-web.js's default** (`Chrome/101.0.4951.67`
  Mac UA). Newer UAs land on WhatsApp's unsupported-browser page.
- **Proxied VMs:** Chromium ignores env proxy vars. Every unattended run needs
  `USE_PROXY=1` (adds `--proxy-server` + `--ignore-certificate-errors`
  pointing at the local CONNECT forwarder). A failed `client.initialize()`
  must `destroy()` before retrying or the profile lock kills all retries.
- **Pairing lifecycle** (`server.js`): `/api/pair` launches Chromium in the
  background; the page polls `/api/status`. On `ready` (NOT `authenticated` —
  killing the client on `authenticated` loses the session before it flushes),
  we wait ~5s for the profile to flush, write `.wwebjs_auth/READY`, then
  destroy. **`wa_paired` is derived from the READY marker file**, never from
  session-file existence (that caused a false-positive `true` once).
  Force re-pair wipes stale sessions and kills stray Chromium processes holding
  the LocalAuth profile lock.
- **`client.getChats()` is broken** on whatsapp-web.js 1.34.7 + this WA Web
  build (IndexedDB `DataError`, surfaces as a puppeteer error). `read.js`
  bypasses it via `window.require('WAWebCollections').Chat.getModelsArray()`;
  groups are `c.groupMetadata != null`. Messages load via
  `WAWebChatLoadMessages.loadEarlierMsgs`, serialized with
  `window.WWebJS.getMessageModel`.
- **Quoted replies:** raw `m.__x_quotedMsg` is a *plain object* (no
  `.serialize()` — it throws). Capture it *before* `getMessageModel(m)`.
- **Teardown race:** whatsapp-web.js throws `TargetCloseError` *after* work
  completes (its disconnect listener evaluates on the closing page; the throw
  escapes `destroy()` via the event emitter). `read.js` handles it with an
  `uncaughtException` guard + `finish()` helper so a successful run exits 0.
- **`run-cycle.sh` has `set -o pipefail`.** Without it, `tail` pipelines mask
  stage failures and print a false `cycle done`. Keep it.
- **`parse-trades.py` uses the repo-local `data/` dir** (not a hardcoded VM
  path) and exits cleanly when nothing has been pulled yet.
- **Scoring is non-fatal by design.** Market-data provider failures must never
  block WhatsApp ingestion or the Supabase push.
- **Time gate:** run-cycle.sh allows 08:30–17:00 America/New_York plus a single
  midnight ET catch-up run (ET-computed, VM-timezone independent).
  Manual runs set `MANUAL_RUN=1` to bypass.

## Deploy checklist

1. `git commit` + `git push origin master`.
2. On the VM: `git pull` in `~/wa-trade-bot`.
3. `node --check` / `bash -n` / `python3 -c "import ast…"` the changed files.
4. `sudo systemctl restart wa-trade-bot.service` if `server.js` changed;
   `sudo systemctl restart wa-trade-listener` if `listener.js` changed.
5. Verify live: `/api/status`, listener heartbeat fresh, then a real cycle —
   never assume.

## Conventions

- Commit messages: short imperative subject, blank line, then the *why*
  (what broke, what the fix proves). Reference the failure mode, not just the
  file.
- `.env.example` documents every env key; keep it in sync when adding config.
- `deploy/install.sh` is the fresh-VM path — any new system dependency or
  env default belongs there, not just in a chat message.
- Dashboard changes: source lives in `dashboard/` *and* `public/` (the bot
  serves `public/`). Keep them in sync; Vercel deploys from `dashboard/`.
- The dashboard reads Supabase live when configured, else static JSON —
  `t.outcome` is read identically from both; keep that contract.
