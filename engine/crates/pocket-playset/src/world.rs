//! The entity world: fixed-capacity slots in struct-of-arrays form.
//!
//! The public arrays (`ent`, `intent`, `user`, `look`, `joint`, `events`,
//! `list`) never reallocate after `World::new`: the guest holds Float32Array
//! views over them for the world's lifetime.

use crate::fmath::*;
use crate::schema::{arch as A, arch_flag as AF, bounds as BM, ent as E, event as EV, event_field as EF, ground as GM, intent as I, state as ST, weapon as W};
use crate::scene::Scene;
use crate::vec::*;
use crate::{brains, collide, kernels, particles::Particles};
use alloc::collections::VecDeque;
use alloc::vec;
use alloc::vec::Vec;

pub const MAX_EVENTS: usize = 256;
/// Removal with no event and no effect.
pub const KILL_SILENT: u8 = 0;
/// The death emitter plays; no event.
pub const KILL_EFFECTS: u8 = 1;
/// DEATH event and the death emitter.
pub const KILL_EVENT: u8 = 2;
pub const ARCH_LEN: usize = crate::schema::ARCH_LENGTH;

#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub a: u32,
    pub b: u32,
    pub flags: u32,
    pub value: f32,
}

/// Per-slot state the guest does not see.
#[derive(Clone, Copy, Default)]
pub struct Slot {
    pub cooldown: [f32; 2],
    pub burst_left: [u8; 2],
    pub burst_timer: [f32; 2],
    pub flash: f32,
    pub hurt: f32,
    pub owner: i32,
    pub team: i32,
    pub layer: u32,
    pub mask: u32,
    /// kernel scratch (steer angle, lane, drift, phase...)
    pub k: [f32; 8],
    /// brain scratch (timers, wander heading, path index...)
    pub b: [f32; 8],
    pub jangle: [f32; 4],
    pub home: Vec3,
    pub trail: f32,
    pub quat: Quat,
    pub parent: i32,
    pub last_hit_by: i32,
}

pub struct World {
    pub cap: usize,
    pub ent: Vec<f32>,
    pub intent: Vec<f32>,
    pub user: Vec<f32>,
    pub look: Vec<f32>,
    pub joint: Vec<f32>,
    pub events: Vec<f32>,
    pub event_count: usize,
    pub events_dropped: u32,
    pub list: Vec<f32>,
    pub archs: Vec<[f32; ARCH_LEN]>,
    pub rules: Vec<Rule>,
    pub s: Vec<Slot>,
    pub live: Vec<u16>,
    live_at: Vec<i32>,
    free: VecDeque<u16>,
    pub rng: Rng,
    pub time: f32,
    pub paths: Vec<Vec<Vec3>>,
    pub broad: collide::Broadphase,
    pub pairs: u32,
    pub fx: Particles,
    /// the camera rig's yaw, for camera-relative kernels
    pub cam_yaw: f32,
    /// slots killed during this step, freed at its end
    doomed: Vec<(u16, i32, u8)>,
}

#[inline]
pub fn eidx(slot: usize, field: usize) -> usize {
    slot * crate::schema::stride::ENT + field
}

#[inline]
pub fn iidx(slot: usize, field: usize) -> usize {
    slot * crate::schema::stride::INTENT + field
}

