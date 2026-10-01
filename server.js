'use strict';
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 12;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const TURN_MS = 45000;
const REACTIONS = ['😂', '😮', '😭', '👏', '🔥', '😈'];
const gzCache = new Map();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const file = path.join(PUBLIC, url === '/' ? 'index.html' : path.normalize(url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.png' ? 'public, max-age=604800, immutable' : 'no-cache',
    };
    if (/.(html|js|css|svg|json|webmanifest)$/.test(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) {
      let gz = gzCache.get(file);
      if (!gz || gz.src !== data.length) { gz = { src: data.length, buf: zlib.gzipSync(data) }; gzCache.set(file, gz); }
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      return res.end(gz.buf);
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map(); // code -> { code, game, hostId, tokens: Map(token->pid), sockets: Map(pid->ws), emptySince }

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function broadcast(room) {
  const g = room.game;
  for (const [pid, ws] of room.sockets) {
    send(ws, { type: 'state', hostId: room.hostId, code: room.code, msLeft: room.deadline ? Math.max(0, room.deadline - Date.now()) : null, ...g.view(pid) });
  }
}

function armTimer(room) {
  const g = room.game;
  const actor = g.pending ? g.pending.pid : (g.phase === 'play' && g.awaiting ? g.players[g.turn].id : null);
  const key = actor ? `${g.round}|${actor}|${g.seq}` : null;
  if (key === room.timerKey) return;
  room.timerKey = key;
  clearTimeout(room.timer);
  room.deadline = null;
  if (!key) return;
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => {
    if (room.timerKey !== key) return;
    room.game.forceAct();
    settle(room);
  }, TURN_MS);
}

function settle(room) {
  let guard = 0;
  while (guard++ < 500 && room.game.autoStep());
  armTimer(room);
  broadcast(room);
}

function cleanName(n) {
  return String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
}

function joinRoom(ws, room, name, token) {
  const g = room.game;
  let pid = token && room.tokens.get(token);
  if (pid && g.byId(pid)) {
    g.byId(pid).connected = true;
  } else {
    if (g.phase !== 'lobby') return send(ws, { type: 'error', msg: 'Game already in progress.' });
    if (g.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', msg: 'Room is full.' });
    name = cleanName(name);
    if (!name) return send(ws, { type: 'error', msg: 'Enter a name.' });
    if (g.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return send(ws, { type: 'error', msg: 'Name already taken in this room.' });
    }
    pid = crypto.randomBytes(4).toString('hex');
    token = crypto.randomBytes(16).toString('hex');
    room.tokens.set(token, pid);
    g.addPlayer(pid, name);
    if (!room.hostId) room.hostId = pid;
  }
  const old = room.sockets.get(pid);
  if (old && old !== ws) { old.ctx = null; old.close(); }
  room.sockets.set(pid, ws);
  ws.ctx = { room, pid };
  room.emptySince = null;
  const tok = [...room.tokens].find(([, v]) => v === pid)[0];
  send(ws, { type: 'joined', code: room.code, token: tok });
  settle(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'create') {
      if (rooms.size > 500) return send(ws, { type: 'error', msg: 'Server busy.' });
      const room = { code: newCode(), game: new Game(), hostId: null, tokens: new Map(), sockets: new Map(), emptySince: null, timer: null, timerKey: null, deadline: null };
      rooms.set(room.code, room);
      return joinRoom(ws, room, m.name, null);
    }
    if (m.type === 'join' || m.type === 'rejoin') {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', msg: 'Room not found.', gone: m.type === 'rejoin' });
      return joinRoom(ws, room, m.name, m.token);
    }

    if (!ws.ctx) return;
    const { room, pid } = ws.ctx;
    const g = room.game;
    switch (m.type) {
      case 'start':
        if (pid === room.hostId && g.phase === 'lobby' && g.players.length >= 2) g.start();
        break;
      case 'hit': g.hit(pid); break;
      case 'stay': g.stay(pid); break;
      case 'target': g.choose(pid, String(m.id)); break;
      case 'next': if (pid === room.hostId) g.nextRound(); break;
      case 'again':
        if (pid === room.hostId && g.phase === 'over') g.start();
        break;
      case 'react':
        if (REACTIONS.includes(m.e)) for (const sock of room.sockets.values()) send(sock, { type: 'react', from: pid, e: m.e });
        return;
      case 'leave': return leave(ws);
      default: return;
    }
    settle(room);
  });
  ws.on('close', () => leave(ws, true));
});

function leave(ws, soft) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  const { room, pid } = ctx;
  const g = room.game;
  if (room.sockets.get(pid) === ws) room.sockets.delete(pid);
  if (g.phase === 'lobby') {
    g.removePlayer(pid);
    for (const [t, v] of room.tokens) if (v === pid) room.tokens.delete(t);
  } else {
    const p = g.byId(pid);
    if (p) p.connected = false;
  }
  if (room.hostId === pid) {
    const next = g.players.find((p) => p.connected);
    room.hostId = next ? next.id : null;
  }
  if (!g.players.some((p) => p.connected)) room.emptySince = Date.now();
  settle(room);
}

// Drop dead sockets and abandoned rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  for (const [code, room] of rooms) {
    if (room.emptySince && Date.now() - room.emptySince > 30 * 60 * 1000) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 30000);

server.listen(PORT, () => console.log(`Flip 7 listening on ${PORT}`));
