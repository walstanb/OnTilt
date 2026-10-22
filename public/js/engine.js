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
export function bestOf(cards){
  if(cards.length<5){ const g=groupsOf(cards.map(rv));
    const c=g[0][0]===4?7:g[0][0]===3?3:g[0][0]===2?(g[1]&&g[1][0]===2?2:1):0; return [c,...g.map(x=>x[1])]; }
  let best=null; const n=cards.length;
  for(let m=0;m<(1<<n);m++){ let pc=0; for(let k=0;k<n;k++) if(m>>k&1) pc++; if(pc!==5) continue;
    const sc=eval5(cards.filter((_,k)=>m>>k&1)); if(!best||cmp(sc,best)>0) best=sc; }
  return best;
}
export const handName = sc => sc[0]===8&&sc[1]===14 ? 'Royal Flush' : HAND_NAMES[sc[0]];

export function mkState(cfg){ return { sb:cfg.sb, bb:cfg.bb, buyIn:cfg.buyIn, minBuy:cfg.minBuy, table:cfg.table,
  seats:Array(MAXS).fill(null), dealer:-1, board:[], deck:[], street:'idle', toAct:-1, curBet:0, minRaise:cfg.bb,
  handNo:0, results:null, runout:false, ledger:{}, seq:0, turnEnd:0, turnTotal:TURN_MS }; }
export function mkSeat(o){ return { token:o.token, pid:o.pid, name:o.name, av:o.av, stack:o.stack, bot:!!o.bot, connected:true,
  bet:0, total:0, folded:false, allIn:false, cards:[], inHand:false, acted:false, leaving:false, last:'' }; }

export const inH = s => s.inHand;
export const live = s => s.inHand && !s.folded;
export const canAct = s => s.inHand && !s.folded && !s.allIn;
export function nextIdx(S, from, pred){ for(let k=1;k<=MAXS;k++){ const i=((from+k)%MAXS+MAXS)%MAXS, s=S.seats[i]; if(s&&pred(s,i)) return i; } return -1; }
export const potTotal = S => S.seats.reduce((a,s)=>a+(s?s.total:0),0);
export function put(s,x){ s.stack-=x; s.bet+=x; s.total+=x; if(s.stack===0) s.allIn=true; }

export function startHand(S){
  S.results=null; S.board=[]; S.runout=false;
  for(const s of S.seats) if(s){ Object.assign(s,{bet:0,total:0,folded:false,allIn:false,cards:[],acted:false,last:''});
    s.inHand = s.stack>0 && (s.connected||s.bot) && !s.leaving; }
  const n=S.seats.filter(s=>s&&s.inHand).length;
  if(n<2){ S.street='idle'; S.toAct=-1; return false; }
  S.handNo++; S.deck=newDeck();
  S.dealer = nextIdx(S, S.dealer<0?MAXS-1:S.dealer, inH);
  const sbI = n===2 ? S.dealer : nextIdx(S,S.dealer,inH), bbI = nextIdx(S,sbI,inH);
  put(S.seats[sbI], Math.min(S.sb,S.seats[sbI].stack));
  put(S.seats[bbI], Math.min(S.bb,S.seats[bbI].stack));
  for(let r=0;r<2;r++){ let i=S.dealer; for(let k=0;k<n;k++){ i=nextIdx(S,i,inH); S.seats[i].cards.push(S.deck.pop()); } }
  S.curBet=S.bb; S.minRaise=S.bb; S.street='preflop'; S.toAct=bbI;
  proceed(S);
  return true;
}

export function proceed(S){
  const L=S.seats.filter(s=>s&&live(s));
  if(L.length===1) return finishFold(S);
  const A=S.seats.filter(s=>s&&canAct(s));
  const needs = s => canAct(s) && (!s.acted || s.bet<S.curBet);
  if(A.length===0 || (A.length===1 && A[0].bet>=S.curBet) || !A.some(needs)) return endRound(S);
  S.toAct = nextIdx(S, S.toAct, needs);
}

export function endRound(S){
  for(const s of S.seats) if(s){ s.bet=0; s.acted=false; if(s.inHand&&!s.folded&&!s.allIn) s.last=''; }
  S.curBet=0; S.minRaise=S.bb; S.toAct=-1;
  const order={preflop:'flop',flop:'turn',turn:'river',river:'showdown'};
  S.street = order[S.street] || 'showdown';
  if(S.street==='showdown') return showdown(S);
  S.deck.pop(); // burn
  const n = S.street==='flop'?3:1; for(let k=0;k<n;k++) S.board.push(S.deck.pop());
  const A=S.seats.filter(s=>s&&canAct(s));
  if(A.length>=2){ S.runout=false; S.toAct=S.dealer; proceed(S); }
  else { S.runout=true; S.toAct=-1; }
}

export function finishFold(S){
  const w=S.seats.findIndex(s=>s&&live(s)), amt=potTotal(S);
  S.seats[w].stack+=amt;
  for(const s of S.seats) if(s){ s.bet=0; }
  S.street='showdown'; S.toAct=-1; S.runout=false;
  S.results={ won:{[w]:amt}, reveal:{}, hands:{}, summary:`${S.seats[w].name} wins ${fmt(amt)}` };
}

