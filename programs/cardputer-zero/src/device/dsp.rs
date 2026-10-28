//! What the microphone's samples become on screen: a level in dBFS, a
//! waveform, a 32-band spectrum and a pitch. The capture is 16 kHz mono
//! S16LE; every block is `BLOCK` samples (32 ms).

use std::f32::consts::PI;

pub const RATE: u32 = 16_000;
pub const BLOCK: usize = 512;
pub const BANDS: usize = 32;
pub const WAVE: usize = 64;
/// The quietest level the meters show.
pub const FLOOR_DB: f32 = -60.0;

/// RMS and peak level of a block in dBFS (0 = full scale), floored.
pub fn level_db(samples: &[i16]) -> (f32, f32) {
    if samples.is_empty() {
        return (FLOOR_DB, FLOOR_DB);
    }
    let mut sum = 0.0f64;
    let mut peak = 0i32;
    for &s in samples {
        let v = s as f64 / 32768.0;
        sum += v * v;
        peak = peak.max((s as i32).abs());
    }
    let rms = (sum / samples.len() as f64).sqrt() as f32;
    (to_db(rms), to_db(peak as f32 / 32768.0))
}

fn to_db(linear: f32) -> f32 {
    if linear <= 0.0 {
        FLOOR_DB
    } else {
        (20.0 * linear.log10()).max(FLOOR_DB)
    }
}

/// The block decimated to `WAVE` points in -1..1.
pub fn wave(samples: &[i16]) -> [f32; WAVE] {
    let mut out = [0.0; WAVE];
    if samples.is_empty() {
        return out;
    }
    for (i, slot) in out.iter_mut().enumerate() {
        let at = i * samples.len() / WAVE;
        *slot = samples[at] as f32 / 32768.0;
    }
    out
}

/// In-place radix-2 FFT of `re` and `im` (a power of two long).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut length = 2;
    while length <= n {
        let angle = -2.0 * PI / length as f32;
        let (wr, wi) = (angle.cos(), angle.sin());
        let mut start = 0;
        while start < n {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..length / 2 {
                let (ar, ai) = (re[start + k], im[start + k]);
                let (br, bi) = (re[start + k + length / 2], im[start + k + length / 2]);
                let (tr, ti) = (br * cr - bi * ci, br * ci + bi * cr);
                re[start + k] = ar + tr;
                im[start + k] = ai + ti;
                re[start + k + length / 2] = ar - tr;
                im[start + k + length / 2] = ai - ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
            start += length;
        }
        length <<= 1;
    }
}

/// Magnitudes of a Hann-windowed `BLOCK`-point FFT, `BLOCK / 2` bins of
/// `RATE / BLOCK` Hz (31.25 Hz).
pub fn magnitudes(samples: &[i16]) -> Vec<f32> {
    let mut re = vec![0.0f32; BLOCK];
    let mut im = vec![0.0f32; BLOCK];
    for (i, slot) in re.iter_mut().enumerate() {
        let s = samples.get(i).copied().unwrap_or(0) as f32 / 32768.0;
        let window = 0.5 - 0.5 * (2.0 * PI * i as f32 / BLOCK as f32).cos();
        *slot = s * window;
    }
    fft(&mut re, &mut im);
    (0..BLOCK / 2)
        .map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt() * 4.0 / BLOCK as f32)
        .collect()
}

