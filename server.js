const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ICE = JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');

const rooms = new Map();
const attempts = new Map();

const handler = (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/ice') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(ICE));
  }
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : path.normalize(url));
  if (!file.startsWith(path.join(__dirname, 'public'))) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'content-type': type }).end(data);
  });
};

const server = process.env.TLS_CERT
  ? require('https').createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
  : http.createServer(handler);

const wss = new WebSocketServer({ server });
const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'host') {
      const code = crypto.randomInt(0, 1e6).toString().padStart(6, '0');
      const room = { code, source: ws, controller: null, expires: Date.now() + CODE_TTL_MS };
      rooms.set(code, room);
      ws.room = room;
      ws.role = 'source';
      return send(ws, { type: 'code', code, ttl: CODE_TTL_MS });
    }

    if (m.type === 'join') {
      const a = attempts.get(ip) || { n: 0, until: 0 };
      if (Date.now() < a.until) return send(ws, { type: 'error', error: 'Too many attempts, wait a minute' });
      const room = rooms.get(String(m.code));
      if (!room || room.expires < Date.now() || room.controller) {
        a.n++;
        if (a.n >= MAX_ATTEMPTS) { a.n = 0; a.until = Date.now() + 60000; }
        attempts.set(ip, a);
        return send(ws, { type: 'error', error: 'Invalid or expired code' });
      }
      attempts.delete(ip);
      room.controller = ws;
      room.expires = 0;
      ws.room = room;
      ws.role = 'controller';
      return send(room.source, { type: 'join-request', from: ip, directOnly: !!m.directOnly });
    }

    const room = ws.room;
    if (!room) return;
    const peer = ws.role === 'source' ? room.controller : room.source;
    if (m.type === 'reject' && ws.role === 'source') {
      send(peer, { type: 'error', error: 'Rejected by source' });
      if (peer) peer.room = null;
      room.controller = null;
      room.expires = Date.now() + CODE_TTL_MS;
      return;
    }
    if (['approve', 'offer', 'answer', 'candidate', 'bye'].includes(m.type)) send(peer, m);
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    if (ws.role === 'source') {
      send(room.controller, { type: 'bye' });
      rooms.delete(room.code);
    } else if (room.controller === ws) {
      room.controller = null;
      room.expires = Date.now() + CODE_TTL_MS;
      send(room.source, { type: 'bye' });
    }
  });
});

setInterval(() => {
  for (const [code, r] of rooms) if (r.expires && r.expires < Date.now() && !r.controller) {
    send(r.source, { type: 'expired' });
    rooms.delete(code);
  }
}, 10000);

server.listen(PORT, () => console.log(`signaling on ${process.env.TLS_CERT ? 'https' : 'http'}://0.0.0.0:${PORT}`));
