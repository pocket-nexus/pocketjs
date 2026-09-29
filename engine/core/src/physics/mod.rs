//! 2D bodies stepped by the UI core: the native half of capability
//! `ui.physics` (contracts/spec/physics.ts, spec ops 52..56).
//!
//! A world advances inside `Ui::tick`, `substeps` semi-implicit Euler
//! integrations per core tick at the realm's fixed dt, with an integer substep
//! count as its clock. Every tick ends by writing each body's pose into its
//! views' `physics_values` layer as the paint-only props translateX,
//! translateY, rotate, skewX, scaleX, scaleY and originY, so the tree paints,
//! clips and hit-tests the motion and layout never runs for it. Emitters write
//! translateX/Y, rotate, uniform scale, opacity and the image texture into a
//! pool of image nodes.
//!
//! Module layout: this file owns the object tables, handles, parameters,
//! commands, queries and the per-tick schedule; `body` integrates bodies and
//! builds their poses; `contact` resolves collisions; `shape` holds static
//! geometry (colliders and zones); `emitter` steps particles.
//!
//! Determinism: f32 arithmetic from `crate::fmath`, one xorshift32 per world
//! and one per emitter, slot-ordered iteration, and rates written as
//! exp(-k·h) so the dynamics do not depend on the substep length beyond
//! integration error. The same params, commands and tick count give the same
//! bits on every host.

mod body;
mod contact;
mod emitter;
mod shape;
#[cfg(test)]
mod tests;

use alloc::collections::VecDeque;
use alloc::vec;
use alloc::vec::Vec;

use crate::fmath::{clampf, exp_neg, maxf, sqrtf, DEG};
use crate::spec;
use crate::spec::physics as ps;
use crate::tree::{Node, Tree};

use body::{Body, Flight};
use contact::OwnerKick;
use emitter::Emitter;
use shape::{Collider, GeoKind, Geometry, Zone};

/// Contact resolution passes per substep.
const ITERATIONS: usize = 3;
/// Seconds between two hit events of one body.
const HIT_COOLDOWN: f32 = 0.12;
/// Seconds without floor contact before an `anchorFree` body springs.
const REST_GRACE: f32 = 0.15;
/// Largest `argc` a command record may carry.
const MAX_ARGS: usize = 16;
/// Rate at which a carried body's velocity follows the pointer, 1/s.
const CARRY_SMOOTHING: f32 = 41.6;

// ---- vectors ------------------------------------------------------------------

#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub(crate) struct V2 {
    pub(crate) x: f32,
    pub(crate) y: f32,
}

impl V2 {
    pub(crate) const ZERO: V2 = V2 { x: 0.0, y: 0.0 };
    #[inline]
    pub(crate) fn new(x: f32, y: f32) -> V2 {
        V2 { x, y }
    }
    #[inline]
    pub(crate) fn add(self, o: V2) -> V2 {
        V2::new(self.x + o.x, self.y + o.y)
    }
    #[inline]
    pub(crate) fn sub(self, o: V2) -> V2 {
        V2::new(self.x - o.x, self.y - o.y)
    }
    #[inline]
    pub(crate) fn mul(self, k: f32) -> V2 {
        V2::new(self.x * k, self.y * k)
    }
    #[inline]
    pub(crate) fn dot(self, o: V2) -> f32 {
        self.x * o.x + self.y * o.y
    }
    /// z of the 3D cross product.
    #[inline]
    pub(crate) fn cross(self, o: V2) -> f32 {
        self.x * o.y - self.y * o.x
    }
    #[inline]
    pub(crate) fn len2(self) -> f32 {
        self.dot(self)
    }
    #[inline]
    pub(crate) fn len(self) -> f32 {
        sqrtf(self.len2())
    }
    /// Rotate by an angle given as (sin, cos).
    #[inline]
    pub(crate) fn rot(self, s: f32, c: f32) -> V2 {
        V2::new(c * self.x - s * self.y, s * self.x + c * self.y)
    }
    /// Velocity of a point at offset `r` on a body spinning at `w`.
    #[inline]
    pub(crate) fn spin(w: f32, r: V2) -> V2 {
        V2::new(-w * r.y, w * r.x)
    }
}

/// xorshift32 → [0, 1).
#[inline]
pub(crate) fn rand01(state: &mut u32) -> f32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    (x >> 8) as f32 / 16_777_216.0
}

// ---- handles and tables --------------------------------------------------------------

#[inline]
fn make_handle(kind: u32, generation: u16, slot: u32) -> i32 {
    ((kind << ps::HANDLE_KIND_SHIFT)
        | ((generation as u32 & ps::HANDLE_GEN_MASK) << ps::HANDLE_GEN_SHIFT)
        | (slot & ps::HANDLE_SLOT_MASK)) as i32
}

/// (kind, generation, slot) of a positive handle.
#[inline]
fn split_handle(handle: i32) -> Option<(u32, u16, u32)> {
    if handle <= 0 {
        return None;
    }
    let h = handle as u32;
    Some((
        h >> ps::HANDLE_KIND_SHIFT,
        ((h >> ps::HANDLE_GEN_SHIFT) & ps::HANDLE_GEN_MASK) as u16,
        h & ps::HANDLE_SLOT_MASK,
    ))
}

