/* =====================================================================
   OnTilt: peer-to-peer Texas Hold'em for friends.
   The host's browser runs the game (deals, enforces rules) and sends each
   player only what they're allowed to see. Networking is WebRTC via
   Trystero (signaling over public Nostr relays), so the site itself is
   fully static and works on GitHub Pages.
   ===================================================================== */

import { TURN_MS, APP_ID, TRYSTERO_URL, RELAY_URLS, TURN_CREDENTIALS_URL, TURN_SERVERS, JOIN_HINT_MS } from './config.js';
import { MAXS, rnd, bestOf, handName, mkState, mkSeat, potTotal, startHand, endRound, applyAction, botMove, fmt,
  isActive, removeSeat, blindsFor, tourLevelUp, tourSettle, describe, equity, HAND_NAMES, nextPlace, MAX_LEVEL } from './engine.js';
import { morph } from './morph.js';
import { AVATARS, avatarSVG, normAv } from './avatars.js';
import { app, short, esc, fmtCode, STAKES, EMOTES, BOTS, ICON, cardHTML, toast, LS, randomName, raiseStops } from './ui-helpers.js';
import { play, buzz, fx as fxPrefs } from './sound.js';
import { qrSVG } from './qr.js';
import { makeOffer, answerOffer, acceptAnswer, opened } from './lan.js';
import { startScanner } from './scan.js';
import { voice, voiceRoom, voicePeerJoin, voicePeerLeave, joinVoice, leaveVoice, setMuted, silence } from './voice.js';

// ------------------------------ profile ------------------------------
const me = LS.get('pp-me', null) || { token: crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2), name:'', av:AVATARS[0] };
if(!me.name){ me.name=randomName(); me.av=AVATARS[rnd(AVATARS.length)]; }   // new players get a fun suggestion
me.av=normAv(me.av);   // older versions saved emoji avatars
const saveMe = () => LS.set('pp-me', me);
saveMe();

// ------------------------------ runtime ------------------------------
let isHost=false, S=null, view=null, net=null, hostPid=null, hostLost=false, tableCode=null;
let joinIssue='';                // guest: '' | 'slow' | 'blocked' | 'offline' (why we haven't reached the host yet)
let replaced=false;              // guest: this profile took its seat back from another tab or device
const peers=new Map();           // host: pid -> {token,name,av}
let timer=null, armedSeq=-1;
const ui={ odds:{ open:false, key:'', res:null, token:0 }, raiseOpen:false, raiseTo:0, emoteOpen:false, lastTurnKey:'', lastResultsKey:'', hide:LS.get('ot-hide',false), noteN:0, finishedShown:false };
const myPid = () => net ? net.selfId : 'local';
const TOUR_STACK_BB = 75;        // tournament starting stack, in starting big blinds

// ------------------------------ host identity ------------------------------
// The host signs every state it sends (ECDSA P-256). Guests check it against the key fingerprint in the
// invite link (or, for links without one, the first host key they saw), so no other player can pose as
// the host. Guests only send their private token to a host that passed that check.
const SIG={ name:'ECDSA', namedCurve:'P-256', hash:'SHA-256' };
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);
const canSign = !!globalThis.crypto?.subtle;
async function fingerprint(pub){ return [...new Uint8Array(await crypto.subtle.digest('SHA-256', unb64(pub)))].slice(0,8).map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function makeHostKey(){
  if(!canSign) return null;
  const k=await crypto.subtle.generateKey(SIG,true,['sign','verify']), pub=b64(await crypto.subtle.exportKey('raw',k.publicKey));
  return { priv:await crypto.subtle.exportKey('jwk',k.privateKey), pub, fp:await fingerprint(pub) };
}
let signer=null, signQ=Promise.resolve();          // host
async function useHostKey(hk){ signer = hk ? { key:await crypto.subtle.importKey('jwk',hk.priv,SIG,false,['sign']), pub:hk.pub } : null; }
function sendState(pid, v){
  const s=JSON.stringify(v);
  if(!signer) return netSend({t:'state',s}, pid);
  // a backup host that took over also sends the chain of endorsements back to the original host's key
  const chain = S?.chain?.length ? { chain:S.chain, root:S.rootPub } : {};
  signQ=signQ.then(async()=>netSend({t:'state',s,pk:signer.pub,sig:b64(await crypto.subtle.sign(SIG,signer.key,utf8(s))),...chain}, pid)).catch(e=>console.warn(e));
}
// Endorsement chain: each link is a new host key signed by the previous one, starting at the original
// host's key (the one pinned by the invite link). Returns the last key, or null if any link is bad.
const certMsg = (table, c) => `ontilt-host|${table}|${c.epoch}|${c.pub}`;
async function verifyChain(root, chain, table){
  if(typeof root!=='string' || !Array.isArray(chain) || chain.length>32) return null;
  let prev=root;
  for(const [k,c] of chain.entries()){
    if(!c || typeof c.pub!=='string' || typeof c.sig!=='string' || c.epoch!==k+1) return null;
    const key=await crypto.subtle.importKey('raw',unb64(prev),SIG,false,['verify']);
    if(!await crypto.subtle.verify(SIG,key,unb64(c.sig),utf8(certMsg(table,c)))) return null;
    prev=c.pub;
  }
  return prev;
}
let hostFp='', hostEpoch=0, verifyQ=Promise.resolve();          // guest
const hostKeys=new Map(), introduced=new Set();
async function verifiedState(d){
  if(typeof d.s!=='string') return null;
  if(!canSign) return JSON.parse(d.s);              // insecure context: nothing to check with
  if(!d.sig || !d.pk) return null;
  const fp=await fingerprint(d.pk);
  let epoch=0;
  if(hostFp && fp!==hostFp){
    // not the original host's key: only a successor endorsed (in a chain) by the original host passes
    if(!d.chain || await fingerprint(d.root)!==hostFp || await verifyChain(d.root, d.chain, tableCode)!==d.pk) return null;
    epoch=d.chain.length;
  }
  if(epoch<hostEpoch) return null;                 // an older host than the one we already follow
  let k=hostKeys.get(d.pk); if(!k){ k=await crypto.subtle.importKey('raw',unb64(d.pk),SIG,false,['verify']); hostKeys.set(d.pk,k); }
  if(!await crypto.subtle.verify(SIG,k,unb64(d.sig),utf8(d.s))) return null;
  if(!hostFp){ hostFp=fp; LS.set('ot-hk-'+tableCode, fp); }
  const v=JSON.parse(d.s); v.epoch=epoch; return v;
}

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
    room.onPeerJoin = pid => { voicePeerJoin(pid); if(isHost) return; act.send({t:'hello',...publicHello()},{target:pid}).catch(()=>{}); };
    room.onPeerLeave = pid => { voicePeerLeave(pid); lost(pid); };
    voiceRoom(room);
    if(isHost){ for(const s of S.seats) if(s&&s.token===me.token) s.pid=selfId; hostSync(); }
    else {
      // Keep saying hello until the host answers: covers lost messages and a host that opens the table after us.
      const hi=()=>{ if(isHost || view && !hostLost || replaced) return; act.send({t:'hello',...publicHello()}).catch(()=>{}); };
      hi(); setInterval(hi, 3000);
    }
  }catch(e){
    console.error(e);
    net=null;
    if(isHost) toast('No internet: invite nearby players with ••• → Show QR code (same Wi-Fi)', 5000);
    else { joinIssue='offline'; render(); toast('Could not load the peer-to-peer library', 4000); }
  }
}
// Everyone in the room hears the public hello; the token (which claims a seat) only goes to the verified host.
const publicHello = () => ({ name:me.name||'player', av:me.av });
const helloData = () => ({ ...publicHello(), token:me.token });
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
  if(isHost){ peers.delete(pid); for(const s of S.seats) if(s&&s.pid===pid){ s.connected=false; s.voice=null; } S.seq++; hostSync(); }
  else if(pid===hostPid){ hostLost=true; armTakeover(); render(); }
}

