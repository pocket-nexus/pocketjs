//! The two transcendental functions this crate needs, resolved against
//! whichever backend the target provides.
//!
//! Keeping them here lets the builder run unchanged on a no_std cooker, so a
//! device-side tool can cook a scene with the same code the desktop uses.

#[cfg(feature = "std")]
#[inline]
pub fn powf(value: f32, exponent: f32) -> f32 {
    value.powf(exponent)
}

#[cfg(feature = "std")]
#[inline]
pub fn expf(value: f32) -> f32 {
    value.exp()
}

#[cfg(feature = "std")]
#[inline]
pub fn roundf(value: f32) -> f32 {
    value.round()
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn powf(value: f32, exponent: f32) -> f32 {
    libm::powf(value, exponent)
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn expf(value: f32) -> f32 {
    libm::expf(value)
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn roundf(value: f32) -> f32 {
    libm::roundf(value)
}

#[cfg(all(not(feature = "std"), not(feature = "libm")))]
compile_error!("pocket3d-scene needs either the std or the libm feature for its math");

#[cfg(feature = "std")]
#[inline]
pub fn sinf(value: f32) -> f32 {
    value.sin()
}

#[cfg(feature = "std")]
#[inline]
pub fn cosf(value: f32) -> f32 {
    value.cos()
}

#[cfg(feature = "std")]
#[inline]
pub fn floorf(value: f32) -> f32 {
    value.floor()
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn sinf(value: f32) -> f32 {
    libm::sinf(value)
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn cosf(value: f32) -> f32 {
    libm::cosf(value)
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn floorf(value: f32) -> f32 {
    libm::floorf(value)
}

/// The fractional part of a non-negative value, in `0..1`.
///
/// Particle motion wraps on this rather than on `f32::fract`, because a phase
/// that has run negative should still come back inside the cycle.
#[inline]
pub fn wrap01(value: f32) -> f32 {
    value - floorf(value)
}

#[cfg(feature = "std")]
#[inline]
pub fn atan2f(y: f32, x: f32) -> f32 {
    y.atan2(x)
}

#[cfg(feature = "std")]
#[inline]
pub fn sqrtf(value: f32) -> f32 {
    value.sqrt()
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn atan2f(y: f32, x: f32) -> f32 {
    libm::atan2f(y, x)
}

#[cfg(all(not(feature = "std"), feature = "libm"))]
#[inline]
pub fn sqrtf(value: f32) -> f32 {
    libm::sqrtf(value)
}
