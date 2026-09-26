//! The river surface, rebuilt every frame around the camera.
//!
//! A backend with no fragment maths of its own still gets moving water here:
//! the mesh carries a travelling wave in its positions, a scrolling texture in
//! its UVs, and reflection, sun glitter and shore foam resolved per vertex into
//! the same `lit`/`fog` pair the cooked geometry uses.
//!
//! The grid is laid out in river space and centred on the camera, so its
//! density follows the viewer down the valley and the shoreline always lands
//! on a column.

use alloc::vec::Vec;

use glam::Vec3;

use crate::format::Scene;
use crate::light::{FogModel, gamma_encode, pack_abgr, tonemap};
use crate::math::{cosf, powf, sinf, wrap01};
use crate::runtime::{DynamicMesh, DynamicVertex, ViewPoint};

/// How much river to build, and how finely.
#[derive(Clone, Copy, Debug)]
pub struct WaterSettings {
    /// Rows from the camera downstream; the grid stretches as it recedes.
    pub rows: usize,
    /// Columns across the channel, including the overlap onto each bank.
    pub columns: usize,
    /// How far upstream of the camera the sheet starts.
    pub behind: f32,
    /// How far downstream it reaches.
    pub ahead: f32,
    /// How far past the water's edge the sheet runs, so the bank geometry
    /// always overlaps it instead of leaving a gap.
    pub bank_overlap: f32,
}

impl Default for WaterSettings {
    fn default() -> Self {
        Self {
            rows: 40,
            columns: 15,
            behind: 45.0,
            ahead: 620.0,
            bank_overlap: 4.5,
        }
    }
}

/// Height of the travelling wave at a point, and its surface normal.
///
/// Two long fronts running down the valley plus a shorter cross-chop. All
/// three are cheap sines, which is what keeps a whole sheet inside the CPU
/// budget on a handheld.
pub fn wave(point: Vec3, time: f32, amplitude: f32, length: f32, speed: f32) -> (f32, Vec3) {
    let k = core::f32::consts::TAU / length.max(0.5);
    let along = point.z * k + time * speed * k * 6.0;
    let across = point.x * k * 0.63 - time * speed * k * 2.2;
    let chop = (point.x + point.z) * k * 1.9 + time * speed * k * 9.0;

    let (sin_a, cos_a) = (sinf(along), cosf(along));
    let (sin_b, cos_b) = (sinf(across), cosf(across));
    let (sin_c, cos_c) = (sinf(chop), cosf(chop));

    // Weights sum to one, so `amplitude` is the true crest height.
    const LONG: f32 = 0.60;
    const CROSS: f32 = 0.27;
    const CHOP: f32 = 0.13;
    let height = amplitude * (sin_a * LONG + sin_b * CROSS + sin_c * CHOP);
    // Analytic slope, so the glitter tracks the crests exactly.
    let slope_x = amplitude * k * (cos_b * CROSS * 0.63 + cos_c * CHOP * 1.9);
    let slope_z = amplitude * k * (cos_a * LONG + cos_c * CHOP * 1.9);
    (height, Vec3::new(-slope_x, 1.0, -slope_z).normalize())
}

