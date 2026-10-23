// Voice chat: each player's microphone goes straight to every other player over the table's WebRTC room.
// Opt-in: nothing is captured or played until you join voice. Players are matched to seats by a random
// voice id (vid) sent with the stream, so peer ids never have to be shared.

const SPEAK_RMS = 0.04, POLL_MS = 120;

export const voice = {
  vid: Math.random().toString(36).slice(2, 10),
  on: false, muted: false,
  stream: null, room: null, ctx: null,
  peers: new Map(),          // pid -> { vid, stream, el, an }
  silenced: new Set(),       // vids muted just for me
  talking: new Set(),        // vids currently speaking (mine included)
  onTalk: null,              // called when `talking` changes
  mine: null,                // analyser for my own mic
};

// called once the room exists: remember incoming streams even before we join, so joining hears everyone
export function voiceRoom(room){
  voice.room = room;
  room.onPeerStream = (stream, pid, meta) => {
    const vid = typeof meta?.vid === 'string' ? meta.vid.slice(0, 16) : '';
    drop(pid);
    const el = new Audio(); el.autoplay = true; el.srcObject = stream;
    const p = { vid, stream, el, an: null };
    voice.peers.set(pid, p);
    if(voice.on){ attach(p); }
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if(voice.peers.get(pid) === p) drop(pid); });
  };
}
// a player arrived after we joined: send them our mic too
export function voicePeerJoin(pid){
  if(voice.on && voice.stream && voice.room) try{ voice.room.addStream(voice.stream, { target: pid, metadata: { vid: voice.vid } }); }catch{}
}
export function voicePeerLeave(pid){ drop(pid); }

export async function joinVoice(){
  if(voice.on) return true;
  if(!voice.room || !navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
  // start audio while the tap still counts as a user gesture (Safari forgets it after the permission prompt)
  voice.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  voice.ctx.resume?.().catch(() => {});
  for(const p of voice.peers.values()) p.el.play?.().catch(() => {});
  voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  voice.on = true; voice.muted = false;
  voice.ctx.resume?.().catch(() => {});
  voice.mine = analyser(voice.stream);
  try{ voice.room.addStream(voice.stream, { metadata: { vid: voice.vid } }); }catch{}
  for(const p of voice.peers.values()) attach(p);
  poll();
  return true;
}
export function leaveVoice(){
  if(!voice.on) return;
  try{ voice.room?.removeStream(voice.stream); }catch{}
  voice.stream?.getTracks().forEach(t => t.stop());
  voice.stream = null; voice.mine = null; voice.on = false; voice.muted = false;
  for(const p of voice.peers.values()){ p.el.pause(); p.an = null; }
  setTalking(new Set());
}
export function setMuted(m){
  voice.muted = !!m;
  voice.stream?.getAudioTracks().forEach(t => { t.enabled = !voice.muted; });
}
// mute someone just for me (or bring them back)
export function silence(vid, on){
  if(on) voice.silenced.add(vid); else voice.silenced.delete(vid);
  for(const p of voice.peers.values()) if(p.vid === vid) p.el.muted = on;
}

function attach(p){
  p.el.muted = voice.silenced.has(p.vid);
  p.el.play?.().catch(() => {});
  p.an ||= analyser(p.stream);
}
function drop(pid){
  const p = voice.peers.get(pid); if(!p) return;
  p.el.pause(); p.el.srcObject = null; voice.peers.delete(pid);
}
function analyser(stream){
  try{
    const an = voice.ctx.createAnalyser(); an.fftSize = 512;
    voice.ctx.createMediaStreamSource(stream).connect(an);
    return { an, buf: new Float32Array(an.fftSize) };
  }catch{ return null; }
}
const loud = a => { if(!a) return false; a.an.getFloatTimeDomainData(a.buf); let s = 0; for(const x of a.buf) s += x * x; return Math.sqrt(s / a.buf.length) > SPEAK_RMS; };
function poll(){
  if(!voice.on) return;
  const now = new Set();
  if(!voice.muted && loud(voice.mine)) now.add(voice.vid);
  for(const p of voice.peers.values()) if(p.vid && !p.el.muted && loud(p.an)) now.add(p.vid);
  setTalking(now);
  setTimeout(poll, POLL_MS);
}
function setTalking(now){
  const same = now.size === voice.talking.size && [...now].every(v => voice.talking.has(v));
  if(same) return;
  voice.talking = now; voice.onTalk?.();
}
