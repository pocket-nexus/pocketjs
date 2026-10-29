//! Particles: a fixed pool of points with life, drag and gravity, drawn as
//! camera-facing quads. Emitters are 24-float descriptors (PLAYSET_EMITTER).

use crate::fmath::*;
use crate::schema::emitter as P;
use crate::vec::*;
use alloc::vec::Vec;

#[derive(Clone, Copy, Default)]
pub struct Particle {
    pub pos: Vec3,
    pub vel: Vec3,
    pub life: f32,
    pub max_life: f32,
    pub emitter: u16,
}

pub struct Particles {
    pub pool: Vec<Particle>,
    pub cap: usize,
    pub emitters: Vec<[f32; 24]>,
}

impl Particles {
    pub fn new(cap: usize) -> Particles {
        let cap = cap.clamp(0, 4096);
        Particles { pool: Vec::with_capacity(cap), cap, emitters: Vec::new() }
    }

    pub fn add_emitter(&mut self, d: &[f32]) -> i32 {
        let mut e = [0.0f32; 24];
        let n = d.len().min(24);
        e[..n].copy_from_slice(&d[..n]);
        self.emitters.push(e);
        (self.emitters.len() - 1) as i32
    }

    /// `count` scales the descriptor's COUNT (1 = as described).
    pub fn emit(&mut self, emitter: usize, at: Vec3, inherit: Vec3, count: f32, rng: &mut Rng) {
        let Some(e) = self.emitters.get(emitter).copied() else { return };
        let n = (e[P::COUNT] * count + rng.next() * 0.999) as usize;
        let dir = v3(e[P::DX], e[P::DY], e[P::DZ]);
        let dir = if dir.len_sq() > 1e-6 { dir.normalized() } else { Vec3::UP };
        let spread = e[P::SPREAD];
        // two axes perpendicular to dir
        let side = if absf(dir.y) < 0.9 { dir.cross(Vec3::UP).normalized() } else { dir.cross(v3(1.0, 0.0, 0.0)).normalized() };
        let up = side.cross(dir);
        for _ in 0..n {
            if self.pool.len() >= self.cap {
                return;
            }
            let a = rng.next() * TAU;
            let cone = if spread >= PI - 1e-3 { acos_uniform(rng) } else { rng.next() * spread };
            let (sc, cc) = (sinf(cone), cosf(cone));
            let d = dir * cc + side * (sc * cosf(a)) + up * (sc * sinf(a));
            let speed = e[P::SPEED] + rng.signed() * e[P::SPEED_JITTER];
            let life = maxf(e[P::LIFE] + rng.signed() * e[P::LIFE_JITTER], 0.05);
            let r = e[P::RADIUS];
            let offset = if r > 0.0 { v3(rng.signed(), rng.signed(), rng.signed()) * r } else { Vec3::ZERO };
            let inh = if e[P::INHERIT] > 0.5 { inherit } else { Vec3::ZERO };
            self.pool.push(Particle { pos: at + offset, vel: d * speed + inh, life, max_life: life, emitter: emitter as u16 });
        }
    }

    pub fn step(&mut self, dt: f32, gravity: f32) {
        let mut i = 0;
        while i < self.pool.len() {
            let p = &mut self.pool[i];
            p.life -= dt;
            if p.life <= 0.0 {
                self.pool.swap_remove(i);
                continue;
            }
            let e = &self.emitters[p.emitter as usize];
            p.vel.y -= gravity * e[P::GRAVITY] * dt;
            if e[P::DRAG] > 0.0 {
                p.vel = p.vel * expf(-e[P::DRAG] * dt);
            }
            p.pos += p.vel * dt;
            i += 1;
        }
    }
}

/// A polar angle for uniform directions over the sphere.
fn acos_uniform(rng: &mut Rng) -> f32 {
    let z = rng.signed();
    atan2f(sqrtf(maxf(1.0 - z * z, 0.0)), z)
}
