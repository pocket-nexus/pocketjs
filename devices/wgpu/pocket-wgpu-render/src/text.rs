//! `TEXT_RUN`: runs the host text system measured, painted by that system.
//!
//! The core emits `TEXT_RUN` only when the host installed a native measurer
//! (docs/BACKENDS.md). A host that does registers a [`TextPainter`] with
//! [`WgpuRenderer::set_text_painter`]; the renderer asks it for a bitmap per
//! distinct run (text, slot, alignment, box width, line height, opaque colour,
//! scale), keeps the bitmap as a texture, and draws it as one image quad
//! modulated by the run's alpha. Without a painter `TEXT_RUN` stays
//! `RenderError::Unsupported`.

use crate::*;
use pocket_render::{TextQuad, TextRun};

/// One `TEXT_RUN` as a [`TextPainter`] receives it. Lengths are logical px.
pub struct TextRunRequest<'a> {
    /// The run's lines, separated by `'\n'` (the core's only line break).
    pub text: &'a str,
    pub slot: u8,
    /// The TextAlign ordinal (contracts/spec/spec.ts).
    pub align: u8,
    /// The content-box width lines align within.
    pub box_width: f32,
    /// The line pitch; NaN means the slot's default.
    pub line_height: f32,
    /// px added after each character.
    pub tracking: f32,
    /// ABGR with alpha 255. The renderer applies the run's alpha when it draws.
    pub color: u32,
    /// Device px per logical px.
    pub scale: f32,
}

/// A bitmap a [`TextPainter`] produced for one run.
pub struct PaintedText {
    pub width: u32,
    pub height: u32,
    /// `width * height` straight-alpha RGBA8 texels; colour channels are
    /// sRGB-encoded, as DrawList colours are.
    pub rgba: Vec<u8>,
    /// The logical offset of the bitmap's top-left corner from the run origin.
    pub offset: [f32; 2],
}