export function showdown(S){
  S.street='showdown'; S.toAct=-1; S.runout=false;
  const C=S.seats.map((s,i)=>s&&s.total>0?{i,t:s.total,live:live(s)}:null).filter(Boolean);
  const scores={}; S.seats.forEach((s,i)=>{ if(s&&live(s)) scores[i]=bestOf([...s.cards,...S.board]); });
  const levels=[...new Set(C.map(c=>c.t))].sort((a,b)=>a-b);
  const pots=[]; let prev=0;
  for(const L of levels){
    const amt=C.reduce((a,c)=>a+Math.min(c.t,L)-Math.min(c.t,prev),0);
    const elig=C.filter(c=>c.live&&c.t>=L).map(c=>c.i);
    if(amt>0){
      const last=pots[pots.length-1];
      if(!elig.length && last) last.amt+=amt;
      else if(last && last.elig.join()===elig.join()) last.amt+=amt;
      else if(elig.length) pots.push({amt,elig});
    }
    prev=L;
  }
  const won={};
  for(const p of pots){
    let best=null, W=[];
    for(const i of p.elig){ const c=best?cmp(scores[i],best):1; if(c>0){best=scores[i];W=[i];} else if(c===0) W.push(i); }
    W.sort((a,b)=>((a-S.dealer-1+MAXS)%MAXS)-((b-S.dealer-1+MAXS)%MAXS));
    const share=Math.floor(p.amt/W.length); let rem=p.amt-share*W.length;
    for(const i of W){ const x=share+(rem>0?1:0); if(rem>0) rem--; S.seats[i].stack+=x; won[i]=(won[i]||0)+x; }
  }
  const reveal={}, hands={};
  for(const i in scores){ reveal[i]=S.seats[i].cards; hands[i]=handName(scores[i]); }
  const ws=Object.keys(won).map(Number);
  const summary = ws.map(i=>`${S.seats[i].name} wins ${fmt(won[i])}`).join(' · ') + (ws.length?` with ${hands[ws[0]]}`:'');
  S.results={won,reveal,hands,summary};
}

export function applyAction(S,i,a,amt){
  const s=S.seats[i]; if(!s||S.toAct!==i||!canAct(s)) return false;
  const toCall=S.curBet-s.bet;
  if(a==='fold'){ s.folded=true; s.last='Fold'; }
  else if(a==='check'){ if(toCall>0) return false; s.last='Check'; }
  else if(a==='call'){ if(toCall<=0){ s.last='Check'; } else { put(s,Math.min(toCall,s.stack)); s.last=s.allIn?'All in':'Call'; } }
  else if(a==='raise'||a==='allin'){
    const maxTo=s.bet+s.stack, minTo=S.curBet+S.minRaise;
    let to = a==='allin' ? maxTo : Math.min(Math.max(Math.floor(+amt||0),minTo),maxTo);
    if(to<=S.curBet){ put(s,Math.min(toCall,s.stack)); s.last=s.allIn?'All in':'Call'; }
    else {
      const inc=to-S.curBet;
      if(inc>=S.minRaise) S.minRaise=inc;
      S.curBet=to; put(s,to-s.bet);
      for(const o of S.seats) if(o&&o!==s&&canAct(o)) o.acted=false;
      s.last = s.allIn ? 'All in' : (toCall===0 && S.curBet===to && inc===to ? 'Bet' : 'Raise');
    }
  } else return false;
  s.acted=true;
  proceed(S);
  return true;
}

export function botMove(S,i){
  const s=S.seats[i], toCall=S.curBet-s.bet, pot=potTotal(S);
  let st;
  if(!S.board.length){ const [a,b]=s.cards.map(rv).sort((x,y)=>y-x);
    st = a===b ? .55+a/30 : (a+b)/34 + (s.cards[0][1]===s.cards[1][1]?.06:0) + (a-b<=2?.04:0); }
  else { const sc=bestOf([...s.cards,...S.board]), bs=bestOf(S.board);
    st=[.18,.5,.72,.8,.86,.88,.93,.97,.99][sc[0]];
    if(sc[0]===1 && sc[1]>=Math.max(...S.board.map(rv))) st+=.12;
    if(sc[0]>0 && sc[0]===bs[0] && cmp(sc,bs)===0) st-=.3; }
  st += (Math.random()-.5)*.22;
  const maxTo=s.bet+s.stack, minTo=Math.min(S.curBet+S.minRaise,maxTo), r=x=>Math.max(S.sb,Math.round(x/S.sb)*S.sb);
  if(toCall<=0){
    if(st>.68 && Math.random()<.65 && maxTo>S.curBet) return ['raise',Math.min(maxTo,Math.max(minTo,S.curBet+r(pot*.6)))];
    return ['check'];
  }
  const odds=toCall/(pot+toCall);
  if(st>.84 && Math.random()<.45 && maxTo>S.curBet) return ['raise',Math.min(maxTo,Math.max(minTo,S.curBet+toCall+r(pot*.75)))];
  if(toCall>=s.stack && st<.75) return ['fold'];
  if(st>odds+.12 || (toCall<=S.bb && st>.3)) return ['call'];
  return ['fold'];
}
export function fmt(n){ return Math.round(n).toLocaleString('en-US'); }
