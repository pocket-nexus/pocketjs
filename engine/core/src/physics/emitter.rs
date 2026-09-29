//! Particle emitters: a pool of image nodes, one particle per node, stepped
//! with their own generator so bursts never shift a world's other randomness.

use alloc::vec;
use alloc::vec::Vec;

use crate::fmath::{clampf, cosf, exp_neg, lerpf, maxf, sinf, DEG, PI, TAU};
use crate::spec;
use crate::spec::physics as ps;
use crate::tree::Tree;

use super::{f, id, node_frame, pairs, put, rand01, release_view, View, V2};

/// Highest streamed particle rate, per second.
const STREAM_RATE_MAX: f32 = 10_000.0;

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

pub(super) struct Emitter {
    pub(super) world: usize,
    rng: u32,
    views: Vec<View>,
    /// Each pool node's texture before the emitter first changed it.
    saved_tex: Vec<Option<i32>>,
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

impl Emitter {
    pub(super) fn new(world: usize, rng: u32, params: &[f64]) -> Emitter {
        let mut e = Emitter {
            world,
            rng,
            views: Vec::new(),
            saved_tex: Vec::new(),
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
                ps::KEY_VIEW => e.views.push(View { node: id(v), offset: V2::ZERO }),
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
                ps::KEY_TEXTURE => e.textures.push(id(v)),
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
        e.saved_tex = vec![None; e.views.len()];
        e
    }

    pub(super) fn live(&self) -> usize {
        self.particles.iter().filter(|p| p.alive).count()
    }

    fn spawn(&mut self, p: V2, angle: f32, speed_scale: f32) {
        let n = self.particles.len();
        if n == 0 {
            return;
        }
        // a free slot, else the oldest
        let i = (0..n).map(|k| (self.next + k) % n).find(|&i| !self.particles[i].alive).unwrap_or(self.next % n);
        self.next = (i + 1) % n;
        let rng = &mut self.rng;
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

    /// `count` particles spread evenly over `spread` around `angle`, each
    /// jittered within its share of the cone.
    pub(super) fn burst(&mut self, p: V2, count: usize, angle: f32, spread: f32, speed_scale: f32) {
        for k in 0..count {
            let base = if count > 1 { (k as f32 + 0.5) / count as f32 - 0.5 } else { 0.0 };
            let jitter = (rand01(&mut self.rng) - 0.5) / maxf(1.0, count as f32);
            self.spawn(p, angle + spread * (base + jitter), speed_scale);
        }
    }

    pub(super) fn stream(&mut self, rate: f32, lo: V2, size: V2) {
        self.stream_rate = clampf(rate, 0.0, STREAM_RATE_MAX);
        self.stream_lo = lo;
        self.stream_size = V2::new(maxf(0.0, size.x), maxf(0.0, size.y));
        if self.stream_rate == 0.0 {
            self.stream_acc = 0.0;
        }
    }

    pub(super) fn step(&mut self, dt: f32) {
        if self.stream_rate > 0.0 {
            let pool = self.particles.len() as f32;
            self.stream_acc = (self.stream_acc + self.stream_rate * dt).min(pool);
            let spawns = self.stream_acc as usize;
            self.stream_acc -= spawns as f32;
            for _ in 0..spawns {
                let p = self.stream_lo.add(V2::new(rand01(&mut self.rng) * self.stream_size.x, rand01(&mut self.rng) * self.stream_size.y));
                let angle = self.stream_angle + (rand01(&mut self.rng) - 0.5) * self.stream_spread;
                self.spawn(p, angle, 1.0);
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

    /// Write every pool node: live particles' poses, opacity 0 for the rest.
    pub(super) fn write(&mut self, tree: &mut Tree, aux_root: i32, origin: &[V2; 2]) {
        for (k, (view, particle)) in self.views.iter().zip(self.particles.iter()).enumerate() {
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
                * match self.scale_curve {
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
            let alpha = match self.alpha_curve {
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
                self.saved_tex[k].get_or_insert(node.tex);
                node.tex = particle.tex;
                node.sprite_frames = 0;
            }
        }
    }

    /// Hand every pool node back: its styled pose and its own texture.
    pub(super) fn release(&self, tree: &mut Tree) {
        for (view, saved) in self.views.iter().zip(self.saved_tex.iter()) {
            release_view(tree, view.node);
            if let (Some(tex), Some(node)) = (saved, tree.get_mut(view.node)) {
                node.tex = *tex;
            }
        }
    }
}
