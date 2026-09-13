#!/usr/bin/env python3
"""Build scrubbed, anonymized dashboard data from extracted trades.

Reads data/trades.json + data/messages.jsonl, emits
~/workspace/wa-trade-dashboard/data/trades.json with:
- senders replaced by stable pseudonyms ("You" for the user's own messages,
  "Trader 01".. for everyone else)
- no raw message bodies, no phone numbers, no group identifiers

Also importable: build_records() -> list of scrubbed action dicts (used by
push-supabase.py). Each record has a stable "id" (msg-<n>-<actionidx>).
"""
import json, os, re
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT_DIR = os.path.expanduser("~/workspace/wa-trade-dashboard/data")
PT = ZoneInfo("America/Los_Angeles")

PSEUDO_PATH = os.path.join(DATA, "pseudonyms.json")  # private, never deployed


def load_pseudos():
    if os.path.exists(PSEUDO_PATH):
        return json.load(open(PSEUDO_PATH))
    return {}


def build_records():
    msgs = [json.loads(l) for l in open(os.path.join(DATA, "messages.jsonl")) if l.strip()]
    results = json.load(open(os.path.join(DATA, "trades.json")))
    pseudos = load_pseudos()
    changed = False

    counter = [max([int(v.split()[1]) for v in pseudos.values()
                    if v.startswith("Trader ")] or [0])]

    def pseudo(sender_id, sender_name, from_me):
        nonlocal changed
        if from_me:
            return "You"
        key = sender_id or sender_name or "unknown"
        if key not in pseudos:
            counter[0] += 1
            pseudos[key] = f"Trader {counter[0]:02d}"
            changed = True
        return pseudos[key]

    out = []
    for r in results:
        m = re.match(r"msg-(\d+)$", r.get("id", ""))
        if not m:
            continue
        idx = int(m.group(1))
        msg = msgs[idx]
        ts = int(msg["t"])
        day = datetime.fromtimestamp(ts, PT).strftime("%Y-%m-%d")
        trader = pseudo(msg.get("senderId"), msg.get("senderName"),
                        str(msg.get("fromMe")).lower() == "true")
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
                "quantity": a.get("quantity"),
                "confidence": a.get("confidence"),
                "note": note.strip(),
            })

    out.sort(key=lambda x: x["ts"])
    if changed:
        with open(PSEUDO_PATH, "w") as f:
            json.dump(pseudos, f, indent=1)
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
