/* =====================================================================
   OnTilt: peer-to-peer Texas Hold'em for friends.
   The host's browser runs the game (deals, enforces rules) and sends each
   player only what they're allowed to see. Networking is WebRTC via
   Trystero (signaling over public Nostr relays), so the site itself is
   fully static and works on GitHub Pages.
   ===================================================================== */

import { TURN_MS, APP_ID, TRYSTERO_URL, RELAY_URLS, TURN_CREDENTIALS_URL, TURN_SERVERS, JOIN_HINT_MS } from './config.js';
import { MAXS, rnd, bestOf, handName, mkState, mkSeat, potTotal, startHand, endRound, applyAction, botMove, fmt,
  isActive, removeSeat, blindsFor, tourLevelUp, tourSettle } from './engine.js';
import { morph } from './morph.js';
import { app, short, esc, fmtCode, STAKES, AVATARS, EMOTES, BOTS, ICON, cardHTML, toast, LS, randomName } from './ui-helpers.js';
import { play, fx as fxPrefs } from './sound.js';
import { qrSVG } from './qr.js';
import { makeOffer, answerOffer, acceptAnswer, opened } from './lan.js';
import { startScanner } from './scan.js';

// ------------------------------ profile ------------------------------
const me = LS.get('pp-me', null) || { token: crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2), name:'', av:AVATARS[0] };
if(!me.name){ me.name=randomName(); me.av=AVATARS[rnd(AVATARS.length)]; }   // new players get a fun suggestion
const saveMe = () => LS.set('pp-me', me);
saveMe();

// ------------------------------ runtime ------------------------------
let isHost=false, S=null, view=null, net=null, hostPid=null, hostLost=false, tableCode=null;
let joinIssue='';                // guest: '' | 'slow' | 'blocked' | 'offline' (why we haven't reached the host yet)
const peers=new Map();           // host: pid -> {token,name,av}
let timer=null, armedSeq=-1;
const ui={ raiseOpen:false, raiseTo:0, emoteOpen:false, lastTurnKey:'', lastResultsKey:'', hide:LS.get('ot-hide',false), noteN:0, finishedShown:false };
const myPid = () => net ? net.selfId : 'local';
const TOUR_STACK_BB = 75;        // tournament starting stack, in starting big blinds

// ------------------------------ network ------------------------------
async function turnServers(){
  const list=[...TURN_SERVERS];
  if(TURN_CREDENTIALS_URL){
    try{ const r=await fetch(TURN_CREDENTIALS_URL,{signal:AbortSignal.timeout(5000)}); if(r.ok) list.push(...await r.json()); }
    catch(e){ console.warn('TURN credentials fetch failed', e); }
  }
  return list;
}
async function connect(code){
  try{
    const [{ joinRoom, selfId }, turnConfig] = await Promise.all([import(TRYSTERO_URL), turnServers()]);
    const room = joinRoom({ appId:APP_ID, password:'pn-'+code, relayConfig:{ urls:RELAY_URLS, warnOnRelayFailure:false },
      ...(turnConfig.length?{turnConfig}:{}) }, 'table-'+code,
      { onJoinError: d => { console.warn('join error', d); if(!isHost && !view){ joinIssue='blocked'; render(); } } });
    const act = room.makeAction('m');
    net = { room, act, selfId };
    act.onMessage = (d,ctx) => onNet(d, ctx.peerId);
    room.onPeerJoin = pid => { if(isHost) return; act.send({t:'hello',...helloData()},{target:pid}).catch(()=>{}); };
    room.onPeerLeave = lost;
    if(isHost){ for(const s of S.seats) if(s&&s.token===me.token) s.pid=selfId; hostSync(); }
    else {
      // Keep saying hello until the host answers: covers lost messages and a host that opens the table after us.
      const hi=()=>{ if(view && !hostLost) return; act.send({t:'hello',...helloData()}).catch(()=>{}); };
      hi(); setInterval(hi, 3000);
    }
  }catch(e){
    console.error(e);
    net=null;
    if(isHost) toast('No internet: invite nearby players with ••• → Show QR code (same Wi-Fi)', 5000);
    else { joinIssue='offline'; render(); toast('Could not load the peer-to-peer library', 4000); }
  }
}
const helloData = () => ({ token:me.token, name:me.name||'player', av:me.av });
function send(d){
  if(isHost) return handle(d, myPid());
  netSend(d, hostPid || undefined);
}

// LAN links (offline play): pid -> data channel. Messages go over a LAN link when there is one, else over Trystero.
const links=new Map();
function wire(pid, ch, pc){
  links.set(pid, ch);
  ch.onmessage = e => { let d; try{ d=JSON.parse(e.data); }catch{ return; } onNet(d, pid); };
  const gone = () => { if(links.get(pid)!==ch) return; links.delete(pid); lost(pid); };
  ch.addEventListener('close', gone);
  pc.addEventListener('connectionstatechange', () => { if(pc.connectionState==='failed' || pc.connectionState==='closed') gone(); });
}
function lost(pid){
  if(isHost){ peers.delete(pid); for(const s of S.seats) if(s&&s.pid===pid){ s.connected=false; } S.seq++; hostSync(); }
  else if(pid===hostPid){ hostLost=true; render(); }
}
function netSend(d, target){
  const out = c => { if(c.readyState==='open') try{ c.send(JSON.stringify(d)); }catch{} };
  if(target && links.has(target)) return out(links.get(target));
  if(!target) for(const c of links.values()) out(c);
  if(net) net.act.send(d, target ? {target} : undefined).catch(()=>{});
}
// Real internet (not just Wi-Fi): can we reach the CDN the online mode depends on?
async function hasInternet(){
  if(!navigator.onLine) return false;
  try{ await fetch('https://esm.sh/trystero@0.26.0', { method:'HEAD', mode:'no-cors', cache:'no-store', signal:AbortSignal.timeout(2500) }); return true; }
  catch{ return false; }
}
function onNet(d, pid){
  if(isHost) return handle(d, pid);
  if(d.t==='state'){
    if(hostPid && hostPid!==pid && !hostLost) return;  // ignore impostors once connected
    hostPid=pid; hostLost=false; joinIssue=''; setView(d.v);
  } else if(d.t==='emote' && pid===hostPid) floatEmote(d.seat, d.e);
  else if(d.t==='ended' && pid===hostPid){ view=null; hostLost=true; render(); toast('The host closed the table',4000); }
}

// ------------------------------ host ------------------------------
const tourOn = () => S.mode==='tourney' && S.tour;
const tourLive = () => tourOn() && S.tour.started && !S.tour.finished;
function note(text, sound){ S.note={ n:(S.note?.n||0)+1, text, sound }; }

// Remove a player for good. Cash: chips go to the ledger. Tournament in progress: they forfeit and take the next place.
function dropSeat(i){
  const s=S.seats[i]; if(!s) return;
  if(tourLive()){
    const left=S.seats.filter(x=>x&&x.stack>0).length;
    S.tour.places.push({name:s.name,av:s.av,token:s.token,place:left}); S.tour.places.sort((a,b)=>a.place-b.place);
    removeSeat(S,i);
    if(S.seats.filter(x=>x&&x.stack>0).length<=1 && !isActive(S)) finishTour();
    return;
  }
  const cash=removeSeat(S,i);
  if(!s.bot && S.ledger[s.token]) S.ledger[s.token].out+=cash;
}
function finishTour(){
  const T=S.tour; if(T.finished) return;
  tourSettle(S);
  if(!T.finished){ const alive=S.seats.filter(s=>s&&s.stack>0); if(alive.length<=1){ T.finished=true;
    if(alive[0]&&!T.places.some(p=>p.place===1)) T.places.unshift({name:alive[0].name,av:alive[0].av,token:alive[0].token,place:1}); } }
  if(T.finished){ const w=T.places.find(p=>p.place===1); note(w?`🏆 ${w.name} wins the tournament!`:'Tournament over','win'); }
}

