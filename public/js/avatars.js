// Minimal avatars: a simple solid head shape in one soft colour, with a tiny face, on a dark disc.
// Avatars travel over the network as short ids ('a0'…'a15'); anything else (e.g. an emoji
// saved by an older version) maps to a stable avatar so every player renders the same thing.

const C = { mint:'#cde8c6', gold:'#f5e35c', coral:'#f2a490', sky:'#9cc7ee', lilac:'#c7b5f0', bone:'#e8e8ea', sage:'#9fd3b5', sand:'#e8cf9f' };
const DISC = '#1c1c20', INK = '#1c1c20';

// Heads, drawn around (16,16). `y` nudges the face for shapes whose visual centre sits lower.
const HEADS = {
  circle:  { d: c => `<circle cx="16" cy="16" r="9.5" fill="${c}"/>` },
  square:  { d: c => `<rect x="6.5" y="6.5" width="19" height="19" rx="5" fill="${c}"/>` },
  tall:    { d: c => `<rect x="8.5" y="5.5" width="15" height="21" rx="7.5" fill="${c}"/>` },
  wide:    { d: c => `<rect x="5" y="8.5" width="22" height="15" rx="7.5" fill="${c}"/>` },
  tri:     { d: c => `<path d="M16 7 25.5 24H6.5z" fill="${c}" stroke="${c}" stroke-width="3" stroke-linejoin="round"/>`, y: 3 },
  hex:     { d: c => `<path d="M16 6 25 11v10l-9 5-9-5V11z" fill="${c}" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>` },
  ghost:   { d: c => `<path d="M7 25.5V15a9 9 0 0 1 18 0v10.5l-3-2-3 2-3-2-3 2-3-2z" fill="${c}"/>`, y: -.5 },
  card:    { d: c => `<rect x="9" y="5.5" width="14" height="21" rx="3" fill="${c}" transform="rotate(10 16 16)"/>` },
  egg:     { d: c => `<ellipse cx="16" cy="16.5" rx="8.5" ry="10" fill="${c}"/>`, y: .5 },
  cat:     { d: c => `<path d="M7.5 12.5 8.6 5.5l5 3.6h4.8l5-3.6 1.1 7a9 9 0 1 1-17 0z" fill="${c}"/>`, y: 1.5 },
  bear:    { d: c => `<circle cx="9.5" cy="9" r="3.4" fill="${c}"/><circle cx="22.5" cy="9" r="3.4" fill="${c}"/><circle cx="16" cy="17" r="9" fill="${c}"/>`, y: 1 },
  shield:  { d: c => `<path d="M16 6c3.6 1.8 6.3 2 9 2v8.2c0 5.6-3.8 8.6-9 10.8-5.2-2.2-9-5.2-9-10.8V8c2.7 0 5.4-.2 9-2z" fill="${c}"/>` },
  drop:    { d: c => `<path d="M16 5.5c4.5 5 8.5 9.2 8.5 13.3a8.5 8.5 0 0 1-17 0c0-4.1 4-8.3 8.5-13.3z" fill="${c}"/>`, y: 3 },
  oct:     { d: c => `<path d="M12 6.5h8l5.5 5.5v8L20 25.5h-8L6.5 20v-8z" fill="${c}"/>` },
  bean:    { d: c => `<rect x="6.5" y="6.5" width="19" height="19" rx="9.5" fill="${c}" transform="rotate(-12 16 16)"/>` },
  sprout:  { d: c => `<path d="M16 10c0-2.5 1-4.5 3.5-5.5" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="18" r="8.5" fill="${c}"/>`, y: 2 },
};

// Faces: eyes ~3.2 apart, mouth below. Ink matches the disc so faces read as cut-outs.
function face(kind, y = 0){
  const ey = 15 + y, my = 19 + y, eye = x => `<circle cx="${x}" cy="${ey}" r="1.35" fill="${INK}"/>`;
  const line = d => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  const eyes = eye(12.8) + eye(19.2);
  switch(kind){
    case 'smile':  return eyes + line(`M13 ${my} q3 2.8 6 0`);
    case 'grin':   return eyes + `<path d="M12.8 ${my - .6}h6.4a3.2 3.2 0 0 1-6.4 0z" fill="${INK}"/>`;
    case 'flat':   return eyes + line(`M13.5 ${my + .6}h5`);
    case 'oh':     return eyes + `<circle cx="16" cy="${my + .6}" r="1.4" fill="${INK}"/>`;
    case 'smirk':  return eyes + line(`M13.6 ${my + .8}q2.8 1.4 5-1.3`);
    case 'wink':   return eye(12.8) + line(`M17.9 ${ey}h2.6`) + line(`M13 ${my} q3 2.8 6 0`);
    case 'happy':  return line(`M11.5 ${ey + .6}q1.3-2 2.6 0M17.9 ${ey + .6}q1.3-2 2.6 0`) + line(`M13 ${my} q3 2.8 6 0`);
    case 'sleepy': return line(`M11.6 ${ey}h2.5M17.9 ${ey}h2.5`) + line(`M14.5 ${my + .6}h3`);
    default:       return eyes;
  }
}

const AV = [
  ['circle', C.mint, 'smile'],  ['square', C.coral, 'grin'],  ['tall', C.sky, 'flat'],    ['tri', C.gold, 'happy'],
  ['hex', C.lilac, 'oh'],       ['ghost', C.bone, 'smirk'],   ['card', C.mint, 'wink'],   ['egg', C.sand, 'sleepy'],
  ['cat', C.sage, 'smile'],     ['bear', C.sand, 'grin'],     ['shield', C.sky, 'smirk'], ['drop', C.coral, 'happy'],
  ['oct', C.gold, 'flat'],      ['bean', C.lilac, 'wink'],    ['wide', C.sage, 'oh'],     ['sprout', C.bone, 'smile'],
];

export const AVATARS = AV.map((_, k) => 'a' + k);

const hash = s => [...String(s)].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7);
export const normAv = id => AVATARS.includes(id) ? id : AVATARS[hash(id || '') % AVATARS.length];

// Scales with the surrounding font-size (1em square), like the emoji it replaced.
export function avatarSVG(id){
  const [shape, color, mood] = AV[+normAv(id).slice(1)], head = HEADS[shape];
  return `<svg class="avi" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="${DISC}"/>${head.d(color)}${face(mood, head.y || 0)}</svg>`;
}