/// Generation-tagged slots. Slot 0 is never handed out, so handle 0 stays
/// "none". Freed slots are reused oldest-first, so a stale handle meets its
/// slot again only after every other free slot has been reused.
struct Slots<T> {
    items: Vec<Option<T>>,
    gens: Vec<u16>,
    free: VecDeque<u32>,
    live: usize,
}

impl<T> Slots<T> {
    fn new() -> Self {
        Slots { items: vec![None], gens: vec![0], free: VecDeque::new(), live: 0 }
    }

    fn insert(&mut self, value: T) -> Option<(u32, u16)> {
        let slot = match self.free.pop_front() {
            Some(slot) => slot,
            None => {
                if self.items.len() as u32 > ps::HANDLE_SLOT_MASK {
                    return None;
                }
                self.items.push(None);
                self.gens.push(0);
                (self.items.len() - 1) as u32
            }
        };
        self.items[slot as usize] = Some(value);
        self.live += 1;
        Some((slot, self.gens[slot as usize]))
    }

    fn live_slot(&self, generation: u16, slot: u32) -> Option<usize> {
        let i = slot as usize;
        if i == 0 || i >= self.items.len() || self.gens[i] != generation || self.items[i].is_none() {
            return None;
        }
        Some(i)
    }

    fn remove(&mut self, slot: usize) -> Option<T> {
        let value = self.items.get_mut(slot)?.take()?;
        self.gens[slot] = (self.gens[slot] + 1) & ps::HANDLE_GEN_MASK as u16;
        self.free.push_back(slot as u32);
        self.live -= 1;
        Some(value)
    }

    fn handle(&self, kind: u32, slot: usize) -> i32 {
        make_handle(kind, self.gens[slot], slot as u32)
    }
}

// ---- views ------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
pub(crate) struct View {
    pub(crate) node: i32,
    pub(crate) offset: V2,
}

/// Laid-out frame of a view node: (surface, centre within the surface, w, h).
/// Ancestor layout offsets are summed; ancestor transforms are not part of the
/// frame. None while the node is dead, detached, or under no surface root.
fn node_frame(tree: &Tree, id: i32, aux_root: i32) -> Option<(usize, V2, f32, f32)> {
    let slot = tree.resolve(id)?;
    let node = &tree.slots[slot as usize];
    let (w, h) = (node.layout.w, node.layout.h);
    let (mut x, mut y) = (node.layout.x, node.layout.y);
    let mut parent = node.parent;
    let mut depth = 0u32;
    let surface = loop {
        if parent == 0 || depth > spec::MAX_TREE_DEPTH {
            return None;
        }
        let pslot = tree.resolve(parent)?;
        let pnode = &tree.slots[pslot as usize];
        x += pnode.layout.x;
        y += pnode.layout.y;
        if parent == spec::ROOT_ID {
            break ps::SURFACE_PRIMARY;
        }
        if aux_root != 0 && parent == aux_root {
            break ps::SURFACE_AUXILIARY;
        }
        parent = pnode.parent;
        depth += 1;
    };
    Some((surface, V2::new(x + w * 0.5, y + h * 0.5), w, h))
}

#[inline]
fn put(node: &mut Node, prop: u8, value: f32) {
    Node::put_entry(&mut node.physics_values, prop, value.to_bits());
}

/// Hand a view back to its styled pose.
fn release_view(tree: &mut Tree, id: i32) {
    if let Some(node) = tree.get_mut(id) {
        node.physics_values.clear();
    }
}

/// A surface index from a wire argument.
#[inline]
fn surface_index(value: f32) -> usize {
    if value == ps::SURFACE_AUXILIARY as f32 {
        ps::SURFACE_AUXILIARY
    } else {
        ps::SURFACE_PRIMARY
    }
}

// ---- worlds and events ----------------------------------------------------------------

struct World {
    gravity: V2,
    substeps: u32,
    seed: u32,
    rng: u32,
    origin: [V2; 2],
    max_speed: f32,
    /// Substeps elapsed: the world's clock.
    step: u64,
    /// Length of one substep, set by the tick that advances the world.
    h: f32,
    listening: bool,
}

impl World {
    /// Whole substeps covering `seconds` (at least one).
    fn steps(&self, seconds: f32) -> u64 {
        if !(self.h > 0.0) {
            return 1;
        }
        ((seconds / self.h) as u64).max(1)
    }
}

/// Event records pending the next drain. A world records at most
/// `EVENT_MAX` per tick and the buffer holds at most `EVENT_BACKLOG` ticks
/// of them; each tick that drops records appends one `overflow` record.
pub(crate) struct Events {
    buf: Vec<f64>,
    tick_start: usize,
    dropped: u32,
    enabled: bool,
}

