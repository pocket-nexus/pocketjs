//! Behaviours as data: a few states, each a weighted sum of steering terms
//! with a speed, a boost and a fire policy, and transitions on conditions.
//!
//! The guest composes a behaviour once (TS presets build STRAFE, PURSUE and
//! HERD from these parts); every step evaluates it per slot with no guest
//! code. Nothing here knows a game: the terms are vector arithmetic, the
//! conditions compare distances, times and hit points.
//!
//! Layout of one behaviour (floats): HEADER, then STATES states of
//! STATE_LEN floats. A state: speed, boost, fire range, fire cone, then
//! TERMS terms of TERM_LEN (kind, weight, a, b, c, d), then TRANSITIONS of
//! TRANSITION_LEN (condition, value, next state).

use crate::fmath::*;
use crate::vec::*;

pub const HEADER: usize = 4;
pub const STATES: usize = 4;
pub const TERMS: usize = 4;
pub const TERM_LEN: usize = 6;
pub const TRANSITIONS: usize = 3;
pub const TRANSITION_LEN: usize = 3;
pub const STATE_HEAD: usize = 4;
pub const STATE_LEN: usize = STATE_HEAD + TERMS * TERM_LEN + TRANSITIONS * TRANSITION_LEN;
pub const LEN: usize = HEADER + STATES * STATE_LEN;

/// Steering terms. Distances in metres, times in seconds.
pub mod term {
    pub const NONE: u32 = 0;
    /// toward the target; a = slow-down radius (arrive), b = stop distance
    pub const SEEK: u32 = 1;
    /// away from the target
    pub const FLEE: u32 = 2;
    /// around the target at radius a, side +1/-1 by b; c = seconds between
    /// side flips (0 keeps the side); d = weight of the radial correction
    pub const ORBIT: u32 = 3;
    /// a heading that drifts by up to a radians every b seconds
    pub const WANDER: u32 = 4;
    /// back to the spawn point beyond radius a
    pub const HOME: u32 = 5;
    /// toward where the target will be in a seconds
    pub const LEAD: u32 = 6;
    /// up when closer than a metres to the ground (flight)
    pub const ALTITUDE: u32 = 7;
    /// the slot's own facing (keep going)
    pub const FORWARD: u32 = 8;
}

/// Transition conditions.
pub mod cond {
    pub const NONE: u32 = 0;
    /// target within value metres
    pub const NEAR: u32 = 1;
    /// target beyond value metres, or none
    pub const FAR: u32 = 2;
    /// value seconds in this state
    pub const AFTER: u32 = 3;
    /// hit points below value of the maximum
    pub const HURT: u32 = 4;
    pub const NO_TARGET: u32 = 5;
    /// with probability value per second
    pub const CHANCE: u32 = 6;
}

/// What a behaviour reads about its slot and target this step.
pub struct Input {
    pub pos: Vec3,
    pub yaw: f32,
    pub home: Vec3,
    pub ground: f32,
    pub hp_frac: f32,
    pub target: Option<(Vec3, Vec3)>,
    pub dt: f32,
}

/// What it asks for: a wanted direction (length = speed fraction), boost,
/// whether to fire, and where to face.
#[derive(Debug, Default, Clone, Copy)]
pub struct Output {
    pub want: Vec3,
    pub boost: bool,
    pub fire_range: f32,
    pub fire_cone: f32,
    pub face: Option<Vec3>,
}

/// Per-slot state: current state, time in it, wander heading and timer,
/// orbit side and its timer.
#[derive(Clone, Copy, Default)]
pub struct Memory {
    pub state: u8,
    pub time: f32,
    pub wander: f32,
    pub wander_timer: f32,
    pub side: f32,
    pub side_timer: f32,
}

fn state(d: &[f32], s: usize) -> &[f32] {
    let at = HEADER + s.min(STATES - 1) * STATE_LEN;
    &d[at..at + STATE_LEN]
}

