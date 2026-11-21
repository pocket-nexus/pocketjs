//! Deterministic physical and reactive world state for Pocket3D.
//!
//! This crate contains no renderer, window, or asset types. Games submit
//! interactions, advance one fixed turn, consume ordered events, and map the
//! resulting entity snapshot to any presentation backend.

mod exposure;
mod locomotion;
mod rng;
mod types;
mod world;

pub use exposure::*;
pub use locomotion::*;
pub use rng::WorldRng;
pub use types::*;
pub use world::{SpawnError, World};
