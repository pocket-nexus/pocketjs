//! The marble module: a plate that tilts under the stick, a ball rolling on
//! it under the projected gravity with friction, walls and moving blocks as
//! boxes on the plate, holes, stars and a goal (GameBlocks' marble-puzzle
//! Game.updatePhysics and PlateTiltController, xt4d/GameBlocks, MIT), plus
//! the grid A* route its PlayerAi plans.
//!
//! Gameplay runs in the plate's own frame, (right, forward) with up out of
//! the plate, as the demo's does; the plate's tilt only reaches the world
//! through matrices. Every step the module writes the level node's matrix
//! (the plate with its walls, holes and goal, one dynamic scene node), each
//! moving block node's, and the world positions of the marble and star
//! slots, so the whole level tilts together.
//!
//! Plate-local (right, up, forward) is playset (x, y, -z) before the tilt.
//! The tilt is R = Rz(rightTilt) * Rx(forwardTilt): the demo's
//! boardGroup.quaternion (about the basis forward axis by -rightTilt, then
//! the right axis by forwardTilt) carried into the playset's axes.
//!
//! The marble slot's intents steer it: X right (+) / left (-), FWD forward
//! (+) / backward (-), each 0..1 as the demo's key or autopilot signals.

use crate::fmath::*;
use crate::scene::Scene;
use crate::schema::{ent as E, event as EV, intent as I};
use crate::vec::*;
use crate::world::{World, KILL_EFFECTS, KILL_SILENT};
use alloc::collections::BinaryHeap;
use alloc::vec::Vec;

/// Call ops (framework/src/playset/marble.ts names them).
pub mod op {
    /// sizeR, sizeF, startR, startF, goalR, goalF, goalRadius, radius, cx,
    /// cy, cz, level node, marble arch, star arch, star up: a new level
    /// (frozen); returns the marble slot
    pub const LEVEL: u32 = 1;
    /// r, f, width, depth
    pub const WALL: u32 = 2;
    /// r, f, width, depth, axis (0 right, 1 forward), distance, speed,
    /// node, height: after the walls (its travel stops short of them)
    pub const BLOCK: u32 = 3;
    /// r, f, radius
    pub const HOLE: u32 = 4;
    /// r, f: a star slot; returns it
    pub const STAR: u32 = 5;
    /// PHASE value
    pub const PHASE: u32 = 6;
    /// maxTilt, tiltLag, gravity, friction, maxSpeed
    pub const TUNE: u32 = 7;
    /// STATE fields into `out`; returns the phase
    pub const STATE: u32 = 8;
    /// toR, toF, cell, boardMargin, wallPad, holePad, blockPad: the
    /// autopilot's route from the marble into `out` as (r, f) pairs;
    /// returns the waypoint count
    pub const ROUTE: u32 = 9;
}

/// PHASE values.
pub mod phase {
    /// nothing moves (the title before a run)
    pub const FROZEN: u32 = 0;
    pub const PLAYING: u32 = 1;
    /// fell through a hole: sinking, the plate still tilts
    pub const FAILED: u32 = 2;
    /// reached the goal: the marble settles, the plate still tilts
    pub const DONE: u32 = 3;
}

/// STATE output fields; moving blocks follow as (r, f) pairs from BLOCKS.
pub mod state {
    pub const PHASE: usize = 0;
    pub const RIGHT: usize = 1;
    pub const FORWARD: usize = 2;
    pub const UP: usize = 3;
    pub const VR: usize = 4;
    pub const VF: usize = 5;
    pub const TILT_RIGHT: usize = 6;
    pub const TILT_FORWARD: usize = 7;
    pub const COLLECTED: usize = 8;
    pub const ELAPSED: usize = 9;
    pub const SPEED: usize = 10;
    pub const BLOCK_COUNT: usize = 11;
    pub const BLOCKS: usize = 12;
}

/// An open Dijkstra entry, the lowest cost first.
#[derive(Clone, Copy, PartialEq)]
struct Open {
    score: f32,
    cell: u32,
}

impl Eq for Open {}

impl Ord for Open {
    fn cmp(&self, o: &Self) -> core::cmp::Ordering {
        // BinaryHeap pops the greatest: reverse the keys
        o.score.total_cmp(&self.score).then(o.cell.cmp(&self.cell))
    }
}

impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

#[derive(Clone, Copy, Default)]
struct Rect {
    r: f32,
    f: f32,
    w: f32,
    d: f32,
}

impl Rect {
    #[inline]
    fn contains(&self, r: f32, f: f32, pad: f32) -> bool {
        absf(r - self.r) <= self.w * 0.5 + pad && absf(f - self.f) <= self.d * 0.5 + pad
    }
}

#[derive(Clone, Copy, Default)]
struct Block {
    base: Rect,
    /// 0 right, 1 forward
    axis: u32,
    /// travel after resolveMovingBlockTravelDistance
    travel: f32,
    speed: f32,
    node: i32,
    up: f32,
    cr: f32,
    cf: f32,
}

impl Block {
    fn rect(&self) -> Rect {
        Rect { r: self.cr, f: self.cf, ..self.base }
    }
}

#[derive(Clone, Copy, Default)]
struct Hole {
    r: f32,
    f: f32,
    radius: f32,
}

#[derive(Clone, Copy, Default)]
struct Star {
    r: f32,
    f: f32,
    slot: i32,
    collected: bool,
}

