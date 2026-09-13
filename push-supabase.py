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


def main():
    records = build_records()
    print(f"push-supabase: upserting {len(records)} actions...")
    for i in range(0, len(records), 200):
        chunk = records[i:i + 200]
        st, _ = api("POST", "/rest/v1/wa_trades?on_conflict=id", chunk)
        print(f"  chunk {i // 200 + 1}: HTTP {st}")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    last_ts = max((r["ts"] for r in records), default=0)
    api("POST", "/rest/v1/wa_meta?on_conflict=key", [
        {"key": "last_push", "value": now},
        {"key": "action_count", "value": str(len(records))},
        {"key": "last_pull_ts", "value": str(last_ts)},
    ])
    print(f"push-supabase: done, meta updated (last_push={now})")


if __name__ == "__main__":
    main()
