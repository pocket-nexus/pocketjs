//! Collision: a uniform grid on the ground plane, static colliders, and the
//! rule table that decides what a contact does.
//!
//! A pair is tested when one side's MASK has a bit of the other's LAYER. The
//! rules then run for every (a, b) orientation whose layers they name; a rule
//! that names both orientations runs once.

use crate::fmath::*;
use crate::schema::{arch as A, arch_flag as AF, event as EV, rule as R, state as ST};
use crate::scene::{Collider, Scene};
use crate::vec::*;
use crate::world::{World, KILL_EFFECTS, KILL_EVENT};
use alloc::vec;
use alloc::vec::Vec;

const BUCKETS: usize = 512;
const CELL: f32 = 4.0;

pub struct Broadphase {
    heads: Vec<i32>,
    next: Vec<i32>,
    slot_of: Vec<u16>,
    stamp: Vec<u32>,
    epoch: u32,
}

impl Default for Broadphase {
    fn default() -> Self {
        Broadphase { heads: vec![-1; BUCKETS], next: Vec::new(), slot_of: Vec::new(), stamp: Vec::new(), epoch: 1 }
    }
}

#[inline]
fn bucket(cx: i32, cz: i32) -> usize {
    ((cx.wrapping_mul(73_856_093) ^ cz.wrapping_mul(19_349_663)) as u32 as usize) % BUCKETS
}

#[inline]
fn cell_range(c: f32, r: f32) -> (i32, i32) {
    (floorf((c - r) / CELL) as i32, floorf((c + r) / CELL) as i32)
}

impl Broadphase {
    fn clear(&mut self, cap: usize) {
        for h in self.heads.iter_mut() {
            *h = -1;
        }
        self.next.clear();
        self.slot_of.clear();
        if self.stamp.len() < cap {
            self.stamp.resize(cap, 0);
        }
    }
    fn insert(&mut self, slot: usize, c: Vec3, r: f32) {
        let (x0, x1) = cell_range(c.x, r);
        let (z0, z1) = cell_range(c.z, r);
        // very large bodies are clamped to a 9x9 block of cells
        for cz in z0..=z1.min(z0 + 8) {
            for cx in x0..=x1.min(x0 + 8) {
                let b = bucket(cx, cz);
                self.next.push(self.heads[b]);
                self.slot_of.push(slot as u16);
                self.heads[b] = (self.next.len() - 1) as i32;
            }
        }
    }
}

#[inline]
fn center(w: &World, slot: usize) -> Vec3 {
    let p = w.pos(slot);
    v3(p.x, p.y + w.s[slot].k[7], p.z)
}

#[inline]
fn radius(w: &World, slot: usize, arch: usize) -> f32 {
    w.archs[arch][A::RADIUS] * (w.look[slot * 4] / w.archs[arch][A::SCALE])
}

fn skip_pair(w: &World, a: usize, aa: usize, b: usize, ab: usize) -> bool {
    let fa = w.archs[aa][A::FLAGS] as u32;
    let fb = w.archs[ab][A::FLAGS] as u32;
    let (sa, sb) = (&w.s[a], &w.s[b]);
    if fa & AF::PROJECTILE != 0 && (sa.owner == b as i32 || (sa.team != 0 && sa.team == sb.team)) {
        return true;
    }
    if fb & AF::PROJECTILE != 0 && (sb.owner == a as i32 || (sb.team != 0 && sb.team == sa.team)) {
        return true;
    }
    // two shots never meet
    fa & AF::PROJECTILE != 0 && fb & AF::PROJECTILE != 0
}

/// Who gets the credit for damage a slot deals: its shooter, if it has one.
fn credit(w: &World, slot: usize) -> i32 {
    let o = w.s[slot].owner;
    if o >= 0 {
        o
    } else {
        slot as i32
    }
}

