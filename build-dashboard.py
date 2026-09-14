#!/usr/bin/env python3
"""Build scrubbed, anonymized dashboard data from extracted trades.

Reads data/trades.json + data/messages.jsonl, emits
~/workspace/wa-trade-dashboard/data/trades.json with:
- senders replaced by stable pseudonyms ("Trader 01".. for everyone,
  including the user's own messages — no "You" label)
- no raw message bodies, no phone numbers, no group identifiers

Also importable: build_records() -> list of scrubbed action dicts (used by
push-supabase.py). Each record has a stable "id" (msg-<n>-<actionidx>).
"""
import json, os, re, sys
from datetime import datetime
from zoneinfo import ZoneInfo

# Shared pseudonym map (also used pre-LLM by parse-trades.py). The import is
# path-bootstrapped because push-supabase.py loads this file via importlib
# (which does not put the repo dir on sys.path).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pseudonyms import load_pseudos, save_pseudos, pseudo, is_from_me, PSEUDO_PATH

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT_DIR = os.path.expanduser("~/workspace/wa-trade-dashboard/data")
PT = ZoneInfo("America/Los_Angeles")

def build_records():
    msgs = [json.loads(l) for l in open(os.path.join(DATA, "messages.jsonl")) if l.strip()]
    results = json.load(open(os.path.join(DATA, "trades.json")))
    pseudos = load_pseudos()
    changed = False
    # Outcomes are scored separately (score-outcomes.py) and merged here.
    try:
        outcomes = json.load(open(os.path.join(DATA, "outcomes.json")))
    except (OSError, ValueError):
        outcomes = {}

    def trader_of(msg):
        nonlocal changed
        # Everyone — including the user's own messages — gets a stable,
        # anonymous "Trader NN" label. Never "You": nothing may reveal
        # which trader is the site owner.
        label, new = pseudo(pseudos, msg.get("senderId"), msg.get("senderName"),
                            is_from_me(msg.get("fromMe")))
        if new:
            changed = True
        return label

    out = []
    for r in results:
        m = re.match(r"msg-(\d+)$", r.get("id", ""))
        if not m:
            continue
        idx = int(m.group(1))
        msg = msgs[idx]
        ts = int(msg["t"])
        day = datetime.fromtimestamp(ts, PT).strftime("%Y-%m-%d")
        trader = trader_of(msg)
        for j, a in enumerate(r.get("trades", [])):
            note = (a.get("note") or "")
            note = re.sub(r"\d{5,}@\w+", "", note)           # strip raw ids
            note = re.sub(r"\+?\d[\d\-\s]{7,}\d", "", note)   # strip phone-ish
            out.append({
                "id": f"msg-{idx}-{j}",
                "day": day,
                "ts": ts,
                "trader": trader,
                "action": a.get("action"),
                "symbol": a.get("symbol"),
                "instrument": a.get("instrument"),
                "strike": a.get("strike"),
                "expiry": a.get("expiry"),
                "price": a.get("price"),
                "target": a.get("target"),
                "quantity": a.get("quantity"),
                "confidence": a.get("confidence"),
                "note": note.strip(),
                "outcome": outcomes.get(f"msg-{idx}-{j}"),
            })

    out.sort(key=lambda x: x["ts"])
    if changed:
        save_pseudos(pseudos)
    return out


def main():
    out = build_records()
    days = sorted({t["day"] for t in out})
    payload = {
        "generated": datetime.now(PT).isoformat(timespec="seconds"),
        "day_range": [days[0], days[-1]] if days else [],
        "n_traders": len({t["trader"] for t in out}),
        "trades": out,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "trades.json"), "w") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"wrote {len(out)} scrubbed actions across {len(days)} days "
          f"({days[0]}..{days[-1] if days else ''}), {payload['n_traders']} traders")


if __name__ == "__main__":
    main()