function handle(d, pid){
  if(!S || !d || typeof d!=='object') return;
  const i = S.seats.findIndex(s=>s&&s.pid===pid);
  const host = pid===myPid();
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
      if(tourOn() && S.tour.started) return;                       // no late entries
      const p = host ? {token:me.token,name:me.name||'host',av:me.av} : peers.get(pid);
      if(!p) return;
      if(S.seats.some(s=>s&&!s.bot&&s.token===p.token)) return;
      const stack = tourOn() ? S.tour.stack : S.buyIn;
      S.seats[k]=mkSeat({...p, pid, stack});
      if(!tourOn()){ const L=S.ledger[p.token] ||= {name:p.name,buy:0,out:0}; L.buy+=stack; }
      note(`${p.name} sat down`,'join');
      S.seq++; break;
    }
    case 'act': if(i<0 || !applyAction(S,i,String(d.a),d.amt)) return; S.seq++; break;
    case 'emote': if(i<0 || !EMOTES.includes(d.e)) return; broadcastEmote(i,d.e); return;
    case 'rebuy': { const s=S.seats[i]; if(i<0||tourOn()||s.stack>0||s.inHand&&isActive(S)) return;
      s.stack=S.buyIn; S.ledger[s.token].buy+=S.buyIn; S.seq++; break; }
    case 'stand': if(i<0) return; dropSeat(i); S.seq++; break;
    case 'addbot': { if(!host) return; const k=d.seat|0; if(k<0||k>=MAXS||S.seats[k]||tourOn()&&S.tour.started) return;
      const used=new Set(S.seats.filter(Boolean).map(s=>s.name)); const b=BOTS.find(b=>!used.has(b[0]))||['bot'+k,'🤖'];
      S.seats[k]=mkSeat({token:'bot-'+k+'-'+Date.now(),pid:null,name:b[0],av:b[1],stack:tourOn()?S.tour.stack:S.buyIn,bot:true}); S.seq++; break; }
    case 'kick': { if(!host) return; const k=d.seat|0, s=S.seats[k]; if(!s||s.token===me.token) return; dropSeat(k); S.seq++; break; }
    case 'tstart': { if(!host||!tourOn()||S.tour.started) return;
      if(S.seats.filter(Boolean).length<2){ toast('Need at least 2 players'); return; }
      const T=S.tour; T.started=true; T.finished=false; T.level=0; T.places=[]; T.levelEnds=Date.now()+T.levelMs;
      [S.sb,S.bb]=blindsFor(T.baseSb,0); S.dealer=-1; S.handNo=0; S.log=[];
      for(const s of S.seats) if(s) s.stack=T.stack;
      note('Shuffle up and deal!','level'); S.seq++; break; }
    case 'treset': { if(!host||!tourOn()||!S.tour.finished) return;
      Object.assign(S.tour,{started:false,finished:false,level:0,places:[]}); [S.sb,S.bb]=blindsFor(S.tour.baseSb,0);
      S.street='idle'; S.results=null; S.board=[];
      for(const s of S.seats) if(s) s.stack=S.tour.stack;
      S.seq++; break; }
    default: return;
  }
  hostSync();
}

function nextHand(){
  for(let i=0;i<MAXS;i++){ const s=S.seats[i]; if(!s) continue;
    if(s.leaving){ dropSeat(i); continue; }
    if(!tourOn() && s.bot && s.stack===0) s.stack=S.buyIn; }
  S.street='idle'; S.results=null;
  if(tourOn()){
    if(!S.tour.started || S.tour.finished) return;
    const out=tourSettle(S);
    if(out.length) note(`${out.join(' & ')} ${out.length>1?'are':'is'} out`,'bust');
    if(S.tour.finished){ const w=S.tour.places.find(p=>p.place===1); note(w?`🏆 ${w.name} wins the tournament!`:'Tournament over','win'); return; }
    if(tourLevelUp(S, Date.now())) note(`Blinds up: ${fmt(S.sb)} / ${fmt(S.bb)}`,'level');
  }
  startHand(S);
}

function schedule(){
  if(S.seq===armedSeq) return; armedSeq=S.seq; clearTimeout(timer); S.turnEnd=0;
  const bump = fn => () => { fn(); S.seq++; hostSync(); };
  if(S.street==='idle'){
    if(tourOn() && (!S.tour.started || S.tour.finished)) return;
    timer=setTimeout(bump(nextHand), 1600); return; }
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
  const R=S.results, T=S.tour;
  const seats=S.seats.map((s,i)=>s&&{
    name:s.name, av:s.av, stack:s.stack, bet:s.bet, folded:s.folded, allIn:s.allIn, inHand:s.inHand, bot:s.bot,
    connected:s.connected||s.bot, leaving:s.leaving, last:s.last, noReraise:s.noReraise,
    cards: i===mySeat ? s.cards : (R&&R.reveal[i]) ? R.reveal[i] : (s.inHand&&!s.folded&&s.cards.length ? ['back','back'] : null),
  });
  const ledger=Object.entries(S.ledger).map(([tok,L])=>{ const s=S.seats.find(x=>x&&x.token===tok);
    return {name:L.name, buy:L.buy, net:L.out+(s?s.stack:0)-L.buy, seated:!!s}; });
  const myToken = pid===myPid() ? me.token : peers.get(pid)?.token;
  return { table:S.table, mode:S.mode, sb:S.sb, bb:S.bb, buyIn:S.buyIn, minBuy:S.minBuy, seats, dealer:S.dealer, board:S.board,
    pot:potTotal(S)-S.seats.reduce((a,s)=>a+(s?s.bet:0),0), street:S.street, toAct:S.toAct, curBet:S.curBet, minRaise:S.minRaise,
    turnLeft:S.turnEnd?Math.max(0,S.turnEnd-Date.now()):0, turnTotal:S.turnTotal, mySeat, results:R, handNo:S.handNo, ledger,
    log:(S.log||[]).slice(0,15), note:S.note||null,
    tour: T && { started:T.started, finished:T.finished, level:T.level, stack:T.stack, levelMs:T.levelMs,
      levelLeft:T.started&&!T.finished?Math.max(0,T.levelEnds-Date.now()):0, next:blindsFor(T.baseSb,T.level+1), places:T.places,
      myPlace:(T.places.find(p=>p.token===myToken)||{}).place||0 },
    isHost: pid===myPid() };
}
function hostSync(){
  schedule();
  S.savedAt=Date.now();
  LS.set('pp-host-'+S.table, S);
  for(const pid of peers.keys()) netSend({t:'state',v:viewFor(pid)}, pid);
  setView(viewFor(myPid()));
}
function broadcastEmote(seat,e){
  netSend({t:'emote',seat,e});
  floatEmote(seat,e);
}

