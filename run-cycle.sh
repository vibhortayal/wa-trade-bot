#!/bin/bash
# Full hourly cycle for self-hosted operation: pull -> parse -> push to Supabase.
# Loads secrets from .env in this directory. Skips overnight (VM clock should be
# America/Los_Angeles; install.sh sets the timezone).
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

HOUR=$(date +%H)
# The timer keeps this window; a manual "Run a cycle now" from the setup UI
# sets MANUAL_RUN=1 to bypass it (explicit user action, not an overnight run).
if [ "${MANUAL_RUN:-0}" != "1" ] && { [ "$HOUR" -lt 6 ] || [ "$HOUR" -ge 18 ]; }; then
  echo "$(date -u +%FT%TZ) skip: outside 06:00-18:00 window"
  exit 0
fi

echo "=== $(date -u +%FT%TZ) cycle start ==="
GROUP_QUERY="${WA_GROUP_QUERY:-your group name}"
node read.js "$GROUP_QUERY" --limit 200 2>&1 | tail -2 || { echo "READ FAILED"; exit 1; }
python3 parse-trades.py 2>&1 | tail -2 || { echo "PARSE FAILED"; exit 1; }
# Outcome scoring via TradingView (needs `tv` login via the setup UI).
# Non-fatal: a scoring failure still leaves fresh parsed trades to push.
python3 score-outcomes.py 2>&1 | tail -2 || echo "SCORE FAILED (continuing without fresh scores)"
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
  python3 push-supabase.py 2>&1 | tail -3 || { echo "PUSH FAILED"; exit 1; }
else
  echo "SUPABASE not configured, skipping push"
fi
echo "=== $(date -u +%FT%TZ) cycle done ==="
