#![no_std]
#![allow(static_mut_refs)]

//! PSP program composition and native embedding interface.
//!
//! The `pocketjs-psp` bin is one composition of these pieces: `module!` and
//! the `frame` loop around the embedded application. A program crate in
//! another repository is another: it runs `frame::run` once per guest with
//! its own `frame::Program`, op providers, native globals, textures and
//! native drawing between guests. A game runtime (e.g. OpenStrike's PSP
//! EBOOT) links the arena allocator, generated QuickJS guest, canonical
//! Runtime, GE driver and private device services, then supplies its native
//! scene. `Runtime::ui` borrows that instance's core; no global UI is
//! installed.
//!
//! Linking this library installs the arena-backed `#[global_allocator]`
//! program-wide — the single-kernel-block
//! memory model from docs/DESIGN.md "Memory (the blocker fix)".

extern crate alloc;
/// The QuickJS bindings the guest runs on, for a program's native globals
/// (`frame::Program::globals`): one revision for the library and the program.
pub use libquickjs_sys;
/// The rust-psp crate this library builds on, for `module!` and for a
/// program's native GE drawing.
pub use psp;
// The archive's symbol shells define the pocket_runtime_op and
// pocket_runtime_supports_op the C guest calls (external-runtime: no
// allocator or panic handler of its own).
use pocket_archive as _;

mod allocator;
pub use pocket_psp_alloc::arena;
pub use pocket_psp_alloc::c_heap;
pub use pocket_psp_audio::output as audio;
pub use pocket_psp_audio::streams as audio_mod;
pub mod dbg;
pub mod embedded;
pub mod frame;
pub mod fs_ops;
pub mod pack_ops;
pub mod scene;
pub mod service_bindings;
pub use scene as ge;
pub mod host;
mod instance;
pub use instance::with_ui;
/// The exported profile this EBOOT was built for (`psp`, `psp-runtime` or a
/// program's own psp profile); build.rs copies it into OUT_DIR from
/// `POCKETJS_PROFILE_RS`.
pub mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}
mod program;
pub use program::{Options, Runtime};
#[cfg(feature = "runtime")]
pub mod package_file;
pub use pocket_package::pak;
pub use pocket_psp_quickjs_alloc as qjs_alloc;
pub mod stats;
pub use pocket_psp_io::mailbox as svc;
pub mod vid;

pub mod offload;
pub mod offload_image;
pub use pocket_psp_io::local as offload_local;
pub use pocket_psp_io::packet as offload_packet;
