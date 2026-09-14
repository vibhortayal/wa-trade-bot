# Trade Flow

**Turn your trading group chat into a live, scored trade tape.**

Trade Flow connects to a WhatsApp trading group as a linked device, pulls new
messages every hour, extracts structured trade actions with AI, scores their
outcomes against real market data, and publishes it all to a clean dashboard —
fully anonymized. The pipeline runs on your own hardware; the dashboard is a
static site on Vercel.

🌐 **Live dashboard:** https://wa-trade-flow.vercel.app

---

## How it works

```
WhatsApp group ──► read.js ──► parse-trades.py ──► score-outcomes.py ──► push-supabase.py ──► dashboard
(linked device)    (hourly       (Gemini: extract    (market data: 5-day    (anonymized         (Vercel;
                    pull)         trade actions)      returns, round trips)   upsert)             static site)
```

1. **Pull** — `read.js` opens WhatsApp Web as a linked device, fetches messages
   since the last checkpoint, and appends them to `data/messages.jsonl`.
2. **Parse** — `parse-trades.py` sends new messages to an LLM, which extracts
   structured trade actions: symbol, instrument (stock/call/put/spread),
   action (BUY/ADD/SELL/TRIM/EXIT/PLAN/HOLD/WATCH), and any stated targets.
   Gemini (free tier) is the suggested default; any OpenAI-compatible API works.
3. **Score** — `score-outcomes.py` pulls daily bars from your market-data source (TradingView by default, Yahoo Finance works too) and grades
   every action over the next 5 trading days (±1% noise band), detects FIFO
   round trips per trader/symbol, and checks whether planned targets were hit.
4. **Push** — `push-supabase.py` upserts the anonymized actions to Supabase.
5. **View** — the dashboard renders a digest, a filterable trade tape, per-trader
   cards, and a rule-based insights feed.

The whole cycle runs hourly on a systemd timer (`08:30–17:00 ET` plus a midnight ET catch-up run), or on demand
from the setup UI.

## Features

- **Zero-touch ingestion** — links to WhatsApp with a one-time phone pairing
  code; no chat export, no bots added to the group.
- **AI trade extraction** — Gemini turns messy chat messages (including quoted
  replies for context) into structured, auditable trade records.
- **Honest outcome scoring** — every action graded against real market data
  bars: favorable / unfavorable / flat, FIFO round trips, target-hit tracking.
- **Per-trader leaderboards** — activity, win rate, favorite symbols, and
  instrument mix per anonymous member, with small-sample caveats.
- **Insights engine** — deterministic rules surface activity spikes, crowd
  shifts, put/call sentiment changes, and hot traders. No LLM hallucinations.
- **Privacy by design** — senders become `Trader 01…N`; raw message text,
  names, and phone numbers never leave your machine (see below).
- **Self-hosted** — runs on a free Oracle Cloud ARM VM; your keys stay in a
  `0600` `.env` on your box.

## Swapping providers

The suggested stack is all free-tier, but nothing is locked in — each layer
has a clean seam:

| Layer | Suggested (free) | Swappable with |
|---|---|---|
| Host | Oracle Cloud Always Free | Any Ubuntu VM (Hetzner, EC2, Raspberry Pi…) — `install.sh` only needs node 20, Python 3, Chromium, systemd |
| Trade parsing (LLM) | Gemini API (free tier) | Any OpenAI-compatible chat-completions API: set `LLM_API_BASE` + `LLM_API_KEY` + `LLM_MODEL` in the setup UI (under *Use a different LLM instead*) or `.env`. Works with OpenAI, OpenRouter, Together, Ollama, vLLM, LM Studio… |
| Data layer | Supabase (free tier) | Anything exposing PostgREST — the push script and dashboard speak plain PostgREST over REST, no SDK. Point `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` at your endpoint |
| Market data | TradingView (your account) | Yahoo Finance — free, no key: set `MARKET_DATA_PROVIDER=yahoo` in the setup UI (§3) or `.env`. US stocks, ETFs and crypto; bars are split/dividend-adjusted. TradingView keeps broader coverage (symbol search, futures) |
| Dashboard | Vercel (free tier) | The bot can serve it instead (default on; set `SERVE_DASHBOARD=0` to keep the bot to pipeline + setup UI) |

