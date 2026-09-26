//! The built things in the valley: a river boat, an arched timber bridge, a
//! tiered tower on the far terrace, and the lanterns that mark the bank.
//!
//! Each generator writes into one mesh per material so the cooker can chunk by
//! material without re-sorting triangles.

use glam::{Quat, Vec3};
use pocket3d_scene::build::Mesh;

use crate::geometry::{Baker, box_prism, card, revolve, tube};
use crate::terrain::smoothstep;

/// Meshes a structure fills, one per material.
#[derive(Default)]
pub struct StructureMeshes {
    pub timber: Mesh,
    pub lacquer: Mesh,
    pub plaster: Mesh,
    pub tiles: Mesh,
    pub thatch: Mesh,
    pub glow: Mesh,
}

/// Half-beam of the hull at normalized length `s`, 0 at the stern and 1 at the
/// bow. A flat run amidships with both ends drawn in.
fn hull_beam(s: f32) -> f32 {
    let stern = smoothstep(0.0, 0.22, s);
    let bow = smoothstep(1.0, 0.62, s);
    (0.35 + 0.65 * stern * bow).clamp(0.05, 1.0)
}

/// Height of the sheer line above the keel at `s`; both ends rise.
fn hull_sheer(s: f32) -> f32 {
    0.62 + 0.55 * (smoothstep(0.35, 0.0, s) + smoothstep(0.7, 1.0, s))
}

/// A flat-bottomed river boat, built in its own local space with the origin at
/// the waterline amidships and the bow towards -Z.
///
/// The runtime places it, so its light is baked as if it were level at the
/// origin and its fog comes from the chunk transform the renderer applies.
pub fn river_boat(meshes: &mut StructureMeshes, baker: &Baker<'_>, length: f32, beam: f32) {
    let sections = 11;
    let half_length = length * 0.5;
    let max_beam = beam * 0.5;
    let keel_drop = 0.42;

    // Hull: a ladder of quads between adjacent cross-sections, plus a floor.
    let mut rings: Vec<[Vec3; 4]> = Vec::with_capacity(sections);
    for section in 0..sections {
        let s = section as f32 / (sections - 1) as f32;
        let z = half_length - s * length;
        let width = max_beam * hull_beam(s);
        let top = hull_sheer(s) * 0.55;
        rings.push([
            Vec3::new(-width, top, z),
            Vec3::new(-width * 0.78, -keel_drop, z),
            Vec3::new(width * 0.78, -keel_drop, z),
            Vec3::new(width, top, z),
        ]);
    }
    let shade = |position: Vec3, normal: Vec3| {
        // Below the sheer the planking sits in its own shadow.
        let shaded = smoothstep(0.4, -0.3, position.y);
        baker.shade(
            position,
            normal,
            0.85,
            (0.95 - 0.45 * shaded).clamp(0.0, 1.0),
            Vec3::splat(1.0 - 0.25 * shaded),
        )
    };
    for section in 0..sections - 1 {
        let near = rings[section];
        let far = rings[section + 1];
        for edge in 0..3 {
            let a = near[edge];
            let b = near[edge + 1];
            let c = far[edge + 1];
            let d = far[edge];
            let normal = (b - a).cross(d - a).normalize_or(Vec3::Y);
            let first = meshes.timber.vertex_count() as u32;
            let u0 = section as f32 * 0.5;
            let u1 = (section + 1) as f32 * 0.5;
            for (position, uv) in [
                (a, [u0, edge as f32 * 0.4]),
                (b, [u0, (edge + 1) as f32 * 0.4]),
                (c, [u1, (edge + 1) as f32 * 0.4]),
                (d, [u1, edge as f32 * 0.4]),
            ] {
                meshes
                    .timber
                    .push_vertex(position, uv, shade(position, normal));
            }
            meshes.timber.push_quad(first, first + 1, first + 2, first + 3);
        }
        // Floorboards, seen from above.
        let first = meshes.timber.vertex_count() as u32;
        let floor = [near[1], near[2], far[2], far[1]];
        let uvs = [
            [section as f32 * 0.5, 0.0],
            [section as f32 * 0.5, 1.0],
            [(section + 1) as f32 * 0.5, 1.0],
            [(section + 1) as f32 * 0.5, 0.0],
        ];
        for (position, uv) in floor.iter().zip(uvs) {
            meshes
                .timber
                .push_vertex(*position, uv, shade(*position, Vec3::Y));
        }
        meshes.timber.push_quad(first, first + 1, first + 2, first + 3);
    }

    // Transom and stem caps close the ends.
    for (ring, normal) in [(rings[0], Vec3::Z), (rings[sections - 1], Vec3::NEG_Z)] {
        let first = meshes.timber.vertex_count() as u32;
        for (index, position) in ring.iter().enumerate() {
            meshes.timber.push_vertex(
                *position,
                [index as f32 * 0.33, 0.5],
                shade(*position, normal),
            );
        }
        meshes.timber.push_quad(first, first + 1, first + 2, first + 3);
    }

    // A thatched arch over the middle third.
    let arch_sections = 7;
    let arch_from = -length * 0.10;
    let arch_to = length * 0.26;
    let arch_radius = max_beam * 0.92;
    let mut arch_rings: Vec<Vec<Vec3>> = Vec::with_capacity(arch_sections);
    let ribs = 6;
    for section in 0..arch_sections {
        let t = section as f32 / (arch_sections - 1) as f32;
        let z = arch_from + (arch_to - arch_from) * t;
        // The hood tapers at both ends so it reads as woven, not extruded.
        let taper = 0.72 + 0.28 * smoothstep(0.0, 0.25, t) * smoothstep(1.0, 0.75, t);
        let mut ring = Vec::with_capacity(ribs + 1);
        for rib in 0..=ribs {
            let angle = rib as f32 / ribs as f32 * core::f32::consts::PI;
            ring.push(Vec3::new(
                -angle.cos() * arch_radius * taper,
                0.34 + angle.sin() * arch_radius * 0.92 * taper,
                z,
            ));
        }
        arch_rings.push(ring);
    }
    for section in 0..arch_sections - 1 {
        for rib in 0..ribs {
            let a = arch_rings[section][rib];
            let b = arch_rings[section][rib + 1];
            let c = arch_rings[section + 1][rib + 1];
            let d = arch_rings[section + 1][rib];
            let normal = (b - a).cross(d - a).normalize_or(Vec3::Y);
            let first = meshes.thatch.vertex_count() as u32;
            for (position, uv) in [
                (a, [rib as f32 * 0.3, section as f32 * 0.5]),
                (b, [(rib + 1) as f32 * 0.3, section as f32 * 0.5]),
                (c, [(rib + 1) as f32 * 0.3, (section + 1) as f32 * 0.5]),
                (d, [rib as f32 * 0.3, (section + 1) as f32 * 0.5]),
            ] {
                let color = baker.shade(position, normal, 0.9, 0.95, Vec3::ONE);
                meshes.thatch.push_vertex(position, uv, color);
            }
            meshes
                .thatch
                .push_quad(first, first + 1, first + 2, first + 3);
        }
    }
}

