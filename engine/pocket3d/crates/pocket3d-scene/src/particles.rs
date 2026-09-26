//! Camera-facing quads for the scene's [`crate::format::Scatter`] volumes.
//!
//! Every particle's position is a pure function of its index and the clock, so
//! nothing has to be simulated, stored or resynchronized. A backend that drops
//! frames or resumes from suspend picks the motion up exactly where the clock
//! says it should be.

use glam::Vec3;

use crate::format::{Scatter, Scene};
use crate::light::{FogModel, gamma_encode, pack_abgr, tonemap};
use crate::math::{cosf, powf, sinf, wrap01};
use crate::runtime::{DynamicMesh, DynamicVertex, ViewPoint};

/// Limits on how much of a volume is worth building.
#[derive(Clone, Copy, Debug)]
pub struct ParticleSettings {
    /// Particles beyond this distance from the camera are skipped.
    pub max_distance: f32,
    /// Edge length of a petal, in metres.
    pub petal_size: f32,
    /// Radius of one mist puff, in metres.
    pub mist_size: f32,
    /// Overall opacity of the mist bank.
    pub mist_opacity: f32,
}

impl Default for ParticleSettings {
    fn default() -> Self {
        Self {
            max_distance: 190.0,
            petal_size: 0.13,
            mist_size: 17.0,
            mist_opacity: 0.30,
        }
    }
}

fn hash(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^= value >> 16;
    value
}

fn unit(index: u32, salt: u32) -> f32 {
    (hash(index.wrapping_mul(0x9e37_79b9).wrapping_add(salt)) >> 8) as f32 / 16_777_216.0
}

fn fog_model(scene: &Scene<'_>) -> FogModel {
    let header = scene.header;
    FogModel {
        cool: header.fog_cool,
        warm: header.fog_warm,
        density: header.fog_density,
        base_height: header.water_level,
        falloff: header.fog_height_falloff,
        inscatter: header.fog_inscatter,
        max: header.fog_max,
    }
}

/// Append one camera-facing quad.
#[allow(clippy::too_many_arguments)]
fn quad(
    mesh: &mut DynamicMesh,
    view: &ViewPoint,
    center: Vec3,
    half_size: f32,
    spin: f32,
    lit: u32,
    fog: u32,
) {
    if mesh.would_overflow(4) {
        return;
    }
    let (sin, cos) = (sinf(spin), cosf(spin));
    let right = (view.right * cos + view.up * sin) * half_size;
    let up = (view.up * cos - view.right * sin) * half_size;
    let corners = [
        (center - right - up, [0.0, 1.0]),
        (center + right - up, [1.0, 1.0]),
        (center + right + up, [1.0, 0.0]),
        (center - right + up, [0.0, 0.0]),
    ];
    let first = mesh.vertices.len() as u16;
    for (position, uv) in corners {
        mesh.push_vertex(DynamicVertex::new(position, uv, lit, fog));
    }
    mesh.push_quad(first, first + 1, first + 2, first + 3);
}