// ------------------------------ client view ------------------------------
function setView(v){
  const prev=view; v.recvAt=performance.now(); view=v;
  const turnKey = v.handNo+':'+v.street+':'+v.toAct+':'+v.curBet;
  const myTurn = v.mySeat>=0 && v.toAct===v.mySeat && isActive(v);
  if(turnKey!==ui.lastTurnKey){ ui.lastTurnKey=turnKey; ui.raiseOpen=false; }
  const rk = v.results ? v.handNo+':'+v.results.summary : '';
  if(rk && rk!==ui.lastResultsKey){ ui.lastResultsKey=rk; toast(v.results.summary, 4200); }
  if(v.note && v.note.n!==ui.noteN){ const fresh=prev&&ui.noteN; ui.noteN=v.note.n; if(fresh){ toast(v.note.text,3600); if(v.note.sound) play(v.note.sound); } }
  if(v.tour?.finished && !ui.finishedShown){ ui.finishedShown=true; setTimeout(standingsSheet, 900); }
  if(v.tour && !v.tour.finished) ui.finishedShown=false;
  cueSounds(prev, v, myTurn);
  document.title = myTurn && document.hidden ? '● Your turn · OnTilt' : 'OnTilt';
  render(prev);
}
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) document.title='OnTilt'; });

// Sounds follow what changed between two views, so host and guests hear the same thing.
function cueSounds(prev, v, myTurn){
  if(!prev) return;
  if(v.handNo!==prev.handNo && v.street==='preflop'){ play('deal'); setTimeout(()=>play('deal'),120); }
  else if(v.board.length>prev.board.length) play('flip');
  if(v.handNo===prev.handNo) v.seats.forEach((s,i)=>{ const p=prev.seats[i];
    if(s && p && s.last!==p.last && s.last){ const m={Fold:'fold',Check:'check',Call:'chip',Bet:'chips',Raise:'chips','All in':'allin'}[s.last]; if(m && i!==v.mySeat) play(m); } });
  const wasTurn = prev.mySeat>=0 && prev.toAct===prev.mySeat && isActive(prev);
  if(myTurn && !wasTurn) play('turn');
  if(v.results && !prev.results){
    const won=v.mySeat>=0 && v.results.won[v.mySeat];
    setTimeout(()=>play(won?'win':(v.mySeat>=0 && v.seats[v.mySeat]?.inHand ? 'lose' : 'chips')), 350);
  }
}

// ------------------------------ rendering ------------------------------
let screen='lobby', lobby={ stake:2, mode:'create', code:null, game:'cash', speed:1 };
const SPEEDS=[['Turbo',5],['Regular',10],['Slow',15]];   // tournament: minutes per blind level

// Wide screens get an oval table with a bottom action dock; phones keep the stacked layout.
// Keep this query in sync with the one in css/desktop.css.
const deskMQ = matchMedia('(min-width:960px) and (min-height:560px)');
deskMQ.addEventListener('change', ()=>render());