fn apply(w: &mut World, rule: usize, a: usize, b: usize, ca: Vec3, cb: Vec3) {
    let r = w.rules[rule];
    let (Some(aa), Some(ab)) = (w.arch_of(a), w.arch_of(b)) else { return };
    let contact = ca.lerp(cb, 0.5);
    let dmg_a = if r.value != 0.0 { r.value } else { w.archs[aa][A::DAMAGE] };
    let dmg_b = if r.value != 0.0 { r.value } else { w.archs[ab][A::DAMAGE] };
    if r.flags & R::EVENT != 0 {
        w.emit_event(EV::HIT, a as i32, b as i32, rule as f32, contact, dmg_a);
    }
    if r.flags & R::DAMAGE_B != 0 {
        let by = credit(w, a);
        w.damage(b, dmg_a, by);
    }
    if r.flags & R::DAMAGE_A != 0 {
        let by = credit(w, b);
        w.damage(a, dmg_b, by);
    }
    if r.flags & R::PICKUP != 0 && w.alive(b) {
        w.emit_event(EV::PICKUP, a as i32, b as i32, ab as f32, contact, w.archs[ab][A::VALUE]);
        w.kill_mode(b, a as i32, KILL_EFFECTS);
    }
    if r.flags & R::KILL_A != 0 {
        let mode = if w.archs[aa][A::FLAGS] as u32 & AF::PROJECTILE != 0 { KILL_EFFECTS } else { KILL_EVENT };
        w.kill_mode(a, credit(w, b), mode);
    }
    if r.flags & R::KILL_B != 0 {
        let mode = if w.archs[ab][A::FLAGS] as u32 & AF::PROJECTILE != 0 { KILL_EFFECTS } else { KILL_EVENT };
        w.kill_mode(b, credit(w, a), mode);
    }
    if r.flags & R::PUSH != 0 {
        push_apart(w, a, aa, b, ab, ca, cb);
    }
    if r.flags & R::BOUNCE != 0 {
        let n = (ca - cb).flat().normalized();
        let v = w.vel(a);
        let vn = v.dot(n);
        if vn < 0.0 {
            w.set_vel(a, v - n * (2.0 * vn));
        }
    }
}

fn push_apart(w: &mut World, a: usize, aa: usize, b: usize, ab: usize, ca: Vec3, cb: Vec3) {
    let d = (ca - cb).flat();
    let dist = d.len();
    let overlap = radius(w, a, aa) + radius(w, b, ab) - dist;
    if overlap <= 0.0 {
        return;
    }
    let n = if dist > 1e-4 { d * (1.0 / dist) } else { v3(1.0, 0.0, 0.0) };
    let (ma, mb) = (maxf(w.archs[aa][A::MASS], 0.0), maxf(w.archs[ab][A::MASS], 0.0));
    // mass 0 counts as 1; a negative-free immovable body has MASS >= 1000
    let (ma, mb) = (if ma == 0.0 { 1.0 } else { ma }, if mb == 0.0 { 1.0 } else { mb });
    let ta = mb / (ma + mb);
    let tb = ma / (ma + mb);
    let pa = w.pos(a) + n * (overlap * ta);
    let pb = w.pos(b) - n * (overlap * tb);
    w.set_pos(a, pa);
    w.set_pos(b, pb);
}

/// Push a mover out of the static colliders; projectiles stop at them.
fn statics(w: &mut World, scene: &Scene, slot: usize, arch: usize) {
    let flags = w.archs[arch][A::FLAGS] as u32;
    if flags & AF::GHOST != 0 || scene.colliders.is_empty() {
        return;
    }
    let r = radius(w, slot, arch);
    if r <= 0.0 {
        return;
    }
    let mut p = w.pos(slot);
    let c = center(w, slot);
    let projectile = flags & AF::PROJECTILE != 0;
    for col in scene.colliders.iter() {
        match *col {
            Collider::Box { c: bc, half, yaw } => {
                if c.y - r > bc.y + half.y || c.y + r < bc.y - half.y {
                    continue;
                }
                let dx = p.x - bc.x;
                let dz = p.z - bc.z;
                if absf(dx) > half.x + half.z + r && absf(dz) > half.x + half.z + r {
                    continue;
                }
                let (s, co) = (sinf(yaw), cosf(yaw));
                // into the box's frame
                let lx = dx * co - dz * s;
                let lz = dx * s + dz * co;
                let qx = clampf(lx, -half.x, half.x);
                let qz = clampf(lz, -half.z, half.z);
                let ox = lx - qx;
                let oz = lz - qz;
                let d2 = ox * ox + oz * oz;
                if d2 >= r * r {
                    continue;
                }
                if projectile {
                    w.emit_event(EV::GROUND, slot as i32, w.s[slot].owner, arch as f32, p, -1.0);
                    w.kill_mode(slot, -1, KILL_EFFECTS);
                    return;
                }
                let (nx, nz, depth) = if d2 > 1e-8 {
                    let d = sqrtf(d2);
                    (ox / d, oz / d, r - d)
                } else {
                    // centre inside: leave by the nearest face
                    let px = half.x - absf(lx);
                    let pz = half.z - absf(lz);
                    if px < pz {
                        (signf(lx), 0.0, px + r)
                    } else {
                        (0.0, signf(lz), pz + r)
                    }
                };
                // back to world
                let wx = nx * co + nz * s;
                let wz = -nx * s + nz * co;
                p.x += wx * depth;
                p.z += wz * depth;
                let v = w.vel(slot);
                let vn = v.x * wx + v.z * wz;
                if vn < 0.0 {
                    w.set_vel(slot, v3(v.x - wx * vn, v.y, v.z - wz * vn));
                }
            }
            Collider::Cylinder { c: cc, r: cr, half_h } => {
                if c.y - r > cc.y + half_h || c.y + r < cc.y - half_h {
                    continue;
                }
                let d = v3(p.x - cc.x, 0.0, p.z - cc.z);
                let min = cr + r;
                let d2 = d.len_sq();
                if d2 >= min * min {
                    continue;
                }
                if projectile {
                    w.emit_event(EV::GROUND, slot as i32, w.s[slot].owner, arch as f32, p, -1.0);
                    w.kill_mode(slot, -1, KILL_EFFECTS);
                    return;
                }
                let dist = sqrtf(d2);
                let n = if dist > 1e-4 { d * (1.0 / dist) } else { v3(1.0, 0.0, 0.0) };
                p += n * (min - dist);
                let v = w.vel(slot);
                let vn = v.dot(n);
                if vn < 0.0 {
                    w.set_vel(slot, v - n * vn);
                }
            }
        }
    }
    w.set_pos(slot, p);
}

