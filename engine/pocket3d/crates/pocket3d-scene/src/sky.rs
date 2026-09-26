//! The sky dome and its cloud band.
//!
//! The horizon ring is deliberately the fog colour rather than a separate sky
//! colour. Fully fogged geometry converges on the fog colour, so making the
//! sky meet it exactly is what lets a ridge dissolve into the distance instead
//! of ending at a visible line.

use alloc::vec::Vec;

use glam::Vec3;

use crate::format::Scene;
use crate::light::{gamma_encode, pack_abgr, tonemap};
use crate::math::{cosf, powf, sinf};
use crate::runtime::{DynamicMesh, DynamicVertex, ViewPoint};

#[derive(Clone, Copy, Debug)]
pub struct SkySettings {
    /// Radius of the dome, in world units. It only needs to sit outside every
    /// other surface, not at the far plane.
    pub radius: f32,
    /// Segments around the horizon.
    pub segments: usize,
    /// Rings from the horizon to the zenith.
    pub rings: usize,
    /// Elevation band the cloud sheet occupies, in radians.
    pub cloud_low: f32,
    pub cloud_high: f32,
}

impl Default for SkySettings {
    fn default() -> Self {
        Self {
            radius: 1500.0,
            segments: 24,
            rings: 7,
            cloud_low: 0.09,
            cloud_high: 0.62,
        }
    }
}

/// The dome's colour looking along `direction`, in linear radiance.
pub fn sample(scene: &Scene<'_>, direction: Vec3) -> Vec3 {
    let header = scene.header;
    let elevation = direction.normalize_or(Vec3::Y).y.clamp(-1.0, 1.0);
    let sun = header.sun_dir.normalize_or(Vec3::Y);

    // Towards the sun the horizon is the warm fog colour; away from it, cool.
    let towards = (direction.normalize_or(Vec3::NEG_Z).dot(sun) * 0.5 + 0.5).clamp(0.0, 1.0);
    let horizon = header
        .fog_cool
        .lerp(header.fog_warm, powf(towards, 2.2) * header.fog_inscatter);
    // Blend the authored horizon tint in above the haze line.
    let horizon = horizon.lerp(header.sky_horizon, 0.35);

    // The gradient climbs fast off the horizon, so the band of haze stays
    // shallow and the dome above it keeps its colour instead of washing out.
    let up = powf(elevation.max(0.0), 0.42);
    let mut color = horizon.lerp(header.sky_zenith, up);

    // A broad glow around the sun, a tighter halo, then the disc itself.
    let angle = direction.normalize_or(Vec3::NEG_Z).dot(sun).clamp(-1.0, 1.0);
    color += header.sky_sun_glow * powf(angle.max(0.0), 6.0) * 0.40;
    color += header.sky_sun_glow * powf(angle.max(0.0), 90.0) * 1.30;
    color += header.sky_sun_glow * powf(angle.max(0.0), 2600.0) * 9.0;
    color
}

/// Rebuild the dome around the camera.
pub fn build(
    mesh: &mut DynamicMesh,
    scene: &Scene<'_>,
    view: &ViewPoint,
    settings: &SkySettings,
) {
    mesh.clear();
    if settings.segments < 3 || settings.rings < 2 {
        return;
    }
    let mut previous: Vec<u16> = Vec::with_capacity(settings.segments + 1);
    let mut current: Vec<u16> = Vec::with_capacity(settings.segments + 1);
    for ring in 0..=settings.rings {
        // Rings bunch towards the horizon, where the gradient is steepest.
        let t = ring as f32 / settings.rings as f32;
        let elevation = powf(t, 1.7) * core::f32::consts::FRAC_PI_2;
        // Start slightly below the horizon so the dome closes under the fog.
        let elevation = elevation - 0.13;
        current.clear();
        for segment in 0..=settings.segments {
            let azimuth = segment as f32 / settings.segments as f32 * core::f32::consts::TAU;
            let direction = Vec3::new(
                cosf(azimuth) * cosf(elevation),
                sinf(elevation),
                sinf(azimuth) * cosf(elevation),
            );
            let color = gamma_encode(tonemap(sample(scene, direction)));
            current.push(mesh.push_vertex(DynamicVertex::new(
                view.eye + direction * settings.radius,
                [0.0, 0.0],
                pack_abgr(color, 1.0),
                // The dome is the far field itself, so it carries no fog.
                0,
            )));
        }
        if ring > 0 {
            for segment in 0..settings.segments {
                mesh.push_quad(
                    previous[segment],
                    previous[segment + 1],
                    current[segment + 1],
                    current[segment],
                );
            }
        }
        core::mem::swap(&mut previous, &mut current);
    }
}

