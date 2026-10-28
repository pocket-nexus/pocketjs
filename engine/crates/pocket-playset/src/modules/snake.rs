//! The snake module: grid snakes on one board, their segments as slots,
//! food, growth, wall/self/snake collisions, and a flood-fill + BFS planner
//! that steers AI snakes (GameBlocks' SnakeMotionController, SnakePlay and
//! PlayerAi with GridPathPlanner, xt4d/GameBlocks, MIT).
//!
//! The board moves every snake once per tick: each planner snake decides
//! against every body as it stands before the tick, every snake steps (a
//! guest snake takes its latched TURN, a planner snake its decision), then
//! the referee checks each snake that was alive at the start of the tick in
//! order: off the board, into itself, into another snake, onto food. Food
//! is picked from the free cells (forward outer, right inner) with a seeded
//! Mulberry32, as the demo picks its apple.
//!
//! Every step the module writes each segment slot's position (cell centre,
//! the demo's idle bob, an optional glide between cells), the head's yaw and
//! the body's shrink scale, so the renderer draws segments as instances of
//! two models. The planner works on a flat cell array with reused buffers:
//! three candidate moves cost three flood fills and six BFS walks over the
//! board, with no allocation.
//!
//! Directions: 0 up (+forward, -Z), 1 right (+X), 2 down, 3 left. Cell
//! (right, forward) sits at origin + (right * cell, 0, -forward * cell).

use crate::fmath::*;
use crate::scene::Scene;
use crate::schema::{ent as E, event as EV};
use crate::vec::*;
use crate::world::{World, KILL_EFFECTS, KILL_SILENT};
use alloc::vec;
use alloc::vec::Vec;

/// Call ops (framework/src/playset/snake.ts names them).
pub mod op {
    /// cols, rows, cell, ox, oy, oz, tick seconds, seed, glide: a new board
    /// (removes every snake and food slot the module owns)
    pub const BOARD: u32 = 1;
    /// right, forward, dir, length, head arch, body arch, planner, wSpace,
    /// wFood, wTail, wStraight, up: a snake; returns its index
    pub const ADD: u32 = 2;
    /// snake, dir: latch the guest's next direction
    pub const TURN: u32 = 3;
    /// snake, planner (0 = the guest steers, 1 = the planner)
    pub const CONTROL: u32 = 4;
    /// arch, count, growth, up: keep `count` food items on the board
    pub const FOOD: u32 = 5;
    /// snake, effects: back to its start cell (old segments die with effects)
    pub const RESPAWN: u32 = 6;
    /// running (0 freezes the board; the idle bob still plays)
    pub const RUN: u32 = 7;
    /// seconds per tick
    pub const TICK: u32 = 8;
    /// snake: STATE fields into `out`; returns the length
    pub const STATE: u32 = 9;
    /// snake, wSpace, wFood, wTail, wStraight
    pub const WEIGHTS: u32 = 10;
    /// slot, snake, lerp: the module keeps `slot` at lerp(head, board centre)
    pub const FOCUS: u32 = 11;
    /// snake, effects: remove its segments and leave it dead
    pub const REMOVE: u32 = 12;
}

/// STATE output fields.
pub mod state {
    pub const ALIVE: usize = 0;
    pub const LENGTH: usize = 1;
    pub const DIR: usize = 2;
    pub const HEAD_RIGHT: usize = 3;
    pub const HEAD_FORWARD: usize = 4;
    pub const HEAD_SLOT: usize = 5;
    pub const PENDING: usize = 6;
    pub const PLANNER: usize = 7;
    pub const TICKS: usize = 8;
}

/// CRASH event VALUE.
pub mod crash {
    pub const WALL: f32 = 0.0;
    pub const SELF: f32 = 1.0;
    pub const SNAKE: f32 = 2.0;
}

const MAX_SNAKES: usize = 8;
const NO_SLOT: u16 = u16::MAX;

const DIRS: [(i32, i32); 4] = [(0, 1), (1, 0), (0, -1), (-1, 0)];
/// The demo's head rotation per direction (its eyes sit at +Z).
const HEAD_YAW: [f32; 4] = [PI, -HALF_PI, 0.0, HALF_PI];

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
struct Cell {
    r: i32,
    f: i32,
}

impl Cell {
    #[inline]
    fn step(self, dir: usize) -> Cell {
        let (dr, df) = DIRS[dir & 3];
        Cell { r: self.r + dr, f: self.f + df }
    }
}

#[inline]
fn opposite(dir: usize) -> usize {
    (dir + 2) & 3
}

#[inline]
fn manhattan(a: Cell, b: Cell) -> i32 {
    (a.r - b.r).abs() + (a.f - b.f).abs()
}

struct Snake {
    cells: Vec<Cell>,
    /// a slot per segment, head first
    slots: Vec<u16>,
    /// where each slot stood before the last tick (glide)
    prev: Vec<Cell>,
    dir: usize,
    next: usize,
    turn: i32,
    pending: i32,
    alive: bool,
    planner: bool,
    w: [f32; 4],
    start: Cell,
    start_dir: usize,
    start_len: i32,
    head_arch: usize,
    body_arch: usize,
    up: f32,
}

#[derive(Clone, Copy)]
struct Food {
    cell: Cell,
    slot: i32,
    growth: i32,
}

