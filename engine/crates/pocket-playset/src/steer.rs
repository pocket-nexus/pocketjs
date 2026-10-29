//! Behaviours as data: a few states, each a weighted sum of steering terms
//! with a speed, a boost, a fire range and an optional FWD intent, and
//! transitions on conditions.
//!
//! The guest composes a behaviour once (`brain.*` in the TS SDK are presets
//! built from these parts); every step evaluates it per slot with no guest
//! code. Nothing here knows a game: the terms are vector arithmetic, the
//! conditions compare distances, times and hit points.
//!
//! Layout (PLAYSET_BEHAVIOUR): HEADER floats, then STATES states of
//! BEHAVIOUR_STATE_LENGTH floats. A state: its head (PLAYSET_BEHAVIOUR_STATE),
//! TERMS terms of TERM_LEN (kind, weight, a, b, c, d), then TRANSITIONS of
//! TRANSITION_LEN (condition, value, next state).

use crate::fmath::*;
use crate::schema::{behaviour as L, behaviour_state as H, steer as term, steer_when as cond, BEHAVIOUR_LENGTH, BEHAVIOUR_STATE_LENGTH};
use crate::vec::*;

/// What a behaviour reads about its slot and target this step.
pub struct Input {
    pub pos: Vec3,
    pub yaw: f32,
    pub home: Vec3,
    pub ground: f32,
    pub hp_frac: f32,
    /// the target's position and velocity
    pub target: Option<(Vec3, Vec3)>,
    pub time: f32,
    /// a per-slot phase for WEAVE
    pub phase: f32,
    pub dt: f32,
}

/// What it asks for: a wanted direction (length = speed fraction), boost,
/// where to fire, where to face, and whether its state steers at all.
#[derive(Debug, Default, Clone, Copy)]
pub struct Output {
    pub want: Vec3,
    pub boost: bool,
    pub fire_range: f32,
    pub fire_cone: f32,
    pub face: Option<Vec3>,
    pub fwd: Option<f32>,
    /// false for a state without terms: the brain leaves the movement
    /// intents alone (a turret's)
    pub drives: bool,
}

/// Per-slot state, kept in the slot's brain floats 1..8.
#[derive(Clone, Copy, Default)]
pub struct Memory {
    pub state: u8,
    pub time: f32,
    pub wander: f32,
    pub wander_timer: f32,
    pub side: f32,
    pub side_timer: f32,
    pub idle: bool,
}

impl Memory {
    pub fn load(b: &[f32]) -> Memory {
        Memory { state: b[0] as u8, time: b[1], wander: b[2], wander_timer: b[3], side: b[4], side_timer: b[5], idle: b[6] > 0.5 }
    }
    pub fn store(&self, b: &mut [f32]) {
        b[0] = self.state as f32;
        b[1] = self.time;
        b[2] = self.wander;
        b[3] = self.wander_timer;
        b[4] = self.side;
        b[5] = self.side_timer;
        b[6] = if self.idle { 1.0 } else { 0.0 };
    }
}

fn state(d: &[f32], s: usize) -> &[f32] {
    let at = L::HEADER + s.min(L::STATES - 1) * BEHAVIOUR_STATE_LENGTH;
    &d[at..at + BEHAVIOUR_STATE_LENGTH]
}