// ------------------------------ backup host ------------------------------
// The host keeps one online player (the backup) up to date with a copy of the table that has no cards
// or deck in it, and endorses a signing key the backup made for itself. If the host is gone for
// TAKEOVER_MS, the backup becomes the host: the unfinished hand is cancelled and bets go back.
// Every host broadcasts a beacon; an older host that comes back sees a newer one and rejoins as a player.
const TAKEOVER_MS=5000, GRACE_MS=20000, HEARTBEAT_MS=2000, SILENCE_MS=6000;
const VOICE_GUARD_MS=4*60000;   // after unmuting themselves, a player muted by someone else can't be muted again this long
let lastHeard=0;   // guest: last message from the host
let ended=false;
const bk={ key:null, pending:false, sentAt:0, snap:null, chain:null, root:null, at:0, timer:null };
const graceWaiting = () => (S.graceUntil||0)>Date.now() && S.seats.some(s=>s&&!s.bot&&!s.connected&&!s.leaving);
function backupPid(){
  if(!signer || !net) return null;
  const me0=S.seats.findIndex(s=>s&&s.pid===myPid());
  for(let k=1;k<=MAXS;k++){ const s=S.seats[((me0<0?0:me0)+k)%MAXS];
    if(s && !s.bot && s.connected && s.pid && s.pid!==myPid() && peers.has(s.pid) && !links.has(s.pid)) return s.pid; }
  return null;
}
async function issueCert(pid, pub){
  if(!isHost || !signer || pid!==S.backup?.pid || typeof pub!=='string' || pub.length>200) return;
  const c={ pub, epoch:(S.epoch||0)+1 };
  c.sig=b64(await crypto.subtle.sign(SIG,signer.key,utf8(certMsg(S.table,c))));
  if(S.backup?.pid===pid){ S.backup.cert=c; hostSync(); }
}
function snapshot(){
  const { deck, burned, hostKey, backup, ...rest }=S;          // never the deck, cards or the host's private key
  return { ...rest, seats:S.seats.map(s=>s&&{...s, cards:[]}), results:null, board:[] };
}
function sendBackup(){
  const b=backupPid();
  if(!b){ S.backup=null; return; }
  if(S.backup?.pid!==b) S.backup={ pid:b, cert:null };
  if(S.backup.cert) netSend({ t:'snap', s:snapshot(), chain:[...(S.chain||[]), S.backup.cert], root:S.rootPub }, b);
}
// guest side
function backupDuty(v){
  if(!v.backupYou || !canSign || isHost) return;
  const mine = bk.key && bk.chain && bk.chain.at(-1)?.pub===bk.key.pub;
  if(mine || bk.pending || Date.now()-bk.sentAt<5000) return;
  bk.pending=true;
  (bk.key ? Promise.resolve(bk.key) : makeHostKey()).then(k=>{ bk.key=k; bk.sentAt=Date.now(); netSend({t:'bkey', pub:k.pub}, hostPid); })
    .catch(()=>{}).finally(()=>{ bk.pending=false; });
}
function armTakeover(){
  if(isHost || ended || replaced || !bk.snap || !bk.key || bk.chain?.at(-1)?.pub!==bk.key.pub) return;
  clearTimeout(bk.timer);
  bk.armedAt=Date.now();
  bk.timer=setTimeout(()=>{ if(hostLost && !isHost && !ended && !replaced) takeOver(); }, TAKEOVER_MS);
}
function fromSnap(snap, at){
  const T=JSON.parse(JSON.stringify(snap)), mid=T.street!=='idle' && T.street!=='showdown';
  for(const s of T.seats) if(s){
    if(mid) s.stack+=s.total;                                 // the hand can't be finished without its cards: bets go back
    Object.assign(s,{ bet:0, total:0, folded:false, allIn:false, cards:[], inHand:false, acted:false, last:'', show:false });
  }
  Object.assign(T,{ deck:[], burned:[], board:[], street:'idle', toAct:-1, curBet:0, runout:false, results:null, dead:0, turnEnd:0 });
  if(T.tour && T.tour.started && !T.tour.finished) T.tour.levelEnds += Math.max(0, Date.now()-at);   // clock paused while nobody hosted
  return { T, mid };
}
async function takeOver(){
  const { T, mid }=fromSnap(bk.snap, bk.at);
  S=T; S.chain=bk.chain; S.epoch=bk.chain.length; S.rootPub=bk.root; S.rootFp=await fingerprint(bk.root).catch(()=>hostFp);
  S.hostKey=bk.key; S.backup=null; lobbyKey=bk.key;
  await useHostKey(bk.key).catch(()=>{});
  isHost=true; hostLost=false; hostPid=null; peers.clear(); introduced.clear();
  for(const s of S.seats) if(s && !s.bot){ s.connected = s.token===me.token; s.pid = s.token===me.token ? myPid() : null; }
  S.graceUntil=Date.now()+GRACE_MS;
  note(mid ? 'The host left mid-hand · bets were returned' : 'The host left · play continues', 'level');
  S.seq++; view=null; hostSync();
  toast('The host left, so you’re hosting this table now', 5000);
}
// host side: someone newer is hosting this table, so step down and rejoin as a player
async function onBeacon(d, pid){
  if(!S || !signer || !S.rootPub || d.root!==S.rootPub || !Number.isInteger(d.epoch)) return;
  const mine=S.epoch||0;
  if(!(d.epoch>mine || (d.epoch===mine && mine>0 && typeof d.pk==='string' && d.pk<signer.pub))) return;
  if(await verifyChain(d.root, d.chain, S.table)!==d.pk || d.chain.length!==d.epoch) return;
  const code=S.table, rootFp=S.rootFp || await fingerprint(S.rootPub);
  clearTimeout(timer); LS.del('pp-host-'+code);
  isHost=false; S=null; signer=null; peers.clear(); hostPid=null; hostLost=true; view=null; introduced.clear();
  hostFp=rootFp; LS.set('ot-hk-'+code, hostFp); hostEpoch=0;
  netSend({t:'hello',...publicHello()}, pid);
  toast('Another player is hosting this table now, so you rejoined as a player', 5000);
  render();
}
// Heartbeat: every host beacons (also over Wi-Fi links) so players notice a vanished host within seconds,
// instead of waiting for the connection to time out.
setInterval(()=>{ if(isHost && S && (net || links.size)) netSend({ t:'beacon', epoch:S.epoch||0, chain:S.chain||[], root:S.rootPub, pk:signer?.pub }); }, HEARTBEAT_MS);
setInterval(()=>{
  if(isHost || !hostPid || hostLost || !view || !lastHeard) return;
  if(Date.now()-lastHeard>SILENCE_MS){ hostLost=true; armTakeover(); render(); }
}, 1000);
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
  if(isHost) return d && d.t==='beacon' ? onBeacon(d, pid) : handle(d, pid);
  if(pid===hostPid) lastHeard=Date.now();
  if(d.t==='state'){
    // in order, one at a time: only states signed by this table's host get through
    verifyQ=verifyQ.then(async()=>{
      const v=await verifiedState(d).catch(()=>null); if(!v || replaced || isHost) return;
      if(hostPid && pid!==hostPid && !hostLost && v.epoch<=hostEpoch) return;   // someone else claiming to host
      hostEpoch=v.epoch; hostPid=pid; hostLost=false; joinIssue=''; clearTimeout(bk.timer); bk.timer=null; lastHeard=Date.now();
      if(!introduced.has(pid)){ introduced.add(pid); netSend({t:'hello',...helloData()}, pid); }
      setView(v);
    });
  } else if(d.t==='emote' && pid===hostPid) floatEmote(d.seat, d.e);
  else if(d.t==='ended' && pid===hostPid){ ended=true; view=null; hostLost=true; render(); toast('The host closed the table',4000); }
  else if(d.t==='snap' && pid===hostPid && !hostLost){ bk.snap=d.s; bk.chain=d.chain; bk.root=d.root; bk.at=Date.now(); }
  else if(d.t==='vmuted' && pid===hostPid) mutedBy(d.by);
  else if(d.t==='replaced' && pid===hostPid){ replaced=true; view=null; hostLost=true; render(); }
}

// ------------------------------ host ------------------------------
const tourOn = () => S.mode==='tourney' && S.tour;
const tourLive = () => tourOn() && S.tour.started && !S.tour.finished;
function note(text, sound){ S.note={ n:(S.note?.n||0)+1, text, sound }; }
// Guest input is untrusted: tokens are opaque ids (never object keys like __proto__), avatars come from the
// picker, names are plain text and unique at the table.
const cleanToken = t => { t=String(t||''); return /^[\w-]{8,64}$/.test(t) && !(t in Object.prototype) ? t : ''; };
const cleanName = n => String(n||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,14) || 'player';
const cleanAv = a => normAv(String(a||'').slice(0,8));
function uniqueName(name, self){
  const taken=new Set(S.seats.filter(s=>s&&s!==self).map(s=>s.name));
  for(let k=2, n=name; ; k++){ if(!taken.has(n)) return n; n=name.slice(0,13-String(k).length)+' '+k; }
}
const emoteTimes=new Map();     // seat -> recent emote times, to stop reaction spam

// Remove a player for good. Cash: chips go to the ledger. Tournament in progress: they forfeit and take the next place.
function dropSeat(i){
  const s=S.seats[i]; if(!s) return;
  if(tourLive()){
    S.tour.places.push({name:s.name,av:s.av,token:s.token,place:nextPlace(S)}); S.tour.places.sort((a,b)=>a.place-b.place);
    removeSeat(S,i);
    if(S.seats.filter(x=>x&&x.stack>0).length<=1 && !isActive(S)) finishTour();
    return;
  }
  const cash=removeSeat(S,i);
  if(!s.bot && Object.hasOwn(S.ledger,s.token)) S.ledger[s.token].out+=cash;
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
    case 'bkey': issueCert(pid, d.pub); return;
    case 'hello': {
      const name=cleanName(d.name), av=cleanAv(d.av), token=cleanToken(d.token)||peers.get(pid)?.token||'';
      peers.set(pid,{token,name,av});
      if(token) for(const s of S.seats) if(s&&!s.bot&&s.token===token){
        // the same player opened the table again (new tab or device): the old connection steps aside
        if(s.pid && s.pid!==pid && s.pid!==myPid() && peers.has(s.pid)){ netSend({t:'replaced'}, s.pid); peers.delete(s.pid); }
        s.pid=pid; s.connected=true; s.name=uniqueName(name,s); s.av=av;
        if(Object.hasOwn(S.ledger,token)) S.ledger[token].name=s.name;
      }
      S.seq++; break;
    }
    case 'sit': {
      const k=d.seat|0; if(i>=0 || k<0 || k>=MAXS || S.seats[k]) return;
      if(tourOn() && S.tour.started) return;                       // no late entries
      const p = host ? {token:me.token,name:me.name||'host',av:me.av} : peers.get(pid);
      if(!p || !p.token) return;
      if(S.seats.some(s=>s&&!s.bot&&s.token===p.token)) return;
      const stack = tourOn() ? S.tour.stack : S.buyIn, name=uniqueName(p.name);
      S.seats[k]=mkSeat({...p, name, pid, stack});
      if(!tourOn()){ const L=Object.hasOwn(S.ledger,p.token) ? S.ledger[p.token] : (S.ledger[p.token]={name,buy:0,out:0}); L.name=name; L.buy+=stack; }
      note(`${name} sat down`,'join');
      S.seq++; break;
    }
    case 'act': if(i<0 || !applyAction(S,i,String(d.a),d.amt)) return; S.seq++; break;
    case 'emote': { if(i<0 || !EMOTES.includes(d.e)) return;
      const now=Date.now(), recent=(emoteTimes.get(i)||[]).filter(t=>now-t<4000);
      if(recent.length>=3) return;                                   // at most 3 reactions per 4 seconds
      emoteTimes.set(i,[...recent,now]); broadcastEmote(i,d.e); return; }
    case 'rebuy': { const s=S.seats[i]; if(i<0||tourOn()||s.stack>0||s.inHand&&isActive(S)) return;
      s.stack=S.buyIn; if(Object.hasOwn(S.ledger,s.token)) S.ledger[s.token].buy+=S.buyIn; S.seq++; break; }
    case 'sitout': { if(i<0 || tourOn()) return; S.seats[i].sittingOut=!!d.on; S.seq++; break; }
    case 'stand': if(i<0) return; dropSeat(i); S.seq++; break;
    case 'show': {   // reveal your cards to everyone when the hand ends (folded players, uncalled winners)
      const s=S.seats[i]; if(i<0 || s.bot || !s.cards.length || S.results?.reveal?.[i]) return;
      if(d.on===false){ if(S.results || !s.show) return; s.show=false; S.seq++; break; }   // changed their mind before the hand ended
      if(s.show) return;
      s.show=true; if(S.results) logShown(i);
      S.seq++; break; }
    case 'addbot': { if(!host) return; const k=d.seat|0; if(k<0||k>=MAXS||S.seats[k]||tourOn()&&S.tour.started) return;
      const used=new Set(S.seats.filter(Boolean).map(s=>s.name)); const b=BOTS.find(b=>!used.has(b[0]))||['bot'+k,'a15'];
      S.seats[k]=mkSeat({token:'bot-'+k+'-'+Date.now(),pid:null,name:b[0],av:b[1],stack:tourOn()?S.tour.stack:S.buyIn,bot:true}); S.seq++; break; }
    case 'kick': { if(!host) return; const k=d.seat|0, s=S.seats[k]; if(!s||s.token===me.token) return; dropSeat(k); S.seq++; break; }
    case 'tstart': { if(!host||!tourOn()||S.tour.started) return;
      if(S.seats.filter(Boolean).length<2){ toast('Need at least 2 players'); return; }
      const T=S.tour; T.started=true; T.finished=false; T.level=0; T.places=[]; T.levelEnds=Date.now()+T.levelMs;
      T.entrants=S.seats.filter(Boolean).length;
      [S.sb,S.bb]=blindsFor(T.baseSb,0); S.dealer=-1; S.handNo=0; S.log=[];
      for(const s of S.seats) if(s) s.stack=T.stack;
      note('Shuffle up and deal!','level'); S.seq++; break; }
    case 'voiceopt': { if(!host) return; S.voiceOn=!!d.on;
      if(!S.voiceOn) for(const x of S.seats) if(x) x.voice=null;
      note(S.voiceOn ? 'Voice chat is on · tap the mic in your box to talk' : 'Voice chat is off');
      S.seq++; break; }
    case 'voice': { if(i<0 || d.on && !S.voiceOn) return; const s=S.seats[i], was=s.voice;
      const vid=String(d.vid||'').slice(0,16); if(!/^[a-z0-9]+$/.test(vid)) return;
      s.voice = d.on ? { vid, muted:!!d.muted, forced:!!(was?.forced && d.muted), guardUntil:was?.guardUntil||0 } : null;
      // muted by someone else, then unmuted themselves: nobody can mute them again for a while
      if(s.voice && was?.forced && !d.muted) s.voice.guardUntil=Date.now()+VOICE_GUARD_MS;
      S.seq++; break; }
    case 'vmute': { const k=d.seat|0, s=S.seats[k]; if(!S.voiceOn || i<0 || k===i || !s?.voice || s.voice.muted || s.voice.guardUntil>Date.now()) return;
      s.voice.muted=true; s.voice.forced=true;
      const by=S.seats[i].name;
      if(s.pid===myPid()) setTimeout(()=>mutedBy(by)); else netSend({t:'vmuted',by}, s.pid);
      S.seq++; break; }
    case 'cstart': { if(!host||tourOn()||S.started) return;
      if(S.seats.filter(Boolean).length<2){ toast('Need at least 2 players'); return; }
      S.started=true; S.seq++; break; }
    case 'treset': { if(!host||!tourOn()||!S.tour.finished) return;
      Object.assign(S.tour,{started:false,finished:false,level:0,places:[]}); delete S.tour.entrants; [S.sb,S.bb]=blindsFor(S.tour.baseSb,0);
      S.street='idle'; S.results=null; S.board=[];
      for(const s of S.seats) if(s) s.stack=S.tour.stack;
      S.seq++; break; }
    default: return;
  }
  hostSync();
}

