// Offline LAN connections: plain WebRTC with no signaling server and no STUN/TURN.
// The host's offer and the guest's answer travel as short codes inside QR codes.
// Only the parts of the SDP that matter are sent (ICE credentials, DTLS fingerprint,
// host candidates); the rest is rebuilt from a fixed data-channel template.

const GATHER_MS = 2500;

const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));

// SDP -> "ufrag*pwd*fingerprint*ip,port*ip,port"
export function packSDP(sdp){
  const get = re => (sdp.match(re) || [])[1];
  const ufrag = get(/a=ice-ufrag:(\S+)/), pwd = get(/a=ice-pwd:(\S+)/);
  const fp = get(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/);
  if(!ufrag || !pwd || !fp) throw new Error('incomplete SDP');
  const cands = [...sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gi)].map(m => `${m[1]},${m[2]}`);
  if(!cands.length) throw new Error('no local network address');
  const fpBytes = Uint8Array.from(fp.split(':').map(h => parseInt(h, 16)));
  return [ufrag, pwd, b64u(fpBytes), ...[...new Set(cands)].slice(0, 4)].join('*');
}

export function unpackSDP(code, setup){
  const [ufrag, pwd, fpB64, ...cands] = String(code).split('*');
  if(!ufrag || !pwd || !fpB64 || !cands.length) throw new Error('bad code');
  const fp = [...unb64u(fpB64)].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const lines = [
    'v=0', `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    ...cands.map((c, k) => { const [ip, port] = c.split(','); return `a=candidate:${k+1} 1 udp ${2122260223 - k} ${ip} ${port} typ host generation 0`; }),
    'a=end-of-candidates',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:sha-256 ${fp}`, `a=setup:${setup}`,
    'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ];
  return lines.join('\r\n') + '\r\n';
}

function gathered(pc){
  return new Promise(res => {
    if(pc.iceGatheringState === 'complete') return res();
    const t = setTimeout(res, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', () => { if(pc.iceGatheringState === 'complete'){ clearTimeout(t); res(); } });
  });
}
function link(){
  const pc = new RTCPeerConnection({ iceServers: [] });
  // negotiated channel: both sides create it with the same id, no extra handshake
  const ch = pc.createDataChannel('m', { negotiated: true, id: 0, ordered: true });
  return { pc, ch };
}

// Host: make an offer to show as a QR code.
export async function makeOffer(){
  const { pc, ch } = link();
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return { pc, ch, code: packSDP(pc.localDescription.sdp) };
}
// Guest: answer the host's offer; the returned code goes back to the host as a QR code.
export async function answerOffer(code){
  const { pc, ch } = link();
  await pc.setRemoteDescription({ type: 'offer', sdp: unpackSDP(code, 'actpass') });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { pc, ch, code: packSDP(pc.localDescription.sdp) };
}
// Host: finish the connection with the guest's answer.
export async function acceptAnswer(pc, code){
  await pc.setRemoteDescription({ type: 'answer', sdp: unpackSDP(code, 'active') });
}
export const opened = ch => new Promise((res, rej) => {
  if(ch.readyState === 'open') return res();
  const t = setTimeout(() => rej(new Error('timeout')), 15000);
  ch.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
});
