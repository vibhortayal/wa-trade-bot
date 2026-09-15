#!/usr/bin/env python3
"""Push-notification alerts via ntfy (https://ntfy.sh), with state-transition dedup.

Usage:
  alert.py <key> failing ["<title>"] ["<message>"] [priority]
  alert.py <key> ok

- "failing": sends the push only if <key> wasn't already "failing"
  (or if the last push was >24h ago, as a daily reminder).
- "ok": sends a "recovered" push only if <key> was "failing", then clears it.
- No-op when NTFY_TOPIC is unset. Messages never include trade content or PII —
  just which step broke and what to check.

State lives in data/alert-state.json (gitignored, local only).
Called by run-cycle.sh (listener/parse/push) and listener.js (auth_failure).
"""
import json
import os
import sys
import time
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE, "data", "alert-state.json")
TOPIC = os.environ.get("NTFY_TOPIC", "").strip()
# Re-ping at most once a day for an alert that stays broken.
REMIND_AFTER = 24 * 3600


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(s):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE_FILE)


def send(title, message, priority=3):
    if not TOPIC:
        print("[alert] NTFY_TOPIC not set, skipping", flush=True)
        return False
    req = urllib.request.Request(
        "https://ntfy.sh/" + TOPIC,
        data=message.encode("utf-8"),
        headers={"Title": title, "Priority": str(priority), "Tags": "warning"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f"[alert] push sent ({r.status})", flush=True)
            return True
    except Exception as e:
        print(f"[alert] FAILED to send push: {e}", flush=True)
        return False


def main():
    if len(sys.argv) < 3:
        print("usage: alert.py <key> <failing|ok> [title] [message] [priority]",
              file=sys.stderr)
        sys.exit(2)
    key, state = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else f"Trade Flow: {key}"
    message = sys.argv[4] if len(sys.argv) > 4 else title
    try:
        priority = int(sys.argv[5]) if len(sys.argv) > 5 else 3
    except ValueError:
        priority = 3

    st = load_state()
    cur = st.get(key, {})
    now = time.time()

    if state == "failing":
        if cur.get("state") == "failing" and now - cur.get("last_sent", 0) < REMIND_AFTER:
            print(f"[alert] dedup: '{key}' already alerted, skipping", flush=True)
            return
        if send(title, message, priority):
            st[key] = {"state": "failing", "last_sent": now}
            save_state(st)
    elif state == "ok":
        if cur.get("state") == "failing":
            send(f"Trade Flow: {key} recovered", f"{key} is healthy again.", 3)
        st[key] = {"state": "ok", "last_sent": now}
        save_state(st)
    else:
        print(f"unknown state '{state}', want failing|ok", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
