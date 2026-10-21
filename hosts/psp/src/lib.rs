#![no_std]
#![allow(static_mut_refs)]

//! PocketJS PSP host library — the reusable half of the EBOOT.
//!
//! The `pocketjs-psp` bin is one composition of these pieces (the 2D UI
//! runtime); a game runtime (e.g. OpenStrike's PSP EBOOT) is another: it
//! links the arena allocator, generated QuickJS guest, canonical Runtime,
//! GE driver and private device services, then supplies its native scene.
//! `Runtime::ui` borrows that instance's core; no global UI is installed.
//!
//! Linking this library installs the arena-backed `#[global_allocator]`
//! program-wide — the single-kernel-block
//! memory model from docs/DESIGN.md "Memory (the blocker fix)".

extern crate alloc;

// A crate-root module literally named `alloc` would collide with
// `extern crate alloc` — keep the docs/DESIGN.md file name, alias the module.
#[path = "alloc.rs"]
mod allocator;
pub mod arena;
pub mod audio;
pub mod audio_mod;
pub mod c_heap;
pub mod dbg;
pub mod ffi;
mod framebuffer;
pub mod ge;
pub mod host;
mod instance;
mod program;
pub use program::Runtime;
#[cfg(feature = "runtime")]
pub mod package_file;
pub mod pak;
pub mod qjs_alloc;
pub mod stats;
pub mod svc;
pub mod switch;
pub mod veil;
pub mod vid;

pub mod offload;
pub mod offload_image;
pub mod offload_local;
pub mod offload_packet;
