//! Sound: descriptions synthesized into mono PCM once, and the per-frame
//! queue of mixer requests a host drains (pps_audio_requests).
//!
//! The world queues sounds where they happen (a shot, a hit, a death, a
//! pickup) with their position; `finish` scales each by its distance from
//! the listener, pans it across the listener's right axis and caps how many
//! copies of one sound start in a frame, so a volley stays a volley and not
//! forty overlapping voices.

use crate::fmath::*;
use crate::schema::{sound as S, voice as VO, wave as WV};
use crate::vec::*;
use alloc::vec::Vec;

pub struct Sound {
    pub pcm: Vec<i16>,
    pub rate: u32,
    pub looping: bool,
}

/// One request for the host's mixer. `voice` names a loop; one-shots use -1.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Request {
    pub kind: u32,
    pub sound: u32,
    pub voice: i32,
    pub volume: f32,
    pub pitch: f32,
    pub pan: f32,
}

#[derive(Clone, Copy)]
struct Pending {
    r: Request,
    at: Option<Vec3>,
}

pub struct Audio {
    pub sounds: Vec<Sound>,
    queue: Vec<Pending>,
    pub out: Vec<Request>,
    next_voice: i32,
    /// the camera target's hum: (slot, voice, sound)
    pub hum: Option<(usize, i32, u32)>,
    pub master: f32,
}

impl Default for Audio {
    fn default() -> Self {
        Audio { sounds: Vec::new(), queue: Vec::new(), out: Vec::new(), next_voice: 1, hum: None, master: 1.0 }
    }
}

/// The most copies of one sound started in one frame, and of all sounds.
const SAME_PER_FRAME: usize = 2;
const ALL_PER_FRAME: usize = 10;

impl Audio {
    pub fn add(&mut self, desc: &[f32]) -> i32 {
        let mut d = [0.0f32; 24];
        let n = desc.len().min(24);
        d[..n].copy_from_slice(&desc[..n]);
        let s = synth(&d);
        self.sounds.push(s);
        (self.sounds.len() - 1) as i32
    }

    /// Queue a one-shot; `at` places it in the world for distance and pan.
    pub fn play(&mut self, sound: u32, volume: f32, pitch: f32, at: Option<Vec3>) {
        if (sound as usize) >= self.sounds.len() || volume <= 0.0 {
            return;
        }
        self.queue.push(Pending { r: Request { kind: VO::PLAY, sound, voice: -1, volume, pitch, pan: 0.0 }, at });
    }

    /// Start a loop; returns its voice.
    pub fn start_loop(&mut self, sound: u32, volume: f32, pitch: f32) -> i32 {
        if (sound as usize) >= self.sounds.len() {
            return -1;
        }
        let voice = self.next_voice;
        self.next_voice += 1;
        self.queue.push(Pending { r: Request { kind: VO::LOOP, sound, voice, volume, pitch, pan: 0.0 }, at: None });
        voice
    }

    pub fn set_loop(&mut self, voice: i32, volume: f32, pitch: f32, pan: f32) {
        self.queue.push(Pending { r: Request { kind: VO::SET, sound: 0, voice, volume, pitch, pan }, at: None });
    }

    pub fn stop_loop(&mut self, voice: i32) {
        self.queue.push(Pending { r: Request { kind: VO::STOP, sound: 0, voice, volume: 0.0, pitch: 1.0, pan: 0.0 }, at: None });
    }

    /// Turn the frame's queue into mixer requests heard from `eye`.
    pub fn finish(&mut self, eye: Vec3, right: Vec3, far: f32) {
        self.out.clear();
        let mut started = 0usize;
        let far = maxf(far, 10.0);
        let mut i = 0;
        while i < self.queue.len() {
            let p = self.queue[i];
            i += 1;
            let mut r = p.r;
            if r.kind == VO::PLAY {
                if started >= ALL_PER_FRAME {
                    continue;
                }
                let same = self.out.iter().filter(|o| o.kind == VO::PLAY && o.sound == r.sound).count();
                if same >= SAME_PER_FRAME {
                    continue;
                }
                if let Some(at) = p.at {
                    let d = at - eye;
                    let dist = d.len();
                    // full volume within a tenth of the far plane, silent at it
                    let k = clampf(1.0 - (dist - far * 0.1) / (far * 0.9), 0.0, 1.0);
                    r.volume *= k * k;
                    if dist > 1e-3 {
                        r.pan = clampf(d.dot(right) / dist, -1.0, 1.0) * 0.7;
                    }
                }
                if r.volume < 0.02 {
                    continue;
                }
                started += 1;
            }
            r.volume = clampf(r.volume * self.master, 0.0, 1.0);
            self.out.push(r);
        }
        self.queue.clear();
    }
}

