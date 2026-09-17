//! Tween/spring tracks — fixed dt per tick (the realm's tick rate, spec
//! default spec::FIXED_DT), never wall clock. Frame content is a pure
//! function of frame index (byte-exact goldens depend on it): easings are
//! polynomial closed forms, springs are a deterministic semi-implicit-Euler
//! damped oscillator at that fixed dt.
//!
//! Value plumbing (see lib.rs): a running track writes its per-frame value
//! into the node's `anim_values`; on completion a transition track simply
//! removes its entry (the resolved style now equals the target) while an
//! explicit `animate()` track persists its final value as a dynamic override.

use alloc::vec::Vec;

use crate::spec;

/// Convert a duration in ms to whole `hz`-rate frames (>= 1). Widened to u64
/// so host-controlled durations near u32::MAX cannot overflow `ms * hz` (the
/// result always fits back in u32: max ~257.7M frames at 60 Hz).
#[inline]
pub fn ms_to_frames(ms: u32, hz: u32) -> u32 {
    (((ms as u64 * hz as u64 + 500) / 1000) as u32).max(1)
}

/// Where a track came from (decides completion semantics — see lib.rs).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TrackKind {
    /// Spawned by a style/focus change diff.
    Transition,
    /// Spawned by the `animate()` op.
    Explicit,
}

/// Why a stable animation id left the live track table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionReason { Ended, Replaced, Dropped }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrackCompletion { pub id: i32, pub reason: CompletionReason }

/// One animation track. `from`/`to` are the raw u32 prop payloads (f32 bits
/// or packed ABGR when `is_color`).
pub struct Track {
    pub alive: bool,
    pub generation: u32,
    pub node: i32,
    pub prop: u8,
    pub is_color: bool,
    pub kind: TrackKind,
    pub from: u32,
    pub to: u32,
    /// Frames to hold `from` before the motion starts.
    pub delay: u32,
    /// Motion duration in frames (ignored by springs).
    pub dur: u32,
    /// spec::Easing ordinal.
    pub easing: u8,
    /// Frames since spawn (incremented by `step`).
    pub elapsed: u32,
    // Spring state (progress-space: x goes 0 -> 1).
    spring_x: f32,
    spring_v: f32,
}

/// `|x|` without std.
#[inline]
fn absf(x: f32) -> f32 {
    f32::from_bits(x.to_bits() & 0x7fff_ffff)
}

/// Polynomial easing curves (t in [0,1]; OutBack overshoots ~10%).
fn ease(easing: u8, t: f32) -> f32 {
    const E_IN: u8 = spec::Easing::EaseIn as u8;
    const E_OUT: u8 = spec::Easing::EaseOut as u8;
    const E_IN_OUT: u8 = spec::Easing::EaseInOut as u8;
    const E_OUT_BACK: u8 = spec::Easing::OutBack as u8;
    match easing {
        E_IN => t * t * t,
        E_OUT => {
            let p = 1.0 - t;
            1.0 - p * p * p
        }
        E_IN_OUT => {
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                let p = -2.0 * t + 2.0;
                1.0 - p * p * p * 0.5
            }
        }
        E_OUT_BACK => {
            const C1: f32 = 1.70158;
            const C3: f32 = C1 + 1.0;
            let p = t - 1.0;
            1.0 + C3 * p * p * p + C1 * p * p
        }
        _ => t, // Linear (and unknown ordinals degrade to linear)
    }
}

/// CSS cubic-bezier(x1, y1, x2, y2) sampled at time-progress `x` in [0,1].
/// Solves x(t) = x by deterministic Newton iterations with a bisection
/// fallback (control xs are inside [0,1] so x(t) is monotonic), then returns
/// y(t). Pure f32 — same result on every host.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    // Polynomial coefficients: b(t) = ((a*t + b)*t + c)*t  with p0=0, p3=1.
    let cx = 3.0 * x1;
    let bx = 3.0 * (x2 - x1) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * y1;
    let by = 3.0 * (y2 - y1) - cy;
    let ay = 1.0 - cy - by;
    let sample_x = |t: f32| ((ax * t + bx) * t + cx) * t;
    let sample_dx = |t: f32| (3.0 * ax * t + 2.0 * bx) * t + cx;

    // Newton from t = x (good seed for near-diagonal curves).
    let mut t = x;
    for _ in 0..8 {
        let e = sample_x(t) - x;
        if absf(e) < 1e-5 {
            return ((ay * t + by) * t + cy) * t;
        }
        let d = sample_dx(t);
        if absf(d) < 1e-6 {
            break;
        }
        t -= e / d;
        if !(0.0..=1.0).contains(&t) {
            break;
        }
    }
    // Bisection fallback (monotonic x(t) on [0,1]).
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    t = x;
    for _ in 0..24 {
        let e = sample_x(t) - x;
        if absf(e) < 1e-5 {
            break;
        }
        if e > 0.0 {
            hi = t;
        } else {
            lo = t;
        }
        t = (lo + hi) * 0.5;
    }
    ((ay * t + by) * t + cy) * t
}

