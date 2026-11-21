//! What the renderer draws each frame. Grows with the runtime; every field
//! is plain data so gameplay code stays renderer-agnostic.

use std::sync::Arc;

use glam::Vec3;

use crate::geometry::WorldModel;
use crate::model::ModelInstance;

/// Procedural gradient sky (no cubemap assets required).
#[derive(Clone, Copy, Debug)]
pub struct Sky {
    pub zenith: Vec3,
    pub horizon: Vec3,
    /// Sun disc direction (pointing *from* the scene *towards* the sun).
    pub sun_dir: Vec3,
    pub sun_color: Vec3,
}

impl Default for Sky {
    fn default() -> Self {
        Self {
            // Dust-flavored defaults: warm horizon, desaturated blue zenith.
            zenith: Vec3::new(0.34, 0.48, 0.66),
            horizon: Vec3::new(0.87, 0.78, 0.62),
            sun_dir: Vec3::new(0.35, 0.65, 0.30).normalize(),
            sun_color: Vec3::new(1.0, 0.95, 0.85),
        }
    }
}

/// Quantized diffuse lighting for dynamic models.
///
/// `steps` counts the visible diffuse bands. Values below two retain a
/// continuous ramp. `wrap` moves the light boundary around curved surfaces;
/// zero is ordinary Lambert lighting and one is a half-Lambert-style wrap.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToonLighting {
    pub steps: u32,
    pub wrap: f32,
}

impl ToonLighting {
    pub const fn new(steps: u32, wrap: f32) -> Self {
        Self { steps, wrap }
    }
}

impl Default for ToonLighting {
    fn default() -> Self {
        Self {
            steps: 3,
            wrap: 0.0,
        }
    }
}

/// View-dependent edge light for dynamic models.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RimLighting {
    pub color: Vec3,
    pub strength: f32,
    pub power: f32,
}

impl RimLighting {
    pub const fn new(color: Vec3, strength: f32, power: f32) -> Self {
        Self {
            color,
            strength,
            power,
        }
    }
}

impl Default for RimLighting {
    fn default() -> Self {
        Self {
            color: Vec3::ONE,
            strength: 0.25,
            power: 3.0,
        }
    }
}

/// Linear world-space fog. Objects before `start` are unchanged and objects
/// at or beyond `end` reach `color`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DistanceFog {
    pub color: Vec3,
    pub start: f32,
    pub end: f32,
}

impl DistanceFog {
    pub const fn new(color: Vec3, start: f32, end: f32) -> Self {
        Self { color, start, end }
    }
}

/// Analytic lighting for dynamic models. World geometry retains its baked
/// lightmaps, while the optional distance fog is shared by both paths.
#[derive(Clone, Copy, Debug)]
pub struct ModelLighting {
    /// Direction from the scene towards the sun.
    pub sun_dir: Vec3,
    pub sun_color: Vec3,
    /// Colored shadow fill. Upward normals additionally receive cool fill
    /// from [`Sky::zenith`].
    pub ambient: Vec3,
    pub toon: Option<ToonLighting>,
    pub rim: Option<RimLighting>,
    pub fog: Option<DistanceFog>,
}

impl Default for ModelLighting {
    fn default() -> Self {
        Self {
            sun_dir: Vec3::new(0.35, 0.65, 0.30).normalize(),
            sun_color: Vec3::new(0.95, 0.9, 0.8),
            ambient: Vec3::new(0.42, 0.4, 0.38),
            toon: None,
            rim: None,
            fog: None,
        }
    }
}

/// A camera-facing quad (muzzle flashes, impact puffs). Additive-blended.
#[derive(Clone, Copy, Debug)]
pub struct Sprite {
    pub pos: Vec3,
    pub size: f32,
    pub color: [f32; 4],
}

/// A world-space line rendered as a view-aligned ribbon (tracers).
#[derive(Clone, Copy, Debug)]
pub struct Beam {
    pub a: Vec3,
    pub b: Vec3,
    pub width: f32,
    pub color: [f32; 4],
}

#[derive(Default)]
pub struct Scene {
    pub sky: Sky,
    /// Draw the procedural gradient sky behind 3D geometry even when no BSP
    /// world supplies sky-brush faces. Disabled by default for compatibility
    /// with transparent widgets and the historical horizon-color clear.
    pub draw_sky: bool,
    /// Clear the frame to fully transparent instead of the sky horizon.
    /// For widget-style windows whose surface composites over the desktop;
    /// meaningless when a `world` (with its sky pass) is present.
    pub transparent_clear: bool,
    pub lighting: ModelLighting,
    pub world: Option<Arc<WorldModel>>,
    /// Dynamic models (bots, props). Rebuilt or mutated per frame by the game.
    pub models: Vec<ModelInstance>,
    /// First-person weapon, drawn in its own depth range so it never clips
    /// into walls.
    pub viewmodel: Option<ModelInstance>,
    pub sprites: Vec<Sprite>,
    pub beams: Vec<Beam>,
    /// Seconds since startup (drives shader effects).
    pub time: f32,
}

#[cfg(test)]
mod tests {
    use super::Scene;

    #[test]
    fn stylized_rendering_is_opt_in() {
        let scene = Scene::default();
        assert!(!scene.draw_sky);
        assert!(scene.lighting.toon.is_none());
        assert!(scene.lighting.rim.is_none());
        assert!(scene.lighting.fog.is_none());
    }
}
