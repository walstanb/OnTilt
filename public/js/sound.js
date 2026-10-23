// Sounds and haptics. Everything is synthesized with WebAudio, so there are no files to load
// and it works offline. Settings persist per device.
import { LS } from './ui-helpers.js';

const prefs = LS.get('ot-fx', { sound: true, vibe: true });
export const fx = {
  get sound(){ return prefs.sound; }, set sound(v){ prefs.sound = !!v; LS.set('ot-fx', prefs); },
  get vibe(){ return prefs.vibe; },   set vibe(v){ prefs.vibe = !!v; LS.set('ot-fx', prefs); },
};

let ctx = null, master = null;
function ac(){
  if(!ctx){
    const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = .8; master.connect(ctx.destination);
  }
  if(ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// Browsers only allow audio after a user gesture: unlock on the first tap or key.
const unlock = () => { ac(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); };
addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

function tone(freq, { at = 0, dur = .12, type = 'sine', vol = .3, slide = 0, attack = .005 } = {}){
  const c = ctx, t = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if(slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + .02);
}
let noiseBuf = null;
function noise({ at = 0, dur = .08, vol = .25, freq = 3000, q = 1, type = 'bandpass', sweep = 0 } = {}){
  const c = ctx, t = c.currentTime + at;
  if(!noiseBuf){ noiseBuf = c.createBuffer(1, c.sampleRate * .5, c.sampleRate); const d = noiseBuf.getChannelData(0); for(let i = 0; i < d.length; i++) d[i] = Math.random()*2 - 1; }
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if(sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + dur + .02);
}

// Kept deliberately quiet and short: soft sine/triangle tones and faint filtered noise.
const SOUNDS = {
  deal:   () => noise({ dur: .04, vol: .06, freq: 4200, q: .7 }),
  flip:   () => noise({ dur: .05, vol: .07, freq: 3200, q: .7 }),
  // chips: a low, soft "thock" (short sine + a breath of low-passed noise), not a click
  chip:   () => { tone(300, { dur: .07, vol: .16, slide: -90 }); noise({ dur: .03, vol: .03, freq: 900, type: 'lowpass' }); },
  chips:  () => { SOUNDS.chip(); setTimeout(() => SOUNDS.chip(), 70); },
  check:  () => tone(170, { dur: .08, vol: .22, slide: -40 }),
  fold:   () => noise({ dur: .12, vol: .05, freq: 1400, q: .5, sweep: -900, type: 'lowpass' }),
  allin:  () => { SOUNDS.chip(); setTimeout(() => SOUNDS.chip(), 60); setTimeout(() => SOUNDS.chip(), 120); },
  turn:   () => tone(988, { dur: .22, vol: .09 }),
  win:    () => { tone(784, { dur: .18, vol: .08 }); tone(1175, { at: .1, dur: .28, vol: .07 }); },
  lose:   () => {},
  emote:  e => (EMOTE_SOUNDS[e] || EMOTE_SOUNDS.default)(),
  join:   () => tone(880, { dur: .14, vol: .06 }),
  bust:   () => tone(262, { dur: .25, type: 'triangle', vol: .08, slide: -60 }),
  tick:   () => tone(1400, { dur: .02, vol: .025 }),
  level:  () => tone(660, { dur: .2, vol: .08 }),
};
// One sound per reaction, matched to its mood. Keys are the emoji in EMOTES (ui-helpers.js).
const EMOTE_SOUNDS = {
  // wave: a friendly rising "hi-i"
  '👋': () => { tone(660, { dur: .1, vol: .07 }); tone(880, { at: .09, dur: .16, vol: .07 }); },
  // clap: a short ragged burst of hand claps
  '👏': () => [0, .09, .2, .28, .38].forEach((at, i) => noise({ at, dur: .05, vol: .09 - i*.008, freq: 1500, q: 1.2 })),
  // laugh: bouncy "ha-ha-ha-ha", stepping down
  '😆': () => [620, 580, 540, 500].forEach((f, i) => tone(f, { at: i*.1, dur: .08, type: 'triangle', vol: .07, slide: 60 })),
  // groan: a long, sagging sigh
  '😫': () => tone(330, { dur: .5, type: 'triangle', vol: .07, slide: -150, attack: .06 }),
  // angry: a low growl
  '😠': () => { tone(110, { dur: .28, type: 'sawtooth', vol: .04, slide: -25, attack: .02 }); noise({ dur: .25, vol: .05, freq: 350, type: 'lowpass' }); },
  // party: a popper, then a quick rising fanfare
  '🥳': () => { noise({ dur: .07, vol: .08, freq: 5000, q: .6 }); [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: .05 + i*.07, dur: .14, vol: .06 })); },
  default: () => tone(700, { dur: .09, vol: .07, slide: 200 }),
};
const EMOTE_BUZZ = { '👋': [8, 60, 8], '👏': [6, 60, 6, 80, 6, 60, 6], '😆': [8, 50, 8, 50, 8], '😫': 30, '😠': [40, 30, 40], '🥳': [10, 30, 10, 30, 30] };
const BUZZ = { turn: [20, 50, 20], win: 40, allin: 25, fold: 8, check: 6, chip: 6, chips: 8, emote: 8, bust: 30, level: 15, tick: 6, flip: 8 };

// iPhone: no browser there supports navigator.vibrate (they all use Apple's WebKit). Since iOS 18,
// toggling a switch-style checkbox gives a light system haptic, so we tap a hidden one instead.
// One tap per pulse in the pattern; durations can't be controlled.
let tapper = null;
function iosTap(){
  if(!tapper){
    tapper = document.createElement('label');
    tapper.setAttribute('aria-hidden', 'true');
    tapper.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9px;top:-9px';
    const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('switch', ''); input.tabIndex = -1;
    tapper.appendChild(input); document.body.appendChild(tapper);
  }
  tapper.click();
}
const canVibrate = typeof navigator.vibrate === 'function';
export function buzz(pattern){
  if(!prefs.vibe || !pattern) return;
  if(canVibrate){ navigator.vibrate(pattern); return; }
  const pulses = Array.isArray(pattern) ? pattern.filter((_, i) => i % 2 === 0) : [pattern];
  let at = 0;
  pulses.forEach((ms, k) => { setTimeout(iosTap, at); at += ms + (Array.isArray(pattern) ? (pattern[k*2 + 1] || 0) : 0) + 60; });
}

// `arg` picks a variant: the emoji for 'emote'.
export function play(name, arg){
  if(prefs.sound && SOUNDS[name] && ac()) try{ SOUNDS[name](arg); }catch{}
  buzz(name === 'emote' ? EMOTE_BUZZ[arg] ?? BUZZ.emote : BUZZ[name]);
}
