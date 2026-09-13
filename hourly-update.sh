#!/bin/bash
# Hourly WhatsApp trade dashboard refresh.
# Self-gates to 06:00-22:00 PT (no overnight runs).
set -u
HOUR=$(TZ=America/Los_Angeles date +%H)
if [ "$HOUR" -lt 6 ] || [ "$HOUR" -ge 22 ]; then
  echo "$(date -u +%FT%TZ) skipped: outside 06-22 PT window"
  exit 0
fi
LOG=~/workspace/wa-trade-reader/logs/hourly.log
mkdir -p ~/workspace/wa-trade-reader/logs
{
  echo "=== $(date -u +%FT%TZ) refresh start ==="
  cd ~/workspace/wa-trade-reader || exit 1
  node read.js "your group name" --limit 200 2>&1 | tail -3 || { echo "READ FAILED"; exit 1; }
  python3 parse-trades.py 2>&1 | tail -3 || { echo "PARSE FAILED"; exit 1; }
  python3 build-dashboard.py 2>&1 | tail -2 || { echo "BUILD FAILED"; exit 1; }
  cd ~/workspace/wa-trade-dashboard || exit 1
  npx -y vercel --prod --yes 2>&1 | tail -3
  echo "=== $(date -u +%FT%TZ) refresh done ==="
} >> "$LOG" 2>&1
