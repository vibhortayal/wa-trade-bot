#!/bin/bash
# Full hourly cycle for self-hosted operation: pull -> parse -> push to Supabase.
# Loads secrets from .env in this directory. Schedule: hourly 08:30-17:00
# America/New_York (market hours +/- 1h buffer) plus a midnight ET catch-up run.
# The gate is ET-based and does not depend on the VM clock timezone.
set -u
# Fail the cycle if any stage fails — without this, `tail` pipelines mask
# failures (tail exits 0) and we'd print a false "cycle done".
set -o pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# The timer fires hourly around the clock; this gate keeps the allowed windows.
# A manual "Run a cycle now" from the setup UI sets MANUAL_RUN=1 to bypass it
# (explicit user action).
ET_MIN=$((10#$(TZ=America/New_York date +%H) * 60 + 10#$(TZ=America/New_York date +%M)))
ALLOW=0
# 00:00-00:59 ET midnight catch-up run, or 08:30-17:00 ET market-hours window
if [ "$ET_MIN" -lt 60 ] || { [ "$ET_MIN" -ge 510 ] && [ "$ET_MIN" -le 1020 ]; }; then
  ALLOW=1
fi
if [ "${MANUAL_RUN:-0}" != "1" ] && [ "$ALLOW" -eq 0 ]; then
  echo "$(date -u +%FT%TZ) skip: outside 08:30-17:00 ET + midnight ET window"
  exit 0
fi

echo "=== $(date -u +%FT%TZ) cycle start ==="
GROUP_QUERY="${WA_GROUP_QUERY:-your group name}"
# Ingestion guardrail: MAX_MESSAGES_PER_CYCLE caps new messages per cycle
# (default 200, ceiling 1000 enforced in read.js). .env is sourced above with
# set -a, so the value is exported for read.js.
node read.js "$GROUP_QUERY" --limit "${MAX_MESSAGES_PER_CYCLE:-200}" 2>&1 | tail -3 || { echo "READ FAILED"; exit 1; }
python3 parse-trades.py 2>&1 | tail -2 || { echo "PARSE FAILED"; exit 1; }
# Outcome scoring via the configured market-data provider
# (MARKET_DATA_PROVIDER: tradingview, needs `tv` login via the setup UI;
#  yahoo, free with no key). Non-fatal: a scoring failure still leaves fresh
# parsed trades to push.
python3 score-outcomes.py 2>&1 | tail -2 || echo "SCORE FAILED (continuing without fresh scores)"
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
  python3 push-supabase.py 2>&1 | tail -3 || { echo "PUSH FAILED"; exit 1; }
else
  echo "SUPABASE not configured, skipping push"
fi
echo "=== $(date -u +%FT%TZ) cycle done ==="