/// Flood fill and BFS over the board in reused buffers.
#[derive(Default)]
struct Grid {
    cols: i32,
    rows: i32,
    blocked: Vec<bool>,
    seen: Vec<bool>,
    dist: Vec<u16>,
    queue: Vec<u16>,
}

impl Grid {
    fn resize(&mut self, cols: i32, rows: i32) {
        self.cols = cols;
        self.rows = rows;
        let n = (cols * rows).max(0) as usize;
        self.blocked = vec![false; n];
        self.seen = vec![false; n];
        self.dist = vec![0; n];
        self.queue = Vec::with_capacity(n);
    }
    #[inline]
    fn inside(&self, c: Cell) -> bool {
        c.r >= 0 && c.r < self.cols && c.f >= 0 && c.f < self.rows
    }
    #[inline]
    fn idx(&self, c: Cell) -> usize {
        (c.f * self.cols + c.r) as usize
    }
    fn clear(&mut self) {
        for b in self.blocked.iter_mut() {
            *b = false;
        }
    }
    #[inline]
    fn mark(&mut self, c: Cell) {
        if self.inside(c) {
            let i = self.idx(c);
            self.blocked[i] = true;
        }
    }
    /// Cells reachable from `start` (exempt from `blocked`): the planner's
    /// floodFill count.
    fn flood(&mut self, start: Cell) -> u32 {
        for s in self.seen.iter_mut() {
            *s = false;
        }
        self.queue.clear();
        let si = self.idx(start);
        self.seen[si] = true;
        self.queue.push(si as u16);
        let mut head = 0;
        while head < self.queue.len() {
            let ci = self.queue[head] as i32;
            head += 1;
            let (cr, cf) = (ci % self.cols, ci / self.cols);
            for &(dr, df) in DIRS.iter() {
                let (nr, nf) = (cr + dr, cf + df);
                if nr < 0 || nr >= self.cols || nf < 0 || nf >= self.rows {
                    continue;
                }
                let ni = (nf * self.cols + nr) as usize;
                if self.seen[ni] || self.blocked[ni] {
                    continue;
                }
                self.seen[ni] = true;
                self.queue.push(ni as u16);
            }
        }
        self.queue.len() as u32
    }
    /// Steps from `start` to `goal` (both exempt), None when unreachable:
    /// the length of findPath minus one, which A* and BFS agree on.
    fn path(&mut self, start: Cell, goal: Cell) -> Option<u32> {
        if start == goal {
            return Some(0);
        }
        if !self.inside(goal) {
            return None;
        }
        for s in self.seen.iter_mut() {
            *s = false;
        }
        self.queue.clear();
        let (si, gi) = (self.idx(start), self.idx(goal));
        self.seen[si] = true;
        self.dist[si] = 0;
        self.queue.push(si as u16);
        let mut head = 0;
        while head < self.queue.len() {
            let ci = self.queue[head] as usize;
            head += 1;
            let d = self.dist[ci];
            let (cr, cf) = (ci as i32 % self.cols, ci as i32 / self.cols);
            for &(dr, df) in DIRS.iter() {
                let (nr, nf) = (cr + dr, cf + df);
                if nr < 0 || nr >= self.cols || nf < 0 || nf >= self.rows {
                    continue;
                }
                let ni = (nf * self.cols + nr) as usize;
                if ni == gi {
                    return Some(d as u32 + 1);
                }
                if self.seen[ni] || self.blocked[ni] {
                    continue;
                }
                self.seen[ni] = true;
                self.dist[ni] = d + 1;
                self.queue.push(ni as u16);
            }
        }
        None
    }
}

#[derive(Default)]
pub struct Snakes {
    cols: i32,
    rows: i32,
    cell: f32,
    origin: Vec3,
    tick: f32,
    acc: f32,
    glide: f32,
    running: bool,
    time: f32,
    ticks: u32,
    snakes: Vec<Snake>,
    food: Vec<Food>,
    food_arch: i32,
    food_count: usize,
    food_growth: i32,
    food_up: f32,
    rng: u32,
    grid: Grid,
    scratch: Vec<Cell>,
    focus_slot: i32,
    focus_snake: i32,
    focus_lerp: f32,
}

impl Snakes {
    /// The world position of a cell's centre at `up` above the board.
    #[inline]
    fn world(&self, c: Cell, up: f32) -> Vec3 {
        v3(self.origin.x + c.r as f32 * self.cell, self.origin.y + up, self.origin.z - c.f as f32 * self.cell)
    }

    fn center(&self) -> Vec3 {
        v3(
            self.origin.x + (self.cols - 1) as f32 * 0.5 * self.cell,
            self.origin.y,
            self.origin.z - (self.rows - 1) as f32 * 0.5 * self.cell,
        )
    }

    /// Mulberry32, bit for bit with the demo's generator.
    fn next_u32(&mut self) -> u32 {
        self.rng = self.rng.wrapping_add(0x6d2b_79f5);
        let mut t = (self.rng ^ (self.rng >> 15)).wrapping_mul(1 | self.rng);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
        t ^ (t >> 14)
    }

    /// floor(random() * n) without a float.
    fn pick(&mut self, n: usize) -> usize {
        ((self.next_u32() as u64 * n as u64) >> 32) as usize
    }

    fn owns(w: &World, slot: u16, arch: usize) -> bool {
        slot != NO_SLOT && w.alive(slot as usize) && w.arch_of(slot as usize) == Some(arch)
    }

