//! Contacts: sample circles against shapes, then position correction, a
//! restitution impulse above `bounceSpeed`, Coulomb friction, jelly
//! responses, hit events and owner kicks.
//!
//! A body collides as sample circles (one for a circle, eight for a rounded
//! box). Samples meet static colliders and the exact shape of other bodies.
//! Each sample is placed from the body's current position, so a correction
//! applied for one sample moves every later sample with the body.

use alloc::vec::Vec;

use crate::fmath::{absf, atan2f, clampf, minf, signf};
use crate::spec::physics as ps;

use super::body::{Body, Shape};
use super::shape::{Collider, GeoKind, Geometry};
use super::{Events, V2};

/// Fraction of a pair's penetration corrected per contact.
const PAIR_CORRECTION: f32 = 0.7;
/// Largest squash velocity one contact adds.
const IMPACT_SQUASH_MAX: f32 = 5.5;
/// Largest lean velocity one contact adds, rad/s (172 °/s).
const IMPACT_LEAN_MAX: f32 = 3.0;
/// Dents below this are ignored.
const DENT_MIN: f32 = 0.035;

/// A collider impact to pass to its owner after the pass.
pub(super) struct OwnerKick {
    pub(super) owner: i32,
    pub(super) squash: f32,
    /// Spin magnitude (rad/s) signed by the collider's ownerSpin.
    pub(super) spin: f32,
    /// World x of the contact, for the side of the owner it struck.
    pub(super) x: f32,
}

/// Inverse mass and inertia a body contributes to a contact this pass.
fn contact_mass(b: &Body) -> (f32, f32) {
    if b.in_flight() || b.is_carried() {
        return (0.0, 0.0);
    }
    if matches!(b.grab, Some(ref g) if g.mode == ps::GRAB_TETHER) {
        return (b.inv_mass * 0.2, b.inv_inertia * 0.2);
    }
    (b.inv_mass, b.inv_inertia)
}

/// Rounded box (centre, sin/cos of its angle, half extents, corner) against
/// a circle: (normal from the box toward the circle, penetration) or None.
#[allow(clippy::too_many_arguments)]
fn box_circle(bc: V2, s: f32, c: f32, hw: f32, hh: f32, rc: f32, p: V2, r: f32) -> Option<(V2, f32)> {
    let d = p.sub(bc);
    let reach = hw + hh + r;
    if !(d.len2() < reach * reach) {
        return None;
    }
    let l = d.rot(-s, c);
    let (ex, ey) = ((hw - rc).max(0.0), (hh - rc).max(0.0));
    let q = V2::new(clampf(l.x, -ex, ex), clampf(l.y, -ey, ey));
    let off = l.sub(q);
    let dl = off.len();
    let (n, dist) = if dl > 1e-6 {
        (off.mul(1.0 / dl), dl - rc)
    } else {
        let (px, py) = (ex - absf(l.x), ey - absf(l.y));
        if px < py {
            (V2::new(signf(l.x), 0.0), -px - rc)
        } else {
            (V2::new(0.0, signf(l.y)), -py - rc)
        }
    };
    let pen = r - dist;
    if !(pen > 0.0) {
        return None;
    }
    Some((n.rot(s, c), pen))
}

