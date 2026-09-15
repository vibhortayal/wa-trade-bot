#!/bin/bash
# Full hourly cycle for self-hosted operation: parse -> score -> push to Supabase.
# Message ingestion is handled by the always-on wa-trade-listener.service
# (listener.js), which keeps a persistent WhatsApp connection — the old
# connect→read→disconnect pattern got the linked device's sync paused.
# This cycle checks the listener is healthy, then parses, scores, pushes.
# Loads secrets from .env in this directory. Schedule: hourly 08:30-17:00
# America/New_York (market hours +/- 1h buffer) plus a midnight ET catch-up run.
# The gate is ET-based and does not depend on the VM clock timezone.
set -u
# Fail the cycle if any stage fails — without this, `tail` pipelines mask
# failures (tail exits 0) and we'd print a false "cycle done".
set -o pipefail
cd "$(dirname "$0")"

# Browser for whatsapp-web.js: puppeteer's bundled Chrome may be missing/wrong-arch.
# Fall back to the snap Chromium REAL binary (not /snap/bin/chromium — the
# snap launcher wrapper fails under systemd; the real binary always works).
# UA is spoofed by wwebjs anyway, so the browser version doesn't matter.
if [ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ] && [ -x /snap/chromium/current/usr/lib/chromium-browser/chrome ]; then
  export PUPPETEER_EXECUTABLE_PATH=/snap/chromium/current/usr/lib/chromium-browser/chrome
fi

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
# Report a failed stage to Supabase (wa_meta.last_cycle) so the dashboard
# health pill names the broken step instead of just going quietly stale.
# Never fails the cycle itself: a dead reporter must not mask the real error.
report_failure() {
  if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
    python3 push-supabase.py --report-failure "$1" 2>&1 | tail -1 || true
  fi
}

# Listener watchdog: the always-on listener owns the WhatsApp browser session.
# If the service isn't active or its heartbeat is stale (>10 min), restart it.
# The listener backfills on (re)connect, so nothing is lost. Non-fatal: parse
# still runs on whatever's already ingested.
if systemctl is-active --quiet wa-trade-listener 2>/dev/null; then
  if [ -f data/listener-heartbeat.json ] && [ -z "$(find data/listener-heartbeat.json -mmin +10 2>/dev/null)" ]; then
    echo "[cycle] listener healthy"
  else
    echo "[cycle] listener heartbeat stale, restarting service"
    sudo -n systemctl restart wa-trade-listener 2>&1 | tail -1 || echo "[cycle] WARNING: could not restart listener"
    report_failure listener
  fi
else
  echo "[cycle] listener not active, starting service"
  sudo -n systemctl start wa-trade-listener 2>&1 | tail -1 || echo "[cycle] WARNING: could not start listener"
  report_failure listener
fi

python3 parse-trades.py 2>&1 | tail -2 || { echo "PARSE FAILED"; report_failure parse; exit 1; }
# Outcome scoring via the configured market-data provider
# (MARKET_DATA_PROVIDER: tradingview, needs `tv` login via the setup UI;
#  yahoo, free with no key). Non-fatal: a scoring failure still leaves fresh
# parsed trades to push.
python3 score-outcomes.py 2>&1 | tail -2 || echo "SCORE FAILED (continuing without fresh scores)"
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
  python3 push-supabase.py 2>&1 | tail -3 || { echo "PUSH FAILED"; report_failure push; exit 1; }
else
  echo "SUPABASE not configured, skipping push"
fi
echo "=== $(date -u +%FT%TZ) cycle done ==="
