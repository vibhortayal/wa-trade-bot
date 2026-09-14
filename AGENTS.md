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
2. **The Oracle VM dir (`~/wa-trade-bot`) is not a git repo.** Deploy with
   `scp`, never `git pull`. GitHub is the source of truth; the VM is a
   deployment target.
3. **Prove it working before calling it done.** Every fix gets a live
   verification on the VM (status endpoint, real pull, real cycle) — not just
   "code looks right."

## Services & commands

```bash
# on the VM (ubuntu@<vm-ip>), via the Hatch CONNECT proxy from dev:
ssh -i ~/.ssh/id_ed25519 -o ProxyCommand='socat - PROXY:hatch-egress-proxy:%h:%p,proxyport=3128,proxyauth=$PROXY_CREDS' ubuntu@<vm-ip>

systemctl status wa-trade-bot.service        # setup UI (:3001)
systemctl status wa-trade-bot-cycle.timer    # hourly pipeline 06:00–18:00 PT
journalctl -u wa-trade-bot.service --since -30m | tail -40

# manual full cycle (bypasses the time gate, like the UI button does):
MANUAL_RUN=1 bash ~/wa-trade-bot/run-cycle.sh

# one-off pull sanity check:
node read.js "your group name" --limit 3
```

Setup UI: `http://<vm-ip>:3001/setup.html` (Basic Auth, any username + the
admin password). Dashboard: the bot serves it at `http://<vm-ip>:3001/`;
production is https://wa-trade-flow.vercel.app.

## Architecture notes (read before touching the pipeline)

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
- **Scoring is non-fatal by design.** TradingView failures must never block
  WhatsApp ingestion or the Supabase push.
- **Time gate:** the timer runs 06:00–18:00 America/Los_Angeles (user rule: no
  overnight processes). Manual runs set `MANUAL_RUN=1` to bypass.

## Deploy checklist

1. `git commit` + `git push origin master` (private repo).
2. `scp` changed files to `~/wa-trade-bot` on the VM (or re-run install for a
   fresh box).
3. `node --check` / `bash -n` / `python3 -c "import ast…"` the changed files.
4. `sudo systemctl restart wa-trade-bot.service` if `server.js` changed.
5. Verify live: `/api/status`, then a real pull or cycle — never assume.

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
