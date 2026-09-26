//! Mesh primitives and the vertex baker every generator shares.
//!
//! The baker is the seam between the scene's shape and `pocket3d-scene`'s
//! lighting model: a generator says where a surface is and which way it faces,
//! and the baker resolves sun, sky, occlusion and aerial perspective into the
//! two packed colours the device multiplies and adds.

use glam::{Quat, Vec3};
use pocket3d_scene::build::Mesh;
use pocket3d_scene::light::{BakeInputs, BakedVertexColor, bake_vertex};

use crate::terrain::Valley;

/// Resolves vertex colour for a generator.
pub struct Baker<'a> {
    pub inputs: BakeInputs,
    pub valley: &'a Valley,
}

impl<'a> Baker<'a> {
    /// Bake with explicit shadow and occlusion terms.
    pub fn shade(
        &self,
        position: Vec3,
        normal: Vec3,
        shadow: f32,
        ao: f32,
        modulate: Vec3,
    ) -> BakedVertexColor {
        bake_vertex(&self.inputs, position, normal, shadow, ao, modulate)
    }

    /// Bake a point that sits on the terrain, sampling both terms from it.
    pub fn ground(&self, position: Vec3, normal: Vec3, modulate: Vec3) -> BakedVertexColor {
        let shadow = self
            .valley
            .sun_shadow(position.x, position.z, self.inputs.lighting.sun_dir);
        let ao = self.valley.ambient_occlusion(position.x, position.z);
        self.shade(position, normal, shadow, ao, modulate)
    }

    /// Bake a point on an object standing at `base`, which shares the ground's
    /// shadow but carries its own occlusion (a canopy shades its own trunk).
    pub fn standing(
        &self,
        base: Vec3,
        position: Vec3,
        normal: Vec3,
        ao: f32,
        modulate: Vec3,
    ) -> BakedVertexColor {
        let shadow = self
            .valley
            .sun_shadow(base.x, base.z, self.inputs.lighting.sun_dir);
        let ground_ao = self.valley.ambient_occlusion(base.x, base.z);
        self.shade(position, normal, shadow, (ao * ground_ao).clamp(0.0, 1.0), modulate)
    }
}

/// Orthonormal frame with `forward` as its third axis.
pub fn frame(forward: Vec3) -> (Vec3, Vec3) {
    let up = if forward.y.abs() > 0.94 { Vec3::Z } else { Vec3::Y };
    let right = up.cross(forward).normalize_or(Vec3::X);
    (right, forward.cross(right).normalize_or(Vec3::Y))
}

/// A tapered tube from `base` to `tip`, closed at neither end.
///
/// `twist` rotates the ring so successive branches do not line their seams up.
#[allow(clippy::too_many_arguments)]
pub fn tube(
    mesh: &mut Mesh,
    base: Vec3,
    tip: Vec3,
    base_radius: f32,
    tip_radius: f32,
    sides: usize,
    twist: f32,
    uv_scale: f32,
    mut color: impl FnMut(Vec3, Vec3) -> BakedVertexColor,
) {
    let axis = tip - base;
    let length = axis.length();
    if length < 1e-4 || sides < 3 {
        return;
    }
    let forward = axis / length;
    let (right, up) = frame(forward);
    let first = mesh.vertex_count() as u32;
    for ring in 0..2 {
        let (center, radius) = if ring == 0 {
            (base, base_radius)
        } else {
            (tip, tip_radius)
        };
        for side in 0..=sides {
            let angle = twist + side as f32 / sides as f32 * core::f32::consts::TAU;
            let normal = right * angle.cos() + up * angle.sin();
            let position = center + normal * radius;
            let u = side as f32 / sides as f32 * uv_scale;
            let v = ring as f32 * length * uv_scale * 0.5;
            mesh.push_vertex(position, [u, v], color(position, normal));
        }
    }
    let stride = sides as u32 + 1;
    for side in 0..sides as u32 {
        let a = first + side;
        let b = first + side + 1;
        let c = first + stride + side + 1;
        let d = first + stride + side;
        mesh.push_quad(a, b, c, d);
    }
}

/// A flat quad centred at `center`, spanning `right` and `up`.
pub fn card(
    mesh: &mut Mesh,
    center: Vec3,
    right: Vec3,
    up: Vec3,
    mut color: impl FnMut(Vec3, Vec3) -> BakedVertexColor,
) {
    let normal = right.cross(up).normalize_or(Vec3::Y);
    let first = mesh.vertex_count() as u32;
    let corners = [
        (center - right - up, [0.0, 1.0]),
        (center + right - up, [1.0, 1.0]),
        (center + right + up, [1.0, 0.0]),
        (center - right + up, [0.0, 0.0]),
    ];
    for (position, uv) in corners {
        mesh.push_vertex(position, uv, color(position, normal));
    }
    mesh.push_quad(first, first + 1, first + 2, first + 3);
}

