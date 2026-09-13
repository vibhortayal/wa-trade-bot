#!/bin/bash
# Full hourly cycle for self-hosted operation: pull -> parse -> push to Supabase.
# Loads secrets from .env in this directory. Skips overnight (VM clock should be
# America/Los_Angeles; install.sh sets the timezone).
set -u
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

HOUR=$(date +%H)
if [ "$HOUR" -lt 6 ] || [ "$HOUR" -ge 22 ]; then
  echo "$(date -u +%FT%TZ) skip: outside 06:00-22:00 window"
  exit 0
fi

echo "=== $(date -u +%FT%TZ) cycle start ==="
GROUP_QUERY="${WA_GROUP_QUERY:-your group name}"
node read.js "$GROUP_QUERY" --limit 200 2>&1 | tail -2 || { echo "READ FAILED"; exit 1; }
python3 parse-trades.py 2>&1 | tail -2 || { echo "PARSE FAILED"; exit 1; }
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
  python3 push-supabase.py 2>&1 | tail -3 || { echo "PUSH FAILED"; exit 1; }
else
  echo "SUPABASE not configured, skipping push"
fi
echo "=== $(date -u +%FT%TZ) cycle done ==="