impl Events {
    fn begin(&mut self, enabled: bool) {
        self.tick_start = self.buf.len();
        self.dropped = 0;
        self.enabled = enabled;
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push(&mut self, kind: u32, a: i32, b: i32, x: f32, y: f32, nx: f32, ny: f32, speed: f32) {
        if !self.enabled {
            return;
        }
        let this_tick = (self.buf.len() - self.tick_start) / ps::EVENT_WORDS;
        if this_tick >= ps::EVENT_MAX || self.buf.len() >= ps::EVENT_MAX * ps::EVENT_BACKLOG * ps::EVENT_WORDS {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.buf.extend_from_slice(&[kind as f64, a as f64, b as f64, x as f64, y as f64, nx as f64, ny as f64, speed as f64]);
    }

    fn end(&mut self, world: i32) {
        if self.dropped > 0 {
            let dropped = self.dropped as f64;
            self.buf.extend_from_slice(&[ps::EVENT_OVERFLOW as f64, world as f64, 0.0, 0.0, 0.0, 0.0, 0.0, dropped]);
        }
        self.enabled = false;
    }
}

// ---- parameters ---------------------------------------------------------------

/// `[key, value]` pairs with finite values.
fn pairs(params: &[f64]) -> impl Iterator<Item = (u32, f64)> + '_ {
    params.as_chunks::<2>().0.iter().filter_map(|&[key, value]| {
        ((0.0..4096.0).contains(&key) && value.is_finite()).then_some((key as u32, value))
    })
}

#[inline]
fn f(v: f64) -> f32 {
    v as f32
}

/// f64 → i32 handle or node id (non-finite → 0).
#[inline]
fn id(v: f64) -> i32 {
    if v.is_finite() && v >= i32::MIN as f64 && v <= i32::MAX as f64 {
        v as i32
    } else {
        0
    }
}

/// Count the pairs with `key`, to refuse creation past a table limit.
fn count(params: &[f64], key: u32) -> usize {
    pairs(params).filter(|(k, _)| *k == key).count()
}

/// Command arguments that may be NaN: launch's target, the angle of teleport
/// and anchor.
fn nan_allowed(cmd: u32, index: usize) -> bool {
    matches!((cmd, index), (ps::CMD_LAUNCH, 2 | 3) | (ps::CMD_TELEPORT, 2) | (ps::CMD_ANCHOR, 2))
}

// ---- the simulation -----------------------------------------------------------

/// Every world, body, collider, zone and emitter of one `Ui`.
pub struct Physics {
    worlds: Slots<World>,
    bodies: Slots<Body>,
    colliders: Slots<Collider>,
    zones: Slots<Zone>,
    emitters: Slots<Emitter>,
    events: Events,
    order: u32,
}

impl Default for Physics {
    fn default() -> Self {
        Self::new()
    }
}

impl Physics {
    pub fn new() -> Self {
        Physics {
            worlds: Slots::new(),
            bodies: Slots::new(),
            colliders: Slots::new(),
            zones: Slots::new(),
            emitters: Slots::new(),
            events: Events { buf: Vec::new(), tick_start: 0, dropped: 0, enabled: false },
            order: 0,
        }
    }

    /// True when no world is alive (the tick skips the whole module).
    pub fn is_idle(&self) -> bool {
        self.worlds.live == 0
    }

    fn world_slot(&self, handle: f64) -> Option<usize> {
        let (kind, generation, slot) = split_handle(id(handle))?;
        if kind != ps::KIND_WORLD {
            return None;
        }
        self.worlds.live_slot(generation, slot)
    }

    /// The world a creation's `world` key names.
    fn world_param(&self, params: &[f64]) -> Option<usize> {
        pairs(params).find(|(k, _)| *k == ps::KEY_WORLD).and_then(|(_, v)| self.world_slot(v))
    }

    fn body_slot(&self, handle: i32) -> Option<usize> {
        let (kind, generation, slot) = split_handle(handle)?;
        if kind != ps::KIND_BODY {
            return None;
        }
        self.bodies.live_slot(generation, slot)
    }

    fn next_order(&mut self) -> u32 {
        self.order = self.order.wrapping_add(1);
        self.order
    }

    // -- create -----------------------------------------------------------------

    /// `physicsCreate(kind, params)` → handle, or 0 when the kind is unknown,
    /// a required world is missing, a limit is exceeded or the table is full.
    pub fn create(&mut self, kind: u32, params: &[f64]) -> i32 {
        match kind {
            ps::KIND_WORLD => self.create_world(params),
            ps::KIND_BODY => self.create_body(params),
            ps::KIND_COLLIDER => self.create_collider(params),
            ps::KIND_ZONE => self.create_zone(params),
            ps::KIND_EMITTER => self.create_emitter(params),
            _ => 0,
        }
    }