/// Sample one baked timeline track at `lt` frames into the iteration.
/// Holds segments[0].from before the first segment, the previous segment's
/// `to` in gaps, and last.to at/after the final segment end.
pub fn sample_track(track: &crate::style::TimelineTrack, lt: u32, is_color: bool) -> u32 {
    let segs = &track.segments;
    let mut value = segs[0].from;
    for seg in segs.iter() {
        if lt < seg.t0 as u32 {
            break;
        }
        if lt >= seg.t1 as u32 {
            value = seg.to;
            continue;
        }
        let t = (lt - seg.t0 as u32) as f32 / (seg.t1 - seg.t0) as f32;
        const BEZIER: u8 = spec::Easing::CubicBezier as u8;
        let f = if seg.easing == BEZIER {
            let [x1, y1, x2, y2] = seg.bezier;
            cubic_bezier(x1, y1, x2, y2, t)
        } else {
            ease(seg.easing, t)
        };
        return interp(seg.from, seg.to, f, is_color);
    }
    value
}

/// Interpolate between two raw payloads by eased progress `f` (may exceed
/// [0,1] for OutBack/springs). Colors lerp per ABGR channel, clamped.
pub fn interp(from: u32, to: u32, f: f32, is_color: bool) -> u32 {
    if is_color {
        let mut out = 0u32;
        for shift in [0u32, 8, 16, 24] {
            let a = ((from >> shift) & 0xff) as f32;
            let b = ((to >> shift) & 0xff) as f32;
            let c = a + (b - a) * f;
            let c = if c < 0.0 { 0.0 } else if c > 255.0 { 255.0 } else { c };
            out |= (((c + 0.5) as u32) & 0xff) << shift;
        }
        out
    } else {
        let a = f32::from_bits(from);
        let b = f32::from_bits(to);
        (a + (b - a) * f).to_bits()
    }
}

impl Track {
    /// Advance one fixed-`dt` frame. Returns (current raw value, done).
    pub fn step(&mut self, dt: f32) -> (u32, bool) {
        self.elapsed += 1;
        if self.elapsed <= self.delay {
            return (self.from, false);
        }
        const SPRING: u8 = spec::Easing::Spring as u8;
        const SPRING_BOUNCY: u8 = spec::Easing::SpringBouncy as u8;
        if self.easing == SPRING || self.easing == SPRING_BOUNCY {
            // Damped oscillator toward 1.0 in progress space; presets chosen
            // to match the familiar react-spring feel. durMs is ignored.
            let (k, c) = if self.easing == SPRING {
                (170.0f32, 26.0f32) // near-critically damped
            } else {
                (180.0f32, 12.0f32) // underdamped: visible bounce
            };
            let a = k * (1.0 - self.spring_x) - c * self.spring_v;
            self.spring_v += a * dt;
            self.spring_x += self.spring_v * dt;
            let done = absf(1.0 - self.spring_x) < 0.0005 && absf(self.spring_v) < 0.01;
            let f = if done { 1.0 } else { self.spring_x };
            (interp(self.from, self.to, f, self.is_color), done)
        } else {
            let run = self.elapsed - self.delay;
            let done = run >= self.dur;
            let t = if done { 1.0 } else { run as f32 / self.dur as f32 };
            (interp(self.from, self.to, ease(self.easing, t), self.is_color), done)
        }
    }
}

/// The track table. Anim ids are generation-tagged like node ids:
/// (gen << ID_SLOT_BITS) | slot, so stale `cancel_anim` calls are no-ops.
pub struct Anims {
    pub tracks: Vec<Track>,
    free: Vec<u32>,
    completions: Vec<TrackCompletion>,
    pending_completions: Vec<TrackCompletion>,
}

impl Default for Anims {
    fn default() -> Self {
        Self::new()
    }
}

impl Anims {
    pub fn new() -> Anims {
        // Slot 0 stays permanently dead so make_id(0, 0) == 0 (an invalid
        // anim id) is never handed out — mirrors the node arena.
        let mut a = Anims { tracks: Vec::new(), free: Vec::new(), completions: Vec::new(), pending_completions: Vec::new() };
        a.tracks.push(Track {
            alive: false,
            generation: 0,
            node: 0,
            prop: 0,
            is_color: false,
            kind: TrackKind::Explicit,
            from: 0,
            to: 0,
            delay: 0,
            dur: 1,
            easing: 0,
            elapsed: 0,
            spring_x: 0.0,
            spring_v: 0.0,
        });
        a
    }

