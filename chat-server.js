'use strict';
// In-room chat shared by the multiplayer games. Chat runs on its own SSE stream (GET /api/chat/events) and
// POST endpoint (/api/chat), so it never touches a game's own connection, snapshots or bot timers.
// Per-room state lives in a WeakMap keyed by the room object: when a game drops a room, its chat goes with it.
//
//   const chat = require('./chat-server')({
//     room: code => rooms.get(code),                       // the game's room object for a (normalised) code, or undefined
//     who: (room, token) => name | null,                   // the player's display name for a seat token, null if not seated
//   });
//   ... in the request handler:  if (chat.handle(req, res, url)) return;
//
// Games with their own transport (WebSockets) call chat.add() / chat.log() directly.
const crypto = require('crypto');

const EMOTES = ['😂', '😮', '😭', '👏', '🔥', '😈', '👍', '❤️', '🤔', '😎', '🙏', '🎉'];
// Control characters, zero-width and bidi-override characters (they let text spoof other text).
const BAD = new RegExp('[' + [
  '\u0000-\u001f', '\u007f-\u009f',                 // control characters
  '\u200b-\u200f', '\u2028\u2029', '\u2060-\u2064', '\ufeff',  // zero-width and line/paragraph separators
  '\u202a-\u202e', '\u2066-\u2069',                 // bidi overrides and isolates
].join('') + ']', 'g');

function clean(text, max = 200) {
  return String(text == null ? '' : text).replace(BAD, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const keyOf = token => crypto.createHash('sha1').update(String(token)).digest('hex').slice(0, 8);

module.exports = function createChat(opts) {
  const { room: getRoom, who } = opts;
  const LOG = opts.logSize || 50, MAX_TEXT = opts.maxText || 200, BURST = opts.burst || 5, PER_SEC = opts.perSec || 1.25;
  const MAX_CLIENTS = opts.maxClients || 40, PER_SEAT = opts.perSeat || 3;
  const state = new WeakMap();
  const st = room => {
    let s = state.get(room);
    if (!s) { s = { log: [], clients: new Set(), seq: 0, buckets: new Map() }; state.set(room, s); }
    return s;
  };

  const send = (res, event, data) => { try { if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* socket gone */ } };
  const json = (res, code, obj) => { if (res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const lookup = (code, token) => {
    const room = getRoom(String(code || '').trim().toUpperCase());
    const name = room && typeof token === 'string' && token ? who(room, token) : null;
    return name ? { room, name, key: keyOf(token) } : null;
  };

  // Validates, rate-limits and stores one message; fans it out to this room's SSE clients.
  // Returns { msg } or { error }. Games with their own transport also deliver `msg` themselves.
  function add(room, key, name, payload) {
    const s = st(room), now = Date.now();
    payload = payload || {};
    const emote = payload.emote != null ? String(payload.emote) : '';
    const text = emote ? '' : clean(payload.text, MAX_TEXT);
    if (emote && !EMOTES.includes(emote)) return { error: 'Unknown emote' };
    if (!emote && !text) return { error: 'Empty message' };
    let b = s.buckets.get(key);
    if (!b) { b = { n: BURST, t: now }; s.buckets.set(key, b); }
    b.n = Math.min(BURST, b.n + ((now - b.t) / 1000) * PER_SEC);
    b.t = now;
    if (b.n < 1) return { error: 'Slow down a little' };
    b.n -= 1;
    const msg = { n: ++s.seq, at: now, key, from: name };
    if (emote) msg.emote = emote; else msg.text = text;
    s.log.push(msg);
    if (s.log.length > LOG) s.log.shift();
    for (const c of s.clients) send(c.res, 'msg', msg);
    return { msg };
  }
  const log = room => st(room).log.slice();

  function stream(req, res, url) {
    const who_ = lookup(url.searchParams.get('code'), url.searchParams.get('token'));
    if (!who_) return json(res, 404, { error: 'Room not found' });
    const s = st(who_.room);
    if (s.clients.size >= MAX_CLIENTS) return json(res, 503, { error: 'Chat is full' });
    const mine = [...s.clients].filter(c => c.key === who_.key);
    while (mine.length >= PER_SEAT) { const old = mine.shift(); s.clients.delete(old); try { old.res.end(); } catch { /* gone */ } } // extra tabs: oldest makes way
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const client = { res, key: who_.key };
    s.clients.add(client);
    send(res, 'hello', { you: who_.key, emotes: EMOTES });
    send(res, 'log', s.log);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* gone */ } }, 25000);
    req.on('close', () => { clearInterval(hb); s.clients.delete(client); });
  }

  function post(req, res) {
    let body = '', dead = false;
    req.on('data', d => { body += d; if (body.length > 2048 && !dead) { dead = true; json(res, 413, { error: 'Too big' }); req.destroy(); } });
    req.on('end', () => {
      if (dead) return;
      let b; try { b = JSON.parse(body || '{}'); } catch { b = null; }
      if (!b || typeof b !== 'object') return json(res, 400, { error: 'Bad request' });
      const w = lookup(b.code, b.token);
      if (!w) return json(res, 403, { error: 'Not in this room' });
      const r = add(w.room, w.key, w.name, b);
      if (r.error) return json(res, r.error === 'Slow down a little' ? 429 : 400, { error: r.error });
      json(res, 200, { ok: true, n: r.msg.n });
    });
    req.on('error', () => { /* client aborted */ });
  }

  function handle(req, res, url) {
    if (url.pathname === '/api/chat/events' && req.method === 'GET') { stream(req, res, url); return true; }
    if (url.pathname === '/api/chat' && req.method === 'POST') { post(req, res); return true; }
    return false;
  }

  return { handle, add, log, EMOTES, clean, keyOf };
};
module.exports.EMOTES = EMOTES;
module.exports.clean = clean;
module.exports.keyOf = keyOf;
