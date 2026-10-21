//! Backend-independent damage, composition, and presentation transactions.

#![no_std]

extern crate alloc;

pub mod compositor;
pub mod damage;
pub mod incremental;
pub mod transaction;

pub use damage::*;
pub use transaction::DamageTransaction;