impl World {
    pub fn new(cap: usize, particles: usize) -> World {
        let cap = cap.clamp(16, 4096);
        let st = crate::schema::stride::ENT;
        let mut free = VecDeque::with_capacity(cap);
        for i in 0..cap {
            free.push_back(i as u16);
        }
        let mut ent = vec![0.0; cap * st];
        for i in 0..cap {
            ent[eidx(i, E::TARGET)] = -1.0;
        }
        World {
            cap,
            ent,
            intent: vec![0.0; cap * crate::schema::stride::INTENT],
            user: vec![0.0; cap * crate::schema::stride::USER],
            look: vec![0.0; cap * crate::schema::stride::LOOK],
            joint: vec![0.0; cap * crate::schema::stride::JOINT],
            events: vec![0.0; MAX_EVENTS * crate::schema::stride::EVENTS],
            event_count: 0,
            events_dropped: 0,
            list: vec![0.0; cap],
            archs: Vec::new(),
            rules: Vec::new(),
            s: vec![Slot { owner: -1, parent: -1, last_hit_by: -1, quat: Quat::IDENTITY, ..Slot::default() }; cap],
            live: Vec::with_capacity(cap),
            live_at: vec![-1; cap],
            free,
            rng: Rng(0x5eed_1234),
            time: 0.0,
            paths: Vec::new(),
            broad: collide::Broadphase::default(),
            pairs: 0,
            fx: Particles::new(particles),
            cam_yaw: 0.0,
            doomed: Vec::with_capacity(64),
        }
    }

    #[inline]
    pub fn e(&self, slot: usize, field: usize) -> f32 {
        self.ent[eidx(slot, field)]
    }
    #[inline]
    pub fn set(&mut self, slot: usize, field: usize, v: f32) {
        self.ent[eidx(slot, field)] = v;
    }
    #[inline]
    pub fn pos(&self, slot: usize) -> Vec3 {
        let b = eidx(slot, 0);
        v3(self.ent[b], self.ent[b + 1], self.ent[b + 2])
    }
    #[inline]
    pub fn set_pos(&mut self, slot: usize, p: Vec3) {
        let b = eidx(slot, 0);
        self.ent[b] = p.x;
        self.ent[b + 1] = p.y;
        self.ent[b + 2] = p.z;
    }
    #[inline]
    pub fn vel(&self, slot: usize) -> Vec3 {
        let b = eidx(slot, E::VX);
        v3(self.ent[b], self.ent[b + 1], self.ent[b + 2])
    }
    #[inline]
    pub fn set_vel(&mut self, slot: usize, v: Vec3) {
        let b = eidx(slot, E::VX);
        self.ent[b] = v.x;
        self.ent[b + 1] = v.y;
        self.ent[b + 2] = v.z;
    }
    #[inline]
    pub fn intent(&self, slot: usize, field: usize) -> f32 {
        self.intent[iidx(slot, field)]
    }
    #[inline]
    pub fn set_intent(&mut self, slot: usize, field: usize, v: f32) {
        self.intent[iidx(slot, field)] = v;
    }
    /// The archetype id of a live slot.
    #[inline]
    pub fn arch_of(&self, slot: usize) -> Option<usize> {
        let a = self.ent[eidx(slot, E::ARCH)];
        if a >= 1.0 {
            Some(a as usize - 1)
        } else {
            None
        }
    }
    #[inline]
    pub fn a(&self, arch: usize, field: usize) -> f32 {
        self.archs[arch][field]
    }
    #[inline]
    pub fn alive(&self, slot: usize) -> bool {
        slot < self.cap && self.ent[eidx(slot, E::ARCH)] >= 1.0 && (self.state(slot) & ST::DEAD) == 0
    }
    #[inline]
    pub fn state(&self, slot: usize) -> u32 {
        self.ent[eidx(slot, E::STATE)] as u32
    }
    #[inline]
    pub fn set_state_bit(&mut self, slot: usize, bit: u32, on: bool) {
        let s = self.state(slot);
        let n = if on { s | bit } else { s & !bit };
        self.ent[eidx(slot, E::STATE)] = n as f32;
    }

    pub fn add_arch(&mut self, desc: &[f32]) -> i32 {
        let mut d = [0.0f32; ARCH_LEN];
        let n = desc.len().min(ARCH_LEN);
        d[..n].copy_from_slice(&desc[..n]);
        if d[A::SCALE] <= 0.0 {
            d[A::SCALE] = 1.0;
        }
        self.archs.push(d);
        (self.archs.len() - 1) as i32
    }