/// Evaluate one step; transitions apply before the terms of the state they
/// land in.
pub fn evaluate(d: &[f32], m: &mut Memory, i: &Input, rng: &mut Rng) -> Output {
    if d.len() < LEN {
        return Output::default();
    }
    m.time += i.dt;
    // transitions
    let st = state(d, m.state as usize);
    for t in 0..TRANSITIONS {
        let at = STATE_HEAD + TERMS * TERM_LEN + t * TRANSITION_LEN;
        let (c, value, next) = (st[at] as u32, st[at + 1], st[at + 2] as usize);
        let dist = i.target.map(|(p, _)| (p - i.pos).len());
        let fire = match c {
            cond::NEAR => dist.is_some_and(|x| x <= value),
            cond::FAR => dist.is_none_or(|x| x > value),
            cond::AFTER => m.time >= value,
            cond::HURT => i.hp_frac < value,
            cond::NO_TARGET => i.target.is_none(),
            cond::CHANCE => rng.next() < value * i.dt,
            _ => false,
        };
        if fire && next < STATES {
            m.state = next as u8;
            m.time = 0.0;
            break;
        }
    }
    let st = state(d, m.state as usize);
    let speed = if st[0] > 0.0 { st[0] } else { 1.0 };
    let mut want = Vec3::ZERO;
    let mut face = None;
    for k in 0..TERMS {
        let at = STATE_HEAD + k * TERM_LEN;
        let (kind, weight, a, b, c, dd) = (st[at] as u32, st[at + 1], st[at + 2], st[at + 3], st[at + 4], st[at + 5]);
        if kind == term::NONE || weight == 0.0 {
            continue;
        }
        let v = match kind {
            term::SEEK | term::LEAD => match i.target {
                Some((tp, tv)) => {
                    let aim = if kind == term::LEAD { tp + tv * a } else { tp };
                    let delta = aim - i.pos;
                    let dist = delta.len();
                    face = Some(aim);
                    let stop = if kind == term::SEEK { b } else { 0.0 };
                    let slow = if kind == term::SEEK && a > 0.0 { clampf((dist - stop) / a, 0.0, 1.0) } else if dist > stop { 1.0 } else { 0.0 };
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
                    (tangent + radial * (correction * if dd > 0.0 { dd } else { 1.0 })).normalized()
                }
                None => Vec3::ZERO,
            },
            term::WANDER => {
                m.wander_timer -= i.dt;
                if m.wander_timer <= 0.0 {
                    m.wander_timer = (if b > 0.0 { b } else { 2.0 }) * (0.5 + rng.next());
                    m.wander += rng.signed() * a;
                }
                forward_of(m.wander)
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
            _ => Vec3::ZERO,
        };
        want += v * weight;
    }
    let len = want.len();
    let want = if len > 1.0 { want * (1.0 / len) } else { want };
    Output { want: want * speed, boost: st[1] > 0.5, fire_range: st[2], fire_cone: st[3], face }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn behaviour(states: &[(f32, f32, [(u32, f32, f32, f32, f32, f32); TERMS], [(u32, f32, f32); TRANSITIONS])]) -> [f32; LEN] {
        let mut d = [0.0f32; LEN];
        for (s, (speed, boost, terms, transitions)) in states.iter().enumerate() {
            let at = HEADER + s * STATE_LEN;
            d[at] = *speed;
            d[at + 1] = *boost;
            for (k, t) in terms.iter().enumerate() {
                let o = at + STATE_HEAD + k * TERM_LEN;
                d[o..o + 6].copy_from_slice(&[t.0 as f32, t.1, t.2, t.3, t.4, t.5]);
            }
            for (k, t) in transitions.iter().enumerate() {
                let o = at + STATE_HEAD + TERMS * TERM_LEN + k * TRANSITION_LEN;
                d[o..o + 3].copy_from_slice(&[t.0 as f32, t.1, t.2]);
            }
        }
        d
    }

    const NO_TERM: (u32, f32, f32, f32, f32, f32) = (0, 0.0, 0.0, 0.0, 0.0, 0.0);
    const NO_TR: (u32, f32, f32) = (0, 0.0, 0.0);

    fn input(pos: Vec3, target: Option<Vec3>, dt: f32) -> Input {
        Input { pos, yaw: 0.0, home: Vec3::ZERO, ground: 0.0, hp_frac: 1.0, target: target.map(|t| (t, Vec3::ZERO)), dt }
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
}
