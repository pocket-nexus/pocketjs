//! Trees, reeds and boulders.
//!
//! Each species is generated at two densities. The near form is real geometry
//! — a tapered trunk with branch tiers or a canopy of cards — and the far form
//! is a single crossed billboard. Which one a chunk carries is decided when it
//! is cooked, and the LOD band on the chunk keeps only one of them on screen at
//! a time.

use glam::Vec3;
use pocket3d_scene::build::Mesh;

use crate::geometry::{Baker, boulder, card, cross_card, tube};
use crate::noise::Rng;

/// Trunk sides for a near tree. Six reads as round at these diameters and
/// keeps a whole forest inside the triangle budget.
const TRUNK_SIDES: usize = 6;

/// Canopy interiors are darker than their lit edges; this is the range the
/// generators modulate across.
fn canopy_shade(depth: f32) -> Vec3 {
    Vec3::splat(0.46 + 0.54 * (1.0 - depth).clamp(0.0, 1.0))
}

/// A pine: a straight trunk with tiers of needle sprays.
///
/// `trunk` and `needles` are separate meshes because they end up in different
/// materials — one opaque, one an alpha-blended cutout.
pub fn pine(
    trunk_mesh: &mut Mesh,
    needle_mesh: &mut Mesh,
    baker: &Baker<'_>,
    base: Vec3,
    height: f32,
    seed: u32,
) {
    let mut rng = Rng::new(seed);
    let radius = height * 0.020;
    let lean = Vec3::new(rng.range(-0.05, 0.05), 0.0, rng.range(-0.05, 0.05)) * height;
    let top = base + Vec3::Y * height + lean;
    tube(
        trunk_mesh,
        base - Vec3::Y * 0.6,
        base + (top - base) * 0.62,
        radius * 1.35,
        radius * 0.8,
        TRUNK_SIDES,
        rng.range(0.0, 1.0),
        1.0,
        |position, normal| baker.standing(base, position, normal, 0.72, Vec3::ONE),
    );
    tube(
        trunk_mesh,
        base + (top - base) * 0.62,
        top,
        radius * 0.8,
        radius * 0.18,
        TRUNK_SIDES,
        rng.range(0.0, 1.0),
        1.0,
        |position, normal| baker.standing(base, position, normal, 0.8, Vec3::ONE),
    );

    // Tiers of crossed cards, narrowing towards the tip. Crossed rather than
    // laid flat: a horizontal branch card is edge-on to a camera at eye level,
    // which is exactly where this scene is viewed from.
    let tiers = 6;
    for tier in 0..tiers {
        let t = tier as f32 / (tiers - 1) as f32;
        let along = 0.30 + 0.66 * t;
        let center = base + (top - base) * along;
        // A cone profile: wide at the bottom skirt, a point at the leader.
        let spread = height * 0.30 * (1.0 - t).powf(0.85) * rng.range(0.85, 1.1);
        let depth = height * 0.14 * (1.0 - t * 0.55);
        cross_card(
            needle_mesh,
            center + Vec3::Y * depth * 0.35,
            spread.max(0.35),
            depth.max(0.30),
            rng.range(0.0, core::f32::consts::TAU),
            |position, _| {
                let reach = (position - center).length() / spread.max(1e-3);
                baker.standing(base, position, Vec3::Y, 0.55 + 0.3 * t, canopy_shade(1.0 - reach))
            },
        );
    }
}

