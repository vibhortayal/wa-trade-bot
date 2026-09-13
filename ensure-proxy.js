// Ensures the local CONNECT forwarder is running (needed for Chromium egress).
// Spawns it detached if 127.0.0.1:18080 refuses connections.
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18080;

function check() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 1500);
  });
}

module.exports = async function ensureProxy() {
  if (await check()) return;
  console.log('[proxy] starting local forwarder...');
  const child = spawn('node', [path.join(__dirname, 'local-proxy.js')], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await check()) { console.log('[proxy] forwarder up'); return; }
  }
  throw new Error('local forwarder did not come up');
};