// add a voluntarily shown hand to the hand history entry it belongs to
function logShown(i){
  const s=S.seats[i], L=S.log?.[0];
  if(!s || !L || L.n!==S.handNo || L.shown.some(x=>x.name===s.name)) return;
  L.shown.push({ name:s.name, cards:[...s.cards], hand:handName(bestOf([...s.cards,...S.board]))+' (shown)' });
}
function nextHand(){
  S.seats.forEach((s,i)=>{ if(s&&s.show) logShown(i); });
  for(let i=0;i<MAXS;i++){ const s=S.seats[i]; if(!s) continue;
    if(s.leaving){ dropSeat(i); continue; }
    if(!tourOn() && s.bot && s.stack===0) s.stack=S.buyIn; }
  S.street='idle'; S.results=null;
  if(!tourOn() && !S.started) return;
  if(tourOn()){
    if(!S.tour.started || S.tour.finished) return;
    const out=tourSettle(S);
    if(out.length) note(`${out.join(' & ')} ${out.length>1?'are':'is'} out`,'bust');
    if(S.tour.finished){ const w=S.tour.places.find(p=>p.place===1); note(w?`🏆 ${w.name} wins the tournament!`:'Tournament over','win'); return; }
    if(tourLevelUp(S, Date.now())) note(`Blinds up: ${fmt(S.sb)} / ${fmt(S.bb)}`,'level');
  }
  if(graceWaiting()) return;            // schedule() deals once everyone is back (or the grace runs out)
  startHand(S);
}

function schedule(){
  if(S.seq===armedSeq) return; armedSeq=S.seq; clearTimeout(timer); S.turnEnd=0;
  const bump = fn => () => { fn(); S.seq++; hostSync(); };
  if(S.street==='idle'){
    if(tourOn() ? (!S.tour.started || S.tour.finished) : !S.started) return;   // the host starts the game
    // just reopened: give players a moment to reconnect before dealing them out
    if(graceWaiting()){ timer=setTimeout(bump(()=>{}), Math.min(2000, S.graceUntil-Date.now())); return; }
    timer=setTimeout(bump(nextHand), 1600); return; }
  if(S.street==='showdown'){ const shown=Object.keys(S.results?.reveal||{}).length; timer=setTimeout(bump(nextHand), shown?6000:3200); return; }
  if(S.runout){ timer=setTimeout(bump(()=>endRound(S)), 1500); return; }
  if(S.toAct>=0){
    const i=S.toAct, s=S.seats[i];
    if(s.bot){ timer=setTimeout(bump(()=>{ const [a,amt]=botMove(S,i); applyAction(S,i,a,amt); }), 800+Math.random()*1400); return; }
    const grace=(S.graceUntil||0)-Date.now();
    const ms = s.connected && !s.leaving ? TURN_MS : Math.max(3500, grace);   // reconnecting players aren't auto-folded
    S.turnEnd=Date.now()+ms; S.turnTotal=ms;
    timer=setTimeout(bump(()=>{ const t=S.seats[i]; if(t && S.toAct===i) applyAction(S,i,S.curBet>t.bet?'fold':'check'); }), ms);
  }
}

function viewFor(pid){
  const mySeat=S.seats.findIndex(s=>s&&s.pid===pid);
  const R=S.results, T=S.tour;
  const seats=S.seats.map((s,i)=>s&&{
    name:s.name, av:s.av, stack:s.stack, bet:s.bet, folded:s.folded, allIn:s.allIn, inHand:s.inHand, bot:s.bot,
    connected:s.connected||s.bot, leaving:s.leaving, last:s.last, acts:s.acts||0, noReraise:s.noReraise, sittingOut:!!s.sittingOut,
    cards: i===mySeat ? [...s.cards] : (R&&R.reveal[i]) ? R.reveal[i] : (R&&s.show&&s.cards.length) ? s.cards : (s.inHand&&!s.folded&&s.cards.length ? ['back','back'] : null),
    voice: s.voice ? { vid:s.voice.vid, muted:s.voice.muted, guard:Math.max(0,(s.voice.guardUntil||0)-Date.now()) } : null,
    show:!!s.show, shownHand: R&&s.show&&!R.reveal[i]&&s.cards.length ? handName(bestOf([...s.cards,...S.board])) : '',
  });
  // mid-hand, chips a player has bet are still theirs until the hand is settled
  const ledger=Object.entries(S.ledger).map(([tok,L])=>{ const s=S.seats.find(x=>x&&x.token===tok);
    return {name:L.name, buy:L.buy, net:L.out+(s?s.stack+(isActive(S)?s.total:0):0)-L.buy, seated:!!s}; });
  const myToken = pid===myPid() ? me.token : peers.get(pid)?.token;
  // board is copied: the host's own previous view must not change when the engine deals the next card
  return { table:S.table, mode:S.mode, sb:S.sb, bb:S.bb, buyIn:S.buyIn, minBuy:S.minBuy, seats, dealer:S.dealer, board:[...S.board],
    pot:potTotal(S), street:S.street, toAct:S.toAct, curBet:S.curBet, minRaise:S.minRaise,
    turnLeft:S.turnEnd?Math.max(0,S.turnEnd-Date.now()):0, turnTotal:S.turnTotal, mySeat, results:R, handNo:S.handNo, ledger,
    log:(S.log||[]).slice(0,15), note:S.note||null, started:!!S.started, voiceOn:!!S.voiceOn,
    tour: T && { started:T.started, finished:T.finished, level:T.level, stack:T.stack, levelMs:T.levelMs,
      levelLeft:T.started&&!T.finished&&T.level<MAX_LEVEL?Math.max(0,T.levelEnds-Date.now()):0, finalLevel:T.level>=MAX_LEVEL,
      next:blindsFor(T.baseSb,T.level+1), places:T.places.map(({name,av,place})=>({name,av,place})),
      myPlace:(T.places.find(p=>p.token===myToken)||{}).place||0 },
    isHost: pid===myPid(), backupYou: !!S.backup && S.backup.pid===pid };
}
let closed=false;
function saveHost(){ if(!isHost || !S || closed) return; S.savedAt=Date.now(); LS.set('pp-host-'+S.table, S); }
// keep the saved clock fresh, so reopening a tournament only adds back the time the table was really closed
setInterval(saveHost, 5000); addEventListener('pagehide', saveHost);
function hostSync(){
  schedule();
  saveHost();
  sendBackup();
  for(const pid of peers.keys()) sendState(pid, viewFor(pid));
  setView(viewFor(myPid()));
}
function broadcastEmote(seat,e){
  netSend({t:'emote',seat,e});
  floatEmote(seat,e);
}

// ------------------------------ voice ------------------------------
function sendVoice(){ send({t:'voice', on:voice.on, muted:voice.muted, vid:voice.vid}); }
// someone muted me for everyone: the mic goes off here, and I can turn it back on myself
function mutedBy(by){
  if(!voice.on || voice.muted) return;
  setMuted(true); sendVoice(); render(); buzz(20);
  toast(`${by} muted you · tap the mic to unmute`, 4000);
}
async function micTap(){
  if(!voice.on){
    try{ await joinVoice(); }
    catch(e){ toast(e?.name==='NotAllowedError' ? 'Microphone blocked: allow it in your browser settings' : 'Voice needs an internet connection', 4000); return; }
    play('tick'); sendVoice(); render(); toast('Voice on · tap the mic to mute'); return;
  }
  setMuted(!voice.muted); sendVoice(); render();
}
// speaking rings update in place, without a re-render
voice.onTalk = () => { for(const el of document.querySelectorAll('[data-vid]')) el.classList.toggle('talk', voice.talking.has(el.dataset.vid)); };
const vidAttr = vid => vid ? ` data-vid="${esc(vid)}"` : '';
const talkCls = vid => vid && voice.talking.has(vid) ? 'talk' : '';

// ------------------------------ client view ------------------------------
function setView(v){
  backupDuty(v);
  const prev=view; v.recvAt=performance.now(); view=v;
  if(voice.on){
    if(v.mySeat<0 || !v.voiceOn){ leaveVoice(); }                           // voice is for players at the table
    else if(!v.seats[v.mySeat].voice && performance.now()-(ui.vSent||0)>3000){ ui.vSent=performance.now(); setTimeout(sendVoice); }   // a new host doesn't know yet
  }
  const turnKey = v.handNo+':'+v.street+':'+v.toAct+':'+v.curBet;
  const myTurn = v.mySeat>=0 && v.toAct===v.mySeat && isActive(v);
  if(turnKey!==ui.lastTurnKey){ ui.lastTurnKey=turnKey; ui.raiseOpen=false; }
  const rk = v.results ? v.handNo+':'+v.results.summary : '';
  if(rk && rk!==ui.lastResultsKey) ui.lastResultsKey=rk;   // the result is shown on the table (see .why)
  if(v.note && v.note.n!==ui.noteN){ const fresh=prev&&ui.noteN; ui.noteN=v.note.n; if(fresh){ toast(v.note.text,3600); if(v.note.sound) play(v.note.sound); } }
  if(v.tour?.finished && !ui.finishedShown){ ui.finishedShown=true; setTimeout(standingsSheet, 900); }
  if(v.tour && !v.tour.finished) ui.finishedShown=false;
  cueSounds(prev, v, myTurn);
  liveAction(prev, v);
  runPre(v, myTurn);
  document.title = myTurn && document.hidden ? '● Your turn · OnTilt' : 'OnTilt';
  render(prev);
}
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) document.title='OnTilt'; });