    pub fn set_arch(&mut self, id: usize, desc: &[f32]) {
        if let Some(d) = self.archs.get_mut(id) {
            let n = desc.len().min(ARCH_LEN);
            d[..n].copy_from_slice(&desc[..n]);
            if d[A::SCALE] <= 0.0 {
                d[A::SCALE] = 1.0;
            }
        }
    }

    pub fn add_rule(&mut self, a: u32, b: u32, flags: u32, value: f32) -> i32 {
        self.rules.push(Rule { a, b, flags, value });
        (self.rules.len() - 1) as i32
    }

    pub fn add_path(&mut self, pts: &[f32]) -> i32 {
        let p: Vec<Vec3> = pts.chunks_exact(3).map(|c| v3(c[0], c[1], c[2])).collect();
        self.paths.push(p);
        (self.paths.len() - 1) as i32
    }

    pub fn emit_event(&mut self, ty: u32, a: i32, b: i32, data: f32, p: Vec3, value: f32) {
        if self.event_count >= MAX_EVENTS {
            self.events_dropped += 1;
            return;
        }
        let o = self.event_count * crate::schema::stride::EVENTS;
        let r = &mut self.events[o..o + 8];
        r[EF::TYPE] = ty as f32;
        r[EF::A] = a as f32;
        r[EF::B] = b as f32;
        r[EF::DATA] = data;
        r[EF::X] = p.x;
        r[EF::Y] = p.y;
        r[EF::Z] = p.z;
        r[EF::VALUE] = value;
        self.event_count += 1;
    }

    /// Allocate a slot for `arch` at a position and heading. -1 when full.
    pub fn spawn(&mut self, scene: &Scene, arch: usize, p: Vec3, yaw: f32) -> i32 {
        if arch >= self.archs.len() {
            return -1;
        }
        let Some(slot) = self.free.pop_front() else { return -1 };
        let slot = slot as usize;
        let d = self.archs[arch];
        let st = crate::schema::stride::ENT;
        for f in &mut self.ent[slot * st..slot * st + st] {
            *f = 0.0;
        }
        for f in &mut self.intent[slot * 8..slot * 8 + 8] {
            *f = 0.0;
        }
        for f in &mut self.user[slot * 8..slot * 8 + 8] {
            *f = 0.0;
        }
        for f in &mut self.joint[slot * 4..slot * 4 + 4] {
            *f = 0.0;
        }
        let l = slot * 4;
        self.look[l] = d[A::SCALE];
        self.look[l + 1] = 1.0;
        self.look[l + 2] = 1.0;
        self.look[l + 3] = 1.0;
        let mut pos = p;
        match d[A::GROUND] as u32 {
            GM::SNAP => pos.y = scene.ground_height(p.x, p.z) + d[A::GROUND_OFFSET],
            GM::WATER => pos.y = scene.water.height(p.x, p.z, self.time) + d[A::GROUND_OFFSET],
            _ => {}
        }
        self.set_pos(slot, pos);
        self.set(slot, E::YAW, yaw);
        self.set(slot, E::HP, d[A::HP]);
        self.set(slot, E::HP_MAX, d[A::HP]);
        self.set(slot, E::ARCH, (arch + 1) as f32);
        self.set(slot, E::TARGET, -1.0);
        self.s[slot] = Slot {
            owner: -1,
            parent: -1,
            last_hit_by: -1,
            team: d[A::TEAM] as i32,
            layer: d[A::LAYER] as u32,
            mask: d[A::MASK] as u32,
            home: pos,
            quat: Quat::from_ypr(yaw, 0.0, 0.0),
            ..Slot::default()
        };
        // stagger brain timers so a wave does not think in lockstep
        self.s[slot].b[0] = self.rng.next() * 0.5;
        self.live_at[slot] = self.live.len() as i32;
        self.live.push(slot as u16);
        kernels::on_spawn(self, scene, slot, arch);
        slot as i32
    }