/// Evaluate one step; transitions apply before the terms of the state they
/// land in.
pub fn evaluate(d: &[f32], m: &mut Memory, i: &Input, rng: &mut Rng) -> Output {
    if d.len() < BEHAVIOUR_LENGTH {
        return Output::default();
    }
    m.time += i.dt;
    let dist = i.target.map(|(p, _)| (p - i.pos).len());
    let st = state(d, m.state as usize);
    for t in 0..L::TRANSITIONS {
        let at = L::STATE_HEAD + L::TERMS * L::TERM_LEN + t * L::TRANSITION_LEN;
        let (c, value, next) = (st[at] as u32, st[at + 1], st[at + 2] as usize);
        let fire = match c {
            cond::NEAR => dist.is_some_and(|x| x <= value),
            cond::FAR => dist.is_none_or(|x| x > value),
            cond::AFTER => m.time >= value,
            cond::HURT => i.hp_frac < value,
            cond::NO_TARGET => i.target.is_none(),
            cond::CHANCE => rng.next() < value * i.dt,
            cond::TARGET => i.target.is_some(),
            _ => false,
        };
        if fire && next < L::STATES {
            m.state = next as u8;
            m.time = 0.0;
            break;
        }
    }
    let st = state(d, m.state as usize);
    let mut want = Vec3::ZERO;
    let mut face = None;
    let mut drives = false;
    for k in 0..L::TERMS {
        let at = L::STATE_HEAD + k * L::TERM_LEN;
        let (kind, weight, a, b, c, dd) = (st[at] as u32, st[at + 1], st[at + 2], st[at + 3], st[at + 4], st[at + 5]);
        if kind == term::NONE {
            continue;
        }
        drives = true;
        if weight == 0.0 {
            continue;
        }
        let v = match kind {
            term::SEEK | term::LEAD => match i.target {
                Some((tp, tv)) => {
                    let aim = if kind == term::LEAD { tp + tv * a } else { tp };
                    let delta = aim - i.pos;
                    let flat = delta.flat().len();
                    face = Some(aim);
                    let slow = if kind == term::LEAD {
                        1.0
                    } else if a > 0.0 {
                        clampf((flat - b) / a, 0.0, 1.0)
                    } else if flat > b {
                        1.0
                    } else {
                        0.0
                    };
                    delta.normalized() * slow
                }
                None => Vec3::ZERO,
            },
            term::FLEE => match i.target {
                Some((tp, _)) => (i.pos - tp).normalized(),
                None => Vec3::ZERO,
            },
            term::ORBIT => match i.target {
                Some((tp, _)) => {
                    if m.side == 0.0 {
                        m.side = if b < 0.0 { -1.0 } else { 1.0 };
                    }
                    if c > 0.0 {
                        m.side_timer -= i.dt;
                        if m.side_timer <= 0.0 {
                            m.side_timer = c * (0.6 + rng.next() * 0.8);
                            m.side = if rng.next() < 0.5 { -1.0 } else { 1.0 };
                        }
                    }
                    let to = (tp - i.pos).flat();
                    let dist = to.len();
                    let radial = to.normalized();
                    let tangent = v3(-radial.z, 0.0, radial.x) * m.side;
                    let correction = clampf((dist - a) / maxf(a * 0.5, 1.0), -1.0, 1.0);
                    face = Some(tp);
                    (tangent + radial * (correction * dd)).normalized()
                }
                None => Vec3::ZERO,
            },
            term::WANDER => {
                if m.wander == 0.0 && m.wander_timer == 0.0 {
                    m.wander = i.yaw;
                }
                m.wander_timer -= i.dt;
                if m.wander_timer <= 0.0 {
                    m.wander_timer = (if b > 0.0 { b } else { 2.0 }) * (0.5 + rng.next());
                    m.wander = wrap_angle(m.wander + rng.signed() * a);
                    m.idle = rng.next() < c;
                }
                if m.idle {
                    Vec3::ZERO
                } else {
                    forward_of(m.wander)
                }
            }
            term::HOME => {
                let to = (i.home - i.pos).flat();
                if to.len() > a {
                    to.normalized()
                } else {
                    Vec3::ZERO
                }
            }
            term::ALTITUDE => {
                if i.pos.y - i.ground < a {
                    Vec3::UP
                } else {
                    Vec3::ZERO
                }
            }
            term::FORWARD => forward_of(i.yaw),
            term::WEAVE => v3(0.0, sinf(i.time * a + i.phase), 0.0),
            _ => Vec3::ZERO,
        };
        want += v * weight;
    }
    let len = want.len();
    let want = if len > 1.0 { want * (1.0 / len) } else { want };
    Output {
        want: want * st[H::SPEED],
        boost: st[H::BOOST] > 0.5,
        fire_range: st[H::FIRE_RANGE],
        fire_cone: st[H::FIRE_CONE],
        face,
        fwd: if st[H::SET_FWD] > 0.5 { Some(st[H::FWD]) } else { None },
        drives,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Term = (u32, f32, f32, f32, f32, f32);
    type Transition = (u32, f32, f32);

    fn behaviour(states: &[(f32, f32, [Term; L::TERMS], [Transition; L::TRANSITIONS])]) -> [f32; BEHAVIOUR_LENGTH] {
        let mut d = [0.0f32; BEHAVIOUR_LENGTH];
        for (s, (speed, boost, terms, transitions)) in states.iter().enumerate() {
            let at = L::HEADER + s * BEHAVIOUR_STATE_LENGTH;
            d[at + H::SPEED] = *speed;
            d[at + H::BOOST] = *boost;
            for (k, t) in terms.iter().enumerate() {
                let o = at + L::STATE_HEAD + k * L::TERM_LEN;
                d[o..o + 6].copy_from_slice(&[t.0 as f32, t.1, t.2, t.3, t.4, t.5]);
            }
            for (k, t) in transitions.iter().enumerate() {
                let o = at + L::STATE_HEAD + L::TERMS * L::TERM_LEN + k * L::TRANSITION_LEN;
                d[o..o + 3].copy_from_slice(&[t.0 as f32, t.1, t.2]);
            }
        }
        d
    }

    const NO_TERM: Term = (0, 0.0, 0.0, 0.0, 0.0, 0.0);
    const NO_TR: Transition = (0, 0.0, 0.0);

    fn input(pos: Vec3, target: Option<Vec3>, dt: f32) -> Input {
        Input { pos, yaw: 0.0, home: Vec3::ZERO, ground: 0.0, hp_frac: 1.0, target: target.map(|t| (t, Vec3::ZERO)), time: 0.0, phase: 0.0, dt }
    }

    #[test]
    fn seek_arrives_and_stops() {
        let d = behaviour(&[(1.0, 0.0, [(term::SEEK, 1.0, 4.0, 2.0, 0.0, 0.0), NO_TERM, NO_TERM, NO_TERM], [NO_TR; 3])]);
        let mut m = Memory::default();
        let mut r = Rng(1);
        let far = evaluate(&d, &mut m, &input(Vec3::ZERO, Some(v3(0.0, 0.0, -20.0)), 0.016), &mut r);
        assert!((far.want - v3(0.0, 0.0, -1.0)).len() < 1e-3);
        let near = evaluate(&d, &mut m, &input(Vec3::ZERO, Some(v3(0.0, 0.0, -3.0)), 0.016), &mut r);
        assert!((near.want.len() - 0.25).abs() < 1e-3, "slows inside the arrive radius");
        let there = evaluate(&d, &mut m, &input(Vec3::ZERO, Some(v3(0.0, 0.0, -1.5)), 0.016), &mut r);
        assert!(there.want.len() < 1e-6);
    }

    #[test]
    fn herd_bolts_then_settles() {
        // graze: wander at half speed; a hunter within 10 m sends it to bolt;
        // bolt: flee with boost for 2 s, then back to graze
        let d = behaviour(&[
            (0.5, 0.0, [(term::WANDER, 1.0, 1.0, 1.0, 0.0, 0.0), NO_TERM, NO_TERM, NO_TERM], [(cond::NEAR, 10.0, 1.0), NO_TR, NO_TR]),
            (1.0, 1.0, [(term::FLEE, 1.0, 0.0, 0.0, 0.0, 0.0), NO_TERM, NO_TERM, NO_TERM], [(cond::AFTER, 2.0, 0.0), NO_TR, NO_TR]),
        ]);
        let mut m = Memory::default();
        let mut r = Rng(7);
        let calm = evaluate(&d, &mut m, &input(Vec3::ZERO, Some(v3(50.0, 0.0, 0.0)), 0.1), &mut r);
        assert_eq!(m.state, 0);
        assert!(!calm.boost && (calm.want.len() - 0.5).abs() < 1e-3);
        let scared = evaluate(&d, &mut m, &input(Vec3::ZERO, Some(v3(5.0, 0.0, 0.0)), 0.1), &mut r);
        assert_eq!(m.state, 1);
        assert!(scared.boost && scared.want.x < -0.99, "runs away from the hunter");
        for _ in 0..25 {
            evaluate(&d, &mut m, &input(Vec3::ZERO, Some(v3(50.0, 0.0, 0.0)), 0.1), &mut r);
        }
        assert_eq!(m.state, 0, "settles after two seconds");
    }

    #[test]
    fn orbit_keeps_its_radius_and_flips_sides() {
        let d = behaviour(&[(1.0, 0.0, [(term::ORBIT, 1.0, 10.0, 1.0, 0.5, 1.0), NO_TERM, NO_TERM, NO_TERM], [NO_TR; 3])]);
        let mut m = Memory::default();
        let mut r = Rng(3);
        let on_ring = evaluate(&d, &mut m, &input(v3(10.0, 0.0, 0.0), Some(Vec3::ZERO), 0.016), &mut r);
        assert!(on_ring.want.x.abs() < 1e-3, "on the radius it moves tangentially");
        let mut sides = [0usize; 2];
        for _ in 0..400 {
            evaluate(&d, &mut m, &input(v3(10.0, 0.0, 0.0), Some(Vec3::ZERO), 0.016), &mut r);
            sides[(m.side > 0.0) as usize] += 1;
        }
        assert!(sides[0] > 0 && sides[1] > 0);
    }

    #[test]
    fn a_state_without_terms_does_not_drive() {
        let d = behaviour(&[(1.0, 0.0, [NO_TERM; 4], [NO_TR; 3])]);
        let out = evaluate(&d, &mut Memory::default(), &input(Vec3::ZERO, Some(v3(5.0, 0.0, 0.0)), 0.016), &mut Rng(1));
        assert!(!out.drives);
    }

    #[test]
    fn memory_round_trips_through_brain_floats() {
        let m = Memory { state: 2, time: 1.5, wander: 0.3, wander_timer: 0.7, side: -1.0, side_timer: 0.2, idle: true };
        let mut b = [0.0f32; 7];
        m.store(&mut b);
        let back = Memory::load(&b);
        assert_eq!(back.state, 2);
        assert!(back.idle && back.side == -1.0 && back.time == 1.5);
    }
}
