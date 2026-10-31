//! The state a game shares with the renderer. Entities live in one Float32Array
//! the TypeScript SDK writes in place; the rest is set through host calls.
use crate::math::{self, Vec3};

/// Floats per entity: position (0..3), Y-X-Z euler rotation (3..6), scale
/// (6..9), rgb (9..12), emissive (12), mesh id (13), flags (14), alpha (15).
pub const STRIDE: usize = 16;
pub const MAX_ENTITIES: usize = 4096;
pub const FLAG_VISIBLE: u32 = 1;
pub const FLAG_SHADOW: u32 = 2;

#[derive(Clone, Debug)]
pub struct Scene {
    pub eye: Vec3,
    pub target: Vec3,
    pub fov: f32,
    pub near: f32,
    pub far: f32,
    pub sky: Vec3,
    pub fog_color: Vec3,
    pub fog_near: f32,
    pub fog_far: f32,
    /// The direction sunlight travels.
    pub sun: Vec3,
    pub sun_color: Vec3,
    pub ambient_top: Vec3,
    pub ambient_bottom: Vec3,
    /// Height of the plane blob shadows fall on.
    pub ground: f32,
    /// A host's own camera, in place of eye, target and fov.
    pub view_projection: Option<crate::math::Mat4>,
    /// Clear color and depth first; a host drawing props over a room clears nothing.
    pub clear: bool,
}

impl Default for Scene {
    fn default() -> Self {
        Self {
            eye: [0.0, 8.0, 12.0],
            target: [0.0, 0.0, 0.0],
            fov: 50f32.to_radians(),
            near: 0.1,
            far: 300.0,
            sky: [0.11, 0.09, 0.19],
            fog_color: [0.11, 0.09, 0.19],
            fog_near: 60.0,
            fog_far: 180.0,
            sun: [-0.5, -0.9, -0.35],
            sun_color: [0.78, 0.74, 0.66],
            ambient_top: [0.52, 0.5, 0.62],
            ambient_bottom: [0.24, 0.2, 0.28],
            ground: 0.0,
            view_projection: None,
            clear: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Particle {
    pub position: Vec3,
    pub velocity: Vec3,
    pub color: Vec3,
    pub size: f32,
    pub life: f32,
    pub span: f32,
    pub gravity: f32,
}

pub fn step_particles(particles: &mut Vec<Particle>, dt: f32) {
    for particle in particles.iter_mut() {
        particle.life -= dt;
        particle.velocity[1] -= particle.gravity * dt;
        for axis in 0..3 {
            particle.position[axis] += particle.velocity[axis] * dt;
        }
    }
    particles.retain(|particle| particle.life > 0.0);
}

/// Deterministic particle bursts: xorshift seeded by the game's own tick.
#[allow(clippy::too_many_arguments)]
pub fn burst(
    particles: &mut Vec<Particle>,
    seed: &mut u32,
    center: Vec3,
    color: Vec3,
    count: u32,
    speed: f32,
    life: f32,
    size: f32,
) {
    let mut next = || {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 17;
        *seed ^= *seed << 5;
        (*seed as f32) / (u32::MAX as f32)
    };
    for _ in 0..count.min(256) {
        if particles.len() >= 2048 {
            break;
        }
        let direction = math::normalize([next() - 0.5, next() * 0.8, next() - 0.5]);
        let velocity = speed * (0.4 + next() * 0.6);
        particles.push(Particle {
            position: center,
            velocity: [
                direction[0] * velocity,
                direction[1] * velocity,
                direction[2] * velocity,
            ],
            color,
            size,
            life,
            span: life,
            gravity: speed * 1.4,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn particles_expire_and_stay_bounded() {
        let mut particles = Vec::new();
        let mut seed = 1;
        burst(
            &mut particles,
            &mut seed,
            [0.0; 3],
            [1.0; 3],
            1000,
            3.0,
            0.5,
            0.1,
        );
        assert_eq!(particles.len(), 256);
        for _ in 0..40 {
            step_particles(&mut particles, 1.0 / 60.0);
        }
        assert!(particles.is_empty());
    }
}
