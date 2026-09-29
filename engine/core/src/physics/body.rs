//! Bodies: parameters, integration, anchors, flights, grabs, jelly and the
//! pose written to views.

use crate::fmath::{absf, atan2f, clampf, cosf, exp_neg, lerpf, maxf, minf, sinf, sqrtf, tanf, wrap_angle, DEG, PI};
use crate::spec::physics as ps;

use super::{f, id, pairs, rand01, Events, View, World, V2};

/// Tether: rate at which the grab point closes its error, 1/s.
const TETHER_RATE: f32 = 28.8;
/// Tether: acceleration limit at strength 1, px/s².
const TETHER_FORCE: f32 = 40_000.0;
/// Tether: spin damping while held, 1/s.
const TETHER_SPIN_DAMPING: f32 = 4.3;
/// Tether: the grab point sits at this fraction of the offset from the centre.
const TETHER_REACH: f32 = 0.75;
/// Launch: seconds the view scale takes to grow, and the grow's overshoot.
const GROW_SECONDS: f32 = 0.2;
const GROW_OVERSHOOT: f32 = 1.9;
/// Launch: fraction of stretchGain applied in flight.
const FLIGHT_STRETCH: f32 = 0.4;
/// Launch arrival on an anchor: velocity and spin handed over, and the
/// fraction of `arrive` the landing kick uses.
const ARRIVE_VX: f32 = 0.1;
const ARRIVE_VY: f32 = 0.3;
const ARRIVE_SPIN: f32 = 0.12;
const ARRIVE_LAND: f32 = 0.85;
/// Hop landing rebound.
const HOP_REBOUND: f32 = 0.08;
/// Carried release onto an anchor: landing distance and speed, in body sizes.
const ARMED_DISTANCE: f32 = 0.05;
const ARMED_SPEED: f32 = 0.6;
const ARMED_SETTLE_SPEED: f32 = 0.4;
const ARMED_SETTLE_DISTANCE: f32 = 0.02;

#[derive(Clone, Copy)]
pub(super) enum Shape {
    None,
    Circle { r: f32 },
    Box { hw: f32, hh: f32, rc: f32 },
}

/// Secondary motion: squash, lean and pulse springs.
#[derive(Clone, Copy, Default)]
pub(super) struct Jelly {
    pub(super) q: f32,
    pub(super) vq: f32,
    k: f32,
    c: f32,
    limit: f32,
    gain_x: f32,
    gain_y: f32,
    impact_axis: bool,
    /// World angle of the squash axis in impact mode.
    pub(super) axis: f32,
    pub(super) impact: f32,
    pub(super) dent: f32,
    pub(super) dent_limit: f32,
    land_gain: f32,
    land_min: f32,
    land_max: f32,
    land_spin: f32,
    pub(super) lean: f32,
    pub(super) vlean: f32,
    lean_k: f32,
    lean_c: f32,
    lean_gain: f32,
    lean_limit: f32,
    pub(super) lean_impact: f32,
    pub(super) pulse: f32,
    vpulse: f32,
    pulse_k: f32,
    pulse_c: f32,
    pub(super) press_q: f32,
    pub(super) press_pulse: f32,
    stretch_gain: f32,
    stretch_limit: f32,
    pub(super) pivot: f32,
    /// Contact speed below which contacts leave the jelly alone.
    pub(super) min_speed: f32,
}

impl Jelly {
    pub(super) fn impact_axis(&self) -> bool {
        self.impact_axis
    }
}

#[derive(Clone, Copy)]
pub(super) struct Flight {
    t: f32,
    duration: f32,
    from: V2,
    to: V2,
    turn: f32,
    end_offset: f32,
    arrive: f32,
    grow: f32,
    end_scale: f32,
    pub(super) solid: bool,
    solved: bool,
    v0: V2,
    g: f32,
    r0: f32,
    vr: f32,
}