/// Render a description into PCM.
pub fn synth(d: &[f32; 24]) -> Sound {
    let rate = if d[S::RATE] >= 4000.0 { d[S::RATE] as u32 } else { 22_050 };
    let attack = maxf(d[S::ATTACK], 0.0);
    let sustain = maxf(d[S::SUSTAIN], 0.0);
    let decay = maxf(d[S::DECAY], 0.0);
    let looping = d[S::LOOP] > 0.5;
    let len_s = if looping { maxf(attack + sustain, 0.05) } else { clampf(attack + sustain + decay, 0.01, 3.0) };
    let echo = clampf(d[S::ECHO], 0.0, 0.5);
    let tail = if echo > 0.0 && !looping { echo * 3.0 } else { 0.0 };
    let n = ((len_s + tail) * rate as f32) as usize;
    let mut pcm = Vec::with_capacity(n);
    let wave = d[S::WAVE] as u32;
    let f0 = maxf(d[S::FREQ], 1.0);
    let f1 = if d[S::FREQ_END] > 0.0 { d[S::FREQ_END] } else { f0 };
    let volume = if d[S::VOLUME] > 0.0 { clampf(d[S::VOLUME], 0.0, 1.0) } else { 0.5 };
    let mut duty = if d[S::DUTY] > 0.0 { d[S::DUTY] } else { 0.5 };
    let noise_mix = clampf(d[S::NOISE], 0.0, 1.0);
    let lowpass = clampf(d[S::LOWPASS], 0.0, 0.99);
    let harmonic = d[S::HARMONIC];
    let harmonic_mix = clampf(d[S::HARMONIC_MIX], 0.0, 1.0);
    let crush = clampf(d[S::CRUSH], 0.0, 1.0);
    let mut rng = Rng(0x9e37_79b9 ^ (d[S::SEED] as u32).wrapping_mul(2_654_435_761));
    let dt = 1.0 / rate as f32;
    let (mut phase, mut phase2) = (0.0f32, 0.0f32);
    let mut noise = 0.0f32;
    let mut noise_phase = 1.0f32;
    let mut filtered = 0.0f32;
    let sweep_len = if looping { len_s } else { maxf(attack + sustain + decay, 0.01) };
    let ratio = if f0 > 0.0 { f1 / f0 } else { 1.0 };
    for i in 0..n {
        let t = i as f32 * dt;
        let u = clampf(t / sweep_len, 0.0, 1.0);
        let mut f = if d[S::CURVE] > 0.5 && ratio > 0.0 { f0 * expf(u * (ratio.max(1e-3)).ln_approx()) } else { lerpf(f0, f1, u) };
        if d[S::ARP] > 0.0 && t >= d[S::ARP_TIME] {
            f *= d[S::ARP];
        }
        if d[S::VIBRATO] > 0.0 {
            // cents to a frequency ratio, 2^(c/1200) ~ 1 + c * 0.000578
            f *= 1.0 + d[S::VIBRATO] * 0.000_578 * sinf(TAU * d[S::VIBRATO_RATE] * t);
        }
        phase += f * dt;
        phase -= floorf(phase);
        if harmonic > 0.0 {
            phase2 += f * harmonic * dt;
            phase2 -= floorf(phase2);
        }
        duty = clampf(duty + d[S::DUTY_SWEEP] * dt, 0.05, 0.95);
        noise_phase += f * dt * 2.0;
        if noise_phase >= 1.0 {
            noise_phase -= floorf(noise_phase);
            noise = rng.signed();
        }
        let osc = |w: u32, ph: f32| -> f32 {
            match w {
                WV::SQUARE => {
                    if ph < duty {
                        1.0
                    } else {
                        -1.0
                    }
                }
                WV::SAW => ph * 2.0 - 1.0,
                WV::SINE => sinf(ph * TAU),
                WV::TRIANGLE => 1.0 - 4.0 * absf(ph - 0.5),
                _ => noise,
            }
        };
        let mut v = osc(wave, phase);
        if harmonic > 0.0 {
            v = lerpf(v, osc(if wave == WV::NOISE { WV::SQUARE } else { wave }, phase2), harmonic_mix);
        }
        if noise_mix > 0.0 && wave != WV::NOISE {
            v = lerpf(v, noise, noise_mix);
        }
        if crush > 0.0 {
            let steps = lerpf(32.0, 3.0, crush);
            v = floorf(v * steps + 0.5) / steps;
        }
        if lowpass > 0.0 {
            filtered += (v - filtered) * (1.0 - lowpass);
            v = filtered;
        }
        // envelope
        let env = if looping {
            1.0
        } else if t < attack {
            t / maxf(attack, 1e-4)
        } else if t < attack + sustain {
            1.0
        } else if t < attack + sustain + decay {
            1.0 - (t - attack - sustain) / maxf(decay, 1e-4)
        } else {
            0.0
        };
        pcm.push(clampf(v * env * volume, -1.0, 1.0));
    }
    // echo: add delayed copies
    let mut out: Vec<i16> = Vec::with_capacity(pcm.len());
    if echo > 0.0 && !looping {
        let delay = (echo * rate as f32) as usize;
        let fb = clampf(d[S::ECHO_FEEDBACK], 0.0, 0.85);
        for i in delay..pcm.len() {
            let e = pcm[i - delay] * fb;
            pcm[i] = clampf(pcm[i] + e, -1.0, 1.0);
        }
    }
    for v in pcm {
        out.push((v * 30_000.0) as i16);
    }
    Sound { pcm: out, rate, looping }
}