Provider priority for parsing: `LLM_API_BASE` (OpenAI-compatible) →
`GEMINI_API_KEY` (Gemini native) → Hatch `google-gemini` skill CLI (dev only).

## Quickstart

You need: an Ubuntu VM (Oracle Cloud Always Free works — 4 ARM cores, 24 GB
RAM, $0), an LLM key (Gemini's free tier is the suggested default; any
OpenAI-compatible API works), a database (Supabase's free tier is the
suggested default; any PostgREST endpoint works), and a Vercel account
(free tier — hosts the dashboard).

```bash
# 1. Copy the repo to your VM (or clone the repo)
scp -r . ubuntu@<vm-ip>:~/wa-trade-bot

# 2. Install: node, Chromium, systemd units (asks for a setup-UI password)
ssh ubuntu@<vm-ip>
bash ~/wa-trade-bot/deploy/install.sh
```

Then open **`http://<vm-ip>:3001/setup.html`** and:

1. **Link WhatsApp** — enter your phone number, get the pairing code, type it
   into WhatsApp → Settings → Linked devices → *Link with phone number instead*.
2. **Save your keys** — an LLM key (Gemini free tier suggested, or any
   OpenAI-compatible API) and your database URL + service key. Set the
   **WhatsApp group to watch** here too (it shows the current value, and every
   field can be edited or reset from the UI).
3. **Pick market data** — connect TradingView (one-click OAuth, broadest coverage) or switch to Yahoo Finance (free, no key) in §3 of the setup UI.
4. **Run the schema** — paste `supabase/schema.sql` once in the Supabase SQL
   editor (creates `wa_trades` / `wa_meta`, anon read-only via RLS).
5. **Run a cycle now** — pulls the last 200 messages and runs the full pipeline.
6. **Deploy the dashboard** — Vercel is its canonical home (the bot only runs
   the pipeline and the setup UI). Edit `dashboard/supabase-config.js` with
   your Supabase project URL and anon key, commit, and push. In Vercel, import
   the repo with the root directory set to `dashboard/` — it redeploys
   automatically on every push. The dashboard reads live from Supabase.

> Full VM walkthrough (Oracle console, firewall, Terraform stack):
> [`deploy/README.md`](deploy/README.md)

## The dashboard

The dashboard is a static vanilla-JS site (`dashboard/`) deployed to Vercel —
that's its canonical home. It reads live from Supabase, so there's nothing to
run: push to `master` and Vercel redeploys.

The bot can also serve the same files itself at `http://<vm-ip>:3001/`
(`SERVE_DASHBOARD=1`, the default). Set `SERVE_DASHBOARD=0` in `.env` to keep
the bot to pipeline + setup UI only.

- **Digest + trade tape** up front; outcome badges (✓/✗/–) with 5-day returns.
- **Six tape filters** behind one toggle; instruments and actions merged into a
  single "Trade mix" panel.
- **Traders tab** — per-member cards (activity, record, target
  hits); tap a card for a bottom-sheet detail view.
- **Insights** — top-4 ranked signals from 7 deterministic rules, or a calm
  "nothing unusual" state.
- **Day / Week / Month** ranges (week is default).

It reads live from Supabase when configured, and falls back to a baked-in
`trades.json` otherwise.

## Privacy by design

- **Pseudonymous by default.** Every sender is mapped to `Trader 01…N` — no
  exceptions, no real names. Numbers are never recycled, so a trader's history
  stays consistent without ever revealing who they are.
- **Raw messages stay home.** `data/messages.jsonl` and the pseudonym map are
  gitignored and never committed. Only anonymized, structured actions reach
  Supabase.
- **Anonymized before the LLM, too.** Trade extraction needs the message text,
  so the text is sent to your configured LLM — but sender names, sender IDs,
  and phone-like numbers are replaced with `Trader 01…N` labels and scrubbed
  first (`pseudonyms.py`, shared with the dashboard so the numbers match).
- **Read-only public data.** The Supabase schema enables Row Level Security:
  anonymous keys can only *read* `wa_trades`; writes require the service key
  that lives on your VM.
- **Scrubbed by default.** Setup never asks for names, and the pipeline drops
  phone numbers, group IDs, and message text before anything leaves the box.

## Configuration

All secrets live in `.env` (mode `600`, gitignored). The setup UI writes them
for you; `.env.example` documents every key.