/// A cherry: a short leaning trunk, a few limbs, and a canopy of blossom cards.
pub fn cherry(
    trunk_mesh: &mut Mesh,
    blossom_mesh: &mut Mesh,
    baker: &Baker<'_>,
    base: Vec3,
    height: f32,
    seed: u32,
) {
    let mut rng = Rng::new(seed ^ 0x5eed);
    let radius = height * 0.040;
    let lean_angle = rng.range(0.0, core::f32::consts::TAU);
    let lean = Vec3::new(lean_angle.cos(), 0.0, lean_angle.sin()) * height * rng.range(0.04, 0.13);
    let fork = base + Vec3::Y * height * 0.46 + lean * 0.5;
    tube(
        trunk_mesh,
        base - Vec3::Y * 0.5,
        fork,
        radius * 1.3,
        radius * 0.85,
        TRUNK_SIDES,
        rng.range(0.0, 1.0),
        1.0,
        |position, normal| baker.standing(base, position, normal, 0.7, Vec3::ONE),
    );

    let limbs = 3 + (rng.next_u32() % 2) as usize;
    let mut tips = Vec::with_capacity(limbs);
    for limb in 0..limbs {
        let angle = rng.range(0.0, core::f32::consts::TAU)
            + limb as f32 / limbs as f32 * core::f32::consts::TAU;
        let outward = Vec3::new(angle.cos(), 0.0, angle.sin());
        let tip = fork
            + outward * height * rng.range(0.16, 0.30)
            + Vec3::Y * height * rng.range(0.22, 0.38);
        tube(
            trunk_mesh,
            fork,
            tip,
            radius * 0.7,
            radius * 0.3,
            5,
            rng.range(0.0, 1.0),
            1.0,
            |position, normal| baker.standing(base, position, normal, 0.66, Vec3::ONE),
        );
        tips.push(tip);
    }

    // The canopy is a loose shell of crossed cards over the limb tips.
    let canopy_center = base + Vec3::Y * height * 0.80 + lean;
    let canopy_radius = height * 0.40;
    for tip in &tips {
        cross_card(
            blossom_mesh,
            *tip + Vec3::Y * height * 0.05,
            height * rng.range(0.16, 0.24),
            height * rng.range(0.13, 0.19),
            rng.range(0.0, core::f32::consts::TAU),
            |position, _| {
                let depth = (position - canopy_center).length() / canopy_radius.max(1e-3);
                baker.standing(base, position, Vec3::Y, 0.6, canopy_shade(1.0 - depth))
            },
        );
    }
    let fillers = 4;
    for _ in 0..fillers {
        let offset = Vec3::new(
            rng.range(-1.0, 1.0),
            rng.range(-0.45, 0.55),
            rng.range(-1.0, 1.0),
        ) * canopy_radius
            * 0.7;
        cross_card(
            blossom_mesh,
            canopy_center + offset,
            height * rng.range(0.14, 0.22),
            height * rng.range(0.11, 0.17),
            rng.range(0.0, core::f32::consts::TAU),
            |position, _| {
                let depth = (position - canopy_center).length() / canopy_radius.max(1e-3);
                baker.standing(base, position, Vec3::Y, 0.55, canopy_shade(1.0 - depth))
            },
        );
    }
}

/// The far form of any tree: one crossed billboard standing on the ground.
pub fn billboard_tree(
    mesh: &mut Mesh,
    baker: &Baker<'_>,
    base: Vec3,
    height: f32,
    width: f32,
    seed: u32,
) {
    let mut rng = Rng::new(seed ^ 0xb111);
    let center = base + Vec3::Y * height * 0.5;
    cross_card(
        mesh,
        center,
        width * 0.5,
        height * 0.5,
        rng.range(0.0, core::f32::consts::TAU),
        |position, _| {
            // Billboards darken towards their root so they sit in the ground.
            let up = ((position.y - base.y) / height.max(1e-3)).clamp(0.0, 1.0);
            baker.standing(base, position, Vec3::Y, 0.55 + 0.35 * up, Vec3::splat(0.78 + 0.3 * up))
        },
    );
}