pub struct Marble {
    active: bool,
    phase: u32,
    half_r: f32,
    half_f: f32,
    start: (f32, f32),
    goal: Hole,
    walls: Vec<Rect>,
    blocks: Vec<Block>,
    holes: Vec<Hole>,
    stars: Vec<Star>,
    center: Vec3,
    level_node: i32,
    marble_arch: i32,
    star_arch: i32,
    star_up: f32,
    slot: i32,
    radius: f32,
    r: f32,
    f: f32,
    up: f32,
    vr: f32,
    vf: f32,
    fall_speed: f32,
    spin: Quat,
    tilt_r: f32,
    tilt_f: f32,
    max_tilt: f32,
    tilt_lag: f32,
    gravity: f32,
    friction: f32,
    max_speed: f32,
    elapsed: f32,
    time: f32,
    collected: u32,
    bump_cool: f32,
    plate: Mat34,
    // the planner's reused buffers; `walk` holds for one level and padding
    walk: Vec<bool>,
    walk_key: [f32; 6],
    geometry: u32,
    /// the cost to the goal per cell, for `field_key` and `field_goal`
    cost: Vec<f32>,
    field_key: [f32; 6],
    field_goal: i32,
    open: BinaryHeap<Open>,
    pts: Vec<(f32, f32)>,
}

impl Default for Marble {
    fn default() -> Self {
        Marble {
            active: false,
            phase: phase::FROZEN,
            half_r: 9.0,
            half_f: 7.0,
            start: (0.0, 0.0),
            goal: Hole::default(),
            walls: Vec::new(),
            blocks: Vec::new(),
            holes: Vec::new(),
            stars: Vec::new(),
            center: Vec3::ZERO,
            level_node: -1,
            marble_arch: -1,
            star_arch: -1,
            star_up: 0.72,
            slot: -1,
            radius: 0.42,
            r: 0.0,
            f: 0.0,
            up: 0.42,
            vr: 0.0,
            vf: 0.0,
            fall_speed: 0.0,
            spin: Quat::IDENTITY,
            tilt_r: 0.0,
            tilt_f: 0.0,
            max_tilt: 0.22,
            tilt_lag: 0.09,
            gravity: 15.5,
            friction: 0.72,
            max_speed: 12.0,
            elapsed: 0.0,
            time: 0.0,
            collected: 0,
            bump_cool: 0.0,
            plate: Mat34::IDENTITY,
            walk: Vec::new(),
            walk_key: [-1.0; 6],
            geometry: 0,
            cost: Vec::new(),
            field_key: [-1.0; 6],
            field_goal: -1,
            open: BinaryHeap::new(),
            pts: Vec::new(),
        }
    }
}

const BUMP_SPEED: f32 = 1.2;

impl Marble {
    /// The plate's world matrix: the tilt about the plate centre, then the centre.
    fn plate_matrix(&self) -> Mat34 {
        let (sa, ca) = (sinf(self.tilt_r), cosf(self.tilt_r));
        let (sb, cb) = (sinf(self.tilt_f), cosf(self.tilt_f));
        let c = self.center;
        Mat34([ca, -sa * cb, sa * sb, c.x, sa, ca * cb, -ca * sb, c.y, 0.0, sb, cb, c.z])
    }

    /// A plate-local (right, up, forward) point in the world.
    #[inline]
    fn world(&self, r: f32, up: f32, f: f32) -> Vec3 {
        self.plate.point(v3(r, up, -f))
    }

    fn owns(w: &World, slot: i32, arch: i32) -> bool {
        slot >= 0 && arch >= 0 && w.alive(slot as usize) && w.arch_of(slot as usize) == Some(arch as usize)
    }

    fn release(&mut self, w: &mut World) {
        if Self::owns(w, self.slot, self.marble_arch) {
            w.kill_mode(self.slot as usize, -1, KILL_SILENT);
        }
        for s in self.stars.iter() {
            if !s.collected && Self::owns(w, s.slot, self.star_arch) {
                w.kill_mode(s.slot as usize, -1, KILL_SILENT);
            }
        }
        self.slot = -1;
        self.stars.clear();
        self.walls.clear();
        self.blocks.clear();
        self.holes.clear();
    }

    /// resolveMovingBlockTravelDistance: the travel stops 0.12 short of the
    /// plate edge and of any wall in the block's lane.
    fn travel(&self, b: &Rect, axis: u32, distance: f32) -> f32 {
        let gap = 0.12;
        let mut pos = distance;
        let mut neg = distance;
        let overlap = |ca: f32, sa: f32, cb: f32, sb: f32| absf(ca - cb) <= (sa + sb) * 0.5;
        if axis == 0 {
            pos = minf(pos, self.half_r - b.w * 0.5 - gap - b.r);
            neg = minf(neg, b.r - (-self.half_r + b.w * 0.5 + gap));
            for wl in self.walls.iter() {
                if !overlap(b.f, b.d, wl.f, wl.d) {
                    continue;
                }
                let (wl_lo, wl_hi) = (wl.r - wl.w * 0.5, wl.r + wl.w * 0.5);
                let (b_lo, b_hi) = (b.r - b.w * 0.5, b.r + b.w * 0.5);
                if wl_lo >= b_hi {
                    pos = minf(pos, wl_lo - b_hi - gap);
                } else if wl_hi <= b_lo {
                    neg = minf(neg, b_lo - wl_hi - gap);
                } else {
                    pos = 0.0;
                    neg = 0.0;
                }
            }
        } else {
            pos = minf(pos, self.half_f - b.d * 0.5 - gap - b.f);
            neg = minf(neg, b.f - (-self.half_f + b.d * 0.5 + gap));
            for wl in self.walls.iter() {
                if !overlap(b.r, b.w, wl.r, wl.w) {
                    continue;
                }
                let (wl_lo, wl_hi) = (wl.f - wl.d * 0.5, wl.f + wl.d * 0.5);
                let (b_lo, b_hi) = (b.f - b.d * 0.5, b.f + b.d * 0.5);
                if wl_lo >= b_hi {
                    pos = minf(pos, wl_lo - b_hi - gap);
                } else if wl_hi <= b_lo {
                    neg = minf(neg, b_lo - wl_hi - gap);
                } else {
                    pos = 0.0;
                    neg = 0.0;
                }
            }
        }
        maxf(0.0, minf(distance, minf(pos, neg)))
    }

