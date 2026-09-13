# Trade Flow bot — self-hosted setup

Runs the WhatsApp reader → Gemini parser → Supabase pipeline on your own
(free) VM. The dashboard at **wa-trade-flow.vercel.app** then pulls live data
from Supabase instead of the baked-in static JSON.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| `server.js` + `public/` | your VM, port 3001 | setup UI: pairing code, keys, status, manual runs |
| `run-cycle.sh` | systemd timer, hourly | pull → parse → push (skips 22:00–06:00 PT) |
| `wa_trades` / `wa_meta` | Supabase | anonymized actions only; anon key is read-only via RLS |
| dashboard | Vercel | reads Supabase live, falls back to static JSON |

## 1. Create the free VM (Oracle Cloud)

**Fastest path — Resource Manager stack (recommended):**
`deploy/terraform.zip` contains a Terraform stack (`main.tf`) that provisions
the `wa-trade-bot` instance reusing the pre-built `bot-vcn` networking
(public subnet + port-3001 ingress rule). In the Oracle console:
Resource Manager → Stacks → Create stack → "My configuration" → upload the zip,
name it `wa-trade-bot`, fill in `tenancy_ocid`, `compartment_ocid` (same value),
`ssh_public_key`, and Apply. If the apply fails with "out of capacity", just
re-run Apply later — capacity for free shapes frees up sporadically.

**Manual path (~10 min):**

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (credit card required for
   verification; the Always Free tier itself costs nothing).
2. Create a Compute instance:
   - **Image:** Ubuntu 24.04
   - **Shape:** Ampere A1 (ARM) — 4 OCPUs / 24 GB RAM (Always Free eligible)
   - Add your SSH public key; note the **public IP**.
3. In the instance's subnet **security list**, add an ingress rule:
   TCP, source `0.0.0.0/0`, destination port **3001**.

## 2. Get three keys (~5 min)

- **Gemini API key** (free): [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- **Supabase project URL + service_role key**: Supabase dashboard →
  Project Settings → API. (You already have a project from Brewlog.)
- **Supabase schema**: in the Supabase dashboard open the **SQL Editor**,
  paste the contents of `supabase/schema.sql` from this repo, and run it once.
  This creates `wa_trades` + `wa_meta` with public read-only access.

## 3. Install the bot (~10 min)

```bash
# on your laptop: copy this project to the VM (or git clone a private repo)
scp -r ~/workspace/wa-trade-reader ubuntu@<vm-ip>:~/wa-trade-bot

ssh ubuntu@<vm-ip>
bash ~/wa-trade-bot/deploy/install.sh   # installs node, deps, systemd units; asks for a UI password
```

Then open **http://\<vm-ip\>:3001**, log in with the password you chose, and:

1. **Link WhatsApp** — enter your phone number, get the pairing code, type it
   into WhatsApp → Settings → Linked devices → *Link with phone number instead*.
2. **Save keys** — paste the Gemini key, Supabase URL, and service_role key.
3. **Connect TradingView** — get the login link, approve it in your browser,
   then paste the localhost callback URL back into the UI. This powers the
   per-trade outcome scoring (5-trading-day window, read-only market data).
4. **Run a cycle now** — first pull takes a few minutes (chat history sync).

The hourly timer takes over from there. The dashboard switches to live data
automatically once rows land in Supabase (set the anon key in
`wa-trade-dashboard/supabase-config.js` and redeploy the dashboard).

## Outcome scoring

Each hourly cycle runs `score-outcomes.py` after parsing. It resolves every
traded symbol to a TradingView ticker (cached in `data/tv_symbols.json`),
fetches daily OHLCV bars (cached in `data/tv_bars.json`), and writes
`data/outcomes.json` keyed by action id. Scores merge into the Supabase rows
via the `outcome` JSONB column:

- **direction** — bullish opens (BUY/ADD/call): favorable if the underlying
  is up >1% five trading days later; bearish (put): down >1%. Options are
  scored on the underlying's direction only — without the contract premium
  there is no real P&L, and the outcome says so.
- **exit** — SELL/TRIM/EXIT: favorable if the price fell >1% in the five
  days after the exit (exit timing).
- **plan** — PLANs with an explicit price target (`target` field, extracted
  by the parser): hit if touched within 14 days.
- **roundtrip** — FIFO match of BUY/ADD → SELL/TRIM/EXIT per trader+symbol;
  the exit carries the approximate return.

Entry price is the message's price when stated, else that day's close
(`entry_src` records which). Unresolved symbols or missing bars produce
`scored: false` — nothing is invented.

## Notes

- **Privacy**: raw WhatsApp messages, names, and phone numbers never leave the VM.
  Only pseudonymized trade actions (`You`, `Trader 01`…) are pushed to Supabase.
- **WhatsApp risk**: this uses an unofficial automation library via a linked
  device — same tradeoff as before, now on hardware you control.
- **Local dev**: `node server.js` runs the UI on `127.0.0.1:3001` with no auth;
  set `USE_PROXY=1` on Hatch, leave unset on the VM.
- **Logs**: `~/wa-trade-bot/logs/cycle.log`, or `journalctl -u wa-trade-bot-cycle`.