/// Blossom drifting down through the near field.
///
/// The volume follows the camera instead of staying where it was cooked, so a
/// drifting viewer always has petals around them without the cooker having to
/// fill the whole valley with particles.
pub fn build_petals(
    mesh: &mut DynamicMesh,
    scene: &Scene<'_>,
    view: &ViewPoint,
    time: f32,
    scatter: &Scatter,
    settings: &ParticleSettings,
) {
    mesh.clear();
    let fog = fog_model(scene);
    let span = scatter.max - scatter.min;
    if span.y <= 0.0 {
        return;
    }
    // Centre the volume on the camera in the ground plane, keep the cooked
    // vertical extent.
    let base = Vec3::new(
        view.eye.x - span.x * 0.5,
        scatter.min.y,
        view.eye.z - span.z * 0.5,
    );
    let sun = scene.header.sun_dir;
    for index in 0..scatter.count as u32 {
        let phase = unit(index, 0x11);
        let fall = scatter.rate * (0.6 + 0.8 * unit(index, 0x22));
        // One cycle from the top of the volume to the bottom, wrapped.
        let cycle = wrap01(time * fall / span.y.max(1.0) + phase);
        let sway = sinf(time * (0.7 + unit(index, 0x33)) + phase * 6.28);
        let swirl = cosf(time * (0.5 + unit(index, 0x44)) + phase * 4.1);
        let position = base
            + Vec3::new(
                unit(index, 0x55) * span.x + sway * 1.4,
                span.y * (1.0 - cycle),
                unit(index, 0x66) * span.z + swirl * 1.1,
            );
        let offset = position - view.eye;
        let distance = offset.length();
        if distance > settings.max_distance || offset.dot(view.forward) < 0.0 {
            continue;
        }
        // Petals fade in as they enter and out as they reach the water.
        let life = (cycle * 6.0).min(1.0) * ((1.0 - cycle) * 5.0).min(1.0);
        if life <= 0.02 {
            continue;
        }
        let terms = fog.terms(view.eye, position, sun);
        // A petal catching the light from the side is brighter than its face.
        let facing = 0.55 + 0.45 * sinf(time * 2.1 + phase * 9.0).abs();
        let color = Vec3::new(1.0, 0.86, 0.9) * facing;
        let lit = gamma_encode(tonemap(color)) * terms.transmittance;
        quad(
            mesh,
            view,
            position,
            settings.petal_size * 0.5,
            time * (0.9 + unit(index, 0x77) * 2.4) + phase * 6.28,
            pack_abgr(lit, life),
            pack_abgr(gamma_encode(tonemap(terms.color)), terms.coverage),
        );
    }
}