    /// collideCircleWithRect: push out, reflect with `bounce`; the speed
    /// into the face when it hit.
    fn collide(&mut self, rect: Rect, bounce: f32) -> f32 {
        let (hw, hd) = (rect.w * 0.5, rect.d * 0.5);
        let cr = clampf(self.r, rect.r - hw, rect.r + hw);
        let cf = clampf(self.f, rect.f - hd, rect.f + hd);
        let mut dr = self.r - cr;
        let mut df = self.f - cf;
        let mut d2 = dr * dr + df * df;
        if d2 > self.radius * self.radius {
            return 0.0;
        }
        if d2 < 1e-8 {
            let or = hw + self.radius - absf(self.r - rect.r);
            let of = hd + self.radius - absf(self.f - rect.f);
            let sign = |v: f32| if v < 0.0 { -1.0 } else { 1.0 };
            if or < of {
                dr = sign(self.r - rect.r);
                df = 0.0;
            } else {
                dr = 0.0;
                df = sign(self.f - rect.f);
            }
            d2 = 1.0;
        }
        let d = sqrtf(d2);
        let (nr, nf) = (dr / d, df / d);
        let push = self.radius - d + 0.002;
        self.r += nr * push;
        self.f += nf * push;
        let vn = self.vr * nr + self.vf * nf;
        if vn < 0.0 {
            self.vr -= (1.0 + bounce) * vn * nr;
            self.vf -= (1.0 + bounce) * vn * nf;
            return -vn;
        }
        0.0
    }

    fn bump(&mut self, w: &mut World, which: i32, speed: f32) {
        if speed < BUMP_SPEED || self.bump_cool > 0.0 {
            return;
        }
        self.bump_cool = 0.08;
        let p = self.world(self.r, self.up, self.f);
        w.emit_event(EV::HIT, self.slot, -1, which as f32, p, speed);
    }

    fn physics(&mut self, w: &mut World, dt: f32) {
        let k = self.max_tilt;
        let slope_r = clampf(-self.tilt_r / k, -1.0, 1.0);
        let slope_f = clampf(-self.tilt_f / k, -1.0, 1.0);
        self.vr += slope_r * self.gravity * dt;
        self.vf += slope_f * self.gravity * dt;
        let fr = expf(-self.friction * dt);
        self.vr *= fr;
        self.vf *= fr;
        let speed = sqrtf(self.vr * self.vr + self.vf * self.vf);
        if speed > self.max_speed {
            let s = self.max_speed / speed;
            self.vr *= s;
            self.vf *= s;
        }
        self.r += self.vr * dt;
        self.f += self.vf * dt;
        // keepInsideBoard
        let (mr, mf) = (self.half_r - self.radius, self.half_f - self.radius);
        let mut edge = 0.0f32;
        if self.r < -mr {
            self.r = -mr;
            edge = maxf(edge, absf(self.vr));
            self.vr = absf(self.vr) * 0.68;
        } else if self.r > mr {
            self.r = mr;
            edge = maxf(edge, absf(self.vr));
            self.vr = -absf(self.vr) * 0.68;
        }
        if self.f < -mf {
            self.f = -mf;
            edge = maxf(edge, absf(self.vf));
            self.vf = absf(self.vf) * 0.68;
        } else if self.f > mf {
            self.f = mf;
            edge = maxf(edge, absf(self.vf));
            self.vf = -absf(self.vf) * 0.68;
        }
        self.bump(w, -1, edge);
        for i in 0..self.walls.len() {
            let hit = self.collide(self.walls[i], 0.7);
            self.bump(w, i as i32, hit);
        }
        for i in 0..self.blocks.len() {
            let hit = self.collide(self.blocks[i].rect(), 0.82);
            self.bump(w, (self.walls.len() + i) as i32, hit);
        }
        for i in 0..self.holes.len() {
            let h = self.holes[i];
            let (dr, df) = (self.r - h.r, self.f - h.f);
            if dr * dr + df * df < (h.radius * 0.78) * (h.radius * 0.78) {
                self.phase = phase::FAILED;
                self.fall_speed = 3.8;
                let p = self.world(self.r, self.up, self.f);
                w.emit_event(EV::MARBLE, self.slot, -1, i as f32, p, self.elapsed);
                return;
            }
        }
        for i in 0..self.stars.len() {
            let s = self.stars[i];
            if s.collected {
                continue;
            }
            let (dr, df) = (self.r - s.r, self.f - s.f);
            if dr * dr + df * df < 0.82 * 0.82 {
                self.stars[i].collected = true;
                self.collected += 1;
                if Self::owns(w, s.slot, self.star_arch) {
                    w.kill_mode(s.slot as usize, self.slot, KILL_EFFECTS);
                }
                let p = self.world(s.r, self.star_up, s.f);
                w.emit_event(EV::PICKUP, self.slot, s.slot, i as f32, p, self.collected as f32);
            }
        }
        let g = self.goal;
        let (dr, df) = (self.r - g.r, self.f - g.f);
        if dr * dr + df * df < (g.radius * 0.5) * (g.radius * 0.5) && sqrtf(self.vr * self.vr + self.vf * self.vf) < 5.5 {
            self.phase = phase::DONE;
            let p = self.world(self.r, self.up, self.f);
            w.emit_event(EV::MARBLE, self.slot, -1, -1.0, p, self.elapsed);
        }
    }