/// Two quads crossing at right angles, the cheapest volume-suggesting card.
pub fn cross_card(
    mesh: &mut Mesh,
    center: Vec3,
    half_width: f32,
    half_height: f32,
    yaw: f32,
    mut color: impl FnMut(Vec3, Vec3) -> BakedVertexColor,
) {
    for step in 0..2 {
        let angle = yaw + step as f32 * core::f32::consts::FRAC_PI_2;
        let right = Vec3::new(angle.cos(), 0.0, angle.sin()) * half_width;
        card(
            mesh,
            center,
            right,
            Vec3::Y * half_height,
            &mut color,
        );
    }
}

/// An axis-aligned box rotated by `yaw` about its centre.
pub fn box_prism(
    mesh: &mut Mesh,
    center: Vec3,
    half_extent: Vec3,
    yaw: f32,
    uv_scale: f32,
    mut color: impl FnMut(Vec3, Vec3) -> BakedVertexColor,
) {
    let rotation = Quat::from_rotation_y(yaw);
    let faces = [
        (Vec3::X, Vec3::Z, Vec3::Y),
        (Vec3::NEG_X, Vec3::NEG_Z, Vec3::Y),
        (Vec3::Y, Vec3::X, Vec3::NEG_Z),
        (Vec3::NEG_Y, Vec3::X, Vec3::Z),
        (Vec3::Z, Vec3::NEG_X, Vec3::Y),
        (Vec3::NEG_Z, Vec3::X, Vec3::Y),
    ];
    for (normal, right, up) in faces {
        let world_normal = rotation * normal;
        let offset = rotation * (normal * half_extent);
        let right_vector = rotation * (right * half_extent);
        let up_vector = rotation * (up * half_extent);
        let first = mesh.vertex_count() as u32;
        let corners = [
            (-right_vector - up_vector, [0.0, 0.0]),
            (right_vector - up_vector, [1.0, 0.0]),
            (right_vector + up_vector, [1.0, 1.0]),
            (-right_vector + up_vector, [0.0, 1.0]),
        ];
        for (delta, uv) in corners {
            let position = center + offset + delta;
            mesh.push_vertex(
                position,
                [uv[0] * uv_scale, uv[1] * uv_scale],
                color(position, world_normal),
            );
        }
        mesh.push_quad(first, first + 1, first + 2, first + 3);
    }
}

/// A closed cone: `sides` triangles from a base ring to an apex.
#[allow(clippy::too_many_arguments)]
pub fn cone(
    mesh: &mut Mesh,
    base: Vec3,
    height: f32,
    radius: f32,
    sides: usize,
    twist: f32,
    uv_scale: f32,
    mut color: impl FnMut(Vec3, Vec3) -> BakedVertexColor,
) {
    if sides < 3 {
        return;
    }
    let apex = base + Vec3::Y * height;
    let slope = (radius / height.max(1e-3)).atan();
    for side in 0..sides {
        let angle0 = twist + side as f32 / sides as f32 * core::f32::consts::TAU;
        let angle1 = twist + (side + 1) as f32 / sides as f32 * core::f32::consts::TAU;
        let middle = (angle0 + angle1) * 0.5;
        let normal = Vec3::new(middle.cos() * slope.cos(), slope.sin(), middle.sin() * slope.cos())
            .normalize();
        let p0 = base + Vec3::new(angle0.cos(), 0.0, angle0.sin()) * radius;
        let p1 = base + Vec3::new(angle1.cos(), 0.0, angle1.sin()) * radius;
        let first = mesh.vertex_count() as u32;
        mesh.push_vertex(p0, [0.0, uv_scale], color(p0, normal));
        mesh.push_vertex(p1, [uv_scale, uv_scale], color(p1, normal));
        mesh.push_vertex(apex, [uv_scale * 0.5, 0.0], color(apex, normal));
        mesh.push_triangle(first, first + 1, first + 2);
    }
}

/// A surface of revolution through `profile`, a list of `(radius, height)`.
pub fn revolve(
    mesh: &mut Mesh,
    base: Vec3,
    profile: &[(f32, f32)],
    sides: usize,
    uv_scale: f32,
    mut color: impl FnMut(Vec3, Vec3) -> BakedVertexColor,
) {
    if profile.len() < 2 || sides < 3 {
        return;
    }
    let first = mesh.vertex_count() as u32;
    for (index, &(radius, height)) in profile.iter().enumerate() {
        // The ring normal follows the profile's local slope.
        let previous = profile[index.saturating_sub(1)];
        let next = profile[(index + 1).min(profile.len() - 1)];
        let run = next.0 - previous.0;
        let rise = next.1 - previous.1;
        for side in 0..=sides {
            let angle = side as f32 / sides as f32 * core::f32::consts::TAU;
            let radial = Vec3::new(angle.cos(), 0.0, angle.sin());
            let position = base + radial * radius + Vec3::Y * height;
            let normal = (radial * rise - Vec3::Y * run).normalize_or(radial);
            let uv = [
                side as f32 / sides as f32 * uv_scale,
                index as f32 / (profile.len() - 1) as f32 * uv_scale,
            ];
            mesh.push_vertex(position, uv, color(position, normal));
        }
    }
    let stride = sides as u32 + 1;
    for ring in 0..profile.len() as u32 - 1 {
        for side in 0..sides as u32 {
            let a = first + ring * stride + side;
            let b = first + ring * stride + side + 1;
            let c = first + (ring + 1) * stride + side + 1;
            let d = first + (ring + 1) * stride + side;
            mesh.push_quad(a, b, c, d);
        }
    }
}