    /// Queue a slot's removal for the end of the step.
    pub fn kill(&mut self, slot: usize, killer: i32, announce: bool) {
        self.kill_mode(slot, killer, if announce { KILL_EVENT } else { KILL_SILENT });
    }

    pub fn kill_mode(&mut self, slot: usize, killer: i32, mode: u8) {
        if !self.alive(slot) {
            return;
        }
        self.set_state_bit(slot, ST::DEAD, true);
        self.doomed.push((slot as u16, killer, mode));
    }

    fn release(&mut self, slot: usize) {
        let at = self.live_at[slot];
        if at < 0 {
            return;
        }
        let last = self.live.pop().unwrap();
        if (last as usize) != slot {
            self.live[at as usize] = last;
            self.live_at[last as usize] = at;
        }
        self.live_at[slot] = -1;
        self.set(slot, E::ARCH, 0.0);
        self.set(slot, E::STATE, 0.0);
        self.free.push_back(slot as u16);
    }

    /// Deaths queued by this step: events, effects, then the slots.
    pub fn bury(&mut self) {
        let mut i = 0;
        while i < self.doomed.len() {
            let (slot, killer, mode) = self.doomed[i];
            let slot = slot as usize;
            i += 1;
            let Some(arch) = self.arch_of(slot) else { continue };
            let p = self.pos(slot);
            if mode == KILL_EVENT {
                let value = self.a(arch, A::VALUE);
                self.emit_event(EV::DEATH, slot as i32, killer, arch as f32, p, value);
            }
            if mode != KILL_SILENT {
                let em = self.a(arch, A::DEATH_EMITTER);
                if em >= 1.0 {
                    let v = self.vel(slot) * 0.3;
                    self.fx.emit(em as usize - 1, p, v, 1.0, &mut self.rng);
                }
            }
            if self.a(arch, A::FLAGS) as u32 & AF::KEEP_ON_DEATH != 0 {
                self.set_vel(slot, Vec3::ZERO);
                continue;
            }
            self.release(slot);
        }
        self.doomed.clear();
    }

    /// Free every slot, KEEP_ON_DEATH ones included.
    pub fn force_release_all(&mut self) {
        self.doomed.clear();
        while let Some(&s) = self.live.last() {
            self.release(s as usize);
        }
    }

    pub fn damage(&mut self, slot: usize, amount: f32, by: i32) {
        let Some(arch) = self.arch_of(slot) else { return };
        if self.state(slot) & ST::DEAD != 0 || self.a(arch, A::FLAGS) as u32 & AF::INVULNERABLE != 0 {
            return;
        }
        if self.s[slot].hurt > 0.0 {
            return;
        }
        let hp = self.e(slot, E::HP) - amount;
        self.set(slot, E::HP, hp);
        self.s[slot].flash = self.a(arch, A::FLASH);
        self.s[slot].hurt = self.a(arch, A::EXTRA);
        self.s[slot].last_hit_by = by;
        if hp <= 0.0 && self.a(arch, A::HP) > 0.0 {
            self.kill(slot, by, true);
        }
    }

    /// The step: brains, weapons, kernels, ageing, collisions, deaths, effects.
    pub fn step(&mut self, scene: &Scene, dt: f32) {
        self.event_count = 0;
        self.events_dropped = 0;
        self.time += dt;
        let n = self.live.len();
        // brains write intents
        for li in 0..n {
            let slot = self.live[li] as usize;
            if self.state(slot) & (ST::DEAD | ST::FROZEN) != 0 {
                continue;
            }
            brains::think(self, scene, slot, dt);
        }
        // weapons
        for li in 0..n {
            let slot = self.live[li] as usize;
            if self.state(slot) & (ST::DEAD | ST::FROZEN) != 0 {
                continue;
            }
            self.weapons(scene, slot, dt);
        }
        // kernels move bodies
        let n = self.live.len();
        for li in 0..n {
            let slot = self.live[li] as usize;
            if self.state(slot) & (ST::DEAD | ST::FROZEN) != 0 {
                continue;
            }
            kernels::step(self, scene, slot, dt);
            self.after_motion(scene, slot, dt);
        }
        collide::resolve(self, scene, dt);
        self.bury();
        self.fx.step(dt, scene.env.gravity);
    }

