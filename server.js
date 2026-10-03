'use strict';
// Flip 7 Online: static file server + WebSocket game rooms (all state in memory).
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');

const DEFAULTS = {
  publicDir: path.join(__dirname, 'public'),
  maxPlayers: 12,
  maxRooms: 500,
  turnMs: 45000, // a stalling player is auto-played after this
  graceMs: 15000, // a disconnected player's decision (and host role) waits this long for a reconnect
  lobbyGraceMs: 120000, // a disconnected lobby player keeps their seat this long
  continueMs: 20000, // after this at round end / game over, anyone may continue
  emptyRoomMs: 30 * 60 * 1000, // a room with nobody connected is deleted after this
  idleRoomMs: 6 * 60 * 60 * 1000, // a room with no actions at all is deleted after this
  sweepMs: 30000, // heartbeat + cleanup interval
  createsPerMin: 8, // new rooms per client IP per minute
  msgBurst: 20, // per-socket token bucket
  msgPerSec: 10,
  reactGapMs: 700, // min gap between reactions from one socket
  rng: null, // deck shuffle RNG (tests pass a seeded one); defaults to Math.random
};

const REACTIONS = ['😂', '😮', '😭', '👏', '🔥', '😈'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = /\.(html|js|css|svg|json|webmanifest|txt)$/;
const PAGES = /\.(html|webmanifest)$/; // revalidated on every load; their __ASSET_V__ placeholder is filled in

function cleanName(n) {
  const s = String(n == null ? '' : n).normalize('NFC').replace(/[^\p{L}\p{M}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, 16).join('').trim();
}

// Read public/ once at startup: precompressed (brotli + gzip) bodies and strong ETags.
function loadStatic(dir) {
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, rel + e.name + '/');
      else list.push({ url: rel + e.name, data: fs.readFileSync(abs) });
    }
  })(dir, '/');
  list.sort((a, b) => (a.url < b.url ? -1 : 1));
  // Asset version (hash of every non-page file) used as the ?v= cache buster.
  const vh = crypto.createHash('sha1');
  for (const f of list) if (!PAGES.test(f.url)) vh.update(f.url).update(f.data);
  const version = vh.digest('hex').slice(0, 10);
  const files = new Map();
  for (const f of list) {
    const ext = path.extname(f.url);
    const page = PAGES.test(f.url);
    const body = page ? Buffer.from(f.data.toString('utf8').replace(/__ASSET_V__/g, version)) : f.data;
    const entry = { type: TYPES[ext] || 'application/octet-stream', body, page, etag: crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20) };
    if (COMPRESSIBLE.test(ext) && body.length > 256) {
      const gz = zlib.gzipSync(body, { level: 9 });
      const br = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
      if (gz.length < body.length) entry.gz = gz;
      if (br.length < body.length) entry.br = br;
    }
    files.set(f.url, entry);
  }
  return { files, version };
}

