// Engine tests: hand evaluator cases + randomized full-hand simulation with invariant checks.
// Run: node tests/engine.test.mjs
import * as E from '../public/js/engine.js';

let fails = 0;
const ok = (cond, msg) => { if(!cond){ fails++; console.error('FAIL:', msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const name = cs => E.handName(E.bestOf(cs.split(' ')));

// ---------- evaluator ----------
eq(name('As Ks Qs Js Ts 2d 3c'), 'Royal Flush', 'royal');
eq(name('9h 8h 7h 6h 5h Ad Kc'), 'Straight Flush', 'straight flush');
eq(name('5d 4d 3d 2d Ad Kc Qh'), 'Straight Flush', 'steel wheel');
eq(name('7s 7h 7d 7c 2d 3c 4h'), 'Four of a Kind', 'quads');
eq(name('Ks Kh Kd 2c 2d 3c 4h'), 'Full House', 'boat');
eq(name('Ks Kh Kd 2c 2d 2h 4h'), 'Full House', 'two trips -> boat');
eq(name('2h 7h 9h Jh Kh 3c 4d'), 'Flush', 'flush');
eq(name('Ah 2c 3d 4s 5h 9c Kd'), 'Straight', 'wheel');
eq(name('Th Jc Qd Ks Ah 2c 3d'), 'Straight', 'broadway');
eq(name('Qs Kh Ad 2c 3d 7h 8s'), 'High Card', 'no wrap straight');
eq(name('8s 8h 8d Kc 2d 3c 4h'), 'Three of a Kind', 'trips');
eq(name('8s 8h Kd Kc 2d 3c 4h'), 'Two Pair', 'two pair');
eq(name('8s 8h Kd Qc 2d 3c 4h'), 'Pair', 'pair');
eq(name('As 9h Kd Qc 2d 3c 4h'), 'High Card', 'high card');
const cmpH = (a, b) => Math.sign(E.cmp(E.bestOf(a.split(' ')), E.bestOf(b.split(' '))));
eq(cmpH('Ah 2c 3d 4s 5h 9c 9d', '2h 3c 4d 5s 6h 9c 9d'), -1, 'wheel < six-high straight');
eq(cmpH('As Ad Kc 7h 3d 2c 4s', 'Ah Ac Qc 7h 3d 2c 4s'), 1, 'pair kicker');
eq(cmpH('Ks Kd 8c 8h 2d 3c Ah', 'Kh Kc 8d 8s 2h 3d Qh'), 1, 'two pair kicker');
eq(cmpH('Ks Kd 8c 8h Ad 3c 2h', 'Kh Kc 8d 8s As 4d 2c'), 0, 'split: same best five');
eq(cmpH('2h 7h 9h Jh Ah 3c 4d', '2h 7h 9h Jh Kh 3c 4d'), 1, 'flush high card');
eq(cmpH('Ts Td Tc 4h 4d 9c 2s', '9s 9d 9h Ah Ad 3c 2s'), 1, 'boat by trips');

// ---------- best five + descriptions ----------
for(let t = 0; t < 3000; t++){
  const seven = E.newDeck().slice(0, 7), b = E.bestFive(seven);
  ok(b.five.length === 5 && b.five.every(c => seven.includes(c)), 'best five are 5 of the 7 cards');
  ok(E.cmp(E.eval5(b.five), b.score) === 0, 'best five make the reported score');
  ok(E.cmp(b.score, E.bestOf(seven)) === 0, 'bestFive agrees with bestOf');
  ok(typeof E.describe(b.score) === 'string' && E.describe(b.score).startsWith(E.handName(b.score).replace('Pair','Pair').split(' ')[0]) || b.score[0] === 1, 'description starts with hand name');
}
eq(E.describe(E.bestOf('Ks Kh Kd 2c 9d 3c 4h'.split(' '))), 'Three of a Kind · Kings', 'describe trips');
eq(E.describe(E.bestOf('Ah 2c 3d 4s 5h 9c Kd'.split(' '))), 'Straight · Five high', 'describe wheel');
eq(E.describe(E.bestOf('Ks Kh Kd 2c 2d 3c 4h'.split(' '))), 'Full House · Kings full of 2s', 'describe boat');

// ---------- odds ----------
{
  const pct = (h, b, o, n = 6000) => { const r = E.equity(h.split(' '), b ? b.split(' ') : [], o, n); return { win: r.win/n, tie: r.tie/n, cats: r.cats.map(c => c/n) }; };
  const aa = pct('As Ah', '', 1); ok(aa.win > .82 && aa.win < .89, `AA vs 1 ≈ 85% (got ${aa.win})`);
  const aa5 = pct('As Ah', '', 5); ok(aa5.win > .44 && aa5.win < .54, `AA vs 5 ≈ 49% (got ${aa5.win})`);
  const nuts = pct('As Ks', 'Qs Js Ts 2d 3c', 3, 300); ok(nuts.win === 1, 'royal flush on the river always wins');
  const fd = pct('Ah Kh', '2h 7h 9c', 0, 4000); ok(Math.abs(fd.cats[5] + fd.cats[8] - .35) < .03, `flush by the river from a flop draw ≈ 35% (got ${fd.cats[5]})`);
  const c = pct('7c 2d', '', 2, 500); ok(Math.abs(c.cats.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'final-hand odds sum to 1');
}

// ---------- deck ----------
for(let t = 0; t < 200; t++){ const d = E.newDeck(); ok(d.length === 52 && new Set(d).size === 52, 'deck has 52 unique cards'); }

// ---------- randomized play ----------
const R = () => Math.random();
function randomTable(){
  const sb = [1,5,25][Math.floor(R()*3)], bb = sb*2;
  const S = E.mkState({ sb, bb, buyIn: bb*100, minBuy: bb*20, table: 'T' });
  const n = 2 + Math.floor(R()*5);
  const seats = [...Array(E.MAXS).keys()].sort(() => R()-.5).slice(0, n);
  for(const i of seats) S.seats[i] = E.mkSeat({ token: 't'+i, pid: 'p'+i, name: 'P'+i, av: '🙂',
    stack: R() < .3 ? 1 + Math.floor(R()*bb*3) : bb*(20 + Math.floor(R()*200)), bot: R() < .5 });
  return S;
}
const stacks = S => S.seats.reduce((a, s) => a + (s ? s.stack : 0), 0);
// chips on the table mid-hand: stacks + everything committed to the pot
const chips = S => E.isActive(S) ? stacks(S) + E.potTotal(S) : stacks(S);
function checkCards(S, ctx){
  const seen = [...S.deck, ...S.board, ...S.burned || []];
  for(const s of S.seats) if(s) seen.push(...s.cards);
  const live = S.seats.filter(s => s && s.cards.length).length;
  ok(new Set(seen).size === seen.length, `${ctx}: duplicate card`);
  ok(S.seats.every(s => !s || !s.inHand || s.cards.length === 2), `${ctx}: in-hand seat without 2 cards`);
  const want = { preflop: 0, flop: 3, turn: 4, river: 5 }[S.street];
  if(want !== undefined) ok(S.board.length === want, `${ctx}: board ${S.board.length} on ${S.street}`);
  void live;
}

let hands = 0, actions = 0, showdowns = 0, splits = 0, sidepots = 0;
for(let game = 0; game < 3000; game++){
  const S = randomTable();
  for(let h = 0; h < 12; h++){
    const before = stacks(S);
    if(!E.startHand(S)) break;
    hands++;
    let guard = 0;
    while(S.street !== 'showdown'){
      if(++guard > 500){ ok(false, 'hand did not finish'); break; }
      checkCards(S, `game ${game} hand ${h}`);
      ok(chips(S) === before, `chips conserved mid-hand (game ${game})`);
      if(S.runout){ E.endRound(S); continue; }
      const i = S.toAct;
      ok(i >= 0 && S.seats[i] && S.seats[i].inHand && !S.seats[i].folded && !S.seats[i].allIn, `toAct ${i} valid on ${S.street}`);
      if(!(i >= 0)) break;
      const s = S.seats[i], toCall = S.curBet - s.bet;
      const opts = E.legalActions(S, i);
      // illegal actions must be rejected without changing state
      if(toCall > 0){ const snap = JSON.stringify(S); ok(!E.applyAction(S, i, 'check'), 'check facing bet rejected'); ok(JSON.stringify(S) === snap, 'rejected action leaves state'); }
      ok(!E.applyAction(S, (i+1) % E.MAXS === i ? i : [...Array(E.MAXS).keys()].find(k => k !== i && S.seats[k]) ?? i, 'call') || false, 'out-of-turn rejected');
      let a, amt;
      const r = R();
      if(s.bot && r < .5) [a, amt] = E.botMove(S, i);
      else if(r < .15 && toCall > 0) a = 'fold';
      else if(r < .55) a = toCall > 0 ? 'call' : 'check';
      else if(r < .65) a = 'allin';
      else { a = 'raise'; amt = opts.minTo + Math.floor(R() * (opts.maxTo - opts.minTo + 1)); if(R() < .2) amt = opts.minTo - 1; }
      const curBefore = S.curBet, minRBefore = S.minRaise;
      const res = E.applyAction(S, i, a, amt);
      ok(res, `legal action ${a} applied (toCall ${toCall}, stack ${s.stack})`);
      actions++;
      if(a === 'raise' && res && S.curBet > curBefore && !s.allIn) ok(S.curBet - curBefore >= minRBefore, 'full raise respects min raise');
      ok(chips(S) === before, 'chips conserved after action');
      ok(S.seats.every(x => !x || x.stack >= 0), 'no negative stacks');
    }
    ok(chips(S) === before, `chips conserved at showdown (game ${game} hand ${h})`);
    const R2 = S.results; ok(!!R2, 'results present');
    if(R2){
      const won = Object.values(R2.won).reduce((a, b) => a + b, 0);
      ok(won === E.potTotal(S), `all chips awarded: won ${won} pot ${E.potTotal(S)}`);
      if(Object.keys(R2.hands).length) showdowns++;
      if(Object.keys(R2.won).length > 1) splits++;
      if((R2.pots || []).length > 1) sidepots++;
      // every winner must hold the best hand among players eligible for a pot they won
      for(const p of R2.pots || []){
        const best = Math.max(...p.elig.map(k => 0)); void best;
        const scores = p.elig.map(k => E.bestOf([...S.seats[k].cards, ...S.board]));
        let top = scores[0]; for(const sc of scores) if(E.cmp(sc, top) > 0) top = sc;
        for(const w of p.winners) ok(E.cmp(E.bestOf([...S.seats[w].cards, ...S.board]), top) === 0, 'pot winner has best hand');
        ok(p.winners.every(w => p.elig.includes(w)), 'winner eligible for pot');
      }
    }
    // next hand housekeeping like the host does
    for(const s of S.seats) if(s && s.stack === 0 && R() < .5) s.stack = S.buyIn;
    S.dead = 0;
  }
}
console.log(`${hands} hands, ${actions} actions, ${showdowns} showdowns, ${splits} split pots, ${sidepots} with side pots`);

// ---------- targeted rules ----------
{ // heads-up: dealer posts SB and acts first preflop, BB acts first after
  const S = E.mkState({ sb: 1, bb: 2, buyIn: 200, minBuy: 40, table: 'H' });
  S.seats[0] = E.mkSeat({ token: 'a', pid: 'a', name: 'A', av: '', stack: 200 });
  S.seats[3] = E.mkSeat({ token: 'b', pid: 'b', name: 'B', av: '', stack: 200 });
  E.startHand(S);
  ok(S.seats[S.dealer].bet === 1, 'HU dealer posts SB');
  ok(S.toAct === S.dealer, 'HU dealer acts first preflop');
  E.applyAction(S, S.toAct, 'call'); ok(S.street === 'preflop' && S.toAct !== S.dealer, 'BB gets option');
  E.applyAction(S, S.toAct, 'check'); ok(S.street === 'flop' && S.toAct !== S.dealer, 'BB acts first postflop');
}
{ // incomplete all-in raise does not reopen raising for players who already acted
  const S = E.mkState({ sb: 5, bb: 10, buyIn: 1000, minBuy: 200, table: 'I' });
  S.seats[0] = E.mkSeat({ token: 'a', pid: 'a', name: 'A', av: '', stack: 1000 });
  S.seats[1] = E.mkSeat({ token: 'b', pid: 'b', name: 'B', av: '', stack: 1000 });
  S.seats[2] = E.mkSeat({ token: 'c', pid: 'c', name: 'C', av: '', stack: 1000 });
  E.startHand(S);
  // move to flop with everyone in
  while(S.street === 'preflop') E.applyAction(S, S.toAct, S.curBet > S.seats[S.toAct].bet ? 'call' : 'check');
  const order = [S.toAct]; E.applyAction(S, S.toAct, 'raise', 100);           // bet 100
  const second = S.toAct; S.seats[second].stack = 120;                        // short stack shoves 120 (incomplete raise of 20)
  E.applyAction(S, second, 'allin');
  const third = S.toAct; E.applyAction(S, third, 'call');
  ok(S.toAct === order[0], 'original bettor must act again');
  ok(!E.legalActions(S, order[0]).canRaise, 'original bettor cannot re-raise after incomplete raise');
  const flopTotal = S.seats[order[0]].total;
  ok(E.applyAction(S, order[0], 'raise', 500) && S.seats[order[0]].total - flopTotal === 20 && S.street === 'turn', 'raise attempt becomes a call');
}
{ // a folded player who leaves mid-hand keeps their chips in the pot
  const S = E.mkState({ sb: 5, bb: 10, buyIn: 1000, minBuy: 200, table: 'L' });
  for(const i of [0, 1, 2]) S.seats[i] = E.mkSeat({ token: 't'+i, pid: 'p'+i, name: 'P'+i, av: '', stack: 1000 });
  const before = stacks(S);
  E.startHand(S);
  const i = S.toAct; E.applyAction(S, i, 'raise', 50);
  const j = S.toAct; E.applyAction(S, j, 'fold');
  const cashed = E.removeSeat(S, j);
  ok(chips(S) + cashed === before, 'chips conserved when folded player leaves');
  while(S.street !== 'showdown'){ if(S.runout){ E.endRound(S); continue; } E.applyAction(S, S.toAct, S.curBet > S.seats[S.toAct].bet ? 'call' : 'check'); }
  ok(Object.values(S.results.won).reduce((a, b) => a + b, 0) === E.potTotal(S) && S.dead > 0, 'dead money awarded');
  const after = S.seats.reduce((a, s) => a + (s ? s.stack : 0), 0);
  ok(after + cashed === before, `table chips after showdown ${after}+${cashed} == ${before}`);
}

{ // tournaments run to a single winner with unique places and constant chips
  for(let t = 0; t < 300; t++){
    const n = 2 + Math.floor(R()*5);
    const S = E.mkState({ sb: 10, bb: 20, buyIn: 1500, minBuy: 0, table: 'T', mode: 'tourney',
      tour: { started: true, finished: false, baseSb: 10, level: 0, levelMs: 1000, levelEnds: 1000, places: [] } });
    for(let i = 0; i < n; i++) S.seats[i] = E.mkSeat({ token: 't'+i, pid: 'p'+i, name: 'P'+i, av: '', stack: 1500, bot: true });
    const total = 1500*n; let clock = 0, hands = 0;
    while(!S.tour.finished && hands < 5000){
      clock += 400; E.tourLevelUp(S, clock);
      if(!E.startHand(S)) break; hands++;
      while(S.street !== 'showdown'){ if(S.runout){ E.endRound(S); continue; } const [a, amt] = E.botMove(S, S.toAct); ok(E.applyAction(S, S.toAct, a, amt), 'bot action legal'); }
      ok(stacks(S) === total, 'tournament chips conserved');
      E.tourSettle(S);
    }
    ok(S.tour.finished, `tournament finished (${hands} hands)`);
    eq(S.tour.places.map(p => p.place), [...Array(n).keys()].map(k => k+1), 'places are 1..n');
    if(hands > 5) ok(S.bb > 20, 'blinds went up');
  }
}

if(fails){ console.error(`\n${fails} failures`); process.exit(1); }
console.log('all engine tests passed');