    pub fn step(&mut self, w: &mut World, scene: &mut Scene, dt: f32) {
        if !self.active {
            return;
        }
        if self.phase != phase::FROZEN {
            self.time += dt;
            self.bump_cool = maxf(self.bump_cool - dt, 0.0);
            for b in self.blocks.iter_mut() {
                let off = sinf(self.time * b.speed) * b.travel;
                b.cr = b.base.r + if b.axis == 0 { off } else { 0.0 };
                b.cf = b.base.f + if b.axis == 1 { off } else { 0.0 };
            }
            // PlateTiltController.move: the tilt eases toward the stick
            let (ix, iz) = if self.slot >= 0 && (self.slot as usize) < w.cap {
                (clampf(w.intent(self.slot as usize, I::X), -1.0, 1.0), clampf(w.intent(self.slot as usize, I::FWD), -1.0, 1.0))
            } else {
                (0.0, 0.0)
            };
            let k = if self.tilt_lag > 0.0 { 1.0 - expf(-dt / self.tilt_lag) } else { 1.0 };
            self.tilt_r += (-ix * self.max_tilt - self.tilt_r) * k;
            self.tilt_f += (-iz * self.max_tilt - self.tilt_f) * k;
            if self.phase == phase::PLAYING {
                self.elapsed += dt;
                let (r0, f0) = (self.r, self.f);
                self.physics(w, dt);
                // the roll: about up x velocity by distance / radius
                let (dr, df) = (self.r - r0, self.f - f0);
                let dist = sqrtf(dr * dr + df * df);
                if dist > 1e-5 {
                    let axis = v3(-df, 0.0, -dr) * (1.0 / dist);
                    self.spin = Quat::axis_angle(axis, dist / self.radius).mul(self.spin).normalized();
                }
                self.up = self.radius;
            } else {
                let d = expf(-1.8 * dt);
                self.vr *= d;
                self.vf *= d;
                self.up = if self.phase == phase::FAILED { self.up - self.fall_speed * dt } else { self.radius };
            }
        }
        self.pose(w, scene);
    }

    /// The level node, block nodes, marble and stars, tilted together.
    fn pose(&mut self, w: &mut World, scene: &mut Scene) {
        self.plate = self.plate_matrix();
        if self.level_node >= 0 {
            scene.set_node(self.level_node as usize, self.plate, 0);
        }
        for b in self.blocks.iter() {
            if b.node >= 0 {
                let m = self.plate.mul(&Mat34([1.0, 0.0, 0.0, b.cr, 0.0, 1.0, 0.0, b.up, 0.0, 0.0, 1.0, -b.cf]));
                scene.set_node(b.node as usize, m, 0);
            }
        }
        if Self::owns(w, self.slot, self.marble_arch) {
            let o = self.slot as usize;
            let p = self.world(self.r, self.up, self.f);
            w.set_pos(o, p);
            let v = self.plate.vector(v3(self.vr, 0.0, -self.vf));
            w.set_vel(o, v);
            w.set(o, E::SPEED, sqrtf(self.vr * self.vr + self.vf * self.vf));
            let (yaw, pitch, roll) = self.spin.to_ypr();
            w.set(o, E::YAW, yaw);
            w.set(o, E::PITCH, pitch);
            w.set(o, E::ROLL, roll);
        }
        for s in self.stars.iter() {
            if s.collected || !Self::owns(w, s.slot, self.star_arch) {
                continue;
            }
            let bob = sinf(self.elapsed * 3.0 + s.r) * 0.08;
            let p = self.world(s.r, self.star_up + bob, s.f);
            w.set_pos(s.slot as usize, p);
        }
    }

