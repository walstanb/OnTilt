// Shared UI helpers: formatting, constants, icons, cards, toast, localStorage.

export const app = document.getElementById('app');
export const short = n => n>=1e6 ? +(n/1e6).toFixed(1)+'M' : n>=1000 ? +(n/1000).toFixed(1)+'K' : ''+n;
export const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const SUITCH = {s:'♠︎',h:'♥︎',d:'♦︎',c:'♣︎'};
export const fmtCode = c => (+c).toLocaleString('en-US');
export const STAKES = [[1,2],[2,5],[5,10],[10,20],[25,50],[50,100],[100,200],[250,500]];
export const AVATARS = ['🦁','🙂','👩🏽','👦🏻','🧔🏽','🐸','🦊','🐼','🐯','🐙','🤠','👽','🦄','🐻','😎','🤖'];
export const EMOTES = ['👋','👏','😆','😫','😠','🥳'];
export const BOTS = [['flint','🙂'],['lolaa','👩🏽'],['hot_duck','👦🏻'],['eager_cat','🐱'],['mav','🤠'],['bluffy','🦊'],['nits','🐢']];
export const ICON = {
  back:'<svg viewBox="0 0 24 24"><path d="M20 12H4M10 6l-6 6 6 6"/></svg>',
  up:'<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  menu:'<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></svg>',
  smile:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1.8 2 5.2 2 7 0"/><circle cx="9" cy="10" r=".6" fill="currentColor"/><circle cx="15" cy="10" r=".6" fill="currentColor"/></svg>',
  link:'<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>',
};
export function cardHTML(c, cls='', delay=0){
  // data-k keys the element by card so the patcher replaces (and re-animates) it when the card changes
  if(!c) return `<div class="card ghost ${cls}" data-k="ghost"></div>`;
  if(c==='back') return `<div class="card back ${cls}" data-k="back"></div>`;
  const red=c[1]==='h'||c[1]==='d', st=delay>0?` style="animation-delay:${delay}ms"`:'';
  return `<div class="card ${red?'red':''} ${cls}" data-k="${c}"${st}><span class="r">${c[0]==='T'?'10':c[0]}</span><span class="s">${SUITCH[c[1]]}</span></div>`;
}
let toastT;
export function toast(msg, ms=2600){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),ms); }
export const LS = { get(k,d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch{ return d; } },
             set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch{} }, del(k){ try{ localStorage.removeItem(k); }catch{} } };