/// A convex hull-ish boulder: a subdivided octahedron pushed out by noise.
pub fn boulder(
    mesh: &mut Mesh,
    center: Vec3,
    radius: Vec3,
    seed: u32,
    mut color: impl FnMut(Vec3, Vec3) -> BakedVertexColor,
) {
    const RINGS: usize = 5;
    const SIDES: usize = 8;
    let first = mesh.vertex_count() as u32;
    let mut positions = Vec::with_capacity((RINGS + 1) * (SIDES + 1));
    for ring in 0..=RINGS {
        let polar = ring as f32 / RINGS as f32 * core::f32::consts::PI;
        for side in 0..=SIDES {
            let azimuth = side as f32 / SIDES as f32 * core::f32::consts::TAU;
            let unit = Vec3::new(
                polar.sin() * azimuth.cos(),
                polar.cos(),
                polar.sin() * azimuth.sin(),
            );
            let lump = 0.72
                + 0.5
                    * crate::noise::fbm(
                        unit.x * 1.7 + 4.0,
                        unit.z * 1.7 + unit.y * 2.1,
                        3,
                        seed,
                    );
            positions.push(center + unit * radius * lump);
        }
    }
    let stride = SIDES + 1;
    for (index, &position) in positions.iter().enumerate() {
        let ring = index / stride;
        let side = index % stride;
        // Face-weighted normals are overkill here; the radial direction from
        // the boulder's centre reads correctly at this size.
        let normal = (position - center).normalize_or(Vec3::Y);
        let uv = [
            side as f32 / SIDES as f32 * 1.4,
            ring as f32 / RINGS as f32 * 1.4,
        ];
        mesh.push_vertex(position, uv, color(position, normal));
    }
    for ring in 0..RINGS as u32 {
        for side in 0..SIDES as u32 {
            let a = first + ring * stride as u32 + side;
            let b = first + ring * stride as u32 + side + 1;
            let c = first + (ring + 1) * stride as u32 + side + 1;
            let d = first + (ring + 1) * stride as u32 + side;
            mesh.push_quad(a, b, c, d);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket3d_scene::light::BakedVertexColor;

    fn white(_: Vec3, _: Vec3) -> BakedVertexColor {
        BakedVertexColor {
            lit: 0xffff_ffff,
            fog: 0,
        }
    }

    #[test]
    fn a_tube_closes_around_its_axis() {
        let mut mesh = Mesh::new();
        tube(
            &mut mesh,
            Vec3::ZERO,
            Vec3::Y * 4.0,
            1.0,
            0.5,
            8,
            0.0,
            1.0,
            white,
        );
        assert_eq!(mesh.triangle_count(), 16);
        let (min, max) = mesh.bounds();
        assert!((min.x + 1.0).abs() < 1e-4);
        assert!((max.y - 4.0).abs() < 1e-4);
    }

    #[test]
    fn a_card_faces_the_cross_product_of_its_axes() {
        let mut mesh = Mesh::new();
        let mut seen = Vec3::ZERO;
        card(
            &mut mesh,
            Vec3::ZERO,
            Vec3::X,
            Vec3::Y,
            |_, normal| {
                seen = normal;
                white(Vec3::ZERO, normal)
            },
        );
        assert_eq!(seen, Vec3::Z);
        assert_eq!(mesh.triangle_count(), 2);
    }

    #[test]
    fn a_box_has_six_quads_and_symmetric_bounds() {
        let mut mesh = Mesh::new();
        box_prism(
            &mut mesh,
            Vec3::ZERO,
            Vec3::new(1.0, 2.0, 3.0),
            0.0,
            1.0,
            white,
        );
        assert_eq!(mesh.triangle_count(), 12);
        let (min, max) = mesh.bounds();
        assert!((min + max).length() < 1e-4);
        assert!((max - Vec3::new(1.0, 2.0, 3.0)).length() < 1e-4);
    }

    #[test]
    fn revolving_a_profile_produces_a_closed_band_per_segment() {
        let mut mesh = Mesh::new();
        revolve(
            &mut mesh,
            Vec3::ZERO,
            &[(2.0, 0.0), (1.4, 1.0), (0.2, 1.6)],
            6,
            1.0,
            white,
        );
        assert_eq!(mesh.triangle_count(), 6 * 2 * 2);
    }

    #[test]
    fn a_boulder_stays_inside_its_radius_budget() {
        let mut mesh = Mesh::new();
        let radius = Vec3::new(2.0, 1.4, 1.8);
        boulder(&mut mesh, Vec3::ZERO, radius, 3, white);
        let (min, max) = mesh.bounds();
        assert!(max.x <= radius.x * 1.25 && min.x >= -radius.x * 1.25);
        assert!(max.y <= radius.y * 1.25 && min.y >= -radius.y * 1.25);
        assert!(mesh.triangle_count() > 40);
    }
}
