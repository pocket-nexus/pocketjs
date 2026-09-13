//! pocket-ui-wgpu — the PocketJS `ui` surface rendered through wgpu.
//!
//! The desktop edition of the 2D UI runtime's native half (docs/RUNTIMES.md).
//! The backend-agnostic surface — the [`pocketjs_core::Ui`] core, pak feeding,
//! and the `ui.*` HostOps mounted into a [`pocket_mod::Guest`] — lives in
//! `pocket-ui-surface` and is re-exported here unchanged. This crate adds the
//! wgpu DrawList backend that renders that core into any render target:
//!
//!   - a window at PSP resolution → the existing PocketJS demos run natively
//!     on macOS (see `examples/uihost`);
//!   - an overlay pass over a 3D scene → a game HUD that is a full PocketJS
//!     app (OpenStrike).
//!
//! 2D and 3D share one base: the same `pocket3d::Gpu` device drives both.

mod blit;
mod overlay;
mod render;

pub use blit::Blit;
pub use overlay::UiOverlay;
pub use render::UiRenderer;
// The backend-agnostic surface (UiSurface + pak walk) — re-exported so desktop
// consumers (uihost, OpenStrike) stay source-compatible after the split.
pub use pocket_ui_surface::{PakEntry, UiSurface, walk_pak};

#[cfg(test)]
mod gpu_tests;
