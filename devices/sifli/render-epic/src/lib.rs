//! EPIC rendering for SiFli SF32LB5x with ordered software fallback.
//!
//! The target is a device-owned RGB565 framebuffer. The DrawList is decoded
//! once per frame into a plan; for every damage rectangle the emitter turns
//! that plan into [`Cmd`]s for an [`Executor`], or into batches the core
//! rasterizer draws into SRAM tiles that the executor copies out of and back
//! into the framebuffer, all in painter order. What may go to hardware is
//! decided from the executor's [`Capabilities`]; executors never decline a
//! command the planner was allowed to build.
//!
//! Textures reach hardware through registrations: native copies from the
//! `.epic` table the program links, or the core's portable bytes when VG
//! Lite reads them.
#![no_std]
extern crate alloc;

#[cfg(feature = "cabi")]
pub mod cabi;
pub mod caps;
pub mod cmd;
mod emit;
pub mod executor;
pub mod geom;
mod mask;
pub mod native;
mod ops;
mod plan;
mod quad;
mod renderer;
mod textures;

pub use caps::{Capabilities, Thresholds};
pub use cmd::{Cmd, Corners, Filter, MaskId, MaskRef, Mirror, TexSrc, TileId, MODULATE_NONE};
pub use executor::{ExecError, Executor, NativeFormat, TextureFormat, TextureSource};
pub use geom::{Clip, Point, Quad, Rect};
pub use native::{source_digest, NativeTable, NativeTexture};
pub use renderer::{EpicRenderer, RenderStats, RendererConfig, Submission};