/// The lantern on the boat's bow post: a warm paper box on a slim pole.
pub fn boat_lantern(meshes: &mut StructureMeshes, baker: &Baker<'_>, base: Vec3, height: f32) {
    tube(
        &mut meshes.timber,
        base,
        base + Vec3::Y * height,
        0.045,
        0.035,
        4,
        0.0,
        1.0,
        |position, normal| baker.shade(position, normal, 0.9, 0.9, Vec3::ONE),
    );
    // The shade is emissive rather than lit: it reads as the light source.
    let center = base + Vec3::Y * (height + 0.16);
    revolve(
        &mut meshes.glow,
        center - Vec3::Y * 0.22,
        &[(0.02, 0.0), (0.16, 0.08), (0.17, 0.30), (0.03, 0.44)],
        7,
        1.0,
        |position, normal| {
            let _ = normal;
            let _ = position;
            baker.shade(position, Vec3::Y, 1.0, 1.0, Vec3::splat(3.2))
        },
    );
}

/// An arched timber bridge across the river.
///
/// `span` is the deck's length; `rise` is how far its crown sits above the
/// abutments. The deck is planked and the rails are lacquered.
pub fn arched_bridge(
    meshes: &mut StructureMeshes,
    baker: &Baker<'_>,
    center: Vec3,
    yaw: f32,
    span: f32,
    width: f32,
    rise: f32,
) {
    let rotation = Quat::from_rotation_y(yaw);
    let along = rotation * Vec3::X;
    let across = rotation * Vec3::Z;
    let segments = 12;
    let arc = |t: f32| -> Vec3 {
        let s = t * 2.0 - 1.0;
        center + along * (s * span * 0.5) + Vec3::Y * (rise * (1.0 - s * s))
    };

    // Deck: a top surface and two fascia strips.
    let half_width = width * 0.5;
    for segment in 0..segments {
        let t0 = segment as f32 / segments as f32;
        let t1 = (segment + 1) as f32 / segments as f32;
        let (p0, p1) = (arc(t0), arc(t1));
        let quads = [
            (
                [
                    p0 - across * half_width,
                    p1 - across * half_width,
                    p1 + across * half_width,
                    p0 + across * half_width,
                ],
                Vec3::Y,
            ),
            (
                [
                    p0 + across * half_width,
                    p1 + across * half_width,
                    p1 + across * half_width - Vec3::Y * 0.55,
                    p0 + across * half_width - Vec3::Y * 0.55,
                ],
                across,
            ),
            (
                [
                    p0 - across * half_width - Vec3::Y * 0.55,
                    p1 - across * half_width - Vec3::Y * 0.55,
                    p1 - across * half_width,
                    p0 - across * half_width,
                ],
                -across,
            ),
        ];
        for (corners, normal) in quads {
            let first = meshes.timber.vertex_count() as u32;
            for (index, position) in corners.iter().enumerate() {
                let uv = [
                    segment as f32 * 0.6 + (index as f32 % 2.0) * 0.6,
                    if index < 2 { 0.0 } else { 1.0 },
                ];
                meshes.timber.push_vertex(
                    *position,
                    uv,
                    baker.shade(*position, normal, 0.92, 0.9, Vec3::ONE),
                );
            }
            meshes.timber.push_quad(first, first + 1, first + 2, first + 3);
        }
    }

    // Rails and posts, on both sides.
    for side in [-1.0f32, 1.0] {
        let offset = across * half_width * side;
        for segment in 0..segments {
            let t0 = segment as f32 / segments as f32;
            let t1 = (segment + 1) as f32 / segments as f32;
            let a = arc(t0) + offset + Vec3::Y * 1.05;
            let b = arc(t1) + offset + Vec3::Y * 1.05;
            box_prism(
                &mut meshes.lacquer,
                (a + b) * 0.5,
                Vec3::new((b - a).length() * 0.5, 0.07, 0.07),
                yaw + (b - a).y.atan2((b - a).dot(along)) * 0.0,
                1.0,
                |position, normal| baker.shade(position, normal, 0.95, 0.95, Vec3::ONE),
            );
        }
        for post in 0..=segments / 2 {
            let t = post as f32 / (segments / 2) as f32;
            let foot = arc(t) + offset;
            box_prism(
                &mut meshes.lacquer,
                foot + Vec3::Y * 0.55,
                Vec3::new(0.09, 0.62, 0.09),
                yaw,
                1.0,
                |position, normal| baker.shade(position, normal, 0.92, 0.85, Vec3::ONE),
            );
        }
    }

    // Two piers carrying the crown.
    for side in [-1.0f32, 1.0] {
        let foot = center + along * (side * span * 0.22);
        let head = arc(0.5 + side * 0.11);
        box_prism(
            &mut meshes.plaster,
            Vec3::new(foot.x, (head.y - 2.0) * 0.5, foot.z),
            Vec3::new(0.55, (head.y + 2.0) * 0.5, width * 0.42),
            yaw,
            1.5,
            |position, normal| baker.shade(position, normal, 0.7, 0.7, Vec3::ONE),
        );
    }
}