    fn after_motion(&mut self, scene: &Scene, slot: usize, dt: f32) {
        let Some(arch) = self.arch_of(slot) else { return };
        let d = &self.archs[arch];
        let (ground, offset, bounds, lifetime, flags) =
            (d[A::GROUND] as u32, d[A::GROUND_OFFSET], d[A::BOUNDS] as u32, d[A::LIFETIME], d[A::FLAGS] as u32);
        let (trail, trail_rate) = (d[A::TRAIL_EMITTER], d[A::TRAIL_RATE]);
        let mut p = self.pos(slot);
        let mut v = self.vel(slot);
        match ground {
            GM::SNAP => {
                p.y = scene.ground_height(p.x, p.z) + offset;
                self.set_state_bit(slot, ST::GROUNDED, true);
            }
            GM::GRAVITY => {
                let gy = scene.ground_height(p.x, p.z) + offset;
                if p.y <= gy {
                    p.y = gy;
                    if v.y < 0.0 {
                        v.y = 0.0;
                    }
                    self.set_state_bit(slot, ST::GROUNDED, true);
                } else {
                    self.set_state_bit(slot, ST::GROUNDED, false);
                }
            }
            _ => {}
        }
        if flags & AF::ALIGN_GROUND != 0 {
            let n = scene.ground_normal(p.x, p.z);
            let yaw = self.e(slot, E::YAW);
            let f = forward_of(yaw);
            let r = right_of(yaw);
            let target_pitch = asinf(-(n.dot(f)));
            let target_roll = asinf(n.dot(r));
            let k = smoothing(10.0, dt);
            let pitch = lerpf(self.e(slot, E::PITCH), target_pitch, k);
            let roll = lerpf(self.e(slot, E::ROLL), target_roll, k);
            self.set(slot, E::PITCH, pitch);
            self.set(slot, E::ROLL, roll);
        }
        if scene.env.has_bounds && bounds != BM::NONE {
            let (lo, hi) = (scene.env.bounds_min, scene.env.bounds_max);
            let outside = p.x < lo.x || p.x > hi.x || p.z < lo.z || p.z > hi.z || p.y < lo.y || p.y > hi.y;
            if outside {
                match bounds {
                    BM::CLAMP | BM::BOUNCE => {
                        let bounce = bounds == BM::BOUNCE;
                        if p.x < lo.x || p.x > hi.x {
                            p.x = clampf(p.x, lo.x, hi.x);
                            v.x = if bounce { -v.x } else { 0.0 };
                        }
                        if p.z < lo.z || p.z > hi.z {
                            p.z = clampf(p.z, lo.z, hi.z);
                            v.z = if bounce { -v.z } else { 0.0 };
                        }
                        if p.y < lo.y || p.y > hi.y {
                            p.y = clampf(p.y, lo.y, hi.y);
                            v.y = if bounce { -v.y } else { 0.0 };
                        }
                        if bounce {
                            self.set(slot, E::YAW, yaw_of(v.x, v.z));
                        }
                    }
                    BM::WRAP => {
                        let w = hi - lo;
                        if p.x < lo.x {
                            p.x += w.x;
                        } else if p.x > hi.x {
                            p.x -= w.x;
                        }
                        if p.z < lo.z {
                            p.z += w.z;
                        } else if p.z > hi.z {
                            p.z -= w.z;
                        }
                    }
                    _ => {
                        self.emit_event(EV::BOUNDS, slot as i32, -1, arch as f32, p, 0.0);
                        self.kill(slot, -1, false);
                    }
                }
            }
        }
        self.set_pos(slot, p);
        self.set_vel(slot, v);
        let age = self.e(slot, E::AGE) + dt;
        self.set(slot, E::AGE, age);
        let st = &mut self.s[slot];
        st.flash = maxf(st.flash - dt, 0.0);
        st.hurt = maxf(st.hurt - dt, 0.0);
        if trail >= 1.0 && trail_rate > 0.0 {
            st.trail += trail_rate * dt;
            let whole = floorf(st.trail);
            if whole >= 1.0 {
                st.trail -= whole;
                self.fx.emit(trail as usize - 1, p, Vec3::ZERO, whole, &mut self.rng);
            }
        }
        if lifetime > 0.0 && age >= lifetime {
            if self.a(arch, A::EXTRA + 1) > 0.5 {
                self.emit_event(EV::EXPIRE, slot as i32, -1, arch as f32, p, 0.0);
            }
            self.kill(slot, -1, false);
        }
    }

