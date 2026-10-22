/* =====================================================================
   OnTilt: peer-to-peer Texas Hold'em for friends.
   The host's browser runs the game (deals, enforces rules) and sends each
   player only what they're allowed to see. Networking is WebRTC via
   Trystero (signaling over public Nostr relays), so the site itself is
   fully static and works on GitHub Pages.
   ===================================================================== */

import { APP_ID, TRYSTERO_URL, TURN_MS } from './config.js';
import { MAXS, rnd, bestOf, handName, mkState, mkSeat, potTotal, startHand, endRound, showdown, applyAction, botMove, fmt } from './engine.js';
import { app, short, esc, fmtCode, STAKES, AVATARS, EMOTES, BOTS, ICON, cardHTML, toast, LS } from './ui-helpers.js';

// ------------------------------ profile ------------------------------
const me = LS.get('pp-me', null) || { token: crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2), name:'', av:AVATARS[0] };
const saveMe = () => LS.set('pp-me', me);
saveMe();

// ------------------------------ runtime ------------------------------
let isHost=false, S=null, view=null, net=null, hostPid=null, hostLost=false, tableCode=null;
const peers=new Map();           // host: pid -> {token,name,av}
let timer=null, armedSeq=-1;
const ui={ raiseOpen:false, raiseTo:0, emoteOpen:false, lastTurnKey:'', lastHand:0, lastBoardLen:0, lastResultsKey:'' };
const myPid = () => net ? net.selfId : 'local';

// ------------------------------ network ------------------------------
async function connect(code){
  try{
    const { joinRoom, selfId } = await import(TRYSTERO_URL);
    const room = joinRoom({ appId:APP_ID, password:'pn-'+code }, 'table-'+code);
    const act = room.makeAction('m');
    net = { room, act, selfId };
    act.onMessage = (d,ctx) => onNet(d, ctx.peerId);
    room.onPeerJoin = pid => { if(isHost) return; act.send({t:'hello',...helloData()},{target:pid}).catch(()=>{}); };
    room.onPeerLeave = pid => {
      if(isHost){ peers.delete(pid); for(const s of S.seats) if(s&&s.pid===pid){ s.connected=false; } S.seq++; hostSync(); }
      else if(pid===hostPid){ hostLost=true; render(); }
    };
    if(isHost){ for(const s of S.seats) if(s&&s.token===me.token) s.pid=selfId; hostSync(); }
    else act.send({t:'hello',...helloData()}).catch(()=>{});
  }catch(e){
    console.error(e);
    net=null;
    if(isHost) toast('Offline mode: friends can’t join, but bots can play', 4000);
    else { hostLost=true; render(); toast('Could not load the peer-to-peer library', 4000); }
  }
}
const helloData = () => ({ token:me.token, name:me.name||'player', av:me.av });
function send(d){
  if(isHost) return handle(d, myPid());
  if(!net) return;
  net.act.send(d, hostPid ? {target:hostPid} : undefined).catch(()=>{});
}
function onNet(d, pid){
  if(isHost) return handle(d, pid);
  if(d.t==='state'){
    if(hostPid && hostPid!==pid && !hostLost) return;  // ignore impostors once connected
    hostPid=pid; hostLost=false; setView(d.v);
  } else if(d.t==='emote' && pid===hostPid) floatEmote(d.seat, d.e);
  else if(d.t==='ended' && pid===hostPid){ view=null; hostLost=true; render(); toast('The host closed the table',4000); }
}

