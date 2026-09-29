//! 2D bodies stepped by the UI core: the native half of capability
//! `ui.physics` (contracts/spec/physics.ts, spec ops 52..56).
//!
//! A world advances inside `Ui::tick`, `substeps` semi-implicit Euler
//! integrations per core tick at the realm's fixed dt. Every tick ends by
//! writing each body's pose into its views' `anim_values` as the paint-only
//! props translateX/translateY, rotate, skewX, scaleX, scaleY and originY,
//! so the tree paints, clips and hit-tests the motion and layout never runs
//! for it. Emitters write the same props plus opacity and the image texture
//! into a pool of image nodes.
//!
//! Determinism: f32 arithmetic only, the draw module's polynomial sin/cos
//! and Newton sqrt, a polynomial atan2 and exp here, one xorshift32 per world,
//! and slot-ordered iteration everywhere. The same params, commands and tick
//! count give the same bits on every host.
//!
//! Collision model: a body collides as a set of sample circles (one for a
//! circle, eight for a rounded box: corners and edge midpoints of the box
//! shrunk by its corner radius). Samples meet static colliders (rounded
//! boxes, circles, thick polylines) and the exact shape of other bodies.
//! Contacts are resolved sequentially, three passes per substep: position
//! correction, a restitution impulse above `bounceSpeed`, Coulomb friction.

use alloc::vec;
use alloc::vec::Vec;

use crate::draw::{cosf, sinf, sqrtf};
use crate::layout::floorf;
use crate::spec;
use crate::spec::physics as ps;
use crate::tree::{Node, Tree};

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = 2.0 * PI;
const DEG: f32 = PI / 180.0;
/// Contact resolution passes per substep.
const ITERATIONS: usize = 3;
/// Seconds between two hit events of one body.
const HIT_COOLDOWN: f32 = 0.12;
/// Largest `argc` a command record may carry.
const MAX_ARGS: usize = 16;

// ---- math ---------------------------------------------------------------------

#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct V2 {
    x: f32,
    y: f32,
}

impl V2 {
    const ZERO: V2 = V2 { x: 0.0, y: 0.0 };
    #[inline]
    fn new(x: f32, y: f32) -> V2 {
        V2 { x, y }
    }
    #[inline]
    fn add(self, o: V2) -> V2 {
        V2::new(self.x + o.x, self.y + o.y)
    }
    #[inline]
    fn sub(self, o: V2) -> V2 {
        V2::new(self.x - o.x, self.y - o.y)
    }
    #[inline]
    fn mul(self, k: f32) -> V2 {
        V2::new(self.x * k, self.y * k)
    }
    #[inline]
    fn dot(self, o: V2) -> f32 {
        self.x * o.x + self.y * o.y
    }
    /// z of the 3D cross product.
    #[inline]
    fn cross(self, o: V2) -> f32 {
        self.x * o.y - self.y * o.x
    }
    #[inline]
    fn len2(self) -> f32 {
        self.dot(self)
    }
    #[inline]
    fn len(self) -> f32 {
        sqrtf(self.len2())
    }
    /// Rotate by an angle given as (sin, cos).
    #[inline]
    fn rot(self, s: f32, c: f32) -> V2 {
        V2::new(c * self.x - s * self.y, s * self.x + c * self.y)
    }
    /// Velocity of a point at offset `r` on a body spinning at `w`.
    #[inline]
    fn spin(w: f32, r: V2) -> V2 {
        V2::new(-w * r.y, w * r.x)
    }
}

#[inline]
fn absf(x: f32) -> f32 {
    f32::from_bits(x.to_bits() & 0x7fff_ffff)
}

#[inline]
fn minf(a: f32, b: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}

