//! Static geometry: colliders and zones.

use alloc::vec::Vec;

use crate::fmath::{absf, maxf, minf, DEG};
use crate::spec::physics as ps;

use super::{f, id, pairs, V2};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum GeoKind {
    None,
    Circle,
    Box,
    Chain,
}

/// Geometry shared by colliders and zones. A node box resolves to `Box` every
/// tick; a node that is not laid out leaves `valid` false.
pub(super) struct Geometry {
    pub(super) kind: GeoKind,
    pub(super) c: V2,
    pub(super) hw: f32,
    pub(super) hh: f32,
    /// Circle radius, chain thickness, or box corner radius.
    pub(super) r: f32,
    points: Vec<V2>,
    closed: bool,
    pub(super) node: i32,
    pub(super) pad: f32,
    pub(super) valid: bool,
    pub(super) lo: V2,
    pub(super) hi: V2,
}

impl Geometry {
    fn parse(params: &[f64]) -> Geometry {
        let mut g = Geometry {
            kind: GeoKind::None,
            c: V2::ZERO,
            hw: 0.0,
            hh: 0.0,
            r: 0.0,
            points: Vec::new(),
            closed: false,
            node: 0,
            pad: 0.0,
            valid: true,
            lo: V2::ZERO,
            hi: V2::ZERO,
        };
        let mut node_shape = false;
        let mut pending_x: Option<f32> = None;
        for (key, v) in pairs(params) {
            match key {
                ps::KEY_SHAPE => {
                    let shape = v as u32;
                    node_shape = shape == ps::SHAPE_NODE;
                    g.kind = match shape {
                        ps::SHAPE_CIRCLE => GeoKind::Circle,
                        ps::SHAPE_BOX | ps::SHAPE_NODE => GeoKind::Box,
                        ps::SHAPE_CHAIN => GeoKind::Chain,
                        _ => GeoKind::None,
                    };
                }
                ps::KEY_X => g.c.x = f(v),
                ps::KEY_Y => g.c.y = f(v),
                ps::KEY_RADIUS | ps::KEY_CORNER => g.r = maxf(0.0, f(v)),
                ps::KEY_HALF_WIDTH => g.hw = maxf(0.0, f(v)),
                ps::KEY_HALF_HEIGHT => g.hh = maxf(0.0, f(v)),
                ps::KEY_POINT_X => pending_x = Some(f(v)),
                ps::KEY_POINT_Y => {
                    if let Some(x) = pending_x.take() {
                        if g.points.len() < ps::MAX_POINTS {
                            g.points.push(V2::new(x, f(v)));
                        }
                    }
                }
                ps::KEY_CLOSED => g.closed = v != 0.0,
                ps::KEY_NODE => g.node = id(v),
                ps::KEY_PAD => g.pad = f(v),
                _ => {}
            }
        }
        if node_shape {
            if g.node == 0 {
                g.kind = GeoKind::None;
            } else {
                // resolved from layout at the next tick
                g.valid = false;
            }
        } else {
            g.node = 0;
        }
        g.bounds();
        g
    }

    pub(super) fn bounds(&mut self) {
        match self.kind {
            GeoKind::Circle => {
                self.lo = self.c.sub(V2::new(self.r, self.r));
                self.hi = self.c.add(V2::new(self.r, self.r));
            }
            GeoKind::Box => {
                self.lo = self.c.sub(V2::new(self.hw, self.hh));
                self.hi = self.c.add(V2::new(self.hw, self.hh));
            }
            GeoKind::Chain => {
                let (mut lo, mut hi) = (V2::new(f32::MAX, f32::MAX), V2::new(f32::MIN, f32::MIN));
                for p in &self.points {
                    lo = V2::new(minf(lo.x, p.x), minf(lo.y, p.y));
                    hi = V2::new(maxf(hi.x, p.x), maxf(hi.y, p.y));
                }
                self.lo = lo.sub(V2::new(self.r, self.r));
                self.hi = hi.add(V2::new(self.r, self.r));
            }
            GeoKind::None => {
                self.lo = V2::ZERO;
                self.hi = V2::ZERO;
            }
        }
    }