    fn create_world(&mut self, params: &[f64]) -> i32 {
        let mut w = World {
            gravity: V2::new(0.0, 980.0),
            substeps: 2,
            seed: 1,
            rng: 1,
            origin: [V2::ZERO; 2],
            max_speed: 6000.0,
            step: 0,
            h: 0.0,
            listening: true,
        };
        for (key, v) in pairs(params) {
            match key {
                ps::KEY_GRAVITY_X => w.gravity.x = f(v),
                ps::KEY_GRAVITY_Y => w.gravity.y = f(v),
                ps::KEY_SUBSTEPS => w.substeps = clampf(f(v), 1.0, 8.0) as u32,
                ps::KEY_SEED => {
                    let seed = v as u32;
                    w.seed = if seed == 0 { 1 } else { seed };
                    w.rng = w.seed;
                }
                ps::KEY_PRIMARY_X => w.origin[ps::SURFACE_PRIMARY].x = f(v),
                ps::KEY_PRIMARY_Y => w.origin[ps::SURFACE_PRIMARY].y = f(v),
                ps::KEY_AUXILIARY_X => w.origin[ps::SURFACE_AUXILIARY].x = f(v),
                ps::KEY_AUXILIARY_Y => w.origin[ps::SURFACE_AUXILIARY].y = f(v),
                ps::KEY_MAX_SPEED => w.max_speed = maxf(1.0, f(v)),
                _ => {}
            }
        }
        match self.worlds.insert(w) {
            Some((slot, generation)) => make_handle(ps::KIND_WORLD, generation, slot),
            None => 0,
        }
    }

    fn create_body(&mut self, params: &[f64]) -> i32 {
        let Some(world) = self.world_param(params) else { return 0 };
        if count(params, ps::KEY_VIEW) > ps::MAX_VIEWS {
            return 0;
        }
        let mut b = Body::new(world, params);
        b.order = self.next_order();
        match self.bodies.insert(b) {
            Some((slot, generation)) => make_handle(ps::KIND_BODY, generation, slot),
            None => 0,
        }
    }

    fn create_collider(&mut self, params: &[f64]) -> i32 {
        let Some(world) = self.world_param(params) else { return 0 };
        if count(params, ps::KEY_POINT_X) > ps::MAX_POINTS {
            return 0;
        }
        let Some(c) = Collider::new(world, params) else { return 0 };
        match self.colliders.insert(c) {
            Some((slot, generation)) => make_handle(ps::KIND_COLLIDER, generation, slot),
            None => 0,
        }
    }

    fn create_zone(&mut self, params: &[f64]) -> i32 {
        let Some(world) = self.world_param(params) else { return 0 };
        if count(params, ps::KEY_POINT_X) > ps::MAX_POINTS {
            return 0;
        }
        let Some(z) = Zone::new(world, params) else { return 0 };
        match self.zones.insert(z) {
            Some((slot, generation)) => make_handle(ps::KIND_ZONE, generation, slot),
            None => 0,
        }
    }

    fn create_emitter(&mut self, params: &[f64]) -> i32 {
        let Some(world) = self.world_param(params) else { return 0 };
        if count(params, ps::KEY_VIEW) > ps::MAX_POOL || count(params, ps::KEY_TEXTURE) > ps::MAX_TEXTURES {
            return 0;
        }
        let seed = self.worlds.items[world].as_ref().map_or(1, |w| w.seed);
        // each emitter draws from its own generator, so particles never shift
        // the world's landing wobble; the slot it will take seeds it
        let slot_hint = self.emitters.free.front().copied().unwrap_or(self.emitters.items.len() as u32);
        let mut rng = seed ^ slot_hint.wrapping_mul(0x9e37_79b9);
        if rng == 0 {
            rng = 1;
        }
        let e = Emitter::new(world, rng, params);
        match self.emitters.insert(e) {
            Some((slot, generation)) => make_handle(ps::KIND_EMITTER, generation, slot),
            None => 0,
        }
    }

    // -- destroy ----------------------------------------------------------------

    /// `physicsDestroy(handle)`. A world takes every object in it; bodies and
    /// emitters hand their views back to their styled poses.
    pub fn destroy(&mut self, handle: i32, tree: &mut Tree) {
        let Some((kind, generation, slot)) = split_handle(handle) else { return };
        match kind {
            ps::KIND_WORLD => {
                let Some(w) = self.worlds.live_slot(generation, slot) else { return };
                for i in 1..self.bodies.items.len() {
                    if self.bodies.items[i].as_ref().is_some_and(|b| b.world == w) {
                        self.remove_body(i, tree);
                    }
                }
                for i in 1..self.colliders.items.len() {
                    if self.colliders.items[i].as_ref().is_some_and(|c| c.world == w) {
                        self.colliders.remove(i);
                    }
                }
                for i in 1..self.zones.items.len() {
                    if self.zones.items[i].as_ref().is_some_and(|z| z.world == w) {
                        self.zones.remove(i);
                    }
                }
                for i in 1..self.emitters.items.len() {
                    if self.emitters.items[i].as_ref().is_some_and(|e| e.world == w) {
                        self.remove_emitter(i, tree);
                    }
                }
                self.worlds.remove(w);
            }
            ps::KIND_BODY => {
                if let Some(i) = self.bodies.live_slot(generation, slot) {
                    self.remove_body(i, tree);
                }
            }
            ps::KIND_COLLIDER => {
                if let Some(i) = self.colliders.live_slot(generation, slot) {
                    self.colliders.remove(i);
                }
            }
            ps::KIND_ZONE => {
                if let Some(i) = self.zones.live_slot(generation, slot) {
                    self.zones.remove(i);
                }
            }
            ps::KIND_EMITTER => {
                if let Some(i) = self.emitters.live_slot(generation, slot) {
                    self.remove_emitter(i, tree);
                }
            }
            _ => {}
        }
    }