impl Flight {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(from: V2, to: V2, duration: f32, turn: f32, end_offset: f32, arrive: f32, grow: f32, end_scale: f32, solid: bool) -> Flight {
        Flight {
            t: 0.0,
            duration: maxf(1.0 / 240.0, duration),
            from,
            to,
            turn,
            end_offset,
            arrive,
            grow,
            end_scale,
            solid,
            solved: false,
            v0: V2::ZERO,
            g: 0.0,
            r0: 0.0,
            vr: 0.0,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Grab {
    pub(super) mode: u32,
    /// Tether: grabbed point in the body frame. Carry: world offset from the
    /// pointer to the body centre.
    local: V2,
    pub(super) target: V2,
    pub(super) prev: V2,
    pub(super) vel: V2,
    strength: f32,
}

/// Collision pose cached once per substep: rotation, jelly scale and pivot
/// do not change while contacts resolve, only the position does.
#[derive(Clone, Copy)]
pub(super) struct PoseCache {
    /// Shape centre relative to `p`.
    pub(super) offset: V2,
    pub(super) sin: f32,
    pub(super) cos: f32,
    pub(super) shape: Shape,
    pub(super) radius: f32,
}

/// Pose written to a body's views.
pub(super) struct Pose {
    pub(super) rotate: f32,
    pub(super) skew: f32,
    pub(super) sx: f32,
    pub(super) sy: f32,
}

pub(super) struct Body {
    pub(super) world: usize,
    pub(super) cache: PoseCache,
    views: [View; ps::MAX_VIEWS],
    view_count: usize,
    pub(super) shape: Shape,
    pub(super) inv_mass: f32,
    pub(super) inv_inertia: f32,
    pub(super) restitution: f32,
    pub(super) friction: f32,
    pub(super) bounce_speed: f32,
    pub(super) hit_speed: f32,
    gravity_scale: f32,
    linear_damping: f32,
    angular_damping: f32,
    max_spin: f32,
    pub(super) layer: u32,
    pub(super) mask: u32,
    pub(super) pickable: bool,
    pub(super) ghost: i32,
    pub(super) asleep: bool,
    pub(super) p: V2,
    pub(super) v: V2,
    pub(super) a: f32,
    pub(super) w: f32,
    pub(super) order: u32,
    pub(super) anchor: u32,
    anchor_angle: f32,
    anchor_axes: u32,
    anchor_free: bool,
    /// Snap to the home the first time it is known (no initial position given).
    snap_home: bool,
    home: V2,
    home_known: bool,
    stiffness: f32,
    damping: f32,
    spin_stiffness: f32,
    spin_damping: f32,
    air_gravity: f32,
    pub(super) airborne: bool,
    armed: bool,
    pub(super) jelly: Jelly,
    flight: Option<Flight>,
    pub(super) grab: Option<Grab>,
    /// View scale from a launch grow / end scale.
    grow: f32,
    pub(super) settle: Option<(f32, f32)>,
    /// World substep of the last floor-like collider contact.
    pub(super) ground_step: Option<u64>,
    /// World substep of the last hit event.
    pub(super) hit_step: Option<u64>,
}

impl Body {
    pub(super) fn new(world: usize, params: &[f64]) -> Body {
        let mut b = Body {
            world,
            cache: PoseCache { offset: V2::ZERO, sin: 0.0, cos: 1.0, shape: Shape::None, radius: 0.0 },
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
            anchor_angle: 0.0,
            anchor_axes: ps::AXIS_X | ps::AXIS_Y | ps::AXIS_ANGLE,
            anchor_free: false,
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
                axis: -PI / 2.0,
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
            ground_step: None,
            hit_step: None,
        };
        let (mut radius, mut hw, mut hh, mut corner) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        let mut shape = ps::SHAPE_NONE;
        let (mut density, mut mass, mut inertia) = (1.0f32, -1.0f32, 1.0f32);
        let mut anchor_point = V2::ZERO;
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
                ps::KEY_ANCHOR_X => anchor_point.x = x,
                ps::KEY_ANCHOR_Y => anchor_point.y = x,
                ps::KEY_ANCHOR_ANGLE => b.anchor_angle = x * DEG,
                ps::KEY_ANCHOR_AXES => b.anchor_axes = v as u32,
                ps::KEY_ANCHOR_FREE => b.anchor_free = v != 0.0,
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
                ps::KEY_LEAN_IMPACT => b.jelly.lean_impact = maxf(0.0, x) * DEG,
                ps::KEY_PULSE_STIFFNESS => b.jelly.pulse_k = maxf(0.0, x),
                ps::KEY_PULSE_DAMPING => b.jelly.pulse_c = maxf(0.0, x),
                ps::KEY_STRETCH_GAIN => b.jelly.stretch_gain = maxf(0.0, x),
                ps::KEY_STRETCH_LIMIT => b.jelly.stretch_limit = maxf(0.0, x),
                ps::KEY_PIVOT => b.jelly.pivot = x,
                ps::KEY_JELLY_SPEED => b.jelly.min_speed = maxf(0.0, x),
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
            b.set_home(anchor_point);
        }
        b
    }

    pub(super) fn views(&self) -> &[View] {
        &self.views[..self.view_count]
    }

    /// Record the anchor's rest position; the first one places a body that
    /// was created without a position.
    pub(super) fn set_home(&mut self, home: V2) {
        self.home = home;
        self.home_known = true;
        if self.snap_home {
            self.p = home;
            self.a = self.anchor_angle;
            self.snap_home = false;
        }
    }

    /// The rest position, once known.
    pub(super) fn rest(&self) -> Option<V2> {
        (self.anchor != ps::ANCHOR_NONE && self.home_known).then_some(self.home)
    }

    pub(super) fn mode(&self) -> u32 {
        if self.grab.is_some() {
            ps::MODE_GRABBED
        } else if self.flight.is_some() {
            ps::MODE_FLIGHT
        } else if self.anchor != ps::ANCHOR_NONE {
            ps::MODE_ANCHORED
        } else {
            ps::MODE_FREE
        }
    }

    fn anchored(&self, axis: u32) -> bool {
        self.anchor != ps::ANCHOR_NONE && self.home_known && self.anchor_axes & axis != 0
    }

    fn anchored_in_position(&self) -> bool {
        self.anchor != ps::ANCHOR_NONE && self.anchor_axes & (ps::AXIS_X | ps::AXIS_Y) != 0
    }

    pub(super) fn is_carried(&self) -> bool {
        matches!(self.grab, Some(Grab { mode: ps::GRAB_CARRY, .. }))
    }

    pub(super) fn in_flight(&self) -> bool {
        self.flight.is_some()
    }

    /// A flying body obstructs free bodies only when launched `solid`.
    pub(super) fn solid(&self) -> bool {
        self.flight.is_none_or(|fl| fl.solid)
    }

    /// Bodies that move under their own dynamics meet colliders.
    pub(super) fn takes_static_contacts(&self) -> bool {
        self.flight.is_none() && self.inv_mass > 0.0 && !self.is_carried() && !matches!(self.shape, Shape::None)
    }

    // -- commands ---------------------------------------------------------------

    pub(super) fn teleport(&mut self, p: V2, angle: f32) {
        self.asleep = false;
        self.p = p;
        if !angle.is_nan() {
            self.a = angle;
        }
        self.v = V2::ZERO;
        self.w = 0.0;
        self.flight = None;
        self.airborne = false;
        self.armed = false;
        self.snap_home = false;
    }

    pub(super) fn launch(&mut self, flight: Flight) {
        self.asleep = false;
        self.snap_home = false;
        self.grab = None;
        self.airborne = false;
        self.armed = false;
        self.p = flight.from;
        self.grow = if flight.grow > 0.0 { flight.grow } else { 1.0 };
        self.jelly.q = 0.0;
        self.jelly.vq = 0.0;
        self.jelly.lean = 0.0;
        self.jelly.vlean = 0.0;
        self.flight = Some(flight);
    }

    pub(super) fn hop(&mut self, up: f32, stretch: f32, spin: f32) {
        if !(self.anchored(ps::AXIS_Y) && self.flight.is_none() && self.grab.is_none()) {
            return;
        }
        self.asleep = false;
        self.airborne = true;
        self.armed = false;
        self.v.y = minf(self.v.y, 0.0) - up;
        self.jelly.vq -= stretch;
        let toward = if wrap_angle(self.a - self.anchor_angle) > 0.0 { -1.0 } else { 1.0 };
        self.w += toward * spin;
    }

    pub(super) fn kick(&mut self, squash: f32, lean: f32, spin: f32, pulse: f32) {
        if squash != 0.0 && self.jelly.impact_axis {
            self.jelly.axis = -PI / 2.0;
        }
        self.jelly.vq += squash;
        self.jelly.vlean += lean;
        self.w += spin;
        self.jelly.vpulse += pulse;
    }

    pub(super) fn grab(&mut self, target: V2, mode: u32, strength: f32) {
        self.asleep = false;
        self.flight = None;
        self.airborne = false;
        self.armed = false;
        let local = if mode == ps::GRAB_CARRY {
            self.p.sub(target)
        } else {
            target.sub(self.p).rot(sinf(-self.a), cosf(-self.a)).mul(TETHER_REACH)
        };
        self.grab = Some(Grab { mode, local, target, prev: target, vel: V2::ZERO, strength });
    }

    pub(super) fn release(&mut self) {
        if let Some(g) = self.grab.take() {
            if g.mode == ps::GRAB_CARRY {
                self.v = g.vel;
                if self.anchored_in_position() {
                    self.armed = true;
                }
            }
        }
    }

    pub(super) fn set_anchor(&mut self, point: V2, angle: f32) {
        self.anchor = ps::ANCHOR_POINT;
        if !angle.is_nan() {
            self.anchor_angle = angle;
        }
        self.home = point;
        self.home_known = true;
    }

    // -- integration --------------------------------------------------------------

    fn size_unit(&self) -> f32 {
        match self.shape {
            Shape::Circle { r } => 2.0 * r,
            Shape::Box { hw, hh, .. } => 2.0 * maxf(hw, hh),
            Shape::None => 64.0,
        }
    }

    /// Not grabbed and no floor contact for `rest_steps` substeps.
    fn is_free(&self, now: u64, rest_steps: u64) -> bool {
        self.grab.is_none() && self.ground_step.is_none_or(|step| now - step > rest_steps)
    }

    pub(super) fn land(&mut self, speed: f32, rng: &mut u32) {
        let j = &mut self.jelly;
        if j.land_gain > 0.0 {
            let kick = clampf(speed * j.land_gain, j.land_min, maxf(j.land_min, j.land_max));
            j.vq += kick;
            let sign = if rand01(rng) < 0.5 { -1.0 } else { 1.0 };
            self.w += sign * kick * j.land_spin;
        }
    }

    pub(super) fn integrate(&mut self, world: &mut World, h: f32, rest_steps: u64, handle: i32, events: &mut Events) {
        if let Some(mut fl) = self.flight {
            self.fly(&mut fl, world, h, handle, events);
            return;
        }
        let springs = !self.anchor_free || self.is_free(world.step, rest_steps);
        if self.is_carried() {
            let g = self.grab.unwrap();
            let next = g.target.add(g.local);
            self.v = next.sub(self.p).mul(1.0 / h);
            self.p = next;
        } else if self.inv_mass > 0.0 || self.anchor != ps::ANCHOR_NONE {
            let home = self.home;
            if springs && self.anchored(ps::AXIS_X) && self.stiffness > 0.0 {
                self.v.x += (self.stiffness * (home.x - self.p.x) - self.damping * self.v.x) * h;
            } else if self.inv_mass > 0.0 {
                self.v.x += world.gravity.x * self.gravity_scale * h;
            }
            if self.airborne {
                self.v.y += self.air_gravity * h;
            } else if springs && self.anchored(ps::AXIS_Y) && self.stiffness > 0.0 {
                self.v.y += (self.stiffness * (home.y - self.p.y) - self.damping * self.v.y) * h;
            } else if self.inv_mass > 0.0 {
                self.v.y += world.gravity.y * self.gravity_scale * h;
            }
            if let Some(g) = self.grab {
                self.tether(&g, h);
            }
            self.v = self.v.mul(exp_neg(self.linear_damping * h));
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
                self.v.y = -speed * HOP_REBOUND;
                events.push(ps::EVENT_LAND, handle, 0, self.p.x, self.p.y, 0.0, -1.0, speed);
            }
            if self.armed {
                let unit = self.size_unit();
                let dist = self.p.sub(home).len();
                let speed = self.v.len();
                if dist < unit * ARMED_DISTANCE && speed > unit * ARMED_SPEED {
                    self.armed = false;
                    self.land(speed, &mut world.rng);
                } else if speed < unit * ARMED_SETTLE_SPEED && dist < unit * ARMED_SETTLE_DISTANCE {
                    self.armed = false;
                }
            }
        }
        if springs && self.anchored(ps::AXIS_ANGLE) && self.spin_stiffness > 0.0 {
            self.w += (self.spin_stiffness * wrap_angle(self.anchor_angle - self.a) - self.spin_damping * self.w) * h;
        }
        self.w = clampf(self.w * exp_neg(self.angular_damping * h), -self.max_spin, self.max_spin);
        self.a += self.w * h;
        self.step_jelly(h);
    }

