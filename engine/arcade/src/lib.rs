//! Pocket Arcade: small 3D games written in TypeScript and drawn by Rust.
//!
//! The Rust side owns the GLES 3 instanced renderer, a 2D text and rectangle
//! layer, particles, a synth, and a QuickJS runtime per game. The TypeScript
//! side (`ts/arcade.ts`, imported as `@pocketjs/framework/arcade`) owns entity
//! allocation, input edges and the game loop's structure, writing entity
//! transforms into one Float32Array the renderer reads each frame.
pub mod game;
#[cfg(target_os = "linux")]
pub mod gl;
#[cfg(target_os = "linux")]
pub mod hud;
pub mod math;
#[cfg(target_os = "linux")]
pub mod render;
pub mod script;
pub mod shapes;
pub mod synth;
pub mod world;

#[cfg(not(target_os = "linux"))]
pub mod hud {
    //! Text alignment; the text layer itself is Linux-only.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum Align {
        Left,
        Center,
        Right,
    }
}
