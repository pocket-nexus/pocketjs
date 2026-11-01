#![no_std]
#![allow(static_mut_refs)]

//! PSP program composition and native embedding interface.
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

mod allocator;
pub use pocket_psp_alloc::arena;
pub use pocket_psp_alloc::c_heap;
pub use pocket_psp_audio::output as audio;
pub use pocket_psp_audio::streams as audio_mod;
pub mod dbg;
pub mod fs_ops;
pub mod scene;
pub mod service_bindings;
pub use scene as ge;
pub mod host;
pub use pocket_psp_io::link;
pub mod media;
pub mod media_wire;
mod instance;
/// The exported profile this EBOOT was built for (`psp` or `psp-runtime`);
/// build.rs copies it into OUT_DIR from `POCKETJS_PROFILE_RS`.
pub mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}
mod program;
pub use program::Runtime;
#[cfg(feature = "runtime")]
pub mod package_file;
pub use pocket_package::pak;
pub use pocket_psp_quickjs_alloc as qjs_alloc;
pub mod stats;
pub use pocket_psp_io::mailbox as svc;
pub mod switch;
pub mod veil;
pub mod vid;

pub mod offload;
pub mod offload_image;
pub use pocket_psp_io::local as offload_local;
pub use pocket_psp_io::packet as offload_packet;
