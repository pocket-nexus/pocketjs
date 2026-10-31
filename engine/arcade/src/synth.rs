//! A small voice mixer. Games queue voices; the program mixes them into its PCM
//! thread at 44100 Hz. No sample playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wave {
    Square,
    Triangle,
    Saw,
    Noise,
    Sine,
}

#[derive(Clone, Copy, Debug)]
pub struct Voice {
    pub wave: Wave,
    pub frequency: f32,
    pub slide: f32,
    pub volume: f32,
    pub remaining: u32,
    pub total: u32,
    phase: f32,
    noise: u32,
}

pub const SAMPLE_RATE: u32 = 44100;

impl Voice {
    pub fn tone(frequency: f32, seconds: f32, volume: f32, wave: u32, slide: f32) -> Self {
        let total = ((seconds.clamp(0.0, 5.0) * SAMPLE_RATE as f32) as u32).max(1);
        Self {
            wave: match wave {
                1 => Wave::Triangle,
                2 => Wave::Saw,
                3 => Wave::Noise,
                4 => Wave::Sine,
                _ => Wave::Square,
            },
            frequency: frequency.clamp(20.0, 12000.0),
            slide,
            volume: volume.clamp(0.0, 1.0),
            remaining: total,
            total,
            phase: 0.0,
            noise: 0x2f6e_2b1d,
        }
    }

    fn sample(&mut self) -> f32 {
        let t = self.phase;
        let value = match self.wave {
            Wave::Square => {
                if t < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            Wave::Triangle => 4.0 * (t - 0.5).abs() - 1.0,
            Wave::Saw => 2.0 * t - 1.0,
            Wave::Sine => (t * std::f32::consts::TAU).sin(),
            Wave::Noise => {
                self.noise ^= self.noise << 13;
                self.noise ^= self.noise >> 17;
                self.noise ^= self.noise << 5;
                (self.noise as f32 / u32::MAX as f32) * 2.0 - 1.0
            }
        };
        let frequency = (self.frequency
            + self.slide * (1.0 - self.remaining as f32 / self.total as f32))
            .max(10.0);
        self.phase = (self.phase + frequency / SAMPLE_RATE as f32).fract();
        let age = self.total - self.remaining;
        let attack = (age as f32 / 200.0).min(1.0);
        let release = (self.remaining as f32 / (self.total as f32 * 0.5).max(1.0)).min(1.0);
        self.remaining -= 1;
        value * self.volume * attack * release
    }
}

/// Mix the active voices into interleaved stereo; finished voices leave the list.
pub fn mix(voices: &mut Vec<Voice>, out: &mut [i16]) {
    for frame in out.chunks_exact_mut(2) {
        let mut sum = 0.0;
        for voice in voices.iter_mut() {
            if voice.remaining > 0 {
                sum += voice.sample();
            }
        }
        let sample = (sum.clamp(-1.0, 1.0) * 0.6 * i16::MAX as f32) as i16;
        frame[0] = sample;
        frame[1] = sample;
    }
    voices.retain(|voice| voice.remaining > 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voices_finish_and_mix_is_bounded() {
        let mut voices = vec![
            Voice::tone(440.0, 0.01, 1.0, 0, 0.0),
            Voice::tone(880.0, 0.01, 1.0, 3, 0.0),
        ];
        let mut out = vec![0i16; 2048];
        mix(&mut voices, &mut out);
        assert!(voices.is_empty());
        assert!(out.iter().any(|&sample| sample != 0));
    }
}
