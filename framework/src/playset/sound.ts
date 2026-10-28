// Sound descriptions for the playset synthesizer (engine/crates/pocket-playset
// src/audio.rs): each is rendered to PCM once when the game loads, then
// played by native triggers (weapons, hits, deaths, pickups, the camera
// target's engine hum) or by the game. The presets below are starting
// points; spread an object over one to change a field.
//
//   const zap = play.sound({ ...sfx.laser(), freq: 1800 });

import { PLAYSET_SOUND, PLAYSET_SOUND_LENGTH, PLAYSET_WAVE } from "../../../contracts/spec/playset.ts";

export interface SoundSpec {
  wave?: "square" | "saw" | "sine" | "triangle" | "noise";
  /** Hz at the start and at the end */
  freq?: number;
  to?: number;
  /** exponential sweep (sounds even across octaves) */
  exp?: boolean;
  attack?: number;
  sustain?: number;
  decay?: number;
  volume?: number;
  duty?: number;
  dutySweep?: number;
  /** cents and Hz */
  vibrato?: number;
  vibratoRate?: number;
  noise?: number;
  lowpass?: number;
  /** pitch multiplier after `arpTime` seconds */
  arp?: number;
  arpTime?: number;
  /** a loop of attack + sustain seconds */
  loop?: boolean;
  harmonic?: number;
  harmonicMix?: number;
  crush?: number;
  echo?: number;
  echoFeedback?: number;
  rate?: number;
  seed?: number;
}

export interface Sound {
  readonly id: number;
}

const WAVES = { square: PLAYSET_WAVE.SQUARE, saw: PLAYSET_WAVE.SAW, sine: PLAYSET_WAVE.SINE, triangle: PLAYSET_WAVE.TRIANGLE, noise: PLAYSET_WAVE.NOISE } as const;

export function encodeSound(s: SoundSpec): Float32Array {
  const d = new Float32Array(PLAYSET_SOUND_LENGTH);
  const S = PLAYSET_SOUND;
  d[S.WAVE] = WAVES[s.wave ?? "square"];
  d[S.FREQ] = s.freq ?? 440;
  d[S.FREQ_END] = s.to ?? s.freq ?? 440;
  d[S.CURVE] = s.exp ? 1 : 0;
  d[S.ATTACK] = s.attack ?? 0.002;
  d[S.SUSTAIN] = s.sustain ?? 0.05;
  d[S.DECAY] = s.decay ?? 0.15;
  d[S.VOLUME] = s.volume ?? 0.5;
  d[S.DUTY] = s.duty ?? 0.5;
  d[S.DUTY_SWEEP] = s.dutySweep ?? 0;
  d[S.VIBRATO] = s.vibrato ?? 0;
  d[S.VIBRATO_RATE] = s.vibratoRate ?? 6;
  d[S.NOISE] = s.noise ?? 0;
  d[S.LOWPASS] = s.lowpass ?? 0;
  d[S.ARP] = s.arp ?? 0;
  d[S.ARP_TIME] = s.arpTime ?? 0;
  d[S.LOOP] = s.loop ? 1 : 0;
  d[S.HARMONIC] = s.harmonic ?? 0;
  d[S.HARMONIC_MIX] = s.harmonicMix ?? 0;
  d[S.RATE] = s.rate ?? 0;
  d[S.CRUSH] = s.crush ?? 0;
  d[S.ECHO] = s.echo ?? 0;
  d[S.ECHO_FEEDBACK] = s.echoFeedback ?? 0;
  d[S.SEED] = s.seed ?? 1;
  return d;
}