let paintedScreen=null;
function render(prev){
  app.classList.toggle('wide', screen!=='lobby' && deskMQ.matches);
  app.classList.toggle('lobby-wide', screen==='lobby' && deskMQ.matches);
  if(screen==='lobby') return renderLobby();
  // UI-only re-renders (no new state) compare against the current view so nothing re-animates
  return renderTable(prev===undefined ? view : prev);
}
// Patch #app in place so unchanged elements survive and CSS transitions can run.
// A screen change swaps the content wholesale with an enter animation instead.
function paint(html){
  if(paintedScreen!==screen){
    paintedScreen=screen; app.innerHTML=html;
    app.classList.remove('enter'); void app.offsetWidth; app.classList.add('enter');
    clearTimeout(paint.t); paint.t=setTimeout(()=>app.classList.remove('enter'), 700);
  } else morph(app, html);
}
const brand = sub => `<div class="brand"><span class="wm">${LOGO}<span>On<b>Tilt</b></span></span>${sub?`<small>${sub}</small>`:''}</div>`;
// Logo mark: a single card outline, knocked off-square. Same art as assets/favicon.svg.
const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="9" y="5" width="14" height="22" rx="3" fill="none" stroke="#cde8c6" stroke-width="2.2" transform="rotate(14 16 16)"/></svg>`;
const mmss = ms => { const s=Math.ceil(ms/1000); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };

function savedTables(){
  const out=[];
  try{ for(let k=0;k<localStorage.length;k++){ const key=localStorage.key(k); if(!key.startsWith('pp-host-')) continue;
    const s=LS.get(key,null); if(!s||!Array.isArray(s.seats)) continue;
    out.push({ code:key.slice(8), mode:s.mode||'cash', sb:s.sb, bb:s.bb, players:s.seats.filter(Boolean).map(x=>x.name), hands:s.handNo||0, at:s.savedAt||0,
      done:!!s.tour?.finished }); } }catch{}
  return out.sort((a,b)=>b.at-a.at).slice(0,5);
}
const ago = t => { if(!t) return ''; const m=Math.round((Date.now()-t)/60000); return m<1?'just now':m<60?`${m}m ago`:m<1440?`${Math.round(m/60)}h ago`:`${Math.round(m/1440)}d ago`; };

function renderLobby(){
  const [sb,bb]=STAKES[lobby.stake];
  const avs=AVATARS.map(a=>`<button data-act="av" data-v="${a}" class="${a===me.av?'sel':''}">${a}</button>`).join('');
  const prof=`<div class="prof"><div class="nmrow"><input id="nm" placeholder="Your name" maxlength="14" autocomplete="off" value="${esc(me.name)}">
      <button class="dice" data-act="reroll" aria-label="Random name">${ICON.dice}</button></div><div class="avs">${avs}</div></div>`;
  if(lobby.mode==='create'){
    const tour=lobby.game==='tourney';
    const saved=savedTables();
    const savedHTML = `<div class="saved"><div class="saved-h"><span>Your tables</span></div>
      ${saved.map(t=>`<div class="srow"><button class="sgo" data-act="resume" data-v="${t.code}">
          <b>${t.mode==='tourney'?'Tournament':'Cash'} · ${fmt(t.sb)}/${fmt(t.bb)}</b>
          <span>${esc(t.players.slice(0,4).join(', ')||'No players')}${t.players.length>4?'…':''} · ${t.hands} hands · ${ago(t.at)}${t.done?' · finished':''}</span></button>
          <button class="sdel" data-act="forget" data-v="${t.code}" aria-label="Delete saved table">${ICON.x}</button></div>`).join('')
        || `<p class="none">Tables you host are saved on this device so you can pick them up later.</p>`}</div>`;
    paint(`<div class="lobby">
      <div class="panel">
        <div class="top"><span></span>${brand()}<span></span></div>
        <div class="seg"><button data-act="game" data-v="cash" class="${tour?'':'sel'}">Cash game</button><button data-act="game" data-v="tourney" class="${tour?'sel':''}">Tournament</button></div>
        <div class="lbl g">${tour?'Starting blinds':'Stakes'}</div><div class="big g">${sb} / ${bb}</div>
        ${tour
          ? `<div class="lbl">Starting stack</div><div class="big">${fmt(bb*TOUR_STACK_BB)}</div>
             <div class="seg sm">${SPEEDS.map(([n,m],k)=>`<button data-act="speed" data-v="${k}" class="${k===lobby.speed?'sel':''}">${n} · ${m} min</button>`).join('')}</div>`
          : `<div class="lbl">Buy-in</div><div class="big">${short(bb*20)} / ${short(bb*100)}</div>`}
        <div class="ruler" id="ruler">${STAKES.map((_,i)=>`<i class="${i===lobby.stake?'sel':''}"></i>`).join('')}</div>
      </div>
      <div class="side">
        ${prof}
        ${savedHTML}
        <div class="grow"></div>
        <div class="lbtns"><button class="lbtn out" data-act="invite">${ICON.link}COPY INVITE LINK</button>
          <button class="lbtn out sq" data-act="qr" aria-label="Show QR code">${ICON.qr}</button></div>
        <button class="lbtn wh" data-act="start">${tour?'CREATE TOURNAMENT':'START GAME'}</button>
      </div>
    </div>`);
    const ruler=document.getElementById('ruler');
    const pick=e=>{ const r=ruler.getBoundingClientRect(); const x=(e.clientX-r.left)/r.width;
      const k=Math.max(0,Math.min(STAKES.length-1,Math.round(x*(STAKES.length-1)))); if(k!==lobby.stake){ lobby.stake=k; readName(); renderLobby(); play('tick'); navigator.vibrate?.(8); } };
    ruler.onpointerdown=e=>{ ruler.setPointerCapture(e.pointerId); pick(e); ruler.onpointermove=pick; };
    ruler.onpointerup=()=>{ ruler.onpointermove=null; };
  } else {
    paint(`<div class="lobby">
      <div class="panel join">
        <div class="top"><button class="ico" data-act="home" aria-label="Back">${ICON.back}</button>${brand()}<span></span></div>
        <div class="join-h"><div class="big">You're invited</div><p>Table ${fmtCode(lobby.code)}. Pick a name and an avatar, then join.</p></div>
      </div>
      <div class="side">
        ${prof}
        <div class="grow"></div>
        <button class="lbtn wh" data-act="join">JOIN TABLE</button>
      </div>
    </div>`);
  }
}
function readName(){ const el=document.getElementById('nm'); if(el){ me.name=el.value.trim().slice(0,14); saveMe(); } }

// a slim bar whose height shows each player's share of the biggest stack at the table
function chipViz(stack, max){
  if(!(stack>0) || !(max>0)) return '';
  const p=Math.max(.12,Math.min(1,stack/max));
  return `<span class="cviz ${stack===max?'lead':''}" aria-hidden="true" style="--h:${p.toFixed(3)}"></span>`;
}

function renderTable(prev){
  const v=view;
  const T=v?.tour;
  let sub='';
  if(T && T.started && !T.finished) sub=`Level ${T.level+1} · ${fmt(v.sb)}/${fmt(v.bb)} · <span data-lvl>${mmss(T.levelLeft)}</span>`;
  else if(T) sub = T.finished ? 'Tournament over' : 'Tournament · registering';
  else if(v) sub=`Blinds ${fmt(v.sb)}/${fmt(v.bb)}`;
  const head=`<div class="top"><button class="ico" data-act="leave" aria-label="Leave">${ICON.back}</button>
    ${brand(sub)}<button class="ico" data-act="menu" aria-label="Menu">${ICON.menu}</button></div>`;
  if(!v && lan.show && lan.svg){
    paint(head+`<div class="center-msg"><div class="lanreply">
      <div class="qr-box">${lan.svg}</div>
      <b>Show this to the host</b>
      <span class="sub">${lan.online?'Connecting over the internet is slow, so let’s use Wi-Fi.':'No internet, so we’ll connect over Wi-Fi.'} The host taps ••• → Show QR code and points their camera here.</span></div></div>`);
    return;
  }
  if(!v){
    const why = {
      nolan:`You’re offline.<br><span class="sub">Ask the host to open ••• → Show QR code, then scan it with your phone camera. You both need the same Wi-Fi.</span>`,
      slow:`Still looking for the host…<br><span class="sub">Make sure the host has this table open in a browser tab and their screen is on.</span>`,
      blocked:`Found the host, but your networks won’t connect directly.<br><span class="sub">Try another network (Wi-Fi ↔ mobile data).</span>`,
      offline:`Couldn’t load the connection library.<br><span class="sub">Check your internet connection.</span>`,
    }[joinIssue] || (hostLost ? `Lost the host.<br><span class="sub">Ask them to keep the table open.</span>` : '');
    paint(head+`<div class="center-msg"><div>${why
      ? `${joinIssue==='offline'?'':'<div class="spin"></div>'}${why}<button class="lbtn out retry" data-act="retry">Retry</button>`
      : `<div class="spin"></div>Connecting to the table…<br><span class="sub">Table ${fmtCode(tableCode)}</span>`}</div></div>`);
    return;
  }
  const seated=v.mySeat>=0, anchor=seated?v.mySeat:0, mine=seated?v.seats[v.mySeat]:null;
  const active=isActive(v);
  const R=v.results;
  const maxStack=Math.max(0,...v.seats.filter(Boolean).map(s=>s.stack));

  // --- board
  const newCards = prev && prev.handNo===v.handNo ? prev.board.length : 0;
  const board=[0,1,2,3,4].map(k=>v.board[k] ? cardHTML(v.board[k], k>=newCards?'deal':'', (k-newCards)*90) : cardHTML('back')).join('');

  // --- controls
  const myTurn = seated && v.toAct===v.mySeat && active;
  let ctrl='', raisePanel='', betChip='';
  const wide = msg => `<div class="ctrl"><button class="btn wide" disabled>${msg}</button></div>`;
  if(mine && mine.bet>0) betChip=`<span class="chip" data-k="b${mine.bet}">${fmt(mine.bet)}</span>`;
  if(R && seated && R.won[v.mySeat]) betChip=`<span class="chip win" data-k="w">+${fmt(R.won[v.mySeat])}</span>`;
  const seatedN=v.seats.filter(Boolean).length;
  if(T && T.finished){
    ctrl = v.isHost ? `<div class="ctrl" style="grid-template-columns:1fr 1fr"><button class="btn on" data-act="standings">Standings</button><button class="btn solid" data-act="treset">Run it back</button></div>`
                    : `<div class="ctrl"><button class="btn on wide" data-act="standings">Final standings</button></div>`;
  } else if(T && !T.started){
    ctrl = v.isHost && seatedN>=2 ? `<div class="ctrl"><button class="btn solid wide" data-act="tstart">Start tournament · ${seatedN} players</button></div>`
         : wide(v.isHost ? 'Waiting for players · tap + to add bots' : seated ? 'Waiting for the host to start' : 'Tap + to take a seat');
  } else if(!seated){
    const full=v.seats.every(Boolean);
    ctrl = wide(T ? (T.myPlace ? `You finished #${T.myPlace} · watching` : 'Tournament running · watching') : full?'Table is full · watching':'Tap + to take a seat');
  } else if(mine.stack===0 && !(mine.inHand&&active) && !T){
    ctrl=`<div class="ctrl" style="grid-template-columns:1fr 1fr"><button class="btn on" data-act="rebuy">Rebuy ${short(v.buyIn)}</button><button class="btn on" data-act="stand">Stand up</button></div>`;
  } else if(!mine.inHand || !active){
    ctrl = wide(active?'Wait for the next hand': v.street==='showdown'?'Next hand…': seatedN>1? 'Starting…':'Waiting for players');
  } else {
    const toCall=v.curBet-mine.bet, maxTo=mine.bet+mine.stack;
    const minTo=Math.min(v.curBet+v.minRaise,maxTo), canRaise=maxTo>v.curBet && !mine.allIn && !mine.noReraise;
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
    if(mine.allIn || mine.folded){ ctrl=wide(mine.folded?'Folded':'All in'); }
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
  const holeCards = mine && mine.cards && mine.cards.length ? mine.cards : null;
  const holeNew = holeCards && (!prev || prev.handNo!==v.handNo);
  const hidden = holeCards && ui.hide;
  const hole = hidden ? cardHTML('back','hid')+cardHTML('back','hid')
             : holeCards ? holeCards.map((c,k)=>cardHTML(c, holeNew?'deal':'', k*120)).join('')
             : (!seated && a && a.cards) ? a.cards.map(c=>cardHTML(c)).join('') : cardHTML(null)+cardHTML(null);
  let hn='';
  if(seated && holeCards){ hn = hidden ? 'Hidden · tap to peek' : R&&R.hands[v.mySeat] ? R.hands[v.mySeat] : handName(bestOf([...holeCards,...v.board])); }
  else if(!seated && a && R && R.hands[anchor]) hn=R.hands[anchor];
  const handTurn = v.toAct===anchor && active;
  let box;
  if(a){
    box=`<div class="hand ${handTurn?'turn':''}" ${handTurn&&v.turnLeft?'data-timer':''} data-seat-av="${anchor}">
      <div class="hn">${esc(hn)}</div>
      <div class="av">${a.av}${v.dealer===anchor&&v.handNo?'<b class="d">D</b>':''}</div>
      <div class="st">${chipViz(a.stack,maxStack)}${fmt(a.stack)}</div>
      ${seated?`<button class="smile" data-act="emote" aria-label="Reactions">${ICON.smile}</button>`:''}</div>`;
  } else {
    box=`<div class="hand"><div class="hn">Open seat</div><button class="plus" data-k="plus" data-act="sit" data-i="${anchor}" ${seated?'disabled':''}></button><div class="hn"></div></div>`;
  }
  const holeEl=`<div class="hole ${mine&&mine.folded?'folded':''} ${holeCards?'mine':''}" id="hole">${hole}</div>`;
  const meRow=`<div class="me">${holeEl}${box}</div>`;

  const banner = hostLost ? `<div class="banner">Lost connection to host… waiting</div>` : '';
  const emo = ui.emoteOpen ? `<div class="shade" data-act="emoteClose"></div><div class="emobar">${EMOTES.map(e=>`<button data-act="em" data-v="${e}">${e}</button>`).join('')}</div>` : '';
  const potHTML = `<div class="pot">${v.pot>0||active?fmt(v.pot):''}</div>`;

  const fx=captureFx();
  // Desktop uses the same open layout as phones (a row of players, the board, your controls), just wider.
  let top=''; for(let k=1;k<MAXS;k++) top+=seatHTML(v,(anchor+k)%MAXS,seated,maxStack);
  if(deskMQ.matches){
    const keys = myTurn && !ui.raiseOpen ? `<div class="keys"><kbd>F</kbd> fold <kbd>C</kbd> check / call <kbd>R</kbd> raise <kbd>↑</kbd> custom <kbd>H</kbd> hide</div>` : '';
    paint(head + banner +
      `<div class="seats">${top}</div><div class="grow" style="flex-grow:1"></div>
       <div class="center"><div class="board">${board}</div>${potHTML}</div>
       <div class="grow" style="flex-grow:1.2"></div>
       <div class="mybet">${betChip}</div>
       <div class="dock">${holeEl}${box}
         <div class="act">${raisePanel}${ctrl}${keys}</div></div>${emo}`);
  } else {
    paint(head + banner +
      `<div class="seats">${top}</div><div class="grow" style="flex-grow:1"></div>
       <div class="board">${board}</div>${potHTML}
       <div class="grow" style="flex-grow:1.3"></div>
       ${raisePanel || `<div class="mybet">${betChip}</div>`}
       ${ctrl}${meRow}${emo}`);
  }
  runFx(fx, prev, v);

  const rng=document.getElementById('rng');
  if(rng) rng.oninput=()=>{ ui.raiseTo=+rng.value; document.getElementById('ramt').textContent=fmt(ui.raiseTo); };
  bindHole(myTurn && mine && v.curBet>mine.bet);
}

