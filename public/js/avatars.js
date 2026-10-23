// Minimal geometric avatars: one simple mark in one soft colour on a dark disc.
// Avatars travel over the network as short ids ('a0'…'a15'); anything else (e.g. an emoji
// saved by an older version) maps to a stable avatar so every player renders the same thing.

const C = { mint:'#cde8c6', gold:'#f5e35c', coral:'#f2a490', sky:'#9cc7ee', lilac:'#c7b5f0', bone:'#e8e8ea', sage:'#9fd3b5', sand:'#e8cf9f' };
const DISC = '#1c1c20';

const MARKS = [
  [C.mint,  c => `<circle cx="16" cy="16" r="7" fill="${c}"/>`],
  [C.coral, c => `<circle cx="16" cy="16" r="6.5" fill="none" stroke="${c}" stroke-width="3"/>`],
  [C.sky,   c => `<path d="M16 7.5 24.5 16 16 24.5 7.5 16z" fill="${c}"/>`],
  [C.gold,  c => `<path d="M16 8.5 24 22.5H8z" fill="${c}" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>`],
  [C.lilac, c => `<rect x="9.5" y="9.5" width="13" height="13" rx="2.5" fill="${c}"/>`],
  [C.sand,  c => `<path d="M8.5 15a7.5 7.5 0 0 0 15 0z" fill="${c}"/>`],
  [C.sage,  c => `<circle cx="11.5" cy="16" r="3.4" fill="${c}"/><circle cx="20.5" cy="16" r="3.4" fill="${c}"/>`],
  [C.bone,  c => `<rect x="9" y="10" width="3" height="12" rx="1.5" fill="${c}"/><rect x="14.5" y="8" width="3" height="16" rx="1.5" fill="${c}"/><rect x="20" y="10" width="3" height="12" rx="1.5" fill="${c}"/>`],
  [C.coral, c => `<path d="M16 9v14M9 16h14" stroke="${c}" stroke-width="3.6" stroke-linecap="round"/>`],
  [C.mint,  c => `<rect x="11" y="8" width="10" height="16" rx="2.2" fill="${c}" transform="rotate(14 16 16)"/>`],
  [C.gold,  c => `<circle cx="16" cy="16" r="7.5" fill="${c}"/><circle cx="19.5" cy="12.5" r="6.2" fill="${DISC}"/>`],
  [C.sky,   c => `<path d="M8 18c2.7-5.3 5.3-5.3 8 0s5.3 5.3 8 0" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`],
  [C.sand,  c => `<path d="M16 8 23 12v8l-7 4-7-4v-8z" fill="${c}"/>`],
  [C.lilac, c => `<circle cx="12" cy="12" r="2.6" fill="${c}"/><circle cx="20" cy="12" r="2.6" fill="${c}"/><circle cx="12" cy="20" r="2.6" fill="${c}"/><circle cx="20" cy="20" r="2.6" fill="${c}"/>`],
  [C.sage,  c => `<path d="m10.5 10.5 11 11m0-11-11 11" stroke="${c}" stroke-width="3.4" stroke-linecap="round"/>`],
  [C.bone,  c => `<path d="M16 7.5 18.4 13.6 24.5 16 18.4 18.4 16 24.5 13.6 18.4 7.5 16 13.6 13.6z" fill="${c}"/>`],
];

export const AVATARS = MARKS.map((_, k) => 'a' + k);

const hash = s => [...String(s)].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7);
export const normAv = id => AVATARS.includes(id) ? id : AVATARS[hash(id || '') % AVATARS.length];

// Scales with the surrounding font-size (1em square), like the emoji it replaces.
export function avatarSVG(id){
  const [color, mark] = MARKS[+normAv(id).slice(1)];
  return `<svg class="avi" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="${DISC}"/>${mark(color)}</svg>`;
}
