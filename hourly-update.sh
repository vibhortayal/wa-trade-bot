#!/bin/bash
# Hourly WhatsApp trade dashboard refresh.
# Self-gates to 06:00-18:00 PT (no overnight runs).
set -u
HOUR=$(TZ=America/Los_Angeles date +%H)
if [ "$HOUR" -lt 6 ] || [ "$HOUR" -ge 18 ]; then
  echo "$(date -u +%FT%TZ) skipped: outside 06-18 PT window"
  exit 0
fi
# On this Hatch VM, Chromium ignores env proxies, so the reader requires the
# local CONNECT forwarder (127.0.0.1:18080 -> Hatch egress proxy). Default
# USE_PROXY=1 here; override explicitly to 0/empty for direct egress.
export USE_PROXY="${USE_PROXY:-1}"
LOG=~/workspace/wa-trade-reader/logs/hourly.log
mkdir -p ~/workspace/wa-trade-reader/logs
{
  echo "=== $(date -u +%FT%TZ) refresh start ==="
  cd ~/workspace/wa-trade-reader || exit 1
  node read.js "your group name" --limit 200 2>&1 | tail -3 || { echo "READ FAILED"; exit 1; }
  python3 parse-trades.py 2>&1 | tail -3 || { echo "PARSE FAILED"; exit 1; }
  # Outcome scoring is non-fatal: a market-data failure must not block
  # fresh parsed trades from reaching the dashboard.
  python3 score-outcomes.py 2>&1 | tail -2 || { echo "SCORE FAILED (non-fatal, continuing)"; }
  python3 build-dashboard.py 2>&1 | tail -2 || { echo "BUILD FAILED"; exit 1; }
  cd ~/workspace/wa-trade-dashboard || exit 1
  npx -y vercel --prod --yes 2>&1 | tail -3
  echo "=== $(date -u +%FT%TZ) refresh done ==="
} >> "$LOG" 2>&1
