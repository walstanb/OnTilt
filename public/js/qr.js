// QR codes for invite links. Uses the bundled qrcode-generator (MIT) so it also works offline.
let loading = null;
function lib(){
  if(window.qrcode) return Promise.resolve(window.qrcode);
  return loading ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/qrcode.min.js';
    s.onload = () => res(window.qrcode); s.onerror = rej; document.head.appendChild(s);
  });
}
// Returns an SVG string: dark modules on white with a quiet zone, scaled by CSS.
export async function qrSVG(text){
  const qrcode = await lib();
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), pad = 3, size = n + pad*2;
  let path = '';
  for(let y = 0; y < n; y++) for(let x = 0; x < n; x++) if(q.isDark(y, x)) path += `M${x+pad} ${y+pad}h1v1h-1z`;
  return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