function seatHTML(v,i,seated,maxStack){
  const s=v.seats[i], R=v.results, active=isActive(v);
  const canSit = !(v.tour && v.tour.started) && (!seated || v.isHost);
  if(!s) return `<div class="seat empty"><div class="pie-wrap"></div>
    <button class="plus" data-k="plus" data-act="sit" data-i="${i}" ${canSit?'':'disabled'} aria-label="Sit here"></button>
    <div class="nm">&nbsp;</div><div class="st">&nbsp;</div><div class="under"></div></div>`;
  const dim = (active&&(!s.inHand||s.folded)) || (!s.connected) || (R&&s.inHand&&s.folded) ;
  let under='';
  if(R && R.reveal[i]) under = R.reveal[i].map(c=>cardHTML(c,'mini')).join('') + (R.won[i]?`<span class="chip win" data-k="w" style="margin-left:2px">+${short(R.won[i])}</span>`:'');
  else if(R && R.won[i]) under=`<span class="chip win" data-k="w">+${fmt(R.won[i])}</span>`;
  else if(s.bet>0) under=`<span class="chip" data-k="b${s.bet}">${fmt(s.bet)}</span>`;
  else if(s.allIn && active) under=`<span class="tag">ALL IN</span>`;
  else if(active && s.last==='Check') under=`<span class="tag" style="color:#6d6d72">CHECK</span>`;
  const turn = v.toAct===i && active;
  return `<div class="seat ${dim?'dim':''} ${turn?'turn':''}">
    <div class="pie-wrap">${turn?'<div class="pie" data-timer></div>':''}</div>
    <button class="av" data-k="av${esc(s.name)}" data-act="seatTap" data-i="${i}" data-seat-av="${i}">${s.av}${v.dealer===i&&v.handNo?'<b class="d">D</b>':''}</button>
    <div class="nm">${esc(s.name)}</div><div class="st">${chipViz(s.stack,maxStack)}${fmt(s.stack)}</div>
    <div class="under">${under}</div></div>`;
}

// Your cards: tap to hide/peek, swipe up to fold (when facing a bet).
function bindHole(canFold){
  const h=document.getElementById('hole'); if(!h || !h.classList.contains('mine')) { if(h){ h.onpointerdown=null; } return; }
  let y0=null, x0=0, dy=0, t0=0, moved=false;
  h.style.touchAction='none';
  h.onpointerdown=e=>{ y0=e.clientY; x0=e.clientX; dy=0; t0=performance.now(); moved=false; h.setPointerCapture(e.pointerId); h.classList.add('drag'); };
  h.onpointermove=e=>{ if(y0==null) return; const up=y0-e.clientY;
    if(Math.abs(up)>8 || Math.abs(e.clientX-x0)>8) moved=true;
    if(!canFold) return;
    dy=Math.max(0,up); h.style.transform=`translateY(${-dy}px) rotate(${-dy/40}deg)`; h.style.opacity=String(1-Math.min(dy/180,.7)); };
  h.onpointerup=h.onpointercancel=e=>{ if(y0==null) return; y0=null; h.classList.remove('drag');
    if(canFold && dy>70){ h.classList.add('flung'); play('fold'); send({t:'act',a:'fold'}); return; }
    h.style.transform=''; h.style.opacity='';
    if(e.type==='pointerup' && !moved && performance.now()-t0<450) toggleHide(); };
}
function toggleHide(){ ui.hide=!ui.hide; LS.set('ot-hide',ui.hide); play('flip'); navigator.vibrate?.(8); render(); }

// timers (pie + border) animate locally from the host's "time left"; the level clock ticks once a second
let lastSec=-1;
(function tick(){
  if(view){
    const el=performance.now()-view.recvAt;
    if(view.turnLeft>0){
      const left=Math.max(0,view.turnLeft-el), p=(left/view.turnTotal).toFixed(4);
      document.querySelectorAll('[data-timer]').forEach(e=>e.style.setProperty('--p',p));
    }
    if(view.tour?.levelLeft){ const sec=Math.ceil(Math.max(0,view.tour.levelLeft-el)/1000);
      if(sec!==lastSec){ lastSec=sec; const n=document.querySelector('[data-lvl]'); if(n) n.textContent=mmss(sec*1000); } }
  }
  requestAnimationFrame(tick);
})();

