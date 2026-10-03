'use strict';
// Server tests: start the real app on an ephemeral port and drive it with ws clients.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { createApp, cleanName } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function start(opts = {}) {
  const app = createApp({ sweepMs: 60000, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  app.port = app.server.address().port;
  return app;
}
const stop = (app) => new Promise((r) => app.close(r));

function get(app, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path, headers, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function client(app) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}`);
  const c = { ws, msgs: [], waiters: [], state: null, joined: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    c.msgs.push(m);
    if (m.type === 'state') c.state = m;
    if (m.type === 'joined') c.joined = m;
    c.waiters = c.waiters.filter((w) => !w(m));
  });
  ws.on('error', () => {});
  c.open = new Promise((r) => ws.on('open', r));
  c.closed = new Promise((r) => ws.on('close', (code) => r(code)));
  c.send = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  c.next = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
    c.waiters.push((m) => { if (!pred(m)) return false; clearTimeout(t); resolve(m); return true; });
  });
  c.count = (type) => c.msgs.filter((m) => m.type === type).length;
  return c;
}

async function seat(app, name, code) {
  const c = client(app);
  await c.open;
  const st = c.next((m) => m.type === 'state');
  c.send(code ? { type: 'join', code, name } : { type: 'create', name });
  await st;
  return c;
}

async function rejoin(app, old) {
  const c = client(app);
  await c.open;
  const st = c.next((m) => m.type === 'state');
  c.send({ type: 'rejoin', code: old.joined.code, token: old.joined.token });
  await st;
  c.joined = old.joined;
  return c;
}

// Play every decision (stay / first target) until the round is over.
async function playOutRound(app, code, clients) {
  const room = app.rooms.get(code);
  const g = room.game;
  for (let i = 0; i < 200 && (g.phase === 'deal' || g.phase === 'play'); i++) {
    const actor = g.actorId();
    const c = clients.find((x) => x.state && x.state.you === actor);
    const st = c.next((m) => m.type === 'state');
    if (g.pending) c.send({ type: 'target', id: g.pending.options[0], seq: g.seq });
    else c.send({ type: 'stay', seq: g.seq });
    await st;
  }
  await sleep(30);
}

async function lobbyOf(app, n) {
  const host = await seat(app, 'Host');
  const code = host.joined.code;
  const others = [];
  for (let i = 1; i < n; i++) others.push(await seat(app, 'P' + i, code));
  await sleep(20);
  return { code, host, all: [host, ...others] };
}

test('cleanName keeps real names and trims by code point', () => {
  assert.strictEqual(cleanName('प्रिया'), 'प्रिया');
  assert.strictEqual(cleanName('Zoë'), 'Zoë');
  assert.strictEqual(cleanName("O'Brien"), "O'Brien");
  assert.strictEqual(cleanName('😀😀'), '');
  assert.strictEqual(cleanName({ toString: () => 'Ann' }), 'Ann');
  assert.strictEqual([...cleanName('𝒜'.repeat(20))].length, 16);
  assert.strictEqual(cleanName('  a   b  '), 'a b');
});

test('static files: brotli/gzip, ETag 304, versioned immutable cards, healthz, no traversal', async () => {
  const app = await start();
  try {
    const page = await get(app, '/', { 'accept-encoding': 'br, gzip' });
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers['content-encoding'], 'br');
    assert.strictEqual(page.headers.vary, 'Accept-Encoding');
    assert.strictEqual(page.headers['cache-control'], 'no-cache');
    assert.strictEqual(Number(page.headers['content-length']), page.body.length);
    const gz = await get(app, '/', { 'accept-encoding': 'gzip' });
    assert.strictEqual(gz.headers['content-encoding'], 'gzip');
    const plain = await get(app, '/');
    const html = plain.body.toString();
    assert.ok(!html.includes('__ASSET_V__'), 'asset version filled in');
    assert.ok(html.includes(`.webp?v=${app.version}`) || html.includes('?v=${V}'));
    const again = await get(app, '/', { 'accept-encoding': 'br', 'if-none-match': page.headers.etag });
    assert.strictEqual(again.status, 304);

    const card = await get(app, `/cards/n7.webp?v=${app.version}`);
    assert.strictEqual(card.status, 200);
    assert.strictEqual(card.headers['content-type'], 'image/webp');
    assert.match(card.headers['cache-control'], /immutable/);
    assert.doesNotMatch((await get(app, '/cards/n7.webp')).headers['cache-control'], /immutable/);

    // Every asset the page and manifest reference exists.
    const manifest = (await get(app, '/manifest.webmanifest')).body.toString();
    const refs = new Set([...(html + manifest).matchAll(/\/(?:cards|icons)\/[\w.-]+\.(?:webp|png)/g)].map((m) => m[0]));
    for (const c of ['n0', 'n12', 'm2', 'm10', 'x2', 'freeze', 'flip3', 'second', 'back']) refs.add(`/cards/${c}.webp`);
    for (const r of refs) assert.strictEqual((await get(app, r)).status, 200, r);
    assert.ok(![...app.files.keys()].some((f) => f.startsWith('/cards/') && f.endsWith('.png')), 'no PNG card art left');
    // Tabs and installed apps from before the WebP switch still ask for the PNGs: redirected.
    for (const c of ['n7', 'back']) {
      const legacy = await get(app, `/cards/${c}.png`);
      assert.strictEqual(legacy.status, 301, c);
      assert.strictEqual(legacy.headers.location, `/cards/${c}.webp?v=${app.version}`);
    }
    assert.strictEqual((await get(app, '/cards/nope.png')).status, 404);

    assert.strictEqual((await get(app, '/healthz')).body.toString(), 'ok');
    assert.strictEqual((await get(app, '/healthz', {}, 'HEAD')).status, 200);
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/cards/../../server.js', '/server.js', '/package.json']) {
      assert.strictEqual((await get(app, p)).status, 404, p);
    }
    assert.strictEqual((await get(app, '/', {}, 'POST')).status, 405);
  } finally { await stop(app); }
});

test('oversized or malformed frames do not crash the server', async () => {
  const app = await start();
  try {
    const bad = client(app);
    await bad.open;
    bad.send('x'.repeat(5000)); // over maxPayload: ws emits an error on the socket
    assert.strictEqual(await bad.closed, 1009);
    const bin = client(app);
    await bin.open;
    bin.ws.send(Buffer.from([0xff, 0xfe]), { binary: true });
    for (const junk of ['nope', '[]', 'null', '{"type":5}', '{"type":"hit"}', '{"type":"join","code":{},"name":[]}', '{"type":"rejoin","code":"ABCD","token":{}}']) bin.send(junk);
    await sleep(50);
    assert.strictEqual((await get(app, '/healthz')).status, 200);
    const ok = await seat(app, 'Ann');
    assert.ok(ok.joined.code);
  } finally { await stop(app); }
});

test('the WebSocket negotiates compression and each player gets their own `you`', async () => {
  const app = await start();
  try {
    const { all } = await lobbyOf(app, 2);
    assert.match(all[0].ws.extensions, /permessage-deflate/);
    assert.notStrictEqual(all[0].state.you, all[1].state.you);
    assert.strictEqual(all[0].state.hostId, all[0].state.you);
    assert.strictEqual(all[1].state.players.length, 2);
  } finally { await stop(app); }
});

test('invalid names never leave rooms behind; double create keeps one room', async () => {
  const app = await start();
  try {
    const c = client(app);
    await c.open;
    for (const name of ['', '   ', '😀😀', null]) {
      const e = c.next((m) => m.type === 'error');
      c.send({ type: 'create', name });
      assert.strictEqual((await e).msg, 'Enter a name.');
    }
    assert.strictEqual(app.rooms.size, 0);
    c.send({ type: 'create', name: 'Ann' });
    c.send({ type: 'create', name: 'Ann' }); // double tap
    await sleep(80);
    assert.strictEqual(app.rooms.size, 1);
    const [room] = app.rooms.values();
    assert.strictEqual(room.game.players.length, 1);
    c.ws.close();
    await sleep(50);
    app.sweep();
    assert.strictEqual(app.rooms.size, 1, 'kept for a reconnect while within the empty-room TTL');
  } finally { await stop(app); }
});

test('room creation is rate limited per client', async () => {
  const app = await start({ createsPerMin: 3 });
  try {
    const c = client(app);
    await c.open;
    for (let i = 0; i < 10; i++) c.send({ type: 'create', name: 'Spam' });
    await sleep(100);
    assert.ok(app.rooms.size <= 1, 'switching rooms releases the old one');
    assert.ok(c.msgs.some((m) => m.type === 'error' && /Too many new rooms/.test(m.msg)));
  } finally { await stop(app); }
});

test('abandoned rooms are swept; leaving the last seat deletes the room', async () => {
  const app = await start({ emptyRoomMs: 30 });
  try {
    const a = await seat(app, 'Ann');
    const b = await seat(app, 'Bob');
    a.send({ type: 'leave' });
    await sleep(50);
    assert.ok(!app.rooms.has(a.joined.code), 'explicit leave of the only player deletes the room');
    b.ws.close();
    await sleep(50);
    app.sweep();
    await sleep(50);
    app.sweep();
    assert.strictEqual(app.rooms.size, 0);
  } finally { await stop(app); }
});

test('a lobby player whose socket drops keeps their seat and can rejoin', async () => {
  const app = await start({ lobbyGraceMs: 150 });
  try {
    const { code, host, all } = await lobbyOf(app, 2);
    const bob = all[1];
    bob.ws.close();
    await host.next((m) => m.type === 'state' && m.players.some((p) => !p.connected));
    assert.strictEqual(app.rooms.get(code).game.players.length, 2);
    const bob2 = await rejoin(app, bob);
    assert.strictEqual(bob2.state.players.length, 2);
    assert.ok(bob2.state.players.every((p) => p.connected));
    // Past the lobby grace period the seat is released and a rejoin says so.
    bob2.ws.close();
    await sleep(250);
    app.sweep();
    assert.strictEqual(app.rooms.get(code).game.players.length, 1);
    const late = client(app);
    await late.open;
    const e = late.next((m) => m.type === 'error');
    late.send({ type: 'rejoin', code, token: bob.joined.token });
    const msg = await e;
    assert.ok(msg.gone && msg.expired && msg.code === code);
  } finally { await stop(app); }
});

test('rejoin to a missing room or with an unknown token is reported as gone', async () => {
  const app = await start();
  try {
    const { code } = await lobbyOf(app, 2);
    const c = client(app);
    await c.open;
    let e = c.next((m) => m.type === 'error');
    c.send({ type: 'rejoin', code: 'ZZZZ', token: 'ab'.repeat(16) });
    assert.ok((await e).gone);
    e = c.next((m) => m.type === 'error');
    c.send({ type: 'rejoin', code, token: 'ab'.repeat(16) });
    const m = await e;
    assert.ok(m.gone && m.expired);
  } finally { await stop(app); }
});

test('host is restored after everyone disconnects and reconnects at round end', async () => {
  const app = await start({ rng: mulberry32(5), graceMs: 80 });
  try {
    const { code, host, all } = await lobbyOf(app, 2);
    host.send({ type: 'start' });
    await all[1].next((m) => m.type === 'state' && m.phase !== 'lobby');
    await playOutRound(app, code, all);
    const room = app.rooms.get(code);
    for (const c of all) c.ws.close();
    await sleep(150); // past the grace period with nobody connected
    const bob = await rejoin(app, all[1]); // Bob comes back first
    assert.strictEqual(room.hostId, bob.state.you, 'a connected player is host');
    const ann = await rejoin(app, all[0]);
    assert.strictEqual(ann.state.hostId, bob.state.you);
    assert.strictEqual(room.game.phase, 'roundEnd');
    const st = ann.next((m) => m.type === 'state' && m.phase !== 'roundEnd');
    bob.send({ type: 'next' }); // the new host can continue: the room is not stuck
    await st;
    assert.notStrictEqual(room.game.phase, 'roundEnd');
  } finally { await stop(app); }
});

test('a short host blip keeps the host; anyone may continue after a while at round end', async () => {
  const app = await start({ rng: mulberry32(11), continueMs: 150 });
  try {
    const { code, host, all } = await lobbyOf(app, 3);
    const room = app.rooms.get(code);
    const hostId = host.state.you;
    host.ws.close();
    await sleep(40);
    const back = await rejoin(app, host);
    assert.strictEqual(room.hostId, hostId);
    back.send({ type: 'start' });
    await all[1].next((m) => m.type === 'state' && m.phase !== 'lobby');
    const players = [back, all[1], all[2]];
    await playOutRound(app, code, players);
    assert.strictEqual(room.game.phase, 'roundEnd');
    const guest = all[1];
    guest.send({ type: 'next' }); // too early for a non-host
    await sleep(40);
    assert.strictEqual(room.game.phase, 'roundEnd');
    assert.ok(guest.state.nextLeft > 0, 'clients get a countdown to show');
    await sleep(guest.state.nextLeft + 30);
    guest.send({ type: 'next' });
    await sleep(40);
    assert.notStrictEqual(room.game.phase, 'roundEnd');
  } finally { await stop(app); }
});

test('a disconnected player gets a grace period before being auto-played', async () => {
  const app = await start({ rng: mulberry32(11), graceMs: 300 });
  try {
    const { code, host, all } = await lobbyOf(app, 3);
    host.send({ type: 'start' });
    await all[1].next((m) => m.type === 'state' && m.phase !== 'lobby');
    const g = app.rooms.get(code).game;
    // Resolve deal-time choices so we are waiting on a turn.
    for (let i = 0; i < 20 && g.pending; i++) {
      const c = all.find((x) => x.state.you === g.pending.pid);
      c.send({ type: 'target', id: g.pending.options[0], seq: g.seq });
      await sleep(30);
    }
    assert.ok(g.phase === 'play' && g.awaiting, 'seeded deal leaves a turn to play');
    const actor = g.actorId();
    const victim = all.find((x) => x.state.you === actor);
    const watcher = all.find((x) => x !== victim);
    victim.ws.close();
    const st = await watcher.next((m) => m.type === 'state' && m.players.some((p) => p.id === actor && !p.connected));
    assert.strictEqual(st.turnId, actor, 'still their turn right after the drop');
    assert.ok(st.graceLeft > 0 && st.graceLeft <= 300);
    assert.strictEqual(g.byId(actor).status, 'active');
    await sleep(450);
    assert.notStrictEqual(g.actorId(), actor, 'auto-played after the grace period');
    assert.strictEqual(g.byId(actor).status, 'stayed');
  } finally { await stop(app); }
});

// Resolve deal-time target choices so the game is waiting on a hit/stay turn.
async function toTurn(app, code, all) {
  const g = app.rooms.get(code).game;
  for (let i = 0; i < 20 && g.pending; i++) {
    const c = all.find((x) => x.state.you === g.pending.pid);
    c.send({ type: 'target', id: g.pending.options[0], seq: g.seq });
    await sleep(30);
  }
  assert.ok(g.phase === 'play' && g.awaiting, 'seeded deal leaves a turn to play');
  return g;
}

test('a passed turn deadline is enforced even when another event settles the room before the timer fires', async () => {
  const app = await start({ rng: mulberry32(11), turnMs: 10000 });
  try {
    const { code, host, all } = await lobbyOf(app, 3);
    host.send({ type: 'start' });
    await all[1].next((m) => m.type === 'state' && m.phase !== 'lobby');
    const g = await toTurn(app, code, all);
    const room = app.rooms.get(code);
    const actor = g.actorId();
    const bystander = all.find((x) => x.state.you !== actor && x.state.you !== room.hostId);
    const watcher = all.find((x) => x !== bystander);
    // Event-loop lag: the deadline has passed but its wake-up has not run yet when a bystander drops.
    room.deadline = Date.now() - 5;
    const st = watcher.next((m) => m.type === 'state' && m.players.some((p) => p.id === bystander.state.you && !p.connected));
    bystander.ws.close();
    await st;
    assert.strictEqual(g.byId(actor).status, 'stayed', 'the stalling player was auto-played');
    assert.notStrictEqual(g.actorId(), actor);
    assert.ok(room.deadline === 0 || room.deadline > Date.now(), 'no stale deadline left behind');
    assert.strictEqual(!!room.timer, !!g.actorId(), 'the next turn has a live timer');
  } finally { await stop(app); }
});

test('in the lobby the same name from another device takes over an offline seat', async () => {
  const app = await start();
  try {
    const { code, host, all } = await lobbyOf(app, 2);
    const bob = all[1];
    const other = client(app);
    await other.open;
    let e = other.next((m) => m.type === 'error');
    other.send({ type: 'join', code, name: 'p1' });
    assert.strictEqual((await e).msg, 'Name already taken in this room.', 'an online seat keeps its name');
    bob.ws.close();
    await host.next((m) => m.type === 'state' && m.players.some((p) => !p.connected));
    const st = other.next((m) => m.type === 'state');
    other.send({ type: 'join', code, name: 'P1' });
    await st;
    assert.strictEqual(other.state.you, bob.state.you, 'same seat, no duplicate');
    assert.strictEqual(other.state.players.length, 2);
    assert.ok(other.state.players.every((p) => p.connected));
    assert.notStrictEqual(other.joined.token, bob.joined.token);
    const old = client(app);
    await old.open;
    e = old.next((m) => m.type === 'error');
    old.send({ type: 'rejoin', code, token: bob.joined.token });
    assert.ok((await e).expired, 'the old device\'s token stops working');
  } finally { await stop(app); }
});

test('lobby seats offline past the grace period are marked away and not dealt in', async () => {
  const app = await start({ graceMs: 80 });
  try {
    const { code, host, all } = await lobbyOf(app, 3);
    const ids = all.map((c) => c.state.you);
    all[2].ws.close();
    // The flag arrives on its own once the grace period ends: no other event is needed.
    const st = await host.next((m) => m.type === 'state' && m.players.some((p) => p.id === ids[2] && p.away), 1000);
    assert.ok(st.players.filter((p) => p.id !== ids[2]).every((p) => !p.away));
    const started = all[1].next((m) => m.type === 'state' && m.phase !== 'lobby');
    host.send({ type: 'start' });
    const s2 = await started;
    assert.deepStrictEqual(s2.players.map((p) => p.id), ids.slice(0, 2), 'the offline seat was left out');
    assert.strictEqual(app.rooms.get(code).game.players.length, 2);

    // With only one player online, start is refused and the offline seat is kept.
    const two = await lobbyOf(app, 2);
    two.all[1].ws.close();
    await two.host.next((m) => m.type === 'state' && m.players.some((p) => p.away), 1000);
    two.host.send({ type: 'start' });
    await sleep(50);
    const room = app.rooms.get(two.code);
    assert.strictEqual(room.game.phase, 'lobby');
    assert.strictEqual(room.game.players.length, 2);
  } finally { await stop(app); }
});

test('double-tapped actions are ignored by seq; rejected actions are not broadcast', async () => {
  const app = await start({ rng: mulberry32(11) });
  try {
    const { code, host, all } = await lobbyOf(app, 2);
    host.send({ type: 'start' });
    await all[1].next((m) => m.type === 'state' && m.phase !== 'lobby');
    const g = app.rooms.get(code).game;
    for (let i = 0; i < 20 && g.pending; i++) {
      const c = all.find((x) => x.state.you === g.pending.pid);
      c.send({ type: 'target', id: g.pending.options[0], seq: g.seq });
      await sleep(30);
    }
    assert.ok(g.phase === 'play' && g.awaiting, 'seeded deal leaves a turn to play');
    const actor = g.actorId();
    const me = all.find((x) => x.state.you === actor);
    const p = g.byId(actor);
    // Rig the deck so a hit cannot bust or trigger actions.
    const free = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((v) => !p.numbers.includes(v));
    g.deck.push({ k: 'n', v: free[0] }, { k: 'n', v: free[1] });
    const before = p.numbers.length;
    const seq = g.seq;
    me.send({ type: 'hit', seq });
    me.send({ type: 'hit', seq }); // double tap: same seq
    await sleep(80);
    assert.strictEqual(p.numbers.length, before + 1, 'exactly one card drawn');

    // Out-of-turn spam: only the sender is refreshed.
    const now = g.actorId();
    const idle = all.find((x) => x.state.you !== now);
    const watcher = all.find((x) => x !== idle);
    const idleStates = idle.count('state');
    const watched = watcher.count('state');
    for (let i = 0; i < 8; i++) idle.send({ type: 'hit' });
    for (let i = 0; i < 8; i++) idle.send({ type: 'next' });
    await sleep(80);
    assert.strictEqual(watcher.count('state'), watched, 'no broadcast for rejected actions');
    assert.ok(idle.count('state') > idleStates, 'the sender is resynced');
  } finally { await stop(app); }
});

test('reactions are throttled per socket', async () => {
  const app = await start();
  try {
    const { all } = await lobbyOf(app, 2);
    for (let i = 0; i < 6; i++) all[0].send({ type: 'react', e: '🔥' });
    all[0].send({ type: 'react', e: '<script>' });
    await sleep(80);
    assert.strictEqual(all[1].count('react'), 1);
  } finally { await stop(app); }
});

test('message flood is rate limited per socket', async () => {
  const app = await start({ msgBurst: 5, msgPerSec: 1 });
  try {
    const c = client(app);
    await c.open;
    for (let i = 0; i < 30; i++) c.send({ type: 'ping' });
    await sleep(80);
    assert.strictEqual(c.count('pong'), 5);
  } finally { await stop(app); }
});

test('the same seat opened twice: the old tab is told it was replaced and stops', async () => {
  const app = await start();
  try {
    const { all } = await lobbyOf(app, 2);
    const tab1 = all[1];
    const replaced = tab1.next((m) => m.type === 'replaced');
    const tab2 = await rejoin(app, tab1);
    await replaced;
    assert.strictEqual(await tab1.closed, 4001);
    await sleep(30);
    assert.strictEqual(tab2.ws.readyState, WebSocket.OPEN);
    assert.ok(tab2.state.players.every((p) => p.connected));
  } finally { await stop(app); }
});

test('leave with code + token releases a seat this socket is not attached to', async () => {
  const app = await start();
  try {
    const { code, all } = await lobbyOf(app, 3);
    const bob = all[1];
    bob.ws.close();
    await sleep(40);
    const fresh = client(app);
    await fresh.open;
    fresh.send({ type: 'leave', code, token: bob.joined.token });
    await sleep(40);
    assert.strictEqual(app.rooms.get(code).game.players.length, 2);
  } finally { await stop(app); }
});

test('switching rooms from one socket releases the previous seat', async () => {
  const app = await start();
  try {
    const a = await seat(app, 'Ann');
    const other = await seat(app, 'Cat');
    const oldCode = a.joined.code;
    const st = a.next((m) => m.type === 'state' && m.code === other.joined.code);
    a.send({ type: 'join', code: other.joined.code, name: 'Ann' });
    await st;
    assert.ok(!app.rooms.has(oldCode), 'the old one-player room is gone');
    assert.strictEqual(app.rooms.get(other.joined.code).game.players.length, 2);
  } finally { await stop(app); }
});

test('new players cannot join a game in progress', async () => {
  const app = await start();
  try {
    const { code, host, all } = await lobbyOf(app, 2);
    host.send({ type: 'start' });
    await all[1].next((m) => m.type === 'state' && m.phase !== 'lobby');
    const late = client(app);
    await late.open;
    const e = late.next((m) => m.type === 'error');
    late.send({ type: 'join', code, name: 'Late' });
    assert.strictEqual((await e).msg, 'Game already in progress.');
  } finally { await stop(app); }
});
