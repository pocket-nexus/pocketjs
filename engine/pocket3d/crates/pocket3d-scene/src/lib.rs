//! `pocket3d-scene` — the authored-scene substrate shared by the constrained
//! Pocket3D backends.
//!
//! `pocket3d-bsp` cooks a GoldSrc map. This crate cooks a scene that no map
//! format produced: procedural terrain, scattered vegetation, props, water and
//! particles, with lighting resolved before the device ever sees it.
//!
//! The runtime side is `no_std` + `alloc` and does no floating-point work per
//! vertex. Everything a fixed-function-class GPU cannot compute — sun and sky
//! irradiance, ambient occlusion, exponential height fog and its sun
//! in-scattering — is evaluated once per vertex by [`light`] at cook time and
//! stored in two packed colors:
//!
//! ```text
//! pixel = albedo x lit + fog.rgb * fog.a
//! ```
//!
//! `lit` already carries `(1 - fog.a)`, so a backend with a multiply blend and
//! an additive blend reproduces linear aerial perspective exactly, with no
//! shader of its own. The Vita backend does this with vita2d's stock shader
//! binaries; the PSP backend gets the same two terms from the GE combiners.
//!
//! Geometry is chunked. Each [`format::Chunk`] carries a bounding sphere for
//! culling, an LOD level, and its own quantization origin and scale, so 16-bit
//! positions keep sub-millimetre precision no matter how large the world is.
//! A backend folds the dequantization into the per-chunk transform it already
//! uploads, so the precision costs nothing at runtime.

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod build;
pub mod cull;
pub mod format;
pub mod light;
mod math;
pub mod particles;
pub mod runtime;
pub mod sky;
pub mod water;

pub use cull::{ChunkVisibility, VisibleSet};
pub use format::{
    Chunk, ChunkFlags, Material, MaterialKind, MaterialRole, Object, RiverSample, Scatter, Scene,
    SceneError, SceneHeader, Texture, VERTEX_STRIDE, WaterParams,
};
pub use light::{BakeInputs, FogTerms, Lighting, pack_abgr};
pub use runtime::{DynamicMesh, DynamicVertex, ViewPoint};