    /// PlayerAi.planRoute: a shortest route over a grid of the plate (8
    /// neighbours, no corner cutting) around padded walls, holes and the
    /// moving blocks' swept lanes, then the path pulled straight where a
    /// line stays clear. The demo runs A* from the marble on every replan;
    /// here the cost to the goal is computed once per level and goal, and a
    /// replan follows it down from the marble (a route of the same length).
    /// Waypoints after the start into `out` as (r, f); the count.
    #[allow(clippy::too_many_arguments)]
    fn route(&mut self, to: (f32, f32), cell: f32, margin: f32, wall_pad: f32, hole_pad: f32, block_pad: f32, out: &mut [f32]) -> f32 {
        let cell = if cell > 0.05 { cell } else { 0.55 };
        let (min_r, max_r) = (-self.half_r + margin, self.half_r - margin);
        let (min_f, max_f) = (-self.half_f + margin, self.half_f - margin);
        let cols = (floorf((max_r - min_r) / cell) as i32 + 1).max(1);
        let rows = (floorf((max_f - min_f) / cell) as i32 + 1).max(1);
        let n = (cols * rows) as usize;
        if n > 20_000 {
            return 0.0;
        }
        let blocked = |m: &Marble, r: f32, f: f32| -> bool {
            if absf(r) > m.half_r - margin || absf(f) > m.half_f - margin {
                return true;
            }
            if m.walls.iter().any(|wl| wl.contains(r, f, wall_pad)) {
                return true;
            }
            if m.holes.iter().any(|h| {
                let (dr, df) = (r - h.r, f - h.f);
                dr * dr + df * df < (h.radius + hole_pad) * (h.radius + hole_pad)
            }) {
                return true;
            }
            m.blocks.iter().any(|b| {
                let swept = Rect {
                    r: b.base.r,
                    f: b.base.f,
                    w: b.base.w + if b.axis == 0 { b.travel * 2.0 } else { 0.0 },
                    d: b.base.d + if b.axis == 1 { b.travel * 2.0 } else { 0.0 },
                };
                swept.contains(r, f, block_pad)
            })
        };
        // the walkable grid holds while the level and the padding do
        let key = [cell, margin, wall_pad, hole_pad, block_pad, self.geometry as f32];
        let mut walk = core::mem::take(&mut self.walk);
        if key != self.walk_key || walk.len() != n {
            walk.clear();
            for row in 0..rows {
                for col in 0..cols {
                    walk.push(!blocked(self, min_r + col as f32 * cell, min_f + row as f32 * cell));
                }
            }
            self.walk_key = key;
        }
        let ok = |c: i32, r: i32| c >= 0 && r >= 0 && c < cols && r < rows && walk[(r * cols + c) as usize];
        let cell_of = |r: f32, f: f32| -> (i32, i32) {
            (
                clampf(roundf((r - min_r) / cell), 0.0, (cols - 1) as f32) as i32,
                clampf(roundf((f - min_f) / cell), 0.0, (rows - 1) as f32) as i32,
            )
        };
        // nearestCell: the closest walkable cell on growing square rings
        let nearest = |r: f32, f: f32| -> (i32, i32) {
            let (cc, cr) = cell_of(r, f);
            if ok(cc, cr) {
                return (cc, cr);
            }
            for radius in 1..=cols.max(rows) {
                let mut best = None;
                let mut best_d = f32::INFINITY;
                for row in cr - radius..=cr + radius {
                    for col in cc - radius..=cc + radius {
                        if (col - cc).abs() != radius && (row - cr).abs() != radius {
                            continue;
                        }
                        if !ok(col, row) {
                            continue;
                        }
                        let (pr, pf) = (min_r + col as f32 * cell, min_f + row as f32 * cell);
                        let d = (r - pr) * (r - pr) + (f - pf) * (f - pf);
                        if d < best_d {
                            best_d = d;
                            best = Some((col, row));
                        }
                    }
                }
                if let Some(b) = best {
                    return b;
                }
            }
            (cc, cr)
        };
        let start = nearest(self.r, self.f);
        let goal = nearest(to.0, to.1);
        let si = (start.1 * cols + start.0) as usize;
        let gi = (goal.1 * cols + goal.0) as usize;
        const DIRS: [(i32, i32, f32); 8] = [
            (1, 0, 1.0),
            (-1, 0, 1.0),
            (0, 1, 1.0),
            (0, -1, 1.0),
            (1, 1, core::f32::consts::SQRT_2),
            (1, -1, core::f32::consts::SQRT_2),
            (-1, 1, core::f32::consts::SQRT_2),
            (-1, -1, core::f32::consts::SQRT_2),
        ];
        // a move to a neighbour, diagonals only past two open sides
        let step = |c: i32, r: i32, dc: i32, dr: i32| -> bool { ok(c + dc, r + dr) && (dc == 0 || dr == 0 || (ok(c + dc, r) && ok(c, r + dr))) };
        // The cost to the goal from every cell, once per level and goal: the
        // grid and the goal hold, so each replan only walks it downhill.
        // Moves are symmetric (a diagonal's two side cells are the same both
        // ways), so the field from the goal is the planner's cost to it.
        if self.field_key != key || self.field_goal != gi as i32 || self.cost.len() != n {
            self.cost.clear();
            self.cost.resize(n, f32::INFINITY);
            self.open.clear();
            self.cost[gi] = 0.0;
            self.open.push(Open { score: 0.0, cell: gi as u32 });
            while let Some(top) = self.open.pop() {
                let cur = top.cell as usize;
                if top.score > self.cost[cur] {
                    continue;
                }
                let (cc, cr) = (cur as i32 % cols, cur as i32 / cols);
                for &(dc, dr, len) in DIRS.iter() {
                    if !step(cc, cr, dc, dr) {
                        continue;
                    }
                    let next = ((cr + dr) * cols + cc + dc) as usize;
                    let c = self.cost[cur] + len;
                    if c < self.cost[next] {
                        self.cost[next] = c;
                        self.open.push(Open { score: c, cell: next as u32 });
                    }
                }
            }
            self.field_key = key;
            self.field_goal = gi as i32;
        }
        self.pts.clear();
        if !self.cost[si].is_finite() {
            self.pts.push(to);
        } else {
            // downhill from the start: each step to the neighbour whose cost
            // plus the step is lowest (first in move order on ties)
            let mut cur = si;
            for _ in 0..n {
                let (c, r) = (cur as i32 % cols, cur as i32 / cols);
                self.pts.push((min_r + c as f32 * cell, min_f + r as f32 * cell));
                if cur == gi {
                    break;
                }
                let mut best = cur;
                let mut best_cost = self.cost[cur];
                for &(dc, dr, len) in DIRS.iter() {
                    if !step(c, r, dc, dr) {
                        continue;
                    }
                    let next = ((r + dr) * cols + c + dc) as usize;
                    let v = self.cost[next] + len;
                    if v < best_cost - 1e-4 || (best == cur && v <= best_cost + 1e-4) {
                        best = next;
                        best_cost = v;
                    }
                }
                if best == cur {
                    break;
                }
                cur = best;
            }
            self.pts[0] = (self.r, self.f);
            let last = self.pts.len() - 1;
            self.pts[last] = to;
            // smoothPath: from each anchor, the farthest point in clear sight
            let clear = |m: &Marble, a: (f32, f32), b: (f32, f32)| -> bool {
                let (dr, df) = (b.0 - a.0, b.1 - a.1);
                let steps = (ceilf(sqrtf(dr * dr + df * df) / 0.28) as i32).max(1);
                for i in 1..=steps {
                    let t = i as f32 / steps as f32;
                    if blocked(m, a.0 + dr * t, a.1 + df * t) {
                        return false;
                    }
                }
                true
            };
            if self.pts.len() > 2 {
                let mut smooth: Vec<(f32, f32)> = Vec::with_capacity(self.pts.len());
                smooth.push(self.pts[0]);
                let mut anchor = 0;
                while anchor < self.pts.len() - 1 {
                    let mut next = self.pts.len() - 1;
                    while next > anchor + 1 && !clear(self, self.pts[anchor], self.pts[next]) {
                        next -= 1;
                    }
                    smooth.push(self.pts[next]);
                    anchor = next;
                }
                self.pts = smooth;
            }
            self.pts.remove(0);
        }
        self.walk = walk;
        let count = self.pts.len().min(out.len() / 2);
        for (k, p) in self.pts.iter().take(count).enumerate() {
            out[k * 2] = p.0;
            out[k * 2 + 1] = p.1;
        }
        count as f32
    }

