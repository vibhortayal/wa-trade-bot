#!/usr/bin/env python3
"""Upsert anonymized trade actions into Supabase.

Reads the same scrubbed records as build-dashboard.py and upserts them into
the wa_trades table (stable ids => idempotent), then updates wa_meta.

Env required:
  SUPABASE_URL           e.g. https://xyz.supabase.co
  SUPABASE_SERVICE_KEY   service_role key (server-side only, never in the browser)
"""
import json, os, sys, urllib.request, urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

# build-dashboard.py has a hyphen; load it without renaming (cron depends on it).
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "build_dashboard", os.path.join(HERE, "build-dashboard.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
build_records = _mod.build_records

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not SUPABASE_URL or not SERVICE_KEY:
    sys.exit("push-supabase: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SUPABASE_URL + path, data=data, method=method)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", "Bearer " + SERVICE_KEY)
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "resolution=merge-duplicates")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()[:200]
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        raise


def read_cycle_stats(max_age_min=30):
    """Per-cycle numbers left behind by read.js (data/state.json -> ingestion)
    and parse-trades.py (data/parse-stats.json). Only stats written within
    max_age_min count as this cycle's; anything older is a previous cycle's
    leftovers, reported as None (unknown)."""
    def fresh_enough(at):
        try:
            age = (datetime.now(timezone.utc)
                   - datetime.fromisoformat(at)).total_seconds() / 60
            return age <= max_age_min
        except Exception:
            return False
    messages, new_actions = None, None
    try:
        ing = json.load(open(os.path.join(HERE, "data", "state.json"))).get("ingestion", {})
        if fresh_enough(ing.get("at", "")):
            messages = int(ing.get("ingested", 0))
    except Exception:
        pass
    try:
        ps = json.load(open(os.path.join(HERE, "data", "parse-stats.json")))
        if fresh_enough(ps.get("at", "")):
            new_actions = int(ps.get("new_actions", 0))
    except Exception:
        pass
    return messages, new_actions


def main():
    # Failure-report mode: run-cycle.sh calls this when a stage fails, so the
    # dashboard health pill can say which step broke instead of just going
    # quietly stale. Only touches wa_meta.
    if len(sys.argv) > 1 and sys.argv[1] == "--report-failure":
        step = sys.argv[2] if len(sys.argv) > 2 else "unknown"
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        messages, _ = read_cycle_stats()
        cycle = {"ended_at": now, "status": "error", "step": step,
                 "messages": messages, "new_actions": None}
        api("POST", "/rest/v1/wa_meta?on_conflict=key",
            [{"key": "last_cycle", "value": json.dumps(cycle)}])
        print(f"push-supabase: reported cycle failure at step '{step}'")
        return
    records = build_records()
    print(f"push-supabase: upserting {len(records)} actions...")
    for i in range(0, len(records), 200):
        chunk = records[i:i + 200]
        st, _ = api("POST", "/rest/v1/wa_trades?on_conflict=id", chunk)
        print(f"  chunk {i // 200 + 1}: HTTP {st}")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    last_ts = max((r["ts"] for r in records), default=0)
    messages, new_actions = read_cycle_stats()
    cycle = {"ended_at": now, "status": "ok",
             "messages": messages, "new_actions": new_actions}
    api("POST", "/rest/v1/wa_meta?on_conflict=key", [
        {"key": "last_push", "value": now},
        {"key": "action_count", "value": str(len(records))},
        {"key": "last_pull_ts", "value": str(last_ts)},
        {"key": "last_cycle", "value": json.dumps(cycle)},
    ])
    print(f"push-supabase: done, meta updated (last_push={now})")


if __name__ == "__main__":
    main()
