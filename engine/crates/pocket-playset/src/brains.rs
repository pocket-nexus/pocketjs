//! Brains: native steering that writes the same INTENT floats a player's stick
//! writes. Each picks a target, computes a wanted direction, and the shared
//! `drive` turns that direction into intents for the slot's kernel.
//!
//! BRAIN_P layout shared by every brain:
//!   0 target mode (0 none, 1 nearest on layers [1], 2 keep TARGET, 3 point [2..4])
//!   1 target layers, 2..4 point, 5 sight range, 6 fire range, 7 fire cone (rad),
//!   8 retarget seconds, 9 preferred distance, 10 speed scale (0 = 1),
//!   11.. brain specific.

use crate::fmath::*;
use crate::schema::{arch as A, brain as B, ent as E, event as EV, intent as I, motion as M, state as ST};
use crate::scene::Scene;
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

/// Turn a wanted world direction (magnitude 0..1) into the kernel's intents.
fn drive(w: &mut World, slot: usize, arch: usize, want: Vec3, face: Option<Vec3>, dt: f32) {
    let kind = w.archs[arch][A::MOTION] as u32;
    let frame = w.archs[arch][A::MOTION_P + 3] as u32;
    let yaw = w.e(slot, E::YAW);
    let f = forward_of(yaw);
    let r = right_of(yaw);
    let flat = want.flat();
    let m = minf(flat.len(), 1.0);
    let dir = flat.normalized();
    let pos = w.pos(slot);
    // TURN toward a heading: proportional, saturating at 0.6 rad
    let turn_to = |target_yaw: f32| -> f32 { clampf(-wrap_angle(target_yaw - yaw) / 0.6, -1.0, 1.0) };
    let face_yaw = match face {
        Some(t) => {
            let d = t - pos;
            Some(yaw_of(d.x, d.z))
        }
        None if m > 0.05 => Some(yaw_of(dir.x, dir.z)),
        None => None,
    };
    let (mut ix, mut iz, mut it, mut ir) = (0.0, 0.0, 0.0, 0.0);
    match kind {
        M::PLANAR => match frame {
            1 => {
                ix = dir.dot(r) * m;
                iz = dir.dot(f) * m;
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
            }
            2 => {
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
                iz = m * clampf(dir.dot(f) * 1.5, 0.0, 1.0);
            }
            _ => {
                ix = dir.x * m;
                iz = -dir.z * m;
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
            }
        },
        M::CHARACTER => match frame {
            0 | 2 => {
                ix = dir.x * m;
                iz = -dir.z * m;
            }
            1 | 4 => {
                ix = dir.dot(r) * m;
                iz = dir.dot(f) * m;
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
            }
            _ => {
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
                iz = m * clampf(dir.dot(f) * 1.5, 0.0, 1.0);
            }
        },
        M::HOVER => {
            ix = dir.dot(r) * m;
            iz = dir.dot(f) * m;
            if let Some(y) = face_yaw {
                it = turn_to(y);
            }
            ir = clampf(want.y, -1.0, 1.0);
        }
        M::CAR | M::BOAT => {
            if let Some(y) = face_yaw {
                it = turn_to(y);
            }
            // slow for sharp corners
            iz = m * clampf(1.2 - absf(it) * 0.6, 0.3, 1.0);
        }
        M::PLANE => {
            // steer the nose at the wanted direction in the body frame
            let q = w.s[slot].quat;
            let inv = Quat { x: -q.x, y: -q.y, z: -q.z, w: q.w };
            let local = inv.rotate(want.normalized());
            it = clampf(local.x * 3.0, -1.0, 1.0);
            ir = clampf(local.y * 3.0, -1.0, 1.0);
            iz = 0.6;
            if local.z > 0.0 {
                // behind: hard roll and pull
                ir = 1.0;
            }
        }
        M::TURRET => {}
        _ => {
            ix = dir.x * m;
            iz = -dir.z * m;
        }
    }
    let _ = dt;
    w.set_intent(slot, I::X, ix);
    w.set_intent(slot, I::FWD, iz);
    w.set_intent(slot, I::TURN, it);
    if kind == M::HOVER || kind == M::PLANE {
        w.set_intent(slot, I::RISE, ir);
    }
}

