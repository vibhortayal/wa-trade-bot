# Trade Flow

**Turn your trading group chat into a live, scored trade tape.**

Trade Flow connects to a WhatsApp trading group as a linked device, pulls new
messages every hour, extracts structured trade actions with AI, scores their
outcomes against real market data, and serves it all on a clean dashboard —
fully anonymized, running on your own hardware.

🌐 **Live dashboard:** https://wa-trade-flow.vercel.app

---

## How it works

```
WhatsApp group ──► read.js ──► parse-trades.py ──► score-outcomes.py ──► push-supabase.py ──► dashboard
(linked device)    (hourly       (Gemini: extract    (TradingView: 5-day     (anonymized         (Vercel or
                    pull)         trade actions)      returns, round trips)   upsert)             self-hosted)
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

The whole cycle runs hourly on a systemd timer (`06:00–18:00 PT`), or on demand
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
- **Privacy by design** — senders become `You` / `Trader 01…N`; raw message text,
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

Provider priority for parsing: `LLM_API_BASE` (OpenAI-compatible) →
`GEMINI_API_KEY` (Gemini native) → Hatch `google-gemini` skill CLI (dev only).

## Quickstart

You need: an Ubuntu VM (Oracle Cloud Always Free works — 4 ARM cores, 24 GB
RAM, $0), an LLM key (Gemini's free tier is the suggested default; any
OpenAI-compatible API works), and a database (Supabase's free tier is the
suggested default; any PostgREST endpoint works).

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

> Full VM walkthrough (Oracle console, firewall, Terraform stack):
> [`deploy/README.md`](deploy/README.md)

## The dashboard

The dashboard is a static vanilla-JS site (`dashboard/`) — the same code also
ships in `public/` so the bot serves it directly at `http://<vm-ip>:3001/`.

- **Digest + trade tape** up front; outcome badges (✓/✗/–) with 5-day returns.
- **Six tape filters** behind one toggle; instruments and actions merged into a
  single "Trade mix" panel.
- **Traders tab** — per-member cards (activity, record, round trips, target
  hits); tap a card for a bottom-sheet detail view.
- **Insights** — top-4 ranked signals from 7 deterministic rules, or a calm
  "nothing unusual" state.
- **Day / Week / Month** ranges (week is default).

It reads live from Supabase when configured, and falls back to a baked-in
`trades.json` otherwise.

## Privacy by design

- **Pseudonymous by default.** Every sender is mapped to `You` (the group
  owner) or `Trader 01…N`. Numbers are never recycled, so a trader's history
  stays consistent without ever revealing who they are.
- **Raw messages stay home.** `data/messages.jsonl` and the pseudonym map are
  gitignored and never committed. Only anonymized, structured actions reach
  Supabase.
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
| `PUPPETEER_EXECUTABLE_PATH` | Chromium binary (see Troubleshooting) |
| `USE_PROXY` | `1` if Chromium needs the local CONNECT forwarder |

The hourly timer runs `06:00–18:00 America/Los_Angeles`. A manual **Run a cycle
now** from the setup UI bypasses the window (`MANUAL_RUN=1`).

## Project structure

```
server.js            Setup UI backend (:3001) — pairing, keys, TV OAuth, manual runs, log tail
public/setup.html    Setup UI · public/{index.html,app.js,styles.css}  Dashboard (also served by the bot)
read.js              WhatsApp linked-device reader → data/messages.jsonl
pair.js              One-time phone-code pairing helper
parse-trades.py      Gemini extraction → data/trades.json
score-outcomes.py    TradingView outcome scoring (5-day window, FIFO round trips)
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

**Pairing code never appears.** The #1 cause: Chromium can't launch from the
systemd service. Snap's launcher (`/snap/bin/chromium`) refuses to run inside a
service cgroup — point `PUPPETEER_EXECUTABLE_PATH` at the real binary instead:
`/snap/chromium/current/usr/lib/chromium-browser/chrome`. `deploy/install.sh`
does this for you.

**`client.getChats()` throws a puppeteer error.** A known whatsapp-web.js /
WA Web incompatibility (IndexedDB `DataError`). `read.js` bypasses it and reads
the in-memory chat collections directly — don't "fix" it back.

**Cycle log shows `skip: outside 06:00–18:00 window`.** The timer only runs
daytime PT. Use the setup UI's **Run a cycle now** button for an immediate run.

**Session lost after re-pairing.** The pairing client must stay alive until the
`ready` event fires and the session flushes — killing it on `authenticated`
loses the session. The link is proven by the `.wwebjs_auth/READY` marker file,
not by session files existing.

**Scoring shows 0 actions.** `score-outcomes.py` needs a market-data source:
connect TradingView (via the setup UI) or set `MARKET_DATA_PROVIDER=yahoo`
(free, no key). Scoring is non-fatal: a market-data failure never blocks ingestion
or the Supabase push.

## Roadmap

- [ ] Multi-group tracking with per-group dashboards
- [ ] Telegram / Discord ingestion alongside WhatsApp
- [ ] Alerting: notify when a followed trader posts or a target is near
- [ ] Options-flow lens: open interest / unusual activity overlays
- [ ] Export: CSV / API access to your own scored tape

## License

MIT — free to use, modify, and self-host. See [LICENSE](LICENSE).
