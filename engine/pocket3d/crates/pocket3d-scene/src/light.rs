//! The bake model: what the cooker resolves so the device does not have to.
//!
//! A GPU that can only multiply and add per pass still reproduces exact linear
//! aerial perspective if the cooker hands it the two terms of the lerp:
//!
//! ```text
//! pixel = albedo x lit + fog.rgb x fog.a      where lit already carries (1 - fog.a)
//! ```
//!
//! Both terms are stored gamma-encoded. A product of gamma-encoded values is
//! the gamma encoding of the product, so the multiply pass is exact; the
//! additive pass is the same gamma-space lerp that fixed-function fog has
//! always performed on this class of hardware.

use glam::Vec3;

use crate::math::{expf, powf};

/// Direct and ambient light, in linear radiance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lighting {
    /// Direction **towards** the sun, normalized.
    pub sun_dir: Vec3,
    pub sun_color: Vec3,
    /// Sky dome colors sampled by surface normal.
    pub sky_zenith: Vec3,
    pub sky_horizon: Vec3,
    /// Light returned by the ground onto downward-facing surfaces.
    pub bounce: Vec3,
    /// Scales the whole result before the tone curve.
    pub exposure: f32,
}

impl Default for Lighting {
    fn default() -> Self {
        Self {
            sun_dir: Vec3::new(0.45, 0.28, -0.85).normalize(),
            sun_color: Vec3::new(1.9, 1.32, 0.78),
            sky_zenith: Vec3::new(0.16, 0.24, 0.40),
            sky_horizon: Vec3::new(0.42, 0.44, 0.48),
            bounce: Vec3::new(0.16, 0.15, 0.12),
            exposure: 1.0,
        }
    }
}

impl Lighting {
    /// Linear radiance leaving a surface of unit albedo.
    ///
    /// `shadow` is 1 in full sun and 0 in shadow; `ao` is 1 in the open and 0
    /// in a fully enclosed corner. Both are the cooker's job to measure.
    pub fn shade(&self, normal: Vec3, shadow: f32, ao: f32) -> Vec3 {
        let lambert = normal.dot(self.sun_dir).max(0.0);
        let sun = self.sun_color * (lambert * shadow.clamp(0.0, 1.0));
        let up = normal.y * 0.5 + 0.5;
        let sky = self.sky_horizon.lerp(self.sky_zenith, up) * ao.clamp(0.0, 1.0);
        let down = (1.0 - up).clamp(0.0, 1.0);
        let bounce = self.bounce * (down * ao.clamp(0.0, 1.0));
        (sun + sky + bounce) * self.exposure
    }
}

/// Analytic exponential height fog with sun in-scattering.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FogModel {
    pub cool: Vec3,
    pub warm: Vec3,
    /// Density at `base_height`, per world unit.
    pub density: f32,
    pub base_height: f32,
    /// Density falls as `exp(-(height - base_height) * falloff)`.
    pub falloff: f32,
    /// How far the sun pulls the fog colour towards `warm`.
    pub inscatter: f32,
    /// Ceiling on coverage, so distant geometry keeps a trace of contrast.
    pub max: f32,
}

impl Default for FogModel {
    fn default() -> Self {
        Self {
            cool: Vec3::new(0.34, 0.44, 0.52),
            warm: Vec3::new(1.02, 0.70, 0.42),
            density: 0.0016,
            base_height: 0.0,
            falloff: 0.035,
            inscatter: 0.85,
            max: 0.97,
        }
    }
}

/// The two terms a constrained backend needs, already gamma-encoded.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FogTerms {
    /// `1 - coverage`, the factor folded into the multiply pass.
    pub transmittance: f32,
    /// Coverage in `0..=1`, the alpha of the additive pass.
    pub coverage: f32,
    /// Linear fog radiance, before tone mapping.
    pub color: Vec3,
}