function createApp(options = {}) {
  const C = { ...DEFAULTS, ...options };
  const { files, version } = loadStatic(C.publicDir);
  const rooms = new Map(); // code -> room
  let closed = false;
  const createLog = new Map(); // ip -> [timestamps of recent creates]

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    const q = req.url.indexOf('?');
    const pathname = q < 0 ? req.url : req.url.slice(0, q);
    const head = req.method === 'HEAD';
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end(head ? undefined : 'ok');
    }
    if (req.method !== 'GET' && !head) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const f = files.get(pathname === '/' ? '/index.html' : pathname); // map lookup: no path traversal possible
    if (!f) {
      // Tabs and installed apps from before the switch to WebP still ask for the old PNG card art.
      const old = /^\/cards\/([a-z0-9]+)\.png$/.exec(pathname);
      if (old && files.has(`/cards/${old[1]}.webp`)) {
        res.writeHead(301, { Location: `/cards/${old[1]}.webp?v=${version}`, 'Cache-Control': 'public, max-age=86400' });
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(head ? undefined : 'Not found');
    }
    const ae = String(req.headers['accept-encoding'] || '');
    let body = f.body;
    let enc = null;
    if (f.br && /\bbr\b/.test(ae)) { body = f.br; enc = 'br'; } else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; enc = 'gzip'; }
    const versioned = q >= 0 && new URLSearchParams(req.url.slice(q + 1)).get('v') === version;
    const headers = {
      'Content-Type': f.type,
      'Cache-Control': f.page ? 'no-cache' : versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      ETag: `"${f.etag}${enc ? '-' + enc : ''}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    if (f.gz || f.br) headers.Vary = 'Accept-Encoding';
    const inm = req.headers['if-none-match'];
    if (inm && inm.includes(f.etag)) { res.writeHead(304, headers); return res.end(); }
    if (enc) headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(head ? undefined : body);
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({
    server,
    maxPayload: 4096,
    perMessageDeflate: {
      threshold: 512, // state messages (1-4 KB of JSON) shrink by ~75%
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
      concurrencyLimit: 8,
    },
  });
  wss.on('error', (e) => console.error('wss error', e.message));

  function newCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
      if (!rooms.has(c)) return c;
    }
  }

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
  const err = (ws, msg, extra) => send(ws, { type: 'error', msg, ...extra });
  const tokenOf = (room, pid) => { for (const [t, v] of room.tokens) if (v === pid) return t; return null; };
  const absent = (p, now) => p.left || (!p.connected && now - p.dcAt >= C.graceMs);
  const live = (room) => rooms.get(room.code) === room;

  // The view is identical for every player (all cards are face up), so it is
  // serialised once per broadcast and only `you` is spliced in per socket.
  function stateParts(room) {
    const now = Date.now();
    const g = room.game;
    const v = g.view();
    // Lobby seats offline past the grace period are left out when the game starts.
    if (g.phase === 'lobby') g.players.forEach((p, i) => { if (absent(p, now)) v.players[i].away = true; });
    v.code = room.code;
    v.hostId = room.hostId;
    v.msTotal = C.turnMs;
    const base = JSON.stringify(v);
    const left = (t) => (t ? Math.max(0, t - now) : null);
    const timing = `"msLeft":${left(room.deadline)},"graceLeft":${left(room.graceAt)},"nextLeft":${left(room.nextAt)}`;
    return { key: `${base}|${room.deadline}|${room.graceAt}|${room.nextAt}`, body: `${timing},${base.slice(1)}` };
  }
  const forPlayer = (body, pid) => `{"type":"state","you":${JSON.stringify(pid)},${body}`;

  function broadcast(room) {
    const { key, body } = stateParts(room);
    if (key === room.lastKey) return false; // nothing changed: skip the fan-out
    room.lastKey = key;
    for (const [pid, ws] of room.sockets) send(ws, forPlayer(body, pid));
    return true;
  }
  const sendState = (room, pid, ws) => send(ws, forPlayer(stateParts(room).body, pid));

  // The host keeps the role through short disconnects; otherwise the first connected player takes over.
  function fixHost(room, now) {
    const g = room.game;
    const h = g.byId(room.hostId);
    if (h && !h.left && (h.connected || now - h.dcAt < C.graceMs)) return;
    const next = g.players.find((p) => !p.left && p.connected);
    if (next) room.hostId = next.id;
    else if (!h || h.left) room.hostId = (g.players.find((p) => !p.left) || {}).id || null;
  }

  const actorKey = (g) => { const a = g.actorId(); return a ? `${g.round}|${a}|${g.seq}` : null; };

  // One timer per room, woken at the earliest of: the turn deadline, or the end of
  // the reconnect grace period of the current actor, the host, or (in the lobby) any
  // disconnected seat, whose `away` flag then flips.
  function armTimer(room, now) {
    const g = room.game;
    const key = actorKey(g);
    if (!key) room.deadline = 0;
    else if (key !== room.timerKey || !room.deadline) room.deadline = now + C.turnMs;
    room.timerKey = key;
    const ap = key && g.byId(g.actorId());
    room.graceAt = ap && !ap.connected && !ap.left ? ap.dcAt + C.graceMs : 0;
    room.nextAt = g.phase === 'roundEnd' || g.phase === 'over' ? room.phaseAt + C.continueMs : 0;
    const h = g.byId(room.hostId);
    // (nextAt needs no wake-up: clients count it down themselves and the server checks it on 'next'.)
    const graceEnds = [room.graceAt, h && !h.connected && !h.left ? h.dcAt + C.graceMs : 0];
    if (g.phase === 'lobby') for (const p of g.players) if (!p.connected) graceEnds.push(p.dcAt + C.graceMs);
    // Grace ends that already passed were handled by settle() and are dropped (with nobody
    // connected the host's stays in the past: re-waking for it would spin). The turn deadline is
    // never dropped: settle() enforces it once passed, so it cannot be skipped.
    const wakes = graceEnds.filter((t) => t > now);
    if (room.deadline) wakes.push(room.deadline);
    clearTimeout(room.timer);
    room.timer = null;
    if (!wakes.length || closed) return;
    room.timer = setTimeout(() => wake(room), Math.max(0, Math.min(...wakes) - now) + 15);
    room.timer.unref(); // the HTTP server keeps the process alive; timers alone should not
  }

  function wake(room) {
    room.timer = null;
    if (!live(room)) return;
    try { settle(room); } catch (e) { console.error('timer error', e); }
  }

  // Auto-play absent players and anyone past the turn deadline, fix the host, re-arm the timer,
  // broadcast if anything changed. The deadline is enforced here rather than only in wake(): any
  // settle() (a bystander reconnecting, say) may land after the deadline but before its wake-up.
  function settle(room) {
    const g = room.game;
    const now = Date.now(); // one clock reading, so "absent" here and the wake-ups in armTimer agree
    for (let guard = 0; guard < 500; guard++) {
      if (g.autoStep((p) => absent(p, now))) continue;
      const key = actorKey(g);
      if (!key || key !== room.timerKey || !room.deadline || now < room.deadline) break;
      room.deadline = 0; // enforced once; armTimer() gives whoever acts next a fresh deadline
      if (!g.forceAct()) break;
    }
    fixHost(room, now);
    if (g.phase !== room.lastPhase) { room.lastPhase = g.phase; room.phaseAt = now; }
    armTimer(room, now);
    return broadcast(room);
  }

  function deleteRoom(room, why) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    for (const ws of room.sockets.values()) { ws.ctx = null; err(ws, why || 'This room has closed.', { gone: true }); }
    room.sockets.clear();
  }

  // Hard removal (explicit leave, or a lobby seat that expired). Returns false if the room is gone.
  function dropPlayer(room, pid, by) {
    const g = room.game;
    g.leavePlayer(pid);
    for (const [t, v] of room.tokens) if (v === pid) room.tokens.delete(t);
    const s = room.sockets.get(pid);
    if (s) {
      s.ctx = null;
      room.sockets.delete(pid);
      if (s !== by) err(s, 'You left this game.', { gone: true });
    }
    if (g.phase !== 'lobby' && g.players.filter((p) => !p.left).length < 2) g.toLobby();
    if (g.players.length === 0) { deleteRoom(room); return false; }
    return true;
  }

  // soft = the socket closed (phone locked, network blip): the seat is kept.
  function leave(ws, soft) {
    const ctx = ws.ctx;
    if (!ctx) return;
    ws.ctx = null;
    const { room, pid } = ctx;
    if (!live(room)) return;
    if (room.sockets.get(pid) === ws) room.sockets.delete(pid);
    if (soft) {
      const p = room.game.byId(pid);
      if (p && !room.sockets.has(pid)) { p.connected = false; p.dcAt = Date.now(); }
    } else if (!dropPlayer(room, pid, ws)) return;
    settle(room);
  }

  function joinRoom(ws, room, m, isRejoin) {
    const g = room.game;
    let pid = typeof m.token === 'string' ? room.tokens.get(m.token) : null;
    let p = pid ? g.byId(pid) : null;
    if (ws.ctx && ws.ctx.room === room && (!p || ws.ctx.pid === pid)) {
      // Already seated here on this socket (double tap, duplicate rejoin): just resend.
      send(ws, { type: 'joined', code: room.code, token: tokenOf(room, ws.ctx.pid) });
      return sendState(room, ws.ctx.pid, ws);
    }
    if (!p) {
      if (isRejoin) return err(ws, `Your seat in room ${room.code} has expired.`, { gone: true, expired: true, code: room.code });
      if (g.phase !== 'lobby') return err(ws, 'Game already in progress.');
      const name = cleanName(m.name);
      if (!name) return err(ws, 'Enter a name.');
      const same = g.players.find((o) => o.name.toLowerCase() === name.toLowerCase());
      if (same && same.connected) return err(ws, 'Name already taken in this room.');
      if (!same && g.players.length >= C.maxPlayers) return err(ws, 'Room is full.');
      if (ws.ctx) leave(ws, false); // this socket switches rooms: release its old seat first
      if (same) {
        // The same person back from another browser or device (in-app browser -> Safari, laptop ->
        // phone) takes over their offline lobby seat. The lobby holds nothing worth protecting;
        // the old token stops working.
        pid = same.id;
        for (const [t, v] of room.tokens) if (v === pid) room.tokens.delete(t);
      } else {
        pid = crypto.randomBytes(4).toString('hex');
        g.addPlayer(pid, name);
      }
      room.tokens.set(crypto.randomBytes(16).toString('hex'), pid);
      p = g.byId(pid);
    } else if (ws.ctx) {
      leave(ws, false);
    }
    p.connected = true;
    p.dcAt = 0;
    const old = room.sockets.get(pid);
    if (old && old !== ws) {
      // Same seat opened elsewhere (another tab or device): tell the old one not to auto-reconnect.
      old.ctx = null;
      send(old, { type: 'replaced' });
      old.close(4001, 'replaced');
    }
    room.sockets.set(pid, ws);
    ws.ctx = { room, pid };
    room.lastActive = Date.now();
    send(ws, { type: 'joined', code: room.code, token: tokenOf(room, pid) });
    if (!settle(room)) sendState(room, pid, ws);
  }

  function createAllowed(ip) {
    const now = Date.now();
    const list = (createLog.get(ip) || []).filter((t) => now - t < 60000);
    createLog.set(ip, list);
    if (list.length >= C.createsPerMin) return false;
    list.push(now);
    return true;
  }

  function newRoom() {
    const now = Date.now();
    return {
      code: newCode(), game: new Game(C.rng || Math.random), hostId: null, tokens: new Map(), sockets: new Map(),
      timer: null, timerKey: null, deadline: 0, graceAt: 0, nextAt: 0, lastKey: null,
      lastPhase: 'lobby', phaseAt: now, lastActive: now, emptySince: 0,
    };
  }

  // Per-socket token bucket; excess messages are dropped silently.
  function allow(ws) {
    const now = Date.now();
    ws.bucket = Math.min(C.msgBurst, ws.bucket + ((now - ws.bucketAt) * C.msgPerSec) / 1000);
    ws.bucketAt = now;
    if (ws.bucket < 1) return false;
    ws.bucket -= 1;
    return true;
  }

  function handle(ws, m) {
    switch (m.type) {
      case 'ping': return send(ws, { type: 'pong' });
      case 'sync': return ws.ctx ? sendState(ws.ctx.room, ws.ctx.pid, ws) : send(ws, { type: 'pong' });
      case 'create': {
        if (!cleanName(m.name)) return err(ws, 'Enter a name.');
        if (!createAllowed(ws.ip)) return err(ws, 'Too many new rooms. Wait a minute and try again.');
        if (rooms.size >= C.maxRooms) sweep();
        if (rooms.size >= C.maxRooms) return err(ws, 'Server busy. Try again soon.');
        const room = newRoom();
        rooms.set(room.code, room);
        joinRoom(ws, room, { name: m.name }, false);
        if (room.game.players.length === 0) deleteRoom(room);
        return;
      }
      case 'join':
      case 'rejoin': {
        const room = rooms.get((typeof m.code === 'string' ? m.code : '').trim().toUpperCase());
        if (!room) return err(ws, m.type === 'rejoin' ? 'That game has ended.' : 'Room not found.', { gone: m.type === 'rejoin' });
        return joinRoom(ws, room, m, m.type === 'rejoin');
      }
      case 'leave': {
        if (typeof m.code === 'string' && typeof m.token === 'string') {
          // Release a specific seat (e.g. the old game when following an invite to another room).
          const room = rooms.get(m.code.toUpperCase());
          const pid = room && room.tokens.get(m.token);
          if (!pid) return;
          if (ws.ctx && ws.ctx.room === room && ws.ctx.pid === pid) return leave(ws, false);
          if (dropPlayer(room, pid, ws)) settle(room);
          return;
        }
        return leave(ws, false);
      }
      default:
    }
    if (!ws.ctx) return;
    const { room, pid } = ws.ctx;
    const g = room.game;
    room.lastActive = Date.now();
    if (m.type === 'react') {
      const now = Date.now();
      if (!REACTIONS.includes(m.e) || now - ws.lastReact < C.reactGapMs) return;
      ws.lastReact = now;
      const msg = JSON.stringify({ type: 'react', from: pid, e: m.e });
      for (const s of room.sockets.values()) send(s, msg);
      return;
    }
    // Actions carry the state seq the player acted on; stale ones (double taps) are ignored.
    const stale = typeof m.seq === 'number' && m.seq !== g.seq;
    const anyone = pid === room.hostId || Date.now() - room.phaseAt >= C.continueMs;
    let ok = false;
    switch (m.type) {
      case 'start': {
        if (pid !== room.hostId || g.phase !== 'lobby') break;
        // Seats offline past the grace period (shown as `away`) are not dealt in: mid-game they
        // would be auto-stayed for the whole game.
        const now = Date.now();
        const ghosts = g.players.filter((p) => absent(p, now));
        if (g.players.length - ghosts.length < 2) break;
        for (const p of ghosts) dropPlayer(room, p.id);
        ok = g.start();
        break;
      }
      case 'hit': ok = !stale && g.hit(pid); break;
      case 'stay': ok = !stale && g.stay(pid); break;
      case 'target': ok = !stale && g.choose(pid, String(m.id)); break;
      case 'next': ok = anyone && g.nextRound(); break;
      case 'again': ok = anyone && g.phase === 'over' && g.start(); break;
      default: return;
    }
    // A rejected action only refreshes the sender; nobody else hears about it.
    if (!ok || !settle(room)) sendState(room, pid, ws);
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.ctx = null;
    ws.bucket = C.msgBurst;
    ws.bucketAt = Date.now();
    ws.lastReact = 0;
    ws.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    // Protocol errors (oversized or invalid frames) are emitted here; ws closes the socket itself.
    ws.on('error', () => {});
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw, isBinary) => {
      ws.isAlive = true;
      if (isBinary || !allow(ws)) return;
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
      try { handle(ws, m); } catch (e) { console.error('message error', m.type, e); }
    });
    ws.on('close', () => { try { leave(ws, true); } catch (e) { console.error('close error', e); } });
  });

  // Expire lobby seats and delete abandoned rooms. Emptiness is computed here
  // from live sockets rather than trusted from earlier bookkeeping.
  function sweep() {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      const g = room.game;
      let changed = false;
      if (g.phase === 'lobby') {
        for (const p of [...g.players]) {
          if (!p.connected && now - p.dcAt > C.lobbyGraceMs) {
            changed = true;
            if (!dropPlayer(room, p.id)) break;
          }
        }
        if (!live(room)) continue;
      }
      const anyLive = [...room.sockets.values()].some((s) => s.readyState === 1);
      room.emptySince = anyLive ? 0 : room.emptySince || now;
      if (g.players.length === 0 || (room.emptySince && now - room.emptySince > C.emptyRoomMs) || now - room.lastActive > C.idleRoomMs) {
        deleteRoom(room, 'This room closed after being idle.');
        continue;
      }
      if (changed) settle(room);
    }
    for (const [ip, list] of createLog) if (!list.length || now - list[list.length - 1] > 60000) createLog.delete(ip);
  }

  // Heartbeat: drop sockets that stopped answering pings, then sweep.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    try { sweep(); } catch (e) { console.error('sweep error', e); }
  }, C.sweepMs);
  interval.unref();

  function notifyAll(msg) {
    const s = JSON.stringify(msg);
    for (const ws of wss.clients) send(ws, s);
  }

  function close(cb) {
    closed = true;
    clearInterval(interval);
    for (const room of rooms.values()) clearTimeout(room.timer);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close(cb);
  }

  return { server, wss, rooms, version, files, sweep, notifyAll, close };
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const app = createApp();
  app.server.listen(PORT, () => console.log(`Flip 7 listening on ${PORT}`));
  // Render sends SIGTERM on deploys and spin-down: warn players before in-memory rooms are lost.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    app.notifyAll({ type: 'notice', msg: 'The server is restarting. Rooms will be reset.' });
    setTimeout(() => app.close(() => process.exit(0)), 300).unref();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp, cleanName, loadStatic, DEFAULTS };