/// A tiered tower: square bodies under flared roofs, narrowing as it rises.
pub fn tiered_tower(
    meshes: &mut StructureMeshes,
    baker: &Baker<'_>,
    base: Vec3,
    tiers: usize,
    base_half_width: f32,
    tier_height: f32,
) {
    let mut height = 0.0f32;
    for tier in 0..tiers {
        let shrink = 1.0 - tier as f32 / tiers as f32 * 0.42;
        let half_width = base_half_width * shrink;
        let body_height = tier_height * (1.0 - tier as f32 / tiers as f32 * 0.18);
        let body_center = base + Vec3::Y * (height + body_height * 0.5);
        box_prism(
            &mut meshes.plaster,
            body_center,
            Vec3::new(half_width, body_height * 0.5, half_width),
            0.0,
            1.4,
            |position, normal| {
                baker.shade(position, normal, 0.95, 0.9, Vec3::ONE)
            },
        );
        // Vermilion corner posts read the structure at distance.
        for (sx, sz) in [(1.0f32, 1.0f32), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0)] {
            box_prism(
                &mut meshes.lacquer,
                body_center + Vec3::new(sx * half_width, 0.0, sz * half_width),
                Vec3::new(half_width * 0.09, body_height * 0.5, half_width * 0.09),
                0.0,
                1.0,
                |position, normal| baker.shade(position, normal, 0.95, 0.85, Vec3::ONE),
            );
        }
        height += body_height;

        // Roof: four sloped faces from an overhanging eave to a short ridge,
        // with the eave corners lifted so the silhouette turns up.
        let eave = half_width * 1.62;
        let ridge = half_width * 0.24;
        let roof_height = tier_height * 0.44;
        let eave_y = base.y + height;
        let lift = roof_height * 0.30;
        let corner = |sx: f32, sz: f32| {
            Vec3::new(base.x + sx * eave, eave_y + lift, base.z + sz * eave)
        };
        let edge = |sx: f32, sz: f32| Vec3::new(base.x + sx * eave, eave_y, base.z + sz * eave);
        let peak = |sx: f32, sz: f32| {
            Vec3::new(
                base.x + sx * ridge,
                eave_y + roof_height,
                base.z + sz * ridge,
            )
        };
        let faces = [
            ((1.0f32, 1.0f32), (1.0f32, -1.0f32)),
            ((1.0, -1.0), (-1.0, -1.0)),
            ((-1.0, -1.0), (-1.0, 1.0)),
            ((-1.0, 1.0), (1.0, 1.0)),
        ];
        for ((ax, az), (bx, bz)) in faces {
            let a = corner(ax, az);
            let b = corner(bx, bz);
            let mid_a = peak(ax, az);
            let mid_b = peak(bx, bz);
            let normal = (b - a).cross(mid_a - a).normalize_or(Vec3::Y);
            let first = meshes.tiles.vertex_count() as u32;
            for (position, uv) in [
                (a, [0.0, 1.0]),
                (b, [2.0, 1.0]),
                (mid_b, [1.6, 0.0]),
                (mid_a, [0.4, 0.0]),
            ] {
                meshes.tiles.push_vertex(
                    position,
                    uv,
                    baker.shade(position, normal, 1.0, 0.98, Vec3::ONE),
                );
            }
            meshes.tiles.push_quad(first, first + 1, first + 2, first + 3);
            // A small gusset under each lifted corner, so the turn-up reads.
            let flat = edge(ax, az);
            let first = meshes.tiles.vertex_count() as u32;
            for (position, uv) in [(a, [0.0, 1.0]), (flat, [0.3, 1.0]), (mid_a, [0.2, 0.0])] {
                meshes.tiles.push_vertex(
                    position,
                    uv,
                    baker.shade(position, normal, 0.95, 0.9, Vec3::splat(0.9)),
                );
            }
            meshes
                .tiles
                .push_triangle(first, first + 1, first + 2);
        }
        height += roof_height * 0.62;
    }

    // Finial.
    tube(
        &mut meshes.lacquer,
        base + Vec3::Y * height,
        base + Vec3::Y * (height + tier_height * 0.8),
        base_half_width * 0.10,
        base_half_width * 0.02,
        5,
        0.0,
        1.0,
        |position, normal| baker.shade(position, normal, 1.0, 1.0, Vec3::ONE),
    );
}

