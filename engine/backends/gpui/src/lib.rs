//! pocket-ui-gpui — the gpui render backend (docs/BACKENDS.md).
//!
//! The portable backend family (pocket-ui-wgpu, the core software
//! rasterizer, the PPA/GLES2 ports) executes the DrawList against the baked
//! font atlases, so every host produces byte-identical pixels. This backend
//! keeps the same DrawList contract but paints it through gpui's Metal
//! renderer: rects and gradients become antialiased vector quads, and text
//! runs are measured AND shaped by the host text system (CoreText) when the
//! host installs [`fonts::native_measure`] into the core.
//!
//! What every backend must uphold (docs/DETERMINISM.md) still holds here:
//! rendering is a pure function of the DrawList — nothing in this crate
//! writes core state, and the host ticks the guest on the fixed virtual
//! clock, never from a paint callback.
//!
//! Two DrawList ops keep a pixel-exact escape hatch through the core
//! software rasterizer (`pocket_raster`): gouraud TRIs and
//! TEX_TRIs (rotated images, 3D subtrees) have no gpui vector equivalent,
//! so consecutive batches raster into a cached local image at the target
//! density and paint as one quad.

mod fonts;
mod render;

pub use fonts::{TextConfig, native_measure, native_wrap, slot_line_height, slot_px};
pub use render::GpuiRenderer;