    fn remove_body(&mut self, slot: usize, tree: &mut Tree) {
        if let Some(b) = self.bodies.remove(slot) {
            for view in b.views() {
                release_view(tree, view.node);
            }
        }
    }

    fn remove_emitter(&mut self, slot: usize, tree: &mut Tree) {
        if let Some(e) = self.emitters.remove(slot) {
            e.release(tree);
        }
    }

    // -- commands -------------------------------------------------------------

    /// `physicsApply(records)`: `[handle, cmd, argc, arg*]*`, in order. A
    /// record with a non-finite argument where NaN has no meaning is skipped.
    pub fn apply(&mut self, records: &[f64]) {
        let mut i = 0;
        while i + 3 <= records.len() {
            let handle = id(records[i]);
            let cmd = records[i + 1];
            let argc = records[i + 2];
            if !(argc >= 0.0 && argc <= MAX_ARGS as f64) {
                return;
            }
            let argc = argc as usize;
            if i + 3 + argc > records.len() {
                return;
            }
            let cmd = if (0.0..256.0).contains(&cmd) { cmd as u32 } else { 0 };
            let mut args = [0.0f64; MAX_ARGS];
            args[..argc].copy_from_slice(&records[i + 3..i + 3 + argc]);
            let finite = args[..argc].iter().enumerate().all(|(k, v)| v.is_finite() || (v.is_nan() && nan_allowed(cmd, k)));
            if finite {
                self.command(handle, cmd, &args, argc);
            }
            i += 3 + argc;
        }
    }

    fn command(&mut self, handle: i32, cmd: u32, args: &[f64; MAX_ARGS], argc: usize) {
        let a = |i: usize| f(args[i]);
        let Some((kind, generation, slot)) = split_handle(handle) else { return };
        match kind {
            ps::KIND_WORLD => {
                let Some(w) = self.worlds.live_slot(generation, slot) else { return };
                let Some(world) = self.worlds.items[w].as_mut() else { return };
                match cmd {
                    ps::CMD_GRAVITY => world.gravity = V2::new(a(0), a(1)),
                    ps::CMD_LISTEN => world.listening = a(0) != 0.0,
                    _ => {}
                }
            }
            ps::KIND_EMITTER => {
                let Some(ei) = self.emitters.live_slot(generation, slot) else { return };
                let Some(e) = self.emitters.items[ei].as_mut() else { return };
                match cmd {
                    ps::CMD_BURST => {
                        let count = clampf(a(2), 0.0, ps::MAX_POOL as f32) as usize;
                        let speed_scale = if argc > 5 { a(5) } else { 1.0 };
                        e.burst(V2::new(a(0), a(1)), count, a(3) * DEG, a(4) * DEG, speed_scale);
                    }
                    ps::CMD_STREAM => e.stream(a(0), V2::new(a(1), a(2)), V2::new(a(3), a(4))),
                    _ => {}
                }
            }
            ps::KIND_BODY => {
                let Some(bi) = self.bodies.live_slot(generation, slot) else { return };
                let order = if cmd == ps::CMD_GRAB { self.next_order() } else { 0 };
                let world = self.bodies.items[bi].as_ref().map_or(0, |b| b.world);
                let Some(origin) = self.worlds.items.get(world).and_then(|w| w.as_ref()).map(|w| w.origin) else { return };
                let Some(b) = self.bodies.items[bi].as_mut() else { return };
                let surface_point = |x: f32, y: f32, s: f32| origin[surface_index(s)].add(V2::new(x, y));
                match cmd {
                    ps::CMD_IMPULSE => {
                        b.asleep = false;
                        b.v = b.v.add(V2::new(a(0), a(1)));
                        b.w += a(2) * DEG;
                    }
                    ps::CMD_VELOCITY => {
                        b.asleep = false;
                        b.v = V2::new(a(0), a(1));
                        b.w = a(2) * DEG;
                    }
                    ps::CMD_TELEPORT => b.teleport(V2::new(a(0), a(1)), a(2) * DEG),
                    ps::CMD_LAUNCH => b.launch(Flight::new(
                        V2::new(a(0), a(1)),
                        V2::new(a(2), a(3)),
                        a(4),
                        a(5) * DEG,
                        a(6) * DEG,
                        a(7),
                        a(8),
                        if argc > 9 && a(9) > 0.0 { a(9) } else { 1.0 },
                        argc > 10 && a(10) != 0.0,
                    )),
                    ps::CMD_HOP => b.hop(a(0), a(1), a(2) * DEG),
                    ps::CMD_KICK => b.kick(a(0), a(1) * DEG, a(2) * DEG, a(3)),
                    ps::CMD_GRAB => {
                        b.order = order;
                        let strength = if a(4) > 0.0 { a(4) } else { 1.0 };
                        b.grab(surface_point(a(0), a(1), a(2)), a(3) as u32, strength);
                    }
                    ps::CMD_DRAG => {
                        let target = surface_point(a(0), a(1), a(2));
                        if let Some(g) = b.grab.as_mut() {
                            g.target = target;
                        }
                    }
                    ps::CMD_RELEASE => b.release(),
                    ps::CMD_PRESS => {
                        b.jelly.press_q = a(0);
                        b.jelly.press_pulse = if a(1) > 0.0 { a(1) } else { 1.0 };
                    }
                    ps::CMD_SETTLE => b.settle = Some((a(0), a(1))),
                    ps::CMD_ANCHOR => b.set_anchor(V2::new(a(0), a(1)), a(2) * DEG),
                    ps::CMD_WAKE => b.asleep = false,
                    _ => {}
                }
            }
            _ => {}
        }
    }

