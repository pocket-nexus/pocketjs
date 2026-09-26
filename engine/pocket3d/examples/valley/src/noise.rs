//! Deterministic value noise and a small integer hash, so a cooked scene is a
//! pure function of its seed and the same on every machine.

/// A 32-bit mix with good avalanche, used for both noise and placement.
pub fn hash(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^= value >> 16;
    value
}

pub fn hash2(x: i32, y: i32, seed: u32) -> u32 {
    hash(
        (x as u32)
            .wrapping_mul(0x9e37_79b9)
            .wrapping_add((y as u32).wrapping_mul(0x85eb_ca6b))
            .wrapping_add(seed),
    )
}

/// `0..1` from a hashed lattice point.
pub fn unit(x: i32, y: i32, seed: u32) -> f32 {
    (hash2(x, y, seed) >> 8) as f32 / 16_777_216.0
}

fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Bilinear value noise in `0..1`.
pub fn value(x: f32, y: f32, seed: u32) -> f32 {
    let xi = x.floor();
    let yi = y.floor();
    let xf = smooth(x - xi);
    let yf = smooth(y - yi);
    let (xi, yi) = (xi as i32, yi as i32);
    let a = unit(xi, yi, seed);
    let b = unit(xi + 1, yi, seed);
    let c = unit(xi, yi + 1, seed);
    let d = unit(xi + 1, yi + 1, seed);
    let top = a + (b - a) * xf;
    let bottom = c + (d - c) * xf;
    top + (bottom - top) * yf
}

/// Sum of `octaves` value-noise layers, normalized to `0..1`.
pub fn fbm(x: f32, y: f32, octaves: u32, seed: u32) -> f32 {
    let mut total = 0.0;
    let mut amplitude = 1.0;
    let mut frequency = 1.0;
    let mut normalization = 0.0;
    for octave in 0..octaves {
        total += value(x * frequency, y * frequency, seed.wrapping_add(octave * 131)) * amplitude;
        normalization += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    total / normalization.max(1e-6)
}

/// Ridged noise: creases along the zero set, for rock and mountain silhouettes.
pub fn ridged(x: f32, y: f32, octaves: u32, seed: u32) -> f32 {
    let mut total = 0.0;
    let mut amplitude = 1.0;
    let mut frequency = 1.0;
    let mut normalization = 0.0;
    for octave in 0..octaves {
        let sample = value(x * frequency, y * frequency, seed.wrapping_add(octave * 271));
        total += (1.0 - (sample * 2.0 - 1.0).abs()) * amplitude;
        normalization += amplitude;
        amplitude *= 0.5;
        frequency *= 2.06;
    }
    total / normalization.max(1e-6)
}

/// Value noise on a torus of `period` lattice cells, so a texture generated
/// from it tiles without a seam.
pub fn value_tiled(x: f32, y: f32, period: i32, seed: u32) -> f32 {
    let period = period.max(1);
    let xi = x.floor();
    let yi = y.floor();
    let xf = smooth(x - xi);
    let yf = smooth(y - yi);
    let (xi, yi) = (xi as i32, yi as i32);
    let wrap = |value: i32| value.rem_euclid(period);
    let a = unit(wrap(xi), wrap(yi), seed);
    let b = unit(wrap(xi + 1), wrap(yi), seed);
    let c = unit(wrap(xi), wrap(yi + 1), seed);
    let d = unit(wrap(xi + 1), wrap(yi + 1), seed);
    let top = a + (b - a) * xf;
    let bottom = c + (d - c) * xf;
    top + (bottom - top) * yf
}

/// Seamless fbm: every octave doubles both the frequency and the period.
pub fn fbm_tiled(x: f32, y: f32, period: i32, octaves: u32, seed: u32) -> f32 {
    let mut total = 0.0;
    let mut amplitude = 1.0;
    let mut frequency = 1.0;
    let mut normalization = 0.0;
    for octave in 0..octaves {
        total += value_tiled(
            x * frequency,
            y * frequency,
            (period as f32 * frequency) as i32,
            seed.wrapping_add(octave * 131),
        ) * amplitude;
        normalization += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    total / normalization.max(1e-6)
}

/// A small deterministic generator for placement decisions.
#[derive(Clone, Copy, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed | 1)
    }

    pub fn next_u32(&mut self) -> u32 {
        self.0 = hash(self.0.wrapping_add(0x9e37_79b9));
        self.0
    }

    /// Uniform in `0..1`.
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }

    pub fn range(&mut self, low: f32, high: f32) -> f32 {
        low + (high - low) * self.unit()
    }

    pub fn index(&mut self, count: usize) -> usize {
        if count == 0 {
            0
        } else {
            (self.next_u32() as usize) % count
        }
    }

    pub fn chance(&mut self, probability: f32) -> bool {
        self.unit() < probability
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_noise_is_continuous_across_a_lattice_line() {
        let left = value(3.0 - 1e-4, 1.25, 7);
        let right = value(3.0 + 1e-4, 1.25, 7);
        assert!((left - right).abs() < 1e-3);
    }

    #[test]
    fn noise_stays_inside_the_unit_range() {
        for step in 0..500 {
            let x = step as f32 * 0.37;
            let y = step as f32 * 0.11;
            for sample in [
                value(x, y, 1),
                fbm(x, y, 5, 2),
                ridged(x, y, 4, 3),
            ] {
                assert!((0.0..=1.0).contains(&sample), "{sample}");
            }
        }
    }

    #[test]
    fn tiled_noise_wraps_at_its_period() {
        for step in 0..40 {
            let y = step as f32 * 0.25;
            let left = fbm_tiled(0.0, y, 8, 4, 5);
            let right = fbm_tiled(8.0, y, 8, 4, 5);
            assert!((left - right).abs() < 1e-5, "{left} vs {right}");
            let bottom = fbm_tiled(y, 8.0, 8, 4, 5);
            let top = fbm_tiled(y, 0.0, 8, 4, 5);
            assert!((top - bottom).abs() < 1e-5);
        }
    }

    #[test]
    fn the_same_seed_produces_the_same_sequence() {
        let mut first = Rng::new(42);
        let mut second = Rng::new(42);
        for _ in 0..64 {
            assert_eq!(first.next_u32(), second.next_u32());
        }
    }

    #[test]
    fn different_seeds_diverge() {
        let mut first = Rng::new(1);
        let mut second = Rng::new(2);
        let differences = (0..64)
            .filter(|_| first.next_u32() != second.next_u32())
            .count();
        assert!(differences > 60);
    }
}