    pub fn call(&mut self, w: &mut World, scene: &mut Scene, op: u32, args: &[f32], out: &mut [f32]) -> f32 {
        let a = |i: usize| args.get(i).copied().unwrap_or(0.0);
        match op {
            op::LEVEL => {
                self.release(w);
                self.geometry = self.geometry.wrapping_add(1);
                self.active = true;
                self.phase = phase::FROZEN;
                self.half_r = maxf(a(0), 1.0) * 0.5;
                self.half_f = maxf(a(1), 1.0) * 0.5;
                self.start = (a(2), a(3));
                self.goal = Hole { r: a(4), f: a(5), radius: a(6) };
                self.radius = if a(7) > 0.0 { a(7) } else { 0.42 };
                self.center = v3(a(8), a(9), a(10));
                self.level_node = a(11) as i32;
                self.marble_arch = a(12) as i32;
                self.star_arch = a(13) as i32;
                self.star_up = a(14);
                self.r = self.start.0;
                self.f = self.start.1;
                self.up = self.radius;
                self.vr = 0.0;
                self.vf = 0.0;
                self.fall_speed = 0.0;
                self.tilt_r = 0.0;
                self.tilt_f = 0.0;
                self.elapsed = 0.0;
                self.time = 0.0;
                self.collected = 0;
                self.spin = Quat::IDENTITY;
                self.plate = self.plate_matrix();
                if self.marble_arch >= 0 && (self.marble_arch as usize) < w.archs.len() {
                    let p = self.world(self.r, self.up, self.f);
                    self.slot = w.spawn(scene, self.marble_arch as usize, p, 0.0);
                }
                self.pose(w, scene);
                self.slot as f32
            }
            op::WALL => {
                self.geometry = self.geometry.wrapping_add(1);
                self.walls.push(Rect { r: a(0), f: a(1), w: a(2), d: a(3) });
                self.walls.len() as f32 - 1.0
            }
            op::BLOCK => {
                self.geometry = self.geometry.wrapping_add(1);
                let base = Rect { r: a(0), f: a(1), w: a(2), d: a(3) };
                let axis = if a(4) > 0.5 { 1 } else { 0 };
                let travel = self.travel(&base, axis, a(5));
                self.blocks.push(Block { base, axis, travel, speed: a(6), node: a(7) as i32, up: a(8), cr: base.r, cf: base.f });
                self.pose(w, scene);
                travel
            }
            op::HOLE => {
                self.geometry = self.geometry.wrapping_add(1);
                self.holes.push(Hole { r: a(0), f: a(1), radius: a(2) });
                self.holes.len() as f32 - 1.0
            }
            op::STAR => {
                if self.star_arch < 0 || self.star_arch as usize >= w.archs.len() {
                    return -1.0;
                }
                let p = self.world(a(0), self.star_up, a(1));
                let slot = w.spawn(scene, self.star_arch as usize, p, 0.0);
                self.stars.push(Star { r: a(0), f: a(1), slot, collected: false });
                slot as f32
            }
            op::PHASE => {
                self.phase = (a(0) as u32).min(phase::DONE);
                if self.phase == phase::FAILED && self.fall_speed <= 0.0 {
                    self.fall_speed = 3.8;
                }
                self.phase as f32
            }
            op::TUNE => {
                if a(0) > 0.0 {
                    self.max_tilt = a(0);
                }
                self.tilt_lag = maxf(a(1), 0.0);
                if a(2) > 0.0 {
                    self.gravity = a(2);
                }
                self.friction = maxf(a(3), 0.0);
                if a(4) > 0.0 {
                    self.max_speed = a(4);
                }
                0.0
            }
            op::STATE => {
                let speed = sqrtf(self.vr * self.vr + self.vf * self.vf);
                let head = [
                    self.phase as f32,
                    self.r,
                    self.f,
                    self.up,
                    self.vr,
                    self.vf,
                    self.tilt_r,
                    self.tilt_f,
                    self.collected as f32,
                    self.elapsed,
                    speed,
                    self.blocks.len() as f32,
                ];
                for (k, v) in head.iter().enumerate() {
                    if k < out.len() {
                        out[k] = *v;
                    }
                }
                for (k, b) in self.blocks.iter().enumerate() {
                    let o = state::BLOCKS + k * 2;
                    if o + 1 < out.len() {
                        out[o] = b.cr;
                        out[o + 1] = b.cf;
                    }
                }
                self.phase as f32
            }
            op::ROUTE => self.route((a(0), a(1)), a(2), a(3), a(4), a(5), a(6), out),
            _ => -1.0,
        }
    }
}