    // -- events and queries -------------------------------------------------

    /// Move the pending event records into `out` (cleared first).
    pub fn take_events(&mut self, out: &mut Vec<f64>) {
        out.clear();
        out.append(&mut self.events.buf);
        self.events.tick_start = 0;
    }

    pub fn has_events(&self) -> bool {
        !self.events.buf.is_empty()
    }

    /// `physicsQuery(query, handle, a, b, c, d)`.
    pub fn query(&self, query: u32, handle: i32, a: f64, b: f64, c: f64, d: f64) -> f64 {
        if query == ps::QUERY_PICK {
            return self.pick(handle, f(a), f(b), f(c), f(d)) as f64;
        }
        if query == ps::QUERY_PARTICLES {
            let Some((ps::KIND_EMITTER, generation, slot)) = split_handle(handle) else { return 0.0 };
            let Some(i) = self.emitters.live_slot(generation, slot) else { return 0.0 };
            return self.emitters.items[i].as_ref().map_or(0, |e| e.live()) as f64;
        }
        let Some(i) = self.body_slot(handle) else { return 0.0 };
        let Some(body) = self.bodies.items[i].as_ref() else { return 0.0 };
        let world = self.worlds.items.get(body.world).and_then(|w| w.as_ref());
        match query {
            ps::QUERY_X => body.p.x as f64,
            ps::QUERY_Y => body.p.y as f64,
            ps::QUERY_ANGLE => (body.a / DEG) as f64,
            ps::QUERY_VX => body.v.x as f64,
            ps::QUERY_VY => body.v.y as f64,
            ps::QUERY_SPIN => (body.w / DEG) as f64,
            ps::QUERY_SPEED => body.v.len() as f64,
            ps::QUERY_GROUNDED => match (body.ground_step, world) {
                (Some(step), Some(w)) => ((w.step - step) as f32 * w.h) as f64,
                _ => -1.0,
            },
            ps::QUERY_AIRBORNE => body.airborne as u32 as f64,
            ps::QUERY_MODE => body.mode() as f64,
            ps::QUERY_ANCHOR_X => body.rest().map_or(f64::NAN, |p| p.x as f64),
            ps::QUERY_ANCHOR_Y => body.rest().map_or(f64::NAN, |p| p.y as f64),
            _ => 0.0,
        }
    }

    fn pick(&self, world: i32, x: f32, y: f32, surface: f32, slop: f32) -> i32 {
        let Some(w) = self.world_slot(world as f64) else { return 0 };
        let Some(origin) = self.worlds.items[w].as_ref().map(|w| w.origin) else { return 0 };
        let point = origin[surface_index(surface)].add(V2::new(x, y));
        let slop = maxf(0.0, slop);
        let mut best: Option<(u32, usize)> = None;
        for (i, item) in self.bodies.items.iter().enumerate() {
            let Some(b) = item.as_ref() else { continue };
            if b.world != w || !b.pickable || b.asleep {
                continue;
            }
            if b.contains(point, slop) && best.is_none_or(|(order, _)| b.order > order) {
                best = Some((b.order, i));
            }
        }
        best.map_or(0, |(_, i)| self.bodies.handle(ps::KIND_BODY, i))
    }

    // -- the tick -------------------------------------------------------------

    /// Advance every world by one core tick of `dt` seconds and write the
    /// resulting poses into the views. `aux_root` is the auxiliary surface
    /// root (0 without one); views resolve their surface from it.
    pub fn step(&mut self, dt: f32, tree: &mut Tree, aux_root: i32) {
        if self.is_idle() {
            return;
        }
        self.refresh_geometry(tree, aux_root);
        for wi in 1..self.worlds.items.len() {
            let Some(world) = self.worlds.items[wi].as_mut() else { continue };
            let substeps = world.substeps.max(1);
            let h = dt / substeps as f32;
            world.h = h;
            let listening = world.listening;
            let handle = self.worlds.handle(ps::KIND_WORLD, wi);
            self.events.begin(listening);
            for _ in 0..substeps {
                self.integrate(wi, h);
                for item in self.bodies.items.iter_mut() {
                    if let Some(b) = item.as_mut() {
                        if b.world == wi {
                            b.refresh_cache();
                        }
                    }
                }
                for _ in 0..ITERATIONS {
                    self.collide_pairs(wi);
                    self.collide_statics(wi);
                }
                self.check_ghosts(wi);
            }
            self.update_zones(wi);
            for item in self.emitters.items.iter_mut() {
                if let Some(e) = item.as_mut() {
                    if e.world == wi {
                        e.step(dt);
                    }
                }
            }
            self.finish_grabs(wi, dt);
            self.events.end(handle);
        }
        self.write_views(tree, aux_root);
    }

