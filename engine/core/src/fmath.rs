//! f32 math without libm, shared by paint and physics.
//!
//! Every function is a fixed sequence of IEEE f32 operations (range reduction,
//! polynomials, Newton steps), so the same input gives the same bits on every
//! host. Paint rotates and shears with `sinf`/`cosf`/`tanf`; the physics core
//! also needs `atan2f` for pose decomposition and `exp_neg` for decay rates.

use crate::layout::floorf;

pub(crate) const PI: f32 = core::f32::consts::PI;
pub(crate) const TAU: f32 = 2.0 * PI;
/// Radians per degree.
pub(crate) const DEG: f32 = PI / 180.0;

/// sin for rotate: range-reduce to [-pi/2, pi/2], 5-term Taylor (max error
/// well under a hundredth of a pixel at screen scale). Deterministic f32.
pub(crate) fn sinf(x: f32) -> f32 {
    // reduce to [-pi, pi]
    let mut r = x - (2.0 * PI) * floorf((x + PI) / (2.0 * PI));
    // fold into [-pi/2, pi/2]
    if r > PI / 2.0 {
        r = PI - r;
    } else if r < -PI / 2.0 {
        r = -PI - r;
    }
    let x2 = r * r;
    r * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 + x2 * (1.0 / 362880.0)))))
}

#[inline]
pub(crate) fn cosf(x: f32) -> f32 {
    sinf(x + PI / 2.0)
}

/// tan as sin / cos (the skewX shear factor).
#[inline]
pub(crate) fn tanf(x: f32) -> f32 {
    sinf(x) / cosf(x)
}

#[inline]
pub(crate) fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut y = f32::from_bits((x.to_bits() >> 1) + 0x1fc0_0000);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y
}

/// atan2 by octant reduction and a degree-9 odd polynomial (|error| below
/// 1.5e-5 rad). Exactly 0 for (0, x > 0), so an unrotated pose stays
/// axis-aligned.
pub(crate) fn atan2f(y: f32, x: f32) -> f32 {
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let (ax, ay) = (absf(x), absf(y));
    let swap = ay > ax;
    let z = if swap { ax / ay } else { ay / ax };
    let s = z * z;
    let mut r = z * (0.999_866 + s * (-0.330_299_5 + s * (0.180_141 + s * (-0.085_133 + s * 0.020_835_1))));
    if swap {
        r = PI / 2.0 - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 {
        r = -r;
    }
    r
}

/// e^(-x) for x >= 0: halve into [0, 1/16], a 6-term series, square back.
pub(crate) fn exp_neg(x: f32) -> f32 {
    if !(x > 0.0) {
        return 1.0;
    }
    let mut x = x;
    let mut halvings = 0;
    while x > 0.0625 && halvings < 20 {
        x *= 0.5;
        halvings += 1;
    }
    let mut r = 1.0 - x * (1.0 - x * (0.5 - x * (1.0 / 6.0 - x * (1.0 / 24.0 - x * (1.0 / 120.0)))));
    for _ in 0..halvings {
        r *= r;
    }
    r
}

/// Wrap an angle into [-pi, pi).
#[inline]
pub(crate) fn wrap_angle(a: f32) -> f32 {
    a - TAU * floorf((a + PI) / TAU)
}

#[inline]
pub(crate) fn absf(x: f32) -> f32 {
    f32::from_bits(x.to_bits() & 0x7fff_ffff)
}

#[inline]
pub(crate) fn minf(a: f32, b: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}

#[inline]
pub(crate) fn maxf(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

#[inline]
pub(crate) fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

#[inline]
pub(crate) fn signf(x: f32) -> f32 {
    if x < 0.0 {
        -1.0
    } else {
        1.0
    }
}

#[inline]
pub(crate) fn lerpf(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atan2_matches_quadrants_and_keeps_zero_exact() {
        assert_eq!(atan2f(0.0, 1.0), 0.0);
        for &(y, x) in &[(1.0f32, 1.0f32), (1.0, -1.0), (-1.0, -1.0), (-1.0, 1.0), (0.3, 2.0), (2.0, 0.3), (-5.0, 0.1)] {
            let expected = (y as f64).atan2(x as f64) as f32;
            assert!(absf(atan2f(y, x) - expected) < 2e-5, "atan2({y}, {x})");
        }
    }

    #[test]
    fn exp_neg_tracks_the_series() {
        for &x in &[0.0f32, 0.01, 0.05, 0.3, 1.0, 4.0] {
            let expected = (-(x as f64)).exp() as f32;
            assert!(absf(exp_neg(x) - expected) <= 2e-6 + expected * 2e-5, "exp(-{x}) = {} vs {expected}", exp_neg(x));
        }
    }
}
