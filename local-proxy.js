// Minimal CONNECT forwarder: Chromium -> 127.0.0.1:18080 -> egress proxy (with auth).
// Chromium won't send Proxy-Authorization preemptively, so we inject it here.
const net = require('net');

const UPSTREAM_HOST = 'hatch-egress-proxy';
const UPSTREAM_PORT = 3128;
const LISTEN_PORT = 18080;

const m = (process.env.https_proxy || process.env.HTTPS_PROXY || '').match(/^http:\/\/([^:]+):([^@]+)@/);
if (!m) { console.error('[fwd] no proxy creds in env'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(m[1] + ':' + m[2]).toString('base64');

const server = net.createServer((clientSock) => {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    clientSock.removeListener('data', onData);
    const head = buf.slice(0, end).toString();
    const rest = buf.slice(end + 4);
    const line = head.split('\r\n')[0];
    const mm = line.match(/^CONNECT\s+(\S+)\s+HTTP\/\d/);
    if (!mm) { clientSock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const target = mm[1];

    const up = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
      up.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${AUTH}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });
    let upBuf = Buffer.alloc(0);
    up.on('data', (c) => {
      upBuf = Buffer.concat([upBuf, c]);
      const e = upBuf.indexOf('\r\n\r\n');
      if (e === -1) return;
      const status = upBuf.slice(0, e).toString().split('\r\n')[0];
      if (!/^HTTP\/\d(\.\d)?\s+200/.test(status)) {
        clientSock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        up.destroy();
        return;
      }
      up.removeAllListeners('data');
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) up.write(rest);
      const leftover = upBuf.slice(e + 4);
      if (leftover.length) clientSock.write(leftover);
      clientSock.pipe(up).pipe(clientSock);
    });
    up.on('error', () => clientSock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    clientSock.on('error', () => up.destroy());
  };
  clientSock.on('data', onData);
  clientSock.on('error', () => {});
  // plain-HTTP forwarding (not needed for WA, but harmless to reject)
  setTimeout(() => {}, 1);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => console.log('[fwd] listening on 127.0.0.1:' + LISTEN_PORT));