    pub(super) fn segments(&self) -> usize {
        let n = self.points.len();
        if n < 2 {
            0
        } else if self.closed {
            n
        } else {
            n - 1
        }
    }

    pub(super) fn segment(&self, i: usize) -> (V2, V2) {
        let n = self.points.len();
        (self.points[i], self.points[(i + 1) % n])
    }

    /// Point-in-shape for zones (a chain counts as its closed polygon).
    pub(super) fn contains(&self, p: V2) -> bool {
        if !self.valid {
            return false;
        }
        match self.kind {
            GeoKind::Circle => p.sub(self.c).len2() <= self.r * self.r,
            GeoKind::Box => absf(p.x - self.c.x) <= self.hw && absf(p.y - self.c.y) <= self.hh,
            GeoKind::Chain => {
                let n = self.points.len();
                if n < 3 {
                    return false;
                }
                let mut inside = false;
                let mut j = n - 1;
                for i in 0..n {
                    let (a, b) = (self.points[i], self.points[j]);
                    if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
                        inside = !inside;
                    }
                    j = i;
                }
                inside
            }
            GeoKind::None => false,
        }
    }
}

pub(super) struct Collider {
    pub(super) world: usize,
    pub(super) geo: Geometry,
    pub(super) restitution: f32,
    pub(super) friction: f32,
    pub(super) layer: u32,
    pub(super) mask: u32,
    pub(super) owner: i32,
    pub(super) owner_squash: f32,
    pub(super) owner_squash_limit: f32,
    /// Degrees converted to rad/s per px/s.
    pub(super) owner_spin: f32,
    pub(super) owner_spin_limit: f32,
    pub(super) owner_speed: f32,
}

impl Collider {
    /// None for a collider without geometry.
    pub(super) fn new(world: usize, params: &[f64]) -> Option<Collider> {
        let mut c = Collider {
            world,
            geo: Geometry::parse(params),
            restitution: 1.0,
            friction: 0.55,
            layer: 1,
            mask: 0xffff,
            owner: 0,
            owner_squash: 0.0,
            owner_squash_limit: 3.0,
            owner_spin: 0.0,
            owner_spin_limit: 50.0 * DEG,
            owner_speed: 0.0,
        };
        for (key, v) in pairs(params) {
            let x = f(v);
            match key {
                ps::KEY_LAYER => c.layer = v as u32,
                ps::KEY_MASK => c.mask = v as u32,
                ps::KEY_RESTITUTION => c.restitution = maxf(0.0, x),
                ps::KEY_FRICTION => c.friction = maxf(0.0, x),
                ps::KEY_OWNER => c.owner = id(v),
                ps::KEY_OWNER_SQUASH => c.owner_squash = maxf(0.0, x),
                ps::KEY_OWNER_SQUASH_LIMIT => c.owner_squash_limit = maxf(0.0, x),
                ps::KEY_OWNER_SPIN => c.owner_spin = x * DEG,
                ps::KEY_OWNER_SPIN_LIMIT => c.owner_spin_limit = maxf(0.0, x) * DEG,
                ps::KEY_OWNER_SPEED => c.owner_speed = maxf(0.0, x),
                _ => {}
            }
        }
        (c.geo.kind != GeoKind::None).then_some(c)
    }
}

pub(super) struct Zone {
    pub(super) world: usize,
    pub(super) geo: Geometry,
    pub(super) mask: u32,
    /// Bodies currently inside, as (slot, generation).
    pub(super) inside: Vec<(u32, u16)>,
}

impl Zone {
    /// None for a zone without geometry.
    pub(super) fn new(world: usize, params: &[f64]) -> Option<Zone> {
        let mut z = Zone { world, geo: Geometry::parse(params), mask: 0xffff, inside: Vec::new() };
        for (key, v) in pairs(params) {
            if key == ps::KEY_MASK {
                z.mask = v as u32;
            }
        }
        (z.geo.kind != GeoKind::None).then_some(z)
    }
}
