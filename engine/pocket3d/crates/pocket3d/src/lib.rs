//! Pocket3D desktop rendering mechanisms used by widgets and applications.
//! Domain compilers and renderers belong to their applications. This crate is
//! one member of the Pocket3D family, not a cross-device engine contract.

pub mod anim;
pub mod app;
pub mod camera;
pub mod geometry;
pub mod gpu;
pub mod hud;
pub mod input;
pub mod model;
pub mod renderer;
pub mod scene;
pub mod texture;
pub mod time;
/// Compatibility name for static render geometry. Simulation lives in pocket3d-world.
pub use geometry as world;

pub use anyhow;
pub use glam;
pub use wgpu;
pub use winit;

pub mod prelude {
    pub use crate::anim::AnimState;
    pub use crate::app::{AppConfig, Game};
    pub use crate::camera::Camera;
    pub use crate::geometry::WorldModel;
    pub use crate::gpu::{DEPTH_FORMAT, Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
    pub use crate::hud::Hud;
    pub use crate::input::Input;
    pub use crate::model::{ModelAsset, ModelInstance};
    pub use crate::renderer::Renderer;
    pub use crate::scene::Scene;
    pub use crate::scene::{Beam, Sprite};
    pub use crate::time::FixedTimestep;
    pub use glam::{Mat4, Quat, Vec2, Vec3, Vec4};
}