// ------------------------------ host ------------------------------
function handle(d, pid){
  if(!S || !d || typeof d!=='object') return;
  const seatOf = () => S.seats.findIndex(s=>s&&s.pid===pid);
  const i = seatOf();
  switch(d.t){
    case 'hello': {
      const name=String(d.name||'player').slice(0,14), av=String(d.av||'🙂').slice(0,8), token=String(d.token||'').slice(0,64);
      peers.set(pid,{token,name,av});
      for(const s of S.seats) if(s&&!s.bot&&s.token===token){ s.pid=pid; s.connected=true; s.name=name; s.av=av; }
      if(token && S.ledger[token]) S.ledger[token].name=name;
      S.seq++; break;
    }
    case 'sit': {
      const k=d.seat|0; if(i>=0 || k<0 || k>=MAXS || S.seats[k]) return;
      const p = pid===myPid() ? {token:me.token,name:me.name||'host',av:me.av} : peers.get(pid);
      if(!p) return;
      if(S.seats.some(s=>s&&!s.bot&&s.token===p.token)) return;
      S.seats[k]=mkSeat({...p, pid, stack:S.buyIn});
      const L=S.ledger[p.token] ||= {name:p.name,buy:0,out:0}; L.buy+=S.buyIn;
      S.seq++; break;
    }
    case 'act': if(i<0 || !applyAction(S,i,String(d.a),d.amt)) return; S.seq++; break;
    case 'emote': if(i<0 || !EMOTES.includes(d.e)) return; broadcastEmote(i,d.e); return;
    case 'rebuy': { const s=S.seats[i]; if(i<0||s.stack>0||s.inHand&&S.street!=='idle'&&S.street!=='showdown') return;
      s.stack=S.buyIn; S.ledger[s.token].buy+=S.buyIn; S.seq++; break; }
    case 'stand': { if(i<0) return; const s=S.seats[i];
      if(s.inHand && !s.folded && S.street!=='idle' && S.street!=='showdown'){ s.leaving=true; if(S.toAct===i) applyAction(S,i,S.curBet>s.bet?'fold':'check'); }
      else { S.ledger[s.token].out+=s.stack; S.seats[i]=null; }
      S.seq++; break; }
    case 'addbot': { if(pid!==myPid()) return; const k=d.seat|0; if(S.seats[k]) return;
      const used=new Set(S.seats.filter(Boolean).map(s=>s.name)); const b=BOTS.find(b=>!used.has(b[0]))||['bot'+k,'🤖'];
      S.seats[k]=mkSeat({token:'bot-'+k+'-'+Date.now(),pid:null,name:b[0],av:b[1],stack:S.buyIn,bot:true}); S.seq++; break; }
    case 'kick': { if(pid!==myPid()) return; const k=d.seat|0, s=S.seats[k]; if(!s||s.token===me.token) return;
      if(s.inHand && !s.folded && S.street!=='idle' && S.street!=='showdown'){ s.leaving=true; if(S.toAct===k) applyAction(S,k,S.curBet>s.bet?'fold':'check'); }
      else { if(!s.bot) S.ledger[s.token].out+=s.stack; S.seats[k]=null; }
      S.seq++; break; }
    default: return;
  }
  hostSync();
}

function nextHand(){
  for(let i=0;i<MAXS;i++){ const s=S.seats[i]; if(!s) continue;
    if(s.leaving){ if(!s.bot) S.ledger[s.token].out+=s.stack; S.seats[i]=null; continue; }
    if(s.bot && s.stack===0) s.stack=S.buyIn; }
  S.street='idle'; S.results=null;
  startHand(S);
}

function schedule(){
  if(S.seq===armedSeq) return; armedSeq=S.seq; clearTimeout(timer); S.turnEnd=0;
  const bump = fn => () => { fn(); S.seq++; hostSync(); };
  if(S.street==='idle'){ timer=setTimeout(bump(()=>startHand(S)), 1600); return; }
  if(S.street==='showdown'){ const shown=Object.keys(S.results?.reveal||{}).length; timer=setTimeout(bump(nextHand), shown?6000:3200); return; }
  if(S.runout){ timer=setTimeout(bump(()=>endRound(S)), 1500); return; }
  if(S.toAct>=0){
    const i=S.toAct, s=S.seats[i];
    if(s.bot){ timer=setTimeout(bump(()=>{ const [a,amt]=botMove(S,i); applyAction(S,i,a,amt); }), 800+Math.random()*1400); return; }
    const ms = s.connected && !s.leaving ? TURN_MS : 3500;
    S.turnEnd=Date.now()+ms; S.turnTotal=ms;
    timer=setTimeout(bump(()=>{ const t=S.seats[i]; if(t && S.toAct===i) applyAction(S,i,S.curBet>t.bet?'fold':'check'); }), ms);
  }
}