/// ln for the exponential sweep (range reduction to [1, 2) and a series).
trait LnApprox {
    fn ln_approx(self) -> f32;
}

impl LnApprox for f32 {
    fn ln_approx(self) -> f32 {
        if !(self > 0.0) {
            return -80.0;
        }
        let bits = self.to_bits();
        let e = ((bits >> 23) & 0xff) as i32 - 127;
        let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000);
        // ln(m) for m in [1, 2): ln((1+y)/(1-y)) = 2(y + y^3/3 + y^5/5 ...)
        let y = (m - 1.0) / (m + 1.0);
        let y2 = y * y;
        let lnm = 2.0 * y * (1.0 + y2 * (1.0 / 3.0 + y2 * (1.0 / 5.0 + y2 * (1.0 / 7.0 + y2 / 9.0))));
        lnm + e as f32 * 0.693_147_2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blip_has_its_length_and_level() {
        let mut d = [0.0f32; 24];
        d[S::WAVE] = WV::SQUARE as f32;
        d[S::FREQ] = 880.0;
        d[S::FREQ_END] = 220.0;
        d[S::SUSTAIN] = 0.1;
        d[S::DECAY] = 0.1;
        d[S::VOLUME] = 0.5;
        let s = synth(&d);
        assert_eq!(s.rate, 22_050);
        assert_eq!(s.pcm.len(), (0.2 * 22_050.0) as usize);
        let peak = s.pcm.iter().map(|v| v.unsigned_abs()).max().unwrap();
        assert!(peak > 14_000 && peak <= 15_001, "peak {peak}");
        // the decay reaches silence
        assert!(s.pcm.last().unwrap().unsigned_abs() < 400);
    }

    #[test]
    fn ln_is_close() {
        for &v in &[0.01f32, 0.5, 1.0, 2.0, 10.0, 300.0] {
            assert!((v.ln_approx() - v.ln()).abs() < 1e-4, "{v}");
        }
    }

    #[test]
    fn volleys_are_capped_and_distance_quiets() {
        let mut a = Audio::default();
        let mut d = [0.0f32; 24];
        d[S::FREQ] = 440.0;
        d[S::SUSTAIN] = 0.05;
        a.add(&d);
        for _ in 0..6 {
            a.play(0, 1.0, 1.0, Some(v3(0.0, 0.0, -5.0)));
        }
        a.play(0, 1.0, 1.0, Some(v3(0.0, 0.0, -500.0)));
        a.finish(Vec3::ZERO, v3(1.0, 0.0, 0.0), 200.0);
        assert_eq!(a.out.len(), SAME_PER_FRAME);
        assert!(a.out[0].volume > 0.9);
    }
}
