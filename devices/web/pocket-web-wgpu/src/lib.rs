//! The browser's device kernel for a Pocket3D game drawn with wgpu.
//!
//! This crate is part of Pocket3D and is under the Pocket3D License
//! (`pocket3d/LICENSE`): a distributed game that draws its scenes with it
//! shows the Pocket3D title card at every start.
//!
//! A game owns its scene: its pack, its pipelines, what a frame draws. What
//! every such game needs around that is here:
//!
//! - [`gpu`]: the device, and the [`gpu::Screen`] a frame goes to: a canvas in
//!   a browser tab (WebGPU), or a texture on the build machine that is read
//!   back, so the same renderer writes a picture to a file.
//! - [`picture`]: pictures of 16 bits a texel (`r5 g6 b5`, as the handheld
//!   packs store them) as textures WebGPU can read.
//! - [`overlay`]: a premultiplied picture laid over a frame in a pass of its
//!   own: a game's PocketJS interface, as the UI core rasterizes it.
//! - [`source`]: ranges of a file, over HTTP in a tab and from disk elsewhere.
//! - [`task`]: something that waits, started from a frame.
//!
//! The page's side is `web/`: the title card first and the frame loop
//! (`pocket3d-shell.js`), the interface's guest in PocketJS's realm and its
//! lines (`pocket3d-interface.js`), a handheld's controls from keys, pointers
//! and buttons on the page (`pocket3d-controls.js`), and the screens of a
//! device laid out on the page (`pocket3d-stage.js`). `README.md` states what
//! a game implements and what it is given.

pub mod gpu;
pub mod overlay;
pub mod picture;
pub mod source;
pub mod task;

pub use wgpu;