/// A stone lantern on the bank: a post, a fire box and a small cap.
pub fn bank_lantern(meshes: &mut StructureMeshes, baker: &Baker<'_>, base: Vec3, height: f32) {
    box_prism(
        &mut meshes.plaster,
        base + Vec3::Y * height * 0.35,
        Vec3::new(height * 0.07, height * 0.35, height * 0.07),
        0.0,
        1.0,
        |position, normal| baker.ground(position, normal, Vec3::splat(0.92)),
    );
    let box_center = base + Vec3::Y * height * 0.80;
    box_prism(
        &mut meshes.plaster,
        box_center,
        Vec3::new(height * 0.17, height * 0.13, height * 0.17),
        0.0,
        1.0,
        |position, normal| baker.ground(position, normal, Vec3::ONE),
    );
    // The lit face of the fire box.
    for side in 0..4 {
        let angle = side as f32 * core::f32::consts::FRAC_PI_2;
        let outward = Vec3::new(angle.cos(), 0.0, angle.sin());
        let right = Vec3::Y.cross(outward).normalize_or(Vec3::X);
        card(
            &mut meshes.glow,
            box_center + outward * height * 0.175,
            right * height * 0.10,
            Vec3::Y * height * 0.08,
            |position, _| baker.shade(position, outward, 1.0, 1.0, Vec3::splat(2.6)),
        );
    }
    // Cap.
    revolve(
        &mut meshes.tiles,
        box_center + Vec3::Y * height * 0.13,
        &[
            (height * 0.26, 0.0),
            (height * 0.20, height * 0.07),
            (height * 0.04, height * 0.15),
        ],
        6,
        1.0,
        |position, normal| baker.ground(position, normal, Vec3::ONE),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terrain::Valley;
    use pocket3d_scene::light::BakeInputs;

    fn meshes_and_baker(valley: &Valley) -> (StructureMeshes, Baker<'_>) {
        (
            StructureMeshes::default(),
            Baker {
                inputs: BakeInputs::default(),
                valley,
            },
        )
    }

    #[test]
    fn the_hull_is_widest_amidships_and_drawn_in_at_both_ends() {
        assert!(hull_beam(0.5) > hull_beam(0.02) * 1.5);
        assert!(hull_beam(0.5) > hull_beam(0.98) * 1.5);
        assert!(hull_sheer(0.0) > hull_sheer(0.5));
        assert!(hull_sheer(1.0) > hull_sheer(0.5));
    }

    #[test]
    fn the_boat_fits_the_length_and_beam_it_was_asked_for() {
        let valley = Valley::new(1);
        let (mut meshes, baker) = meshes_and_baker(&valley);
        river_boat(&mut meshes, &baker, 9.0, 2.6);
        let (min, max) = meshes.timber.bounds();
        assert!((max.z - min.z - 9.0).abs() < 0.01);
        assert!(max.x - min.x <= 2.6 + 0.01);
        assert!(meshes.timber.triangle_count() > 40);
        assert!(!meshes.thatch.is_empty(), "the hood should exist");
        let (hood_min, _) = meshes.thatch.bounds();
        assert!(hood_min.y > min.y, "the hood sits above the hull floor");
    }

    #[test]
    fn the_bridge_crown_rises_above_its_abutments() {
        let valley = Valley::new(2);
        let (mut meshes, baker) = meshes_and_baker(&valley);
        let center = Vec3::new(0.0, 2.0, -100.0);
        arched_bridge(&mut meshes, &baker, center, 0.0, 40.0, 4.0, 3.5);
        let (min, max) = meshes.timber.bounds();
        assert!(max.y > center.y + 3.0, "crown at {}", max.y);
        assert!((max.x - min.x - 40.0).abs() < 0.5);
        assert!(!meshes.lacquer.is_empty(), "rails should exist");
    }

    #[test]
    fn a_tower_narrows_as_it_rises() {
        let valley = Valley::new(3);
        let (mut meshes, baker) = meshes_and_baker(&valley);
        tiered_tower(&mut meshes, &baker, Vec3::new(0.0, 10.0, -300.0), 4, 5.0, 6.0);
        let (min, max) = meshes.plaster.bounds();
        assert!(max.y > 10.0 + 18.0, "top at {}", max.y);
        assert!(max.x <= 5.1 && min.x >= -5.1);
        assert!(!meshes.tiles.is_empty(), "roofs should exist");
    }

    #[test]
    fn a_lantern_emits_more_light_than_the_stone_around_it() {
        let valley = Valley::new(4);
        let (mut meshes, baker) = meshes_and_baker(&valley);
        bank_lantern(&mut meshes, &baker, Vec3::new(2.0, 1.0, -20.0), 2.2);
        assert!(!meshes.glow.is_empty());
        let brightest_glow = meshes
            .glow
            .colors
            .iter()
            .map(|color| color.lit & 0xff)
            .max()
            .unwrap();
        let brightest_stone = meshes
            .plaster
            .colors
            .iter()
            .map(|color| color.lit & 0xff)
            .max()
            .unwrap();
        assert!(brightest_glow > brightest_stone);
    }
}
