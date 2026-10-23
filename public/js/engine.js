// Texas Hold'em rules engine: dealing, betting rounds, side pots, showdown, bots.
// Pure game logic, no DOM or networking.
import { TURN_MS } from './config.js';

export const MAXS = 6;
export const RANKS = '23456789TJQKA', SUITS = 'shdc';
export const HAND_NAMES = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush'];

export function rnd(n){ const a=new Uint32Array(1), lim=Math.floor(4294967296/n)*n; do crypto.getRandomValues(a); while(a[0]>=lim); return a[0]%n; }
export function newDeck(){ const d=[]; for(const s of SUITS) for(const r of RANKS) d.push(r+s);
  for(let i=d.length-1;i>0;i--){ const j=rnd(i+1); [d[i],d[j]]=[d[j],d[i]]; } return d; }
export const rv = c => RANKS.indexOf(c[0])+2;
export function groupsOf(rs){ const m=new Map(); rs.forEach(x=>m.set(x,(m.get(x)||0)+1));
  return [...m].map(([r,n])=>[n,r]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]); }
export function eval5(cs){
  const r=cs.map(rv).sort((a,b)=>b-a), flush=cs.every(c=>c[1]===cs[0][1]), g=groupsOf(r);
  let sh=0;
  if(g.length===5){ if(r[0]-r[4]===4) sh=r[0]; else if(r[0]===14&&r[1]===5) sh=5; }
  if(sh&&flush) return [8,sh];
  if(g[0][0]===4) return [7,g[0][1],g[1][1]];
  if(g[0][0]===3&&g[1][0]===2) return [6,g[0][1],g[1][1]];
  if(flush) return [5,...r];
  if(sh) return [4,sh];
  if(g[0][0]===3) return [3,...g.map(x=>x[1])];
  if(g[0][0]===2&&g[1][0]===2) return [2,...g.map(x=>x[1])];
  if(g[0][0]===2) return [1,...g.map(x=>x[1])];
  return [0,...r];
}
export function cmp(a,b){ for(let i=0;i<Math.max(a.length,b.length);i++){ const d=(a[i]||0)-(b[i]||0); if(d) return d; } return 0; }
// Best hand from any number of cards: { score, five } where five are the cards that make it.
export function bestFive(cards){
  if(cards.length<5){ const g=groupsOf(cards.map(rv));
    const c=g[0][0]===4?7:g[0][0]===3?3:g[0][0]===2?(g[1]&&g[1][0]===2?2:1):0; return { score:[c,...g.map(x=>x[1])], five:[...cards] }; }
  let best=null, five=null; const n=cards.length;
  for(let m=0;m<(1<<n);m++){ let pc=0; for(let k=0;k<n;k++) if(m>>k&1) pc++; if(pc!==5) continue;
    const pick=cards.filter((_,k)=>m>>k&1), sc=eval5(pick); if(!best||cmp(sc,best)>0){ best=sc; five=pick; } }
  return { score:best, five };
}
export const bestOf = cards => bestFive(cards).score;
export const handName = sc => sc[0]===8&&sc[1]===14 ? 'Royal Flush' : HAND_NAMES[sc[0]];

// Human description of a score: "Three of a Kind · Kings", "Two Pair · Aces & 8s", "Flush · Ace high".
const ONE=['','','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Jack','Queen','King','Ace'];
const MANY=['','','2s','3s','4s','5s','6s','7s','8s','9s','10s','Jacks','Queens','Kings','Aces'];
export function describe(sc){
  const [c,a,b]=sc;
  switch(c){
    case 8: return a===14 ? 'Royal Flush' : `Straight Flush · ${ONE[a]} high`;
    case 7: return `Four of a Kind · ${MANY[a]}`;
    case 6: return `Full House · ${MANY[a]} full of ${MANY[b]}`;
    case 5: return `Flush · ${ONE[a]} high`;
    case 4: return `Straight · ${ONE[a]} high`;
    case 3: return `Three of a Kind · ${MANY[a]}`;
    case 2: return `Two Pair · ${MANY[a]} & ${MANY[b]}`;
    case 1: return `Pair of ${MANY[a]}`;
    default: return `High Card · ${ONE[a]}`;
  }
}