/// A clump of reeds at the waterline.
pub fn reed_clump(mesh: &mut Mesh, baker: &Baker<'_>, base: Vec3, height: f32, seed: u32) {
    let mut rng = Rng::new(seed ^ 0x2222);
    let blades = 2;
    for blade in 0..blades {
        let yaw = rng.range(0.0, core::f32::consts::TAU)
            + blade as f32 * core::f32::consts::FRAC_PI_2;
        let offset = Vec3::new(rng.range(-0.4, 0.4), 0.0, rng.range(-0.4, 0.4));
        let card_height = height * rng.range(0.78, 1.2);
        card(
            mesh,
            base + offset + Vec3::Y * card_height * 0.5,
            Vec3::new(yaw.cos(), 0.0, yaw.sin()) * height * 0.42,
            Vec3::Y * card_height * 0.5,
            |position, _| {
                let up = ((position.y - base.y) / card_height.max(1e-3)).clamp(0.0, 1.0);
                baker.standing(base, position, Vec3::Y, 0.45 + 0.5 * up, Vec3::splat(0.7 + 0.45 * up))
            },
        );
    }
}

/// A boulder seated into the ground.
pub fn rock(mesh: &mut Mesh, baker: &Baker<'_>, base: Vec3, radius: Vec3, seed: u32) {
    // Sink the centre so the noise-perturbed underside never floats.
    let center = base + Vec3::Y * radius.y * 0.55;
    boulder(mesh, center, radius, seed, |position, normal| {
        let buried = 1.0 - ((position.y - base.y) / radius.y.max(1e-3)).clamp(0.0, 1.0);
        baker.ground(position, normal, Vec3::splat(1.0 - 0.35 * buried))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terrain::Valley;
    use pocket3d_scene::light::BakeInputs;

    fn baker(valley: &Valley) -> Baker<'_> {
        Baker {
            inputs: BakeInputs::default(),
            valley,
        }
    }

    #[test]
    fn a_pine_stands_on_its_base_and_reaches_its_height() {
        let valley = Valley::new(1);
        let baker = baker(&valley);
        let mut trunk = Mesh::new();
        let mut needles = Mesh::new();
        let base = Vec3::new(4.0, 2.0, -30.0);
        pine(&mut trunk, &mut needles, &baker, base, 16.0, 7);
        let (trunk_min, trunk_max) = trunk.bounds();
        assert!(trunk_min.y <= base.y, "the trunk should reach into the ground");
        assert!(trunk_max.y >= base.y + 15.0);
        let (needle_min, needle_max) = needles.bounds();
        assert!(needle_min.y > base.y + 2.0, "no needles on the bare trunk");
        assert!(needle_max.y <= trunk_max.y + 1.0);
        assert!(trunk.triangle_count() + needles.triangle_count() < 140);
    }

    #[test]
    fn a_cherry_spreads_wider_than_it_is_tall_at_the_canopy() {
        let valley = Valley::new(2);
        let baker = baker(&valley);
        let mut trunk = Mesh::new();
        let mut blossom = Mesh::new();
        let base = Vec3::new(-8.0, 1.0, -55.0);
        cherry(&mut trunk, &mut blossom, &baker, base, 9.0, 11);
        let (min, max) = blossom.bounds();
        let span = (max.x - min.x).max(max.z - min.z);
        assert!(span > (max.y - min.y) * 0.8, "canopy {span} vs {}", max.y - min.y);
        assert!(blossom.triangle_count() > 20);
    }

    #[test]
    fn a_reed_clump_is_rooted_at_its_base() {
        let valley = Valley::new(3);
        let baker = baker(&valley);
        let mut mesh = Mesh::new();
        let base = Vec3::new(0.0, 0.2, -10.0);
        reed_clump(&mut mesh, &baker, base, 1.8, 5);
        let (min, _) = mesh.bounds();
        assert!((min.y - base.y).abs() < 0.2);
    }

    #[test]
    fn a_rock_does_not_float_above_its_base() {
        let valley = Valley::new(4);
        let baker = baker(&valley);
        let mut mesh = Mesh::new();
        let base = Vec3::new(3.0, 0.5, -12.0);
        rock(&mut mesh, &baker, base, Vec3::new(1.4, 1.0, 1.2), 9);
        let (min, _) = mesh.bounds();
        assert!(min.y < base.y, "{} should dip below {}", min.y, base.y);
    }
}
