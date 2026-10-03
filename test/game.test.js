'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, buildDeck } = require('../game');

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
  g.stay('p1');
  assert.strictEqual(g.phase, 'roundEnd');
  assert.strictEqual(g.byId('p0').total, 3);
  assert.strictEqual(g.byId('p1').total, 4);
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

test('forceAct stays the stalling player and resolves pending choices', () => {
  const g = withDeck(2, [N(3), N(4), A('freeze')]);
  g.hit('p0');
  assert.ok(g.pending);
  assert.ok(g.forceAct());
  assert.strictEqual(g.pending, null);
  assert.strictEqual(g.byId('p1').status, 'frozen');
  assert.ok(g.forceAct()); // p0's turn -> stay
  assert.strictEqual(g.byId('p0').status, 'stayed');
});

// ---------- regression tests for engine fixes ----------
const M = (v) => ({ k: 'm', v });

// Deterministic PRNG so fuzz failures reproduce.
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const same = (a, b) => a.k === b.k && a.v === b.v && a.a === b.a;
// Full 94-card deck whose first draws are `top` (in order); dealing starts at p0.
function arranged(n, top, rng = mulberry32(1)) {
  const rest = buildDeck();
  for (const c of top) rest.splice(rest.findIndex((d) => same(d, c)), 1);
  const g = new Game(rng);
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.dealer = n - 2;
  g.deck = rest.concat(top.slice().reverse());
  g.startRound();
  return g;
}
// Every card is somewhere: deck, discard, a hand, a bust slot, the effect queue or a pending choice.
function cardCount(g) {
  let n = g.deck.length + g.discard.length;
  if (g.phase !== 'roundEnd' && g.phase !== 'over') for (const p of g.players) n += p.held.length + (p.bustCard ? 1 : 0);
  for (const q of g.queue) n += (q.card ? 1 : 0) + (q.deferred ? q.deferred.length : 0);
  if (g.pending) n++;
  return n;
}
function finishRound(g) {
  for (let i = 0; i < 1000 && (g.phase === 'deal' || g.phase === 'play'); i++) {
    if (g.pending) g.choose(g.pending.pid, g.pending.options[0]);
    else g.stay(g.players[g.turn].id);
  }
}

test('a player frozen during the opening deal is not dealt a card', () => {
  const g = arranged(3, [A('freeze'), N(5), N(12)]);
  assert.ok(g.pending && g.pending.pid === 'p0');
  g.choose('p0', 'p2'); // p2 frozen before their deal
  const p2 = g.byId('p2');
  assert.strictEqual(p2.status, 'frozen');
  assert.deepStrictEqual(p2.numbers, []);
  assert.strictEqual(g.roundScore(p2), 0);
  assert.deepStrictEqual(g.byId('p1').numbers, [5]);
  assert.ok(same(g.deck[g.deck.length - 1], N(12)), 'the 12 stays on the deck');
  assert.strictEqual(cardCount(g), 94);
});

test('a player busted by a deal-time Flip Three is not dealt again', () => {
  const g = arranged(3, [A('flip3'), N(10), N(10), N(5), N(12)]);
  g.choose('p0', 'p2'); // p2 flips 10, 10 -> bust
  const p2 = g.byId('p2');
  assert.strictEqual(p2.status, 'busted');
  assert.deepStrictEqual(p2.numbers, [10]);
  assert.ok(same(p2.bustCard, N(10)));
  assert.deepStrictEqual(g.byId('p1').numbers, [5]);
  assert.ok(same(g.deck[g.deck.length - 1], N(12)));
  assert.strictEqual(cardCount(g), 94);
});

test('Flip 7 during Flip Three does not destroy the deferred action card', () => {
  const g = arranged(2, [N(1), N(2), N(3), N(4), N(5), N(6), A('flip3'), A('freeze'), N(7), N(8)]);
  g.hit('p0'); // 3
  g.stay('p1');
  g.hit('p0'); g.hit('p0'); g.hit('p0'); // 4 5 6
  g.hit('p0'); // Flip Three on self (only active player): freeze (deferred), 7, 8 -> Flip 7
  assert.strictEqual(g.flip7By, 'p0');
  assert.ok(g.phase === 'roundEnd' || g.phase === 'over');
  assert.strictEqual(g.queue.length, 0);
  assert.strictEqual(g.deck.length + g.discard.length, 94);
  assert.ok(g.discard.some((c) => c.a === 'freeze'), 'freeze went to the discard');
});

test('Second Chance puts the held card itself in the discard', () => {
  const g = arranged(2, [A('second'), N(6), N(5), N(5)]);
  const sc = g.byId('p0').held.find((c) => c.a === 'second');
  g.hit('p0'); // 5
  g.stay('p1');
  g.hit('p0'); // duplicate 5 absorbed
  assert.ok(g.discard.includes(sc));
  assert.strictEqual(cardCount(g), 94);
});