// ------------------------------ state ------------------------------
// S.dead holds chips from players who left mid-hand; it stays in the pot until showdown.
export function mkState(cfg){ return { sb:cfg.sb, bb:cfg.bb, buyIn:cfg.buyIn, minBuy:cfg.minBuy, table:cfg.table,
  mode:cfg.mode||'cash', tour:cfg.tour||null,
  seats:Array(MAXS).fill(null), dealer:-1, board:[], deck:[], burned:[], street:'idle', toAct:-1, curBet:0, minRaise:cfg.bb,
  handNo:0, results:null, runout:false, dead:0, ledger:{}, log:[], seq:0, turnEnd:0, turnTotal:TURN_MS }; }
export function mkSeat(o){ return { token:o.token, pid:o.pid, name:o.name, av:o.av, stack:o.stack, bot:!!o.bot, connected:true,
  bet:0, total:0, folded:false, allIn:false, cards:[], inHand:false, acted:false, noReraise:false, leaving:false, last:'', startStack:o.stack }; }

const inH = s => s.inHand;
const live = s => s.inHand && !s.folded;
const canAct = s => s.inHand && !s.folded && !s.allIn;
function nextIdx(S, from, pred){ for(let k=1;k<=MAXS;k++){ const i=((from+k)%MAXS+MAXS)%MAXS, s=S.seats[i]; if(s&&pred(s,i)) return i; } return -1; }
export const potTotal = S => S.seats.reduce((a,s)=>a+(s?s.total:0),0) + (S.dead||0);
export const isActive = S => S.street!=='idle' && S.street!=='showdown';
function put(s,x){ x=Math.max(0,Math.min(x,s.stack)); s.stack-=x; s.bet+=x; s.total+=x; if(s.stack===0) s.allIn=true; }

// ------------------------------ hand flow ------------------------------
export function startHand(S){
  S.results=null; S.board=[]; S.burned=[]; S.runout=false; S.dead=0;
  for(const s of S.seats) if(s){ Object.assign(s,{bet:0,total:0,folded:false,allIn:false,cards:[],acted:false,noReraise:false,last:'',show:false,acts:0});
    s.inHand = s.stack>0 && (s.connected||s.bot||S.mode==='tourney') && !s.leaving && !s.sittingOut; s.startStack=s.stack; }
  const n=S.seats.filter(s=>s&&s.inHand).length;
  if(n<2){ for(const s of S.seats) if(s) s.inHand=false; S.street='idle'; S.toAct=-1; return false; }
  S.handNo++; S.deck=newDeck();
  S.dealer = nextIdx(S, S.dealer<0?MAXS-1:S.dealer, inH);
  const sbI = n===2 ? S.dealer : nextIdx(S,S.dealer,inH), bbI = nextIdx(S,sbI,inH);
  put(S.seats[sbI], S.sb); S.seats[sbI].last='SB';
  put(S.seats[bbI], S.bb); S.seats[bbI].last='BB';
  for(let r=0;r<2;r++){ let i=S.dealer; for(let k=0;k<n;k++){ i=nextIdx(S,i,inH); S.seats[i].cards.push(S.deck.pop()); } }
  S.curBet=S.bb; S.minRaise=S.bb; S.street='preflop'; S.toAct=bbI;
  proceed(S);
  return true;
}

function proceed(S){
  const L=S.seats.filter(s=>s&&live(s));
  if(L.length===1) return finishFold(S);
  const A=S.seats.filter(s=>s&&canAct(s));
  const needs = s => canAct(s) && (!s.acted || s.bet<S.curBet);
  if(A.length===0 || (A.length===1 && A[0].bet>=S.curBet) || !A.some(needs)) return endRound(S);
  S.toAct = nextIdx(S, S.toAct, needs);
}