    fn step_jelly(&mut self, h: f32) {
        let airborne = self.airborne;
        let (vx, vy) = (self.v.x, self.v.y);
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

    /// Soft pointer joint: drive the grabbed point's velocity toward closing
    /// its error at TETHER_RATE, bounded by a force limit.
    fn tether(&mut self, g: &Grab, h: f32) {
        if self.inv_mass == 0.0 {
            return;
        }
        let (s, c) = (sinf(self.a), cosf(self.a));
        let r = g.local.rot(s, c);
        let err = g.target.sub(self.p.add(r));
        let bias = err.mul(TETHER_RATE);
        let va = self.v.add(V2::spin(self.w, r));
        let (im, ii) = (self.inv_mass, self.inv_inertia);
        let k11 = im + ii * r.y * r.y;
        let k12 = -ii * r.x * r.y;
        let k22 = im + ii * r.x * r.x;
        let det = k11 * k22 - k12 * k12;
        if !(det > 0.0) {
            return;
        }
        let dv = bias.sub(va);
        let mut j = V2::new((k22 * dv.x - k12 * dv.y) / det, (-k12 * dv.x + k11 * dv.y) / det);
        let max_j = TETHER_FORCE * g.strength * h / im;
        let jl = j.len();
        if jl > max_j {
            j = j.mul(max_j / jl);
        }
        self.v = self.v.add(j.mul(im));
        self.w += ii * r.cross(j);
        self.w *= exp_neg(TETHER_SPIN_DAMPING * h);
    }

    fn fly(&mut self, fl: &mut Flight, world: &mut World, h: f32, handle: i32, events: &mut Events) {
        if !fl.solved {
            let rest = if self.home_known { Some(self.home) } else { None };
            let x = if fl.to.x.is_nan() { rest.map_or(fl.from.x, |p| p.x) } else { fl.to.x };
            let y = if fl.to.y.is_nan() { rest.map_or(fl.from.y, |p| p.y) } else { fl.to.y };
            fl.to = V2::new(x, y);
            let d = fl.to.sub(fl.from);
            let tf = fl.duration;
            fl.g = 2.0 * (fl.arrive - d.y / tf) / tf;
            fl.v0 = V2::new(d.x / tf, d.y / tf - fl.g * tf * 0.5);
            // a body resting in position turns to its rest angle; any other
            // turns from where it is
            let (r0, r1) = if self.anchored_in_position() {
                let r1 = self.anchor_angle + fl.end_offset;
                (r1 - fl.turn, r1)
            } else {
                (self.a, self.a + fl.turn + fl.end_offset)
            };
            fl.r0 = r0;
            fl.vr = (r1 - r0) / tf;
            fl.solved = true;
        }
        fl.t += h;
        let t = fl.t;
        // accumulated substeps land a hair short of the duration in f32
        if t >= fl.duration - h * 0.25 {
            self.flight = None;
            self.grow = fl.end_scale;
            self.jelly.q = 0.0;
            self.jelly.vq = 0.0;
            self.p = fl.to;
            let end_angle = fl.r0 + fl.vr * fl.duration;
            let speed = if self.anchored_in_position() {
                self.v = V2::new(fl.v0.x * ARRIVE_VX, fl.arrive * ARRIVE_VY);
                self.a = self.anchor_angle + wrap_angle(end_angle - self.anchor_angle);
                self.w = fl.vr * ARRIVE_SPIN;
                let speed = fl.arrive * ARRIVE_LAND;
                self.land(speed, &mut world.rng);
                speed
            } else {
                self.v = V2::new(fl.v0.x, fl.v0.y + fl.g * fl.duration);
                self.a = end_angle;
                self.w = fl.vr;
                self.v.len()
            };
            events.push(ps::EVENT_LAND, handle, 0, self.p.x, self.p.y, 0.0, -1.0, speed);
            return;
        }
        self.p = V2::new(fl.from.x + fl.v0.x * t, fl.from.y + fl.v0.y * t + 0.5 * fl.g * t * t);
        self.v = V2::new(fl.v0.x, fl.v0.y + fl.g * t);
        self.a = fl.r0 + fl.vr * t;
        self.w = fl.vr;
        let grow = if fl.grow > 0.0 && t < GROW_SECONDS { fl.grow + (1.0 - fl.grow) * back_out(t / GROW_SECONDS) } else { 1.0 };
        self.grow = grow * lerpf(1.0, fl.end_scale, t / fl.duration);
        self.jelly.q = -minf(self.jelly.stretch_limit, self.v.len() * self.jelly.stretch_gain * FLIGHT_STRETCH);
        self.flight = Some(*fl);
    }

    // -- geometry ---------------------------------------------------------------

    /// Jelly scale factors along the body's own axes (body-axis squash).
    fn body_scale(&self) -> (f32, f32) {
        let s = self.jelly.pulse * self.grow;
        if self.jelly.impact_axis {
            (s, s)
        } else {
            (s * (1.0 + self.jelly.q * self.jelly.gain_x), s * (1.0 - self.jelly.q * self.jelly.gain_y))
        }
    }

    /// Collision frame: (centre, angle, shape scaled by the pose). A pivoted
    /// body turns and squashes about its foot, so the centre of its shape
    /// moves with the pose.
    fn frame(&self) -> (V2, f32, Shape) {
        let (sx, sy) = self.body_scale();
        let shape = match self.shape {
            Shape::Box { hw, hh, rc } => Shape::Box { hw: hw * sx, hh: hh * sy, rc: rc * minf(sx, sy) },
            Shape::Circle { r } => Shape::Circle { r: r * minf(sx, sy) },
            Shape::None => Shape::None,
        };
        let pivot = self.jelly.pivot;
        if pivot == 0.0 {
            return (self.p, self.a, shape);
        }
        // pivot + M·(0, -pivot), M = R(a)·skewX(lean)·diag(sx, sy)
        let (s, c) = (sinf(self.a), cosf(self.a));
        let t = if self.jelly.lean == 0.0 { 0.0 } else { tanf(self.jelly.lean) };
        let column = V2::new(c * t * sy - s * sy, s * t * sy + c * sy);
        let foot = self.p.add(V2::new(0.0, pivot));
        (foot.sub(column.mul(pivot)), self.a, shape)
    }

    pub(super) fn refresh_cache(&mut self) {
        let (c, a, shape) = self.frame();
        let radius = match shape {
            Shape::Circle { r } => r,
            Shape::Box { hw, hh, .. } => sqrtf(hw * hw + hh * hh),
            Shape::None => 0.0,
        };
        self.cache = PoseCache { offset: c.sub(self.p), sin: sinf(a), cos: cosf(a), shape, radius };
    }

    /// Shape centre from the substep cache and the current position.
    #[inline]
    pub(super) fn centre(&self) -> V2 {
        self.p.add(self.cache.offset)
    }

    /// Sample circles as (offset from `p`, radius), from the cache: one for a
    /// circle, eight for a box (corners and edge midpoints of the box shrunk
    /// by the sample radius, the corner radius or a fifth of the short side).
    pub(super) fn sample_offsets(&self, out: &mut [(V2, f32); 8]) -> usize {
        let (s, co) = (self.cache.sin, self.cache.cos);
        match self.cache.shape {
            Shape::Circle { r } => {
                out[0] = (self.cache.offset, r);
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
                    *slot = (self.cache.offset.add(l.rot(s, co)), rr);
                }
                8
            }
            Shape::None => 0,
        }
    }