impl FogModel {
    /// Integrate the density along `eye -> point` for a height-varying medium.
    ///
    /// For density `d(h) = d0 * exp(-(h - base) * k)` the optical depth over a
    /// straight segment has a closed form; the `k * dy -> 0` limit degrades to
    /// the constant-density case, which is what a level ray needs.
    pub fn optical_depth(&self, eye: Vec3, point: Vec3) -> f32 {
        let delta = point - eye;
        let distance = delta.length();
        if distance <= 1e-4 || self.density <= 0.0 {
            return 0.0;
        }
        let rise = delta.y;
        let at_eye = self.density * expf(-(eye.y - self.base_height) * self.falloff);
        let exponent = -self.falloff * rise;
        // The segment average of exp(t * exponent) over t in 0..1. The series
        // expansion covers the level-ray case, where the closed form is 0/0.
        let average = if exponent.abs() < 1e-4 {
            1.0 + exponent * 0.5
        } else {
            (expf(exponent) - 1.0) / exponent
        };
        (at_eye * average * distance).max(0.0)
    }

    /// Resolve the fog terms for a point seen from `eye`.
    pub fn terms(&self, eye: Vec3, point: Vec3, sun_dir: Vec3) -> FogTerms {
        let depth = self.optical_depth(eye, point);
        let coverage = (1.0 - expf(-depth)).clamp(0.0, self.max.clamp(0.0, 1.0));
        let view = (point - eye).normalize_or_zero();
        let towards = (view.dot(sun_dir) * 0.5 + 0.5).clamp(0.0, 1.0);
        let warmth = (powf(towards, 3.0) * self.inscatter).clamp(0.0, 1.0);
        FogTerms {
            transmittance: 1.0 - coverage,
            coverage,
            color: self.cool.lerp(self.warm, warmth),
        }
    }
}

/// Everything a per-vertex bake needs in one argument.
#[derive(Clone, Copy, Debug)]
pub struct BakeInputs {
    pub lighting: Lighting,
    pub fog: FogModel,
    /// The viewpoint the fog is baked for. A scene with one camera path bakes
    /// against its own route; an explorable scene bakes against its centre and
    /// accepts the parallax error.
    pub eye: Vec3,
    /// Coverage below this is not worth an additive pass.
    pub fog_epsilon: f32,
}

impl Default for BakeInputs {
    fn default() -> Self {
        Self {
            lighting: Lighting::default(),
            fog: FogModel::default(),
            eye: Vec3::ZERO,
            fog_epsilon: 1.0 / 255.0,
        }
    }
}

/// The packed pair stored in one vertex.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BakedVertexColor {
    /// Gamma-encoded `shade * (1 - coverage)` in ABGR.
    pub lit: u32,
    /// Gamma-encoded fog colour in RGB, coverage in A, in ABGR.
    pub fog: u32,
}