    /// Layout-derived inputs: anchor homes and node-box colliders and zones.
    fn refresh_geometry(&mut self, tree: &Tree, aux_root: i32) {
        for item in self.bodies.items.iter_mut() {
            let Some(b) = item.as_mut() else { continue };
            if b.anchor != ps::ANCHOR_LAYOUT {
                continue;
            }
            let Some(view) = b.views().first().copied() else { continue };
            let Some(origin) = self.worlds.items.get(b.world).and_then(|w| w.as_ref()).map(|w| w.origin) else { continue };
            if let Some((surface, centre, _, _)) = node_frame(tree, view.node, aux_root) {
                b.set_home(origin[surface].add(centre).sub(view.offset));
            }
        }
        let resolve = |geo: &mut Geometry, world: usize, worlds: &Slots<World>| {
            if geo.node == 0 {
                return;
            }
            geo.valid = false;
            let Some(origin) = worlds.items.get(world).and_then(|w| w.as_ref()).map(|w| w.origin) else { return };
            if let Some((surface, centre, w, h)) = node_frame(tree, geo.node, aux_root) {
                geo.kind = GeoKind::Box;
                geo.c = origin[surface].add(centre);
                geo.hw = maxf(0.0, w * 0.5 + geo.pad);
                geo.hh = maxf(0.0, h * 0.5 + geo.pad);
                geo.valid = geo.hw > 0.0 && geo.hh > 0.0;
                geo.bounds();
            }
        };
        for item in self.colliders.items.iter_mut() {
            if let Some(c) = item.as_mut() {
                resolve(&mut c.geo, c.world, &self.worlds);
            }
        }
        for item in self.zones.items.iter_mut() {
            if let Some(z) = item.as_mut() {
                resolve(&mut z.geo, z.world, &self.worlds);
            }
        }
    }

    fn integrate(&mut self, wi: usize, h: f32) {
        let Physics { worlds, bodies, events, .. } = self;
        let Some(world) = worlds.items[wi].as_mut() else { return };
        world.step += 1;
        let rest_steps = world.steps(REST_GRACE);
        for bi in 1..bodies.items.len() {
            let handle = bodies.handle(ps::KIND_BODY, bi);
            let Some(b) = bodies.items[bi].as_mut() else { continue };
            if b.world != wi || b.asleep {
                continue;
            }
            b.integrate(world, h, rest_steps, handle, events);
        }
    }

    fn collide_pairs(&mut self, wi: usize) {
        let Physics { worlds, bodies, events, .. } = self;
        let Some(world) = worlds.items[wi].as_ref() else { return };
        let (now, cooldown) = (world.step, world.steps(HIT_COOLDOWN));
        let n = bodies.items.len();
        for i in 1..n {
            for j in (i + 1)..n {
                let (left, right) = bodies.items.split_at_mut(j);
                let (Some(a), Some(b)) = (left[i].as_mut(), right[0].as_mut()) else { continue };
                if a.world != wi || b.world != wi || a.asleep || b.asleep {
                    continue;
                }
                if a.layer & b.mask == 0 || b.layer & a.mask == 0 {
                    continue;
                }
                let (ha, hb) = (make_handle(ps::KIND_BODY, bodies.gens[i], i as u32), make_handle(ps::KIND_BODY, bodies.gens[j], j as u32));
                contact::collide_bodies(a, b, ha, hb, now, cooldown, events);
            }
        }
    }

    fn collide_statics(&mut self, wi: usize) {
        let Physics { worlds, bodies, colliders, events, .. } = self;
        let Some(world) = worlds.items[wi].as_ref() else { return };
        let (now, cooldown) = (world.step, world.steps(HIT_COOLDOWN));
        let mut kicks: Vec<OwnerKick> = Vec::new();
        for bi in 1..bodies.items.len() {
            let handle = bodies.handle(ps::KIND_BODY, bi);
            let Some(b) = bodies.items[bi].as_mut() else { continue };
            if b.world != wi || b.asleep || !b.takes_static_contacts() {
                continue;
            }
            for ci in 1..colliders.items.len() {
                let Some(c) = colliders.items[ci].as_ref() else { continue };
                if c.world != wi || !c.geo.valid || c.layer & b.mask == 0 || b.layer & c.mask == 0 {
                    continue;
                }
                let chandle = colliders.handle(ps::KIND_COLLIDER, ci);
                if b.ghost != 0 && b.ghost == chandle {
                    continue;
                }
                contact::collide_static(b, c, handle, chandle, now, cooldown, events, &mut kicks);
            }
        }
        for kick in kicks {
            let Some((ps::KIND_BODY, generation, slot)) = split_handle(kick.owner) else { continue };
            let Some(i) = bodies.live_slot(generation, slot) else { continue };
            if let Some(o) = bodies.items[i].as_mut() {
                // turn away from the side that was struck
                let side = if kick.x < o.p.x { -1.0 } else { 1.0 };
                o.jelly.vq += kick.squash;
                o.w -= side * kick.spin;
            }
        }
    }