function floatEmote(seat,e){
  play('emote');
  const el=document.querySelector(`[data-seat-av="${seat}"]`); if(!el) return;
  const r=el.getBoundingClientRect(), f=document.createElement('div');
  f.className='float'; f.textContent=e; f.style.left=(r.left+r.width/2)+'px'; f.style.top=(r.top+r.height/2)+'px';
  document.body.appendChild(f); setTimeout(()=>f.remove(),2300);
}

// ------------------------------ motion ------------------------------
// Bets slide into the pot when a betting round ends; winnings slide from the pot to the winner;
// the pot counts up. Everything is skipped when the user prefers reduced motion.
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let potShown=0, potRaf=0;
function captureFx(){
  return [...app.querySelectorAll('.chip:not(.win)')].map(el=>({el, r:el.getBoundingClientRect(), html:el.outerHTML}));
}
function flyChip(html, from, to, delay=0){
  const t=document.createElement('div'); t.innerHTML=html; const c=t.firstElementChild; c.classList.add('fly');
  Object.assign(c.style,{left:from.left+'px',top:from.top+'px',width:from.width+'px',height:from.height+'px',transitionDelay:delay+'ms'});
  document.body.appendChild(c);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    c.style.transform=`translate(${to.left+to.width/2-from.left-from.width/2}px,${to.top+to.height/2-from.top-from.height/2}px) scale(.7)`;
    c.style.opacity='0';
  }));
  setTimeout(()=>c.remove(), 650+delay);
}
function runFx(fx, prev, v){
  const potEl=app.querySelector('.pot');
  if(!calm.matches && prev && potEl){
    const pr=potEl.getBoundingClientRect(), target={left:pr.left+pr.width/2-20,top:pr.top,width:40,height:pr.height};
    // bets that vanished this render were collected into the pot
    if(prev.street!==v.street || prev.handNo!==v.handNo)
      fx.filter(f=>!f.el.isConnected).forEach((f,k)=>flyChip(f.html, f.r, target, k*40));
    // new winnings fly out of the pot
    if(v.results && !prev.results)
      app.querySelectorAll('.chip.win').forEach((el,k)=>{ const r=el.getBoundingClientRect();
        el.style.animationDelay=(350+k*80)+'ms';
        flyChip(`<span class="chip win"></span>`, {left:target.left,top:target.top,width:r.width,height:r.height}, r, k*80); });
  }
  // pot counts toward its new value
  if(potEl && v.pot>0){
    const to=v.pot, from=calm.matches||!prev||prev.handNo!==v.handNo?to:potShown;
    cancelAnimationFrame(potRaf); potShown=to;
    if(from!==to){ const t0=performance.now();
      const step=now=>{ const k=Math.min(1,(now-t0)/450), e=1-Math.pow(1-k,3);
        potEl.textContent=fmt(from+(to-from)*e); if(k<1) potRaf=requestAnimationFrame(step); };
      potEl.textContent=fmt(from); potRaf=requestAnimationFrame(step);
      potEl.classList.remove('bump'); void potEl.offsetWidth; potEl.classList.add('bump'); }
  } else potShown=0;
}

// ------------------------------ sheets ------------------------------
function sheet(title, text, buttons, cls=''){
  const bg=document.createElement('div'); bg.className='sheet-bg';
  bg.innerHTML=`<div class="sheet ${cls}"><h3>${esc(title)}</h3>${text?`<div class="sheet-body">${text}</div>`:''}${buttons.map((b,k)=>`<button class="sb ${b.cls||''}" data-k="${k}">${esc(b.label)}</button>`).join('')}
    <button class="sb" data-k="x" style="background:transparent;color:var(--mut)">Close</button></div>`;
  bg.onclick=e=>{ const t=e.target.closest('[data-k]'), k=t?.dataset.k; if(e.target===bg||k==='x'){ closeSheet(bg); return; }
    if(k!=null){ closeSheet(bg); buttons[+k].fn?.(); } };
  document.body.appendChild(bg);
  return bg;
}
function closeSheet(bg){ if(bg.classList.contains('closing')) return; bg.classList.add('closing'); bg.onClose?.(); setTimeout(()=>bg.remove(),180); }
function inviteUrl(){ return location.origin+location.pathname+'#'+(tableCode||lobby.code); }
async function shareInvite(){
  const url=inviteUrl();
  if(navigator.share){ try{ await navigator.share({title:'OnTilt',text:`Join my OnTilt poker table`,url}); return; }catch(e){ if(e.name==='AbortError') return; } }
  copyInvite();
}
async function copyInvite(){
  try{ await navigator.clipboard.writeText(inviteUrl()); toast('Invite link copied'); }
  catch{ sheet('Invite link', `<p class="sel-text">${esc(inviteUrl())}</p>`, []); }
}
async function qrSheet(forceOnline){
  // Hosts without internet go straight to nearby (LAN) pairing
  if(isHost && !forceOnline && !(await hasInternet())) return lanSheet();
  const url=inviteUrl();
  const bg=sheet('Scan to join', `<div class="qr"><div class="qr-box"><div class="spin"></div></div><p>Point a phone camera here to join table ${fmtCode(tableCode||lobby.code)}.</p></div>`,
    [{label:'Copy link',fn:copyInvite}, ...(isHost?[{label:'No internet? Pair nearby',fn:lanSheet}]:[])], 'qr-sheet');
  try{ bg.querySelector('.qr-box').innerHTML=await qrSVG(url); }
  catch{ bg.querySelector('.qr-box').innerHTML='<p>Couldn’t draw the QR code. Use the link instead.</p>'; }
}
// Host: pair nearby players without internet. Show an offer QR; the guest's phone camera opens it,
// their screen shows a reply QR, and we scan that reply here. Repeats for each player.
let lanPending=null;
async function lanSheet(){
  const bg=sheet('Play nearby, no internet', `<div class="lan">
      <ol class="steps"><li>They scan this code with their phone camera.</li><li>Point your camera at the code on their screen.</li></ol>
      <div class="qr-box" id="lanqr"><div class="spin"></div></div>
      <div class="cam"><video id="lancam" playsinline muted></video><span id="lanstat">Starting camera…</span></div>
      <p class="note">Everyone needs the same Wi-Fi (or your phone’s hotspot). Guests must have opened OnTilt once before.</p></div>`,
    [{label:'Use internet invite instead',fn:()=>qrSheet(true)}], 'qr-sheet lan-sheet');
  const stat=t=>{ const el=bg.querySelector('#lanstat'); if(el) el.textContent=t; };
  let scanner=null, busy=false;
  bg.onClose=()=>{ scanner?.stop(); if(lanPending && !links.size){ /* keep unused offer for next time */ } };
  const fresh=async()=>{
    try{
      lanPending=await makeOffer();
      const box=bg.querySelector('#lanqr'); if(box) box.innerHTML=await qrSVG(inviteUrl()+'~'+lanPending.code);
    }catch(e){ console.warn(e); const box=bg.querySelector('#lanqr'); if(box) box.innerHTML='<p>Couldn’t find a local network. Connect to Wi-Fi or turn on your hotspot.</p>'; }
  };
  const onCode=async text=>{
    const m=String(text).match(/^OTA:(.+)$/); if(!m || busy || !lanPending) return;
    busy=true; stat('Connecting…');
    const p=lanPending; lanPending=null;
    try{
      await acceptAnswer(p.pc, m[1]); await opened(p.ch);
      wire('lan-'+Math.random().toString(36).slice(2,9), p.ch, p.pc);
      play('join'); toast('Player connected over Wi-Fi'); stat('Connected! Scan the next player’s reply…');
    }catch(e){ console.warn(e); p.pc.close(); stat('Couldn’t connect. Check you’re on the same Wi-Fi and try again.'); }
    busy=false;
    if(bg.isConnected && !bg.classList.contains('closing')) fresh();
  };
  // camera first: with camera permission, WebRTC offers carry real LAN addresses, which connect more reliably
  try{ scanner=await startScanner(bg.querySelector('#lancam'), onCode); stat('Scanning for their reply…'); }
  catch{ stat('Camera blocked. Allow camera access to scan replies.'); }
  if(!bg.isConnected || bg.classList.contains('closing')){ scanner?.stop(); return; }
  if(!lanPending) await fresh(); else { const box=bg.querySelector('#lanqr'); if(box) box.innerHTML=await qrSVG(inviteUrl()+'~'+lanPending.code); }
}