/// Rebuild `mesh` as the river seen from `view`.
pub fn build(
    mesh: &mut DynamicMesh,
    scene: &Scene<'_>,
    view: &ViewPoint,
    time: f32,
    settings: &WaterSettings,
) {
    mesh.clear();
    if scene.river.is_empty() || settings.rows < 2 || settings.columns < 2 {
        return;
    }
    let water = scene.water;
    let header = scene.header;
    let fog = FogModel {
        cool: header.fog_cool,
        warm: header.fog_warm,
        density: header.fog_density,
        base_height: header.water_level,
        falloff: header.fog_height_falloff,
        inscatter: header.fog_inscatter,
        max: header.fog_max,
    };
    let sun = header.sun_dir.normalize_or(Vec3::Y);
    // What the surface mirrors: mostly the low sky, warmed towards the sun.
    let sky = header.sky_horizon.lerp(header.sky_zenith, 0.3);

    let first_z = scene.river[0].z;
    let last_z = scene.river[scene.river.len() - 1].z;
    let start = (view.eye.z + settings.behind).min(last_z);
    let end = (view.eye.z - settings.ahead).max(first_z);

    let rows = settings.rows;
    let columns = settings.columns;
    let mut row_vertices = Vec::with_capacity(columns);
    let mut previous_row: Vec<u16> = Vec::with_capacity(columns);

    for row in 0..rows {
        // Rows stretch with distance: near water is dense, far water is not.
        let t = row as f32 / (rows - 1) as f32;
        let z = start + (end - start) * powf(t, 1.9);
        let (center, half_width) = scene.river_at(z);
        row_vertices.clear();
        for column in 0..columns {
            let across = column as f32 / (columns - 1) as f32 * 2.0 - 1.0;
            let edge = half_width + settings.bank_overlap;
            let x = center + across * edge;
            let flat = Vec3::new(x, water.level, z);
            let (height, normal) = wave(
                flat,
                time,
                water.wave_amplitude,
                water.wave_length,
                water.wave_speed,
            );
            let position = Vec3::new(x, water.level + height, z);

            // Depth from the channel profile: deepest at the centre line.
            let across01 = across.abs().min(1.0);
            let depth01 = (1.0 - across01 * across01).clamp(0.0, 1.0);
            let mut color = water.shallow.lerp(water.deep, depth01);

            let to_eye = (view.eye - position).normalize_or(Vec3::Y);
            // A grazing view mirrors the sky; a steep one looks into the water.
            let facing = to_eye.dot(normal).clamp(0.0, 1.0);
            let fresnel = powf(1.0 - facing, 4.0) * 0.92 + 0.06;
            color = color.lerp(sky, fresnel);

            // Sun glitter from the wave slope, not from a flat plane, so it
            // breaks into the moving specks the crests actually produce.
            let half = (sun + to_eye).normalize_or(Vec3::Y);
            let glitter = powf(normal.dot(half).clamp(0.0, 1.0), 110.0);
            color += water.specular * glitter;

            // Foam where the sheet meets the bank.
            let to_edge = (edge - (x - center).abs()).max(0.0);
            let to_bank = (to_edge / water.foam_width.max(0.1)).clamp(0.0, 1.0);
            // Squared, so foam is tight against the bank rather than a wash.
            let foam = (1.0 - to_bank) * (1.0 - to_bank);
            let ripple = 0.5 + 0.5 * sinf((x + z) * 0.9 + time * 2.4);
            color = color.lerp(Vec3::splat(0.86), foam * (0.35 + 0.4 * ripple));

            let terms = fog.terms(view.eye, position, sun);
            let lit = gamma_encode(tonemap(color)) * terms.transmittance;
            let fog_color = gamma_encode(tonemap(terms.color));

            // Two scrolling layers share one map: the UVs carry the fast one
            // and the wave carries the slow one.
            let scroll = time * water.wave_speed * 0.5;
            let uv = [
                (x * water.tile) + scroll * 0.18,
                (z * water.tile) - scroll,
            ];
            row_vertices.push(mesh.push_vertex(DynamicVertex::new(
                position,
                uv,
                pack_abgr(lit, 1.0),
                pack_abgr(fog_color, terms.coverage),
            )));
        }
        if row > 0 {
            for column in 0..columns - 1 {
                mesh.push_quad(
                    previous_row[column],
                    previous_row[column + 1],
                    row_vertices[column + 1],
                    row_vertices[column],
                );
            }
        }
        previous_row.clear();
        previous_row.extend_from_slice(&row_vertices);
    }
}

