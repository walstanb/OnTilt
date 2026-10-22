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
  emote:  () => tone(700, { dur: .09, vol: .07, slide: 200 }),
  join:   () => tone(880, { dur: .14, vol: .06 }),
  bust:   () => tone(262, { dur: .25, type: 'triangle', vol: .08, slide: -60 }),
  tick:   () => tone(1400, { dur: .02, vol: .025 }),
  level:  () => tone(660, { dur: .2, vol: .08 }),
};
const BUZZ = { turn: [20, 50, 20], win: 40, allin: 25, fold: 8, check: 6, chip: 6, chips: 8, emote: 8, bust: 30, level: 15 };

export function play(name){
  if(prefs.sound && SOUNDS[name] && ac()) try{ SOUNDS[name](); }catch{}
  if(prefs.vibe && BUZZ[name]) navigator.vibrate?.(BUZZ[name]);
}
