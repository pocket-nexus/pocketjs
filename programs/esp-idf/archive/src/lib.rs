#![cfg_attr(not(feature = "std"), no_std)]
pub use pocket_archive::*;
pub use pocket_render_esp_ppa::cabi::*;
/// What a program reads from an application before boot (pocket/package_facts.h).
pub mod package_facts;
pub use package_facts::*;
