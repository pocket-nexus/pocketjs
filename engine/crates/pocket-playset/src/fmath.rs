//! f32 math without libm. Fixed IEEE f32 sequences, so a step gives the same
//! bits on the 3DS, the desktop and wasm.

pub const PI: f32 = core::f32::consts::PI;
pub const TAU: f32 = 2.0 * PI;
pub const HALF_PI: f32 = PI / 2.0;

#[inline]
pub fn absf(x: f32) -> f32 {
    f32::from_bits(x.to_bits() & 0x7fff_ffff)
}

#[inline]
pub fn floorf(x: f32) -> f32 {
    if !(absf(x) < 8_388_608.0) {
        return x;
    }
    let t = x as i32 as f32;
    if t > x {
        t - 1.0
    } else {
        t
    }
}

#[inline]
pub fn roundf(x: f32) -> f32 {
    floorf(x + 0.5)
}

#[inline]
pub fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

#[inline]
pub fn minf(a: f32, b: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}

#[inline]
pub fn maxf(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

#[inline]
pub fn signf(x: f32) -> f32 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}

#[inline]
pub fn lerpf(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// sin over all reals: reduce to [-pi, pi], fold to [-pi/2, pi/2], odd
/// polynomial (error below 1e-6).
pub fn sinf(x: f32) -> f32 {
    let mut r = x - TAU * floorf((x + PI) / TAU);
    if r > HALF_PI {
        r = PI - r;
    } else if r < -HALF_PI {
        r = -PI - r;
    }
    let x2 = r * r;
    r * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 + x2 * (1.0 / 362_880.0)))))
}

#[inline]
pub fn cosf(x: f32) -> f32 {
    sinf(x + HALF_PI)
}

#[inline]
pub fn tanf(x: f32) -> f32 {
    sinf(x) / cosf(x)
}

pub fn sqrtf(x: f32) -> f32 {
    if !(x > 0.0) {
        return 0.0;
    }
    let mut y = f32::from_bits((x.to_bits() >> 1) + 0x1fc0_0000);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    0.5 * (y + x / y)
}

/// 1/sqrt for normalizing (one Newton step past the bit estimate, two more
/// for f32 precision).
pub fn rsqrtf(x: f32) -> f32 {
    if !(x > 0.0) {
        return 0.0;
    }
    let half = 0.5 * x;
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    y *= 1.5 - half * y * y;
    y *= 1.5 - half * y * y;
    y * (1.5 - half * y * y)
}