/// Rebuild the cloud band: one textured ring inside the dome.
pub fn build_clouds(
    mesh: &mut DynamicMesh,
    scene: &Scene<'_>,
    view: &ViewPoint,
    time: f32,
    settings: &SkySettings,
) {
    mesh.clear();
    if settings.segments < 3 {
        return;
    }
    let radius = settings.radius * 0.92;
    let header = scene.header;
    let sun = header.sun_dir.normalize_or(Vec3::Y);
    // The sheet drifts with the scene wind, slowly.
    let drift = time * header.wind_strength * 0.004;
    let mut low: Vec<u16> = Vec::with_capacity(settings.segments + 1);
    let mut high: Vec<u16> = Vec::with_capacity(settings.segments + 1);
    for segment in 0..=settings.segments {
        let t = segment as f32 / settings.segments as f32;
        let azimuth = t * core::f32::consts::TAU;
        let flat = Vec3::new(cosf(azimuth), 0.0, sinf(azimuth));
        // Clouds lit from the side the sun is on.
        let towards = (flat.dot(sun) * 0.5 + 0.5).clamp(0.0, 1.0);
        // Cloud undersides take the sun from whichever side it is on, which
        // is most of what makes a flat band read as lit volume.
        let tint = header
            .sky_zenith
            .lerp(header.sky_sun_glow, powf(towards, 1.5) * 0.95)
            * 1.45;
        let color = gamma_encode(tonemap(tint));
        for (elevation, row, store) in [
            (settings.cloud_low, 1.0f32, &mut low),
            (settings.cloud_high, 0.0f32, &mut high),
        ] {
            let direction = Vec3::new(
                flat.x * cosf(elevation),
                sinf(elevation),
                flat.z * cosf(elevation),
            );
            store.push(mesh.push_vertex(DynamicVertex::new(
                view.eye + direction * radius,
                [t * 4.0 + drift, row],
                pack_abgr(color, 1.0),
                0,
            )));
        }
    }
    for segment in 0..settings.segments {
        mesh.push_quad(
            low[segment],
            low[segment + 1],
            high[segment + 1],
            high[segment],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{Mesh, SceneBuilder};
    use crate::format::{Material, MaterialKind};
    use crate::light::BakedVertexColor;

    fn scene_bytes() -> alloc::vec::Vec<u8> {
        let mut builder = SceneBuilder::new();
        builder.header.sun_dir = Vec3::new(0.3, 0.18, -0.94).normalize();
        builder.header.sky_zenith = Vec3::new(0.15, 0.23, 0.42);
        builder.header.sky_horizon = Vec3::new(0.86, 0.72, 0.58);
        builder.header.sky_sun_glow = Vec3::new(1.45, 0.92, 0.55);
        builder.header.fog_cool = Vec3::new(0.40, 0.49, 0.58);
        builder.header.fog_warm = Vec3::new(1.25, 0.86, 0.54);
        builder.header.fog_inscatter = 0.92;
        builder.header.lod_distances = [90.0, 300.0, 1200.0];
        builder.add_texture("flat", 2, 2, &[255u8; 16], false).unwrap();
        let material = builder.add_material(Material {
            texture: 0,
            kind: MaterialKind::Opaque,
            flags: 0,
            tint: [255; 4],
            sort_bias: 0.0,
        });
        let mut mesh = Mesh::new();
        let color = BakedVertexColor {
            lit: 0xffff_ffff,
            fog: 0,
        };
        let a = mesh.push_vertex(Vec3::ZERO, [0.0, 0.0], color);
        let b = mesh.push_vertex(Vec3::X, [1.0, 0.0], color);
        let c = mesh.push_vertex(Vec3::Z, [0.0, 1.0], color);
        mesh.push_triangle(a, b, c);
        builder.add_mesh(&mesh, material, 0xff, 0).unwrap();
        builder.finish().unwrap()
    }

    #[test]
    fn the_zenith_is_cooler_and_darker_than_the_horizon() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let zenith = sample(&scene, Vec3::Y);
        let horizon = sample(&scene, Vec3::new(1.0, 0.02, 0.0));
        assert!(horizon.x > zenith.x, "{horizon:?} vs {zenith:?}");
        assert!(zenith.z / zenith.x > horizon.z / horizon.x);
    }

    #[test]
    fn looking_at_the_sun_is_the_brightest_direction() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let towards = sample(&scene, scene.header.sun_dir);
        let away = sample(&scene, -scene.header.sun_dir);
        assert!(towards.length() > away.length() * 3.0);
    }

    #[test]
    fn the_dome_closes_around_the_camera() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let mut mesh = DynamicMesh::new();
        let settings = SkySettings::default();
        let view = ViewPoint::new(Vec3::new(10.0, 3.0, -20.0), Vec3::NEG_Z);
        build(&mut mesh, &scene, &view, &settings);
        assert_eq!(mesh.triangle_count(), settings.segments * settings.rings * 2);
        for vertex in &mesh.vertices {
            let offset = vertex.position() - view.eye;
            assert!((offset.length() - settings.radius).abs() < 1.0);
            // Nothing pokes below the fog line the dome is meant to close at.
            assert!(offset.y > -settings.radius * 0.2);
        }
    }

    #[test]
    fn the_cloud_band_wraps_without_a_seam() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let mut mesh = DynamicMesh::new();
        let settings = SkySettings::default();
        let view = ViewPoint::new(Vec3::ZERO, Vec3::NEG_Z);
        build_clouds(&mut mesh, &scene, &view, 3.0, &settings);
        let first = mesh.vertices[0].position();
        let last = mesh.vertices[mesh.vertices.len() - 2].position();
        assert!((first - last).length() < 1.0, "{first:?} vs {last:?}");
    }
}