    /// Fire a slot's weapons from its intents.
    fn weapons(&mut self, scene: &Scene, slot: usize, dt: f32) {
        let Some(arch) = self.arch_of(slot) else { return };
        for wi in 0..2 {
            let base = if wi == 0 { A::WEAPON0 } else { A::WEAPON1 };
            let w = &self.archs[arch][base..base + 16];
            let proj = w[W::PROJECTILE];
            if proj < 1.0 {
                continue;
            }
            let (cool, burst, gap) = (w[W::COOLDOWN], w[W::BURST] as u8, w[W::BURST_GAP]);
            let st = &mut self.s[slot];
            st.cooldown[wi] = maxf(st.cooldown[wi] - dt, 0.0);
            st.burst_timer[wi] = maxf(st.burst_timer[wi] - dt, 0.0);
            let trigger = self.intent(slot, if wi == 0 { I::FIRE } else { I::ALT }) >= 0.5;
            let st = &mut self.s[slot];
            let mut shoot = false;
            if st.burst_left[wi] > 0 && st.burst_timer[wi] <= 0.0 {
                st.burst_left[wi] -= 1;
                st.burst_timer[wi] = gap;
                shoot = true;
            } else if trigger && st.cooldown[wi] <= 0.0 && st.burst_left[wi] == 0 {
                st.cooldown[wi] = cool;
                if burst > 1 {
                    st.burst_left[wi] = burst - 1;
                    st.burst_timer[wi] = gap;
                }
                shoot = true;
            }
            if shoot {
                self.fire(scene, slot, arch, wi);
            }
        }
    }

