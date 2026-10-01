'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, buildDeck } = require('../game');

function rigged(names, cards) {
  const g = new Game(() => 0.5);
  names.forEach((n, i) => g.addPlayer('p' + i, n));
  g.start();
  return g;
}

// Start a game, then overwrite the deck so draws come out in the given order.
function withDeck(n, cards) {
  const g = new Game();
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.deck = [];
  g.dealer = n - 2; // startRound advances it, so dealing starts at p0
  g.round = 0;
  g.deck = cards.slice().reverse();
  g.startRound();
  return g;
}
const N = (v) => ({ k: 'n', v });
const A = (a) => ({ k: 'a', a });

test('deck has 94 cards with correct composition', () => {
  const d = buildDeck();
  assert.strictEqual(d.length, 94);
  assert.strictEqual(d.filter((c) => c.k === 'n').length, 79);
  assert.strictEqual(d.filter((c) => c.k === 'a').length, 9);
  assert.strictEqual(d.filter((c) => c.k === 'n' && c.v === 12).length, 12);
});

test('duplicate busts, scores zero', () => {
  const g = withDeck(2, [N(5), N(6), N(5)]); // p0:5, p1:6, p0 hits 5
  assert.strictEqual(g.turn, 0);
  g.hit('p0');
  assert.strictEqual(g.byId('p0').status, 'busted');
  assert.strictEqual(g.roundScore(g.byId('p0')), 0);
  assert.strictEqual(g.turn, 1);
});

test('second chance absorbs a duplicate', () => {
  const g = withDeck(2, [A('second'), N(6), N(5), N(5)]);
  assert.ok(g.byId('p0').second);
  g.hit('p0'); // 5
  g.stay('p1');
  g.hit('p0'); // dup 5
  assert.strictEqual(g.byId('p0').status, 'active');
  assert.strictEqual(g.byId('p0').second, false);
});

test('flip 7 ends round with bonus', () => {
  const g = withDeck(2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 12].map(N));
  // p0:1 p1:2, p0 hits 3, p1 hits 4 ... p0 gets 1,3,5,7,9,11 then 12 -> 7 uniques
  for (let i = 0; i < 5; i++) { g.hit('p0'); g.hit('p1'); }
  g.hit('p0');
  assert.strictEqual(g.phase === 'roundEnd' || g.phase === 'over', true);
  assert.strictEqual(g.byId('p0').total, 1 + 3 + 5 + 7 + 9 + 11 + 12 + 15 - 0);
});

test('modifiers: x2 doubles numbers only, then plus bonus', () => {
  const g = withDeck(2, [N(5), N(6), { k: 'x' }, { k: 'm', v: 4 }]);
  g.hit('p0'); g.hit('p1'); // p0 x2, p1 +4
  g.hit('p0'); g.stay('p0');
  g.hit('p1'); g.stay('p1');
  assert.strictEqual(g.roundScore(g.byId('p0')), 10);
  assert.strictEqual(g.roundScore(g.byId('p1')), 10);
});

test('freeze on self banks and removes player; round ends when none active', () => {
  const g = withDeck(2, [N(3), N(4), A('freeze')]);
  g.hit('p0');
  assert.ok(g.pending && g.pending.pid === 'p0');
  g.choose('p0', 'p0');
  assert.strictEqual(g.byId('p0').status, 'frozen');
  assert.strictEqual(g.turn, 1);
});

test('flip three draws three cards and defers action cards', () => {
  const g = withDeck(2, [N(1), N(2), A('flip3'), N(3), A('freeze'), N(4)]);
  g.hit('p0');
  g.choose('p0', 'p1'); // p1 flips 3: 3, freeze(deferred), 4
  assert.deepStrictEqual(g.byId('p1').numbers.sort(), [2, 3, 4]);
  assert.ok(g.pending && g.pending.pid === 'p1'); // p1 must now pick freeze target
  g.choose('p1', 'p0');
  assert.strictEqual(g.byId('p0').status, 'frozen');
});

test('random bot games always finish', () => {
  for (let s = 0; s < 200; s++) {
    const g = new Game();
    const n = 2 + (s % 6);
    for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
    g.start();
    let steps = 0;
    while (g.phase !== 'over' && steps++ < 20000) {
      if (g.phase === 'roundEnd') { g.nextRound(); continue; }
      if (g.pending) {
        const o = g.pending.options;
        assert.ok(g.choose(g.pending.pid, o[Math.floor(Math.random() * o.length)]));
      } else {
        const p = g.players[g.turn];
        if (Math.random() < 0.35) g.stay(p.id); else g.hit(p.id);
      }
    }
    assert.strictEqual(g.phase, 'over', 'game ended');
  }
});