/// The wake a hull leaves, as a short ribbon of alpha-blended foam.
///
/// `heading` is the hull's yaw; the ribbon trails behind it and widens as it
/// dissipates, which is the cue that reads as movement on a still river.
pub fn build_wake(
    mesh: &mut DynamicMesh,
    scene: &Scene<'_>,
    view: &ViewPoint,
    origin: Vec3,
    heading: f32,
    beam: f32,
    time: f32,
) {
    mesh.clear();
    let header = scene.header;
    let fog = FogModel {
        cool: header.fog_cool,
        warm: header.fog_warm,
        density: header.fog_density,
        base_height: header.water_level,
        falloff: header.fog_height_falloff,
        inscatter: header.fog_inscatter,
        max: header.fog_max,
    };
    let back = Vec3::new(sinf(heading), 0.0, cosf(heading));
    let side = Vec3::new(back.z, 0.0, -back.x);
    let segments = 14;
    let length = 26.0f32;
    let mut previous: Option<(u16, u16)> = None;
    for segment in 0..=segments {
        let t = segment as f32 / segments as f32;
        let distance = t * length;
        let centre = origin + back * distance;
        // The wake spreads behind the hull and fades as it spreads.
        let width = beam * (0.55 + 1.5 * t);
        let fade = (1.0 - t).powf(1.6);
        let ripple = 0.65 + 0.35 * (sinf(distance * 0.9 - time * 3.1));
        let alpha = fade * ripple * 0.7;
        let terms = fog.terms(view.eye, centre, header.sun_dir);
        let lit = gamma_encode(tonemap(Vec3::splat(0.92))) * terms.transmittance;
        let fog_color = gamma_encode(tonemap(terms.color));
        let height = header.water_level + 0.035;
        let left = mesh.push_vertex(DynamicVertex::new(
            centre - side * width + Vec3::Y * height,
            [0.0, t * 2.0],
            pack_abgr(lit, alpha),
            pack_abgr(fog_color, terms.coverage),
        ));
        let right = mesh.push_vertex(DynamicVertex::new(
            centre + side * width + Vec3::Y * height,
            [1.0, t * 2.0],
            pack_abgr(lit, alpha),
            pack_abgr(fog_color, terms.coverage),
        ));
        if let Some((previous_left, previous_right)) = previous {
            mesh.push_quad(previous_left, previous_right, right, left);
        }
        previous = Some((left, right));
    }
}

/// Fog coverage at a point, for callers that need it outside a surface build.
pub fn coverage_at(scene: &Scene<'_>, eye: Vec3, point: Vec3) -> f32 {
    let header = scene.header;
    let fog = FogModel {
        cool: header.fog_cool,
        warm: header.fog_warm,
        density: header.fog_density,
        base_height: header.water_level,
        falloff: header.fog_height_falloff,
        inscatter: header.fog_inscatter,
        max: header.fog_max,
    };
    fog.terms(eye, point, header.sun_dir).coverage
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wave_normal_is_flat_where_the_surface_is_flat() {
        let (_, normal) = wave(Vec3::ZERO, 0.0, 0.0, 8.0, 1.0);
        assert!((normal - Vec3::Y).length() < 1e-5);
    }

    #[test]
    fn the_wave_stays_inside_its_amplitude() {
        for step in 0..400 {
            let point = Vec3::new(step as f32 * 0.7, 0.0, step as f32 * -1.3);
            let (height, normal) = wave(point, step as f32 * 0.05, 0.06, 7.5, 0.9);
            assert!(height.abs() <= 0.06 + 1e-5, "{height}");
            assert!(normal.y > 0.0);
            assert!((normal.length() - 1.0).abs() < 1e-4);
        }
    }

    #[test]
    fn the_wave_travels_over_time() {
        let point = Vec3::new(3.0, 0.0, -11.0);
        let first = wave(point, 0.0, 0.06, 7.5, 0.9).0;
        let later = wave(point, 0.4, 0.06, 7.5, 0.9).0;
        assert!((first - later).abs() > 1e-4);
    }
}