| Key | What it is |
|---|---|
| `ADMIN_PASSWORD` | Login for the setup UI |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Trade extraction (free tier works) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Live data layer for the dashboard |
| `WA_GROUP_QUERY` | Which group to pull (matched by name) |
| `MAX_MESSAGES_PER_CYCLE` | Ingestion guardrail: max new messages per cycle (default `200`, ceiling `1000`) |
| `PUPPETEER_EXECUTABLE_PATH` | Chromium binary (see Troubleshooting) |
| `USE_PROXY` | `1` if Chromium needs the local CONNECT forwarder |
| `SERVE_DASHBOARD` | `0` to stop serving the dashboard from the bot (setup UI stays up); default `1` |

The hourly timer runs `08:30–17:00 America/New_York` plus a single midnight ET run. A manual **Run a cycle
now** from the setup UI bypasses the window (`MANUAL_RUN=1`).

## Project structure

```
server.js            Setup UI backend (:3001) — pairing, keys, TV OAuth, manual runs, log tail
public/setup.html    Setup UI · public/{index.html,app.js,styles.css}  Dashboard (also served by the bot)
read.js              WhatsApp linked-device reader → data/messages.jsonl
pair.js              One-time phone-code pairing helper
parse-trades.py      Gemini extraction → data/trades.json
score-outcomes.py    Market-data outcome scoring (5-day window, FIFO round trips)
push-supabase.py     Anonymized upsert → Supabase wa_trades / wa_meta
run-cycle.sh         Full pipeline: pull → parse → score → push
build-dashboard.py   Bakes data/trades.json into the static dashboard
dashboard/           Standalone dashboard source (deployed to Vercel)
supabase/schema.sql  Tables + RLS (anon read-only)
deploy/              install.sh, systemd units, Terraform stack, setup guide
vendor/tradingview   Vendored TradingView client used by score-outcomes.py
```

Setup-UI API (all behind HTTP Basic Auth, any username):

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Pairing state, LLM/DB/TV flags |
| `POST /api/pair` | Start phone-code pairing (`{phone, force}`) |
| `POST /api/keys` | Save LLM/DB keys + group query (supports `reset` list) |
| `POST /api/run` | Run a full cycle now (bypasses the time gate) |
| `POST /api/tv-auth-start` / `POST /api/tv-auth-callback` | TradingView OAuth |
| `GET /api/logs` | Tail of `logs/cycle.log` |

## Troubleshooting

**Oracle says "out of capacity" when creating the VM.** Always Free capacity
in a region comes and goes — we hit this in us-sanjose-1 for both free shapes.
Retry, or try the other shape. What unblocked us: upgrading the tenancy to Pay
As You Go (card on file, still free-tier eligible) with a budget alert as a
safety net.

**Pairing code never appears / reads die instantly.** Symptom of Chromium never
launching: the `chromium` snap's launcher (`/snap/bin/chromium`) refuses to run
inside a systemd cgroup (`not a snap cgroup`), while working fine from an SSH
shell. Point `PUPPETEER_EXECUTABLE_PATH` at the real binary instead:
`/snap/chromium/current/usr/lib/chromium-browser/chrome`. `deploy/install.sh`
does this for you.

**Pairing stalls: code shown but the link never completes.** Pairing is a round
trip — the VM's headless Chromium shows the code, you type it into WhatsApp on
the phone, and WhatsApp confirms back. The link only counts when the setup UI
reports `wa_paired: true`, which is derived from the `.wwebjs_auth/READY` marker
file (written after the `ready` event plus a profile flush — not from session
files existing). Codes expire within minutes. If it keeps failing, the VM holds
a stale half-paired session: force re-pair (`POST /api/pair` with
`{"phone": ..., "force": true}`, or the "Get a fresh code" button) wipes
`.wwebjs_auth` and kills stray Chromium processes holding the profile lock.

**`client.getChats()` throws a puppeteer error.** A known whatsapp-web.js /
WA Web incompatibility (IndexedDB `DataError`). `read.js` bypasses it and reads
the in-memory chat collections directly — don't "fix" it back.

