//! Borrowed bundle and asset-pack readers, plan facts, and identity hashing.
//!
//! Bundle bytes and platform I/O stay with the caller. This crate owns the
//! bundle format reader, the admission rules (`admission`) and the checks a
//! program's sections pass whichever container holds them; source drivers
//! and runtime orchestration are separate contracts.

#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod admission;
pub mod bundle;
pub mod bytecode;
pub mod embedded;
pub mod font_archive;
pub mod package_format;
pub mod pak;
pub mod plan_facts;
pub mod sha256;
pub mod source;

pub use admission::{HostFacts, Mismatch, Timing};
pub use bundle::{admit_bundle, fnv1a64, Bundle, Guest, GuestError, Identity, PackageError};
pub use plan_facts::{plan_facts, Features, PlanFacts, PlanFactsError, PlanSurface};
pub use source::{admit, admit_stated};