export function endRound(S){
  for(const s of S.seats) if(s){ s.bet=0; s.acted=false; s.noReraise=false; if(s.inHand&&!s.folded&&!s.allIn) s.last=''; }
  S.curBet=0; S.minRaise=S.bb; S.toAct=-1;
  const order={preflop:'flop',flop:'turn',turn:'river',river:'showdown'};
  S.street = order[S.street] || 'showdown';
  if(S.street==='showdown') return showdown(S);
  S.burned.push(S.deck.pop());
  const n = S.street==='flop'?3:1; for(let k=0;k<n;k++) S.board.push(S.deck.pop());
  const A=S.seats.filter(s=>s&&canAct(s));
  if(A.length>=2){ S.runout=false; S.toAct=S.dealer; proceed(S); }
  else { S.runout=true; S.toAct=-1; }
}

function finishFold(S){
  const w=S.seats.findIndex(s=>s&&live(s)), amt=potTotal(S);
  S.seats[w].stack+=amt;
  for(const s of S.seats) if(s){ s.bet=0; }
  S.street='showdown'; S.toAct=-1; S.runout=false;
  S.results={ won:{[w]:amt}, back:{}, reveal:{}, hands:{}, desc:{}, best:{}, uncontested:true, pots:[{amt,elig:[w],winners:[w]}], summary:`${S.seats[w].name} wins ${fmt(amt)}` };
  logHand(S);
}

function showdown(S){
  S.street='showdown'; S.toAct=-1; S.runout=false;
  const C=S.seats.map((s,i)=>s&&s.total>0?{i,t:s.total,live:live(s)}:null).filter(Boolean);
  const scores={}, fives={}; S.seats.forEach((s,i)=>{ if(s&&live(s)){ const b=bestFive([...s.cards,...S.board]); scores[i]=b.score; fives[i]=b.five; } });
  const levels=[...new Set(C.map(c=>c.t))].sort((a,b)=>a-b);
  const pots=[]; let prev=0;
  for(const L of levels){
    const amt=C.reduce((a,c)=>a+Math.min(c.t,L)-Math.min(c.t,prev),0);
    const elig=C.filter(c=>c.live&&c.t>=L).map(c=>c.i);
    // chips only one player put in at this level are an uncalled bet: they go back, they aren't won
    const refund = elig.length===1 && C.filter(c=>c.t>prev).length===1;
    if(amt>0){
      const last=pots[pots.length-1];
      if(refund) pots.push({amt,elig,refund:true});
      else if(!elig.length && last) last.amt+=amt;
      else if(last && !last.refund && last.elig.join()===elig.join()) last.amt+=amt;
      else if(elig.length) pots.push({amt,elig});
      else pots.push({amt,elig:Object.keys(scores).map(Number)}); // only folded money at this level: goes to everyone still in
    }
    prev=L;
  }
  // money from players who left mid-hand joins the main pot
  if(S.dead){ if(pots.length) pots[0].amt+=S.dead; else pots.push({amt:S.dead,elig:Object.keys(scores).map(Number)}); }
  const won={}, back={};
  for(const p of pots){
    if(p.refund){ const i=p.elig[0]; S.seats[i].stack+=p.amt; back[i]=(back[i]||0)+p.amt; p.winners=[i]; continue; }
    let best=null, W=[];
    for(const i of p.elig){ const c=best?cmp(scores[i],best):1; if(c>0){best=scores[i];W=[i];} else if(c===0) W.push(i); }
    W.sort((a,b)=>((a-S.dealer-1+MAXS)%MAXS)-((b-S.dealer-1+MAXS)%MAXS));   // odd chips go left of the button first
    const share=Math.floor(p.amt/W.length); let rem=p.amt-share*W.length;
    for(const i of W){ const x=share+(rem>0?1:0); if(rem>0) rem--; S.seats[i].stack+=x; won[i]=(won[i]||0)+x; }
    p.winners=W;
  }
  const reveal={}, hands={}, desc={};
  for(const i in scores){ reveal[i]=S.seats[i].cards; hands[i]=handName(scores[i]); desc[i]=describe(scores[i]); }
  const summary = Object.keys(won).map(i=>`${S.seats[i].name} wins ${fmt(won[i])} with ${desc[i]}`).join(' · ');
  S.results={won,back,reveal,hands,desc,best:fives,pots,summary};
  logHand(S);
}