test('dealer rotation does not skip a seat when the dealer leaves', () => {
  const g = new Game(mulberry32(7));
  for (let i = 0; i < 4; i++) g.addPlayer('p' + i, 'P' + i);
  g.start();
  assert.strictEqual(g.players[g.dealer].id, 'p0');
  finishRound(g);
  g.nextRound();
  assert.strictEqual(g.players[g.dealer].id, 'p1');
  g.leavePlayer('p1'); // the dealer leaves mid-round
  finishRound(g);
  g.nextRound();
  assert.strictEqual(g.players[g.dealer].id, 'p2');
  finishRound(g);
  g.nextRound();
  assert.strictEqual(g.players[g.dealer].id, 'p3');
});

test('dealer rotation keeps order when a player before the dealer leaves', () => {
  const g = new Game(mulberry32(8));
  for (let i = 0; i < 4; i++) g.addPlayer('p' + i, 'P' + i);
  g.start();
  finishRound(g);
  g.nextRound(); // dealer p1
  g.leavePlayer('p0');
  finishRound(g);
  g.nextRound();
  assert.strictEqual(g.players[g.dealer].id, 'p2');
});

test('automatic targets are random among other players, not always seat 0', () => {
  const pick = (r) => {
    const g = arranged(3, [N(3), N(4), N(5), A('freeze')], () => r);
    g.hit('p0');
    assert.ok(g.pending && g.pending.pid === 'p0');
    return g.autoTarget();
  };
  assert.strictEqual(pick(0), 'p1');
  assert.strictEqual(pick(0.99), 'p2');
});

test('autoStep only acts for players the predicate marks absent', () => {
  const g = arranged(2, [N(3), N(4)]);
  g.byId('p0').connected = false;
  assert.strictEqual(g.autoStep(() => false), false, 'within the grace period nothing happens');
  assert.strictEqual(g.byId('p0').status, 'active');
  assert.strictEqual(g.autoStep((p) => !p.connected), true);
  assert.strictEqual(g.byId('p0').status, 'stayed');
});

test('start needs two players; start and nextRound report success', () => {
  const g = new Game();
  g.addPlayer('a', 'A');
  assert.strictEqual(g.start(), false);
  assert.strictEqual(g.phase, 'lobby');
  g.addPlayer('b', 'B');
  assert.strictEqual(g.start(), true);
  assert.strictEqual(g.nextRound(), false);
});

test('view is shared by all players and trimmed', () => {
  const g = arranged(2, [N(3), N(4)]);
  const v = g.view();
  assert.strictEqual(v.you, undefined);
  assert.strictEqual(g.view('p1').you, 'p1');
  assert.strictEqual(typeof v.seq, 'number');
  assert.strictEqual(v.lastRound, null);
  for (let i = 0; i < 40; i++) g.say('line ' + i);
  assert.strictEqual(g.view().log.length, 12);
  finishRound(g);
  assert.ok(Array.isArray(g.view().lastRound));
  g.nextRound();
  assert.strictEqual(g.view().lastRound, null, 'last round results are not resent during play');
});

test('seeded random games: cards conserved, nobody out of the round gains cards, turns valid', () => {
  for (let s = 1; s <= 400; s++) {
    const rng = mulberry32(s);
    const g = new Game(rng);
    const n = 2 + (s % 11);
    for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
    g.start();
    let steps = 0;
    while (g.phase !== 'over' && steps++ < 20000) {
      assert.strictEqual(cardCount(g), 94, `seed ${s}: card count`);
      if (g.phase === 'roundEnd') {
        assert.strictEqual(g.deck.length + g.discard.length, 94, `seed ${s}: 94 cards at round end`);
        g.nextRound();
        continue;
      }
      const before = g.players.map((p) => ({ out: p.status !== 'active', n: p.numbers.length + p.mods.length }));
      if (g.pending) {
        const o = g.pending.options;
        assert.ok(g.choose(g.pending.pid, o[Math.floor(rng() * o.length)]));
      } else {
        assert.ok(g.awaiting, `seed ${s}: waiting on a player`);
        const p = g.players[g.turn];
        assert.strictEqual(p.status, 'active', `seed ${s}: turn belongs to an active player`);
        assert.ok(rng() < 0.3 ? g.stay(p.id) : g.hit(p.id));
      }
      if (g.phase === 'deal' || g.phase === 'play') {
        g.players.forEach((p, i) => {
          if (before[i].out) assert.ok(p.numbers.length + p.mods.length <= before[i].n, `seed ${s}: out player gained a card`);
        });
      }
    }
    assert.strictEqual(g.phase, 'over', `seed ${s}: game ended`);
  }
});