    /// Bounds of the cached shape overlap an axis-aligned rect.
    pub(super) fn overlaps(&self, lo: V2, hi: V2) -> bool {
        let c = self.centre();
        let r = self.cache.radius;
        !(c.x + r < lo.x || c.x - r > hi.x || c.y + r < lo.y || c.y - r > hi.y)
    }

    /// Whether a world point lies within `slop` of the body's shape.
    pub(super) fn contains(&self, point: V2, slop: f32) -> bool {
        let (c, angle, shape) = self.frame();
        let d = point.sub(c);
        match shape {
            Shape::Circle { r } => d.len2() < (r + slop) * (r + slop),
            Shape::Box { hw, hh, .. } => {
                let l = d.rot(sinf(-angle), cosf(-angle));
                absf(l.x) < hw + slop && absf(l.y) < hh + slop
            }
            Shape::None => false,
        }
    }

    /// Poses written to views. Body-axis squash maps onto rotate/skewX/scale
    /// directly; an impact-axis squash is a world-space deformation composed
    /// with the rotation and decomposed as R(θ)·skewX(φ)·diag(sx, sy).
    pub(super) fn pose(&self) -> Pose {
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
}

/// Overshooting ease-out for the launch grow.
fn back_out(t: f32) -> f32 {
    let t = t - 1.0;
    1.0 + t * t * ((GROW_OVERSHOOT + 1.0) * t + GROW_OVERSHOOT)
}