function logHand(S){
  (S.log ||= []).unshift({ n:S.handNo, board:[...S.board], summary:S.results.summary,
    shown:Object.entries(S.results.reveal).map(([i,c])=>({name:S.seats[i].name, cards:c, hand:S.results.hands[i]})) });
  S.log.length=Math.min(S.log.length,30);
}

// What seat i may do right now (used by the UI and to validate actions).
// Table rule: a raise must at least double the current bet (opening bets are at least one big blind).
// Doubling is never less than the standard "previous raise" minimum, since a raise can't exceed the bet.
export const raiseInc = S => S.curBet===0 ? S.bb : Math.max(S.minRaise, S.curBet);
export function legalActions(S,i){
  const s=S.seats[i];
  if(!s || S.toAct!==i || !canAct(s) || !isActive(S) || S.runout) return null;
  const toCall=Math.max(0,S.curBet-s.bet), maxTo=s.bet+s.stack;
  const canRaise = maxTo>S.curBet && !s.noReraise && toCall<s.stack;
  return { toCall, canCheck:toCall===0, maxTo, minTo:Math.min(S.curBet+raiseInc(S),maxTo), canRaise };
}

export function applyAction(S,i,a,amt){
  const o=legalActions(S,i); if(!o) return false;
  const s=S.seats[i], toCall=o.toCall;
  const call=()=>{ put(s,toCall); s.last=s.allIn?'All in':'Call'; };
  if(a==='fold'){ s.folded=true; s.last='Fold'; }
  else if(a==='check'){ if(toCall>0) return false; s.last='Check'; }
  else if(a==='call'){ if(toCall<=0) s.last='Check'; else call(); }
  else if(a==='raise'||a==='allin'){
    let to = a==='allin' ? o.maxTo : Math.min(Math.max(Math.floor(+amt||0),o.minTo),o.maxTo);
    if(!o.canRaise) to=Math.min(S.curBet,o.maxTo);               // can't raise: shove becomes a call
    if(to<=S.curBet){ if(toCall>0) call(); else s.last='Check'; }
    else {
      const inc=to-S.curBet, full=inc>=raiseInc(S), wasBet=S.curBet===0;
      put(s,to-s.bet); S.curBet=to;
      if(full){ S.minRaise=inc; for(const x of S.seats) if(x) x.noReraise=false; }
      // everyone else must respond; after an incomplete all-in raise, those who already acted may only call or fold
      for(const x of S.seats) if(x&&x!==s&&canAct(x)){ if(!full && x.acted) x.noReraise=true; x.acted=false; }
      s.last = s.allIn ? 'All in' : wasBet ? 'Bet' : 'Raise';
    }
  } else return false;
  s.acted=true; s.acts=(s.acts||0)+1;
  proceed(S);
  return true;
}

// Remove a seat. Mid-hand, a player still in the hand is folded first, and their chips stay in the pot.
export function removeSeat(S,i){
  const s=S.seats[i]; if(!s) return 0;
  if(isActive(S) && s.inHand){
    if(!s.folded){ if(S.toAct===i){ s.folded=true; S.seats[i]=null; S.dead+=s.total; proceed(S); return s.stack; } s.folded=true; }
    S.dead+=s.total;
    S.seats[i]=null;
    if(S.seats.filter(x=>x&&live(x)).length===1 && !S.results) proceed(S);
    return s.stack;
  }
  S.seats[i]=null;
  return s.stack;
}

