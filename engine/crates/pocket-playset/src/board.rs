//! Board games on a grid: snakes and the marble plate.
//!
//! Filled in by the snake and marble kernels; the empty board steps nothing.

use crate::scene::Scene;
use crate::world::World;

#[derive(Default)]
pub struct Board {}

impl Board {
    pub fn step(&mut self, _w: &mut World, _scene: &Scene, _dt: f32) {}
}

pub fn step_snake(_w: &mut World, _scene: &Scene, _slot: usize, _arch: usize, _dt: f32) {}
pub fn think_snake(_w: &mut World, _scene: &Scene, _slot: usize, _arch: usize, _dt: f32) {}
pub fn step_marble(_w: &mut World, _scene: &Scene, _slot: usize, _arch: usize, _dt: f32) {}
