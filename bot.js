'use strict';
// Flip 7 bot: decisions use only what a card counter at the table could know
// (the cards still in the draw pile are the full deck minus everything face up or discarded).

const MEAN_FALLBACK = 6;

function pileStats(g, p) {
  const n = g.deck.length;
  let dup = 0, gain = 0;
  for (const c of g.deck) {
    if (c.k === 'n') { if (p.numbers.includes(c.v)) dup++; else gain += c.v; }
    else if (c.k === 'm') gain += c.v;
    else if (c.k === 'x') gain += g.roundScore(p, false);
  }
  return { n, bust: n ? dup / n : 0, gain: n ? gain / n : MEAN_FALLBACK };
}

// 'hit' or 'stay' for the player whose turn it is.
function hitOrStay(g, p) {
  const score = g.roundScore(p, false);
  if (score === 0) return 'hit'; // nothing to lose yet
  const { n, bust, gain } = pileStats(g, p);
  if (n === 0) return 'stay';
  const risk = p.second ? bust * 0.3 : bust; // a Second Chance absorbs one duplicate
  let ev = (1 - risk) * gain - risk * score;
  if (p.numbers.length === 6) ev += (1 - risk) * 15; // the seventh number is a Flip 7 (+15)
  const mine = p.total + score;
  const best = Math.max(0, ...g.players.filter((o) => o.id !== p.id).map((o) => o.total + g.roundScore(o, false)));
  if (mine >= 200 && mine > best) return 'stay'; // banking the win
  return ev > 0 ? 'hit' : 'stay';
}

// Pick a target for the pending Freeze / Flip Three / Second Chance.
function pickTarget(g, p) {
  const pd = g.pending;
  const others = pd.options.filter((id) => id !== p.id).map((id) => g.byId(id)).filter(Boolean);
  const pickMax = (list, key) => list.reduce((a, b) => (key(b) > key(a) ? b : a));
  const pickMin = (list, key) => list.reduce((a, b) => (key(b) < key(a) ? b : a));
  if (!others.length) return p.id;
  if (pd.card.a === 'freeze') return pickMax(others, (o) => g.roundScore(o, false)).id;
  if (pd.card.a === 'flip3') {
    // Make the player closest to busting flip three; a cautious bot flips them itself only when it is safe.
    const risky = pickMax(others, (o) => o.numbers.length + (o.second ? -2 : 0));
    if (pd.options.includes(p.id) && p.numbers.length <= 1 && risky.numbers.length <= 2) return p.id;
    return risky.id;
  }
  return pickMin(others, (o) => o.total).id; // spare Second Chance: help whoever is furthest behind
}

// What the bot would do right now, or null when it is not its decision.
function decide(g, p) {
  if (g.pending) return g.pending.pid === p.id ? { type: 'target', id: pickTarget(g, p) } : null;
  if (g.phase === 'play' && g.awaiting && g.players[g.turn] === p) return { type: hitOrStay(g, p) };
  return null;
}

module.exports = { decide, hitOrStay, pickTarget };