// ------------------------------ tournament ------------------------------
// Blind levels are multiples of the starting small blind.
const LEVELS=[1,1.5,2,3,4,6,8,12,16,24,32,48,64,100,150,200,300,400];
export function blindsFor(baseSb, level){ const m=LEVELS[Math.min(level,LEVELS.length-1)]; const sb=Math.round(baseSb*m); return [sb,sb*2]; }
export const MAX_LEVEL=LEVELS.length-1;
export function tourLevelUp(S, now){
  const T=S.tour; if(!T||!T.started||T.finished) return false;
  let up=false;
  while(now>=T.levelEnds && T.level<MAX_LEVEL){ T.level++; T.levelEnds+=T.levelMs; up=true; }
  if(up){ [S.sb,S.bb]=blindsFor(T.baseSb,T.level); }
  return up;
}
// The place the next player out finishes in: entrants count down as players are knocked out.
export function nextPlace(S){
  const T=S.tour; T.entrants ??= T.places.length + S.seats.filter(Boolean).length;
  return T.entrants - T.places.length;
}
// After a hand: record busted players (bigger starting stack places higher) and detect the winner.
export function tourSettle(S){
  const T=S.tour; if(!T||!T.started||T.finished) return [];
  const busted=S.seats.map((s,i)=>s&&s.stack===0?{s,i}:null).filter(Boolean).sort((a,b)=>a.s.startStack-b.s.startStack);
  const out=[];
  for(const {s,i} of busted){ T.places.push({name:s.name,av:s.av,token:s.token,place:nextPlace(S)}); S.seats[i]=null; out.push(s.name); }
  T.places.sort((a,b)=>a.place-b.place);
  const alive=S.seats.filter(s=>s&&s.stack>0);
  if(alive.length<=1){
    T.finished=true;
    if(alive[0]) T.places.unshift({name:alive[0].name,av:alive[0].av,token:alive[0].token,place:1});
  }
  return out;
}

// ------------------------------ bots ------------------------------
export function botMove(S,i){
  const s=S.seats[i], o=legalActions(S,i), pot=potTotal(S);
  if(!o) return ['check'];
  let st;
  if(!S.board.length){ const [a,b]=s.cards.map(rv).sort((x,y)=>y-x);
    st = a===b ? .55+a/30 : (a+b)/34 + (s.cards[0][1]===s.cards[1][1]?.06:0) + (a-b<=2?.04:0); }
  else { const sc=bestOf([...s.cards,...S.board]), bs=bestOf(S.board);
    st=[.18,.5,.72,.8,.86,.88,.93,.97,.99][sc[0]];
    if(sc[0]===1 && sc[1]>=Math.max(...S.board.map(rv))) st+=.12;
    if(sc[0]>0 && sc[0]===bs[0] && cmp(sc,bs)===0) st-=.3; }
  st += (Math.random()-.5)*.22;
  const r=x=>Math.max(S.sb,Math.round(x/S.sb)*S.sb), {toCall,maxTo,minTo,canRaise}=o;
  if(toCall<=0){
    if(st>.68 && Math.random()<.65 && canRaise) return ['raise',Math.min(maxTo,Math.max(minTo,S.curBet+r(pot*.6)))];
    return ['check'];
  }
  const odds=toCall/(pot+toCall);
  if(st>.84 && Math.random()<.45 && canRaise) return ['raise',Math.min(maxTo,Math.max(minTo,S.curBet+toCall+r(pot*.75)))];
  if(toCall>=s.stack && st<.75) return ['fold'];
  if(st>odds+.12 || (toCall<=S.bb && st>.3)) return ['call'];
  return ['fold'];
}
export function fmt(n){ return Math.round(n).toLocaleString('en-US'); }

// ------------------------------ odds ------------------------------
// Monte Carlo odds for one player: deal the missing board cards and each opponent's hole cards
// at random from the cards this player can't see, many times. Returns raw counts so callers
// can run it in small chunks and add the results up.
export function equity(hole, board, opponents, iters=1000, rand=Math.random){
  const known=new Set([...hole,...board]), deck=[];
  for(const s of SUITS) for(const r of RANKS){ const c=r+s; if(!known.has(c)) deck.push(c); }
  const need=5-board.length, take=need+opponents*2;
  let win=0, tie=0; const cats=Array(9).fill(0);
  for(let t=0;t<iters;t++){
    for(let k=0;k<take;k++){ const j=k+Math.floor(rand()*(deck.length-k)); const x=deck[k]; deck[k]=deck[j]; deck[j]=x; }
    const full=need ? board.concat(deck.slice(0,need)) : board;
    const mine=bestOf(hole.concat(full)); cats[mine[0]]++;
    let lost=false, tied=false;
    for(let o=0;o<opponents && !lost;o++){
      const c=cmp(mine, bestOf([deck[need+o*2], deck[need+o*2+1], ...full]));
      if(c<0) lost=true; else if(c===0) tied=true;
    }
    if(!lost){ if(tied) tie++; else win++; }
  }
  return { iters, win, tie, cats };
}
