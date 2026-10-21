//! Backend-independent damage, composition, and presentation transactions.

#![no_std]

extern crate alloc;

pub mod compositor;
pub mod coordinator;
pub mod damage;
pub mod incremental;
pub mod transaction;

pub use damage::*;
pub use coordinator::{Coordinator, DisplayId, PresentError, RendererId};
pub use transaction::DamageTransaction;