// Live line under the pot: what the latest player just did ("lolaa raises to 40").
function liveAction(prev, v){
  if(!prev || v.handNo!==prev.handNo || v.board.length!==prev.board.length){ ui.live=null; }
  if(!prev || v.handNo!==prev.handNo) return;
  v.seats.forEach((s,i)=>{ const p=prev.seats[i];
    if(!s || !p || !s.last || (s.last===p.last && s.acts===p.acts)) return;
    const who = i===v.mySeat ? 'You' : esc(s.name), you=i===v.mySeat;
    const text = {
      Fold:`${who} fold${you?'':'s'}`, Check:`${who} check${you?'':'s'}`,
      Call:`${who} call${you?'':'s'} ${amt(s.bet-(p.bet||0))}`, Bet:`${who} bet${you?'':'s'} ${amt(s.bet)}`,
      Raise:`${who} raise${you?'':'s'} to ${amt(s.bet)}`, 'All in':`${who} ${you?'are':'is'} all in · ${amt(s.bet)}`,
    }[s.last];
    if(text) ui.live={ text, kind:s.last, key:v.handNo+':'+i+':'+s.acts };
  });
}

// Pre-actions: choose while others act; it fires when your turn comes if it still makes sense.
function runPre(v, myTurn){
  if(ui.pre && ui.pre.hand!==v.handNo) ui.pre=null;
  const m=v.mySeat>=0 && v.seats[v.mySeat];
  if(!ui.pre || !myTurn || !m || m.folded || m.allIn) return;
  const pre=ui.pre, toCall=v.curBet-m.bet; ui.pre=null;
  let a=null;
  if(pre.kind==='checkfold') a = toCall>0 ? 'fold' : 'check';
  else if(pre.kind==='fold') a = toCall>0 ? 'fold' : 'check';
  else if(pre.kind==='call') a = toCall===pre.amt ? 'call' : null;
  else if(pre.kind==='callany') a = 'call';
  if(!a){ toast('The bet changed, so your pre-call was cancelled'); return; }
  setTimeout(()=>{ if(view && view.toAct===view.mySeat && view.handNo===v.handNo) doAction(a); }, 350);
}