    fn release(w: &mut World, slots: &mut Vec<u16>, head: usize, body: usize, mode: u8) {
        for (k, &s) in slots.iter().enumerate() {
            if Self::owns(w, s, if k == 0 { head } else { body }) {
                w.kill_mode(s as usize, -1, mode);
            }
        }
        slots.clear();
    }

    fn reset_board(&mut self, w: &mut World) {
        let mut snakes = core::mem::take(&mut self.snakes);
        for s in snakes.iter_mut() {
            Self::release(w, &mut s.slots, s.head_arch, s.body_arch, KILL_SILENT);
        }
        for f in self.food.iter() {
            if f.slot >= 0 && Self::owns(w, f.slot as u16, self.food_arch as usize) {
                w.kill_mode(f.slot as usize, -1, KILL_SILENT);
            }
        }
        self.food.clear();
        self.food_arch = -1;
        self.food_count = 0;
        self.focus_slot = -1;
        self.ticks = 0;
        self.acc = 0.0;
    }

    /// The snake's segments back at its start, with fresh slots.
    fn place(&mut self, w: &mut World, scene: &Scene, i: usize) {
        let s = &mut self.snakes[i];
        s.cells.clear();
        s.prev.clear();
        let mut c = s.start;
        let back = opposite(s.start_dir);
        for k in 0..s.start_len.max(1) {
            if k > 0 {
                c = c.step(back);
            }
            s.cells.push(c);
            s.prev.push(c);
        }
        s.dir = s.start_dir;
        s.next = s.start_dir;
        s.turn = -1;
        s.pending = 0;
        s.alive = true;
        let (head, body, up, n) = (s.head_arch, s.body_arch, s.up, s.cells.len());
        for k in 0..n {
            let p = self.world(self.snakes[i].cells[k], up);
            let yaw = if k == 0 { HEAD_YAW[self.snakes[i].dir] } else { 0.0 };
            let slot = w.spawn(scene, if k == 0 { head } else { body }, p, yaw);
            self.snakes[i].slots.push(if slot >= 0 { slot as u16 } else { NO_SLOT });
        }
    }