#[inline]
fn ceilf(x: f32) -> f32 {
    let f = floorf(x);
    if f < x {
        f + 1.0
    } else {
        f
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{arch as A, event_field as EF};
    use crate::Playset;
    use alloc::boxed::Box;

    fn call(ps: &mut Playset, op: u32, args: &[f32], out: &mut [f32]) -> f32 {
        ps.modules.marble.call(&mut ps.world, &mut ps.scene, op, args, out)
    }

    /// The demo's first level, "Sky Table", with bare archetypes.
    pub(super) fn sky_table() -> (Box<Playset>, usize) {
        let mut ps = Playset::new(64, 16);
        let mut d = [0.0f32; crate::schema::ARCH_LENGTH];
        d[A::SCALE] = 1.0;
        let marble = ps.world.add_arch(&d) as f32;
        let star = ps.world.add_arch(&d) as f32;
        let slot = call(&mut ps, op::LEVEL, &[18.0, 14.0, -7.2, -4.8, 7.1, 4.6, 1.0, 0.42, 0.0, 0.0, 0.0, -1.0, marble, star, 0.72], &mut []);
        for wall in [
            [0.0, -6.95, 18.0, 0.45],
            [0.0, 6.95, 18.0, 0.45],
            [-8.95, 0.0, 0.45, 14.0],
            [8.95, 0.0, 0.45, 14.0],
            [-1.2, -1.1, 0.55, 5.8],
            [3.6, 2.3, 5.2, 0.5],
        ] {
            call(&mut ps, op::WALL, &wall, &mut []);
        }
        call(&mut ps, op::BLOCK, &[1.5, 0.1, 1.25, 1.25, 1.0, 2.9, 1.2, -1.0, 0.36], &mut []);
        call(&mut ps, op::HOLE, &[-3.8, 1.3, 0.85], &mut []);
        call(&mut ps, op::HOLE, &[2.1, -2.7, 0.95], &mut []);
        for s in [[-5.7, 4.7], [0.8, -4.7], [6.6, 0.9]] {
            call(&mut ps, op::STAR, &s, &mut []);
        }
        (ps, slot as usize)
    }

    fn st(ps: &mut Playset) -> [f32; 24] {
        let mut out = [0.0f32; 24];
        call(ps, op::STATE, &[], &mut out);
        out
    }

    #[test]
    fn tilting_right_rolls_right_and_the_plate_tilts_with_it() {
        let (mut ps, slot) = sky_table();
        call(&mut ps, op::PHASE, &[phase::PLAYING as f32], &mut []);
        ps.world.set_intent(slot, I::X, 1.0);
        for _ in 0..30 {
            ps.step(1.0 / 60.0);
        }
        let s = st(&mut ps);
        assert!(s[state::VR] > 1.0, "rolling right: {}", s[state::VR]);
        assert!(s[state::TILT_RIGHT] < -0.15, "the plate leans: {}", s[state::TILT_RIGHT]);
        // the marble sits on the tilted plate: its right edge is lower
        let p = ps.world.pos(slot);
        let expect = ps.modules.marble.world(s[state::RIGHT], 0.42, s[state::FORWARD]);
        assert!((p - expect).len() < 1e-4);
        let edge = ps.modules.marble.world(9.0, 0.0, 0.0);
        assert!(edge.y < -1.0, "right edge down: {edge:?}");
        // forward tilt lowers the far side (-Z)
        ps.world.set_intent(slot, I::X, 0.0);
        ps.world.set_intent(slot, I::FWD, 1.0);
        for _ in 0..60 {
            ps.step(1.0 / 60.0);
        }
        let far = ps.modules.marble.world(0.0, 0.0, 7.0);
        assert!(far.y < -1.0 && far.z < 0.0, "far side down: {far:?}");
        assert!(st(&mut ps)[state::VF] > 0.5);
    }

    #[test]
    fn walls_stop_the_marble_and_report_the_bump() {
        let (mut ps, slot) = sky_table();
        call(&mut ps, op::PHASE, &[phase::PLAYING as f32], &mut []);
        // the left wall: roll left from the start
        ps.world.set_intent(slot, I::X, -1.0);
        let mut bumps = 0;
        for _ in 0..120 {
            let n = ps.step(1.0 / 60.0);
            for e in 0..n {
                if ps.world.events[e * 8 + EF::TYPE] as u32 == EV::HIT {
                    bumps += 1;
                }
            }
        }
        let s = st(&mut ps);
        assert!(s[state::RIGHT] >= -8.95 + 0.225 + 0.42 - 0.01, "stopped at the wall: {}", s[state::RIGHT]);
        assert!(bumps >= 1);
    }

    #[test]
    fn holes_fail_stars_collect_and_the_goal_completes() {
        let (mut ps, _slot) = sky_table();
        call(&mut ps, op::PHASE, &[phase::PLAYING as f32], &mut []);
        // put the marble on a star, then into a hole
        ps.modules.marble.r = 0.8;
        ps.modules.marble.f = -4.7;
        let n = ps.step(1.0 / 60.0);
        let mut pick = None;
        for e in 0..n {
            let r = &ps.world.events[e * 8..e * 8 + 8];
            if r[EF::TYPE] as u32 == EV::PICKUP {
                pick = Some((r[EF::DATA], r[EF::VALUE]));
            }
        }
        assert_eq!(pick, Some((1.0, 1.0)));
        ps.modules.marble.r = 2.1;
        ps.modules.marble.f = -2.7;
        ps.modules.marble.vr = 0.0;
        ps.modules.marble.vf = 0.0;
        let n = ps.step(1.0 / 60.0);
        let fell = (0..n).any(|e| ps.world.events[e * 8 + EF::TYPE] as u32 == EV::MARBLE && ps.world.events[e * 8 + EF::DATA] == 1.0);
        assert!(fell);
        assert_eq!(st(&mut ps)[state::PHASE], phase::FAILED as f32);
        let up0 = st(&mut ps)[state::UP];
        ps.step(0.1);
        assert!(st(&mut ps)[state::UP] < up0, "sinking");
        // the goal, slowly
        call(&mut ps, op::PHASE, &[phase::PLAYING as f32], &mut []);
        ps.modules.marble.r = 7.1;
        ps.modules.marble.f = 4.6;
        ps.modules.marble.vr = 0.0;
        ps.modules.marble.vf = 0.0;
        let n = ps.step(1.0 / 60.0);
        let done = (0..n).any(|e| ps.world.events[e * 8 + EF::TYPE] as u32 == EV::MARBLE && ps.world.events[e * 8 + EF::DATA] == -1.0);
        assert!(done);
        assert_eq!(st(&mut ps)[state::PHASE], phase::DONE as f32);
    }

    #[test]
    fn moving_blocks_stop_short_of_walls_and_move() {
        let (mut ps, _slot) = sky_table();
        // Sky Table's block: forward travel 2.9 at f = 0.1 between walls at
        // f = 2.3 (the 5.2-wide wall, r 1.0..6.2) and the plate edge
        let b = ps.modules.marble.blocks[0];
        assert!(b.travel > 0.0 && b.travel <= 2.9);
        // the block (r 0.875..2.125) overlaps the wall's lane (r 1.0..6.2):
        // its top face 0.725 must stop 0.12 short of the wall at 2.05
        assert!((b.travel - (2.05 - 0.725 - 0.12)).abs() < 1e-3, "{}", b.travel);
        call(&mut ps, op::PHASE, &[phase::PLAYING as f32], &mut []);
        for _ in 0..40 {
            ps.step(1.0 / 60.0);
        }
        let s = st(&mut ps);
        assert_eq!(s[state::BLOCK_COUNT], 1.0);
        assert!((s[state::BLOCKS + 1] - 0.1).abs() > 0.3, "it moved: {}", s[state::BLOCKS + 1]);
    }

    #[test]
    fn the_route_reaches_the_goal_around_the_walls() {
        let (mut ps, _slot) = sky_table();
        let r = 0.42;
        let mut out = [0.0f32; 128];
        let n = call(&mut ps, op::ROUTE, &[7.1, 4.6, 0.55, r + 0.12, r + 0.16, r + 0.36, r + 0.22], &mut out) as usize;
        assert!(n >= 2, "a bent route: {n}");
        assert_eq!((out[(n - 1) * 2], out[(n - 1) * 2 + 1]), (7.1, 4.6));
        // every leg stays clear of the walls and holes
        let m = &ps.modules.marble;
        let mut from = (m.r, m.f);
        for k in 0..n {
            let to = (out[k * 2], out[k * 2 + 1]);
            for i in 0..=20 {
                let t = i as f32 / 20.0;
                let (pr, pf) = (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
                for h in m.holes.iter() {
                    let d = sqrtf((pr - h.r) * (pr - h.r) + (pf - h.f) * (pf - h.f));
                    assert!(d > h.radius, "leg {k} crosses a hole");
                }
                for wl in m.walls.iter().skip(4) {
                    assert!(!wl.contains(pr, pf, 0.0), "leg {k} crosses a wall");
                }
            }
            from = to;
        }
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::schema::arch as A;
    use crate::Playset;

    /// cargo test -p pocket-playset --release route_cost -- --ignored --nocapture
    #[test]
    #[ignore]
    fn route_cost_on_trap_gallery() {
        let mut ps = Playset::new(64, 16);
        let mut d = [0.0f32; crate::schema::ARCH_LENGTH];
        d[A::SCALE] = 1.0;
        let m = ps.world.add_arch(&d) as f32;
        let call = |ps: &mut Playset, op: u32, a: &[f32], o: &mut [f32]| ps.modules.marble.call(&mut ps.world, &mut ps.scene, op, a, o);
        call(&mut ps, op::LEVEL, &[22.0, 18.0, -9.0, -6.6, 9.1, 6.9, 1.0, 0.42, 0.0, 0.0, 0.0, -1.0, m, m, 0.72], &mut []);
        for w in [[0.0, -8.95, 22.0, 0.45], [0.0, 8.95, 22.0, 0.45], [-10.95, 0.0, 0.45, 18.0], [10.95, 0.0, 0.45, 18.0], [-5.9, -2.1, 0.5, 6.4], [-0.8, 2.4, 6.8, 0.5], [4.7, -3.4, 0.5, 6.6], [6.8, 3.8, 5.6, 0.5]] {
            call(&mut ps, op::WALL, &w, &mut []);
        }
        for b in [[-2.3, -0.8, 1.2, 2.6, 0.0, 3.7, 1.0, -1.0, 0.36], [2.2, 5.3, 1.5, 1.5, 1.0, 3.1, 1.45, -1.0, 0.36], [7.3, -5.1, 2.4, 1.1, 0.0, 2.5, 1.7, -1.0, 0.36]] {
            call(&mut ps, op::BLOCK, &b, &mut []);
        }
        for h in [[-8.1, 0.9, 0.9], [-2.6, -5.8, 0.85], [2.7, 0.1, 0.95], [8.1, -1.6, 0.88]] {
            call(&mut ps, op::HOLE, &h, &mut []);
        }
        let mut out = [0.0f32; 128];
        let t = std::time::Instant::now();
        let mut n = 0.0;
        for _ in 0..100 {
            n = call(&mut ps, op::ROUTE, &[9.1, 6.9, 0.55, 0.54, 0.58, 0.78, 0.64], &mut out);
        }
        std::println!("trap gallery: {n} waypoints, {:?} per call", t.elapsed() / 100);
        // Sky Table, where a route exists and the path smoothing runs
        let (mut ps, _) = super::tests::sky_table();
        let t = std::time::Instant::now();
        for _ in 0..100 {
            n = ps.modules.marble.call(&mut ps.world, &mut ps.scene, op::ROUTE, &[7.1, 4.6, 0.55, 0.54, 0.58, 0.78, 0.64], &mut out);
        }
        std::println!("sky table: {n} waypoints, {:?} per call", t.elapsed() / 100);
        // a new level: the walkable grid and the cost field are rebuilt
        let t = std::time::Instant::now();
        for _ in 0..100 {
            ps.modules.marble.geometry += 1;
            n = ps.modules.marble.call(&mut ps.world, &mut ps.scene, op::ROUTE, &[7.1, 4.6, 0.55, 0.54, 0.58, 0.78, 0.64], &mut out);
        }
        std::println!("sky table, first route of a level: {n} waypoints, {:?} per call", t.elapsed() / 100);
    }
}