/// A sample circle against a body's cached shape.
fn body_contact(b: &Body, p: V2, r: f32) -> Option<(V2, f32)> {
    let c = b.centre();
    match b.cache.shape {
        Shape::Circle { r: rb } => {
            let d = p.sub(c);
            let dl = d.len();
            if !(dl < r + rb) || dl <= 1e-6 {
                return None;
            }
            Some((d.mul(1.0 / dl), r + rb - dl))
        }
        Shape::Box { hw, hh, rc } => box_circle(c, b.cache.sin, b.cache.cos, hw, hh, rc, p, r),
        Shape::None => None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn collide_bodies(a: &mut Body, b: &mut Body, ha: i32, hb: i32, now: u64, cooldown: u64, events: &mut Events) {
    let (ma, _) = contact_mass(a);
    let (mb, _) = contact_mass(b);
    if ma == 0.0 && mb == 0.0 {
        return;
    }
    if matches!(a.shape, Shape::None) || matches!(b.shape, Shape::None) || !a.solid() || !b.solid() {
        return;
    }
    let reach = a.cache.radius + b.cache.radius;
    if !(a.centre().sub(b.centre()).len2() < reach * reach) {
        return;
    }
    let circles = matches!(a.cache.shape, Shape::Circle { .. }) && matches!(b.cache.shape, Shape::Circle { .. });
    let mut samples = [(V2::ZERO, 0.0f32); 8];
    // A's samples against B's shape; B's against A's only when none of A's
    // touched, so one overlap is never resolved from both sides
    let mut touched = false;
    for pass in 0..2 {
        if pass == 1 && (circles || touched) {
            break;
        }
        let n = if pass == 0 { a.sample_offsets(&mut samples) } else { b.sample_offsets(&mut samples) };
        for &(offset, r) in &samples[..n] {
            let (first, second) = if pass == 0 { (&*a, &*b) } else { (&*b, &*a) };
            let p = first.p.add(offset);
            let Some((normal, pen)) = body_contact(second, p, r) else { continue };
            let point = p.sub(normal.mul(r));
            touched = true;
            // `normal` points from `second` toward `first`
            if pass == 0 {
                resolve_pair(a, b, ha, hb, point, normal, pen, now, cooldown, events);
            } else {
                resolve_pair(b, a, hb, ha, point, normal, pen, now, cooldown, events);
            }
        }
    }
}

/// Resolve one contact; `n` points from `b` toward `a`.
#[allow(clippy::too_many_arguments)]
fn resolve_pair(a: &mut Body, b: &mut Body, ha: i32, hb: i32, point: V2, n: V2, pen: f32, now: u64, cooldown: u64, events: &mut Events) {
    let (ima, iia) = contact_mass(a);
    let (imb, iib) = contact_mass(b);
    let msum = ima + imb;
    if msum == 0.0 {
        return;
    }
    let corr = pen * PAIR_CORRECTION / msum;
    a.p = a.p.add(n.mul(corr * ima));
    b.p = b.p.sub(n.mul(corr * imb));
    let ra = point.sub(a.centre());
    let rb = point.sub(b.centre());
    let rv = a.v.add(V2::spin(a.w, ra)).sub(b.v.add(V2::spin(b.w, rb)));
    let vn = rv.dot(n);
    if !(vn < 0.0) {
        return;
    }
    let speed = -vn;
    let e = if speed > minf(a.bounce_speed, b.bounce_speed) { minf(a.restitution, b.restitution) } else { 0.0 };
    let rna = ra.cross(n);
    let rnb = rb.cross(n);
    let jn = -(1.0 + e) * vn / (msum + rna * rna * iia + rnb * rnb * iib);
    a.v = a.v.add(n.mul(jn * ima));
    a.w += rna * jn * iia;
    b.v = b.v.sub(n.mul(jn * imb));
    b.w -= rnb * jn * iib;
    // friction
    let t = V2::new(-n.y, n.x);
    let rv = a.v.add(V2::spin(a.w, ra)).sub(b.v.add(V2::spin(b.w, rb)));
    let vt = rv.dot(t);
    let rta = ra.cross(t);
    let rtb = rb.cross(t);
    let mu = 0.5 * (a.friction + b.friction);
    let jt = clampf(-vt / (msum + rta * rta * iia + rtb * rtb * iib), -mu * jn, mu * jn);
    a.v = a.v.add(t.mul(jt * ima));
    a.w += rta * jt * iia;
    b.v = b.v.sub(t.mul(jt * imb));
    b.w -= rtb * jt * iib;
    react(a, n, jn * ima, speed);
    react(b, n.mul(-1.0), jn * imb, speed);
    hit_event(a, ha, hb, point, n, speed, now, cooldown, events);
    hit_event(b, hb, ha, point, n.mul(-1.0), speed, now, cooldown, events);
}

/// Jelly response to a contact on `b`: `n` points toward `b`, `dv` is the
/// velocity change the impulse gave it, `speed` the approach speed.
fn react(b: &mut Body, n: V2, dv: f32, speed: f32) {
    let impact_axis = b.jelly.impact_axis();
    let j = &mut b.jelly;
    if speed < j.min_speed {
        return;
    }
    if dv > 0.0 && (j.impact > 0.0 || j.lean_impact > 0.0) {
        let nl = n.rot(crate::fmath::sinf(-b.a), crate::fmath::cosf(-b.a));
        if j.impact > 0.0 {
            let kick = minf(IMPACT_SQUASH_MAX, dv * j.impact);
            j.vq += kick * (absf(nl.y) - 0.55 * absf(nl.x));
        }
        if j.lean_impact > 0.0 {
            // the body shears away from the side it was pushed on
            j.vlean += clampf(nl.x * dv * j.lean_impact, -IMPACT_LEAN_MAX, IMPACT_LEAN_MAX);
        }
    }
    if j.dent > 0.0 {
        let amt = minf(j.dent_limit, speed * j.dent);
        if amt > DENT_MIN && amt > absf(j.q) {
            j.q = amt;
            j.vq = 0.0;
            if impact_axis {
                j.axis = atan2f(n.y, n.x);
            }
        }
    }
    // pushed up from below: a hop gives way to the springs
    if b.airborne && n.y < -0.5 && dv > 0.0 {
        b.airborne = false;
    }
}

#[allow(clippy::too_many_arguments)]
fn hit_event(b: &mut Body, own: i32, other: i32, point: V2, n: V2, speed: f32, now: u64, cooldown: u64, events: &mut Events) {
    if b.hit_speed > 0.0 && speed >= b.hit_speed && b.hit_step.is_none_or(|step| now - step >= cooldown) {
        b.hit_step = Some(now);
        events.push(ps::EVENT_HIT, own, other, point.x, point.y, n.x, n.y, speed);
    }
}

/// A sample circle against static geometry: (normal from the geometry toward
/// the sample, penetration). A chain answers with its deepest segment, so a
/// joint between two segments does not push twice.
fn geo_circle(geo: &Geometry, p: V2, r: f32) -> Option<(V2, f32)> {
    match geo.kind {
        GeoKind::Circle => {
            let d = p.sub(geo.c);
            let dl = d.len();
            if !(dl < geo.r + r) || dl <= 1e-6 {
                return None;
            }
            Some((d.mul(1.0 / dl), geo.r + r - dl))
        }
        GeoKind::Box => box_circle(geo.c, 0.0, 1.0, geo.hw, geo.hh, minf(geo.r, minf(geo.hw, geo.hh)), p, r),
        GeoKind::Chain => {
            if !(p.x + r >= geo.lo.x && p.x - r <= geo.hi.x && p.y + r >= geo.lo.y && p.y - r <= geo.hi.y) {
                return None;
            }
            let mut best: Option<(V2, f32)> = None;
            for i in 0..geo.segments() {
                let (a, b) = geo.segment(i);
                let ab = b.sub(a);
                let l2 = ab.len2();
                let t = if l2 > 0.0 { clampf(p.sub(a).dot(ab) / l2, 0.0, 1.0) } else { 0.0 };
                let d = p.sub(a.add(ab.mul(t)));
                let dl = d.len();
                let pen = geo.r + r - dl;
                if !(pen > 0.0) {
                    continue;
                }
                let n = if dl > 1e-6 {
                    d.mul(1.0 / dl)
                } else {
                    let len = l2.max(0.0);
                    if len > 0.0 {
                        let len = crate::fmath::sqrtf(len);
                        V2::new(-ab.y / len, ab.x / len)
                    } else {
                        V2::new(0.0, -1.0)
                    }
                };
                if best.is_none_or(|(_, deepest)| pen > deepest) {
                    best = Some((n, pen));
                }
            }
            best
        }
        GeoKind::None => None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn collide_static(
    b: &mut Body,
    c: &Collider,
    handle: i32,
    chandle: i32,
    now: u64,
    cooldown: u64,
    events: &mut Events,
    kicks: &mut Vec<OwnerKick>,
) {
    if !b.overlaps(c.geo.lo, c.geo.hi) {
        return;
    }
    let mut samples = [(V2::ZERO, 0.0f32); 8];
    let n = b.sample_offsets(&mut samples);
    for &(offset, sr) in &samples[..n] {
        let p = b.p.add(offset);
        let Some((normal, pen)) = geo_circle(&c.geo, p, sr) else { continue };
        let point = p.sub(normal.mul(sr));
        let speed = resolve_static(b, point, normal, pen, c.restitution, c.friction);
        if speed <= 0.0 {
            continue;
        }
        if normal.y < -0.7 {
            b.ground_step = Some(now);
            if let Some((vx, spin)) = b.settle.take() {
                b.v.x *= vx;
                b.w *= spin;
            }
        }
        react(b, normal, speed * (1.0 + minf(b.restitution, c.restitution)), speed);
        hit_event(b, handle, chandle, point, normal, speed, now, cooldown, events);
        if c.owner != 0 && speed >= c.owner_speed && (c.owner_squash > 0.0 || c.owner_spin != 0.0) {
            kicks.push(OwnerKick {
                owner: c.owner,
                squash: minf(c.owner_squash_limit, speed * c.owner_squash),
                spin: minf(c.owner_spin_limit, speed * absf(c.owner_spin)) * signf(c.owner_spin),
                x: point.x,
            });
        }
    }
}

/// Resolve a contact against static geometry; returns the approach speed
/// (0 when separating).
fn resolve_static(b: &mut Body, point: V2, n: V2, pen: f32, restitution: f32, friction: f32) -> f32 {
    let (im, ii) = contact_mass(b);
    if im == 0.0 {
        return 0.0;
    }
    b.p = b.p.add(n.mul(pen));
    let r = point.add(n.mul(pen)).sub(b.centre());
    let vp = b.v.add(V2::spin(b.w, r));
    let vn = vp.dot(n);
    if !(vn < 0.0) {
        return 0.0;
    }
    let speed = -vn;
    let e = if speed > b.bounce_speed { minf(b.restitution, restitution) } else { 0.0 };
    let rn = r.cross(n);
    let jn = -(1.0 + e) * vn / (im + rn * rn * ii);
    b.v = b.v.add(n.mul(jn * im));
    b.w += rn * jn * ii;
    let t = V2::new(-n.y, n.x);
    let vt = b.v.add(V2::spin(b.w, r)).dot(t);
    let rt = r.cross(t);
    let mu = 0.5 * (b.friction + friction);
    let jt = clampf(-vt / (im + rt * rt * ii), -mu * jn, mu * jn);
    b.v = b.v.add(t.mul(jt * im));
    b.w += rt * jt * ii;
    speed
}