/// Retarget on the brain's interval and return the target position.
fn target(w: &mut World, slot: usize, arch: usize, dt: f32) -> Option<(i32, Vec3)> {
    let mode = bp(w, arch, 0) as u32;
    match mode {
        1 => {
            w.s[slot].b[0] -= dt;
            let mut t = w.e(slot, E::TARGET) as i32;
            if w.s[slot].b[0] <= 0.0 || t < 0 || !w.alive(t as usize) {
                let every = bp(w, arch, 8);
                w.s[slot].b[0] = if every > 0.0 { every } else { 0.5 };
                let sight = bp(w, arch, 5);
                t = nearest(w, slot, bp(w, arch, 1) as u32, if sight > 0.0 { sight } else { 1e9 });
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

fn fire_control(w: &mut World, slot: usize, arch: usize, tp: Option<Vec3>) {
    let range = bp(w, arch, 6);
    let mut fire = 0.0;
    if let Some(t) = tp {
        if range > 0.0 {
            let pos = w.pos(slot);
            let d = t - pos;
            let dist = d.len();
            if dist <= range {
                let cone = bp(w, arch, 7);
                let yaw = w.e(slot, E::YAW);
                let pitch = w.e(slot, E::PITCH);
                let f = Mat34::from_ypr(Vec3::ZERO, yaw, pitch, 0.0, 1.0).vector(v3(0.0, 0.0, -1.0));
                let fwd_flat = forward_of(yaw);
                let aim = if w.archs[arch][A::WEAPON0 + crate::schema::weapon::AIM] as u32 == crate::schema::aim::FORWARD {
                    if w.archs[arch][A::MOTION] as u32 == M::PLANE {
                        f.dot(d * (1.0 / maxf(dist, 1e-3)))
                    } else {
                        fwd_flat.dot(d.flat().normalized())
                    }
                } else {
                    1.0
                };
                if cone <= 0.0 || aim >= cosf(cone) {
                    fire = 1.0;
                }
            }
        }
    }
    w.set_intent(slot, I::FIRE, fire);
}

pub fn think(w: &mut World, scene: &Scene, slot: usize, dt: f32) {
    let Some(arch) = w.arch_of(slot) else { return };
    let kind = w.archs[arch][A::BRAIN] as u32;
    if kind == B::NONE {
        return;
    }
    let scale = if bp(w, arch, 10) > 0.0 { bp(w, arch, 10) } else { 1.0 };
    let pos = w.pos(slot);
    let tgt = target(w, slot, arch, dt);
    let tp = tgt.map(|t| t.1);
    let pref = bp(w, arch, 9);
    match kind {
        B::SEEK => {
            let want = match tp {
                Some(t) => {
                    let d = t - pos;
                    let dist = d.flat().len();
                    let slow = if pref > 0.0 { clampf((dist - pref) / maxf(pref * 0.5, 0.5), 0.0, 1.0) } else { 1.0 };
                    v3(d.x, d.y, d.z).normalized() * (slow * scale)
                }
                None => Vec3::ZERO,
            };
            drive(w, slot, arch, want, tp, dt);
            fire_control(w, slot, arch, tp);
        }
        B::FLEE => {
            let sight = bp(w, arch, 5);
            let want = match tp {
                Some(t) if t.dist_xz_sq(pos) < sight * sight || sight <= 0.0 => (pos - t).normalized() * scale,
                _ => Vec3::ZERO,
            };
            drive(w, slot, arch, want, None, dt);
        }
        B::ORBIT => {
            let want = match tp {
                Some(t) => {
                    let d = (t - pos).flat();
                    let dist = d.len();
                    let radial = d.normalized();
                    let side = if bp(w, arch, 11) < 0.0 { -1.0 } else { 1.0 };
                    let tangent = v3(-radial.z, 0.0, radial.x) * side;
                    let correction = clampf((dist - pref) / maxf(pref, 1.0), -1.0, 1.0);
                    (tangent + radial * correction).normalized() * scale
                }
                None => Vec3::ZERO,
            };
            drive(w, slot, arch, want, tp, dt);
            fire_control(w, slot, arch, tp);
        }
        B::WANDER | B::HERD => {
            let st = &mut w.s[slot];
            st.b[2] -= dt;
            let flee_left = st.b[3];
            let mut fleeing = false;
            let mut want;
            if kind == B::HERD {
                let sight = bp(w, arch, 5);
                if let Some(t) = tp {
                    if t.dist_xz_sq(pos) < sight * sight {
                        w.s[slot].b[3] = bp(w, arch, 11).max(1.0);
                        w.s[slot].b[1] = {
                            let d = pos - t;
                            yaw_of(d.x, d.z)
                        };
                    }
                }
                w.s[slot].b[3] = maxf(w.s[slot].b[3] - dt, 0.0);
                fleeing = flee_left > 0.0;
            }
            if w.s[slot].b[2] <= 0.0 && !fleeing {
                let every = if bp(w, arch, 12) > 0.0 { bp(w, arch, 12) } else { 2.0 };
                w.s[slot].b[2] = every * (0.5 + w.rng.next());
                let turn = if bp(w, arch, 13) > 0.0 { bp(w, arch, 13) } else { 1.5 };
                w.s[slot].b[1] += w.rng.signed() * turn;
                // idle sometimes
                w.s[slot].b[4] = if w.rng.next() < 0.3 { 0.0 } else { 1.0 };
            }
            let home = w.s[slot].home;
            let leash = bp(w, arch, 14);
            if leash > 0.0 && pos.dist_xz_sq(home) > leash * leash && !fleeing {
                let d = home - pos;
                w.s[slot].b[1] = yaw_of(d.x, d.z);
                w.s[slot].b[4] = 1.0;
            }
            let speed = if fleeing { 1.0 } else { w.s[slot].b[4] * 0.5 * scale };
            want = forward_of(w.s[slot].b[1]) * speed;
            if fleeing {
                w.set_intent(slot, I::AUX, 1.0);
            } else {
                w.set_intent(slot, I::AUX, 0.0);
            }
            if kind == B::WANDER {
                if let Some(t) = tp {
                    // wanderers with a target drift toward it
                    let d = (t - pos).normalized();
                    want = (want + d * 0.3).normalized() * speed;
                }
            }
            drive(w, slot, arch, want, None, dt);
            fire_control(w, slot, arch, if kind == B::WANDER { tp } else { None });
        }
        B::PURSUE => {
            let want = match tgt {
                Some((t, p)) => {
                    let lead = if t >= 0 { p + w.vel(t as usize) * 0.6 } else { p };
                    (lead - pos).normalized()
                }
                None => forward_of(w.e(slot, E::YAW)),
            };
            // keep off the ground
            let floor = scene.ground_height(pos.x, pos.z);
            let want = if pos.y - floor < 12.0 { (want + Vec3::UP).normalized() } else { want };
            drive(w, slot, arch, want, None, dt);
            fire_control(w, slot, arch, tp);
        }
        B::TURRET => {
            fire_control(w, slot, arch, tp);
        }
        B::STRAFE => {
            let want = match tp {
                Some(t) => {
                    let d = (t - pos).flat();
                    let dist = d.len();
                    let radial = d.normalized();
                    w.s[slot].b[2] -= dt;
                    if w.s[slot].b[2] <= 0.0 {
                        let every = if bp(w, arch, 11) > 0.0 { bp(w, arch, 11) } else { 1.6 };
                        w.s[slot].b[2] = every * (0.6 + w.rng.next() * 0.8);
                        w.s[slot].b[4] = if w.rng.next() < 0.5 { -1.0 } else { 1.0 };
                    }
                    let side = w.s[slot].b[4];
                    let tangent = v3(-radial.z, 0.0, radial.x) * side;
                    let correction = clampf((dist - pref) / maxf(pref * 0.5, 1.0), -1.0, 1.0);
                    (tangent * 0.8 + radial * correction).normalized() * scale
                }
                None => Vec3::ZERO,
            };
            drive(w, slot, arch, want, tp, dt);
            fire_control(w, slot, arch, tp);
        }
        B::WAYPOINTS => {
            let path_id = bp(w, arch, 11) as usize;
            let look = if bp(w, arch, 12) > 0.0 { bp(w, arch, 12) } else { 6.0 };
            let gate_r = if bp(w, arch, 13) > 0.0 { bp(w, arch, 13) } else { 8.0 };
            let Some(points) = w.paths.get(path_id) else { return };
            let n = points.len();
            if n == 0 {
                return;
            }
            let i = (w.s[slot].b[5] as usize) % n;
            let gate = points[i];
            let next = points[(i + 1) % n];
            if gate.dist_xz_sq(pos) < gate_r * gate_r {
                let lap = w.s[slot].b[6] + if i + 1 == n { 1.0 } else { 0.0 };
                w.s[slot].b[6] = lap;
                w.s[slot].b[5] = ((i + 1) % n) as f32;
                w.emit_event(EV::GATE, slot as i32, -1, i as f32, pos, lap);
            }
            // aim between the gate and the one after it, by distance
            let d = gate.dist_xz_sq(pos);
            let t = clampf(1.0 - d / (look * look * 4.0), 0.0, 0.6);
            let aim = gate.lerp(next, t);
            let want = (aim - pos).normalized() * scale;
            drive(w, slot, arch, want, None, dt);
            fire_control(w, slot, arch, tp);
        }
        // the snake module steers its own heads
        B::SNAKE => {}
        _ => {}
    }
}