/// Low mist banks lying on the water.
pub fn build_mist(
    mesh: &mut DynamicMesh,
    scene: &Scene<'_>,
    view: &ViewPoint,
    time: f32,
    scatter: &Scatter,
    settings: &ParticleSettings,
) {
    mesh.clear();
    let fog = fog_model(scene);
    let span = scatter.max - scatter.min;
    let sun = scene.header.sun_dir;
    let wind = Vec3::new(
        scene.header.wind_dir[0],
        0.0,
        scene.header.wind_dir[1],
    )
    .normalize_or(Vec3::NEG_Z);
    for index in 0..scatter.count as u32 {
        let phase = unit(index, 0x91);
        // Puffs travel downstream and wrap, so the bank never thins out.
        let travel = wrap01(time * scatter.rate * 0.02 + phase);
        let (river_x, half_width) = scene.river_at(scatter.min.z + span.z * travel);
        let position = Vec3::new(
            river_x + (unit(index, 0xa2) - 0.5) * half_width * 3.2,
            scatter.min.y + span.y * powf(unit(index, 0xb3), 1.8),
            scatter.min.z + span.z * travel,
        ) + wind * (sinf(time * 0.35 + phase * 3.0) * 4.0);
        let offset = position - view.eye;
        let distance = offset.length();
        // Mist reads from much further away than petals do.
        if distance > settings.max_distance * 3.0 || offset.dot(view.forward) < -0.3 {
            continue;
        }
        // A puff right on top of the camera would wash the frame out.
        let near_fade = ((distance - settings.mist_size * 0.6) / settings.mist_size).clamp(0.0, 1.0);
        let terms = fog.terms(view.eye, position, sun);
        // Mist takes the fog's own colour, so it thickens the same air.
        let color = terms.color * 1.12;
        let lit = gamma_encode(tonemap(color)) * terms.transmittance;
        let alpha = settings.mist_opacity * near_fade * (0.7 + 0.3 * sinf(phase * 6.28));
        quad(
            mesh,
            view,
            position,
            settings.mist_size * (0.7 + 0.6 * unit(index, 0xc4)),
            phase * 6.28,
            pack_abgr(lit, alpha),
            pack_abgr(gamma_encode(tonemap(terms.color)), terms.coverage * 0.5),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{Mesh, SceneBuilder};
    use crate::format::{Material, MaterialKind, RiverSample, ScatterKind};
    use crate::light::BakedVertexColor;
    use alloc::vec::Vec;

    fn scene_bytes() -> Vec<u8> {
        let mut builder = SceneBuilder::new();
        builder.header.sun_dir = Vec3::new(0.3, 0.18, -0.94).normalize();
        builder.header.fog_cool = Vec3::new(0.40, 0.49, 0.58);
        builder.header.fog_warm = Vec3::new(1.25, 0.86, 0.54);
        builder.header.fog_density = 0.002;
        builder.header.fog_height_falloff = 0.026;
        builder.header.fog_inscatter = 0.9;
        builder.header.fog_max = 0.98;
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
        builder.set_river(alloc::vec![
            RiverSample { z: -400.0, x: 0.0, half_width: 14.0, depth: 2.5 },
            RiverSample { z: 100.0, x: 6.0, half_width: 16.0, depth: 2.5 },
        ]);
        builder.finish().unwrap()
    }

    fn petal_scatter() -> Scatter {
        Scatter {
            kind: ScatterKind::Petal,
            count: 120,
            min: Vec3::new(-60.0, 0.0, -60.0),
            max: Vec3::new(60.0, 24.0, 60.0),
            rate: 0.8,
        }
    }

    #[test]
    fn petals_are_built_in_front_of_the_camera_and_face_it() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let view = ViewPoint::new(Vec3::new(0.0, 2.0, 0.0), Vec3::NEG_Z);
        let mut mesh = DynamicMesh::new();
        build_petals(&mut mesh, &scene, &view, 4.0, &petal_scatter(), &ParticleSettings::default());
        assert!(mesh.triangle_count() > 8, "{}", mesh.triangle_count());
        // Every particle is one quad: four vertices, two triangles.
        assert_eq!(mesh.vertices.len(), mesh.triangle_count() * 2);
        assert_eq!(mesh.vertices.len() % 4, 0);
        for vertex in &mesh.vertices {
            assert!((vertex.position() - view.eye).dot(view.forward) > -1.0);
        }
    }

    #[test]
    fn the_petal_field_follows_the_camera() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let mut first = DynamicMesh::new();
        let mut second = DynamicMesh::new();
        let settings = ParticleSettings::default();
        build_petals(
            &mut first,
            &scene,
            &ViewPoint::new(Vec3::new(0.0, 2.0, 0.0), Vec3::NEG_Z),
            4.0,
            &petal_scatter(),
            &settings,
        );
        build_petals(
            &mut second,
            &scene,
            &ViewPoint::new(Vec3::new(0.0, 2.0, -400.0), Vec3::NEG_Z),
            4.0,
            &petal_scatter(),
            &settings,
        );
        assert!(first.triangle_count() > 0 && second.triangle_count() > 0);
        let centroid = |mesh: &DynamicMesh| {
            mesh.vertices
                .iter()
                .map(|vertex| vertex.position())
                .fold(Vec3::ZERO, |sum, value| sum + value)
                / mesh.vertices.len() as f32
        };
        assert!(centroid(&first).z - centroid(&second).z > 300.0);
    }

    #[test]
    fn particle_motion_is_a_pure_function_of_the_clock() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let view = ViewPoint::new(Vec3::new(0.0, 2.0, 0.0), Vec3::NEG_Z);
        let settings = ParticleSettings::default();
        let mut first = DynamicMesh::new();
        let mut second = DynamicMesh::new();
        build_petals(&mut first, &scene, &view, 7.25, &petal_scatter(), &settings);
        build_petals(&mut second, &scene, &view, 7.25, &petal_scatter(), &settings);
        assert_eq!(first.vertices, second.vertices);
    }

    #[test]
    fn mist_lies_low_over_the_water() {
        let bytes = scene_bytes();
        let scene = Scene::parse(&bytes).unwrap();
        let view = ViewPoint::new(Vec3::new(0.0, 2.0, 0.0), Vec3::NEG_Z);
        let scatter = Scatter {
            kind: ScatterKind::Mist,
            count: 40,
            min: Vec3::new(-100.0, 0.4, -380.0),
            max: Vec3::new(100.0, 7.0, 80.0),
            rate: 0.35,
        };
        let mut mesh = DynamicMesh::new();
        build_mist(&mut mesh, &scene, &view, 12.0, &scatter, &ParticleSettings::default());
        assert!(mesh.triangle_count() > 4);
        // Each quad's centre is the puff's own position; the corners fan out
        // around it by up to its radius, so the centres are what to check.
        for quad in mesh.vertices.chunks_exact(4) {
            let height = quad.iter().map(|vertex| vertex.y).sum::<f32>() / 4.0;
            assert!(
                (scatter.min.y..=scatter.max.y).contains(&height),
                "a puff sat at {height}"
            );
        }
    }
}