function viewFor(pid){
  const mySeat=S.seats.findIndex(s=>s&&s.pid===pid);
  const R=S.results;
  const seats=S.seats.map((s,i)=>s&&{
    name:s.name, av:s.av, stack:s.stack, bet:s.bet, folded:s.folded, allIn:s.allIn, inHand:s.inHand, bot:s.bot,
    connected:s.connected||s.bot, leaving:s.leaving, last:s.last,
    cards: i===mySeat ? s.cards : (R&&R.reveal[i]) ? R.reveal[i] : (s.inHand&&!s.folded&&s.cards.length ? ['back','back'] : null),
  });
  const ledger=Object.entries(S.ledger).map(([tok,L])=>{ const s=S.seats.find(x=>x&&x.token===tok);
    return {name:L.name, buy:L.buy, net:L.out+(s?s.stack:0)-L.buy, seated:!!s}; });
  return { table:S.table, sb:S.sb, bb:S.bb, buyIn:S.buyIn, minBuy:S.minBuy, seats, dealer:S.dealer, board:S.board,
    pot:potTotal(S)-S.seats.reduce((a,s)=>a+(s?s.bet:0),0), street:S.street, toAct:S.toAct, curBet:S.curBet, minRaise:S.minRaise,
    turnLeft:S.turnEnd?Math.max(0,S.turnEnd-Date.now()):0, turnTotal:S.turnTotal, mySeat, results:R, handNo:S.handNo, ledger,
    isHost: pid===myPid() };
}
function hostSync(){
  schedule();
  LS.set('pp-host-'+S.table, S);
  if(net) for(const pid of peers.keys()) net.act.send({t:'state',v:viewFor(pid)},{target:pid}).catch(()=>{});
  setView(viewFor(myPid()));
}
function broadcastEmote(seat,e){
  if(net) net.act.send({t:'emote',seat,e}).catch(()=>{});
  floatEmote(seat,e);
}

// ------------------------------ client view ------------------------------
function setView(v){
  const prev=view; v.recvAt=performance.now(); view=v;
  const turnKey = v.handNo+':'+v.street+':'+v.toAct+':'+v.curBet;
  const myTurn = v.mySeat>=0 && v.toAct===v.mySeat;
  if(turnKey!==ui.lastTurnKey){ ui.lastTurnKey=turnKey; ui.raiseOpen=false; if(myTurn) navigator.vibrate?.(25); }
  const rk = v.results ? v.handNo+':'+v.results.summary : '';
  if(rk && rk!==ui.lastResultsKey){ ui.lastResultsKey=rk; toast(v.results.summary, 4200); }
  render(prev);
}

// ------------------------------ rendering ------------------------------
let screen='lobby', lobby={ stake:2, mode:'create', code:null };

// Wide screens get an oval table with a bottom action dock; phones keep the stacked layout.
// Keep this query in sync with the one in css/desktop.css.
const deskMQ = matchMedia('(min-width:960px) and (min-height:560px)');
deskMQ.addEventListener('change', ()=>render());

function render(prev){
  app.classList.toggle('wide', screen!=='lobby' && deskMQ.matches);
  if(screen==='lobby') return renderLobby();
  return renderTable(prev);
}

function renderLobby(){
  const [sb,bb]=STAKES[lobby.stake];
  const avs=AVATARS.map(a=>`<button data-act="av" data-v="${a}" class="${a===me.av?'sel':''}">${a}</button>`).join('');
  const prof=`<div class="prof"><input id="nm" placeholder="Your name" maxlength="14" autocomplete="off" value="${esc(me.name)}"><div class="avs">${avs}</div></div>`;
  if(lobby.mode==='create'){
    app.innerHTML=`<div class="lobby">
      <div class="panel">
        <div class="top"><span></span><div class="code">${fmtCode(lobby.code)}</div><span></span></div>
        <div class="lbl g">Stakes</div><div class="big g">${sb} / ${bb}</div>
        <div class="lbl">Buy-in</div><div class="big">${short(bb*20)} / ${short(bb*100)}</div>
        <div class="ruler" id="ruler">${STAKES.map((_,i)=>`<i class="${i===lobby.stake?'sel':''}"></i>`).join('')}</div>
      </div>
      ${prof}
      <div class="grow"></div>
      <button class="lbtn out" data-act="invite">${ICON.link}COPY INVITE LINK</button>
      <button class="lbtn wh" data-act="start">START GAME</button>
    </div>`;
    const ruler=document.getElementById('ruler');
    const pick=e=>{ const r=ruler.getBoundingClientRect(); const x=(e.clientX-r.left)/r.width;
      const k=Math.max(0,Math.min(STAKES.length-1,Math.round(x*(STAKES.length-1)))); if(k!==lobby.stake){ lobby.stake=k; readName(); renderLobby(); navigator.vibrate?.(8); } };
    ruler.onpointerdown=e=>{ ruler.setPointerCapture(e.pointerId); pick(e); ruler.onpointermove=pick; };
    ruler.onpointerup=()=>{ ruler.onpointermove=null; };
  } else {
    app.innerHTML=`<div class="lobby">
      <div class="top"><button class="ico" data-act="home">${ICON.back}</button><div class="code">${fmtCode(lobby.code)}</div><span></span></div>
      <div class="join-h"><div class="big">You're invited</div><p>Pick a name and an avatar, then join the table.</p></div>
      ${prof}
      <div class="grow"></div>
      <button class="lbtn wh" data-act="join">JOIN TABLE</button>
    </div>`;
  }
}
function readName(){ const el=document.getElementById('nm'); if(el){ me.name=el.value.trim().slice(0,14); saveMe(); } }