**Reader pulls no messages.** Two causes: (a) a fresh linked device takes up to
~60s to populate the in-memory chat list — `read.js` polls
`WAWebCollections.Chat.getModelsArray()` until it's non-empty, so just re-run;
(b) the group filter — `WA_GROUP_QUERY` is a case-insensitive substring match
on the group name, and groups are identified by `c.groupMetadata != null`. If
it matches nothing, the pull is empty by design — check the "WhatsApp group to
watch" value in the setup UI against the group's actual name in WhatsApp.

**Cycle log shows `skip: outside 08:30–17:00 ET + midnight ET window`.** The timer only runs
during the ET window above. Use the setup UI's **Run a cycle now** button for an immediate run.

**Session lost after re-pairing.** The pairing client must stay alive until the
`ready` event fires and the session flushes — killing it on `authenticated`
loses the session. The link is proven by the `.wwebjs_auth/READY` marker file,
not by session files existing.

**Scoring shows 0 actions.** `score-outcomes.py` needs a market-data source:
connect TradingView (via the setup UI) or set `MARKET_DATA_PROVIDER=yahoo`
(free, no key). Scoring is non-fatal: a market-data failure never blocks ingestion
or the Supabase push.

**Dashboard looks stale.** Check `/api/status` first: if `last_pull` /
`last_parse` are old, the pipeline isn't running — check
`wa-trade-bot-cycle.timer` and `logs/cycle.log`. If the tape is fresh but
outcome badges are missing, the market-data source failed: scoring is non-fatal
by design, so an expired TradingView token or an unreachable Yahoo just leaves
scores blank. Reconnect in setup UI §3 or set `MARKET_DATA_PROVIDER=yahoo`.

**Stray Chromium holds the profile lock.** If pairing or reads fail with
profile-lock errors, a dead Chromium may still hold the Chrome profile. Kill
stray `chrome` processes, wipe `.wwebjs_auth`, and pair fresh — force re-pair
does this for you.

**WhatsApp shows an "unsupported browser" page.** `read.js` pins Chromium's user
agent to whatsapp-web.js's default (Chrome/101 on Mac). Newer user agents get
rejected by WhatsApp — don't override it.

**`web.whatsapp.com` fails with `ERR_EMPTY_RESPONSE`.** Chromium ignores
environment proxy variables. If the VM sits behind a proxy, run the local
CONNECT forwarder (`local-proxy.js`, `USE_PROXY=1`) so the browser routes
through it.

**`TargetCloseError` right after `DONE`.** A harmless whatsapp-web.js teardown
race — its disconnect listener fires on the closing page. `read.js` guards it;
trust the exit code, not the stack trace.

**Seeing duplicate trades.** Checkpoint-boundary re-reads can re-deliver the
last message. `read.js` dedupes with `m.t >= lastTs` and the parser dedupes by
stable message id — if you still see dupes, check the checkpoint in `data/state.json`.

**`PARSE_FAILED` batches.** Messages the parser can't handle are marked
`PARSE_FAILED` and skipped individually — one bad message never blocks the rest.
Check the API key / quota, then re-run.

**Gemini quota / rate limits.** The free tier is limited; the parser backs off
and retries in smaller batches, and unparseable messages are marked
`PARSE_FAILED` and skipped individually. Easiest fixes first: set a backup key
(`GEMINI_API_KEY_BACKUP` in the setup UI — automatic failover when the primary
hits its quota), wait for the quota to reset, or point `LLM_API_BASE` /
`LLM_API_KEY` / `LLM_MODEL` at any OpenAI-compatible endpoint.

**Setup UI unreachable on :3001.** The page won't load because Oracle blocks all
ports by default — the subnet's security list needs a TCP ingress rule for port
3001 (source `0.0.0.0/0`; see `deploy/`). Also run the services as the same OS
user that installed Chromium (`ubuntu`, not `root` — root can't see the
ubuntu-installed browser).

**Deploying to the VM: it's not a git repo.** Copy files with `scp` (see
`deploy/`); `git pull` won't work there by design.

## Roadmap

- [ ] Multi-group tracking with per-group dashboards
- [ ] Telegram / Discord ingestion alongside WhatsApp
- [ ] Alerting: notify when a followed trader posts or a target is near
- [ ] Options-flow lens: open interest / unusual activity overlays
- [ ] Export: CSV / API access to your own scored tape

## License

MIT — free to use, modify, and self-host. See [LICENSE](LICENSE).
