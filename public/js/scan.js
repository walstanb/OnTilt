// Camera QR scanner. Uses the built-in BarcodeDetector where available (Chrome/Android),
// otherwise the bundled jsQR (Apache-2.0), which also covers iPhone Safari.
let jsqrLoading = null;
function jsQR(){
  if(window.jsQR) return Promise.resolve(window.jsQR);
  return jsqrLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/jsQR.min.js';
    s.onload = () => res(window.jsQR); s.onerror = rej; document.head.appendChild(s);
  });
}

// Starts the camera into `video` and calls onCode(text) for each QR seen. Returns { stop }.
// Resolves only after the camera is live (camera permission also lets WebRTC use real LAN addresses).
export async function startScanner(video, onCode){
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
  video.srcObject = stream; video.setAttribute('playsinline', ''); video.muted = true;
  await video.play().catch(() => {});
  let detector = null;
  if('BarcodeDetector' in window){ try{ if((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] }); }catch{} }
  const decode = detector ? null : await jsQR();
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  let alive = true, last = '';
  const loop = async () => {
    if(!alive) return;
    try{
      if(video.readyState >= 2){
        let text = '';
        if(detector){ const r = await detector.detect(video); text = r[0]?.rawValue || ''; }
        else {
          const w = Math.min(640, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth);
          canvas.width = w; canvas.height = h; ctx.drawImage(video, 0, 0, w, h);
          text = decode(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || '';
        }
        if(text && text !== last){ last = text; onCode(text); }
      }
    }catch{}
    setTimeout(loop, 180);
  };
  loop();
  return { stop(){ alive = false; stream.getTracks().forEach(t => t.stop()); video.srcObject = null; } };
}
