//! Brains: native steering that writes the same INTENT floats a player's stick
//! writes. A STEER brain picks a target, evaluates the archetype's behaviour
//! (steer.rs: states of weighted terms the guest composed), and the kernel's
//! `drive` turns the wanted direction into that kernel's intents.
//!
//! BRAIN_P layout:
//!   0 target mode (0 none, 1 nearest on layers [1], 2 keep TARGET, 3 point [2..4],
//!     4 furthest along its path on layers [1])
//!   1 target layers, 2..4 point, 5 sight range, 8 retarget seconds.
//!
//! A slot's brain floats: 0 the retarget timer, 1..8 the behaviour's memory.

use crate::fmath::*;
use crate::kernels;
use crate::schema::{arch as A, brain as B, ent as E, intent as I, state as ST};
use crate::scene::Scene;
use crate::steer;
use crate::vec::*;
use crate::world::World;

#[inline]
fn bp(w: &World, arch: usize, i: usize) -> f32 {
    w.archs[arch][A::BRAIN_P + i]
}

/// The nearest live slot on `layers` within `range` of `from` (not itself).
pub fn nearest(w: &World, from: usize, layers: u32, range: f32) -> i32 {
    let p = w.pos(from);
    let mut best = -1;
    let mut best_d = range * range;
    let team = w.s[from].team;
    for &s in w.live.iter() {
        let s = s as usize;
        if s == from || w.s[s].layer & layers == 0 || w.state(s) & ST::DEAD != 0 {
            continue;
        }
        if team != 0 && w.s[s].team == team {
            continue;
        }
        let d = w.pos(s).dist_sq(p);
        if d < best_d {
            best_d = d;
            best = s as i32;
        }
    }
    best
}

/// The live slot on `layers` within `range` of `from` on the ground plane
/// that is furthest along its path (a PATH kernel's segment and distance
/// into it); slots on other kernels count as at the start. Tower defense
/// targeting: the creep closest to the base.
pub fn leading(w: &World, from: usize, layers: u32, range: f32) -> i32 {
    let p = w.pos(from);
    let r2 = range * range;
    let team = w.s[from].team;
    let mut best = -1;
    let mut best_progress = f32::NEG_INFINITY;
    for &s in w.live.iter() {
        let s = s as usize;
        if s == from || w.s[s].layer & layers == 0 || w.state(s) & ST::DEAD != 0 {
            continue;
        }
        if team != 0 && w.s[s].team == team {
            continue;
        }
        if w.pos(s).dist_xz_sq(p) > r2 {
            continue;
        }
        let progress = kernels::progress(w, s);
        if progress > best_progress {
            best_progress = progress;
            best = s as i32;
        }
    }
    best
}

/// Retarget on the brain's interval and return the target position.
fn target(w: &mut World, slot: usize, arch: usize, dt: f32) -> Option<(i32, Vec3)> {
    let mode = bp(w, arch, 0) as u32;
    match mode {
        1 | 4 => {
            w.s[slot].b[0] -= dt;
            let mut t = w.e(slot, E::TARGET) as i32;
            if w.s[slot].b[0] <= 0.0 || t < 0 || !w.alive(t as usize) {
                let every = bp(w, arch, 8);
                w.s[slot].b[0] = if every > 0.0 { every } else { 0.5 };
                let sight = bp(w, arch, 5);
                let (layers, range) = (bp(w, arch, 1) as u32, if sight > 0.0 { sight } else { 1e9 });
                t = if mode == 4 { leading(w, slot, layers, range) } else { nearest(w, slot, layers, range) };
                w.set(slot, E::TARGET, t as f32);
            }
            if t >= 0 {
                Some((t, w.pos(t as usize)))
            } else {
                None
            }
        }
        2 => {
            let t = w.e(slot, E::TARGET) as i32;
            if t >= 0 && w.alive(t as usize) {
                Some((t, w.pos(t as usize)))
            } else {
                None
            }
        }
        3 => Some((-1, v3(bp(w, arch, 2), bp(w, arch, 3), bp(w, arch, 4)))),
        _ => None,
    }
}

fn fire_control(w: &mut World, slot: usize, arch: usize, tp: Option<Vec3>, range: f32, cone: f32) {
    let mut fire = 0.0;
    if let Some(t) = tp {
        let d = t - w.pos(slot);
        let dist = d.len();
        if range > 0.0 && dist <= range && (cone <= 0.0 || kernels::aim_cos(w, slot, arch, d * (1.0 / maxf(dist, 1e-3))) >= cosf(cone)) {
            fire = 1.0;
        }
    }
    w.set_intent(slot, I::FIRE, fire);
}

pub fn think(w: &mut World, scene: &Scene, slot: usize, dt: f32) {
    let Some(arch) = w.arch_of(slot) else { return };
    if w.archs[arch][A::BRAIN] as u32 != B::STEER {
        return;
    }
    let tgt = target(w, slot, arch, dt);
    let pos = w.pos(slot);
    let hp_max = w.e(slot, E::HP_MAX);
    let input = steer::Input {
        pos,
        yaw: w.e(slot, E::YAW),
        home: w.s[slot].home,
        ground: scene.ground_height(pos.x, pos.z),
        hp_frac: if hp_max > 0.0 { w.e(slot, E::HP) / hp_max } else { 1.0 },
        target: tgt.map(|(t, p)| (p, if t >= 0 { w.vel(t as usize) } else { Vec3::ZERO })),
        time: w.time,
        phase: slot as f32 * 2.399,
        dt,
    };
    let mut memory = steer::Memory::load(&w.s[slot].b[1..8]);
    let out = steer::evaluate(&w.behaviours[arch], &mut memory, &input, &mut w.rng);
    memory.store(&mut w.s[slot].b[1..8]);
    if out.drives {
        kernels::drive(w, slot, arch, out.want, out.face, out.fwd);
        w.set_intent(slot, I::AUX, if out.boost { 1.0 } else { 0.0 });
    }
    fire_control(w, slot, arch, tgt.map(|t| t.1), out.fire_range, out.fire_cone);
}