/// The host text system that measured the runs paints them.
pub trait TextPainter {
    /// The bitmap of `run` at `run.scale`, or `None` when it draws nothing.
    fn paint(&mut self, run: &TextRunRequest<'_>) -> Option<PaintedText>;
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct TextKey {
    text: Vec<u8>,
    slot: u8,
    align: u8,
    box_width: u32,
    line_height: u32,
    tracking: u32,
    color: u32,
    scale: u32,
}

struct TextEntry {
    key: TextKey,
    bind: Option<wgpu::BindGroup>,
    offset: [f32; 2],
    size: [f32; 2],
    used: u64,
    bytes: usize,
}

/// Bitmaps of runs, retained while frames keep drawing them.
#[derive(Default)]
pub(crate) struct TextRuns {
    painter: Option<Box<dyn TextPainter>>,
    keys: HashMap<TextKey, u64>,
    entries: HashMap<u64, TextEntry>,
    next: u64,
    frame: u64,
    bytes: usize,
}

/// Runs a frame has not drawn for this many frames release their bitmaps.
const IDLE_FRAMES: u64 = 240;
/// Above this many bitmap bytes, the least recently drawn runs release theirs.
const BUDGET_BYTES: usize = 96 << 20;

impl TextRuns {
    pub(crate) fn set_painter(&mut self, painter: Option<Box<dyn TextPainter>>) {
        self.painter = painter;
        self.clear();
    }
    pub(crate) fn clear(&mut self) {
        self.keys.clear();
        self.entries.clear();
        self.bytes = 0;
    }
    pub(crate) fn has_painter(&self) -> bool {
        self.painter.is_some()
    }
    pub(crate) fn resident(&self) -> usize {
        self.entries.len()
    }
    /// Start a frame: release bitmaps idle for [`IDLE_FRAMES`], then the least
    /// recently drawn ones while over [`BUDGET_BYTES`]. A pass that drew a
    /// released bitmap keeps its own reference to the bind group.
    pub(crate) fn begin_frame(&mut self) {
        self.frame += 1;
        let frame = self.frame;
        let idle: Vec<u64> = self
            .entries
            .iter()
            .filter(|(_, entry)| frame - entry.used > IDLE_FRAMES)
            .map(|(id, _)| *id)
            .collect();
        for id in idle {
            self.remove(id);
        }
        if self.bytes > BUDGET_BYTES {
            let mut order: Vec<(u64, u64)> = self
                .entries
                .iter()
                .map(|(id, entry)| (entry.used, *id))
                .collect();
            order.sort_unstable();
            for (_, id) in order {
                if self.bytes <= BUDGET_BYTES {
                    break;
                }
                self.remove(id);
            }
        }
    }
    fn remove(&mut self, id: u64) {
        if let Some(entry) = self.entries.remove(&id) {
            self.bytes -= entry.bytes;
            self.keys.remove(&entry.key);
        }
    }
    pub(crate) fn bind(&self, id: u64) -> Option<wgpu::BindGroup> {
        self.entries.get(&id).and_then(|entry| entry.bind.clone())
    }
}

impl WgpuRenderer {
    /// Paint `TEXT_RUN` with `painter`, the host text system whose measurer
    /// and wrapper the core uses (`Ui::set_text_measure`/`set_text_wrap`).
    /// `None` makes `TEXT_RUN` unsupported again. Either way the retained
    /// run bitmaps are released.
    pub fn set_text_painter(&mut self, painter: Option<Box<dyn TextPainter>>) {
        self.text.set_painter(painter);
    }
    /// Run bitmaps currently retained.
    pub fn resident_text_runs(&self) -> usize {
        self.text.resident()
    }
    pub(crate) fn text_run(
        &mut self,
        run: &TextRun<'_>,
        scale: f32,
    ) -> Result<Option<TextQuad<TexBind>>, RenderError> {
        if self.text.painter.is_none() {
            return Err(RenderError::Unsupported);
        }
        if !(run.origin[0].is_finite() && run.origin[1].is_finite() && run.box_width.is_finite()) {
            return Err(RenderError::InvalidFrame);
        }
        let alpha = run.color >> 24;
        if alpha == 0 || run.bytes == 0 {
            return Ok(None);
        }
        let key = TextKey {
            text: run.text_bytes(),
            slot: run.slot,
            align: run.align,
            box_width: run.box_width.to_bits(),
            line_height: run.line_height.to_bits(),
            tracking: run.tracking.to_bits(),
            color: run.color | 0xff00_0000,
            scale: scale.to_bits(),
        };
        let frame = self.text.frame;
        let id = match self.text.keys.get(&key) {
            Some(id) => *id,
            None => {
                let text =
                    core::str::from_utf8(&key.text).map_err(|_| RenderError::InvalidFrame)?;
                let request = TextRunRequest {
                    text,
                    slot: run.slot,
                    align: run.align,
                    box_width: run.box_width,
                    line_height: run.line_height,
                    tracking: run.tracking,
                    color: key.color,
                    scale,
                };
                let painted = self.text.painter.as_mut().unwrap().paint(&request);
                let limit = self.gpu.device.limits().max_texture_dimension_2d;
                let entry = match painted {
                    Some(p) if p.width > 0 && p.height > 0 => {
                        if p.width > limit
                            || p.height > limit
                            || p.rgba.len() != p.width as usize * p.height as usize * 4
                            || !(p.offset[0].is_finite() && p.offset[1].is_finite())
                        {
                            return Err(RenderError::InvalidFrame);
                        }
                        let bind = self.gpu.upload_image(
                            &self.bind_layout,
                            &self.sampler,
                            self.image_format,
                            &p.rgba,
                            p.width,
                            p.height,
                        );
                        TextEntry {
                            key: key.clone(),
                            bind: Some(bind),
                            offset: p.offset,
                            size: [p.width as f32 / scale, p.height as f32 / scale],
                            used: frame,
                            bytes: p.rgba.len(),
                        }
                    }
                    // Remember runs that draw nothing (all spaces) as well.
                    _ => TextEntry {
                        key: key.clone(),
                        bind: None,
                        offset: [0.0; 2],
                        size: [0.0; 2],
                        used: frame,
                        bytes: 0,
                    },
                };
                self.text.next += 1;
                let id = self.text.next;
                self.text.bytes += entry.bytes;
                self.text.keys.insert(key, id);
                self.text.entries.insert(id, entry);
                id
            }
        };
        let entry = self.text.entries.get_mut(&id).unwrap();
        entry.used = frame;
        if entry.bind.is_none() {
            return Ok(None);
        }
        // Whole device pixels: the bitmap was drawn at this scale, so texels
        // land on pixels and sample without blur.
        let snap = |v: f32| (v * scale).round() / scale;
        let x0 = snap(run.origin[0] + entry.offset[0]);
        let y0 = snap(run.origin[1] + entry.offset[1]);
        Ok(Some(TextQuad {
            texture: TexBind::Text(id),
            rect: [x0, y0, x0 + entry.size[0], y0 + entry.size[1]],
            uv: [0.0, 0.0, 1.0, 1.0],
            color: (alpha << 24) | 0x00ff_ffff,
        }))
    }
}
