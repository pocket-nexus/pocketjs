//! The voxel module (filled in with its game's port).

use crate::scene::Scene;
use crate::world::World;

#[derive(Default)]
pub struct Voxels {}

impl Voxels {
    pub fn step(&mut self, _w: &mut World, _scene: &mut Scene, _dt: f32) {}

    pub fn call(&mut self, _w: &mut World, _scene: &mut Scene, _op: u32, _args: &[f32], _out: &mut [f32]) -> f32 {
        -1.0
    }
}
