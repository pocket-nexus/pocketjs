//! Forwarding crate for the former `pocket-present` modules.
//!
//! Every item keeps its `pocket_present` path and is the item itself:
//! `damage` and `DamageTransaction` are in `pocket_render::damage`,
//! `compositor` and `incremental` in `pocket_raster`, `coordinator` in
//! `pocket_runtime::coordinator`, and `ink` in `pocket_drivers::ink`. New code
//! depends on those crates.

#![no_std]

pub use pocket_drivers::ink;
pub use pocket_raster::{compositor, incremental};
pub use pocket_render::damage;
pub use pocket_runtime::coordinator;

pub mod transaction {
    pub use pocket_render::damage::DamageTransaction;
}

pub use coordinator::{Coordinator, DisplayId, PresentError, RendererId};
pub use damage::*;
pub use transaction::DamageTransaction;
