//! Borrowed `.pocket` and asset-pack readers, plan facts, and identity hashing.
//!
//! Package bytes and platform I/O stay with the caller. This crate preserves
//! the current package format and target/host ABI admission rules; source
//! drivers and runtime orchestration are separate contracts.

#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod package;
pub mod embedded;
pub mod package_format;
pub mod pak;
pub mod plan_facts;
pub mod sha256;
pub mod source;

pub use package::{select_guest, Guest, GuestError, Identity, Package, PackageError, Variant};
pub use plan_facts::{plan_facts, PlanFacts, PlanFactsError, PlanSurface};