pub fn resolve(w: &mut World, scene: &Scene, _dt: f32) {
    let cap = w.cap;
    let mut bp = core::mem::take(&mut w.broad);
    bp.clear(cap);
    let live: Vec<u16> = w.live.clone();
    // static colliders first, so pairs see settled positions
    for &s in live.iter() {
        let s = s as usize;
        if w.state(s) & (ST::DEAD | ST::FROZEN) != 0 {
            continue;
        }
        if let Some(arch) = w.arch_of(s) {
            statics(w, scene, s, arch);
        }
    }
    for &s in live.iter() {
        let s = s as usize;
        if w.state(s) & ST::DEAD != 0 {
            continue;
        }
        let Some(arch) = w.arch_of(s) else { continue };
        let r = radius(w, s, arch);
        if r <= 0.0 || (w.s[s].layer | w.s[s].mask) == 0 {
            continue;
        }
        bp.insert(s, center(w, s), r);
    }
    let mut pairs = 0u32;
    let mut candidates: Vec<u16> = Vec::with_capacity(32);
    for &i in live.iter() {
        let i = i as usize;
        if w.state(i) & ST::DEAD != 0 || w.s[i].mask == 0 {
            continue;
        }
        let Some(ai) = w.arch_of(i) else { continue };
        let ri = radius(w, i, ai);
        if ri <= 0.0 {
            continue;
        }
        let ci = center(w, i);
        bp.epoch = bp.epoch.wrapping_add(1);
        if bp.epoch == 0 {
            for s in bp.stamp.iter_mut() {
                *s = 0;
            }
            bp.epoch = 1;
        }
        let epoch = bp.epoch;
        candidates.clear();
        let (x0, x1) = cell_range(ci.x, ri);
        let (z0, z1) = cell_range(ci.z, ri);
        for cz in z0..=z1.min(z0 + 8) {
            for cx in x0..=x1.min(x0 + 8) {
                let mut e = bp.heads[bucket(cx, cz)];
                while e >= 0 {
                    let j = bp.slot_of[e as usize] as usize;
                    e = bp.next[e as usize];
                    if j == i || bp.stamp[j] == epoch {
                        continue;
                    }
                    bp.stamp[j] = epoch;
                    candidates.push(j as u16);
                }
            }
        }
        // deterministic order whatever the bucket chains held
        candidates.sort_unstable();
        for &j in candidates.iter() {
            let j = j as usize;
            if w.state(i) & ST::DEAD != 0 {
                break;
            }
            if w.state(j) & ST::DEAD != 0 || w.s[i].mask & w.s[j].layer == 0 {
                continue;
            }
            // both see each other: the lower slot handles the pair
            if w.s[j].mask & w.s[i].layer != 0 && j < i {
                continue;
            }
            let Some(aj) = w.arch_of(j) else { continue };
            if skip_pair(w, i, ai, j, aj) {
                continue;
            }
            let cj = center(w, j);
            let rr = ri + radius(w, j, aj);
            if ci.dist_sq(cj) >= rr * rr {
                continue;
            }
            pairs += 1;
            let (li, lj) = (w.s[i].layer, w.s[j].layer);
            let solid = w.archs[ai][A::SOLID] > 0.5 && w.archs[aj][A::SOLID] > 0.5;
            if solid {
                push_apart(w, i, ai, j, aj, ci, cj);
            }
            for r in 0..w.rules.len() {
                let rule = w.rules[r];
                let fwd = li & rule.a != 0 && lj & rule.b != 0;
                let rev = lj & rule.a != 0 && li & rule.b != 0;
                if fwd {
                    apply(w, r, i, j, ci, cj);
                } else if rev {
                    apply(w, r, j, i, cj, ci);
                }
            }
        }
    }
    w.pairs = pairs;
    w.broad = bp;
}