// Sounds follow what changed between two views, so host and guests hear the same thing.
function cueSounds(prev, v, myTurn){
  if(!prev) return;
  if(v.handNo!==prev.handNo && v.street==='preflop'){ play('deal'); setTimeout(()=>play('deal'),120); }
  else if(v.board.length>prev.board.length) play('flip');
  // a new action shows as a new label or a higher action count (calling twice in a round is still a call).
  // Your own taps already played their sound; actions the shot clock took for you haven't.
  if(v.handNo===prev.handNo) v.seats.forEach((s,i)=>{ const p=prev.seats[i];
    if(s && p && s.last && (s.last!==p.last || s.acts!==p.acts)){ const m={Fold:'fold',Check:'check',Call:'chip',Bet:'chips',Raise:'chips','All in':'allin'}[s.last];
      if(m && !(i===v.mySeat && ui.selfCue===v.handNo+':'+s.acts)) play(m); } });
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
// Landscape only: a portrait iPad (or any tall window) gets the phone layout, scaled up instead.
const deskMQ = matchMedia('(min-width:960px) and (min-height:560px) and (min-aspect-ratio:5/4)');
deskMQ.addEventListener('change', ()=>{ fitZoom(); render(); });

// Big screens using the phone layout (portrait tablets) scale the whole UI up so it fills the screen.
// The phone layout is designed around ~540×880; --z is how much bigger this screen is.
function fitZoom(){
  const big = !deskMQ.matches && innerWidth>=640;
  const z = big ? Math.max(1, Math.min(innerWidth/540, innerHeight/880, 1.8)) : 1;
  document.documentElement.style.setProperty('--z', z.toFixed(3));
  document.body.classList.toggle('zoomed', big);
}
fitZoom();
addEventListener('resize', fitZoom);
addEventListener('orientationchange', ()=>setTimeout(()=>{ fitZoom(); render(); }, 250));

let paintedScreen=null;
function render(prev){
  app.classList.toggle('wide', screen!=='lobby' && deskMQ.matches);
  app.classList.toggle('lobby-wide', screen==='lobby' && deskMQ.matches);
  app.classList.toggle('in-lobby', screen==='lobby');
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
// Logo mark: a spade card knocked off-square in front of a straight one. Same art as assets/favicon.svg,
// except the straight card is masked where the tilted one covers it, so no black edge shows on grey panels.
const LOGO = `<svg class="mark" viewBox="2 2.3 27.7 27" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eaf8e4"/><stop offset="1" stop-color="#8fd6ac"/></linearGradient></defs><rect x="4.5" y="7.5" width="13" height="19" rx="3" fill="#5c5c63" stroke="#000" stroke-width="1.6" transform="rotate(-10 11 17)"/><g transform="rotate(14 19.5 15.5)"><rect x="12.5" y="5.5" width="14" height="20" rx="3.2" fill="url(#lg)" stroke="#000" stroke-width="1.6"/><path d="M19.5 10.4c-2.3 2.3-4.3 3.7-4.3 5.7a2.3 2.3 0 0 0 3.8 1.7l-.9 2.6h2.8l-.9-2.6a2.3 2.3 0 0 0 3.8-1.7c0-2-2-3.4-4.3-5.7z" fill="#0b0b0c"/></g></svg>`;
const mmss = ms => { const s=Math.ceil(ms/1000); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
// blinds go up between hands, so once the clock runs out they rise when this hand ends
const lvlLeft = ms => ms>0 ? mmss(ms) : 'up next hand';
// big numbers get abbreviated where space is tight (seats, chips)
const amt = n => n>=1e5 ? short(n) : fmt(n);

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
  const avs=AVATARS.map(a=>`<button data-act="av" data-v="${a}" class="${a===me.av?'sel':''}" aria-label="Avatar ${a.slice(1)}">${avatarSVG(a)}</button>`).join('');
  const prof=`<div class="prof"><div class="nmrow"><input id="nm" placeholder="Your name" maxlength="14" autocomplete="off" value="${esc(me.name)}">
      <button class="dice" data-act="reroll" aria-label="Random name">${ICON.dice}</button></div><div class="avs">${avs}</div></div>`;
  if(lobby.mode==='create'){
    const tour=lobby.game==='tourney';
    const saved=savedTables();
    const savedHTML = `<div class="saved"><div class="saved-h"><span>Your tables</span></div>
      ${saved.map(t=>`<div class="srow"><button class="sgo" data-act="resume" data-v="${t.code}">
          <b>${t.mode==='tourney'?'Tournament':'Cash'} · ${fmt(t.sb)}/${fmt(t.bb)}</b>
          <span>${esc(t.players.slice(0,4).join(', ')||'No players')}${t.players.length>4?'…':''} · ${t.hands} hand${t.hands===1?'':'s'} · ${ago(t.at)}${t.done?' · finished':''}</span></button>
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
        <div class="ruler" id="ruler" role="slider" tabindex="0" aria-label="${tour?'Starting blinds':'Stakes'}" aria-valuemin="0" aria-valuemax="${STAKES.length-1}" aria-valuenow="${lobby.stake}" aria-valuetext="${sb} / ${bb}">${STAKES.map((_,i)=>`<i class="${i===lobby.stake?'sel':''}"></i>`).join('')}</div>
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
    const setStake=k=>{ k=Math.max(0,Math.min(STAKES.length-1,k)); if(k!==lobby.stake){ lobby.stake=k; readName(); renderLobby(); play('tick'); } };
    const pick=e=>{ const r=ruler.getBoundingClientRect(); setStake(Math.round((e.clientX-r.left)/r.width*(STAKES.length-1))); };
    ruler.onpointerdown=e=>{ ruler.setPointerCapture(e.pointerId); pick(e); ruler.onpointermove=pick; };
    ruler.onpointerup=()=>{ ruler.onpointermove=null; };
    ruler.onkeydown=e=>{ const d={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[e.key]; if(d){ e.preventDefault(); setStake(lobby.stake+d); } };
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


function renderTable(prev){
  const v=view;
  const T=v?.tour;
  let sub='';
  if(T && T.started && !T.finished) sub=`Level ${T.level+1} · ${fmt(v.sb)}/${fmt(v.bb)} · ${T.finalLevel?'final level':`<span data-lvl>${lvlLeft(T.levelLeft)}</span>`}`;
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
    const why = replaced ? `This table is open in another tab or device.<br><span class="sub">Keep playing there, or reload here to move back.</span>` : {
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
  syncOdds(v);
  const seated=v.mySeat>=0, anchor=seated?v.mySeat:0, mine=seated?v.seats[v.mySeat]:null;
  const active=isActive(v);
  const R=v.results;
  const maxStack=Math.max(0,...v.seats.filter(Boolean).map(s=>s.stack));

  // --- board
  const newCards = prev && prev.handNo===v.handNo ? prev.board.length : 0;
  // after a showdown, the five cards that won stay bright and everything else dims
  const mainW = R ? (R.pots?.[0]?.winners || Object.keys(R.won).map(Number)) : [];
  const lit = R && R.best && R.best[mainW[0]] ? new Set(R.best[mainW[0]]) : null;
  const litCls = c => lit && !lit.has(c) ? 'dimc' : '';
  const board=[0,1,2,3,4].map(k=>v.board[k] ? cardHTML(v.board[k], `${k>=newCards?'deal':''} ${litCls(v.board[k])}`, (k-newCards)*90) : cardHTML('back')).join('');   // undealt: face down, in the chosen back design
  let why='';
  if(R){
    const nm=i=>esc(v.seats[i]?.name||'Player');
    why = R.uncontested ? `${nm(mainW[0])} wins · everyone folded`
        : `${mainW.map(nm).join(' & ')} ${mainW.length>1?'split the pot with':'wins with'} ${esc(R.desc?.[mainW[0]]||R.hands?.[mainW[0]]||'')}`;
  }

  // --- controls
  const myTurn = seated && v.toAct===v.mySeat && active;
  let ctrl='', raisePanel='', betChip='';
  const wide = msg => `<div class="ctrl"><button class="btn wide" disabled>${msg}</button></div>`;
  if(mine && mine.bet>0) betChip=`<span class="chip" data-k="b${mine.bet}">${amt(mine.bet)}</span>`;
  if(R && seated && R.won[v.mySeat]) betChip=`<span class="chip win" data-k="w">+${amt(R.won[v.mySeat])}</span>`;
  const seatedN=v.seats.filter(Boolean).length;
  if(T && T.finished){
    ctrl = v.isHost ? `<div class="ctrl" style="grid-template-columns:1fr 1fr"><button class="btn on" data-act="standings">Standings</button><button class="btn solid" data-act="treset">Run it back</button></div>`
                    : `<div class="ctrl"><button class="btn on wide" data-act="standings">Final standings</button></div>`;
  } else if(T && !T.started){
    ctrl = v.isHost && seatedN>=2 ? `<div class="ctrl"><button class="btn solid wide" data-act="tstart">Start tournament · ${seatedN} players</button></div>`
         : wide(v.isHost ? 'Waiting for players · tap + to add bots' : seated ? 'Waiting for the host to start' : 'Tap + to take a seat');
  } else if(!T && !v.started){
    ctrl = v.isHost && seatedN>=2 ? `<div class="ctrl"><button class="btn solid wide" data-act="cstart">Start game · ${seatedN} players</button></div>`
         : wide(v.isHost ? 'Waiting for players · tap + to add bots' : seated ? 'Waiting for the host to start' : 'Tap + to take a seat');
  } else if(!seated){
    const full=v.seats.every(Boolean);
    ctrl = wide(T ? (T.myPlace ? `You finished #${T.myPlace} · watching` : 'Tournament running · watching') : full?'Table is full · watching':'Tap + to take a seat');
  } else if(mine.stack===0 && !(mine.inHand&&active) && !T){
    ctrl=`<div class="ctrl" style="grid-template-columns:1fr 1fr"><button class="btn on" data-act="rebuy">Rebuy ${short(v.buyIn)}</button><button class="btn on" data-act="stand">Stand up</button></div>`;
  } else if(R && mine.inHand && v.street==='showdown' && !R.reveal[v.mySeat] && mine.cards?.length){
    ctrl = mine.show ? wide('Cards shown') : `<div class="ctrl"><button class="btn on wide" data-act="show">Show your cards</button></div>`;
  } else if(mine.sittingOut && !(mine.inHand&&active)){
    ctrl=`<div class="ctrl"><button class="btn on wide" data-act="sitin">Sitting out · I’m back</button></div>`;
  } else if(!mine.inHand || !active){
    ctrl = wide(active?'Wait for the next hand': v.street==='showdown'?'Next hand…': seatedN>1? 'Starting…':'Waiting for players');
  } else {
    const toCall=v.curBet-mine.bet, maxTo=mine.bet+mine.stack;
    const minTo=Math.min(v.curBet+(v.curBet===0 ? v.bb : Math.max(v.minRaise, v.curBet)),maxTo),   // raises at least double the bet (engine.raiseInc)
           canRaise=maxTo>v.curBet && !mine.allIn && !mine.noReraise;
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
    if(!myTurn && !mine.folded && !mine.allIn){
      // not your turn yet: pick what to do in advance
      const sel=k=>ui.pre?.kind===k?'sel':'';
      const opts = toCall>0
        ? [['fold','Fold'],['call',toCall>=mine.stack?`Call all in`:`Call ${fmt(toCall)}`],['callany','Call any']]
        : [['checkfold','Check / Fold'],['callany','Call any']];
      html=opts.map(([k,l])=>`<button class="btn pre ${sel(k)}" data-act="pre" data-v="${k}" data-amt="${k==='call'?toCall:''}" aria-pressed="${!!sel(k)}">${l}</button>`).join('');
      ctrl=`<div class="ctrl" style="grid-template-columns:${opts.length>2?'1fr 1.1fr 1fr':'1fr 1fr'}">${html}</div>`;
    }
    else if(mine.folded) ctrl=`<div class="ctrl"><button class="btn pre wide ${mine.show?'sel':''}" data-act="showToggle" aria-pressed="${!!mine.show}">${mine.show?'Showing your cards at the end':'Show cards at the end'}</button></div>`;
    else if(mine.allIn){ ctrl=wide('All in'); }
    else ctrl=`<div class="ctrl" style="grid-template-columns:${cols.join(' ')}">${html}</div>`;

    if(myTurn && ui.raiseOpen && canRaise && minTo<maxTo){
      if(ui.raiseTo<minTo||ui.raiseTo>maxTo) ui.raiseTo=minTo;
      // pot-sized raises, rounded to the small blind
      const unit=x=>Math.round(x/v.sb)*v.sb;
      const half=Math.min(maxTo,Math.max(minTo,unit(v.curBet+(v.pot+toCall)/2)));
      const full=Math.min(maxTo,Math.max(minTo,unit(v.curBet+v.pot+toCall)));
      raiseStops_=raiseStops(minTo,maxTo,v.sb,[half,full]);
      ui.raiseTo=raiseStops_.reduce((a,b)=>Math.abs(b-ui.raiseTo)<Math.abs(a-ui.raiseTo)?b:a);
      const k=raiseStops_.indexOf(ui.raiseTo), sel=x=>x===ui.raiseTo?'sel':'';
      // a tick ruler like the lobby's stake picker: one tick per stop, pot presets taller, all-in red
      raisePanel=`<div class="raise"><span class="amt"><small>Raise to</small><b id="ramt">${fmt(ui.raiseTo)}</b></span>
        <div class="rruler" id="rr" role="slider" tabindex="0" aria-label="Raise amount" aria-valuemin="${minTo}" aria-valuemax="${maxTo}" aria-valuenow="${ui.raiseTo}" aria-valuetext="${fmt(ui.raiseTo)}">${
          raiseStops_.map((x,i)=>`<i class="${i<k?'on':i===k?'sel':''} ${x===half||x===full?'key':''}"></i>`).join('')}</div>
        <button class="go" data-act="raiseGo" aria-label="Raise">${ICON.up}</button></div>`;
      ctrl=`<div class="ctrl" style="grid-template-columns:1fr 1fr 1fr .55fr">
        <button class="btn on ${sel(half)}" data-act="preset" data-v="${half}">½ Pot</button>
        <button class="btn on ${sel(full)}" data-act="preset" data-v="${full}">Pot</button>
        <button class="btn on ${sel(maxTo)}" data-act="preset" data-v="${maxTo}">All in</button>
        <button class="btn on" data-act="raiseClose" aria-label="Close">${ICON.x}</button></div>`;
    }
  }

  // --- bottom row (me / anchor seat)
  const a=v.seats[anchor];
  const holeCards = mine && mine.cards && mine.cards.length ? mine.cards : null;
  const holeNew = holeCards && (!prev || prev.handNo!==v.handNo);
  const hidden = holeCards && ui.hide;
  const hole = hidden ? cardHTML('back','hid')+cardHTML('back','hid')
             : holeCards && lit ? holeCards.map(c=>cardHTML(c, litCls(c))).join('')
             : holeCards ? holeCards.map((c,k)=>cardHTML(c, holeNew?'deal':'', k*120)).join('')
             : (!seated && a && a.cards) ? a.cards.map(c=>cardHTML(c)).join('') : cardHTML(null,'slot')+cardHTML(null,'slot');   // no cards yet: outlines, like the board
  let hn='';
  if(seated && holeCards){ hn = hidden ? 'Hidden' : R&&R.hands[v.mySeat] ? R.hands[v.mySeat] : mine.shownHand || handName(bestOf([...holeCards,...v.board])); }
  else if(!seated && a && R && R.hands[anchor]) hn=R.hands[anchor];
  const handTurn = v.toAct===anchor && active;
  let box;
  if(a){
    box=`<div class="hand ${handTurn?'turn':''}" ${handTurn&&v.turnLeft?'data-timer':''} data-seat-av="${anchor}">
      ${seated && hn && !hidden ? `<button class="hn hnb ${hn.length>11?'long':''}" data-act="ranks" aria-label="${esc(hn)} · see hand rankings">${esc(hn)}</button>` : `<div class="hn">${esc(hn)}</div>`}
      ${seated?`<button class="av ${voice.on?talkCls(voice.vid):''}"${voice.on?vidAttr(voice.vid):''} data-act="odds" aria-label="Your odds">`:'<div class="av">'}${avatarSVG(a.av)}${v.dealer===anchor&&v.handNo?'<b class="d">D</b>':''}${seated?'</button>':'</div>'}
      ${seated && ui.odds.open ? oddsHTML() : ''}
      <div class="st">${a.stack>=1e6?short(a.stack):fmt(a.stack)}</div>
      ${seated?`<button class="smile" data-act="emote" aria-label="Reactions">${ICON.smile}</button><button class="rkbtn" data-act="ranks" aria-label="Hand rankings">${ICON.ranks}</button>
        ${v.voiceOn?`<button class="mic ${voice.on?(voice.muted?'off':'live'):''}" data-act="mic" aria-label="${!voice.on?'Join voice chat':voice.muted?'Unmute your mic':'Mute your mic'}" aria-pressed="${voice.on&&!voice.muted}">${voice.on&&!voice.muted?ICON.mic:ICON.micOff}</button>`:''}`:''}</div>`;
  } else {
    box=`<div class="hand"><div class="hn">Open seat</div><button class="plus" data-k="plus" data-act="sit" data-i="${anchor}" ${seated?'disabled':''}></button><div class="hn"></div></div>`;
  }
  const flung = mine && mine.folded && ui.flung===v.handNo;   // swiped away: thrown briefly, then settles back as the folded silhouette
  const holeEl=`<div class="hole ${mine&&mine.folded?'folded':''} ${flung?'flung':''} ${holeCards?'mine':''}" id="hole"${holeCards?
    ` role="button" tabindex="0" aria-label="Your cards: ${hidden?'hidden, press to show':esc(holeCards.join(' '))+', press to hide'}"`:''}>${hole}</div>`;
  const swipeFold = myTurn && mine && !mine.folded && !mine.allIn && holeCards;
  const meRow=`<div class="me">${holeEl}${box}</div>`;

  const banner = hostLost ? `<div class="banner">${bk.timer && bk.armedAt ? 'The host disconnected · you’ll take over hosting in a few seconds if they don’t return' : 'Lost connection to host… waiting'}</div>` : '';
  const emo = ui.emoteOpen ? `<div class="shade" data-act="emoteClose"></div><div class="emobar">${EMOTES.map(e=>`<button data-act="em" data-v="${e}">${e}</button>`).join('')}</div>` : '';
  const liveTxt = !why && active && ui.live ? `<span class="live ${/Raise|Bet|All in/.test(ui.live.kind)?'hot':''}" data-k="${ui.live.key}">${ui.live.text}</span>` : '';
  const potHTML = `<div class="pot">${v.pot>0||active?fmt(v.pot):''}</div><div class="why">${why||liveTxt}</div>`;

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

  bindRaise();
  bindHole(!!swipeFold);
}

// Raise ruler: drag or tap to snap between stops; updates in place so the drag isn't re-rendered under the finger.
let raiseStops_=[];
function setRaise(k){
  const rr=document.getElementById('rr'); if(!rr) return;
  k=Math.max(0,Math.min(raiseStops_.length-1,k)); const x=raiseStops_[k]; if(x===ui.raiseTo) return;
  ui.raiseTo=x; play('tick');
  [...rr.children].forEach((t,i)=>{ t.classList.toggle('on',i<k); t.classList.toggle('sel',i===k); });
  rr.setAttribute('aria-valuenow',x); document.getElementById('ramt').textContent=fmt(x);
  app.querySelectorAll('[data-act=preset]').forEach(b=>b.classList.toggle('sel',+b.dataset.v===x));
}
function stepRaise(d){ setRaise(raiseStops_.indexOf(ui.raiseTo)+d); }
function bindRaise(){
  const rr=document.getElementById('rr'); if(!rr) return;
  const pick=e=>{ const r=rr.getBoundingClientRect(); setRaise(Math.round((e.clientX-r.left)/r.width*(raiseStops_.length-1))); };
  rr.onpointerdown=e=>{ rr.setPointerCapture(e.pointerId); pick(e); rr.onpointermove=pick; };
  rr.onpointerup=rr.onpointercancel=()=>{ rr.onpointermove=null; };
}

// ------------------------------ odds ------------------------------
// Tap your avatar: Monte Carlo over the unseen turn/river and the hands of everyone still in.
// Runs in small chunks so the table stays smooth, refreshing as the numbers settle.
const ODDS_ITERS=4000, ODDS_CHUNK=250;
function oddsKey(v){
  const me=v.seats[v.mySeat], opp=v.seats.filter((s,i)=>s&&i!==v.mySeat&&s.inHand&&!s.folded).length;
  return [v.handNo, me.cards.join(''), v.board.join(''), opp].join('|');
}
function syncOdds(v){
  const me=v && v.mySeat>=0 && v.seats[v.mySeat];
  if(!ui.odds.open) return;
  if(!me || !me.cards?.length || me.folded || !me.inHand || !isActive(v)){ ui.odds.open=false; return; }
  const key=oddsKey(v); if(ui.odds.key===key) return;
  const token=++ui.odds.token, hole=[...me.cards], board=[...v.board], opp=+key.split('|')[3];
  Object.assign(ui.odds, { key, res:null });
  const acc={ iters:0, win:0, tie:0, cats:Array(9).fill(0), opp };
  const step=()=>{
    if(token!==ui.odds.token || !ui.odds.open) return;
    const r=equity(hole, board, opp, ODDS_CHUNK);
    acc.iters+=r.iters; acc.win+=r.win; acc.tie+=r.tie; r.cats.forEach((c,k)=>acc.cats[k]+=c);
    if(acc.iters%1000===0 || acc.iters>=ODDS_ITERS){ ui.odds.res={...acc, cats:[...acc.cats]}; render(); }
    if(acc.iters<ODDS_ITERS) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
function oddsHTML(){
  const r=ui.odds.res;
  if(!r) return `<div class="odds" data-act="odds"><div class="spin"></div></div>`;
  const pct=x=>Math.round(x/r.iters*100);
  const top=r.cats.map((c,k)=>[k,c]).filter(([,c])=>c/r.iters>=.01).sort((a,b)=>b[1]-a[1]).slice(0,3);
  return `<div class="odds" data-act="odds">
    <b>${pct(r.win)}%</b><span class="vs">to win${r.opp?` vs ${r.opp} player${r.opp>1?'s':''}`:''}${pct(r.tie)>=1?` · split ${pct(r.tie)}%`:''}</span>
    <ul>${top.map(([k,c])=>`<li><span>${HAND_NAMES[k]}</span><i>${pct(c)}%</i></li>`).join('')}</ul>
  </div>`;
}

function seatHTML(v,i,seated,maxStack){
  const s=v.seats[i], R=v.results, active=isActive(v);
  const canSit = !(v.tour && v.tour.started) && (!seated || v.isHost);
  if(!s) return `<div class="seat empty"><div class="pie-wrap"></div>
    <button class="plus" data-k="plus" data-act="sit" data-i="${i}" ${canSit?'':'disabled'} aria-label="Sit here"></button>
    <div class="nm">&nbsp;</div><div class="st">&nbsp;</div><div class="under"></div></div>`;
  const dim = ((active&&(!s.inHand||s.folded)) || (!s.connected) || (R&&s.inHand&&s.folded)) && !(R&&s.show);
  let under='';
  const shown = R && (R.reveal[i] || (s.show && s.cards && s.cards[0]!=='back' ? s.cards : null));
  const lit = R && R.best && R.best[(R.pots?.[0]?.winners||[])[0]] ? new Set(R.best[R.pots[0].winners[0]]) : null;
  // shown cards with winnings: the chip sits on the cards so the pair fits the seat's column
  if(shown) under = `<div class="rv"><div class="rvc shown">${shown.map(c=>cardHTML(c,`mini ${lit&&!lit.has(c)?'dimc':''}`)).join('')}${R.won[i]?`<span class="chip win over" data-k="w">+${short(R.won[i])}</span>`:''}</div>
      <div class="shand ${R.won[i]?'w':''}">${esc(R.hands[i] || (s.shownHand ? s.shownHand+' · shown' : ''))}</div></div>`;
  else if(R && R.won[i]) under=`<span class="chip win" data-k="w">+${amt(R.won[i])}</span>`;
  else if(active && (s.bet>0 || s.allIn || s.last==='Check')){
    // what they did this round, popping in again on every new action, above their bet
    const tag = { Raise:'RAISE', Bet:'BET', Call:'CALL', 'All in':'ALL IN', Check:'CHECK', SB:'SB', BB:'BB' }[s.allIn ? 'All in' : s.last] || '';
    const hot = /RAISE|BET|ALL IN/.test(tag);
    under=`<div class="act-col">${tag?`<span class="tag ${hot?'':'cool'}" data-k="t${s.acts||0}${tag}">${tag}</span>`:''}${s.bet>0?`<span class="chip" data-k="b${s.bet}">${amt(s.bet)}</span>`:''}</div>`;
  }
  const turn = v.toAct===i && active;
  return `<div class="seat ${dim?'dim':''} ${turn?'turn':''}">
    <div class="pie-wrap">${turn?'<div class="pie" data-timer></div>':''}</div>
    <button class="av ${talkCls(s.voice?.vid)}"${vidAttr(s.voice?.vid)} data-k="av${esc(s.name)}" data-act="seatTap" data-i="${i}" data-seat-av="${i}" aria-label="${esc(s.name)}, ${fmt(s.stack)} chips${s.bot?', bot':''}${!s.connected?', disconnected':''}${s.voice?(s.voice.muted?', mic muted':', in voice'):''}">${avatarSVG(s.av)}${s.voice?`<span class="vb ${s.voice.muted||voice.silenced.has(s.voice.vid)?'off':''}">${s.voice.muted||voice.silenced.has(s.voice.vid)?ICON.micOff:ICON.mic}</span>`:''}${v.dealer===i&&v.handNo?'<b class="d">D</b>':''}</button>
    <div class="nm">${esc(s.name)}</div><div class="st">${amt(s.stack)}</div>
    <div class="under">${under}</div></div>`;
}

// Your cards: tap to hide/peek, swipe up to fold (any time it's your turn).
// Drag state lives outside the element so a re-render mid-swipe doesn't lose the gesture.
const drag={ on:false, y0:0, x0:0, dy:0, t0:0, moved:false };
const FOLD_PX=60;
function dragLook(h){
  h.classList.toggle('drag', drag.on);
  h.style.transform = drag.on && drag.dy ? `translateY(${-drag.dy}px) rotate(${-drag.dy/40}deg)` : '';
  h.style.opacity = drag.on && drag.dy ? String(1-Math.min(drag.dy/180,.7)) : '';
}
function bindHole(canFold){
  const h=document.getElementById('hole');
  if(!h || !h.classList.contains('mine')){ if(h){ h.onpointerdown=h.onpointermove=h.onpointerup=h.onpointercancel=null; } drag.on=false; return; }
  if(drag.on) dragLook(h);          // the re-render reset our inline styles; put the drag back
  h.onpointerdown=e=>{
    Object.assign(drag,{ on:true, y0:e.clientY, x0:e.clientX, dy:0, t0:performance.now(), moved:false });
    try{ h.setPointerCapture(e.pointerId); }catch{}
    dragLook(h);
  };
  h.onpointermove=e=>{
    if(!drag.on) return;
    const up=drag.y0-e.clientY;
    if(Math.abs(up)>8 || Math.abs(e.clientX-drag.x0)>8) drag.moved=true;
    // can fold: cards follow your finger; can't: a small rubber-band so the gesture still feels alive
    drag.dy = canFold ? Math.max(0,up) : Math.min(18, Math.max(0,up)*.2);
    dragLook(h);
  };
  h.onpointerup=h.onpointercancel=e=>{
    if(!drag.on) return;
    const { dy, moved, t0 }=drag; drag.on=false; drag.dy=0;
    if(canFold && dy>FOLD_PX && e.type==='pointerup'){ h.classList.remove('drag'); h.classList.add('flung'); const hn=ui.flung=view.handNo; doAction('fold');
      setTimeout(()=>{ if(ui.flung===hn){ ui.flung=null; render(); } }, 450); return; }
    dragLook(h);
    if(e.type==='pointerup' && !moved && performance.now()-t0<450) toggleHide();
  };
}
function toggleHide(){ ui.hide=!ui.hide; LS.set('ot-hide',ui.hide); play('flip'); render(); }

// timers (pie + border) animate locally from the host's "time left"; the level clock ticks once a second
let lastSec=-1;
(function tick(){
  if(view){
    const el=performance.now()-view.recvAt;
    if(view.turnLeft>0){
      const left=Math.max(0,view.turnLeft-el), p=(left/view.turnTotal).toFixed(4);
      document.querySelectorAll('[data-timer]').forEach(e=>e.style.setProperty('--p',p));
      // warn once when your own shot clock is about to run out
      if(left<=5000 && left>0 && view.turnTotal>5000 && view.toAct===view.mySeat && view.mySeat>=0 && ui.warned!==ui.lastTurnKey){ ui.warned=ui.lastTurnKey; play('warn'); }
    }
    if(view.tour?.levelLeft){ const sec=Math.ceil(Math.max(0,view.tour.levelLeft-el)/1000);
      if(sec!==lastSec){ lastSec=sec; const n=document.querySelector('[data-lvl]'); if(n) n.textContent=lvlLeft(sec*1000); } }
  }
  requestAnimationFrame(tick);
})();

function floatEmote(seat,e){
  play('emote',e);
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
let sheetN=0;
function sheet(title, text, buttons, cls=''){
  const bg=document.createElement('div'); bg.className='sheet-bg'; const id='sh'+(++sheetN);
  bg.opener=document.activeElement;
  bg.innerHTML=`<div class="sheet ${cls}" role="dialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1"><h3 id="${id}">${esc(title)}</h3>${text?`<div class="sheet-body">${text}</div>`:''}${buttons.map((b,k)=>`<button class="sb ${b.cls||''}" data-k="${k}">${esc(b.label)}</button>`).join('')}
    <button class="sb" data-k="x" style="background:transparent;color:var(--mut)">Close</button></div>`;
  bg.onclick=e=>{ const t=e.target.closest('[data-k]'), k=t?.dataset.k; if(e.target===bg||k==='x'){ closeSheet(bg); return; }
    if(k!=null){ closeSheet(bg); buttons[+k].fn?.(); } };
  // keep Tab inside the sheet while it's open
  bg.addEventListener('keydown', e=>{ if(e.key!=='Tab') return;
    const f=[...bg.querySelectorAll('button:not(:disabled),[href],input,[tabindex]:not([tabindex="-1"])')]; if(!f.length) return;
    const first=f[0], last=f[f.length-1];
    if(e.shiftKey && (document.activeElement===first || !bg.contains(document.activeElement))){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); } });
  document.body.appendChild(bg);
  bg.querySelector('.sheet').focus({preventScroll:true});
  return bg;
}
function closeSheet(bg){ if(bg.classList.contains('closing')) return; bg.classList.add('closing'); bg.onClose?.(); setTimeout(()=>bg.remove(),180);
  const o=bg.opener; if(o && o.isConnected && o!==document.body && !document.querySelector('.sheet-bg:not(.closing)')) o.focus({preventScroll:true}); }
// The invite carries the host key's fingerprint (#1234567.<fp>) so guests can tell the real host apart.
function inviteUrl(){ const fp=isHost||screen==='lobby' ? (S?.rootFp || lobbyKey?.fp) : hostFp; return location.origin+location.pathname+'#'+(tableCode||lobby.code)+(fp?'.'+fp:''); }
async function shareInvite(){
  const url=inviteUrl();
  if(navigator.share){ try{ await navigator.share({title:'OnTilt',text:`Join my OnTilt poker table`,url}); return; }catch(e){ if(e.name==='AbortError') return; } }
  copyInvite();
}
async function copyInvite(){
  await lobbyKeyP;
  try{ await navigator.clipboard.writeText(inviteUrl()); toast('Invite link copied'); }
  catch{ sheet('Invite link', `<p class="sel-text">${esc(inviteUrl())}</p>`, []); }
}
async function qrSheet(forceOnline){
  // Hosts without internet go straight to nearby (LAN) pairing
  if(isHost && !forceOnline && !(await hasInternet())) return lanSheet();
  await lobbyKeyP;
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
      await lobbyKeyP;
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
    const hi=()=>{ if(view && !hostLost || replaced) return; netSend({t:'hello',...publicHello()}, 'lan-host'); };
    g.ch.addEventListener('open', ()=>{ hi(); setInterval(hi, 3000); lan.show=false; render(); });
    lan.reply='OTA:'+g.code; lan.svg=await qrSVG(lan.reply);
    if(!lan.online) lan.show=true;
    else setTimeout(()=>{ if(!view){ lan.show=true; render(); } }, 4000);   // internet path didn't connect quickly: offer the LAN route
    render();
  }catch(e){ console.warn(e); if(!lan.online){ joinIssue='nolan'; render(); } }
}

function ledgerSheet(){
  const rows=(view?.ledger||[]).map(L=>`<tr><td>${esc(L.name)}${L.seated?'':' <span style="color:var(--mut)">(left)</span>'}</td><td>${fmt(L.buy)}</td><td class="${L.net>0?'pos':L.net<0?'neg':''}">${L.net>0?'+':''}${fmt(L.net)}</td></tr>`).join('');
  sheet('Ledger', `<table class="ledger"><tr><th>Player</th><th>Buy-ins</th><th>Net</th></tr>${rows||'<tr><td colspan=3>No buy-ins yet</td></tr>'}</table>`, []);
}
function standingsSheet(){
  const T=view?.tour; if(!T) return;
  const alive=view.seats.filter(Boolean).filter(s=>s.stack>0).sort((a,b)=>b.stack-a.stack);
  const medal=p=>['🥇','🥈','🥉'][p-1]||`#${p}`;
  const rows = T.finished ? T.places : [...alive.map((s,k)=>({name:s.name,av:s.av,place:k+1,stack:s.stack})), ...T.places];
  const html=`<table class="ledger standings"><tr><th>Place</th><th>Player</th>${T.finished?'':'<th>Chips</th>'}</tr>
    ${rows.map(p=>`<tr><td class="${T.finished||p.stack==null?'medal':''}">${T.finished||p.stack==null?medal(p.place):p.place}</td><td>${avatarSVG(p.av)}${esc(p.name)}</td>${T.finished?'':`<td>${p.stack!=null?fmt(p.stack):'out'}</td>`}</tr>`).join('')||`<tr><td colspan=${T.finished?2:3}>No players yet</td></tr>`}</table>`;
  const w=T.finished && T.places.find(p=>p.place===1);
  sheet(w?`🏆 ${w.name} wins!`:'Standings', html, view.isHost&&T.finished?[{label:'Run it back',cls:'primary',fn:()=>send({t:'treset'})}]:[]);
}
// Best to worst, each with an example. Dimmed cards are the ones that don't count.
const RANKINGS=[
  ['Royal Flush','A K Q J 10, all one suit','As Ks Qs Js Ts',5],
  ['Straight Flush','Five in a row, all one suit','9h 8h 7h 6h 5h',5],
  ['Four of a Kind','Four cards of one rank','Qc Qd Qh Qs 7d',4],
  ['Full House','Three of a kind plus a pair','Kh Kd Ks 4c 4h',5],
  ['Flush','Any five of one suit','Ad Jd 8d 6d 3d',5],
  ['Straight','Five in a row, any suits','Tc 9d 8h 7s 6c',5],
  ['Three of a Kind','Three cards of one rank','7c 7d 7h Ks 2d',3],
  ['Two Pair','Two different pairs','Jh Jc 5d 5s As',4],
  ['Pair','Two cards of one rank','Ts Th Ad 8c 4h',2],
  ['High Card','None of the above: highest card plays','Ah Jd 9c 6s 3h',1],
];
function rankingsSheet(){
  // highlight the hand you currently hold
  const m=view && view.seats[view.mySeat], cur=m && m.cards?.length ? handName(bestOf([...m.cards, ...view.board])) : '';
  const html=`<div class="ranks">${RANKINGS.map(([name,what,cards,n],k)=>`<div class="rk ${name===cur?'cur':''}">
      <span class="rn">${k+1}</span>
      <div class="rt"><b>${name}${name===cur?' <i>· your hand</i>':''}</b><span>${what}</span></div>
      <div class="rc">${cards.split(' ').map((c,j)=>cardHTML(c, `mini ${j>=n?'dimc':''}`)).join('')}</div></div>`).join('')}</div>
    <p class="rnote">Ties break on the highest cards. Suits never rank; an ace can be high or low in a straight.</p>`;
  sheet('Hand rankings', html, [], 'tall ranks-sheet');
}
function historySheet(){
  const log=view?.log||[];
  const html = log.length ? `<div class="hist">${log.map(h=>`<div class="hrow"><div class="hh"><b>Hand ${h.n}</b><span>${esc(h.summary)}</span></div>
      ${h.board.length?`<div class="hb">${h.board.map(c=>cardHTML(c,'mini')).join('')}</div>`:''}
      ${h.shown.map(s=>`<div class="hs">${s.cards.map(c=>cardHTML(c,'mini')).join('')}<span>${esc(s.name)} · ${esc(s.hand)}</span></div>`).join('')}</div>`).join('')}</div>`
    : '<p>No hands played yet.</p>';
  sheet('Hand history', html, [], 'tall');
}
// Card back designs: a per-device look (card faces always stay classic). Each design is a CSS class
// that sets the back's variables (see "card backs" in css/features.css); previews carry their own class.
const DECKS=[['red','Classic Red'],['stripes','Stripes'],['navy','Cobalt'],['mint','Mint'],['gold','Sunny'],['paper','Ink']];
let deck=LS.get('ot-deck','red'); if(!DECKS.some(d=>d[0]===deck)) deck='red';
const applyDeck=()=>{ for(const [d] of DECKS) document.documentElement.classList.toggle('dk-'+d, d===deck); };
applyDeck();
function settingsSheet(){
  const previews=DECKS.map(([id,name])=>`<button class="deckopt dk-${id} ${id===deck?'sel':''}" data-deck="${id}" aria-pressed="${id===deck}">
      <span class="dkc">${cardHTML('back')}${cardHTML('back')}</span><span class="dkn">${name}</span></button>`).join('');
  const bg=sheet('Settings', `<div class="set-h">Card backs</div><div class="decks">${previews}</div><div class="set-h">Sound & vibration</div>`, [
    {label:`Sound: ${fxPrefs.sound?'on':'off'}`, fn:()=>{ fxPrefs.sound=!fxPrefs.sound; play('chip'); settingsSheet(); }},
    {label:`Vibration: ${fxPrefs.vibe?'on':'off'}`, fn:()=>{ fxPrefs.vibe=!fxPrefs.vibe; play('chip'); settingsSheet(); }},
  ]);
  bg.addEventListener('click', e=>{
    const b=e.target.closest('[data-deck]'); if(!b) return;
    deck=b.dataset.deck; LS.set('ot-deck', deck); applyDeck(); play('flip');
    bg.querySelectorAll('[data-deck]').forEach(x=>{ x.classList.toggle('sel', x===b); x.setAttribute('aria-pressed', x===b); });
  });
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
    case 'seatTap': { const i=+b.dataset.i, s=v.seats[i]; if(!s || i===v.mySeat) break;
      const btns=[], lines=[], vc=s.voice;
      if(vc && voice.on){ const quiet=voice.silenced.has(vc.vid);
        btns.push({label:quiet?'Unmute for me':'Mute for me', fn:()=>{ silence(vc.vid,!quiet); render(); }}); }
      if(vc && v.mySeat>=0){
        const left=vc.guard-(performance.now()-v.recvAt);
        if(vc.muted) lines.push(`${esc(s.name)}’s mic is muted.`);
        else if(left>0) lines.push(`${esc(s.name)} unmuted after being muted, so they can’t be muted for everyone again for ${mmss(left)}.`);
        else btns.push({label:'Mute for everyone', fn:()=>send({t:'vmute',seat:i})});
      }
      if(v.isHost){
        lines.push(s.bot?'This seat is a bot.': v.tour?.started ? 'Remove this player? They forfeit the tournament.' : 'Remove this player from the table? Their chips are cashed out in the ledger.');
        btns.push({label:s.bot?'Remove bot':'Remove player',cls:'danger',fn:()=>send({t:'kick',seat:i})});
      }
      if(btns.length || lines.length) sheet(s.name, lines.map(t=>`<p>${t}</p>`).join(''), btns);
      break; }
    case 'mic': micTap(); break;
    case 'fold': doAction('fold'); break;
    case 'check': doAction('check'); break;
    case 'call': doAction('call'); break;
    case 'raiseMin': doAction('raise',+b.dataset.v); break;
    case 'raiseOpen': ui.raiseOpen=true; ui.raiseTo=0; play('tick'); render(); break;
    case 'raiseClose': ui.raiseOpen=false; render(); break;
    case 'preset': ui.raiseTo=+b.dataset.v; play('tick'); render(); break;
    case 'raiseGo': ui.raiseOpen=false; doAction('raise',ui.raiseTo); break;
    case 'emote': ui.emoteOpen=true; render(); break;
    case 'emoteClose': ui.emoteOpen=false; render(); break;
    case 'em': ui.emoteOpen=false; if(!isHost) buzz(8); send({t:'emote',e:b.dataset.v}); render(); break;   // guests feel it now; the sound comes with the host's echo
    case 'rebuy': play('chips'); send({t:'rebuy'}); break;
    case 'show': play('flip'); send({t:'show'}); break;
    case 'showToggle': { const m=v.seats[v.mySeat]; play('tick'); send({t:'show',on:!m?.show}); break; }
    case 'ranks': rankingsSheet(); break;
    case 'pre': { const k=b.dataset.v; ui.pre = ui.pre?.kind===k ? null : { kind:k, amt:+b.dataset.amt||0, hand:v.handNo }; play('tick'); render(); break; }
    case 'odds': {
      const mine=v?.seats[v.mySeat];
      if(!ui.odds.open && !(mine?.cards?.length && mine.inHand && !mine.folded && isActive(v))){ toast('Your odds appear here once you’re dealt into a hand'); break; }
      ui.odds.open=!ui.odds.open; play('tick'); render(); break; }
    case 'stand': send({t:'stand'}); break;
    case 'sitin': send({t:'sitout',on:false}); break;
    case 'tstart': send({t:'tstart'}); break;
    case 'cstart': send({t:'cstart'}); break;
    case 'treset': send({t:'treset'}); break;
    case 'standings': standingsSheet(); break;
    case 'retry': location.reload(); break;
    case 'menu': {
      const btns=[{label:'Invite friends',cls:'primary',fn:shareInvite},{label:'Show QR code',fn:qrSheet},{label:'Hand history',fn:historySheet}];
      btns.push(v?.tour ? {label:'Standings',fn:standingsSheet} : {label:'Ledger',fn:ledgerSheet});
      btns.push({label:'Settings',fn:settingsSheet});
      if(isHost) btns.push({label:v?.voiceOn?'Turn off voice chat':'Turn on voice chat',fn:()=>send({t:'voiceopt',on:!v?.voiceOn})});
      if(voice.on) btns.push({label:'Leave voice chat',fn:()=>{ leaveVoice(); sendVoice(); render(); }});
      if(v && v.mySeat>=0 && !v.tour){ const out=v.seats[v.mySeat].sittingOut; btns.push({label:out?'I’m back':'Sit out next hand',fn:()=>send({t:'sitout',on:!out})}); }
      if(v && v.mySeat>=0) btns.push({label:v.tour?.started?'Leave tournament':'Stand up',fn:()=>send({t:'stand'})});
      if(isHost) btns.push({label:'Close table for everyone',cls:'danger',fn:endTable});
      const what = v?.tour ? `Tournament · starting stack ${fmt(v.tour.stack)}` : v ? `Blinds ${fmt(v.sb)}/${fmt(v.bb)} · buy-in ${short(v.buyIn)}` : '';
      sheet(`Table ${fmtCode(tableCode)}`, `<p>${what}${isHost?' · you are hosting. The table saves automatically on this device.':''}</p>`, btns); break; }
    case 'leave':
      if(isHost) sheet('Leave table?','You’re the host. If other players are online, one of them takes over hosting within about 10 seconds and the game carries on. Otherwise it pauses until you come back: it’s saved on this device under “Your tables”.',[{label:'Leave',cls:'danger',fn:goHome}]);
      else sheet('Leave table?','Your chips stay at the table until you stand up.',[{label:'Stand up and leave',cls:'danger',fn:()=>{ send({t:'stand'}); setTimeout(goHome,250); }},{label:'Just leave',fn:goHome}]);
      break;
  }
});
app.addEventListener('keydown', e=>{ if(e.target.id==='nm' && e.key==='Enter'){ e.preventDefault(); document.querySelector('[data-act=start],[data-act=join]')?.click(); } });

// Your action: play its sound right away (all in when it puts your whole stack in) and remember it,
// so the echo from the host doesn't play it twice.
function doAction(a, amt){
  const v=view, m=v && v.seats[v.mySeat];
  if(m){
    const toCall=v.curBet-m.bet, all=(a==='call'&&toCall>=m.stack) || (a==='raise'&&amt>=m.bet+m.stack);
    ui.selfCue=v.handNo+':'+(m.acts+1);
    play(all?'allin':a==='call'&&toCall<=0?'check':{fold:'fold',check:'check',call:'chip',raise:'chips'}[a]);
  }
  send({t:'act',a,amt});
}

// keyboard shortcuts (desktop): F fold, C / space check-call, R min-raise, ↑ custom raise (then ←/→ to size it), Enter confirm, H hide cards, Esc close
document.addEventListener('keydown',e=>{
  if(e.metaKey||e.ctrlKey||e.altKey||e.target.closest?.('input:not([type=range])')) return;
  // Space/Enter on a control reached with the keyboard activates that control, not a shortcut
  if((e.key===' '||e.key==='Enter') && e.target!==document.body && e.target.matches?.(':focus-visible')){
    if(e.target.id==='hole'){ e.preventDefault(); toggleHide(); }
    return;
  }
  if(e.key==='Escape'){ const bg=document.querySelector('.sheet-bg:not(.closing)'); if(bg){ closeSheet(bg); return; }
    if(ui.emoteOpen){ ui.emoteOpen=false; render(); return; } if(ui.raiseOpen){ ui.raiseOpen=false; render(); } return; }
  if(screen==='lobby' || document.querySelector('.sheet-bg:not(.closing)')) return;
  if(e.key.toLowerCase()==='h' && document.querySelector('#hole.mine')){ toggleHide(); return; }
  const step={ arrowleft:-1, arrowdown:-1, arrowright:1, arrowup:1 }[e.key.toLowerCase()];
  if(step && document.getElementById('rr')){ e.preventDefault(); stepRaise(step); return; }
  const acts={ f:['fold'], c:['check','call'], ' ':['check','call'], r:['raiseMin'], arrowup:['raiseOpen'], enter:['raiseGo'] }[e.key.toLowerCase()];
  if(!acts) return;
  const b=acts.map(a=>app.querySelector(`button[data-act="${a}"]:not(:disabled)`)).find(Boolean);
  if(b){ e.preventDefault(); b.click(); }
});

// ------------------------------ flows ------------------------------
async function startHosting(){
  const [sb,bb]=STAKES[lobby.stake];
  const hostKey=await lobbyKeyP;
  tableCode=lobby.code; isHost=true;
  const tour = lobby.game==='tourney'
    ? { started:false, finished:false, baseSb:sb, level:0, levelMs:SPEEDS[lobby.speed][1]*60000, levelEnds:0, places:[], stack:bb*TOUR_STACK_BB } : null;
  S=mkState({sb,bb,buyIn:bb*100,minBuy:bb*20,table:tableCode,mode:tour?'tourney':'cash',tour});
  S.hostKey=hostKey; S.rootPub=hostKey?.pub; S.rootFp=hostKey?.fp; S.chain=[]; S.epoch=0; await useHostKey(hostKey).catch(()=>{});
  S.seats[0]=mkSeat({token:me.token,pid:'local',name:me.name,av:me.av,stack:tour?tour.stack:S.buyIn});
  if(!tour) S.ledger[me.token]={name:me.name,buy:S.buyIn,out:0};
  history.replaceState(null,'','#'+tableCode+(hostKey?'.'+hostKey.fp:''));
  screen='table'; hostSync(); connect(tableCode);
  setTimeout(()=>toast(tour?'Invite friends from •••, add bots with +, then start':'Tap ••• to invite friends, or + to add bots',4200),600);
}
async function resumeHost(code){
  tableCode=code; isHost=true; S=LS.get('pp-host-'+code,null);
  // tables saved before hosts had a key get one now (links shared earlier still work, without the fingerprint)
  S.hostKey ||= await makeHostKey().catch(()=>null); lobbyKey=S.hostKey; lobbyKeyP=Promise.resolve(lobbyKey);
  await useHostKey(S.hostKey).catch(()=>{});
  // fill in fields added in newer versions
  S.mode ||= 'cash'; S.dead ||= 0; S.burned ||= []; S.log ||= []; S.ledger ||= {};
  for(const s of S.seats) if(s){ s.noReraise ??= false; s.startStack ??= s.stack; }
  for(const s of S.seats) if(s&&!s.bot){ s.connected = s.token===me.token; s.voice=null; if(s.token===me.token) s.pid='local'; }
  // the blind clock stops while a tournament is closed
  if(S.tour && S.tour.started && !S.tour.finished && S.savedAt) S.tour.levelEnds += Math.max(0, Date.now()-S.savedAt);
  S.rootPub ||= S.hostKey?.pub; S.rootFp ||= S.hostKey?.fp; S.chain ||= []; S.epoch ||= 0;
  S.graceUntil=Date.now()+GRACE_MS;       // players need a moment to reconnect: don't auto-fold or skip them yet
  S.seq++; screen='table'; hostSync(); connect(code);
  toast('Table resumed');
}
async function startJoining(){
  tableCode=lobby.code; isHost=false; screen='table'; render();
  hostFp = lobby.fp || LS.get('ot-hk-'+tableCode,'');
  lan.online=await hasInternet();
  if(lobby.lanOffer) startLanGuest(lobby.lanOffer);          // scanned an offline QR: Wi-Fi route ready either way
  if(lan.online) connect(tableCode);
  else if(!lobby.lanOffer){ joinIssue='nolan'; render(); }
  setTimeout(()=>{ if(!view && screen==='table' && !joinIssue && !lan.show){ joinIssue='slow'; render(); } }, JOIN_HINT_MS);
}
function endTable(){
  sheet('Close the table?','Everyone is sent back to the start screen and the saved table is deleted.',[{label:'Close table',cls:'danger',fn:()=>{
    netSend({t:'ended'});
    closed=true; LS.del('pp-host-'+tableCode); setTimeout(goHome,300); }}]);
}
function goHome(){ try{ net?.room.leave(); }catch{} history.replaceState(null,'',location.pathname); location.reload(); }
const newCode = () => String(1000000+rnd(9000000));
// The host key is made in the lobby so an invite copied before starting already carries its fingerprint.
let lobbyKey=null, lobbyKeyP=Promise.resolve(null);

// ------------------------------ boot ------------------------------
(function boot(){
  const code=(location.hash.slice(1).match(/\d{7}/)||[])[0];
  if(code && LS.get('pp-host-'+code,null)) return resumeHost(code);
  const offer=(location.hash.match(/~(.+)$/)||[])[1], fp=(location.hash.match(/^#\d{7}\.([0-9a-f]{16})/)||[])[1]||'';
  if(code){ lobby={...lobby,mode:'join',code,fp,lanOffer:offer?decodeURIComponent(offer):''}; }
  else { lobby={...lobby,mode:'create',code:newCode()}; lobbyKeyP=makeHostKey().catch(()=>null).then(k=>lobbyKey=k); }
  screen='lobby'; render();
})();
window.addEventListener('hashchange',()=>location.reload());
// cache the app so it opens without internet (needed for nearby play)
if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('sw.js').catch(()=>{});