// Guest: answer a host's offer from the scanned link and show the reply QR for the host to scan.
const lan={ reply:'', svg:'', show:false, online:true };
async function startLanGuest(offer){
  try{
    const g=await answerOffer(offer);
    wire('lan-host', g.ch, g.pc);
    const hi=()=>{ if(view && !hostLost) return; netSend({t:'hello',...helloData()}, 'lan-host'); };
    g.ch.addEventListener('open', ()=>{ hi(); setInterval(hi, 3000); lan.show=false; render(); });
    lan.reply='OTA:'+g.code; lan.svg=await qrSVG(lan.reply);
    if(!lan.online) lan.show=true;
    else setTimeout(()=>{ if(!view){ lan.show=true; render(); } }, 4000);   // internet path didn't connect quickly: offer the LAN route
    render();
  }catch(e){ console.warn(e); if(!lan.online){ joinIssue='nolan'; render(); } }
}

function ledgerSheet(){
  const rows=(view?.ledger||[]).map(L=>`<tr><td>${esc(L.name)}${L.seated?'':' <span style="color:var(--mut)">(left)</span>'}</td><td>${fmt(L.buy)}</td><td class="${L.net>0?'pos':L.net<0?'neg':''}">${L.net>0?'+':''}${fmt(L.net)}</td></tr>`).join('');
  sheet('Ledger', `<table class="ledger"><tr><th>Player</th><th>Bought in</th><th>Net</th></tr>${rows||'<tr><td colspan=3>No buy-ins yet</td></tr>'}</table>`, []);
}
function standingsSheet(){
  const T=view?.tour; if(!T) return;
  const alive=view.seats.filter(Boolean).filter(s=>s.stack>0).sort((a,b)=>b.stack-a.stack);
  const medal=p=>['🥇','🥈','🥉'][p-1]||`#${p}`;
  const rows = T.finished ? T.places : [...alive.map((s,k)=>({name:s.name,av:s.av,place:k+1,stack:s.stack})), ...T.places];
  const html=`<table class="ledger"><tr><th>Place</th><th>Player</th><th>${T.finished?'':'Chips'}</th></tr>
    ${rows.map(p=>`<tr><td>${T.finished||p.stack==null?medal(p.place):p.place}</td><td>${p.av||''} ${esc(p.name)}</td><td>${p.stack!=null?fmt(p.stack):p.stack===undefined&&!T.finished?'out':''}</td></tr>`).join('')||'<tr><td colspan=3>No players yet</td></tr>'}</table>`;
  const w=T.finished && T.places.find(p=>p.place===1);
  sheet(w?`🏆 ${w.name} wins!`:'Standings', html, view.isHost&&T.finished?[{label:'Run it back',cls:'primary',fn:()=>send({t:'treset'})}]:[]);
}
function historySheet(){
  const log=view?.log||[];
  const html = log.length ? `<div class="hist">${log.map(h=>`<div class="hrow"><div class="hh"><b>Hand ${h.n}</b><span>${esc(h.summary)}</span></div>
      ${h.board.length?`<div class="hb">${h.board.map(c=>cardHTML(c,'mini')).join('')}</div>`:''}
      ${h.shown.map(s=>`<div class="hs">${s.cards.map(c=>cardHTML(c,'mini')).join('')}<span>${esc(s.name)} · ${esc(s.hand)}</span></div>`).join('')}</div>`).join('')}</div>`
    : '<p>No hands played yet.</p>';
  sheet('Hand history', html, [], 'tall');
}
function settingsSheet(){
  sheet('Sound & vibration', '', [
    {label:`Sound: ${fxPrefs.sound?'on':'off'}`, fn:()=>{ fxPrefs.sound=!fxPrefs.sound; play('chip'); settingsSheet(); }},
    {label:`Vibration: ${fxPrefs.vibe?'on':'off'}`, fn:()=>{ fxPrefs.vibe=!fxPrefs.vibe; play('chip'); settingsSheet(); }},
  ]);
}

