//! Genre engines that plug into a playset: each owns its state, a call table
//! the guest reaches through `playset.call(module, op, args, out)`
//! (`pps_call`), and a per-step hook that runs after the world's step.
//!
//! A module writes into the shared world (slots, events) and scene (ground
//! tiles for meshes it rebuilds, dynamic nodes for boards it tilts); it adds
//! no ABI of its own. Module ids are contracts/spec/playset.ts PLAYSET_MODULE.

use crate::scene::Scene;
use crate::world::World;

/// Module `module`'s event `n` (contracts playsetModuleEvent).
pub const fn event(module: u32, n: u32) -> u32 {
    crate::schema::MODULE_EVENT as u32 + module * 16 + n
}

pub mod marble;
pub mod snake;
pub mod voxel;

#[derive(Default)]
pub struct Modules {
    pub snake: snake::Snakes,
    pub marble: marble::Marble,
    pub voxel: voxel::Voxels,
}

impl Modules {
    pub fn step(&mut self, w: &mut World, scene: &mut Scene, dt: f32) {
        self.snake.step(w, scene, dt);
        self.marble.step(w, scene, dt);
        self.voxel.step(w, scene, dt);
    }

    /// One call: `args` in, results into `out`; the return value is the
    /// call's scalar result (a slot, a count, a height...).
    pub fn call(&mut self, w: &mut World, scene: &mut Scene, module: u32, op: u32, args: &[f32], out: &mut [f32]) -> f32 {
        use crate::schema::module as M;
        match module {
            M::SNAKE => self.snake.call(w, scene, op, args, out),
            M::MARBLE => self.marble.call(w, scene, op, args, out),
            M::VOXEL => self.voxel.call(w, scene, op, args, out),
            _ => -1.0,
        }
    }
}