    fn spawn_food(&mut self, w: &mut World, scene: &Scene) {
        if self.food_arch < 0 {
            return;
        }
        while self.food.len() < self.food_count {
            self.grid.clear();
            for si in 0..self.snakes.len() {
                for k in 0..self.snakes[si].cells.len() {
                    let c = self.snakes[si].cells[k];
                    self.grid.mark(c);
                }
            }
            for fi in 0..self.food.len() {
                let c = self.food[fi].cell;
                self.grid.mark(c);
            }
            let free = self.grid.blocked.iter().filter(|b| !**b).count();
            if free == 0 {
                return;
            }
            let k = self.pick(free);
            let mut seen = 0;
            let mut at = None;
            'scan: for f in 0..self.rows {
                for r in 0..self.cols {
                    if self.grid.blocked[(f * self.cols + r) as usize] {
                        continue;
                    }
                    if seen == k {
                        at = Some(Cell { r, f });
                        break 'scan;
                    }
                    seen += 1;
                }
            }
            let Some(cell) = at else { return };
            let p = self.world(cell, self.food_up);
            let slot = w.spawn(scene, self.food_arch as usize, p, 0.0);
            self.food.push(Food { cell, slot, growth: self.food_growth });
        }
    }

    /// PlayerAi.choose: the best of the three non-reversing moves by
    /// reachable space, distance to the nearest food, whether the tail stays
    /// reachable, and a bias for going straight.
    fn choose(&mut self, i: usize) -> usize {
        let s = &self.snakes[i];
        let head = s.cells[0];
        let cur = s.dir;
        let (pending, wt) = (s.pending, s.w);
        let mut target = None;
        let mut nearest = i32::MAX;
        for f in self.food.iter() {
            let d = manhattan(head, f.cell);
            if d < nearest {
                nearest = d;
                target = Some(f.cell);
            }
        }
        let mut best = cur;
        let mut best_score = f32::NEG_INFINITY;
        for dir in 0..4 {
            if dir == opposite(cur) {
                continue;
            }
            if let Some(score) = self.score(i, dir, head, pending, target, cur, wt) {
                if score > best_score {
                    best_score = score;
                    best = dir;
                }
            }
        }
        best
    }

    #[allow(clippy::too_many_arguments)]
    fn score(&mut self, i: usize, dir: usize, head: Cell, pending: i32, target: Option<Cell>, cur: usize, wt: [f32; 4]) -> Option<f32> {
        let next = head.step(dir);
        if !self.grid.inside(next) {
            return None;
        }
        // into a body that is still there after this tick
        let own = &self.snakes[i].cells;
        let stop = if pending > 0 { own.len() } else { own.len().saturating_sub(1) };
        if own[..stop].contains(&next) {
            return None;
        }
        for (j, o) in self.snakes.iter().enumerate() {
            if j != i && o.cells.contains(&next) {
                return None;
            }
        }
        // the body after the move, minus the tail that vacates next tick
        self.scratch.clear();
        self.scratch.push(next);
        self.scratch.extend_from_slice(own);
        if pending <= 0 {
            self.scratch.pop();
        }
        let after = if pending > 0 { pending - 1 } else { 0 };
        self.grid.clear();
        for j in 0..self.snakes.len() {
            if j == i {
                continue;
            }
            for k in 0..self.snakes[j].cells.len() {
                let c = self.snakes[j].cells[k];
                self.grid.mark(c);
            }
        }
        let keep = if after > 0 { self.scratch.len() } else { self.scratch.len() - 1 };
        for k in 0..keep {
            let c = self.scratch[k];
            self.grid.mark(c);
        }
        let flood = self.grid.flood(next) as f32;
        let food_cost = match target.and_then(|t| self.grid.path(next, t)) {
            Some(d) => d as f32 * wt[1],
            None => (self.cols * self.rows) as f32,
        };
        let tail = *self.scratch.last().unwrap_or(&next);
        let tail_ok = self.grid.path(next, tail).is_some();
        Some(flood * wt[0] - food_cost + if tail_ok { wt[2] } else { 0.0 } + if dir == cur { wt[3] } else { 0.0 })
    }

    fn crash(&mut self, w: &mut World, i: usize, hit: i32, reason: f32) {
        let s = &mut self.snakes[i];
        s.alive = false;
        let head = s.slots.first().copied().unwrap_or(NO_SLOT);
        let p = self.world(self.snakes[i].cells[0], self.snakes[i].up);
        w.emit_event(EV::CRASH, if head == NO_SLOT { -1 } else { head as i32 }, hit, i as f32, p, reason);
    }

    fn grid_tick(&mut self, w: &mut World, scene: &Scene) {
        let n = self.snakes.len().min(MAX_SNAKES);
        let mut was = [false; MAX_SNAKES];
        for i in 0..n {
            was[i] = self.snakes[i].alive && !self.snakes[i].cells.is_empty();
        }
        // every decision sees the bodies as they stand before the tick
        for i in 0..n {
            if !was[i] {
                continue;
            }
            let d = if self.snakes[i].planner {
                self.choose(i)
            } else {
                let t = self.snakes[i].turn;
                if t >= 0 {
                    t as usize & 3
                } else {
                    self.snakes[i].dir
                }
            };
            self.snakes[i].next = d;
            self.snakes[i].turn = -1;
        }
        for i in 0..n {
            if !was[i] {
                continue;
            }
            let s = &mut self.snakes[i];
            // cardinal turns only: a reversal keeps the heading
            let want = s.next;
            if want != opposite(s.dir) {
                s.dir = want;
            }
            for k in 0..s.cells.len() {
                s.prev[k] = s.cells[k];
            }
            let head = s.cells[0].step(s.dir);
            let grew = s.pending > 0;
            if grew {
                s.pending -= 1;
                let tail = *s.cells.last().unwrap();
                s.prev.push(tail);
            } else {
                s.cells.pop();
            }
            s.cells.insert(0, head);
            if grew {
                let (arch, up) = (s.body_arch, s.up);
                let tail = *self.snakes[i].cells.last().unwrap();
                let p = self.world(tail, up);
                let slot = w.spawn(scene, arch, p, 0.0);
                self.snakes[i].slots.push(if slot >= 0 { slot as u16 } else { NO_SLOT });
            }
        }
        // the referee, in snake order
        for i in 0..n {
            if !was[i] {
                continue;
            }
            let head = self.snakes[i].cells[0];
            if !self.grid.inside(head) {
                self.crash(w, i, -1, crash::WALL);
                continue;
            }
            if self.snakes[i].cells[1..].contains(&head) {
                let k = self.snakes[i].cells[1..].iter().position(|c| *c == head).unwrap() + 1;
                let hit = self.snakes[i].slots.get(k).copied().unwrap_or(NO_SLOT);
                self.crash(w, i, if hit == NO_SLOT { -1 } else { hit as i32 }, crash::SELF);
                continue;
            }
            let mut hit = None;
            for j in 0..n {
                if j == i || !was[j] {
                    continue;
                }
                if let Some(k) = self.snakes[j].cells.iter().position(|c| *c == head) {
                    hit = Some(self.snakes[j].slots.get(k).copied().unwrap_or(NO_SLOT));
                    break;
                }
            }
            if let Some(h) = hit {
                self.crash(w, i, if h == NO_SLOT { -1 } else { h as i32 }, crash::SNAKE);
                continue;
            }
            if let Some(fi) = self.food.iter().position(|f| f.cell == head) {
                let f = self.food.remove(fi);
                let s = &mut self.snakes[i];
                s.pending += f.growth.max(1);
                let len = (s.cells.len() as i32 + s.pending) as f32;
                let hs = s.slots.first().copied().unwrap_or(NO_SLOT);
                if f.slot >= 0 && Self::owns(w, f.slot as u16, self.food_arch as usize) {
                    w.kill_mode(f.slot as usize, if hs == NO_SLOT { -1 } else { hs as i32 }, KILL_EFFECTS);
                }
                let p = self.world(head, self.food_up);
                w.emit_event(EV::EAT, if hs == NO_SLOT { -1 } else { hs as i32 }, f.slot, i as f32, p, len);
            }
        }
        self.spawn_food(w, scene);
        self.ticks += 1;
    }

    /// Segment, food and focus poses for this frame.
    fn pose(&mut self, w: &mut World) {
        let t = self.time;
        let glide = if self.glide > 0.0 && self.running { clampf(self.acc / maxf(self.tick * self.glide, 1e-3), 0.0, 1.0) } else { 1.0 };
        for i in 0..self.snakes.len() {
            let s = &self.snakes[i];
            let (head, body, up, dir) = (s.head_arch, s.body_arch, s.up, s.dir);
            for k in 0..s.slots.len().min(s.cells.len()) {
                let slot = s.slots[k];
                if !Self::owns(w, slot, if k == 0 { head } else { body }) {
                    continue;
                }
                let bob = if k == 0 { sinf(t * 8.0) * 0.035 } else { sinf(t * 6.0 - k as f32 * 0.55) * 0.02 };
                let to = self.world(s.cells[k], up + bob);
                let p = if glide < 1.0 && k < s.prev.len() { self.world(s.prev[k], up + bob).lerp(to, glide) } else { to };
                let o = slot as usize;
                w.set_pos(o, p);
                if k == 0 {
                    w.set(o, E::YAW, HEAD_YAW[dir]);
                } else {
                    let base = w.archs[body][crate::schema::arch::SCALE];
                    w.look[o * 4] = base * maxf(0.82, 1.0 - k as f32 * 0.015);
                }
            }
        }
        if self.food_arch >= 0 {
            for (fi, f) in self.food.iter().enumerate() {
                if f.slot < 0 || !Self::owns(w, f.slot as u16, self.food_arch as usize) {
                    continue;
                }
                let p = self.world(f.cell, self.food_up + sinf(t * 5.0 + fi as f32) * 0.08);
                w.set_pos(f.slot as usize, p);
                w.set(f.slot as usize, E::YAW, wrap_angle(t * 1.2 + fi as f32 * 0.4));
            }
        }
        if self.focus_slot >= 0 && w.alive(self.focus_slot as usize) {
            let c = self.center();
            let p = match self.snakes.get(self.focus_snake.max(0) as usize) {
                Some(s) if !s.cells.is_empty() => self.world(s.cells[0], s.up).lerp(c, self.focus_lerp),
                _ => c,
            };
            w.set_pos(self.focus_slot as usize, p);
        }
    }

    pub fn step(&mut self, w: &mut World, scene: &mut Scene, dt: f32) {
        if self.cols <= 0 {
            return;
        }
        self.time += dt;
        if self.running {
            self.acc += dt;
            let mut guard = 0;
            while self.acc >= self.tick && guard < 4 {
                self.acc -= self.tick;
                self.grid_tick(w, scene);
                guard += 1;
            }
        }
        self.pose(w);
    }

    pub fn call(&mut self, w: &mut World, scene: &mut Scene, op: u32, args: &[f32], out: &mut [f32]) -> f32 {
        let a = |i: usize| args.get(i).copied().unwrap_or(0.0);
        let snake = |s: &Snakes, i: f32| -> Option<usize> {
            let i = i as i32;
            if i >= 0 && (i as usize) < s.snakes.len() {
                Some(i as usize)
            } else {
                None
            }
        };
        match op {
            op::BOARD => {
                self.reset_board(w);
                self.cols = (a(0) as i32).clamp(2, 64);
                self.rows = (a(1) as i32).clamp(2, 64);
                self.cell = if a(2) > 0.0 { a(2) } else { 1.0 };
                self.origin = v3(a(3), a(4), a(5));
                self.tick = maxf(a(6), 0.008);
                self.rng = a(7) as u32;
                self.glide = clampf(a(8), 0.0, 1.0);
                self.running = false;
                self.time = 0.0;
                self.grid.resize(self.cols, self.rows);
                self.scratch = Vec::with_capacity((self.cols * self.rows) as usize + 2);
                0.0
            }
            op::ADD => {
                if self.cols <= 0 || self.snakes.len() >= MAX_SNAKES {
                    return -1.0;
                }
                let (head, body) = (a(4) as i32, a(5) as i32);
                if head < 0 || body < 0 || head as usize >= w.archs.len() || body as usize >= w.archs.len() {
                    return -1.0;
                }
                let cap = (self.cols * self.rows) as usize + 2;
                self.snakes.push(Snake {
                    cells: Vec::with_capacity(cap),
                    slots: Vec::with_capacity(cap),
                    prev: Vec::with_capacity(cap),
                    dir: a(2) as usize & 3,
                    next: a(2) as usize & 3,
                    turn: -1,
                    pending: 0,
                    alive: true,
                    planner: a(6) > 0.5,
                    w: [a(7), a(8), a(9), a(10)],
                    start: Cell { r: a(0) as i32, f: a(1) as i32 },
                    start_dir: a(2) as usize & 3,
                    start_len: (a(3) as i32).max(1),
                    head_arch: head as usize,
                    body_arch: body as usize,
                    up: a(11),
                });
                let i = self.snakes.len() - 1;
                self.place(w, scene, i);
                i as f32
            }
            op::TURN => {
                if let Some(i) = snake(self, a(0)) {
                    let d = a(1) as i32;
                    if (0..4).contains(&d) {
                        self.snakes[i].turn = d;
                    }
                }
                0.0
            }
            op::CONTROL => {
                if let Some(i) = snake(self, a(0)) {
                    self.snakes[i].planner = a(1) > 0.5;
                    self.snakes[i].turn = -1;
                }
                0.0
            }
            op::FOOD => {
                let arch = a(0) as i32;
                if arch < 0 || arch as usize >= w.archs.len() {
                    return -1.0;
                }
                self.food_arch = arch;
                self.food_count = (a(1) as usize).min(32);
                self.food_growth = (a(2) as i32).max(1);
                self.food_up = a(3);
                self.spawn_food(w, scene);
                self.food.len() as f32
            }
            op::RESPAWN | op::REMOVE => {
                let Some(i) = snake(self, a(0)) else { return -1.0 };
                let mode = if a(1) > 0.5 { KILL_EFFECTS } else { KILL_SILENT };
                let s = &mut self.snakes[i];
                Self::release(w, &mut s.slots, s.head_arch, s.body_arch, mode);
                if op == op::RESPAWN {
                    self.place(w, scene, i);
                } else {
                    let s = &mut self.snakes[i];
                    s.cells.clear();
                    s.prev.clear();
                    s.alive = false;
                }
                0.0
            }
            op::RUN => {
                self.running = a(0) > 0.5;
                if !self.running {
                    self.acc = 0.0;
                }
                0.0
            }
            op::TICK => {
                self.tick = maxf(a(0), 0.008);
                0.0
            }
            op::STATE => {
                let Some(i) = snake(self, a(0)) else { return -1.0 };
                let s = &self.snakes[i];
                let head = s.cells.first().copied().unwrap_or_default();
                let vals = [
                    if s.alive { 1.0 } else { 0.0 },
                    s.cells.len() as f32,
                    s.dir as f32,
                    head.r as f32,
                    head.f as f32,
                    s.slots.first().map_or(-1.0, |&x| if x == NO_SLOT { -1.0 } else { x as f32 }),
                    s.pending as f32,
                    if s.planner { 1.0 } else { 0.0 },
                    self.ticks as f32,
                ];
                for (k, v) in vals.iter().enumerate() {
                    if k < out.len() {
                        out[k] = *v;
                    }
                }
                s.cells.len() as f32
            }
            op::WEIGHTS => {
                if let Some(i) = snake(self, a(0)) {
                    self.snakes[i].w = [a(1), a(2), a(3), a(4)];
                }
                0.0
            }
            op::FOCUS => {
                self.focus_slot = a(0) as i32;
                self.focus_snake = a(1) as i32;
                self.focus_lerp = clampf(a(2), 0.0, 1.0);
                0.0
            }
            _ => -1.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{arch as A, event_field as EF};
    use crate::Playset;
    use alloc::boxed::Box;

    struct Board {
        ps: Box<Playset>,
        head: f32,
        body: f32,
        food: f32,
    }

    fn call(ps: &mut Playset, op: u32, args: &[f32], out: &mut [f32]) -> f32 {
        ps.modules.snake.call(&mut ps.world, &mut ps.scene, op, args, out)
    }

    /// A 16x16 board at the origin with three bare archetypes; one tick per step.
    fn board() -> Board {
        let mut ps = Playset::new(256, 16);
        let mut d = [0.0f32; crate::schema::ARCH_LENGTH];
        d[A::SCALE] = 1.0;
        let head = ps.world.add_arch(&d) as f32;
        let body = ps.world.add_arch(&d) as f32;
        let food = ps.world.add_arch(&d) as f32;
        call(&mut ps, op::BOARD, &[16.0, 16.0, 1.0, 0.0, 0.0, 0.0, 1.0 / 60.0, 1337.0, 0.0], &mut []);
        Board { ps, head, body, food }
    }

    fn events(ps: &Playset, n: usize, ty: u32) -> Vec<[f32; 8]> {
        let mut v = Vec::new();
        for e in 0..n {
            let r = &ps.world.events[e * 8..e * 8 + 8];
            if r[EF::TYPE] as u32 == ty {
                let mut a = [0.0; 8];
                a.copy_from_slice(r);
                v.push(a);
            }
        }
        v
    }

    fn state(ps: &mut Playset, i: f32) -> [f32; 9] {
        let mut out = [0.0f32; 9];
        call(ps, op::STATE, &[i], &mut out);
        out
    }

    #[test]
    fn segments_follow_the_head_one_cell_per_tick() {
        let mut b = board();
        let s = call(&mut b.ps, op::ADD, &[3.0, 8.0, 1.0, 4.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        assert_eq!(s, 0.0);
        let st = state(&mut b.ps, 0.0);
        assert_eq!(st[state::LENGTH], 4.0);
        let head = st[state::HEAD_SLOT] as usize;
        call(&mut b.ps, op::RUN, &[1.0], &mut []);
        b.ps.step(1.0 / 60.0);
        let st = state(&mut b.ps, 0.0);
        assert_eq!((st[state::HEAD_RIGHT], st[state::HEAD_FORWARD]), (4.0, 8.0));
        // the head slot stands on its cell and faces right
        let p = b.ps.world.pos(head);
        assert!((p.x - 4.0).abs() < 1e-4 && (p.z + 8.0).abs() < 1e-4);
        assert!((b.ps.world.e(head, E::YAW) + HALF_PI).abs() < 1e-5);
        // turn up: the body bends behind it
        call(&mut b.ps, op::TURN, &[0.0, 0.0], &mut []);
        b.ps.step(1.0 / 60.0);
        let snake = &b.ps.modules.snake.snakes[0];
        assert_eq!(snake.cells[0], Cell { r: 4, f: 9 });
        assert_eq!(snake.cells[1], Cell { r: 4, f: 8 });
        assert_eq!(snake.cells[2], Cell { r: 3, f: 8 });
        let tail = snake.slots[3] as usize;
        let p = b.ps.world.pos(tail);
        assert!((p.x - 2.0).abs() < 1e-4 && (p.z + 8.0).abs() < 1e-4);
        // a reversal is ignored
        call(&mut b.ps, op::TURN, &[0.0, 2.0], &mut []);
        b.ps.step(1.0 / 60.0);
        assert_eq!(b.ps.modules.snake.snakes[0].cells[0], Cell { r: 4, f: 10 });
    }

    #[test]
    fn eating_grows_reports_and_respawns_food() {
        let mut b = board();
        call(&mut b.ps, op::ADD, &[3.0, 8.0, 1.0, 4.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        call(&mut b.ps, op::FOOD, &[b.food, 1.0, 1.0, 0.25], &mut []);
        // put the food two cells ahead of the head
        let fslot = b.ps.modules.snake.food[0].slot;
        b.ps.modules.snake.food[0].cell = Cell { r: 5, f: 8 };
        call(&mut b.ps, op::RUN, &[1.0], &mut []);
        b.ps.step(1.0 / 60.0);
        let n = b.ps.step(1.0 / 60.0);
        let eats = events(&b.ps, n, EV::EAT);
        assert_eq!(eats.len(), 1);
        assert_eq!(eats[0][EF::B] as i32, fslot);
        assert_eq!(eats[0][EF::VALUE], 5.0);
        assert!(!b.ps.world.alive(fslot as usize) || b.ps.modules.snake.food[0].slot == fslot);
        assert_eq!(b.ps.modules.snake.food.len(), 1, "a new apple appears");
        let before = b.ps.world.live.len();
        b.ps.step(1.0 / 60.0);
        assert_eq!(state(&mut b.ps, 0.0)[state::LENGTH], 5.0);
        assert_eq!(b.ps.world.live.len(), before + 1, "a segment slot was added");
    }

    #[test]
    fn walls_self_and_other_snakes_crash() {
        let mut b = board();
        // into the right wall
        call(&mut b.ps, op::ADD, &[14.0, 2.0, 1.0, 3.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        call(&mut b.ps, op::RUN, &[1.0], &mut []);
        b.ps.step(1.0 / 60.0);
        let n = b.ps.step(1.0 / 60.0);
        let c = events(&b.ps, n, EV::CRASH);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0][EF::VALUE], crash::WALL);
        assert_eq!(state(&mut b.ps, 0.0)[state::ALIVE], 0.0);
        // a dead snake stops
        b.ps.step(1.0 / 60.0);
        assert_eq!(b.ps.modules.snake.snakes[0].cells[0], Cell { r: 16, f: 2 });
        // respawn puts it back
        call(&mut b.ps, op::RESPAWN, &[0.0, 1.0], &mut []);
        assert_eq!(state(&mut b.ps, 0.0)[state::ALIVE], 1.0);
        assert_eq!(b.ps.modules.snake.snakes[0].cells[0], Cell { r: 14, f: 2 });

        // into itself: a long snake turning in a tight square
        let mut b = board();
        call(&mut b.ps, op::ADD, &[8.0, 8.0, 1.0, 6.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        call(&mut b.ps, op::RUN, &[1.0], &mut []);
        let mut crashed = None;
        for d in [0.0, 3.0, 2.0] {
            call(&mut b.ps, op::TURN, &[0.0, d], &mut []);
            let n = b.ps.step(1.0 / 60.0);
            if let Some(c) = events(&b.ps, n, EV::CRASH).first() {
                crashed = Some(c[EF::VALUE]);
            }
        }
        assert_eq!(crashed, Some(crash::SELF));

        // head-on: both die in the same tick
        let mut b = board();
        call(&mut b.ps, op::ADD, &[5.0, 5.0, 1.0, 3.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        call(&mut b.ps, op::ADD, &[7.0, 5.0, 3.0, 3.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        call(&mut b.ps, op::RUN, &[1.0], &mut []);
        let n = b.ps.step(1.0 / 60.0);
        let c = events(&b.ps, n, EV::CRASH);
        assert_eq!(c.len(), 2);
        assert!(c.iter().all(|e| e[EF::VALUE] == crash::SNAKE));
    }

    #[test]
    fn the_planner_eats_and_survives() {
        let mut b = board();
        // the demo's two snakes, both on the planner with the demo's weights
        call(&mut b.ps, op::ADD, &[3.0, 8.0, 1.0, 4.0, b.head, b.body, 1.0, 2.4, 3.2, 3.5, 0.35, 0.12], &mut []);
        call(&mut b.ps, op::ADD, &[12.0, 3.0, 3.0, 4.0, b.head, b.body, 1.0, 2.0, 3.0, 3.5, 0.5, 0.12], &mut []);
        call(&mut b.ps, op::FOOD, &[b.food, 1.0, 1.0, 0.25], &mut []);
        call(&mut b.ps, op::RUN, &[1.0], &mut []);
        let mut eaten = 0;
        let mut crashes = 0;
        for _ in 0..600 {
            let n = b.ps.step(1.0 / 60.0);
            eaten += events(&b.ps, n, EV::EAT).len();
            for c in events(&b.ps, n, EV::CRASH) {
                crashes += 1;
                call(&mut b.ps, op::RESPAWN, &[c[EF::DATA], 0.0], &mut []);
            }
        }
        assert!(eaten >= 20, "ate {eaten}");
        assert!(crashes <= 4, "crashed {crashes} times in 600 ticks");
        // slots match the bodies
        for s in b.ps.modules.snake.snakes.iter() {
            assert_eq!(s.slots.len(), s.cells.len());
        }
    }

    #[test]
    fn the_planner_steers_toward_food_and_away_from_walls() {
        let mut b = board();
        call(&mut b.ps, op::ADD, &[15.0, 8.0, 1.0, 3.0, b.head, b.body, 1.0, 2.4, 3.2, 3.5, 0.35, 0.0], &mut []);
        call(&mut b.ps, op::FOOD, &[b.food, 1.0, 1.0, 0.25], &mut []);
        b.ps.modules.snake.food[0].cell = Cell { r: 15, f: 2 };
        // heading right at the wall with food below: it turns down
        assert_eq!(b.ps.modules.snake.choose(0), 2);
    }

    #[test]
    fn mulberry_pick_matches_the_float_floor() {
        let mut s = Snakes { rng: 1337, ..Snakes::default() };
        let mut r = 1337u32;
        for _ in 0..2000 {
            for n in [1usize, 7, 100, 255, 256] {
                let mut copy = Snakes { rng: r, ..Snakes::default() };
                let raw = copy.next_u32();
                r = copy.rng;
                let want = ((raw as f64 / 4294967296.0) * n as f64).floor() as usize;
                assert_eq!(s.pick(n), want);
            }
        }
    }

    #[test]
    fn glide_carries_segments_between_cells() {
        let mut b = board();
        // ticks of 4 steps, gliding over the whole tick
        call(&mut b.ps, op::BOARD, &[16.0, 16.0, 1.0, 0.0, 0.0, 0.0, 4.0 / 60.0, 1.0, 1.0], &mut []);
        call(&mut b.ps, op::ADD, &[3.0, 8.0, 1.0, 3.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        call(&mut b.ps, op::RUN, &[1.0], &mut []);
        let head = state(&mut b.ps, 0.0)[state::HEAD_SLOT] as usize;
        let mut xs = Vec::new();
        for _ in 0..8 {
            b.ps.step(1.0 / 60.0);
            xs.push(b.ps.world.pos(head).x);
        }
        // from the first tick on (the glide runs one tick behind the cells),
        // the head moves a quarter cell a step and never jumps
        assert_eq!(xs[3], 3.0);
        for k in 4..xs.len() {
            let d = xs[k] - xs[k - 1];
            assert!(d > 0.2 && d < 0.3, "steps {xs:?}");
        }
    }

    #[test]
    fn board_resets_release_slots_and_focus_follows() {
        let mut b = board();
        call(&mut b.ps, op::ADD, &[3.0, 8.0, 1.0, 4.0, b.head, b.body, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &mut []);
        call(&mut b.ps, op::FOOD, &[b.food, 1.0, 1.0, 0.25], &mut []);
        let focus = b.ps.world.spawn(&b.ps.scene, b.food as usize, Vec3::ZERO, 0.0);
        call(&mut b.ps, op::FOCUS, &[focus as f32, 0.0, 0.5], &mut []);
        b.ps.step(1.0 / 60.0);
        let p = b.ps.world.pos(focus as usize);
        // halfway between the head (3, -8) and the centre (7.5, -7.5)
        assert!((p.x - 5.25).abs() < 1e-3 && (p.z + 7.75).abs() < 1e-3, "{p:?}");
        call(&mut b.ps, op::BOARD, &[16.0, 16.0, 1.0, 0.0, 0.0, 0.0, 0.15, 1.0, 0.0], &mut []);
        b.ps.step(1.0 / 60.0);
        assert_eq!(b.ps.world.live.len(), 1, "only the guest's own slot is left");
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::schema::arch as A;
    use crate::Playset;

    /// cargo test -p pocket-playset --release planner_cost -- --ignored --nocapture
    #[test]
    #[ignore]
    fn planner_cost_per_tick() {
        let mut ps = Playset::new(320, 16);
        let mut d = [0.0f32; crate::schema::ARCH_LENGTH];
        d[A::SCALE] = 1.0;
        let a = ps.world.add_arch(&d) as f32;
        let call = |ps: &mut Playset, op: u32, x: &[f32]| ps.modules.snake.call(&mut ps.world, &mut ps.scene, op, x, &mut []);
        call(&mut ps, op::BOARD, &[16.0, 16.0, 1.0, 0.0, 0.0, 0.0, 1.0 / 60.0, 1337.0, 0.0]);
        call(&mut ps, op::ADD, &[3.0, 8.0, 1.0, 4.0, a, a, 1.0, 2.4, 3.2, 3.5, 0.35, 0.0]);
        call(&mut ps, op::ADD, &[12.0, 3.0, 3.0, 4.0, a, a, 1.0, 2.0, 3.0, 3.5, 0.5, 0.0]);
        call(&mut ps, op::FOOD, &[a, 1.0, 1.0, 0.0]);
        call(&mut ps, op::RUN, &[1.0]);
        let t = std::time::Instant::now();
        let mut ticks = 0;
        for _ in 0..600 {
            let n = ps.step(1.0 / 60.0);
            ticks += 1;
            for e in 0..n {
                if ps.world.events[e * 8] as u32 == EV::CRASH {
                    let i = ps.world.events[e * 8 + 3];
                    call(&mut ps, op::RESPAWN, &[i, 0.0]);
                }
            }
        }
        let lens: Vec<usize> = ps.modules.snake.snakes.iter().map(|s| s.cells.len()).collect();
        std::println!("{:?} per tick with both snakes planning (lengths {lens:?})", t.elapsed() / ticks);
    }
}