// ------------------------------ input ------------------------------
app.addEventListener('click', e=>{
  const b=e.target.closest('[data-act]'); if(!b || b.disabled) return;
  const act=b.dataset.act, v=view;
  switch(act){
    case 'av': readName(); me.av=b.dataset.v; saveMe(); play('tick'); renderLobby(); break;
    case 'reroll': me.name=randomName(); saveMe(); play('tick'); renderLobby(); { const el=document.getElementById('nm'); if(el) el.value=me.name; } break;
    case 'game': readName(); lobby.game=b.dataset.v; play('tick'); renderLobby(); break;
    case 'speed': readName(); lobby.speed=+b.dataset.v; play('tick'); renderLobby(); break;
    case 'invite': readName(); copyInvite(); break;
    case 'qr': readName(); qrSheet(); break;
    case 'resume': location.hash=b.dataset.v; break;
    case 'forget': sheet('Delete saved table?', 'This removes it from this device. Players can’t rejoin it afterwards.',
      [{label:'Delete',cls:'danger',fn:()=>{ LS.del('pp-host-'+b.dataset.v); renderLobby(); }}]); break;
    case 'start': readName(); if(!me.name){ toast('Enter your name first'); document.getElementById('nm')?.focus(); return; } startHosting(); break;
    case 'join': readName(); if(!me.name){ toast('Enter your name first'); document.getElementById('nm')?.focus(); return; } startJoining(); break;
    case 'home': goHome(); break;
    case 'sit': { const i=+b.dataset.i;
      if(v.mySeat<0) send({t:'sit',seat:i});
      else if(v.isHost) sheet('Open seat','Add a bot to fill this seat?',[{label:'Add bot',cls:'primary',fn:()=>send({t:'addbot',seat:i})}]);
      break; }
    case 'seatTap': { const i=+b.dataset.i, s=v.seats[i];
      if(v.isHost && s && i!==v.mySeat) sheet(s.name, s.bot?'This seat is a bot.': v.tour?.started ? 'Remove this player? They forfeit the tournament.' : 'Remove this player from the table? Their chips are cashed out in the ledger.',
        [{label:s.bot?'Remove bot':'Remove player',cls:'danger',fn:()=>send({t:'kick',seat:i})}]);
      break; }
    case 'fold': play('fold'); send({t:'act',a:'fold'}); break;
    case 'check': play('check'); send({t:'act',a:'check'}); break;
    case 'call': play('chip'); send({t:'act',a:'call'}); break;
    case 'raiseMin': play('chips'); send({t:'act',a:'raise',amt:+b.dataset.v}); break;
    case 'raiseOpen': ui.raiseOpen=true; ui.raiseTo=0; play('tick'); render(); break;
    case 'raiseClose': ui.raiseOpen=false; render(); break;
    case 'preset': ui.raiseTo=+b.dataset.v; play('tick'); render(); break;
    case 'raiseGo': ui.raiseOpen=false; play('chips'); send({t:'act',a:'raise',amt:ui.raiseTo}); break;
    case 'emote': ui.emoteOpen=true; render(); break;
    case 'emoteClose': ui.emoteOpen=false; render(); break;
    case 'em': ui.emoteOpen=false; send({t:'emote',e:b.dataset.v}); render(); break;
    case 'rebuy': play('chips'); send({t:'rebuy'}); break;
    case 'stand': send({t:'stand'}); break;
    case 'tstart': send({t:'tstart'}); break;
    case 'treset': send({t:'treset'}); break;
    case 'standings': standingsSheet(); break;
    case 'retry': location.reload(); break;
    case 'menu': {
      const btns=[{label:'Invite friends',cls:'primary',fn:shareInvite},{label:'Show QR code',fn:qrSheet},{label:'Hand history',fn:historySheet}];
      btns.push(v?.tour ? {label:'Standings',fn:standingsSheet} : {label:'Ledger',fn:ledgerSheet});
      btns.push({label:'Sound & vibration',fn:settingsSheet});
      if(v && v.mySeat>=0) btns.push({label:v.tour?.started?'Leave tournament':'Stand up',fn:()=>send({t:'stand'})});
      if(isHost) btns.push({label:'Close table for everyone',cls:'danger',fn:endTable});
      const what = v?.tour ? `Tournament · starting stack ${fmt(v.tour.stack)}` : v ? `Blinds ${v.sb}/${v.bb} · buy-in ${short(v.buyIn)}` : '';
      sheet(`Table ${fmtCode(tableCode)}`, `<p>${what}${isHost?' · you are hosting. The table saves automatically on this device.':''}</p>`, btns); break; }
    case 'leave':
      if(isHost) sheet('Leave table?','You’re the host. The game pauses for everyone while you’re away. It’s saved on this device: open the same link or pick it from “Your tables” to resume.',[{label:'Leave',cls:'danger',fn:goHome}]);
      else sheet('Leave table?','Your chips stay at the table until you stand up.',[{label:'Stand up and leave',cls:'danger',fn:()=>{ send({t:'stand'}); setTimeout(goHome,250); }},{label:'Just leave',fn:goHome}]);
      break;
  }
});
app.addEventListener('keydown', e=>{ if(e.target.id==='nm' && e.key==='Enter'){ e.preventDefault(); document.querySelector('[data-act=start],[data-act=join]')?.click(); } });

// keyboard shortcuts (desktop): F fold, C / space check-call, R min-raise, ↑ custom raise, Enter confirm, H hide cards, Esc close
document.addEventListener('keydown',e=>{
  if(e.metaKey||e.ctrlKey||e.altKey||e.target.closest?.('input:not([type=range])')) return;
  if(e.key==='Escape'){ const bg=document.querySelector('.sheet-bg:not(.closing)'); if(bg){ closeSheet(bg); return; }
    if(ui.emoteOpen){ ui.emoteOpen=false; render(); return; } if(ui.raiseOpen){ ui.raiseOpen=false; render(); } return; }
  if(screen==='lobby' || document.querySelector('.sheet-bg:not(.closing)')) return;
  if(e.key.toLowerCase()==='h' && document.querySelector('#hole.mine')){ toggleHide(); return; }
  const acts={ f:['fold'], c:['check','call'], ' ':['check','call'], r:['raiseMin'], arrowup:['raiseOpen'], enter:['raiseGo'] }[e.key.toLowerCase()];
  if(!acts) return;
  const b=acts.map(a=>app.querySelector(`button[data-act="${a}"]:not(:disabled)`)).find(Boolean);
  if(b){ e.preventDefault(); b.click(); }
});

// ------------------------------ flows ------------------------------
function startHosting(){
  const [sb,bb]=STAKES[lobby.stake];
  tableCode=lobby.code; isHost=true;
  const tour = lobby.game==='tourney'
    ? { started:false, finished:false, baseSb:sb, level:0, levelMs:SPEEDS[lobby.speed][1]*60000, levelEnds:0, places:[], stack:bb*TOUR_STACK_BB } : null;
  S=mkState({sb,bb,buyIn:bb*100,minBuy:bb*20,table:tableCode,mode:tour?'tourney':'cash',tour});
  S.seats[0]=mkSeat({token:me.token,pid:'local',name:me.name,av:me.av,stack:tour?tour.stack:S.buyIn});
  if(!tour) S.ledger[me.token]={name:me.name,buy:S.buyIn,out:0};
  history.replaceState(null,'','#'+tableCode);
  screen='table'; hostSync(); connect(tableCode);
  setTimeout(()=>toast(tour?'Invite friends from •••, add bots with +, then start':'Tap ••• to invite friends, or + to add bots',4200),600);
}
function resumeHost(code){
  tableCode=code; isHost=true; S=LS.get('pp-host-'+code,null);
  // fill in fields added in newer versions
  S.mode ||= 'cash'; S.dead ||= 0; S.burned ||= []; S.log ||= [];
  for(const s of S.seats) if(s){ s.noReraise ??= false; s.startStack ??= s.stack; }
  for(const s of S.seats) if(s&&!s.bot){ s.connected = s.token===me.token; if(s.token===me.token) s.pid='local'; }
  // the blind clock stops while a tournament is closed
  if(S.tour && S.tour.started && !S.tour.finished && S.savedAt) S.tour.levelEnds += Math.max(0, Date.now()-S.savedAt);
  S.seq++; screen='table'; hostSync(); connect(code);
  toast('Table resumed');
}
async function startJoining(){
  tableCode=lobby.code; isHost=false; screen='table'; render();
  lan.online=await hasInternet();
  if(lobby.lanOffer) startLanGuest(lobby.lanOffer);          // scanned an offline QR: Wi-Fi route ready either way
  if(lan.online) connect(tableCode);
  else if(!lobby.lanOffer){ joinIssue='nolan'; render(); }
  setTimeout(()=>{ if(!view && screen==='table' && !joinIssue && !lan.show){ joinIssue='slow'; render(); } }, JOIN_HINT_MS);
}
function endTable(){
  sheet('Close the table?','Everyone is sent back to the start screen and the saved table is deleted.',[{label:'Close table',cls:'danger',fn:()=>{
    netSend({t:'ended'});
    LS.del('pp-host-'+tableCode); setTimeout(goHome,300); }}]);
}
function goHome(){ try{ net?.room.leave(); }catch{} history.replaceState(null,'',location.pathname); location.reload(); }
const newCode = () => String(1000000+rnd(9000000));

// ------------------------------ boot ------------------------------
(function boot(){
  const code=(location.hash.slice(1).match(/\d{7}/)||[])[0];
  if(code && LS.get('pp-host-'+code,null)) return resumeHost(code);
  const offer=(location.hash.match(/~(.+)$/)||[])[1];
  if(code){ lobby={...lobby,mode:'join',code,lanOffer:offer?decodeURIComponent(offer):''}; }
  else lobby={...lobby,mode:'create',code:newCode()};
  screen='lobby'; render();
})();
window.addEventListener('hashchange',()=>location.reload());
// cache the app so it opens without internet (needed for nearby play)
if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('sw.js').catch(()=>{});
