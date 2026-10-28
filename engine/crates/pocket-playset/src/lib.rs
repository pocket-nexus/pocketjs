//! pocket-playset — the native half of the playset SDK (docs/PLAYSET.md).
//!
//! One `Playset` holds a retained scene (models built from three.js-shaped
//! primitives, static batches, ground, water, environment), an entity world
//! (archetypes, genre motion kernels, brains, weapons, collision rules,
//! particles) and a camera rig. A guest describes content once, then crosses
//! the boundary once per frame: `step`, a scan of the event records, and
//! Float32Array views over the slot arrays in this crate.
//!
//! `render::prepare` turns the state into a frame record (culled draws, joint
//! palettes, dynamic geometry) for a device renderer; the 3DS one lives in
//! devices/3ds/pocket-3ds-playset.
#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;

pub mod audio;
pub mod brains;
pub mod camera;
pub mod collide;
pub mod fmath;
pub mod geom;
pub mod kernels;
pub mod model;
pub mod modules;
pub mod particles;
pub mod render;
pub mod scene;
pub mod schema;
pub mod steer;
pub mod vec;
pub mod world;

mod cabi;

use crate::schema::{env as ENV, stat as S};
use crate::vec::*;
use alloc::boxed::Box;

pub struct Playset {
    pub scene: scene::Scene,
    pub world: world::World,
    pub rig: camera::Rig,
    pub render: render::Builder,
    pub camera_out: [f32; 16],
    pub stats: [f32; 16],
    pub modules: modules::Modules,
}

fn c3(p: &[f32], i: usize) -> Vec3 {
    v3(
        p.get(i).copied().unwrap_or(0.0),
        p.get(i + 1).copied().unwrap_or(0.0),
        p.get(i + 2).copied().unwrap_or(0.0),
    )
}

impl Playset {
    pub fn new(capacity: usize, particles: usize) -> Box<Playset> {
        Box::new(Playset {
            scene: scene::Scene::default(),
            world: world::World::new(capacity, particles),
            rig: camera::Rig::default(),
            render: render::Builder::default(),
            camera_out: [0.0; 16],
            stats: [0.0; 16],
            modules: modules::Modules::default(),
        })
    }

    pub fn env(&mut self, kind: u32, p: &[f32]) {
        let e = &mut self.scene.env;
        let g = |i: usize| p.get(i).copied().unwrap_or(0.0);
        match kind {
            ENV::SKY => {
                e.sky_top = c3(p, 0);
                e.sky_horizon = c3(p, 3);
                e.sky_bottom = if p.len() >= 9 { c3(p, 6) } else { c3(p, 3) };
            }
            ENV::FOG => {
                e.fog_color = c3(p, 0);
                e.fog_start = g(3);
                e.fog_end = g(4);
                e.fog_max = if p.len() > 5 { g(5) } else { 1.0 };
            }
            ENV::LIGHT => {
                e.sun_dir = c3(p, 0).normalized();
                e.sun_color = c3(p, 3);
                e.hemi_sky = c3(p, 6);
                e.hemi_ground = c3(p, 9);
            }
            ENV::BOUNDS => {
                e.bounds_min = v3(g(0), g(2), g(4));
                e.bounds_max = v3(g(1), g(3), g(5));
                e.has_bounds = true;
            }
            ENV::GROUND => {
                let a = [g(2), g(3), g(4)];
                let b = if p.len() >= 8 { [g(5), g(6), g(7)] } else { a };
                self.scene.flat_ground(g(0), if g(1) > 0.0 { g(1) } else { 50.0 }, a, b, g(8));
            }
            ENV::WATER => {
                self.scene.water = scene::Water {
                    active: true,
                    level: g(0),
                    amplitude: g(1),
                    wavelength: if g(2) > 0.0 { g(2) } else { 12.0 },
                    speed: g(3),
                    half: if g(4) > 0.0 { g(4) } else { 60.0 },
                    cells: if g(5) > 0.0 { g(5) as u32 } else { 24 },
                    color: c3(p, 6),
                    deep: if p.len() >= 12 { c3(p, 9) } else { c3(p, 6) * 0.6 },
                };
            }
            ENV::GRAVITY => e.gravity = g(0),
            _ => {}
        }
    }

    pub fn step(&mut self, dt: f32) -> usize {
        let dt = fmath::clampf(dt, 0.0, 0.1);
        self.world.step(&self.scene, dt);
        self.modules.step(&mut self.world, &mut self.scene, dt);
        // deaths a module queued
        self.world.bury();
        self.rig.step(&mut self.world, dt);
        self.hum();
        self.rig.publish(&mut self.camera_out, self.world.time, 400.0 / 240.0);
        self.stats[S::LIVE] = self.world.live.len() as f32;
        self.stats[S::PARTICLES] = self.world.fx.pool.len() as f32;
        self.stats[S::PAIRS] = self.world.pairs as f32;
        self.stats[S::MODELS] = self.scene.models.len() as f32;
        self.stats[S::NODES] = self.scene.nodes.len() as f32;
        self.world.event_count
    }

    /// The camera target's engine loop: started, retuned by speed, stopped.
    fn hum(&mut self) {
        use crate::schema::arch_sound as AS;
        let target = self.rig.d[crate::schema::camera::TARGET] as i32;
        let w = &mut self.world;
        let want = if target >= 0 && w.alive(target as usize) {
            w.arch_of(target as usize).and_then(|a| {
                let s = w.archs[a][AS::HUM];
                if s >= 1.0 {
                    Some((target as usize, a, s as u32 - 1))
                } else {
                    None
                }
            })
        } else {
            None
        };
        match (w.audio.hum, want) {
            (Some((slot, voice, sound)), Some((s, a, snd))) if slot == s && sound == snd => {
                let top = w.archs[a][AS::HUM_SPEED];
                let k = fmath::clampf(fmath::absf(w.e(s, crate::schema::ent::SPEED)) / if top > 0.0 { top } else { 10.0 }, 0.0, 1.0);
                let pmax = if w.archs[a][AS::HUM_PITCH] > 0.0 { w.archs[a][AS::HUM_PITCH] } else { 2.0 };
                let v = w.archs[a][AS::VOLUME];
                let vol = (if v > 0.0 { v } else { 1.0 }) * (0.55 + 0.45 * k);
                w.audio.set_loop(voice, vol, 1.0 + (pmax - 1.0) * k, 0.0);
            }
            (current, want) => {
                if let Some((_, voice, _)) = current {
                    w.audio.stop_loop(voice);
                    w.audio.hum = None;
                }
                if let Some((s, a, snd)) = want {
                    let v = w.archs[a][AS::VOLUME];
                    let voice = w.audio.start_loop(snd, (if v > 0.0 { v } else { 1.0 }) * 0.55, 1.0);
                    w.audio.hum = Some((s, voice, snd));
                }
            }
        }
    }

    pub fn prepare(&mut self, aspect: f32) -> *const render::Frame {
        let f = render::prepare(self, aspect);
        let (eye, fwd, up) = self.rig.basis(self.world.time);
        let right = fwd.cross(up).normalized();
        let far = self.rig.far;
        self.world.audio.finish(eye, right, far);
        let fr = &self.render.frame;
        self.stats[S::DRAWS] = fr.draw_count as f32;
        self.stats[S::TRIS] = fr.tris as f32;
        self.stats[S::CULLED] = fr.culled as f32;
        self.stats[S::STATIC_BATCHES] = (self.scene.batches.len() + self.scene.ground.len()) as f32;
        f
    }
}

#[cfg(test)]
mod tests;
