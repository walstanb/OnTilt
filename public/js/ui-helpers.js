// Shared UI helpers: formatting, constants, icons, cards, toast, localStorage.

export const app = document.getElementById('app');
export const short = n => n>=1e6 ? +(n/1e6).toFixed(1)+'M' : n>=1000 ? +(n/1000).toFixed(1)+'K' : ''+n;
export const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const SUITCH = {s:'♠︎',h:'♥︎',d:'♦︎',c:'♣︎'};
export const fmtCode = c => String(c ?? '');   // table codes are plain digits, no separators
export const STAKES = [[1,2],[2,5],[5,10],[10,20],[25,50],[50,100],[100,200],[250,500]];
export const EMOTES = ['👋','👏','😆','😫','😠','🖕','🥳'];
// Fun names offered to new players (they can reroll or type their own).
const NAME_A = ['Lucky','Sly','Wild','Cool','Bold','Lazy','Sneaky','Salty','Spicy','Quiet','Royal','Chill','Shady','Tilted','Cosmic','Grumpy','Turbo','Velvet','Midnight','Golden'];
const NAME_B = ['Ace','Fox','Shark','Donkey','Joker','River','Bluff','Muck','Nuts','Fish','Whale','Cowboy','Kicker','Flop','Owl','Rocket','Duck','Bandit','Tiger','Pocket'];
export const randomName = () => { const a=NAME_A[Math.floor(Math.random()*NAME_A.length)], b=NAME_B[Math.floor(Math.random()*NAME_B.length)];
  return (a+b).length<=14 ? a+b : b+Math.floor(10+Math.random()*90); };
export const BOTS = [['flint','a2'],['lolaa','a1'],['hot_duck','a3'],['eager_cat','a6'],['mav','a12'],['bluffy','a10'],['nits','a14']];   // [name, avatar id]
export const ICON = {
  ranks:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
  qr:'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/></svg>',
  dice:'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/></svg>',
  back:'<svg viewBox="0 0 24 24"><path d="M20 12H4M10 6l-6 6 6 6"/></svg>',
  up:'<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  mic:'<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  micOff:'<svg viewBox="0 0 24 24"><path d="M15 9.5V6a3 3 0 0 0-5.6-1.5M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.3 5.3M18.4 12.5c.1-.5.1-1 .1-1.5M12 17.5V21M4 4l16 16"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  menu:'<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></svg>',
  smile:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1.8 2 5.2 2 7 0"/><circle cx="9" cy="10" r=".6" fill="currentColor"/><circle cx="15" cy="10" r=".6" fill="currentColor"/></svg>',
  link:'<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>',
};
export function cardHTML(c, cls='', delay=0){
  // data-k keys the element by card so the patcher replaces (and re-animates) it when the card changes
  if(!c) return `<div class="card ghost ${cls}" data-k="ghost"></div>`;
  if(c==='back' || !/^[2-9TJQKA][shdc]$/.test(c)) return `<div class="card back ${cls}" data-k="back"></div>`;
  const red=c[1]==='h'||c[1]==='d', st=delay>0?` style="animation-delay:${delay}ms"`:'';
  return `<div class="card ${red?'red':''} s-${c[1]} ${cls}" data-k="${c}"${st}><span class="r">${c[0]==='T'?'10':c[0]}</span><span class="s">${SUITCH[c[1]]}</span></div>`;
}
let toastT;
export function toast(msg, ms=2600){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),ms); }
export const LS = { get(k,d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch{ return d; } },
             set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch{} }, del(k){ try{ localStorage.removeItem(k); }catch{} } };
// Raise slider stops: every chip unit when the range is small, otherwise ~n "nice" amounts spaced
// geometrically (bets scale with the pot), always keeping the ends and the pot presets.
const NICE=[1,1.2,1.5,2,2.5,3,4,5,6,8,10];
const nice=(x,unit)=>{ const mag=10**Math.floor(Math.log10(x));
  const m=NICE.reduce((a,b)=>Math.abs(b*mag-x)<Math.abs(a*mag-x)?b:a); return Math.max(unit,Math.round(m*mag/unit)*unit); };
export function raiseStops(lo, hi, unit, keys=[], n=18){
  if((hi-lo)/unit<=n){ const out=[]; for(let x=lo;x<hi;x+=unit) out.push(x); return [...new Set([...out,...keys.filter(k=>k>lo&&k<hi),hi])].sort((a,b)=>a-b); }
  const keep=x=>x===lo||x===hi||keys.includes(x), r=(hi/lo)**(1/n), all=new Set([lo,hi,...keys.filter(k=>k>lo&&k<hi)]);
  for(let i=1;i<n;i++) all.add(nice(lo*r**i,unit));
  const out=[];
  for(const x of [...all].filter(x=>x>=lo&&x<=hi).sort((a,b)=>a-b)){
    const p=out[out.length-1];
    // drop a stop crowding its neighbour, preferring to keep the ends and presets
    if(p!==undefined && x/p<1.08){ if(keep(x)&&!keep(p)&&p!==lo) out[out.length-1]=x; else if(keep(x)) out.push(x); continue; }
    out.push(x);
  }
  return out;
}