/** Preset sounds; each returns a SoundSpec to pass to `Playset.sound`. */
export const sfx = {
  // weapons
  laser: (): SoundSpec => ({ wave: "square", freq: 1500, to: 320, exp: true, sustain: 0.015, decay: 0.11, duty: 0.25, dutySweep: 2, volume: 0.28 }),
  blaster: (): SoundSpec => ({ wave: "saw", freq: 700, to: 130, exp: true, sustain: 0.02, decay: 0.16, noise: 0.15, lowpass: 0.3, volume: 0.3 }),
  cannon: (): SoundSpec => ({ wave: "noise", freq: 900, to: 60, exp: true, sustain: 0.04, decay: 0.55, lowpass: 0.55, harmonic: 0.08, harmonicMix: 0.4, echo: 0.09, echoFeedback: 0.35, volume: 0.65 }),
  gun: (): SoundSpec => ({ wave: "noise", freq: 2400, to: 300, exp: true, sustain: 0.01, decay: 0.09, lowpass: 0.2, crush: 0.3, volume: 0.4 }),
  missile: (): SoundSpec => ({ wave: "noise", freq: 400, to: 1600, exp: true, attack: 0.04, sustain: 0.12, decay: 0.25, lowpass: 0.45, volume: 0.35 }),
  bow: (): SoundSpec => ({ wave: "triangle", freq: 420, to: 180, exp: true, sustain: 0.02, decay: 0.16, noise: 0.25, lowpass: 0.25, volume: 0.45 }),
  whoosh: (): SoundSpec => ({ wave: "noise", freq: 300, to: 1400, exp: true, attack: 0.05, sustain: 0.06, decay: 0.12, lowpass: 0.6, volume: 0.3 }),
  // impacts
  hit: (): SoundSpec => ({ wave: "square", freq: 340, to: 120, exp: true, sustain: 0.01, decay: 0.08, noise: 0.35, crush: 0.4, volume: 0.25 }),
  hurt: (): SoundSpec => ({ wave: "saw", freq: 260, to: 90, exp: true, sustain: 0.03, decay: 0.18, noise: 0.25, crush: 0.3, volume: 0.45 }),
  thud: (): SoundSpec => ({ wave: "sine", freq: 150, to: 45, exp: true, sustain: 0.02, decay: 0.14, noise: 0.15, volume: 0.5 }),
  explosion: (): SoundSpec => ({ wave: "noise", freq: 700, to: 50, exp: true, sustain: 0.06, decay: 0.6, lowpass: 0.5, echo: 0.07, echoFeedback: 0.3, volume: 0.6 }),
  smallExplosion: (): SoundSpec => ({ wave: "noise", freq: 1100, to: 120, exp: true, sustain: 0.03, decay: 0.3, lowpass: 0.35, volume: 0.45 }),
  bigExplosion: (): SoundSpec => ({ wave: "noise", freq: 500, to: 30, exp: true, sustain: 0.12, decay: 1.2, lowpass: 0.65, harmonic: 0.05, harmonicMix: 0.3, echo: 0.15, echoFeedback: 0.4, volume: 0.75 }),
  crumble: (): SoundSpec => ({ wave: "noise", freq: 500, to: 90, exp: true, sustain: 0.05, decay: 0.35, lowpass: 0.4, crush: 0.5, volume: 0.45 }),
  splash: (): SoundSpec => ({ wave: "noise", freq: 1600, to: 200, exp: true, attack: 0.01, sustain: 0.06, decay: 0.45, lowpass: 0.5, volume: 0.45 }),
  // rewards
  coin: (): SoundSpec => ({ wave: "square", freq: 988, arp: 1.335, arpTime: 0.06, sustain: 0.08, decay: 0.2, duty: 0.5, volume: 0.3 }),
  pickup: (): SoundSpec => ({ wave: "square", freq: 660, to: 990, sustain: 0.05, decay: 0.16, arp: 1.5, arpTime: 0.05, duty: 0.25, volume: 0.32 }),
  powerup: (): SoundSpec => ({ wave: "triangle", freq: 330, to: 990, sustain: 0.22, decay: 0.16, vibrato: 60, vibratoRate: 14, volume: 0.42 }),
  heal: (): SoundSpec => ({ wave: "sine", freq: 520, to: 1040, sustain: 0.18, decay: 0.25, vibrato: 30, vibratoRate: 8, harmonic: 1.5, harmonicMix: 0.3, volume: 0.4 }),
  // movement
  jump: (): SoundSpec => ({ wave: "square", freq: 240, to: 620, exp: true, sustain: 0.03, decay: 0.12, duty: 0.3, volume: 0.3 }),
  land: (): SoundSpec => ({ wave: "noise", freq: 300, to: 80, exp: true, sustain: 0.01, decay: 0.08, lowpass: 0.5, volume: 0.3 }),
  step: (): SoundSpec => ({ wave: "noise", freq: 500, to: 200, sustain: 0.005, decay: 0.05, lowpass: 0.6, volume: 0.15 }),
  bite: (): SoundSpec => ({ wave: "square", freq: 420, to: 760, exp: true, sustain: 0.02, decay: 0.07, duty: 0.4, arp: 1.25, arpTime: 0.03, volume: 0.3 }),
  roll: (): SoundSpec => ({ wave: "noise", freq: 120, loop: true, sustain: 0.6, lowpass: 0.85, volume: 0.35 }),
  // loops: engines and ambience (pitch follows speed through an archetype's hum)
  engine: (): SoundSpec => ({ wave: "saw", freq: 55, loop: true, sustain: 0.5, harmonic: 2, harmonicMix: 0.35, lowpass: 0.7, volume: 0.35 }),
  jet: (): SoundSpec => ({ wave: "noise", freq: 900, loop: true, sustain: 0.8, lowpass: 0.75, harmonic: 0.5, harmonicMix: 0.2, volume: 0.28 }),
  rotor: (): SoundSpec => ({ wave: "square", freq: 32, loop: true, sustain: 0.5, duty: 0.12, lowpass: 0.65, noise: 0.2, volume: 0.3 }),
  motor: (): SoundSpec => ({ wave: "triangle", freq: 110, loop: true, sustain: 0.5, harmonic: 3, harmonicMix: 0.25, noise: 0.1, lowpass: 0.4, volume: 0.25 }),
  hull: (): SoundSpec => ({ wave: "noise", freq: 140, loop: true, sustain: 1, lowpass: 0.92, volume: 0.32 }),
  wind: (): SoundSpec => ({ wave: "noise", freq: 400, loop: true, sustain: 1.2, lowpass: 0.94, volume: 0.25 }),
  // signals
  sonar: (): SoundSpec => ({ wave: "sine", freq: 1320, to: 1250, sustain: 0.04, decay: 0.7, echo: 0.22, echoFeedback: 0.5, volume: 0.35 }),
  alarm: (): SoundSpec => ({ wave: "square", freq: 880, arp: 0.75, arpTime: 0.12, sustain: 0.24, decay: 0.05, duty: 0.5, volume: 0.28 }),
  wave: (): SoundSpec => ({ wave: "triangle", freq: 392, arp: 1.5, arpTime: 0.12, sustain: 0.26, decay: 0.3, vibrato: 25, vibratoRate: 5, volume: 0.4 }),
  checkpoint: (): SoundSpec => ({ wave: "square", freq: 784, arp: 1.26, arpTime: 0.07, sustain: 0.14, decay: 0.18, duty: 0.25, volume: 0.32 }),
  win: (): SoundSpec => ({ wave: "triangle", freq: 523, arp: 1.5, arpTime: 0.15, sustain: 0.4, decay: 0.5, vibrato: 30, vibratoRate: 6, harmonic: 2, harmonicMix: 0.25, volume: 0.45 }),
  lose: (): SoundSpec => ({ wave: "triangle", freq: 440, to: 110, sustain: 0.45, decay: 0.6, vibrato: 40, vibratoRate: 5, volume: 0.45 }),
  // building and tools
  place: (): SoundSpec => ({ wave: "square", freq: 220, to: 160, sustain: 0.01, decay: 0.07, noise: 0.2, volume: 0.32 }),
  dig: (): SoundSpec => ({ wave: "noise", freq: 700, to: 300, sustain: 0.02, decay: 0.09, crush: 0.6, lowpass: 0.3, volume: 0.32 }),
  servo: (): SoundSpec => ({ wave: "saw", freq: 180, loop: true, sustain: 0.4, harmonic: 1.5, harmonicMix: 0.3, lowpass: 0.6, volume: 0.22 }),
  grab: (): SoundSpec => ({ wave: "square", freq: 300, to: 200, sustain: 0.02, decay: 0.06, duty: 0.2, volume: 0.3 }),
  // interface
  select: (): SoundSpec => ({ wave: "square", freq: 1100, sustain: 0.01, decay: 0.04, duty: 0.25, volume: 0.22 }),
  confirm: (): SoundSpec => ({ wave: "triangle", freq: 660, arp: 1.5, arpTime: 0.05, sustain: 0.07, decay: 0.12, volume: 0.32 }),
  pause: (): SoundSpec => ({ wave: "triangle", freq: 520, to: 390, sustain: 0.05, decay: 0.1, volume: 0.3 }),
};