    /// Spawn a track (killing any live track on the same node+prop first).
    /// Returns the anim id, or -1 when the table is full.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &mut self,
        node: i32,
        prop: u8,
        is_color: bool,
        kind: TrackKind,
        from: u32,
        to: u32,
        dur_ms: u32,
        easing: u8,
        delay_ms: u32,
        hz: u32,
    ) -> i32 {
        self.kill_for(node, prop);
        let slot = match self.free.pop() {
            Some(s) => s,
            None => {
                if self.tracks.len() as u32 > spec::ID_SLOT_MASK {
                    return -1;
                }
                self.tracks.push(Track {
                    alive: false,
                    generation: 0,
                    node: 0,
                    prop: 0,
                    is_color: false,
                    kind: TrackKind::Explicit,
                    from: 0,
                    to: 0,
                    delay: 0,
                    dur: 1,
                    easing: 0,
                    elapsed: 0,
                    spring_x: 0.0,
                    spring_v: 0.0,
                });
                (self.tracks.len() - 1) as u32
            }
        };
        let generation = self.tracks[slot as usize].generation;
        let t = &mut self.tracks[slot as usize];
        *t = Track {
            alive: true,
            generation,
            node,
            prop,
            is_color,
            kind,
            from,
            to,
            delay: if delay_ms == 0 { 0 } else { ms_to_frames(delay_ms, hz) },
            dur: ms_to_frames(dur_ms, hz),
            easing,
            elapsed: 0,
            spring_x: 0.0,
            spring_v: 0.0,
        };
        crate::tree::make_id(generation, slot)
    }

    /// Resolve an anim id to a live track slot.
    pub fn resolve(&self, anim_id: i32) -> Option<u32> {
        if anim_id <= 0 {
            return None;
        }
        let (generation, slot) = crate::tree::split_id(anim_id);
        let t = self.tracks.get(slot as usize)?;
        if t.alive && t.generation == generation && slot != 0 {
            Some(slot)
        } else {
            None
        }
    }

    /// Kill a track by slot (bumps generation so its id goes stale).
    pub fn kill(&mut self, slot: u32) { self.finish(slot, CompletionReason::Replaced); }

    pub fn finish(&mut self, slot: u32, reason: CompletionReason) {
        let t = &mut self.tracks[slot as usize];
        if t.alive {
            self.pending_completions.push(TrackCompletion {
                id: crate::tree::make_id(t.generation, slot), reason,
            });
            t.alive = false;
            t.generation = (t.generation + 1) & crate::tree::GEN_MASK;
            self.free.push(slot);
        }
    }

    /// Kill the live track on (node, prop), if any.
    pub fn kill_for(&mut self, node: i32, prop: u8) {
        // Slot 0 is permanently dead and never enters `free`, so this
        // equality means there are no live tracks. Direct per-frame scrubs
        // commonly retain a large all-dead table after their release tween;
        // avoid rescanning every dead slot for every property write.
        if self.tracks.len() == self.free.len() + 1 {
            return;
        }
        for slot in 0..self.tracks.len() as u32 {
            let t = &self.tracks[slot as usize];
            if t.alive && t.node == node && t.prop == prop {
                self.kill(slot);
            }
        }
    }

    /// Kill every live track on a node (destroy_node).
    pub fn kill_node(&mut self, node: i32) {
        for slot in 0..self.tracks.len() as u32 {
            let t = &self.tracks[slot as usize];
            if t.alive && t.node == node {
                self.finish(slot, CompletionReason::Dropped);
            }
        }
    }

    /// Publish this tick's completions. Hosts that do not observe reports retain one tick only.
    pub fn publish_completions(&mut self) {
        self.completions.clear();
        core::mem::swap(&mut self.completions, &mut self.pending_completions);
    }
    pub fn completions(&self) -> &[TrackCompletion] { &self.completions }
    /// Include kills issued between ticks and consume each report once.
    pub fn drain_completions(&mut self, mut receive: impl FnMut(TrackCompletion)) {
        for completion in self.completions.drain(..) { receive(completion); }
        for completion in self.pending_completions.drain(..) { receive(completion); }
    }

    /// Is there a live track on (node, prop)?
    pub fn has_live(&self, node: i32, prop: u8) -> bool {
        self.tracks.iter().any(|t| t.alive && t.node == node && t.prop == prop)
    }
}