function renderTable(prev){
  const v=view;
  const head=`<div class="top"><button class="ico" data-act="leave" aria-label="Leave">${ICON.back}</button>
    <div class="code">${v?`${fmtCode(tableCode)}`:''}</div><button class="ico" data-act="menu" aria-label="Menu">${ICON.menu}</button></div>`;
  if(!v){
    app.innerHTML=head+`<div class="center-msg"><div>${hostLost
      ? `Can't reach the host right now.<br>Ask them to keep the table open, then refresh.`
      : `<div class="spin"></div>Looking for the table host…<br><span style="font-size:13px">Table ${fmtCode(tableCode)}</span>`}</div></div>`;
    return;
  }
  const seated=v.mySeat>=0, anchor=seated?v.mySeat:0, mine=seated?v.seats[v.mySeat]:null;
  const active=v.street!=='idle'&&v.street!=='showdown';
  const R=v.results;

  // --- top seats
  let top='';
  for(let k=1;k<MAXS;k++){ const i=(anchor+k)%MAXS; top+=seatHTML(v,i,seated); }

  // --- board
  const newCards = prev && prev.handNo===v.handNo ? prev.board.length : 0;
  const board=[0,1,2,3,4].map(k=>v.board[k] ? cardHTML(v.board[k], k>=newCards?'deal':'') : cardHTML('back')).join('');

  // --- controls
  const myTurn = seated && v.toAct===v.mySeat && active;
  let ctrl='', raisePanel='', betChip='';
  if(mine && mine.bet>0) betChip=`<span class="chip">${fmt(mine.bet)}</span>`;
  if(R && seated && R.won[v.mySeat]) betChip=`<span class="chip win">+${fmt(R.won[v.mySeat])}</span>`;
  if(!seated){
    const full=v.seats.every(Boolean);
    ctrl=`<div class="ctrl"><button class="btn wide" disabled>${full?'Table is full · watching':'Tap + to take a seat'}</button></div>`;
  } else if(mine.stack===0 && !(mine.inHand&&active)){
    ctrl=`<div class="ctrl" style="grid-template-columns:1fr 1fr"><button class="btn on" data-act="rebuy">Rebuy ${short(v.buyIn)}</button><button class="btn on" data-act="stand">Stand up</button></div>`;
  } else if(!mine.inHand || !active){
    const others=v.seats.filter(s=>s&&s!==mine).length;
    ctrl=`<div class="ctrl"><button class="btn wide" disabled>${active?'Wait for the next hand': v.street==='showdown'?'Next hand…': others? 'Starting…':'Waiting for players'}</button></div>`;
  } else {
    const toCall=v.curBet-mine.bet, maxTo=mine.bet+mine.stack;
    const minTo=Math.min(v.curBet+v.minRaise,maxTo), canRaise=maxTo>v.curBet && !mine.allIn;
    const on=myTurn?'on':'', dis=myTurn?'':'disabled';
    const callLbl = toCall<=0 ? 'Check' : toCall>=mine.stack ? `All in ${fmt(mine.stack)}` : `Call ${fmt(toCall)}`;
    const rLbl = minTo>=maxTo ? `All in ${fmt(maxTo)}` : `${v.curBet===0?'Bet':'Raise'} ${fmt(minTo)}`;
    const cols=[]; let html='';
    if(toCall>0){ cols.push('.9fr'); html+=`<button class="btn ${on}" ${dis} data-act="fold">Fold</button>`; }
    cols.push('1.3fr'); html+=`<button class="btn ${on}" ${dis} data-act="${toCall<=0?'check':'call'}">${callLbl}</button>`;
    if(canRaise && toCall<mine.stack){
      cols.push('1.3fr'); html+=`<button class="btn ${on}" ${dis} data-act="raiseMin" data-v="${minTo}">${rLbl}</button>`;
      if(minTo<maxTo){ cols.push('.55fr'); html+=`<button class="btn ${on}" ${dis} data-act="raiseOpen" aria-label="Custom raise">${ICON.up}</button>`; }
    }
    if(mine.allIn || mine.folded){ ctrl=`<div class="ctrl"><button class="btn wide" disabled>${mine.folded?'Folded':'All in'}</button></div>`; }
    else ctrl=`<div class="ctrl" style="grid-template-columns:${cols.join(' ')}">${html}</div>`;

    if(myTurn && ui.raiseOpen && canRaise && minTo<maxTo){
      if(ui.raiseTo<minTo||ui.raiseTo>maxTo) ui.raiseTo=minTo;
      const potNow=v.pot+v.seats.reduce((a,s)=>a+(s?s.bet:0),0);
      const half=Math.min(maxTo,Math.max(minTo,Math.round(v.curBet+(potNow+toCall)/2)));
      const full=Math.min(maxTo,Math.max(minTo,v.curBet+potNow+toCall));
      raisePanel=`<div class="raise"><span class="amt">↑ <b id="ramt" style="font-weight:400">${fmt(ui.raiseTo)}</b></span>
        <input type="range" id="rng" min="${minTo}" max="${maxTo}" step="${v.sb}" value="${ui.raiseTo}">
        <button class="go" data-act="raiseGo" aria-label="Raise">${ICON.up}</button></div>`;
      ctrl=`<div class="ctrl" style="grid-template-columns:1fr 1fr 1fr .55fr">
        <button class="btn on" data-act="preset" data-v="${half}">½ Pot</button>
        <button class="btn on" data-act="preset" data-v="${full}">Pot</button>
        <button class="btn on" data-act="preset" data-v="${maxTo}">All in</button>
        <button class="btn on" data-act="raiseClose" aria-label="Close">${ICON.x}</button></div>`;
    }
  }

  // --- bottom row (me / anchor seat)
  const a=v.seats[anchor];
  let holeCards = mine && mine.cards && mine.cards.length ? mine.cards : null;
  const holeNew = holeCards && (!prev || prev.handNo!==v.handNo);
  const hole = holeCards ? holeCards.map(c=>cardHTML(c, holeNew?'deal':'')).join('')
             : (!seated && a && a.cards) ? a.cards.map(c=>cardHTML(c)).join('') : cardHTML(null)+cardHTML(null);
  let hn='';
  if(seated && holeCards){ hn = R&&R.hands[v.mySeat] ? R.hands[v.mySeat] : handName(bestOf([...holeCards,...v.board])); }
  else if(!seated && a && R && R.hands[anchor]) hn=R.hands[anchor];
  const handTurn = v.toAct===anchor && active;
  let box;
  if(a){
    box=`<div class="hand ${handTurn?'turn':''}" ${handTurn&&v.turnLeft?'data-timer':''} data-seat-av="${anchor}">
      <div class="hn">${esc(hn)}</div>
      <div class="av">${a.av}${v.dealer===anchor&&v.handNo?'<b class="d">D</b>':''}</div>
      <div class="st">${fmt(a.stack)}</div>
      ${seated?`<button class="smile" data-act="emote" aria-label="Reactions">${ICON.smile}</button>`:''}</div>`;
  } else {
    box=`<div class="hand"><div class="hn">Open seat</div><button class="plus" data-act="sit" data-i="${anchor}" ${seated?'disabled':''}></button><div class="hn"></div></div>`;
  }
  const canSwipe = myTurn && mine && v.curBet>mine.bet;
  const meRow=`<div class="me"><div class="hole ${mine&&mine.folded?'folded':''}" id="hole">${hole}</div>${box}
    </div>`;

  const banner = hostLost ? `<div class="banner">Lost connection to host… waiting</div>` : '';
  const emo = ui.emoteOpen ? `<div class="shade" data-act="emoteClose"></div><div class="emobar">${EMOTES.map(e=>`<button data-act="em" data-v="${e}">${e}</button>`).join('')}</div>` : '';

  if(deskMQ.matches){
    let ring=''; for(let k=1;k<MAXS;k++) ring+=seatHTML(v,(anchor+k)%MAXS,seated,'p'+k);
    const keys = myTurn && !ui.raiseOpen ? `<div class="keys"><kbd>F</kbd> fold <kbd>C</kbd> check / call <kbd>R</kbd> raise <kbd>↑</kbd> custom</div>` : '';
    app.innerHTML = head + banner +
      `<div class="felt-wrap"><div class="felt">${ring}
        <div class="center"><div class="board">${board}</div><div class="pot">${v.pot>0||active?fmt(v.pot):''}</div></div>
        <div class="mybet">${betChip}</div></div></div>
       <div class="dock"><div class="hole ${mine&&mine.folded?'folded':''}" id="hole">${hole}</div>${box}
         <div class="act">${raisePanel}${ctrl}${keys}</div></div>${emo}`;
  } else
  app.innerHTML = head + banner +
    `<div class="seats">${top}</div><div class="grow" style="flex-grow:1"></div>
     <div class="board">${board}</div><div class="pot">${v.pot>0||active?fmt(v.pot):''}</div>
     <div class="grow" style="flex-grow:1.3"></div>
     ${raisePanel || `<div class="mybet">${betChip}</div>`}
     ${ctrl}${meRow}${emo}`;

  const rng=document.getElementById('rng');
  if(rng) rng.oninput=()=>{ ui.raiseTo=+rng.value; document.getElementById('ramt').textContent=fmt(ui.raiseTo); };
  if(canSwipe) bindSwipe();
}

function seatHTML(v,i,seated,pos=''){
  const s=v.seats[i], R=v.results, active=v.street!=='idle'&&v.street!=='showdown';
  if(!s) return `<div class="seat ${pos}"><div class="pie-wrap"></div>
    <button class="plus" data-act="sit" data-i="${i}" ${seated&&!v.isHost?'disabled':''} aria-label="Sit here"></button>
    <div class="nm">&nbsp;</div><div class="st">&nbsp;</div><div class="under"></div></div>`;
  const dim = (active&&(!s.inHand||s.folded)) || (!s.connected) || (R&&s.inHand&&s.folded) ;
  let under='';
  if(R && R.reveal[i]) under = R.reveal[i].map(c=>cardHTML(c,'mini')).join('') + (R.won[i]?`<span class="chip win" style="margin-left:2px">+${short(R.won[i])}</span>`:'');
  else if(R && R.won[i]) under=`<span class="chip win">+${fmt(R.won[i])}</span>`;
  else if(s.bet>0) under=`<span class="chip">${fmt(s.bet)}</span>`;
  else if(s.allIn && active) under=`<span class="tag">ALL IN</span>`;
  else if(active && s.last==='Check') under=`<span class="tag" style="color:#6d6d72">CHECK</span>`;
  const turn = v.toAct===i && active;
  return `<div class="seat ${pos} ${dim?'dim':''}">
    <div class="pie-wrap">${turn?'<div class="pie" data-timer></div>':''}</div>
    <button class="av" data-act="seatTap" data-i="${i}" data-seat-av="${i}">${s.av}${v.dealer===i&&v.handNo?'<b class="d">D</b>':''}</button>
    <div class="nm">${esc(s.name)}${s.bot?'':''}</div><div class="st">${fmt(s.stack)}</div>
    <div class="under">${under}</div></div>`;
}

function bindSwipe(){
  const h=document.getElementById('hole'); if(!h) return;
  let y0=null, dy=0;
  h.style.touchAction='none';
  h.onpointerdown=e=>{ y0=e.clientY; dy=0; h.setPointerCapture(e.pointerId); h.classList.add('drag'); };
  h.onpointermove=e=>{ if(y0==null) return; dy=Math.max(0,e.clientY-y0); h.style.transform=`translateY(${dy}px)`; h.style.opacity=String(1-Math.min(dy/160,.7)); };
  h.onpointerup=h.onpointercancel=()=>{ if(y0==null) return; y0=null; h.classList.remove('drag');
    if(dy>70){ send({t:'act',a:'fold'}); } else { h.style.transition='transform .2s,opacity .2s'; h.style.transform=''; h.style.opacity=''; } };
}

// timers (pie + border) animate locally from the host's "time left"
(function tick(){
  if(view && view.turnLeft>0){
    const left=Math.max(0,view.turnLeft-(performance.now()-view.recvAt)), p=(left/view.turnTotal).toFixed(4);
    document.querySelectorAll('[data-timer]').forEach(el=>el.style.setProperty('--p',p));
  }
  requestAnimationFrame(tick);
})();

function floatEmote(seat,e){
  const el=document.querySelector(`[data-seat-av="${seat}"]`); if(!el) return;
  const r=el.getBoundingClientRect(), f=document.createElement('div');
  f.className='float'; f.textContent=e; f.style.left=(r.left+r.width/2)+'px'; f.style.top=(r.top+r.height/2)+'px';
  document.body.appendChild(f); setTimeout(()=>f.remove(),2300);
}

// ------------------------------ sheets ------------------------------
function sheet(title, text, buttons){
  const bg=document.createElement('div'); bg.className='sheet-bg';
  bg.innerHTML=`<div class="sheet"><h3>${esc(title)}</h3>${text?`<p>${text}</p>`:''}${buttons.map((b,k)=>`<button class="sb ${b.cls||''}" data-k="${k}">${esc(b.label)}</button>`).join('')}
    <button class="sb" data-k="x" style="background:transparent;color:var(--mut)">Cancel</button></div>`;
  bg.onclick=e=>{ const k=e.target.dataset?.k; if(e.target===bg||k==='x'){ bg.remove(); return; }
    if(k!=null){ bg.remove(); buttons[+k].fn?.(); } };
  document.body.appendChild(bg);
}
function inviteUrl(){ return location.origin+location.pathname+'#'+(tableCode||lobby.code); }
async function shareInvite(){
  const url=inviteUrl();
  if(navigator.share){ try{ await navigator.share({title:'OnTilt',text:`Join my poker table ${fmtCode(tableCode||lobby.code)}`,url}); return; }catch(e){ if(e.name==='AbortError') return; } }
  try{ await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch{ sheet('Invite link', esc(url), []); }
}
function ledgerSheet(){
  const rows=(view?.ledger||[]).map(L=>`<tr><td>${esc(L.name)}${L.seated?'':' <span style="color:var(--mut)">(left)</span>'}</td><td>${fmt(L.buy)}</td><td class="${L.net>0?'pos':L.net<0?'neg':''}">${L.net>0?'+':''}${fmt(L.net)}</td></tr>`).join('');
  sheet('Ledger', `<table class="ledger"><tr><th>Player</th><th>Bought in</th><th>Net</th></tr>${rows||'<tr><td colspan=3>No buy-ins yet</td></tr>'}</table>`, []);
}

// ------------------------------ input ------------------------------
app.addEventListener('click', e=>{
  const b=e.target.closest('[data-act]'); if(!b || b.disabled) return;
  const act=b.dataset.act, v=view;
  switch(act){
    case 'av': readName(); me.av=b.dataset.v; saveMe(); renderLobby(); break;
    case 'invite': readName(); shareInvite(); break;
    case 'start': readName(); if(!me.name){ toast('Enter your name first'); document.getElementById('nm')?.focus(); return; } startHosting(); break;
    case 'join': readName(); if(!me.name){ toast('Enter your name first'); document.getElementById('nm')?.focus(); return; } startJoining(); break;
    case 'home': goHome(); break;
    case 'sit': { const i=+b.dataset.i;
      if(v.mySeat<0) send({t:'sit',seat:i});
      else if(v.isHost) sheet('Open seat','Add a bot to fill this seat?',[{label:'Add bot',cls:'primary',fn:()=>send({t:'addbot',seat:i})}]);
      break; }
    case 'seatTap': { const i=+b.dataset.i, s=v.seats[i];
      if(v.isHost && s && i!==v.mySeat) sheet(s.name, s.bot?'This seat is a bot.':'Remove this player from the table? Their chips are cashed out in the ledger.',
        [{label:s.bot?'Remove bot':'Remove player',cls:'danger',fn:()=>send({t:'kick',seat:i})}]);
      break; }
    case 'fold': send({t:'act',a:'fold'}); break;
    case 'check': send({t:'act',a:'check'}); break;
    case 'call': send({t:'act',a:'call'}); break;
    case 'raiseMin': send({t:'act',a:'raise',amt:+b.dataset.v}); break;
    case 'raiseOpen': ui.raiseOpen=true; ui.raiseTo=0; render(); break;
    case 'raiseClose': ui.raiseOpen=false; render(); break;
    case 'preset': ui.raiseTo=+b.dataset.v; render(); break;
    case 'raiseGo': ui.raiseOpen=false; send({t:'act',a:'raise',amt:ui.raiseTo}); break;
    case 'emote': ui.emoteOpen=true; render(); break;
    case 'emoteClose': ui.emoteOpen=false; render(); break;
    case 'em': ui.emoteOpen=false; send({t:'emote',e:b.dataset.v}); render(); break;
    case 'rebuy': send({t:'rebuy'}); break;
    case 'stand': send({t:'stand'}); break;
    case 'menu': {
      const btns=[{label:'Invite friends',cls:'primary',fn:shareInvite},{label:'Ledger',fn:ledgerSheet}];
      if(v && v.mySeat>=0) btns.push({label:'Stand up',fn:()=>send({t:'stand'})});
      if(isHost) btns.push({label:'Close table for everyone',cls:'danger',fn:endTable});
      sheet(`Table ${fmtCode(tableCode)}`, v?`Blinds ${v.sb}/${v.bb} · buy-in ${short(v.buyIn)}${isHost?' · you are hosting':''}`:'', btns); break; }
    case 'leave':
      if(isHost) sheet('Leave table?','You’re the host. The game pauses for everyone while you’re away. Open the same link later to resume.',[{label:'Leave',cls:'danger',fn:goHome}]);
      else sheet('Leave table?','Your chips stay at the table until you stand up.',[{label:'Stand up and leave',cls:'danger',fn:()=>{ send({t:'stand'}); setTimeout(goHome,250); }},{label:'Just leave',fn:goHome}]);
      break;
  }
});

// keyboard shortcuts (desktop): F fold, C / space check-call, R min-raise, ↑ custom raise, Enter confirm, Esc close
document.addEventListener('keydown',e=>{
  if(e.metaKey||e.ctrlKey||e.altKey||e.target.closest?.('input:not([type=range])')) return;
  if(e.key==='Escape'){ const bg=document.querySelector('.sheet-bg'); if(bg){ bg.remove(); return; }
    if(ui.emoteOpen){ ui.emoteOpen=false; render(); return; } if(ui.raiseOpen){ ui.raiseOpen=false; render(); } return; }
  if(screen==='lobby' || document.querySelector('.sheet-bg')) return;
  const acts={ f:['fold'], c:['check','call'], ' ':['check','call'], r:['raiseMin'], arrowup:['raiseOpen'], enter:['raiseGo'] }[e.key.toLowerCase()];
  if(!acts) return;
  const b=acts.map(a=>app.querySelector(`button[data-act="${a}"]:not(:disabled)`)).find(Boolean);
  if(b){ e.preventDefault(); b.click(); }
});

// ------------------------------ flows ------------------------------
function startHosting(){
  const [sb,bb]=STAKES[lobby.stake];
  tableCode=lobby.code; isHost=true;
  S=mkState({sb,bb,buyIn:bb*100,minBuy:bb*20,table:tableCode});
  S.seats[0]=mkSeat({token:me.token,pid:'local',name:me.name,av:me.av,stack:S.buyIn});
  S.ledger[me.token]={name:me.name,buy:S.buyIn,out:0};
  history.replaceState(null,'','#'+tableCode);
  screen='table'; hostSync(); connect(tableCode);
  setTimeout(()=>toast('Tap ••• to invite friends, or + to add bots',4200),600);
}
function resumeHost(code){
  tableCode=code; isHost=true; S=LS.get('pp-host-'+code,null);
  for(const s of S.seats) if(s&&!s.bot){ s.connected = s.token===me.token; if(s.token===me.token) s.pid='local'; }
  S.seq++; screen='table'; hostSync(); connect(code);
  toast('Table resumed');
}
function startJoining(){
  tableCode=lobby.code; isHost=false; screen='table'; render(); connect(tableCode);
  setTimeout(()=>{ if(!view && screen==='table'){ hostLost=true; render(); } }, 20000);
}
function endTable(){
  sheet('Close the table?','Everyone will be disconnected and the table can’t be resumed.',[{label:'Close table',cls:'danger',fn:()=>{
    if(net) net.act.send({t:'ended'}).catch(()=>{});
    LS.del('pp-host-'+tableCode); setTimeout(goHome,300); }}]);
}
function goHome(){ try{ net?.room.leave(); }catch{} history.replaceState(null,'',location.pathname); location.reload(); }
const newCode = () => String(1000000+rnd(9000000));

// ------------------------------ boot ------------------------------
(function boot(){
  const code=(location.hash.slice(1).match(/\d{7}/)||[])[0];
  if(code && LS.get('pp-host-'+code,null)) return resumeHost(code);
  if(code){ lobby={stake:2,mode:'join',code}; }
  else lobby={stake:2,mode:'create',code:newCode()};
  screen='lobby'; render();
})();
window.addEventListener('hashchange',()=>location.reload());