#[inline]
fn maxf(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

#[inline]
fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

#[inline]
fn signf(x: f32) -> f32 {
    if x < 0.0 {
        -1.0
    } else {
        1.0
    }
}

#[inline]
fn lerpf(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// atan2 by octant reduction and a degree-9 odd polynomial (|error| below
/// 1.5e-5 rad). Exactly 0 for (0, x > 0), so an unrotated pose stays
/// axis-aligned.
fn atan2f(y: f32, x: f32) -> f32 {
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let (ax, ay) = (absf(x), absf(y));
    let swap = ay > ax;
    let z = if swap { ax / ay } else { ay / ax };
    let s = z * z;
    let mut r = z * (0.999_866 + s * (-0.330_299_5 + s * (0.180_141 + s * (-0.085_133 + s * 0.020_835_1))));
    if swap {
        r = PI / 2.0 - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 {
        r = -r;
    }
    r
}

/// e^(-x) for x >= 0: halve into [0, 1/16], a 6-term series, square back.
fn exp_neg(x: f32) -> f32 {
    if !(x > 0.0) {
        return 1.0;
    }
    let mut x = x;
    let mut halvings = 0;
    while x > 0.0625 && halvings < 20 {
        x *= 0.5;
        halvings += 1;
    }
    let mut r = 1.0 - x * (1.0 - x * (0.5 - x * (1.0 / 6.0 - x * (1.0 / 24.0 - x * (1.0 / 120.0)))));
    for _ in 0..halvings {
        r *= r;
    }
    r
}

/// Wrap an angle into [-pi, pi).
#[inline]
fn wrap(a: f32) -> f32 {
    a - TAU * floorf((a + PI) / TAU)
}

/// Overshooting ease-out used for the launch grow (the homepage's backOut).
fn back_out(t: f32) -> f32 {
    const C: f32 = 1.9;
    let t = t - 1.0;
    1.0 + t * t * ((C + 1.0) * t + C)
}

#[inline]
fn tanf(x: f32) -> f32 {
    sinf(x) / cosf(x)
}

/// xorshift32 → [0, 1).
#[inline]
fn rand01(state: &mut u32) -> f32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    (x >> 8) as f32 / 16_777_216.0
}

// ---- handles and arenas -----------------------------------------------------------

#[inline]
fn make_handle(kind: u32, generation: u8, slot: u32) -> i32 {
    ((kind << ps::HANDLE_KIND_SHIFT) | ((generation as u32) << ps::HANDLE_GEN_SHIFT) | (slot & ps::HANDLE_SLOT_MASK)) as i32
}

/// (kind, generation, slot) of a positive handle.
#[inline]
fn split_handle(handle: i32) -> Option<(u32, u8, u32)> {
    if handle <= 0 {
        return None;
    }
    let h = handle as u32;
    Some((h >> ps::HANDLE_KIND_SHIFT, ((h >> ps::HANDLE_GEN_SHIFT) & 0xff) as u8, h & ps::HANDLE_SLOT_MASK))
}

/// Generation-tagged slots. Slot 0 is never handed out, so handle 0 stays
/// "none". Freed slots are reused LIFO.
struct Slots<T> {
    items: Vec<Option<T>>,
    gens: Vec<u8>,
    free: Vec<u32>,
    live: usize,
}

impl<T> Slots<T> {
    fn new() -> Self {
        let mut items = Vec::new();
        items.push(None);
        Slots { items, gens: vec![0], free: Vec::new(), live: 0 }
    }

    fn insert(&mut self, value: T) -> Option<(u32, u8)> {
        let slot = match self.free.pop() {
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

    fn live_slot(&self, generation: u8, slot: u32) -> Option<usize> {
        let i = slot as usize;
        if i == 0 || i >= self.items.len() || self.gens[i] != generation || self.items[i].is_none() {
            return None;
        }
        Some(i)
    }

    fn remove(&mut self, slot: usize) -> Option<T> {
        let value = self.items.get_mut(slot)?.take()?;
        self.gens[slot] = self.gens[slot].wrapping_add(1);
        self.free.push(slot as u32);
        self.live -= 1;
        Some(value)
    }

    fn handle(&self, kind: u32, slot: usize) -> i32 {
        make_handle(kind, self.gens[slot], slot as u32)
    }
}

// ---- views --------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct View {
    node: i32,
    offset: V2,
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
            break 0;
        }
        if aux_root != 0 && parent == aux_root {
            break 1;
        }
        parent = pnode.parent;
        depth += 1;
    };
    Some((surface, V2::new(x + w * 0.5, y + h * 0.5), w, h))
}

/// The props a body or emitter writes on its views.
const BODY_PROPS: [u8; 7] = [
    spec::prop::TRANSLATE_X,
    spec::prop::TRANSLATE_Y,
    spec::prop::ROTATE,
    spec::prop::SKEW_X,
    spec::prop::SCALE_X,
    spec::prop::SCALE_Y,
    spec::prop::ORIGIN_Y,
];

fn put(node: &mut Node, prop: u8, value: f32) {
    Node::put_entry(&mut node.anim_values, prop, value.to_bits());
}

fn clear_view(tree: &mut Tree, id: i32, with_opacity: bool) {
    if let Some(node) = tree.get_mut(id) {
        for prop in BODY_PROPS {
            Node::remove_entry(&mut node.anim_values, prop);
        }
        if with_opacity {
            Node::remove_entry(&mut node.anim_values, spec::prop::OPACITY);
        }
    }
}

// ---- objects ------------------------------------------------------------------

struct World {
    gravity: V2,
    substeps: u32,
    rng: u32,
    origin: [V2; 2],
    max_speed: f32,
    time: f32,
}

#[derive(Clone, Copy)]
enum Shape {
    None,
    Circle { r: f32 },
    Box { hw: f32, hh: f32, rc: f32 },
}

#[derive(Clone, Copy, Default)]
struct Jelly {
    q: f32,
    vq: f32,
    k: f32,
    c: f32,
    limit: f32,
    gain_x: f32,
    gain_y: f32,
    impact_axis: bool,
    /// World angle of the squash axis in impact mode.
    axis: f32,
    impact: f32,
    dent: f32,
    dent_limit: f32,
    land_gain: f32,
    land_min: f32,
    land_max: f32,
    land_spin: f32,
    lean: f32,
    vlean: f32,
    lean_k: f32,
    lean_c: f32,
    lean_gain: f32,
    lean_limit: f32,
    lean_impact: f32,
    pulse: f32,
    vpulse: f32,
    pulse_k: f32,
    pulse_c: f32,
    press_q: f32,
    press_pulse: f32,
    stretch_gain: f32,
    stretch_limit: f32,
    pivot: f32,
}

#[derive(Clone, Copy)]
struct Flight {
    t: f32,
    duration: f32,
    from: V2,
    to: V2,
    turn: f32,
    end_offset: f32,
    arrive: f32,
    grow: f32,
    end_scale: f32,
    solved: bool,
    v0: V2,
    g: f32,
    r0: f32,
    vr: f32,
}

#[derive(Clone, Copy)]
struct Grab {
    mode: u32,
    /// Tether: grabbed point in the body frame. Carry: world offset from the
    /// pointer to the body centre.
    local: V2,
    target: V2,
    prev: V2,
    vel: V2,
    strength: f32,
}

/// Collision pose cached once per substep: rotation, jelly scale and pivot
/// do not change while contacts resolve, only the position does.
#[derive(Clone, Copy)]
struct PoseCache {
    /// Shape centre relative to `p`.
    offset: V2,
    sin: f32,
    cos: f32,
    shape: Shape,
    radius: f32,
}

impl PoseCache {
    const EMPTY: PoseCache = PoseCache { offset: V2::ZERO, sin: 0.0, cos: 1.0, shape: Shape::None, radius: 0.0 };
}

struct Body {
    world: usize,
    cache: PoseCache,
    views: [View; ps::MAX_VIEWS],
    view_count: usize,
    shape: Shape,
    inv_mass: f32,
    inv_inertia: f32,
    restitution: f32,
    friction: f32,
    bounce_speed: f32,
    hit_speed: f32,
    gravity_scale: f32,
    linear_damping: f32,
    angular_damping: f32,
    max_spin: f32,
    layer: u32,
    mask: u32,
    pickable: bool,
    ghost: i32,
    asleep: bool,
    p: V2,
    v: V2,
    a: f32,
    w: f32,
    order: u32,
    anchor: u32,
    anchor_point: V2,
    anchor_angle: f32,
    anchor_axes: u32,
    snap_home: bool,
    home: V2,
    home_known: bool,
    stiffness: f32,
    damping: f32,
    spin_stiffness: f32,
    spin_damping: f32,
    air_gravity: f32,
    airborne: bool,
    armed: bool,
    jelly: Jelly,
    flight: Option<Flight>,
    grab: Option<Grab>,
    /// View scale from a launch grow / end scale.
    grow: f32,
    settle: Option<(f32, f32)>,
    ground_t: f32,
    hit_t: f32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GeoKind {
    None,
    Circle,
    Box,
    Chain,
}

/// Static geometry shared by colliders and zones. Node boxes resolve to
/// `Box` every tick; a node that is not laid out leaves `valid` false.
struct Geometry {
    kind: GeoKind,
    c: V2,
    hw: f32,
    hh: f32,
    r: f32,
    points: Vec<V2>,
    closed: bool,
    node: i32,
    pad: f32,
    valid: bool,
    lo: V2,
    hi: V2,
}

impl Geometry {
    fn bounds(&mut self) {
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

    fn segments(&self) -> usize {
        let n = self.points.len();
        if n < 2 {
            0
        } else if self.closed {
            n
        } else {
            n - 1
        }
    }

    fn segment(&self, i: usize) -> (V2, V2) {
        let n = self.points.len();
        (self.points[i], self.points[(i + 1) % n])
    }

    /// Point-in-shape for zones (a chain counts as its closed polygon).
    fn contains(&self, p: V2) -> bool {
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

struct Collider {
    world: usize,
    geo: Geometry,
    restitution: f32,
    friction: f32,
    layer: u32,
    mask: u32,
    owner: i32,
    owner_squash: f32,
    owner_squash_limit: f32,
    owner_spin: f32,
    owner_spin_limit: f32,
}

struct Zone {
    world: usize,
    geo: Geometry,
    mask: u32,
    /// Bodies currently inside, as (slot, generation).
    inside: Vec<(u32, u8)>,
}

#[derive(Clone, Copy, Default)]
struct Particle {
    alive: bool,
    p: V2,
    v: V2,
    rot: f32,
    vr: f32,
    life: f32,
    max: f32,
    size: f32,
    tex: i32,
}

struct Emitter {
    world: usize,
    views: Vec<View>,
    textures: Vec<i32>,
    particles: Vec<Particle>,
    next: usize,
    life: (f32, f32),
    speed: (f32, f32),
    size: (f32, f32),
    spin: (f32, f32),
    drag: f32,
    gravity: V2,
    scale_curve: u32,
    alpha_curve: u32,
    stream_angle: f32,
    stream_spread: f32,
    stream_rate: f32,
    stream_lo: V2,
    stream_size: V2,
    stream_acc: f32,
}

/// Event records pending the next drain, capped at `EVENT_MAX`.
struct Events {
    buf: Vec<f64>,
}

impl Events {
    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, kind: u32, a: i32, b: i32, x: f32, y: f32, nx: f32, ny: f32, speed: f32) {
        if self.buf.len() >= ps::EVENT_MAX * ps::EVENT_WORDS {
            return;
        }
        self.buf.extend_from_slice(&[kind as f64, a as f64, b as f64, x as f64, y as f64, nx as f64, ny as f64, speed as f64]);
    }
}

// ---- parameters ---------------------------------------------------------------

/// Iterate `[key, value]` pairs.
fn pairs(params: &[f64]) -> impl Iterator<Item = (u32, f64)> + '_ {
    params.chunks_exact(2).filter_map(|kv| {
        let key = kv[0];
        (key >= 0.0 && key < 4096.0).then(|| (key as u32, kv[1]))
    })
}

#[inline]
fn f(v: f64) -> f32 {
    v as f32
}

/// f64 → i32 handle/node id (non-finite → 0).
#[inline]
fn id(v: f64) -> i32 {
    if v.is_finite() && v >= i32::MIN as f64 && v <= i32::MAX as f64 {
        v as i32
    } else {
        0
    }
}

fn geometry(params: &[f64]) -> Geometry {
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
    let mut pending_x: Option<f32> = None;
    for (key, v) in pairs(params) {
        match key {
            ps::KEY_SHAPE => {
                g.kind = match v as u32 {
                    ps::SHAPE_CIRCLE => GeoKind::Circle,
                    ps::SHAPE_BOX | ps::SHAPE_NODE => GeoKind::Box,
                    ps::SHAPE_CHAIN => GeoKind::Chain,
                    _ => GeoKind::None,
                };
                if v as u32 == ps::SHAPE_NODE {
                    g.valid = false;
                }
            }
            ps::KEY_X => g.c.x = f(v),
            ps::KEY_Y => g.c.y = f(v),
            ps::KEY_RADIUS => g.r = maxf(0.0, f(v)),
            ps::KEY_HALF_WIDTH => g.hw = maxf(0.0, f(v)),
            ps::KEY_HALF_HEIGHT => g.hh = maxf(0.0, f(v)),
            ps::KEY_CORNER => g.r = maxf(0.0, f(v)),
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
    if g.node == 0 && !g.valid {
        g.kind = GeoKind::None;
        g.valid = true;
    }
    g.bounds();
    g
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

/// Pose written to a body's views.
struct Pose {
    rotate: f32,
    skew: f32,
    sx: f32,
    sy: f32,
}

impl Physics {
    pub fn new() -> Self {
        Physics {
            worlds: Slots::new(),
            bodies: Slots::new(),
            colliders: Slots::new(),
            zones: Slots::new(),
            emitters: Slots::new(),
            events: Events { buf: Vec::new() },
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
    /// a required world is missing or the arena is full.
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
            rng: 1,
            origin: [V2::ZERO; 2],
            max_speed: 6000.0,
            time: 0.0,
        };
        for (key, v) in pairs(params) {
            match key {
                ps::KEY_GRAVITY_X => w.gravity.x = f(v),
                ps::KEY_GRAVITY_Y => w.gravity.y = f(v),
                ps::KEY_SUBSTEPS => w.substeps = clampf(f(v), 1.0, 8.0) as u32,
                ps::KEY_SEED => {
                    let seed = v as u32;
                    w.rng = if seed == 0 { 1 } else { seed };
                }
                ps::KEY_PRIMARY_X => w.origin[0].x = f(v),
                ps::KEY_PRIMARY_Y => w.origin[0].y = f(v),
                ps::KEY_AUXILIARY_X => w.origin[1].x = f(v),
                ps::KEY_AUXILIARY_Y => w.origin[1].y = f(v),
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
        let Some(world) = pairs(params).find(|(k, _)| *k == ps::KEY_WORLD).and_then(|(_, v)| self.world_slot(v)) else {
            return 0;
        };
        let mut b = Body {
            world,
            cache: PoseCache::EMPTY,
            views: [View::default(); ps::MAX_VIEWS],
            view_count: 0,
            shape: Shape::None,
            inv_mass: 0.0,
            inv_inertia: 0.0,
            restitution: 0.3,
            friction: 0.4,
            bounce_speed: 110.0,
            hit_speed: 0.0,
            gravity_scale: 1.0,
            linear_damping: 0.08,
            angular_damping: 0.7,
            max_spin: 1600.0 * DEG,
            layer: 1,
            mask: 0xffff,
            pickable: false,
            ghost: 0,
            asleep: false,
            p: V2::ZERO,
            v: V2::ZERO,
            a: 0.0,
            w: 0.0,
            order: 0,
            anchor: ps::ANCHOR_NONE,
            anchor_point: V2::ZERO,
            anchor_angle: 0.0,
            anchor_axes: ps::AXIS_X | ps::AXIS_Y | ps::AXIS_ANGLE,
            snap_home: true,
            home: V2::ZERO,
            home_known: false,
            stiffness: 0.0,
            damping: 0.0,
            spin_stiffness: 0.0,
            spin_damping: 0.0,
            air_gravity: 980.0,
            airborne: false,
            armed: false,
            jelly: Jelly {
                limit: 0.42,
                gain_x: 0.6,
                gain_y: 1.0,
                dent_limit: 0.3,
                lean_limit: 14.0 * DEG,
                pulse: 1.0,
                press_pulse: 1.0,
                stretch_limit: 0.16,
                ..Jelly::default()
            },
            flight: None,
            grab: None,
            grow: 1.0,
            settle: None,
            ground_t: -1.0,
            hit_t: -1.0,
        };
        let (mut radius, mut hw, mut hh, mut corner) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        let mut shape = ps::SHAPE_NONE;
        let (mut density, mut mass, mut inertia) = (1.0f32, -1.0f32, 1.0f32);
        for (key, v) in pairs(params) {
            let x = f(v);
            match key {
                ps::KEY_LAYER => b.layer = v as u32,
                ps::KEY_MASK => b.mask = v as u32,
                ps::KEY_VIEW => {
                    if b.view_count < ps::MAX_VIEWS {
                        b.views[b.view_count] = View { node: id(v), offset: V2::ZERO };
                        b.view_count += 1;
                    }
                }
                ps::KEY_VIEW_OFFSET_X if b.view_count > 0 => b.views[b.view_count - 1].offset.x = x,
                ps::KEY_VIEW_OFFSET_Y if b.view_count > 0 => b.views[b.view_count - 1].offset.y = x,
                ps::KEY_X => {
                    b.p.x = x;
                    b.snap_home = false;
                }
                ps::KEY_Y => {
                    b.p.y = x;
                    b.snap_home = false;
                }
                ps::KEY_ANGLE => b.a = x * DEG,
                ps::KEY_SHAPE => shape = v as u32,
                ps::KEY_RADIUS => radius = maxf(0.0, x),
                ps::KEY_HALF_WIDTH => hw = maxf(0.0, x),
                ps::KEY_HALF_HEIGHT => hh = maxf(0.0, x),
                ps::KEY_CORNER => corner = maxf(0.0, x),
                ps::KEY_RESTITUTION => b.restitution = maxf(0.0, x),
                ps::KEY_FRICTION => b.friction = maxf(0.0, x),
                ps::KEY_DENSITY => density = maxf(0.0, x),
                ps::KEY_MASS => mass = x,
                ps::KEY_INERTIA => inertia = maxf(0.0, x),
                ps::KEY_GRAVITY_SCALE => b.gravity_scale = x,
                ps::KEY_LINEAR_DAMPING => b.linear_damping = maxf(0.0, x),
                ps::KEY_ANGULAR_DAMPING => b.angular_damping = maxf(0.0, x),
                ps::KEY_MAX_SPIN => b.max_spin = maxf(0.0, x) * DEG,
                ps::KEY_BOUNCE_SPEED => b.bounce_speed = maxf(0.0, x),
                ps::KEY_HIT_SPEED => b.hit_speed = maxf(0.0, x),
                ps::KEY_VX => b.v.x = x,
                ps::KEY_VY => b.v.y = x,
                ps::KEY_SPIN => b.w = x * DEG,
                ps::KEY_PICKABLE => b.pickable = v != 0.0,
                ps::KEY_GHOST => b.ghost = id(v),
                ps::KEY_ASLEEP => b.asleep = v != 0.0,
                ps::KEY_ANCHOR => b.anchor = v as u32,
                ps::KEY_ANCHOR_X => b.anchor_point.x = x,
                ps::KEY_ANCHOR_Y => b.anchor_point.y = x,
                ps::KEY_ANCHOR_ANGLE => b.anchor_angle = x * DEG,
                ps::KEY_ANCHOR_AXES => b.anchor_axes = v as u32,
                ps::KEY_STIFFNESS => b.stiffness = maxf(0.0, x),
                ps::KEY_DAMPING => b.damping = maxf(0.0, x),
                ps::KEY_SPIN_STIFFNESS => b.spin_stiffness = maxf(0.0, x),
                ps::KEY_SPIN_DAMPING => b.spin_damping = maxf(0.0, x),
                ps::KEY_AIR_GRAVITY => b.air_gravity = x,
                ps::KEY_SQUASH_STIFFNESS => b.jelly.k = maxf(0.0, x),
                ps::KEY_SQUASH_DAMPING => b.jelly.c = maxf(0.0, x),
                ps::KEY_SQUASH_LIMIT => b.jelly.limit = maxf(0.0, x),
                ps::KEY_SQUASH_X => b.jelly.gain_x = x,
                ps::KEY_SQUASH_Y => b.jelly.gain_y = x,
                ps::KEY_SQUASH_AXIS => b.jelly.impact_axis = v as u32 == ps::SQUASH_AXIS_IMPACT,
                ps::KEY_SQUASH_IMPACT => b.jelly.impact = maxf(0.0, x),
                ps::KEY_DENT => b.jelly.dent = maxf(0.0, x),
                ps::KEY_DENT_LIMIT => b.jelly.dent_limit = maxf(0.0, x),
                ps::KEY_LAND_GAIN => b.jelly.land_gain = maxf(0.0, x),
                ps::KEY_LAND_MIN => b.jelly.land_min = maxf(0.0, x),
                ps::KEY_LAND_MAX => b.jelly.land_max = maxf(0.0, x),
                ps::KEY_LAND_SPIN => b.jelly.land_spin = x * DEG,
                ps::KEY_LEAN_STIFFNESS => b.jelly.lean_k = maxf(0.0, x),
                ps::KEY_LEAN_DAMPING => b.jelly.lean_c = maxf(0.0, x),
                ps::KEY_LEAN_GAIN => b.jelly.lean_gain = x * DEG,
                ps::KEY_LEAN_LIMIT => b.jelly.lean_limit = maxf(0.0, x) * DEG,
                ps::KEY_LEAN_IMPACT => b.jelly.lean_impact = maxf(0.0, x),
                ps::KEY_PULSE_STIFFNESS => b.jelly.pulse_k = maxf(0.0, x),
                ps::KEY_PULSE_DAMPING => b.jelly.pulse_c = maxf(0.0, x),
                ps::KEY_STRETCH_GAIN => b.jelly.stretch_gain = maxf(0.0, x),
                ps::KEY_STRETCH_LIMIT => b.jelly.stretch_limit = maxf(0.0, x),
                ps::KEY_PIVOT => b.jelly.pivot = x,
                _ => {}
            }
        }
        b.shape = match shape {
            ps::SHAPE_CIRCLE if radius > 0.0 => Shape::Circle { r: radius },
            ps::SHAPE_BOX if hw > 0.0 && hh > 0.0 => Shape::Box { hw, hh, rc: minf(corner, minf(hw, hh)) },
            _ => Shape::None,
        };
        let (area, inertia_per_mass) = match b.shape {
            Shape::Circle { r } => (PI * r * r, r * r * 0.5),
            Shape::Box { hw, hh, .. } => (4.0 * hw * hh, (hw * hw + hh * hh) / 3.0),
            Shape::None => (0.0, 0.0),
        };
        let m = if mass < 0.0 { density * area } else { mass };
        if m > 0.0 {
            b.inv_mass = 1.0 / m;
            let i = m * inertia_per_mass * inertia;
            b.inv_inertia = if i > 0.0 { 1.0 / i } else { 0.0 };
        }
        if b.anchor == ps::ANCHOR_POINT {
            b.home = b.anchor_point;
            b.home_known = true;
            if b.snap_home {
                b.p = b.home;
                b.a = b.anchor_angle;
                b.snap_home = false;
            }
        }
        b.order = self.next_order();
        match self.bodies.insert(b) {
            Some((slot, generation)) => make_handle(ps::KIND_BODY, generation, slot),
            None => 0,
        }
    }

    fn create_collider(&mut self, params: &[f64]) -> i32 {
        let Some(world) = pairs(params).find(|(k, _)| *k == ps::KEY_WORLD).and_then(|(_, v)| self.world_slot(v)) else {
            return 0;
        };
        let mut c = Collider {
            world,
            geo: geometry(params),
            restitution: 1.0,
            friction: 0.55,
            layer: 1,
            mask: 0xffff,
            owner: 0,
            owner_squash: 0.0,
            owner_squash_limit: 3.0,
            owner_spin: 0.0,
            owner_spin_limit: 50.0 * DEG,
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
                _ => {}
            }
        }
        if c.geo.kind == GeoKind::None {
            return 0;
        }
        match self.colliders.insert(c) {
            Some((slot, generation)) => make_handle(ps::KIND_COLLIDER, generation, slot),
            None => 0,
        }
    }

    fn create_zone(&mut self, params: &[f64]) -> i32 {
        let Some(world) = pairs(params).find(|(k, _)| *k == ps::KEY_WORLD).and_then(|(_, v)| self.world_slot(v)) else {
            return 0;
        };
        let mut z = Zone { world, geo: geometry(params), mask: 0xffff, inside: Vec::new() };
        for (key, v) in pairs(params) {
            if key == ps::KEY_MASK {
                z.mask = v as u32;
            }
        }
        if z.geo.kind == GeoKind::None {
            return 0;
        }
        match self.zones.insert(z) {
            Some((slot, generation)) => make_handle(ps::KIND_ZONE, generation, slot),
            None => 0,
        }
    }

    fn create_emitter(&mut self, params: &[f64]) -> i32 {
        let Some(world) = pairs(params).find(|(k, _)| *k == ps::KEY_WORLD).and_then(|(_, v)| self.world_slot(v)) else {
            return 0;
        };
        let mut e = Emitter {
            world,
            views: Vec::new(),
            textures: Vec::new(),
            particles: Vec::new(),
            next: 0,
            life: (0.6, 0.8),
            speed: (100.0, 200.0),
            size: (1.0, 1.0),
            spin: (0.0, 0.0),
            drag: 0.0,
            gravity: V2::ZERO,
            scale_curve: ps::SCALE_CURVE_CONSTANT,
            alpha_curve: ps::ALPHA_CURVE_FADE,
            stream_angle: -90.0 * DEG,
            stream_spread: 30.0 * DEG,
            stream_rate: 0.0,
            stream_lo: V2::ZERO,
            stream_size: V2::ZERO,
            stream_acc: 0.0,
        };
        for (key, v) in pairs(params) {
            let x = f(v);
            match key {
                ps::KEY_VIEW if e.views.len() < ps::MAX_POOL => e.views.push(View { node: id(v), offset: V2::ZERO }),
                ps::KEY_VIEW_OFFSET_X => {
                    if let Some(view) = e.views.last_mut() {
                        view.offset.x = x;
                    }
                }
                ps::KEY_VIEW_OFFSET_Y => {
                    if let Some(view) = e.views.last_mut() {
                        view.offset.y = x;
                    }
                }
                ps::KEY_TEXTURE if e.textures.len() < ps::MAX_TEXTURES => e.textures.push(id(v)),
                ps::KEY_LIFE_MIN => e.life.0 = maxf(0.01, x),
                ps::KEY_LIFE_MAX => e.life.1 = maxf(0.01, x),
                ps::KEY_SPEED_MIN => e.speed.0 = x,
                ps::KEY_SPEED_MAX => e.speed.1 = x,
                ps::KEY_SIZE_MIN => e.size.0 = x,
                ps::KEY_SIZE_MAX => e.size.1 = x,
                ps::KEY_SPIN_MIN => e.spin.0 = x * DEG,
                ps::KEY_SPIN_MAX => e.spin.1 = x * DEG,
                ps::KEY_DRAG => e.drag = maxf(0.0, x),
                ps::KEY_GRAVITY_X => e.gravity.x = x,
                ps::KEY_GRAVITY_Y => e.gravity.y = x,
                ps::KEY_SCALE_CURVE => e.scale_curve = v as u32,
                ps::KEY_ALPHA_CURVE => e.alpha_curve = v as u32,
                ps::KEY_STREAM_ANGLE => e.stream_angle = x * DEG,
                ps::KEY_STREAM_SPREAD => e.stream_spread = x * DEG,
                _ => {}
            }
        }
        e.particles = vec![Particle::default(); e.views.len()];
        match self.emitters.insert(e) {
            Some((slot, generation)) => make_handle(ps::KIND_EMITTER, generation, slot),
            None => 0,
        }
    }

    // -- destroy ----------------------------------------------------------------

    /// `physicsDestroy(handle)`. A world takes every object in it; bodies and
    /// emitters clear the props they wrote on their views.
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
            for view in &b.views[..b.view_count] {
                clear_view(tree, view.node, false);
            }
        }
    }

    fn remove_emitter(&mut self, slot: usize, tree: &mut Tree) {
        if let Some(e) = self.emitters.remove(slot) {
            for view in &e.views {
                clear_view(tree, view.node, true);
            }
        }
    }

    // -- commands -------------------------------------------------------------

    /// `physicsApply(records)`: `[handle, cmd, argc, arg*]*`, in order.
    pub fn apply(&mut self, records: &[f64]) {
        let mut i = 0;
        while i + 3 <= records.len() {
            let handle = id(records[i]);
            let cmd = records[i + 1];
            let argc = records[i + 2];
            if !(argc >= 0.0) || argc > MAX_ARGS as f64 {
                return;
            }
            let argc = argc as usize;
            if i + 3 + argc > records.len() {
                return;
            }
            let mut args = [0.0f64; MAX_ARGS];
            args[..argc].copy_from_slice(&records[i + 3..i + 3 + argc]);
            let cmd = if cmd >= 0.0 && cmd < 256.0 { cmd as u32 } else { 0 };
            self.command(handle, cmd, &args, argc);
            i += 3 + argc;
        }
    }

    fn command(&mut self, handle: i32, cmd: u32, args: &[f64; MAX_ARGS], argc: usize) {
        let a = |i: usize| f(args[i]);
        let Some((kind, generation, slot)) = split_handle(handle) else { return };
        match kind {
            ps::KIND_WORLD => {
                let Some(w) = self.worlds.live_slot(generation, slot) else { return };
                if cmd == ps::CMD_GRAVITY {
                    if let Some(world) = self.worlds.items[w].as_mut() {
                        world.gravity = V2::new(a(0), a(1));
                    }
                }
            }
            ps::KIND_EMITTER => {
                let Some(ei) = self.emitters.live_slot(generation, slot) else { return };
                let wi = self.emitters.items[ei].as_ref().map_or(0, |e| e.world);
                let Some(world) = self.worlds.items.get_mut(wi).and_then(|w| w.as_mut()) else { return };
                let Some(e) = self.emitters.items[ei].as_mut() else { return };
                match cmd {
                    ps::CMD_BURST => {
                        let count = clampf(a(2), 0.0, ps::MAX_POOL as f32) as usize;
                        let speed_scale = if argc > 5 { a(5) } else { 1.0 };
                        e.burst(&mut world.rng, V2::new(a(0), a(1)), count, a(3) * DEG, a(4) * DEG, speed_scale);
                    }
                    ps::CMD_STREAM => {
                        e.stream_rate = maxf(0.0, a(0));
                        e.stream_lo = V2::new(a(1), a(2));
                        e.stream_size = V2::new(maxf(0.0, a(3)), maxf(0.0, a(4)));
                        if e.stream_rate == 0.0 {
                            e.stream_acc = 0.0;
                        }
                    }
                    _ => {}
                }
            }
            ps::KIND_BODY => {
                let Some(bi) = self.bodies.live_slot(generation, slot) else { return };
                let order = if cmd == ps::CMD_GRAB { self.next_order() } else { 0 };
                let world_origin = {
                    let wi = self.bodies.items[bi].as_ref().map_or(0, |b| b.world);
                    self.worlds.items.get(wi).and_then(|w| w.as_ref()).map(|w| w.origin)
                };
                let Some(origin) = world_origin else { return };
                let Some(b) = self.bodies.items[bi].as_mut() else { return };
                let surface_point = |x: f32, y: f32, s: f32| {
                    let s = if s >= 1.0 { 1 } else { 0 };
                    origin[s].add(V2::new(x, y))
                };
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
                    ps::CMD_TELEPORT => {
                        b.asleep = false;
                        b.p = V2::new(a(0), a(1));
                        b.a = a(2) * DEG;
                        b.v = V2::ZERO;
                        b.w = 0.0;
                        b.flight = None;
                        b.airborne = false;
                        b.armed = false;
                        b.snap_home = false;
                    }
                    ps::CMD_LAUNCH => {
                        b.asleep = false;
                        b.snap_home = false;
                        b.grab = None;
                        b.airborne = false;
                        b.armed = false;
                        let duration = maxf(1.0 / 240.0, a(4));
                        b.flight = Some(Flight {
                            t: 0.0,
                            duration,
                            from: V2::new(a(0), a(1)),
                            to: V2::new(args[2] as f32, args[3] as f32),
                            turn: a(5) * DEG,
                            end_offset: a(6) * DEG,
                            arrive: a(7),
                            grow: a(8),
                            end_scale: if argc > 9 && a(9) > 0.0 { a(9) } else { 1.0 },
                            solved: false,
                            v0: V2::ZERO,
                            g: 0.0,
                            r0: 0.0,
                            vr: 0.0,
                        });
                        b.p = V2::new(a(0), a(1));
                        b.grow = if a(8) > 0.0 { a(8) } else { 1.0 };
                        b.jelly.q = 0.0;
                        b.jelly.vq = 0.0;
                        b.jelly.lean = 0.0;
                        b.jelly.vlean = 0.0;
                    }
                    ps::CMD_HOP => {
                        if b.anchor != ps::ANCHOR_NONE && b.flight.is_none() && b.grab.is_none() {
                            b.asleep = false;
                            b.airborne = true;
                            b.armed = false;
                            b.v.y = minf(b.v.y, 0.0) - a(0);
                            b.jelly.vq -= a(1);
                            let toward = if b.a > b.anchor_angle { -1.0 } else { 1.0 };
                            b.w += toward * a(2) * DEG;
                        }
                    }
                    ps::CMD_KICK => {
                        b.jelly.vq += a(0);
                        b.jelly.vlean += a(1) * DEG;
                        b.w += a(2) * DEG;
                        b.jelly.vpulse += a(3);
                    }
                    ps::CMD_GRAB => {
                        b.asleep = false;
                        b.flight = None;
                        b.airborne = false;
                        b.armed = false;
                        b.order = order;
                        let target = surface_point(a(0), a(1), a(2));
                        let mode = a(3) as u32;
                        let local = if mode == ps::GRAB_CARRY {
                            b.p.sub(target)
                        } else {
                            let (s, c) = (sinf(-b.a), cosf(-b.a));
                            target.sub(b.p).rot(s, c).mul(0.75)
                        };
                        let strength = if a(4) > 0.0 { a(4) } else { 1.0 };
                        b.grab = Some(Grab { mode, local, target, prev: target, vel: V2::ZERO, strength });
                    }
                    ps::CMD_DRAG => {
                        let target = surface_point(a(0), a(1), a(2));
                        if let Some(g) = b.grab.as_mut() {
                            g.target = target;
                        }
                    }
                    ps::CMD_RELEASE => {
                        if let Some(g) = b.grab.take() {
                            if g.mode == ps::GRAB_CARRY {
                                b.v = g.vel;
                                if b.anchor != ps::ANCHOR_NONE {
                                    b.armed = true;
                                }
                            }
                        }
                    }
                    ps::CMD_PRESS => {
                        b.jelly.press_q = a(0);
                        b.jelly.press_pulse = if a(1) > 0.0 { a(1) } else { 1.0 };
                    }
                    ps::CMD_SETTLE => b.settle = Some((a(0), a(1))),
                    ps::CMD_ANCHOR => {
                        b.anchor_point = V2::new(a(0), a(1));
                        b.anchor_angle = a(2) * DEG;
                        if b.anchor != ps::ANCHOR_LAYOUT {
                            b.anchor = ps::ANCHOR_POINT;
                            b.home = b.anchor_point;
                            b.home_known = true;
                        }
                    }
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
            let Some((kind, generation, slot)) = split_handle(handle) else { return 0.0 };
            if kind != ps::KIND_EMITTER {
                return 0.0;
            }
            let Some(i) = self.emitters.live_slot(generation, slot) else { return 0.0 };
            return self.emitters.items[i].as_ref().map_or(0, |e| e.particles.iter().filter(|p| p.alive).count()) as f64;
        }
        let Some(i) = self.body_slot(handle) else { return 0.0 };
        let Some(body) = self.bodies.items[i].as_ref() else { return 0.0 };
        match query {
            ps::QUERY_X => body.p.x as f64,
            ps::QUERY_Y => body.p.y as f64,
            ps::QUERY_ANGLE => (body.a / DEG) as f64,
            ps::QUERY_VX => body.v.x as f64,
            ps::QUERY_VY => body.v.y as f64,
            ps::QUERY_SPIN => (body.w / DEG) as f64,
            ps::QUERY_SPEED => body.v.len() as f64,
            ps::QUERY_GROUNDED => {
                if body.ground_t < 0.0 {
                    -1.0
                } else {
                    let now = self.worlds.items.get(body.world).and_then(|w| w.as_ref()).map_or(0.0, |w| w.time);
                    (now - body.ground_t) as f64
                }
            }
            ps::QUERY_AIRBORNE => body.airborne as u32 as f64,
            ps::QUERY_ANCHOR_X if body.anchor != ps::ANCHOR_NONE && body.home_known => body.home.x as f64,
            ps::QUERY_ANCHOR_Y if body.anchor != ps::ANCHOR_NONE && body.home_known => body.home.y as f64,
            ps::QUERY_ANCHOR_X | ps::QUERY_ANCHOR_Y => f64::NAN,
            ps::QUERY_MODE => {
                (if body.grab.is_some() {
                    3
                } else if body.flight.is_some() {
                    2
                } else if body.anchor != ps::ANCHOR_NONE {
                    1
                } else {
                    0
                }) as f64
            }
            _ => 0.0,
        }
    }

    fn pick(&self, world: i32, x: f32, y: f32, surface: f32, slop: f32) -> i32 {
        let Some(w) = self.world_slot(world as f64) else { return 0 };
        let Some(origin) = self.worlds.items[w].as_ref().map(|w| w.origin) else { return 0 };
        let point = origin[if surface >= 1.0 { 1 } else { 0 }].add(V2::new(x, y));
        let slop = maxf(0.0, slop);
        let mut best: Option<(u32, usize)> = None;
        for (i, item) in self.bodies.items.iter().enumerate() {
            let Some(b) = item.as_ref() else { continue };
            if b.world != w || !b.pickable || b.asleep {
                continue;
            }
            let (c, angle, shape) = b.frame();
            let d = point.sub(c);
            let hit = match shape {
                Shape::Circle { r } => d.len2() < (r + slop) * (r + slop),
                Shape::Box { hw, hh, .. } => {
                    let l = d.rot(sinf(-angle), cosf(-angle));
                    absf(l.x) < hw + slop && absf(l.y) < hh + slop
                }
                Shape::None => false,
            };
            if hit && best.is_none_or(|(order, _)| b.order > order) {
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
            let Some(world) = self.worlds.items[wi].as_ref() else { continue };
            let substeps = world.substeps.max(1);
            let h = dt / substeps as f32;
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
            self.step_emitters(wi, dt);
            self.finish_grabs(wi, dt);
        }
        self.write_views(tree, aux_root);
    }

    /// Layout-derived inputs: anchor homes and node-box colliders and zones.
    fn refresh_geometry(&mut self, tree: &Tree, aux_root: i32) {
        for item in self.bodies.items.iter_mut() {
            let Some(b) = item.as_mut() else { continue };
            if b.anchor != ps::ANCHOR_LAYOUT || b.view_count == 0 {
                continue;
            }
            let Some(origin) = self.worlds.items.get(b.world).and_then(|w| w.as_ref()).map(|w| w.origin) else { continue };
            let view = b.views[0];
            if let Some((surface, centre, _, _)) = node_frame(tree, view.node, aux_root) {
                b.home = origin[surface].add(centre).sub(view.offset);
                b.home_known = true;
                if b.snap_home {
                    b.p = b.home;
                    b.a = b.anchor_angle;
                    b.snap_home = false;
                }
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
        world.time += h;
        for bi in 1..bodies.items.len() {
            let handle = bodies.handle(ps::KIND_BODY, bi);
            let Some(b) = bodies.items[bi].as_mut() else { continue };
            if b.world != wi || b.asleep {
                continue;
            }
            b.integrate(world, h, handle, events);
        }
    }

    fn collide_pairs(&mut self, wi: usize) {
        let Physics { worlds, bodies, events, .. } = self;
        let Some(world) = worlds.items[wi].as_ref() else { return };
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
                collide_bodies(a, b, ha, hb, world.time, events);
            }
        }
    }

    fn collide_statics(&mut self, wi: usize) {
        let Physics { worlds, bodies, colliders, events, .. } = self;
        let Some(world) = worlds.items[wi].as_ref() else { return };
        // (owner handle, squash velocity, spin velocity) applied after the pass
        let mut kicks: Vec<(i32, f32, f32)> = Vec::new();
        for bi in 1..bodies.items.len() {
            let handle = bodies.handle(ps::KIND_BODY, bi);
            let Some(b) = bodies.items[bi].as_mut() else { continue };
            if b.world != wi || b.asleep || b.flight.is_some() || b.inv_mass == 0.0 {
                continue;
            }
            if matches!(b.grab, Some(Grab { mode: ps::GRAB_CARRY, .. })) || matches!(b.shape, Shape::None) {
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
                collide_static(b, c, handle, chandle, world.time, events, &mut kicks);
            }
        }
        for (owner, squash, spin) in kicks {
            let Some((kind, generation, slot)) = split_handle(owner) else { continue };
            if kind != ps::KIND_BODY {
                continue;
            }
            if let Some(i) = bodies.live_slot(generation, slot) {
                if let Some(o) = bodies.items[i].as_mut() {
                    o.jelly.vq += squash;
                    o.w += spin;
                }
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
                    Some(ci) => {
                        let geo = &colliders.items[ci].as_ref().unwrap().geo;
                        let c = b.p.add(b.cache.offset);
                        let r = b.cache.radius;
                        c.x + r < geo.lo.x || c.x - r > geo.hi.x || c.y + r < geo.lo.y || c.y - r > geo.hi.y
                    }
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
            // leave: bodies gone or outside
            let mut k = 0;
            while k < z.inside.len() {
                let (slot, generation) = z.inside[k];
                let still = bodies.live_slot(generation, slot).and_then(|i| bodies.items[i].as_ref()).is_some_and(|b| z.geo.contains(b.p));
                if still {
                    k += 1;
                } else {
                    z.inside.remove(k);
                    let h = make_handle(ps::KIND_BODY, generation, slot);
                    events.push(ps::EVENT_LEAVE, zhandle, h, 0.0, 0.0, 0.0, 0.0, 0.0);
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
                let speed = b.v.len();
                events.push(ps::EVENT_ENTER, zhandle, bodies.handle(ps::KIND_BODY, bi), b.p.x, b.p.y, b.v.x, b.v.y, speed);
            }
        }
    }

    fn step_emitters(&mut self, wi: usize, dt: f32) {
        let Physics { worlds, emitters, .. } = self;
        let Some(world) = worlds.items[wi].as_mut() else { return };
        for item in emitters.items.iter_mut() {
            let Some(e) = item.as_mut() else { continue };
            if e.world != wi {
                continue;
            }
            e.step(&mut world.rng, dt);
        }
    }

    fn finish_grabs(&mut self, wi: usize, dt: f32) {
        for item in self.bodies.items.iter_mut() {
            let Some(b) = item.as_mut() else { continue };
            if b.world != wi {
                continue;
            }
            if let Some(g) = b.grab.as_mut() {
                let raw = g.target.sub(g.prev).mul(1.0 / dt);
                g.vel = g.vel.mul(0.5).add(raw.mul(0.5));
                g.prev = g.target;
            }
        }
    }

    fn write_views(&mut self, tree: &mut Tree, aux_root: i32) {
        for item in self.bodies.items.iter() {
            let Some(b) = item.as_ref() else { continue };
            if b.view_count == 0 {
                continue;
            }
            let Some(origin) = self.worlds.items.get(b.world).and_then(|w| w.as_ref()).map(|w| w.origin) else { continue };
            let pose = b.pose();
            for view in &b.views[..b.view_count] {
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
        for item in self.emitters.items.iter() {
            let Some(e) = item.as_ref() else { continue };
            let Some(origin) = self.worlds.items.get(e.world).and_then(|w| w.as_ref()).map(|w| w.origin) else { continue };
            for (view, particle) in e.views.iter().zip(e.particles.iter()) {
                if !particle.alive {
                    if let Some(node) = tree.get_mut(view.node) {
                        put(node, spec::prop::OPACITY, 0.0);
                    }
                    continue;
                }
                let Some((surface, centre, _, _)) = node_frame(tree, view.node, aux_root) else { continue };
                let t = particle.p.sub(origin[surface]).add(view.offset).sub(centre);
                let u = clampf(particle.life / particle.max, 0.0, 1.0);
                let scale = particle.size
                    * match e.scale_curve {
                        ps::SCALE_CURVE_POP => {
                            if u < 0.3 {
                                0.25 + 0.75 * (u / 0.3)
                            } else {
                                maxf(0.0, 1.0 - (u - 0.3) / 0.7)
                            }
                        }
                        ps::SCALE_CURVE_SHRINK => 1.0 - u,
                        _ => 1.0,
                    };
                let alpha = match e.alpha_curve {
                    ps::ALPHA_CURVE_FADE => 1.0 - u * u,
                    ps::ALPHA_CURVE_TWINKLE => sinf(PI * u) * 0.85,
                    _ => 1.0,
                };
                let Some(node) = tree.get_mut(view.node) else { continue };
                put(node, spec::prop::TRANSLATE_X, t.x);
                put(node, spec::prop::TRANSLATE_Y, t.y);
                put(node, spec::prop::ROTATE, particle.rot / DEG);
                put(node, spec::prop::SCALE_X, scale);
                put(node, spec::prop::SCALE_Y, scale);
                put(node, spec::prop::OPACITY, clampf(alpha, 0.0, 1.0));
                if particle.tex >= 0 && node.node_type == spec::NodeType::Image as u8 && node.tex != particle.tex {
                    node.tex = particle.tex;
                    node.sprite_frames = 0;
                }
            }
        }
    }
}

// ---- body dynamics --------------------------------------------------------------

impl Body {
    fn anchored(&self, axis: u32) -> bool {
        self.anchor != ps::ANCHOR_NONE && self.home_known && self.anchor_axes & axis != 0
    }

    /// Jelly scale factors along the body's own axes (body-axis squash).
    fn body_scale(&self) -> (f32, f32) {
        let s = self.jelly.pulse * self.grow;
        if self.jelly.impact_axis {
            (s, s)
        } else {
            (s * (1.0 + self.jelly.q * self.jelly.gain_x), s * (1.0 - self.jelly.q * self.jelly.gain_y))
        }
    }

    /// Collision frame: (centre, angle, shape scaled by body-axis jelly).
    /// A pivoted body turns and squashes about its foot, so the centre of
    /// its shape moves with the pose.
    fn frame(&self) -> (V2, f32, Shape) {
        let (sx, sy) = self.body_scale();
        let shape = match self.shape {
            Shape::Box { hw, hh, rc } => Shape::Box { hw: hw * sx, hh: hh * sy, rc: rc * minf(sx, sy) },
            Shape::Circle { r } => Shape::Circle { r: r * self.grow },
            Shape::None => Shape::None,
        };
        let pivot = self.jelly.pivot;
        if pivot == 0.0 {
            return (self.p, self.a, shape);
        }
        // pivot + M·(0, -pivot), M = R(a)·skewX(lean)·diag(sx, sy)
        let (s, c) = (sinf(self.a), cosf(self.a));
        let t = if self.jelly.lean == 0.0 { 0.0 } else { tanf(self.jelly.lean) };
        let col = V2::new(c * t * sy - s * sy, s * t * sy + c * sy);
        let foot = self.p.add(V2::new(0.0, pivot));
        (foot.sub(col.mul(pivot)), self.a, shape)
    }

    fn refresh_cache(&mut self) {
        let (c, a, shape) = self.frame();
        let radius = match shape {
            Shape::Circle { r } => r,
            Shape::Box { hw, hh, .. } => sqrtf(hw * hw + hh * hh),
            Shape::None => 0.0,
        };
        self.cache = PoseCache { offset: c.sub(self.p), sin: sinf(a), cos: cosf(a), shape, radius };
    }

    /// Collision frame from the substep cache: (centre, sin, cos, shape).
    #[inline]
    fn cframe(&self) -> (V2, f32, f32, Shape) {
        (self.p.add(self.cache.offset), self.cache.sin, self.cache.cos, self.cache.shape)
    }

    /// Sample circles in world space (centre, radius), from the cache.
    fn samples(&self, out: &mut [(V2, f32); 8]) -> usize {
        let (c, s, co, shape) = self.cframe();
        match shape {
            Shape::Circle { r } => {
                out[0] = (c, r);
                1
            }
            Shape::Box { hw, hh, rc } => {
                let rr = maxf(rc, 0.2 * minf(hw, hh));
                let (ex, ey) = (maxf(0.0, hw - rr), maxf(0.0, hh - rr));
                let local = [
                    V2::new(-ex, -ey),
                    V2::new(ex, -ey),
                    V2::new(ex, ey),
                    V2::new(-ex, ey),
                    V2::new(0.0, -ey),
                    V2::new(ex, 0.0),
                    V2::new(0.0, ey),
                    V2::new(-ex, 0.0),
                ];
                for (slot, l) in out.iter_mut().zip(local) {
                    *slot = (c.add(l.rot(s, co)), rr);
                }
                8
            }
            Shape::None => 0,
        }
    }

    fn land(&mut self, speed: f32, rng: &mut u32) {
        let j = &mut self.jelly;
        if j.land_gain > 0.0 {
            let kick = clampf(speed * j.land_gain, j.land_min, maxf(j.land_min, j.land_max));
            j.vq += kick;
            let sign = if rand01(rng) < 0.5 { -1.0 } else { 1.0 };
            self.w += sign * kick * j.land_spin;
        }
    }

    /// Poses written to views. Body-axis squash maps onto rotate/skewX/scale
    /// directly; an impact-axis squash is a world-space deformation composed
    /// with the rotation and decomposed as R(θ)·skewX(φ)·diag(sx, sy).
    fn pose(&self) -> Pose {
        let j = &self.jelly;
        let (sx, sy) = self.body_scale();
        if !(j.impact_axis && absf(j.q) > 1e-4) {
            return Pose { rotate: if self.a == 0.0 { 0.0 } else { self.a / DEG }, skew: j.lean / DEG, sx, sy };
        }
        // D = R(axis)·diag(1 - q·gy, 1 + q·gx)·R(-axis); M = D·R(a)·K(lean)·diag(sx, sy)
        let (sa, ca) = (sinf(j.axis), cosf(j.axis));
        let (along, across) = (1.0 - j.q * j.gain_y, 1.0 + j.q * j.gain_x);
        let d11 = ca * ca * along + sa * sa * across;
        let d22 = sa * sa * along + ca * ca * across;
        let d12 = ca * sa * (along - across);
        let (s, c) = (sinf(self.a), cosf(self.a));
        let t = if j.lean == 0.0 { 0.0 } else { tanf(j.lean) };
        // R(a)·K·S columns
        let (m11, m21) = (c * sx, s * sx);
        let (m12, m22) = (c * t * sy - s * sy, s * t * sy + c * sy);
        let a11 = d11 * m11 + d12 * m21;
        let a21 = d12 * m11 + d22 * m21;
        let a12 = d11 * m12 + d12 * m22;
        let a22 = d12 * m12 + d22 * m22;
        let qx = sqrtf(a11 * a11 + a21 * a21);
        if qx <= 1e-6 {
            return Pose { rotate: self.a / DEG, skew: 0.0, sx, sy };
        }
        let theta = atan2f(a21, a11);
        let k = (a11 * a12 + a21 * a22) / qx;
        let qy = (a11 * a22 - a21 * a12) / qx;
        let skew = if qy != 0.0 { atan2f(k, qy) } else { 0.0 };
        Pose { rotate: theta / DEG, skew: skew / DEG, sx: qx, sy: qy }
    }

    fn integrate(&mut self, world: &mut World, h: f32, handle: i32, events: &mut Events) {
        if let Some(mut fl) = self.flight {
            self.fly(&mut fl, world, h, handle, events);
            return;
        }
        let carry = matches!(self.grab, Some(Grab { mode: ps::GRAB_CARRY, .. }));
        if carry {
            let g = self.grab.unwrap();
            let next = g.target.add(g.local);
            self.v = next.sub(self.p).mul(1.0 / h);
            self.p = next;
        } else if self.inv_mass > 0.0 || self.anchor != ps::ANCHOR_NONE {
            let home = self.home;
            // anchor springs, hop gravity, world gravity
            if self.anchored(ps::AXIS_X) && self.stiffness > 0.0 {
                self.v.x += (self.stiffness * (home.x - self.p.x) - self.damping * self.v.x) * h;
            } else if self.inv_mass > 0.0 {
                self.v.x += world.gravity.x * self.gravity_scale * h;
            }
            if self.airborne {
                self.v.y += self.air_gravity * h;
            } else if self.anchored(ps::AXIS_Y) && self.stiffness > 0.0 {
                self.v.y += (self.stiffness * (home.y - self.p.y) - self.damping * self.v.y) * h;
            } else if self.inv_mass > 0.0 {
                self.v.y += world.gravity.y * self.gravity_scale * h;
            }
            if let Some(g) = self.grab {
                self.tether(&g, h);
            }
            let lin = clampf(1.0 - self.linear_damping * h, 0.0, 1.0);
            self.v = self.v.mul(lin);
            let speed = self.v.len();
            if speed > world.max_speed {
                self.v = self.v.mul(world.max_speed / speed);
            }
            self.p = self.p.add(self.v.mul(h));
            if self.airborne && self.v.y > 0.0 && self.p.y >= home.y {
                self.p.y = home.y;
                self.airborne = false;
                let speed = self.v.y;
                self.land(speed, &mut world.rng);
                self.v.y = -speed * 0.08;
                events.push(ps::EVENT_LAND, handle, 0, self.p.x, self.p.y, 0.0, -1.0, speed);
            }
            if self.armed {
                let unit = self.size_unit();
                let dist = self.p.sub(home).len();
                let speed = self.v.len();
                if dist < unit * 0.05 && speed > unit * 0.6 {
                    self.armed = false;
                    self.land(speed, &mut world.rng);
                } else if speed < unit * 0.4 && dist < unit * 0.02 {
                    self.armed = false;
                }
            }
        }
        // spin: anchor angle spring, damping, clamp
        if self.anchored(ps::AXIS_ANGLE) && self.spin_stiffness > 0.0 {
            self.w += (self.spin_stiffness * wrap(self.anchor_angle - self.a) - self.spin_damping * self.w) * h;
        }
        let ang = clampf(1.0 - self.angular_damping * h, 0.0, 1.0);
        self.w = clampf(self.w * ang, -self.max_spin, self.max_spin);
        self.a += self.w * h;
        self.step_jelly(h);
    }

    fn size_unit(&self) -> f32 {
        match self.shape {
            Shape::Circle { r } => 2.0 * r,
            Shape::Box { hw, hh, .. } => 2.0 * maxf(hw, hh),
            Shape::None => 64.0,
        }
    }

    fn step_jelly(&mut self, h: f32) {
        let airborne = self.airborne;
        let vy = self.v.y;
        let vx = self.v.x;
        let j = &mut self.jelly;
        if j.k > 0.0 {
            let target = if airborne { -minf(j.stretch_limit, absf(vy) * j.stretch_gain) } else { j.press_q };
            j.vq += (j.k * (target - j.q) - j.c * j.vq) * h;
            j.q = clampf(j.q + j.vq * h, -j.limit, j.limit);
        }
        if j.lean_k > 0.0 {
            let target = clampf(-vx * j.lean_gain, -j.lean_limit, j.lean_limit);
            j.vlean += (j.lean_k * (target - j.lean) - j.lean_c * j.vlean) * h;
            j.lean += j.vlean * h;
        }
        if j.pulse_k > 0.0 {
            j.vpulse += (j.pulse_k * (j.press_pulse - j.pulse) - j.pulse_c * j.vpulse) * h;
            j.pulse += j.vpulse * h;
        }
    }

    /// Soft pointer joint: drive the grabbed point's velocity toward the
    /// pointer with a positional bias, bounded by a force limit.
    fn tether(&mut self, g: &Grab, h: f32) {
        if self.inv_mass == 0.0 {
            return;
        }
        let (s, c) = (sinf(self.a), cosf(self.a));
        let r = g.local.rot(s, c);
        let err = g.target.sub(self.p.add(r));
        let bias = err.mul(0.24 / h);
        let va = self.v.add(V2::spin(self.w, r));
        let (im, ii) = (self.inv_mass, self.inv_inertia);
        let k11 = im + ii * r.y * r.y;
        let k12 = -ii * r.x * r.y;
        let k22 = im + ii * r.x * r.x;
        let det = k11 * k22 - k12 * k12;
        if det <= 0.0 {
            return;
        }
        let dv = bias.sub(va);
        let mut j = V2::new((k22 * dv.x - k12 * dv.y) / det, (-k12 * dv.x + k11 * dv.y) / det);
        // the homepage's 70000 px/s² per unit mass at its default scale
        let max_j = 40_000.0 * g.strength * h / im;
        let jl = j.len();
        if jl > max_j {
            j = j.mul(max_j / jl);
        }
        self.v = self.v.add(j.mul(im));
        self.w += ii * r.cross(j);
        self.w *= 0.965;
    }

    fn fly(&mut self, fl: &mut Flight, world: &mut World, h: f32, handle: i32, events: &mut Events) {
        if !fl.solved {
            let to = V2::new(
                if fl.to.x.is_nan() { self.home.x } else { fl.to.x },
                if fl.to.y.is_nan() { self.home.y } else { fl.to.y },
            );
            fl.to = to;
            let d = to.sub(fl.from);
            let tf = fl.duration;
            fl.g = 2.0 * (fl.arrive - d.y / tf) / tf;
            fl.v0 = V2::new(d.x / tf, d.y / tf - fl.g * tf * 0.5);
            let rest = if self.anchor != ps::ANCHOR_NONE { self.anchor_angle } else { self.a + fl.turn };
            let r1 = rest + fl.end_offset;
            fl.r0 = r1 - fl.turn;
            fl.vr = fl.turn / tf;
            fl.solved = true;
        }
        fl.t += h;
        let t = fl.t;
        // accumulated substeps land a hair short of the duration in f32
        if t >= fl.duration - h * 0.25 {
            self.flight = None;
            self.grow = 1.0;
            self.jelly.q = 0.0;
            self.jelly.vq = 0.0;
            if self.anchor != ps::ANCHOR_NONE {
                self.p = fl.to;
                self.v = V2::new(fl.v0.x * 0.1, fl.arrive * 0.3);
                self.a = self.anchor_angle + wrap(fl.r0 + fl.vr * fl.duration - self.anchor_angle);
                self.w = fl.vr * 0.12;
                self.land(fl.arrive * 0.85, &mut world.rng);
            } else {
                self.p = fl.to;
                self.v = V2::new(fl.v0.x, fl.v0.y + fl.g * fl.duration);
                self.a = fl.r0 + fl.vr * fl.duration;
                self.w = fl.vr;
            }
            events.push(ps::EVENT_LAND, handle, 0, self.p.x, self.p.y, 0.0, -1.0, fl.arrive);
            return;
        }
        self.p = V2::new(fl.from.x + fl.v0.x * t, fl.from.y + fl.v0.y * t + 0.5 * fl.g * t * t);
        self.v = V2::new(fl.v0.x, fl.v0.y + fl.g * t);
        self.a = fl.r0 + fl.vr * t;
        self.w = fl.vr;
        let grow = if fl.grow > 0.0 && t < 0.2 { fl.grow + (1.0 - fl.grow) * back_out(t / 0.2) } else { 1.0 };
        self.grow = grow * lerpf(1.0, fl.end_scale, t / fl.duration);
        self.jelly.q = -minf(self.jelly.stretch_limit, self.v.len() * self.jelly.stretch_gain * 0.4);
        self.flight = Some(*fl);
    }
}

// ---- contacts -------------------------------------------------------------------

/// Inverse mass and inertia a body contributes to a contact this pass.
fn contact_mass(b: &Body) -> (f32, f32) {
    if b.flight.is_some() || matches!(b.grab, Some(Grab { mode: ps::GRAB_CARRY, .. })) {
        return (0.0, 0.0);
    }
    if matches!(b.grab, Some(Grab { mode: ps::GRAB_TETHER, .. })) {
        return (b.inv_mass * 0.2, b.inv_inertia * 0.2);
    }
    (b.inv_mass, b.inv_inertia)
}

/// Rounded box (centre, angle, half extents, corner) against a circle:
/// (normal from the box toward the circle, penetration) or None.
fn box_circle(bc: V2, s: f32, c: f32, hw: f32, hh: f32, rc: f32, p: V2, r: f32) -> Option<(V2, f32)> {
    let d = p.sub(bc);
    if d.len2() > (sqrtf(hw * hw + hh * hh) + r) * (sqrtf(hw * hw + hh * hh) + r) {
        return None;
    }
    let l = d.rot(-s, c);
    let (ex, ey) = (maxf(0.0, hw - rc), maxf(0.0, hh - rc));
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
    if pen <= 0.0 {
        return None;
    }
    Some((n.rot(s, c), pen))
}

fn collide_bodies(a: &mut Body, b: &mut Body, ha: i32, hb: i32, time: f32, events: &mut Events) {
    let (ma, _) = contact_mass(a);
    let (mb, _) = contact_mass(b);
    if ma == 0.0 && mb == 0.0 {
        return;
    }
    if matches!(a.shape, Shape::None) || matches!(b.shape, Shape::None) {
        return;
    }
    let ca = a.p.add(a.cache.offset);
    let cb = b.p.add(b.cache.offset);
    let reach = a.cache.radius + b.cache.radius;
    if ca.sub(cb).len2() >= reach * reach {
        return;
    }
    // A's samples against B's exact shape, then B's against A's
    let mut samples = [(V2::ZERO, 0.0f32); 8];
    for pass in 0..2 {
        let (first, second) = if pass == 0 { (&*a, &*b) } else { (&*b, &*a) };
        if pass == 1 && matches!(first.shape, Shape::Circle { .. }) && matches!(second.shape, Shape::Circle { .. }) {
            break;
        }
        let n = first.samples(&mut samples);
        let (sc, ss, scos, shape) = second.cframe();
        let mut contacts: [(V2, V2, f32); 8] = [(V2::ZERO, V2::ZERO, 0.0); 8];
        let mut count = 0;
        for &(p, r) in &samples[..n] {
            let hit = match shape {
                Shape::Circle { r: rb } => {
                    let d = p.sub(sc);
                    let dl = d.len();
                    if dl < r + rb && dl > 1e-6 {
                        Some((d.mul(1.0 / dl), r + rb - dl))
                    } else {
                        None
                    }
                }
                Shape::Box { hw, hh, rc } => box_circle(sc, ss, scos, hw, hh, rc, p, r),
                Shape::None => None,
            };
            if let Some((normal, pen)) = hit {
                contacts[count] = (p.sub(normal.mul(r)), normal, pen);
                count += 1;
            }
        }
        for &(point, normal, pen) in &contacts[..count] {
            // normal points from `second` toward `first`
            if pass == 0 {
                resolve_pair(a, b, ha, hb, point, normal, pen, time, events);
            } else {
                resolve_pair(b, a, hb, ha, point, normal, pen, time, events);
            }
        }
    }
}

/// Resolve one contact; `n` points from `b` toward `a`.
#[allow(clippy::too_many_arguments)]
fn resolve_pair(a: &mut Body, b: &mut Body, ha: i32, hb: i32, point: V2, n: V2, pen: f32, time: f32, events: &mut Events) {
    let (ima, iia) = contact_mass(a);
    let (imb, iib) = contact_mass(b);
    let msum = ima + imb;
    if msum == 0.0 {
        return;
    }
    let corr = pen * 0.7 / msum;
    a.p = a.p.add(n.mul(corr * ima));
    b.p = b.p.sub(n.mul(corr * imb));
    let ca = a.p.add(a.cache.offset);
    let cb = b.p.add(b.cache.offset);
    let ra = point.sub(ca);
    let rb = point.sub(cb);
    let rv = a.v.add(V2::spin(a.w, ra)).sub(b.v.add(V2::spin(b.w, rb)));
    let vn = rv.dot(n);
    if vn >= 0.0 {
        return;
    }
    let speed = -vn;
    let e = if speed > minf(a.bounce_speed, b.bounce_speed) { minf(a.restitution, b.restitution) } else { 0.0 };
    let rna = ra.cross(n);
    let rnb = rb.cross(n);
    let denom = msum + rna * rna * iia + rnb * rnb * iib;
    let jn = -(1.0 + e) * vn / denom;
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
    let denom_t = msum + rta * rta * iia + rtb * rtb * iib;
    let mu = 0.5 * (a.friction + b.friction);
    let jt = clampf(-vt / denom_t, -mu * jn, mu * jn);
    a.v = a.v.add(t.mul(jt * ima));
    a.w += rta * jt * iia;
    b.v = b.v.sub(t.mul(jt * imb));
    b.w -= rtb * jt * iib;
    // jelly and events
    react(a, n, jn * ima, speed);
    react(b, n.mul(-1.0), jn * imb, speed);
    hit_event(a, ha, hb, point, n, speed, time, events);
    hit_event(b, hb, ha, point, n.mul(-1.0), speed, time, events);
}

/// Jelly response to a contact on `b`: `n` points toward `b`, `dv` is the
/// velocity change the impulse gave it, `speed` the approach speed.
fn react(b: &mut Body, n: V2, dv: f32, speed: f32) {
    let j = &mut b.jelly;
    if dv > 0.0 && (j.impact > 0.0 || j.lean_impact > 0.0) {
        let (s, c) = (sinf(-b.a), cosf(-b.a));
        let nl = n.rot(s, c);
        if j.impact > 0.0 {
            let kick = minf(5.5, dv * j.impact);
            j.vq += kick * (absf(nl.y) - 0.55 * absf(nl.x));
        }
        if j.lean_impact > 0.0 {
            j.vlean -= clampf(nl.x * dv * j.lean_impact, -3.0, 3.0);
        }
    }
    if j.dent > 0.0 {
        let amt = minf(j.dent_limit, speed * j.dent);
        if amt > 0.035 && amt > absf(j.q) {
            j.q = amt;
            j.vq = 0.0;
            j.axis = atan2f(n.y, n.x);
        }
    }
    // pushed up from below: a hop gives way to the springs
    if b.airborne && n.y < -0.5 && dv > 0.0 {
        b.airborne = false;
    }
}

#[allow(clippy::too_many_arguments)]
fn hit_event(b: &mut Body, own: i32, other: i32, point: V2, n: V2, speed: f32, time: f32, events: &mut Events) {
    if b.hit_speed > 0.0 && speed >= b.hit_speed && time - b.hit_t >= HIT_COOLDOWN {
        b.hit_t = time;
        events.push(ps::EVENT_HIT, own, other, point.x, point.y, n.x, n.y, speed);
    }
}

/// Distance query of a sample circle against static geometry:
/// (normal from the geometry toward the sample, penetration).
fn geo_circle(geo: &Geometry, p: V2, r: f32, out: &mut Vec<(V2, f32)>) {
    match geo.kind {
        GeoKind::Circle => {
            let d = p.sub(geo.c);
            let dl = d.len();
            if dl < geo.r + r && dl > 1e-6 {
                out.push((d.mul(1.0 / dl), geo.r + r - dl));
            }
        }
        GeoKind::Box => {
            if let Some(hit) = box_circle(geo.c, 0.0, 1.0, geo.hw, geo.hh, minf(geo.r, minf(geo.hw, geo.hh)), p, r) {
                out.push(hit);
            }
        }
        GeoKind::Chain => {
            if p.x + r < geo.lo.x || p.x - r > geo.hi.x || p.y + r < geo.lo.y || p.y - r > geo.hi.y {
                return;
            }
            // the deepest segment only, so a joint between two segments
            // does not push twice
            let mut best: Option<(V2, f32)> = None;
            for i in 0..geo.segments() {
                let (a, b) = geo.segment(i);
                let ab = b.sub(a);
                let l2 = ab.len2();
                let t = if l2 > 0.0 { clampf(p.sub(a).dot(ab) / l2, 0.0, 1.0) } else { 0.0 };
                let q = a.add(ab.mul(t));
                let d = p.sub(q);
                let dl = d.len();
                let pen = geo.r + r - dl;
                if pen <= 0.0 {
                    continue;
                }
                let n = if dl > 1e-6 {
                    d.mul(1.0 / dl)
                } else {
                    let len = sqrtf(l2);
                    if len > 0.0 {
                        V2::new(-ab.y / len, ab.x / len)
                    } else {
                        V2::new(0.0, -1.0)
                    }
                };
                if best.is_none_or(|(_, bp)| pen > bp) {
                    best = Some((n, pen));
                }
            }
            if let Some(hit) = best {
                out.push(hit);
            }
        }
        GeoKind::None => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn collide_static(
    b: &mut Body,
    c: &Collider,
    handle: i32,
    chandle: i32,
    time: f32,
    events: &mut Events,
    kicks: &mut Vec<(i32, f32, f32)>,
) {
    let r = b.cache.radius;
    let centre = b.p.add(b.cache.offset);
    if centre.x + r < c.geo.lo.x || centre.x - r > c.geo.hi.x || centre.y + r < c.geo.lo.y || centre.y - r > c.geo.hi.y {
        return;
    }
    let mut samples = [(V2::ZERO, 0.0f32); 8];
    let n = b.samples(&mut samples);
    let mut hits: Vec<(V2, f32)> = Vec::new();
    for &(p, sr) in &samples[..n] {
        hits.clear();
        geo_circle(&c.geo, p, sr, &mut hits);
        for &(normal, pen) in &hits {
            let point = p.sub(normal.mul(sr));
            let speed = resolve_static(b, point, normal, pen, c.restitution, c.friction);
            if speed <= 0.0 {
                continue;
            }
            if normal.y < -0.7 {
                b.ground_t = time;
                if let Some((vx, spin)) = b.settle.take() {
                    b.v.x *= vx;
                    b.w *= spin;
                }
            }
            react(b, normal, speed * (1.0 + minf(b.restitution, c.restitution)), speed);
            hit_event(b, handle, chandle, point, normal, speed, time, events);
            if c.owner != 0 && (c.owner_squash > 0.0 || c.owner_spin != 0.0) {
                let squash = minf(c.owner_squash_limit, speed * c.owner_squash);
                let side = signf(point.x - c.geo.c.x);
                let spin = -side * minf(c.owner_spin_limit, speed * absf(c.owner_spin)) * signf(c.owner_spin);
                kicks.push((c.owner, squash, spin));
            }
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
    let c = b.p.add(b.cache.offset);
    let r = point.add(n.mul(pen)).sub(c);
    let vp = b.v.add(V2::spin(b.w, r));
    let vn = vp.dot(n);
    if vn >= 0.0 {
        return 0.0;
    }
    let speed = -vn;
    let e = if speed > b.bounce_speed { minf(b.restitution, restitution) } else { 0.0 };
    let rn = r.cross(n);
    let jn = -(1.0 + e) * vn / (im + rn * rn * ii);
    b.v = b.v.add(n.mul(jn * im));
    b.w += rn * jn * ii;
    let t = V2::new(-n.y, n.x);
    let vp = b.v.add(V2::spin(b.w, r));
    let vt = vp.dot(t);
    let rt = r.cross(t);
    let mu = 0.5 * (b.friction + friction);
    let jt = clampf(-vt / (im + rt * rt * ii), -mu * jn, mu * jn);
    b.v = b.v.add(t.mul(jt * im));
    b.w += rt * jt * ii;
    speed
}

// ---- particles ------------------------------------------------------------------

impl Emitter {
    fn spawn(&mut self, rng: &mut u32, p: V2, angle: f32, speed_scale: f32) {
        if self.particles.is_empty() {
            return;
        }
        // a free slot, else the oldest
        let n = self.particles.len();
        let mut slot = None;
        for k in 0..n {
            let i = (self.next + k) % n;
            if !self.particles[i].alive {
                slot = Some(i);
                break;
            }
        }
        let i = slot.unwrap_or(self.next % n);
        self.next = (i + 1) % n;
        let speed = lerpf(self.speed.0, self.speed.1, rand01(rng)) * speed_scale;
        let life = lerpf(self.life.0, self.life.1, rand01(rng));
        let size = lerpf(self.size.0, self.size.1, rand01(rng));
        let rot = rand01(rng) * TAU;
        let spin = lerpf(self.spin.0, self.spin.1, rand01(rng)) * if rand01(rng) < 0.5 { -1.0 } else { 1.0 };
        let tex = if self.textures.is_empty() {
            -1
        } else {
            self.textures[((rand01(rng) * self.textures.len() as f32) as usize).min(self.textures.len() - 1)]
        };
        self.particles[i] = Particle {
            alive: true,
            p,
            v: V2::new(cosf(angle) * speed, sinf(angle) * speed),
            rot,
            vr: spin,
            life: 0.0,
            max: maxf(0.01, life),
            size,
            tex,
        };
    }

    fn burst(&mut self, rng: &mut u32, p: V2, count: usize, angle: f32, spread: f32, speed_scale: f32) {
        for k in 0..count {
            let base = if count > 1 { (k as f32 + 0.5) / count as f32 - 0.5 } else { 0.0 };
            let jitter = (rand01(rng) - 0.5) / maxf(1.0, count as f32);
            self.spawn(rng, p, angle + spread * (base + jitter), speed_scale);
        }
    }

    fn step(&mut self, rng: &mut u32, dt: f32) {
        if self.stream_rate > 0.0 {
            self.stream_acc += self.stream_rate * dt;
            while self.stream_acc >= 1.0 {
                self.stream_acc -= 1.0;
                let p = self.stream_lo.add(V2::new(rand01(rng) * self.stream_size.x, rand01(rng) * self.stream_size.y));
                let angle = self.stream_angle + (rand01(rng) - 0.5) * self.stream_spread;
                self.spawn(rng, p, angle, 1.0);
            }
        }
        let decay = exp_neg(self.drag * dt);
        for p in self.particles.iter_mut() {
            if !p.alive {
                continue;
            }
            p.life += dt;
            if p.life >= p.max {
                p.alive = false;
                continue;
            }
            p.v = p.v.mul(decay).add(self.gravity.mul(dt));
            p.p = p.p.add(p.v.mul(dt));
            p.rot += p.vr * dt;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atan2_matches_quadrants_and_keeps_zero_exact() {
        assert_eq!(atan2f(0.0, 1.0), 0.0);
        for &(y, x) in &[(1.0f32, 1.0f32), (1.0, -1.0), (-1.0, -1.0), (-1.0, 1.0), (0.3, 2.0), (2.0, 0.3), (-5.0, 0.1)] {
            let expected = (y as f64).atan2(x as f64) as f32;
            assert!(absf(atan2f(y, x) - expected) < 2e-5, "atan2({y}, {x})");
        }
    }

    #[test]
    fn exp_neg_tracks_the_series() {
        for &x in &[0.0f32, 0.01, 0.05, 0.3, 1.0, 4.0] {
            let expected = (-(x as f64)).exp() as f32;
            assert!(absf(exp_neg(x) - expected) <= 2e-6 + expected * 2e-5, "exp(-{x}) = {} vs {expected}", exp_neg(x));
        }
    }

    #[test]
    fn handles_are_kind_tagged_and_stale_after_removal() {
        let mut p = Physics::new();
        let w = p.create(ps::KIND_WORLD, &[]);
        assert_eq!(split_handle(w).unwrap().0, ps::KIND_WORLD);
        let b = p.create(ps::KIND_BODY, &[ps::KEY_WORLD as f64, w as f64, ps::KEY_SHAPE as f64, 1.0, ps::KEY_RADIUS as f64, 10.0]);
        assert_eq!(split_handle(b).unwrap().0, ps::KIND_BODY);
        assert_eq!(p.create(ps::KIND_BODY, &[ps::KEY_WORLD as f64, (w + 1) as f64]), 0, "a stale world refuses bodies");
        let mut tree = Tree::new();
        p.destroy(w, &mut tree);
        assert!(p.is_idle());
        assert_eq!(p.query(ps::QUERY_X, b, 0.0, 0.0, 0.0, 0.0), 0.0);
    }

    // -- end to end through Ui ------------------------------------------------

    use crate::Ui;

    fn abs_box(ui: &mut Ui, parent: i32, x: f64, y: f64, w: f64, h: f64) -> i32 {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.set_prop(n, spec::prop::INSET_L, x);
        ui.set_prop(n, spec::prop::INSET_T, y);
        ui.set_prop(n, spec::prop::WIDTH, w);
        ui.set_prop(n, spec::prop::HEIGHT, h);
        ui.insert_before(parent, n, 0);
        n
    }

    fn kv(pairs: &[(u32, f64)]) -> Vec<f64> {
        pairs.iter().flat_map(|&(k, v)| [k as f64, v]).collect()
    }

    fn prop(ui: &Ui, node: i32, prop: u8) -> f32 {
        ui.resolved_style(node).map_or(f32::NAN, |r| f32::from_bits(r.get_bits(prop)))
    }

    fn drain(ui: &mut Ui) -> Vec<[f64; ps::EVENT_WORDS]> {
        let mut out = Vec::new();
        ui.physics_take_events(&mut out);
        out.chunks_exact(ps::EVENT_WORDS).map(|c| c.try_into().unwrap()).collect()
    }

    /// A jelly letter resting at its layout slot, with the homepage's springs.
    fn letter(ui: &mut Ui, world: i32, view: i32, extra: &[(u32, f64)]) -> i32 {
        let mut params = kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_VIEW, view as f64),
            (ps::KEY_SHAPE, ps::SHAPE_BOX as f64),
            (ps::KEY_HALF_WIDTH, 20.0),
            (ps::KEY_HALF_HEIGHT, 24.0),
            (ps::KEY_CORNER, 6.0),
            (ps::KEY_DENSITY, 0.2),
            (ps::KEY_ANCHOR, ps::ANCHOR_LAYOUT as f64),
            (ps::KEY_STIFFNESS, 190.0),
            (ps::KEY_DAMPING, 13.0),
            (ps::KEY_SPIN_STIFFNESS, 230.0),
            (ps::KEY_SPIN_DAMPING, 13.0),
            (ps::KEY_AIR_GRAVITY, 836.0),
            (ps::KEY_SQUASH_STIFFNESS, 540.0),
            (ps::KEY_SQUASH_DAMPING, 12.0),
            (ps::KEY_LAND_GAIN, 0.02),
            (ps::KEY_LAND_MIN, 1.4),
            (ps::KEY_LAND_MAX, 6.4),
            (ps::KEY_LAND_SPIN, 9.0),
            (ps::KEY_STRETCH_GAIN, 0.0007),
            (ps::KEY_PIVOT, 21.0),
        ]);
        params.extend(kv(extra));
        ui.physics_create(ps::KIND_BODY, &params)
    }

    #[test]
    fn layout_anchor_rests_the_view_on_its_slot_and_hops_back() {
        let mut ui = Ui::new();
        let view = abs_box(&mut ui, spec::ROOT_ID, 100.0, 60.0, 64.0, 64.0);
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 2500.0)]));
        let body = letter(&mut ui, world, view, &[]);
        ui.tick();
        assert_eq!(ui.physics_query(ps::QUERY_X, body, 0.0, 0.0, 0.0, 0.0), 132.0, "snapped to the layout centre");
        assert_eq!(prop(&ui, view, spec::prop::TRANSLATE_X), 0.0);
        assert!((prop(&ui, view, spec::prop::ORIGIN_Y) - 21.0 / 64.0).abs() < 1e-6, "pivot at the foot");

        ui.physics_apply(&[body as f64, ps::CMD_HOP as f64, 3.0, 213.0, 4.0, 80.0]);
        ui.tick();
        assert_eq!(ui.physics_query(ps::QUERY_AIRBORNE, body, 0.0, 0.0, 0.0, 0.0), 1.0);
        assert!(prop(&ui, view, spec::prop::TRANSLATE_Y) < 0.0, "rises");
        assert!(prop(&ui, view, spec::prop::SCALE_Y) > 1.0, "stretches on take-off");
        let mut landed = None;
        for frame in 0..90 {
            ui.tick();
            if let Some(e) = drain(&mut ui).into_iter().find(|e| e[0] as u32 == ps::EVENT_LAND) {
                landed = Some((frame, e));
                break;
            }
        }
        let (_, event) = landed.expect("the hop lands");
        assert_eq!(event[1] as i32, body);
        assert!(event[7] > 100.0, "landing speed");
        for _ in 0..240 {
            ui.tick();
        }
        assert!(prop(&ui, view, spec::prop::TRANSLATE_Y).abs() < 0.05);
        assert!((prop(&ui, view, spec::prop::SCALE_Y) - 1.0).abs() < 0.01, "the squash settles");
    }

    #[test]
    fn launch_arrives_at_the_anchor_on_time_and_hands_over_to_the_springs() {
        let mut ui = Ui::new();
        let view = abs_box(&mut ui, spec::ROOT_ID, 100.0, 40.0, 64.0, 64.0);
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[]));
        let body = letter(&mut ui, world, view, &[(ps::KEY_ASLEEP, 1.0), (ps::KEY_X, 200.0), (ps::KEY_Y, 420.0)]);
        for _ in 0..10 {
            ui.tick();
        }
        assert_eq!(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0), 420.0, "parked bodies stay put");
        ui.physics_apply(&[
            body as f64, ps::CMD_LAUNCH as f64, 10.0,
            200.0, 420.0, f64::NAN, f64::NAN, 0.6, 360.0, 10.0, 300.0, 0.3, 0.0,
        ]);
        let mut land_frame = None;
        let mut apex = f64::MAX;
        for frame in 1..=60 {
            ui.tick();
            apex = apex.min(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0));
            if drain(&mut ui).iter().any(|e| e[0] as u32 == ps::EVENT_LAND) {
                land_frame = Some(frame);
                break;
            }
        }
        assert_eq!(land_frame, Some(36), "0.6 s at 60 Hz");
        assert!(apex < 72.0, "the arc overshoots the slot before it drops in");
        assert_eq!(ui.physics_query(ps::QUERY_X, body, 0.0, 0.0, 0.0, 0.0), 132.0);
        assert_eq!(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0), 72.0);
        assert!((ui.physics_query(ps::QUERY_ANGLE, body, 0.0, 0.0, 0.0, 0.0) - 10.0).abs() < 0.01);
        assert_eq!(ui.physics_query(ps::QUERY_MODE, body, 0.0, 0.0, 0.0, 0.0), 1.0);
    }

    fn floor_world(ui: &mut Ui) -> (i32, i32) {
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 2500.0), (ps::KEY_SEED, 7.0)]));
        let floor = ui.physics_create(
            ps::KIND_COLLIDER,
            &kv(&[
                (ps::KEY_WORLD, world as f64),
                (ps::KEY_SHAPE, ps::SHAPE_CHAIN as f64),
                (ps::KEY_RADIUS, 2.0),
                (ps::KEY_POINT_X, 0.0),
                (ps::KEY_POINT_Y, 0.0),
                (ps::KEY_POINT_X, 0.0),
                (ps::KEY_POINT_Y, 200.0),
                (ps::KEY_POINT_X, 480.0),
                (ps::KEY_POINT_Y, 200.0),
                (ps::KEY_POINT_X, 480.0),
                (ps::KEY_POINT_Y, 0.0),
            ]),
        );
        assert!(floor > 0);
        (world, floor)
    }

    fn toy(ui: &mut Ui, world: i32, view: i32, x: f64, y: f64) -> i32 {
        ui.physics_create(
            ps::KIND_BODY,
            &kv(&[
                (ps::KEY_WORLD, world as f64),
                (ps::KEY_VIEW, view as f64),
                (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64),
                (ps::KEY_RADIUS, 20.0),
                (ps::KEY_DENSITY, 0.318),
                (ps::KEY_RESTITUTION, 0.5),
                (ps::KEY_FRICTION, 0.35),
                (ps::KEY_HIT_SPEED, 260.0),
                (ps::KEY_PICKABLE, 1.0),
                (ps::KEY_SQUASH_AXIS, ps::SQUASH_AXIS_IMPACT as f64),
                (ps::KEY_SQUASH_STIFFNESS, 900.0),
                (ps::KEY_SQUASH_DAMPING, 20.0),
                (ps::KEY_SQUASH_X, 0.65),
                (ps::KEY_DENT, 1.0 / 3000.0),
                (ps::KEY_X, x),
                (ps::KEY_Y, y),
            ]),
        )
    }

    #[test]
    fn a_toy_falls_bounces_dents_and_comes_to_rest_on_a_chain_floor() {
        let mut ui = Ui::new();
        let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
        let (world, floor) = floor_world(&mut ui);
        let body = toy(&mut ui, world, view, 240.0, 40.0);
        let mut hits = 0;
        let mut dented = false;
        for _ in 0..240 {
            ui.tick();
            for e in drain(&mut ui) {
                if e[0] as u32 == ps::EVENT_HIT {
                    assert_eq!(e[2] as i32, floor);
                    assert!(e[6] < -0.99, "the floor normal points up");
                    hits += 1;
                }
            }
            let (sx, sy) = (prop(&ui, view, spec::prop::SCALE_X), prop(&ui, view, spec::prop::SCALE_Y));
            dented |= (sx - sy).abs() > 0.05;
        }
        assert!(hits >= 1, "the first impact reports a hit");
        assert!(dented, "impacts squash along the contact normal");
        let y = ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0);
        assert!((y - 178.0).abs() < 0.5, "rests on the floor: {y}");
        assert!(ui.physics_query(ps::QUERY_SPEED, body, 0.0, 0.0, 0.0, 0.0) < 1.0);
        assert!(ui.physics_query(ps::QUERY_GROUNDED, body, 0.0, 0.0, 0.0, 0.0) >= 0.0);
        // the view follows: its layout centre is (20, 20)
        assert!((prop(&ui, view, spec::prop::TRANSLATE_Y) as f64 - (y - 20.0)).abs() < 1e-3);
    }

    #[test]
    fn toys_knock_an_anchored_letter_which_springs_home() {
        let mut ui = Ui::new();
        let slot = abs_box(&mut ui, spec::ROOT_ID, 208.0, 76.0, 64.0, 64.0);
        let ball = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
        let (world, _) = floor_world(&mut ui);
        let body = letter(&mut ui, world, slot, &[(ps::KEY_SQUASH_IMPACT, 0.01), (ps::KEY_LAYER, 2.0), (ps::KEY_MASK, 1.0)]);
        let t = toy(&mut ui, world, ball, 240.0, 10.0);
        let mut disturbed = 0.0f32;
        for _ in 0..180 {
            ui.tick();
            disturbed = disturbed.max(prop(&ui, slot, spec::prop::TRANSLATE_Y).abs());
        }
        assert!(disturbed > 0.5, "the letter gives under the toy: {disturbed}");
        let toy_y = ui.physics_query(ps::QUERY_Y, t, 0.0, 0.0, 0.0, 0.0);
        let sag = prop(&ui, slot, spec::prop::TRANSLATE_Y);
        assert!(toy_y < 100.0, "the toy rests on the letter: {toy_y}");
        assert!(sag > 2.0, "and the letter carries its weight: {sag}");
        ui.physics_destroy(t);
        for _ in 0..600 {
            ui.tick();
        }
        assert_eq!(ui.physics_query(ps::QUERY_MODE, body, 0.0, 0.0, 0.0, 0.0), 1.0);
        assert!(prop(&ui, slot, spec::prop::TRANSLATE_Y).abs() < 0.05, "springs back to its slot");
    }

    #[test]
    fn the_same_commands_give_the_same_bits() {
        let run = || {
            let mut ui = Ui::new();
            let (world, _) = floor_world(&mut ui);
            let mut bodies = Vec::new();
            for k in 0..6 {
                let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
                bodies.push(toy(&mut ui, world, view, 60.0 + 70.0 * k as f64, 30.0 + 11.0 * k as f64));
            }
            ui.physics_apply(&[bodies[0] as f64, ps::CMD_IMPULSE as f64, 3.0, 900.0, -300.0, 720.0]);
            let mut trace = Vec::new();
            for _ in 0..180 {
                ui.tick();
                for &b in &bodies {
                    trace.push(ui.physics_query(ps::QUERY_X, b, 0.0, 0.0, 0.0, 0.0).to_bits());
                    trace.push(ui.physics_query(ps::QUERY_ANGLE, b, 0.0, 0.0, 0.0, 0.0).to_bits());
                }
                let mut events = Vec::new();
                ui.physics_take_events(&mut events);
                trace.extend(events.iter().map(|v| v.to_bits()));
            }
            trace
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn views_on_two_surfaces_share_one_world() {
        let mut ui = Ui::new();
        ui.set_viewport(400.0, 240.0);
        let aux = ui.create_auxiliary_surface(320.0, 240.0);
        let top = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 20.0, 20.0);
        let bottom = abs_box(&mut ui, aux, 0.0, 0.0, 20.0, 20.0);
        let world = ui.physics_create(
            ps::KIND_WORLD,
            &kv(&[(ps::KEY_GRAVITY_Y, 0.0), (ps::KEY_AUXILIARY_X, 40.0), (ps::KEY_AUXILIARY_Y, 296.0)]),
        );
        let body = ui.physics_create(
            ps::KIND_BODY,
            &kv(&[
                (ps::KEY_WORLD, world as f64),
                (ps::KEY_VIEW, top as f64),
                (ps::KEY_VIEW, bottom as f64),
                (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64),
                (ps::KEY_RADIUS, 10.0),
                (ps::KEY_X, 200.0),
                (ps::KEY_Y, 400.0),
                (ps::KEY_PICKABLE, 1.0),
            ]),
        );
        ui.tick();
        assert_eq!(prop(&ui, top, spec::prop::TRANSLATE_Y), 390.0, "below the top screen");
        assert_eq!(prop(&ui, bottom, spec::prop::TRANSLATE_X), 150.0);
        assert_eq!(prop(&ui, bottom, spec::prop::TRANSLATE_Y), 94.0, "inside the bottom screen");
        assert_eq!(ui.physics_query(ps::QUERY_PICK, world, 160.0, 104.0, 1.0, 0.0) as i32, body);
        assert_eq!(ui.physics_query(ps::QUERY_PICK, world, 160.0, 104.0, 0.0, 0.0), 0.0);

        // a stylus carry moves it; release throws it
        ui.physics_apply(&[body as f64, ps::CMD_GRAB as f64, 5.0, 160.0, 104.0, 1.0, ps::GRAB_CARRY as f64, 0.0]);
        for k in 1..=5 {
            ui.physics_apply(&[body as f64, ps::CMD_DRAG as f64, 3.0, 160.0, 104.0 - 8.0 * k as f64, 1.0]);
            ui.tick();
        }
        assert_eq!(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0), 360.0);
        ui.physics_apply(&[body as f64, ps::CMD_RELEASE as f64, 0.0]);
        assert!(ui.physics_query(ps::QUERY_VY, body, 0.0, 0.0, 0.0, 0.0) < -300.0, "thrown upward");
    }

    #[test]
    fn zones_report_enter_and_leave() {
        let mut ui = Ui::new();
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
        let zone = ui.physics_create(
            ps::KIND_ZONE,
            &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_BOX as f64), (ps::KEY_X, 100.0), (ps::KEY_Y, 100.0), (ps::KEY_HALF_WIDTH, 20.0), (ps::KEY_HALF_HEIGHT, 20.0)]),
        );
        let body = ui.physics_create(
            ps::KIND_BODY,
            &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64), (ps::KEY_RADIUS, 5.0), (ps::KEY_X, 40.0), (ps::KEY_Y, 100.0), (ps::KEY_VX, 1200.0), (ps::KEY_LINEAR_DAMPING, 0.0)]),
        );
        let mut seen = Vec::new();
        for _ in 0..12 {
            ui.tick();
            for e in drain(&mut ui) {
                assert_eq!(e[1] as i32, zone);
                assert_eq!(e[2] as i32, body);
                seen.push(e[0] as u32);
            }
        }
        assert_eq!(seen, [ps::EVENT_ENTER, ps::EVENT_LEAVE]);
    }

    #[test]
    fn an_emitter_bursts_into_its_pool_and_hides_spent_particles() {
        let mut ui = Ui::new();
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[]));
        let mut params = kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_LIFE_MIN, 0.2), (ps::KEY_LIFE_MAX, 0.3), (ps::KEY_SCALE_CURVE, ps::SCALE_CURVE_POP as f64)]);
        let mut pool = Vec::new();
        for _ in 0..6 {
            let node = ui.create_node(2);
            ui.set_prop(node, spec::prop::WIDTH, 8.0);
            ui.set_prop(node, spec::prop::HEIGHT, 8.0);
            ui.set_prop(node, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
            ui.insert_before(spec::ROOT_ID, node, 0);
            params.extend([ps::KEY_VIEW as f64, node as f64]);
            pool.push(node);
        }
        let emitter = ui.physics_create(ps::KIND_EMITTER, &params);
        ui.tick();
        assert!(pool.iter().all(|&n| prop(&ui, n, spec::prop::OPACITY) == 0.0), "an idle pool is invisible");
        ui.physics_apply(&[emitter as f64, ps::CMD_BURST as f64, 6.0, 100.0, 100.0, 4.0, 0.0, 360.0, 1.0]);
        ui.tick();
        assert_eq!(ui.physics_query(ps::QUERY_PARTICLES, emitter, 0.0, 0.0, 0.0, 0.0), 4.0);
        assert_eq!(pool.iter().filter(|&&n| prop(&ui, n, spec::prop::OPACITY) > 0.0).count(), 4);
        for _ in 0..30 {
            ui.tick();
        }
        assert_eq!(ui.physics_query(ps::QUERY_PARTICLES, emitter, 0.0, 0.0, 0.0, 0.0), 0.0);
        ui.physics_destroy(emitter);
        assert!(pool.iter().all(|&n| prop(&ui, n, spec::prop::OPACITY) == 1.0), "destroy hands the views back");
    }

    #[test]
    fn a_collider_owner_absorbs_impacts_as_wobble() {
        let mut ui = Ui::new();
        let (world, _) = floor_world(&mut ui);
        let pocket = ui.physics_create(
            ps::KIND_BODY,
            &kv(&[
                (ps::KEY_WORLD, world as f64),
                (ps::KEY_MASS, 0.0),
                (ps::KEY_ANCHOR, ps::ANCHOR_POINT as f64),
                (ps::KEY_ANCHOR_X, 240.0),
                (ps::KEY_ANCHOR_Y, 190.0),
                (ps::KEY_SPIN_STIFFNESS, 170.0),
                (ps::KEY_SPIN_DAMPING, 5.0),
                (ps::KEY_SQUASH_STIFFNESS, 560.0),
                (ps::KEY_SQUASH_DAMPING, 15.0),
                (ps::KEY_SQUASH_LIMIT, 2.0),
            ]),
        );
        ui.physics_create(
            ps::KIND_COLLIDER,
            &kv(&[
                (ps::KEY_WORLD, world as f64),
                (ps::KEY_SHAPE, ps::SHAPE_BOX as f64),
                (ps::KEY_X, 240.0),
                (ps::KEY_Y, 170.0),
                (ps::KEY_HALF_WIDTH, 50.0),
                (ps::KEY_HALF_HEIGHT, 20.0),
                (ps::KEY_OWNER, pocket as f64),
                (ps::KEY_OWNER_SQUASH, 1.0 / 900.0),
                (ps::KEY_OWNER_SPIN, 20.0 / 2600.0 * 57.3),
            ]),
        );
        let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
        toy(&mut ui, world, view, 270.0, 20.0);
        let mut max_spin = 0.0f64;
        for _ in 0..60 {
            ui.tick();
            max_spin = max_spin.max(ui.physics_query(ps::QUERY_ANGLE, pocket, 0.0, 0.0, 0.0, 0.0).abs());
        }
        assert!(max_spin > 0.1, "a hit off-centre tips the owner: {max_spin}");
        assert_eq!(ui.physics_query(ps::QUERY_X, pocket, 0.0, 0.0, 0.0, 0.0), 240.0, "an immovable owner stays put");
    }
}
