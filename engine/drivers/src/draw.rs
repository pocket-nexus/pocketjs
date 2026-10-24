//! DrawList word storage and captured text boxes.

use alloc::vec::Vec;

/// The core -> backend command list: flat little-endian u32 words.
/// Format pinned in contracts/spec/spec.ts ("DRAWLIST op format"); op codes in
/// spec::draw_op. On wasm the host reads this as a Uint32Array; on PSP,
/// programs/psp/src/scene.rs walks it into sceGu calls. The words are the COMPLETE
/// pixel truth — TEXT_RUN packs its run string's UTF-8 bytes into the stream,
/// so snapshots, hashes and damage diffs never need side data.
pub struct DrawList {
    pub words: Vec<u32>,
    /// Armed by `Ui::capture_texts` with a node id: the next build of this
    /// list records every text run painted inside that node's subtree, with
    /// its visible world box, into `texts`, then disarms (0). The agent reads
    /// a screen this way (contracts/spec/agent.ts).
    pub capture_texts: i32,
    pub texts: Vec<TextBox>,
    /// Paint that repeats exactly when content moves by whole logical
    /// pixels: axis-aligned world translations round to whole pixels, and a
    /// partially clipped gradient is emitted as SCISSOR, the unclipped
    /// GRAD_RECT, SCISSOR_POP so its colors do not depend on the clip. For
    /// backends that clip in software: the unclipped rect may leave the
    /// viewport.
    pub stable_motion_paint: bool,
}

/// One painted text run: its visible box (clipped, world px) and its text.
#[derive(Debug, Clone, PartialEq)]
pub struct TextBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub text: alloc::string::String,
}

impl DrawList {
    pub fn new() -> Self {
        DrawList {
            words: Vec::new(),
            capture_texts: 0,
            texts: Vec::new(),
            stable_motion_paint: false,
        }
    }
}

impl Default for DrawList {
    fn default() -> Self {
        Self::new()
    }
}
