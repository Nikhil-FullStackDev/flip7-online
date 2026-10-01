'use strict';
// Flip 7 rules engine (server-authoritative, no I/O).

const TARGET_SCORE = 200;
const FLIP7_BONUS = 15;

function buildDeck() {
  const d = [{ k: 'n', v: 0 }];
  for (let v = 1; v <= 12; v++) for (let i = 0; i < v; i++) d.push({ k: 'n', v });
  for (const v of [2, 4, 6, 8, 10]) d.push({ k: 'm', v });
  d.push({ k: 'x' });
  for (const a of ['freeze', 'flip3', 'second']) for (let i = 0; i < 3; i++) d.push({ k: 'a', a });
  return d;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardName(c) {
  if (c.k === 'n') return String(c.v);
  if (c.k === 'm') return '+' + c.v;
  if (c.k === 'x') return 'x2';
  return { freeze: 'Freeze', flip3: 'Flip Three', second: 'Second Chance' }[c.a];
}

class Game {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.players = [];
    this.phase = 'lobby'; // lobby | deal | play | roundEnd | over
    this.deck = [];
    this.discard = [];
    this.dealer = 0;
    this.round = 0;
    this.log = [];
    this.seq = 0;
    this.queue = [];
    this.pending = null;
    this.turn = -1;
    this.awaiting = false;
    this.flip7By = null;
    this.exhausted = false;
    this.curF3 = null;
    this.lastRound = null;
    this.winner = null;
  }

  say(msg) {
    this.seq++;
    this.log.push(msg);
    if (this.log.length > 60) this.log.shift();
  }

  byId(id) { return this.players.find((p) => p.id === id); }

  addPlayer(id, name) {
    this.players.push({
      id, name, connected: true, total: 0,
      numbers: [], mods: [], second: false, status: 'active', held: [], bustCard: null,
    });
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
  }

  start() {
    this.players.forEach((p) => { p.total = 0; });
    this.deck = shuffle(buildDeck(), this.rng);
    this.discard = [];
    this.dealer = this.players.length - 1;
    this.round = 0;
    this.winner = null;
    this.lastRound = null;
    this.startRound();
  }

  // Explicit leave: lobby players vanish; mid-game they are auto-played until the round ends, then dropped.
  leavePlayer(id) {
    const p = this.byId(id);
    if (!p) return;
    if (this.phase === 'lobby') { this.removePlayer(id); return; }
    p.left = true;
    p.connected = false;
    this.say(`${p.name} left the game.`);
  }

  dropLeavers() {
    let d = this.dealer;
    for (let i = 0; i < this.dealer; i++) if (this.players[i] && this.players[i].left) d--;
    this.players = this.players.filter((p) => !p.left);
    const n = this.players.length || 1;
    this.dealer = ((d % n) + n) % n;
  }

  // Too few players left: back to the waiting room.
  toLobby() {
    this.dropLeavers();
    this.phase = 'lobby';
    this.round = 0;
    this.queue = []; this.pending = null; this.awaiting = false; this.turn = -1;
    this.flip7By = null; this.winner = null; this.lastRound = null;
    for (const p of this.players) { p.total = 0; p.numbers = []; p.mods = []; p.second = false; p.status = 'active'; p.held = []; p.bustCard = null; }
    this.say('Not enough players — back to the lobby.');
  }

  startRound() {
    this.dropLeavers();
    this.dealer = (this.dealer + 1) % this.players.length;
    this.round++;
    for (const p of this.players) {
      p.numbers = []; p.mods = []; p.second = false; p.status = 'active'; p.held = []; p.bustCard = null;
    }
    this.phase = 'deal';
    this.dealIdx = 0;
    this.queue = [];
    this.pending = null;
    this.turn = -1;
    this.awaiting = false;
    this.flip7By = null;
    this.exhausted = false;
    this.curF3 = null;
    this.say(`— Round ${this.round} —`);
    this.run();
  }

  draw() {
    if (this.deck.length === 0 && this.discard.length) {
      this.deck = shuffle(this.discard, this.rng);
      this.discard = [];
      this.say('Deck reshuffled.');
    }
    const c = this.deck.pop();
    if (!c) this.exhausted = true;
    return c || null;
  }

  activePlayers() { return this.players.filter((p) => p.status === 'active'); }

  // Engine loop: processes queued effects until input is needed or the round ends.
  run() {
    for (;;) {
      if (this.phase !== 'deal' && this.phase !== 'play') return;
      if (this.pending) return;
      if (this.flip7By != null || this.exhausted) { this.endRound(); return; }
      const t = this.queue.shift();
      if (t) { this.exec(t); continue; }
      if (this.phase === 'deal') {
        if (this.dealIdx < this.players.length) {
          const p = this.players[(this.dealer + 1 + this.dealIdx) % this.players.length];
          this.dealIdx++;
          const c = this.draw();
          if (c) this.receive(p, c, false);
          continue;
        }
        this.phase = 'play';
        this.turn = (this.dealer + 1 + this.players.length - 1) % this.players.length; // so advance starts after dealer
      }
      if (!this.advance()) { this.endRound(); return; }
      return;
    }
  }

  advance() {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.turn + i) % n;
      if (this.players[idx].status === 'active') {
        this.turn = idx;
        this.awaiting = true;
        return true;
      }
    }
    return false;
  }

  receive(p, card, inF3) {
    this.say(`${p.name} draws ${cardName(card)}.`);
    if (card.k === 'n') {
      if (p.numbers.includes(card.v)) {
        if (p.second) {
          p.second = false;
          p.held = p.held.filter((h) => !(h.k === 'a' && h.a === 'second'));
          this.discard.push(card, { k: 'a', a: 'second' });
          this.say(`${p.name} uses Second Chance — duplicate ${card.v} discarded.`);
        } else {
          p.status = 'busted';
          p.bustCard = card;
          this.say(`${p.name} BUSTS on a duplicate ${card.v}!`);
        }
      } else {
        p.numbers.push(card.v);
        p.held.push(card);
        if (p.numbers.length === 7) {
          this.flip7By = p.id;
          this.say(`${p.name} FLIPPED 7!`);
        }
      }
    } else if (card.k === 'm' || card.k === 'x') {
      p.mods.push(card);
      p.held.push(card);
    } else if (card.a === 'second') {
      if (!p.second) {
        p.second = true;
        p.held.push(card);
      } else {
        const options = this.activePlayers().filter((o) => o.id !== p.id && !o.second).map((o) => o.id);
        if (options.length === 0) this.discard.push(card);
        else if (options.length === 1) this.giveSecond(options[0], card);
        else this.pending = { pid: p.id, card, options };
      }
    } else if (inF3 && this.curF3) {
      this.curF3.deferred.push({ pid: p.id, card });
    } else {
      this.queue.unshift({ t: 'choose', pid: p.id, card });
    }
  }

  giveSecond(tid, card) {
    const t = this.byId(tid);
    t.second = true;
    t.held.push(card);
    this.say(`Second Chance goes to ${t.name}.`);
  }

  exec(t) {
    if (t.t === 'choose') {
      const p = this.byId(t.pid);
      if (!p || p.status !== 'active') { this.discard.push(t.card); return; }
      const options = this.activePlayers().map((o) => o.id);
      if (options.length === 1) this.applyAction(t.card, p, p);
      else this.pending = { pid: p.id, card: t.card, options };
    } else if (t.t === 'f3') {
      const p = this.byId(t.pid);
      const alive = p.status === 'active' && this.flip7By == null;
      if (!alive || t.left === 0) {
        const keep = p.status === 'active';
        for (let i = t.deferred.length - 1; i >= 0; i--) {
          const d = t.deferred[i];
          if (keep) this.queue.unshift({ t: 'choose', pid: d.pid, card: d.card });
          else this.discard.push(d.card);
        }
        return;
      }
      const c = this.draw();
      if (!c) return;
      this.curF3 = t;
      this.receive(p, c, true);
      this.curF3 = null;
      t.left--;
      this.queue.unshift(t);
    }
  }

  applyAction(card, chooser, target) {
    if (card.a === 'freeze') {
      target.status = 'frozen';
      this.say(`${chooser.name} freezes ${target.name}.`);
      this.discard.push(card);
    } else if (card.a === 'flip3') {
      this.say(`${chooser.name} makes ${target.name} flip three!`);
      this.discard.push(card);
      this.queue.unshift({ t: 'f3', pid: target.id, left: 3, deferred: [] });
    } else if (card.a === 'second') {
      this.giveSecond(target.id, card);
    }
  }

  // ---- player actions ----
  hit(pid) {
    if (this.phase !== 'play' || !this.awaiting || this.pending) return false;
    const p = this.players[this.turn];
    if (p.id !== pid) return false;
    this.awaiting = false;
    const c = this.draw();
    if (c) this.receive(p, c, false);
    this.run();
    return true;
  }

  stay(pid) {
    if (this.phase !== 'play' || !this.awaiting || this.pending) return false;
    const p = this.players[this.turn];
    if (p.id !== pid) return false;
    this.awaiting = false;
    p.status = 'stayed';
    this.say(`${p.name} stays (${this.roundScore(p)} pts).`);
    this.run();
    return true;
  }

  choose(pid, tid) {
    const pd = this.pending;
    if (!pd || pd.pid !== pid || !pd.options.includes(tid)) return false;
    this.pending = null;
    if (pd.card.a === 'second') this.giveSecond(tid, pd.card);
    else this.applyAction(pd.card, this.byId(pid), this.byId(tid));
    this.run();
    return true;
  }

  nextRound() {
    if (this.phase !== 'roundEnd') return false;
    this.startRound();
    return true;
  }

  // Resolve decisions for disconnected players. Returns true if it acted.
  autoStep() {
    if (this.pending) {
      const pl = this.byId(this.pending.pid);
      if (pl && !pl.connected) {
        const o = this.pending.options.find((id) => id !== pl.id) || this.pending.options[0];
        return this.choose(pl.id, o);
      }
    } else if (this.phase === 'play' && this.awaiting) {
      const pl = this.players[this.turn];
      if (!pl.connected) return this.stay(pl.id);
    }
    return false;
  }

  // Turn timer expiry: act for the player who is stalling.
  forceAct() {
    if (this.pending) {
      const o = this.pending.options.find((id) => id !== this.pending.pid) || this.pending.options[0];
      return this.choose(this.pending.pid, o);
    }
    if (this.phase === 'play' && this.awaiting) return this.stay(this.players[this.turn].id);
    return false;
  }

  roundScore(p, flip7 = p.id === this.flip7By) {
    if (p.status === 'busted') return 0;
    let s = p.numbers.reduce((a, b) => a + b, 0);
    if (p.mods.some((m) => m.k === 'x')) s *= 2;
    for (const m of p.mods) if (m.k === 'm') s += m.v;
    if (flip7) s += FLIP7_BONUS;
    return s;
  }

  endRound() {
    const results = this.players.map((p) => {
      const pts = this.roundScore(p);
      p.total += pts;
      return { id: p.id, name: p.name, pts, busted: p.status === 'busted', flip7: p.id === this.flip7By };
    });
    for (const p of this.players) {
      this.discard.push(...p.held);
      if (p.bustCard) this.discard.push(p.bustCard);
    }
    this.lastRound = results;
    this.pending = null;
    this.awaiting = false;
    const top = Math.max(...this.players.map((p) => p.total));
    const leaders = this.players.filter((p) => p.total === top);
    if (top >= TARGET_SCORE && leaders.length === 1) {
      this.phase = 'over';
      this.winner = leaders[0].id;
      this.say(`${leaders[0].name} wins with ${top} points!`);
    } else {
      this.phase = 'roundEnd';
      this.say('Round over.');
    }
  }

  view(forId) {
    const cur = this.phase === 'play' && this.awaiting ? this.players[this.turn] : null;
    return {
      phase: this.phase,
      round: this.round,
      you: forId,
      turnId: cur ? cur.id : null,
      dealerId: this.players[this.dealer] ? this.players[this.dealer].id : null,
      pending: this.pending
        ? { pid: this.pending.pid, card: this.pending.card, options: this.pending.options }
        : null,
      deckCount: this.deck.length,
      target: TARGET_SCORE,
      winner: this.winner,
      lastRound: this.lastRound,
      log: this.log.slice(-25),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, connected: p.connected, total: p.total,
        numbers: p.numbers, mods: p.mods, second: p.second, status: p.status,
        bustCard: p.bustCard, score: this.phase === 'lobby' ? 0 : this.roundScore(p),
        flip7: p.id === this.flip7By,
      })),
    };
  }
}

module.exports = { Game, buildDeck, cardName, TARGET_SCORE, FLIP7_BONUS };