/// Filmic tone curve: keeps sunlit highlights from clipping to a flat plate.
pub fn tonemap(value: Vec3) -> Vec3 {
    fn channel(x: f32) -> f32 {
        let x = x.max(0.0);
        ((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0)
    }
    Vec3::new(channel(value.x), channel(value.y), channel(value.z))
}

/// Linear to display encoding. The device framebuffer is not sRGB-converting,
/// so the cooker encodes and the textures are authored in the same space.
pub fn gamma_encode(value: Vec3) -> Vec3 {
    Vec3::new(
        powf(value.x.clamp(0.0, 1.0), 1.0 / 2.2),
        powf(value.y.clamp(0.0, 1.0), 1.0 / 2.2),
        powf(value.z.clamp(0.0, 1.0), 1.0 / 2.2),
    )
}

pub fn gamma_decode(value: Vec3) -> Vec3 {
    Vec3::new(
        powf(value.x.clamp(0.0, 1.0), 2.2),
        powf(value.y.clamp(0.0, 1.0), 2.2),
        powf(value.z.clamp(0.0, 1.0), 2.2),
    )
}

/// Pack a display-space colour and alpha into the `ABGR` word both the GE and
/// GXM read as a `U8N` vertex colour.
pub fn pack_abgr(color: Vec3, alpha: f32) -> u32 {
    let to_byte = |value: f32| (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
    (to_byte(alpha) << 24) | (to_byte(color.z) << 16) | (to_byte(color.y) << 8) | to_byte(color.x)
}

/// Bake one vertex: shade it, fog it, and pack both terms.
///
/// `modulate` multiplies the shaded result, carrying per-vertex tint such as
/// the darkening towards the inside of a tree canopy.
pub fn bake_vertex(
    inputs: &BakeInputs,
    position: Vec3,
    normal: Vec3,
    shadow: f32,
    ao: f32,
    modulate: Vec3,
) -> BakedVertexColor {
    let shade = inputs.lighting.shade(normal, shadow, ao) * modulate;
    let fog = inputs.fog.terms(inputs.eye, position, inputs.lighting.sun_dir);
    let lit = gamma_encode(tonemap(shade)) * fog.transmittance;
    let fog_color = gamma_encode(tonemap(fog.color));
    BakedVertexColor {
        lit: pack_abgr(lit, 1.0),
        fog: pack_abgr(fog_color, fog.coverage),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_surface_facing_the_sun_is_brighter_than_one_facing_away() {
        let lighting = Lighting::default();
        let towards = lighting.shade(lighting.sun_dir, 1.0, 1.0);
        let away = lighting.shade(-lighting.sun_dir, 1.0, 1.0);
        assert!(towards.length() > away.length() * 2.0);
    }

    #[test]
    fn shadow_removes_only_the_sun_term() {
        let lighting = Lighting::default();
        let lit = lighting.shade(Vec3::Y, 1.0, 1.0);
        let shadowed = lighting.shade(Vec3::Y, 0.0, 1.0);
        let sun = lighting.sun_color * Vec3::Y.dot(lighting.sun_dir).max(0.0);
        assert!((lit - shadowed - sun).length() < 1e-5);
    }

    #[test]
    fn fog_coverage_grows_with_distance_and_saturates_below_one() {
        let fog = FogModel::default();
        let eye = Vec3::new(0.0, 2.0, 0.0);
        let near = fog.terms(eye, Vec3::new(0.0, 2.0, -50.0), Vec3::Y);
        let far = fog.terms(eye, Vec3::new(0.0, 2.0, -3000.0), Vec3::Y);
        assert!(near.coverage < far.coverage);
        assert!(far.coverage <= fog.max + 1e-6);
        assert!((near.transmittance + near.coverage - 1.0).abs() < 1e-6);
    }

    #[test]
    fn height_fog_thins_out_above_the_base() {
        let fog = FogModel::default();
        let low = fog.optical_depth(Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, 1.0, -400.0));
        let high = fog.optical_depth(Vec3::new(0.0, 120.0, 0.0), Vec3::new(0.0, 120.0, -400.0));
        assert!(high < low * 0.2);
    }

    #[test]
    fn looking_at_the_sun_warms_the_fog() {
        let fog = FogModel::default();
        let sun = Vec3::new(0.0, 0.2, -1.0).normalize();
        let towards = fog.terms(Vec3::ZERO, sun * 500.0, sun);
        let away = fog.terms(Vec3::ZERO, -sun * 500.0, sun);
        assert!(towards.color.x > away.color.x);
        assert!(towards.color.z < away.color.z);
    }

    #[test]
    fn packing_round_trips_through_abgr() {
        let packed = pack_abgr(Vec3::new(1.0, 0.0, 0.5), 0.25);
        assert_eq!(packed & 0xff, 255);
        assert_eq!((packed >> 8) & 0xff, 0);
        assert_eq!((packed >> 16) & 0xff, 128);
        assert_eq!((packed >> 24) & 0xff, 64);
    }

    #[test]
    fn a_fully_fogged_vertex_keeps_no_surface_light() {
        let mut inputs = BakeInputs::default();
        inputs.fog.density = 1.0;
        inputs.fog.max = 1.0;
        let baked = bake_vertex(
            &inputs,
            Vec3::new(0.0, 0.0, -900.0),
            Vec3::Y,
            1.0,
            1.0,
            Vec3::ONE,
        );
        assert_eq!(baked.lit & 0x00ff_ffff, 0);
        assert_eq!(baked.fog >> 24, 255);
    }
}
