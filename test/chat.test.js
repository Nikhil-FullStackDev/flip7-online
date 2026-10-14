// Flip 7 chat rides on the game's own WebSocket: seated players talk, history replays, strangers/spam are refused.
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createApp } = require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function start() { const app = createApp({ sweepMs: 60000 }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); app.port = app.server.address().port; return app; }
function client(app) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}`);
  const c = { ws, msgs: [], state: null };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'state') c.state = m; });
  ws.on('error', () => {});
  c.open = new Promise(r => ws.on('open', r));
  c.send = m => ws.send(JSON.stringify(m));
  c.until = async (pred, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (c.msgs.some(pred)) return true; await sleep(15); } return false; };
  return c;
}

test('chat over the WebSocket: delivery, history, validation and rate limit', async () => {
  const app = await start();
  try {
    const a = client(app); await a.open; a.send({ type: 'create', name: 'Ann' });
    assert.ok(await a.until(m => m.type === 'chatlog'), 'creator gets the (empty) history');
    const code = a.state.code;
    const b = client(app); await b.open; b.send({ type: 'join', code, name: 'Bo' });
    assert.ok(await b.until(m => m.type === 'chatlog'));

    a.send({ type: 'chat', text: '  hi   Bo ' });
    assert.ok(await b.until(m => m.type === 'chat' && m.msg.text === 'hi Bo'), 'the other player gets it, cleaned');
    assert.ok(await a.until(m => m.type === 'chat' && m.msg.text === 'hi Bo'), 'and the sender gets the echo');
    const got = b.msgs.find(m => m.type === 'chat').msg;
    assert.strictEqual(got.from, 'Ann');
    assert.strictEqual(got.key, a.msgs.find(m => m.type === 'chatlog').you, 'messages carry the sender seat id so clients can mark their own');

    b.send({ type: 'chat', emote: '🎉' });
    assert.ok(await a.until(m => m.type === 'chat' && m.msg.emote === '🎉'));
    b.send({ type: 'chat', emote: 'nope' });
    assert.ok(await b.until(m => m.type === 'chaterr' && /emote/i.test(m.msg)));
    b.send({ type: 'chat', text: '   ' });
    assert.ok(await b.until(m => m.type === 'chaterr' && /empty/i.test(m.msg)));

    // someone who joins later (or reconnects) gets the history
    const c = client(app); await c.open; c.send({ type: 'join', code, name: 'Cy' });
    assert.ok(await c.until(m => m.type === 'chatlog' && m.log.length >= 2), 'history replayed');

    // spam: a burst is allowed, the rest is refused
    for (let i = 0; i < 12; i++) c.send({ type: 'chat', text: 'spam ' + i });
    assert.ok(await c.until(m => m.type === 'chaterr' && /slow/i.test(m.msg)), 'rate limited');

    // not seated => nothing (the socket has no room)
    const d = client(app); await d.open; d.send({ type: 'chat', text: 'let me in' });
    await sleep(100);
    assert.ok(!d.msgs.some(m => m.type === 'chat'), 'a socket that is not in a room gets nothing');
    [a, b, c, d].forEach(x => x.ws.close());
  } finally { await new Promise(r => app.close(r)); }
});