    fn check_ghosts(&mut self, wi: usize) {
        let Physics { bodies, colliders, events, .. } = self;
        for bi in 1..bodies.items.len() {
            let handle = bodies.handle(ps::KIND_BODY, bi);
            let Some(b) = bodies.items[bi].as_mut() else { continue };
            if b.world != wi || b.ghost == 0 || b.asleep {
                continue;
            }
            let ghost = b.ghost;
            let clear = match split_handle(ghost) {
                Some((ps::KIND_COLLIDER, generation, slot)) => match colliders.live_slot(generation, slot) {
                    Some(ci) => colliders.items[ci].as_ref().is_none_or(|c| !b.overlaps(c.geo.lo, c.geo.hi)),
                    None => true,
                },
                _ => true,
            };
            if clear {
                b.ghost = 0;
                events.push(ps::EVENT_CLEAR, handle, ghost, b.p.x, b.p.y, 0.0, 0.0, 0.0);
            }
        }
    }

    fn update_zones(&mut self, wi: usize) {
        let Physics { bodies, zones, events, .. } = self;
        for zi in 1..zones.items.len() {
            let zhandle = zones.handle(ps::KIND_ZONE, zi);
            let Some(z) = zones.items[zi].as_mut() else { continue };
            if z.world != wi {
                continue;
            }
            let mut k = 0;
            while k < z.inside.len() {
                let (slot, generation) = z.inside[k];
                let still = bodies.live_slot(generation, slot).and_then(|i| bodies.items[i].as_ref()).is_some_and(|b| z.geo.contains(b.p));
                if still {
                    k += 1;
                } else {
                    z.inside.remove(k);
                    events.push(ps::EVENT_LEAVE, zhandle, make_handle(ps::KIND_BODY, generation, slot), 0.0, 0.0, 0.0, 0.0, 0.0);
                }
            }
            for bi in 1..bodies.items.len() {
                let Some(b) = bodies.items[bi].as_ref() else { continue };
                if b.world != wi || b.layer & z.mask == 0 || b.asleep {
                    continue;
                }
                let key = (bi as u32, bodies.gens[bi]);
                if z.inside.contains(&key) || !z.geo.contains(b.p) {
                    continue;
                }
                z.inside.push(key);
                events.push(ps::EVENT_ENTER, zhandle, bodies.handle(ps::KIND_BODY, bi), b.p.x, b.p.y, b.v.x, b.v.y, b.v.len());
            }
        }
    }

    /// Smooth each carried body's pointer velocity once per tick.
    fn finish_grabs(&mut self, wi: usize, dt: f32) {
        let follow = 1.0 - exp_neg(CARRY_SMOOTHING * dt);
        for item in self.bodies.items.iter_mut() {
            let Some(b) = item.as_mut() else { continue };
            if b.world != wi {
                continue;
            }
            if let Some(g) = b.grab.as_mut() {
                let raw = g.target.sub(g.prev).mul(1.0 / dt);
                g.vel = g.vel.add(raw.sub(g.vel).mul(follow));
                g.prev = g.target;
            }
        }
    }

    fn write_views(&mut self, tree: &mut Tree, aux_root: i32) {
        for item in self.bodies.items.iter() {
            let Some(b) = item.as_ref() else { continue };
            if b.views().is_empty() {
                continue;
            }
            let Some(origin) = self.worlds.items.get(b.world).and_then(|w| w.as_ref()).map(|w| w.origin) else { continue };
            let pose = b.pose();
            for view in b.views() {
                let Some((surface, centre, _, h)) = node_frame(tree, view.node, aux_root) else { continue };
                let t = b.p.sub(origin[surface]).add(view.offset).sub(centre);
                let origin_y = if h > 0.0 { b.jelly.pivot / h } else { 0.0 };
                let Some(node) = tree.get_mut(view.node) else { continue };
                put(node, spec::prop::TRANSLATE_X, t.x);
                put(node, spec::prop::TRANSLATE_Y, t.y);
                put(node, spec::prop::ROTATE, pose.rotate);
                put(node, spec::prop::SKEW_X, pose.skew);
                put(node, spec::prop::SCALE_X, pose.sx);
                put(node, spec::prop::SCALE_Y, pose.sy);
                put(node, spec::prop::ORIGIN_Y, origin_y);
            }
        }
        for item in self.emitters.items.iter_mut() {
            let Some(e) = item.as_mut() else { continue };
            let Some(origin) = self.worlds.items.get(e.world).and_then(|w| w.as_ref()).map(|w| w.origin) else { continue };
            e.write(tree, aux_root, &origin);
        }
    }
}