    pub fn fire(&mut self, scene: &Scene, slot: usize, arch: usize, wi: usize) {
        let base = if wi == 0 { A::WEAPON0 } else { A::WEAPON1 };
        let mut w = [0.0f32; 16];
        w.copy_from_slice(&self.archs[arch][base..base + 16]);
        let proj = w[W::PROJECTILE] as usize - 1;
        if proj >= self.archs.len() {
            return;
        }
        let yaw = self.e(slot, E::YAW);
        let pitch = self.e(slot, E::PITCH);
        let roll = self.e(slot, E::ROLL);
        let scale = self.look[slot * 4];
        let m = Mat34::from_ypr(self.pos(slot), yaw, pitch, roll, scale);
        let muzzle = m.point(v3(w[W::MX], w[W::MY], w[W::MZ]));
        let speed = w[W::SPEED];
        let target = self.e(slot, E::TARGET) as i32;
        let mut dir = Mat34::from_ypr(Vec3::ZERO, yaw, pitch + w[W::PITCH], roll, 1.0).vector(v3(0.0, 0.0, -1.0));
        match w[W::AIM] as u32 {
            crate::schema::aim::LEAD if target >= 0 && self.alive(target as usize) => {
                let tp = self.pos(target as usize);
                let tv = self.vel(target as usize);
                let t = (tp - muzzle).len() / maxf(speed, 1.0);
                let lead = tp + tv * t;
                let d = (lead - muzzle).normalized();
                if d.len_sq() > 0.5 {
                    dir = d;
                }
            }
            crate::schema::aim::ARC if target >= 0 && self.alive(target as usize) => {
                let tp = self.pos(target as usize);
                let g = scene.env.gravity * maxf(self.a(proj, A::MOTION_P), 0.0);
                if let Some(d) = ballistic_aim(muzzle, tp, speed, g) {
                    dir = d;
                }
            }
            _ => {}
        }
        let count = (w[W::COUNT] as u32).max(1);
        let spread = w[W::SPREAD];
        let inherit = if w[W::INHERIT] > 0.5 { self.vel(slot) } else { Vec3::ZERO };
        let team = self.s[slot].team;
        for _ in 0..count {
            let mut d = dir;
            if spread > 0.0 {
                let r = right_of(yaw_of(d.x, d.z));
                let u = r.cross(d).normalized();
                let a = self.rng.signed() * spread;
                let b = self.rng.signed() * spread * 0.5;
                d = (d + r * a + u * b).normalized();
            }
            let pyaw = yaw_of(d.x, d.z);
            let ppitch = asinf(d.y);
            let p = self.spawn(scene, proj, muzzle, pyaw);
            if p < 0 {
                break;
            }
            let p = p as usize;
            self.set(p, E::PITCH, ppitch);
            self.set_vel(p, d * speed + inherit);
            self.set(p, E::SPEED, speed);
            self.set(p, E::TARGET, target as f32);
            self.s[p].owner = slot as i32;
            self.s[p].team = team;
            if w[W::EVENT] > 0.5 {
                self.emit_event(EV::FIRE, slot as i32, p as i32, wi as f32, muzzle, 0.0);
            }
        }
    }

    /// Slots matching a query into `list`; the count.
    pub fn query(&mut self, scene: &Scene, kind: u32, a: f32, b: f32, c: f32, d: f32) -> f32 {
        use crate::schema::query as Q;
        match kind {
            Q::ARCH => {
                let mut n = 0;
                for &s in self.live.iter() {
                    let s = s as usize;
                    if self.ent[eidx(s, E::ARCH)] == a + 1.0 && self.state(s) & ST::DEAD == 0 {
                        self.list[n] = s as f32;
                        n += 1;
                    }
                }
                n as f32
            }
            Q::NEAR => {
                let layers = a as u32;
                let center = v3(b, 0.0, c);
                let r2 = d * d;
                let mut n = 0;
                for &s in self.live.iter() {
                    let s = s as usize;
                    if self.s[s].layer & layers != 0 && self.state(s) & ST::DEAD == 0 && self.pos(s).dist_xz_sq(center) <= r2 {
                        self.list[n] = s as f32;
                        n += 1;
                    }
                }
                n as f32
            }
            Q::NEAREST => {
                let from = b as usize;
                if from >= self.cap {
                    return -1.0;
                }
                brains::nearest(self, from, a as u32, if c > 0.0 { c } else { 1e9 }) as f32
            }
            Q::HEIGHT => scene.ground_height(a, b),
            _ => 0.0,
        }
    }
}

/// The unit direction that throws a body from `from` to `to` at `speed`
/// under `g` (positive down), on the lower arc. None when out of range.
pub fn ballistic_aim(from: Vec3, to: Vec3, speed: f32, g: f32) -> Option<Vec3> {
    let d = to - from;
    let flat = d.flat();
    let x = flat.len();
    if x < 1e-3 {
        return None;
    }
    if g <= 1e-4 {
        return Some(d.normalized());
    }
    let y = d.y;
    let v2 = speed * speed;
    let disc = v2 * v2 - g * (g * x * x + 2.0 * y * v2);
    if disc < 0.0 {
        // out of range: 45 degrees gets closest
        let h = flat * (1.0 / x);
        return Some((h + Vec3::UP).normalized());
    }
    let angle = atan2f(v2 - sqrtf(disc), g * x);
    let h = flat * (1.0 / x);
    Some((h * cosf(angle) + Vec3::UP * sinf(angle)).normalized())
}