/// atan2 by octant reduction and an odd polynomial (|error| below 1.5e-5).
pub fn atan2f(y: f32, x: f32) -> f32 {
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let (ax, ay) = (absf(x), absf(y));
    let swap = ay > ax;
    let z = if swap { ax / ay } else { ay / ax };
    let s = z * z;
    let mut r = z * (0.999_866 + s * (-0.330_299_5 + s * (0.180_141 + s * (-0.085_133 + s * 0.020_835_1))));
    if swap {
        r = HALF_PI - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 {
        -r
    } else {
        r
    }
}

pub fn asinf(x: f32) -> f32 {
    let c = clampf(x, -1.0, 1.0);
    atan2f(c, sqrtf(1.0 - c * c))
}

/// e^x for |x| < ~80: split into 2^k * e^r with |r| <= ln2/2.
pub fn expf(x: f32) -> f32 {
    if x < -80.0 {
        return 0.0;
    }
    if x > 80.0 {
        return f32::MAX;
    }
    const LN2: f32 = 0.693_147_2;
    let k = floorf(x / LN2 + 0.5);
    let r = x - k * LN2;
    let p = 1.0 + r * (1.0 + r * (0.5 + r * (1.0 / 6.0 + r * (1.0 / 24.0 + r * (1.0 / 120.0 + r / 720.0)))));
    let bits = ((k as i32 + 127).clamp(1, 254) as u32) << 23;
    p * f32::from_bits(bits)
}

/// Frame-rate independent smoothing factor: 1 - e^(-rate * dt).
#[inline]
pub fn smoothing(rate: f32, dt: f32) -> f32 {
    if rate <= 0.0 {
        1.0
    } else {
        1.0 - expf(-rate * dt)
    }
}

/// Wrap an angle into [-pi, pi].
#[inline]
pub fn wrap_angle(a: f32) -> f32 {
    a - TAU * floorf((a + PI) / TAU)
}

/// Move `a` toward `b` by at most `step` around the circle.
pub fn approach_angle(a: f32, b: f32, step: f32) -> f32 {
    let d = wrap_angle(b - a);
    if absf(d) <= step {
        b
    } else {
        a + signf(d) * step
    }
}

/// Move a value toward a target by at most `step`.
#[inline]
pub fn approach(a: f32, b: f32, step: f32) -> f32 {
    if a < b {
        minf(a + step, b)
    } else {
        maxf(a - step, b)
    }
}

/// Mulberry32, the generator GameBlocks seeds everything from.
#[derive(Clone, Copy)]
pub struct Rng(pub u32);

impl Rng {
    pub fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
    /// [0, 1)
    pub fn next(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    /// [-1, 1)
    pub fn signed(&mut self) -> f32 {
        self.next() * 2.0 - 1.0
    }
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}

/// Integer hash for value noise.
#[inline]
pub fn hash2(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(374_761_393) ^ (y as u32).wrapping_mul(668_265_263) ^ seed.wrapping_mul(2_246_822_519);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    (h >> 8) as f32 * (1.0 / 16_777_216.0)
}

/// Smooth value noise in [0, 1).
pub fn noise2(x: f32, y: f32, seed: u32) -> f32 {
    let xi = floorf(x);
    let yi = floorf(y);
    let fx = x - xi;
    let fy = y - yi;
    let (ix, iy) = (xi as i32, yi as i32);
    let ux = fx * fx * (3.0 - 2.0 * fx);
    let uy = fy * fy * (3.0 - 2.0 * fy);
    let a = hash2(ix, iy, seed);
    let b = hash2(ix + 1, iy, seed);
    let c = hash2(ix, iy + 1, seed);
    let d = hash2(ix + 1, iy + 1, seed);
    lerpf(lerpf(a, b, ux), lerpf(c, d, ux), uy)
}

/// Fractal value noise in [-1, 1).
pub fn fbm2(x: f32, y: f32, octaves: u32, seed: u32) -> f32 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut norm = 0.0;
    for o in 0..octaves {
        sum += amp * (noise2(x * freq, y * freq, seed.wrapping_add(o * 101)) * 2.0 - 1.0);
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    if norm > 0.0 {
        sum / norm
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trig_is_close() {
        let mut x = -10.0f32;
        while x < 10.0 {
            assert!((sinf(x) - x.sin()).abs() < 1e-5, "sin {x}");
            assert!((cosf(x) - x.cos()).abs() < 1e-5, "cos {x}");
            x += 0.137;
        }
        for &(y, x) in &[(1.0f32, 2.0f32), (-3.0, 0.5), (0.2, -4.0), (-1.0, -1.0)] {
            assert!((atan2f(y, x) - y.atan2(x)).abs() < 2e-5);
        }
    }

    #[test]
    fn roots_and_exp() {
        for &v in &[0.01f32, 1.0, 2.0, 123.4, 9999.0] {
            assert!((sqrtf(v) - v.sqrt()).abs() / v.sqrt() < 1e-6);
            assert!((rsqrtf(v) - 1.0 / v.sqrt()).abs() * v.sqrt() < 1e-5);
        }
        for &v in &[-5.0f32, -0.3, 0.0, 0.7, 3.2] {
            assert!((expf(v) - v.exp()).abs() / v.exp() < 1e-5, "exp {v}");
        }
    }

    #[test]
    fn mulberry_matches_gameblocks() {
        // RandomGenerator(1).next() in GameBlocks RandomUtils.js
        let mut r = Rng(1);
        let first = r.next_u32();
        assert_eq!(first, 2_693_262_067);
    }
}