/// `BANDS` bands between 60 Hz and 8 kHz, log-spaced, each 0..1 over the
/// range FLOOR_DB..0 dB.
pub fn spectrum(samples: &[i16]) -> [f32; BANDS] {
    let bins = magnitudes(samples);
    let hz_per_bin = RATE as f32 / BLOCK as f32;
    let (low, high) = (60.0f32, 8000.0f32);
    let ratio = (high / low).ln();
    let mut out = [0.0; BANDS];
    for (b, slot) in out.iter_mut().enumerate() {
        let from = low * (ratio * b as f32 / BANDS as f32).exp();
        let to = low * (ratio * (b + 1) as f32 / BANDS as f32).exp();
        let first = (from / hz_per_bin).floor().max(1.0) as usize;
        let last = ((to / hz_per_bin).ceil() as usize).max(first + 1).min(bins.len());
        let mut peak = 0.0f32;
        for bin in &bins[first.min(bins.len() - 1)..last] {
            peak = peak.max(*bin);
        }
        *slot = ((to_db(peak) - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0);
    }
    out
}

/// The fundamental in Hz by normalized autocorrelation over 60..1200 Hz,
/// None when the block is quiet or not periodic.
pub fn pitch(samples: &[i16]) -> Option<f32> {
    if samples.len() < BLOCK {
        return None;
    }
    let (level, _) = level_db(samples);
    if level < -45.0 {
        return None;
    }
    let x: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
    let min_lag = (RATE as f32 / 1200.0) as usize;
    let max_lag = (RATE as f32 / 60.0) as usize;
    let energy: f32 = x.iter().map(|v| v * v).sum();
    if energy <= 0.0 {
        return None;
    }
    let mut best = (0usize, 0.0f32);
    for lag in min_lag..=max_lag.min(x.len() / 2) {
        let mut sum = 0.0f32;
        let mut norm = 0.0f32;
        for i in 0..x.len() - lag {
            sum += x[i] * x[i + lag];
            norm += x[i + lag] * x[i + lag];
        }
        let score = if norm > 0.0 { sum / (energy * norm).sqrt() } else { 0.0 };
        if score > best.1 {
            best = (lag, score);
        }
    }
    if best.1 < 0.6 || best.0 == 0 {
        return None;
    }
    // Parabolic interpolation around the best lag for a finer period.
    let lag = best.0;
    let score_at = |l: usize| -> f32 {
        if l < min_lag || l > max_lag || l >= x.len() / 2 {
            return 0.0;
        }
        let mut sum = 0.0f32;
        let mut norm = 0.0f32;
        for i in 0..x.len() - l {
            sum += x[i] * x[i + l];
            norm += x[i + l] * x[i + l];
        }
        if norm > 0.0 { sum / (energy * norm).sqrt() } else { 0.0 }
    };
    let (a, b, c) = (score_at(lag - 1), best.1, score_at(lag + 1));
    let denominator = a - 2.0 * b + c;
    let shift = if denominator.abs() > 1e-9 { 0.5 * (a - c) / denominator } else { 0.0 };
    Some(RATE as f32 / (lag as f32 + shift.clamp(-0.5, 0.5)))
}

const NOTES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/// The nearest note of `hz` (A4 = 440) with its octave, and the error in
/// cents (-50..50).
pub fn note(hz: f32) -> (String, f32) {
    let semitones = 12.0 * (hz / 440.0).log2() + 69.0;
    let nearest = semitones.round();
    let cents = (semitones - nearest) * 100.0;
    let midi = nearest as i32;
    let name = NOTES[midi.rem_euclid(12) as usize];
    let octave = midi.div_euclid(12) - 1;
    (format!("{name}{octave}"), cents)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f32, amplitude: f32) -> Vec<i16> {
        (0..BLOCK)
            .map(|i| (amplitude * (2.0 * PI * hz * i as f32 / RATE as f32).sin() * 32767.0) as i16)
            .collect()
    }

    #[test]
    fn levels_spectrum_and_pitch_read_a_tone() {
        let a4 = tone(440.0, 0.5);
        let (level, peak) = level_db(&a4);
        assert!((level + 9.0).abs() < 0.5, "{level}");
        assert!((peak + 6.0).abs() < 0.2, "{peak}");
        let bands = spectrum(&a4);
        let loudest = bands.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        // 440 Hz lands in the band whose range holds it.
        let low = 60.0 * ((8000.0f32 / 60.0).ln() * loudest as f32 / BANDS as f32).exp();
        let high = 60.0 * ((8000.0f32 / 60.0).ln() * (loudest + 1) as f32 / BANDS as f32).exp();
        assert!(low <= 440.0 && 440.0 <= high, "{low}..{high}");
        let hz = pitch(&a4).unwrap();
        assert!((hz - 440.0).abs() < 3.0, "{hz}");
        assert_eq!(note(hz).0, "A4");
        assert_eq!(note(261.63).0, "C4");
        assert!(note(445.0).1 > 15.0);
        assert_eq!(pitch(&vec![0i16; BLOCK]), None);
        assert_eq!(level_db(&[]), (FLOOR_DB, FLOOR_DB));
        assert_eq!(wave(&a4).len(), WAVE);
    }
}
