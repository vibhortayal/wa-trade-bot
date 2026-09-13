// One-time pairing: links this machine as a WhatsApp linked device via pairing code.
// Usage: node pair.js <phone-number-with-country-code>   e.g. node pair.js 14155551234
const { Client, LocalAuth } = require('whatsapp-web.js');
const ensureProxy = require('./ensure-proxy');

const phone = process.argv[2];
if (!phone || !/^\d{7,15}$/.test(phone)) {
  console.error('Usage: node pair.js <phone-number-with-country-code, digits only, e.g. 14155551234>');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--proxy-server=http://127.0.0.1:18080', '--ignore-certificate-errors'],
  },
});

client.on('qr', () => {
  console.log('[pair] QR emitted (ignoring, using pairing code instead)');
});

client.on('authenticated', () => console.log('[pair] AUTHENTICATED ✓ session saved'));
client.on('auth_failure', (m) => { console.error('[pair] AUTH FAILURE:', m); process.exit(1); });
client.on('ready', async () => {
  console.log('[pair] READY ✓ pairing complete — closing browser cleanly to flush session...');
  await client.destroy();  // clean shutdown flushes the Chrome profile to disk
  console.log('[pair] session flushed, exiting');
  process.exit(0);
});
client.on('disconnected', (r) => { console.error('[pair] disconnected:', r); process.exit(1); });

(async () => {
  await ensureProxy();
  await client.initialize();
  // Give the client a moment to reach the pairing state, then request the code.
  // The code is typed into WhatsApp on the phone:
  // Settings > Linked devices > Link a device > "Link with phone number instead".
  await new Promise((r) => setTimeout(r, 8000));
  try {
    const code = await client.requestPairingCode(phone);
    console.log('\n========================================');
    console.log('  PAIRING CODE: ' + code);
    console.log('========================================');
    console.log('On your phone: WhatsApp > Settings > Linked devices >');
    console.log('Link a device > "Link with phone number instead", then type the code.\n');
  } catch (e) {
    console.error('[pair] could not get pairing code:', e.message);
    process.exit(1);
  }
})();
