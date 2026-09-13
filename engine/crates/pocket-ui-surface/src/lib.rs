//! pocket-ui-surface — the backend-agnostic half of the PocketJS `ui` surface.
//!
//! Owns a [`pocketjs_core::Ui`] core, feeds it app paks (styles, font atlases,
//! images, sprites — the same walk as the PSP's `hosts/psp/src/pak.rs`), and
//! mounts the `ui.*` HostOps surface into a [`pocket_mod::Guest`]. It has NO
//! renderer dependency: the desktop wgpu host (`pocket-ui-wgpu`) and the
//! PocketBook e-ink host (`hosts/pocketbook`) both build on it, pairing it with
//! their own DrawList backends (docs/RUNTIMES.md — a runtime is
//! ⟨Cores, Surfaces, Guest⟩; this crate is the Surface mechanism).

mod dbg;
mod pak;
mod surface;

pub use pak::{PakEntry, find_pak, walk_pak};
pub use surface::UiSurface;

pub mod offload;
