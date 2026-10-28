//! ESP PPA rendering with ordered software fallback and bounded A8 storage.
//! Hardware operations finish before returning, including error paths. A
//! declined operation or a strip the device cannot address draws in
//! software; frame damage bounds every path to the dirty pixels.
//!
//! A strip visits the ops whose rows reach it, from an index built once per
//! DrawList; painting starts at the last opaque rectangle that covers the
//! strip, and later opaque rectangles cut the pieces of an op they hide.
//! Work below the PPA's worth stays on the CPU: a transaction costs about as
//! much as blending [`CPU_BLEND_MAX_PIXELS`] in software.
#![no_std]
extern crate alloc;
#[cfg(feature = "cabi")]
pub mod cabi;
use alloc::vec::Vec;
use pocket_draw_ops::{word_len, Operation, MAX_CLIP_DEPTH};
use pocket_drivers::{
    DamageRect as Clip, PixelFormat, Rect as Region, RenderError, RenderResources, Surface, TexView,
};
use pocket_glyph_pages::composite_mask;
use pocket_raster::{
    blend_rgb565_pixel, coverage_index, lerp_color, linear_sample_coordinates, pack_rgb565,
    render_operation, texel, LinearSample, OperationResources,
};
use pocket_spec as spec;
const MASK_ALIGNMENT: usize = 128;
/// Translucent work up to this many physical pixels blends on the CPU: a PPA
/// transaction costs about as much as blending this area in software.
pub const CPU_BLEND_MAX_PIXELS: u32 = 2048;
const TEXTURE_CLASS_CACHE_LEN: usize = 64;
/// Later opaque covers checked for each op, and the pieces one op keeps.
const COVERS_AHEAD: usize = 8;
const MAX_PIECES: usize = 8;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PpaError {
    Unsupported,
    Failed,
}
fn accelerated(result: Result<(), PpaError>) -> Result<bool, RenderError> {
    match result {
        Ok(()) => Ok(true),
        Err(PpaError::Unsupported) => Ok(false),
        Err(PpaError::Failed) => Err(RenderError::Failed),
    }
}
/// Integer pixel rectangle, using half-open bounds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    #[inline]
    pub const fn area(self) -> u32 {
        self.w.saturating_mul(self.h)
    }

    #[inline]
    pub const fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }
}

/// Quarter-turn transform supported by the PPA SRM engine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QuarterTurn {
    #[default]
    None,
    Ccw90,
    Ccw180,
    Ccw270,
}

/// Scale/rotate/mirror controls passed to the host's PPA SRM implementation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SrmTransform {
    pub rotation: QuarterTurn,
    pub mirror_x: bool,
    pub mirror_y: bool,
}

/// Narrow hardware surface implemented by an ESP-IDF host.
///
/// All calls are synchronous from the DrawList interpreter's perspective:
/// on every return, the destination pixels must be visible to
/// subsequent CPU or PPA operations. `Unsupported` is allowed only before any write and requests ordered
/// software fallback; a transaction the device driver rejects before writing
/// reports it. `Failed` is terminal and prevents display flush.
#[allow(clippy::too_many_arguments)]
pub trait PpaOps {
    /// Fill `rect` in the full RGB565 destination.
    fn fill_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        rect: Rect,
        color: u16,
    ) -> Result<(), PpaError>;

    /// Blend an A8 plane over the full RGB565 destination with one fixed RGB
    /// color. `global_alpha` scales every coverage byte.
    fn blend_a8_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        mask: &[u8],
        rect: Rect,
        color: [u8; 3],
        global_alpha: u8,
    ) -> Result<(), PpaError>;

    /// Copy an opaque PSP PSM 5650 texture into the RGB565 destination with
    /// PPA SRM. PSM 5650 stores R and B opposite to ESP RGB565, so the host
    /// must enable the PPA input RGB swap.
    fn srm_psm5650_to_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        source: &[u8],
        source_width: u32,
        source_height: u32,
        source_rect: Rect,
        destination_rect: Rect,
        transform: SrmTransform,
    ) -> Result<(), PpaError>;

    /// Byte alignment the device requires of a destination address and of the
    /// strip's byte length. The renderer reads it once at construction and
    /// draws strips that miss it in software. Zero means one.
    fn buffer_alignment(&self) -> usize {
        1
    }
}

/// Heuristics controlling when transaction overhead is worth paying.
#[derive(Clone, Copy, Debug)]
pub struct RendererConfig {
    pub scale: u32,
    pub min_fill_pixels: u32,
    pub min_blend_pixels: u32,
    pub min_srm_pixels: u32,
    /// Translucent work at or below this physical area blends on the CPU;
    /// zero offers every blend to the device.
    pub cpu_blend_max_pixels: u32,
}

impl Default for RendererConfig {
    fn default() -> Self {
        Self {
            scale: 1,
            min_fill_pixels: 1024,
            min_blend_pixels: 256,
            min_srm_pixels: 256,
            cpu_blend_max_pixels: CPU_BLEND_MAX_PIXELS,
        }
    }
}

/// Per-frame backend accounting for profiling and regression logs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderStats {
    pub ppa_fills: u32,
    pub ppa_blends: u32,
    pub ppa_srm: u32,
    pub software_ops: u32,
    pub software_words: u32,
    /// Number of disjoint physical framebuffer regions repainted.
    pub damage_regions: u32,
    /// Total physical pixels repainted across all damage regions.
    pub damage_pixels: u32,
    /// Bounding rectangle of every repainted physical region.
    pub damage_bounds: Rect,
    /// True for an initial, invalidated, or heuristically promoted full frame.
    pub full_redraw: bool,
}

/// The logical rows one op can touch, by its word offset.
#[derive(Clone, Copy, Debug)]
struct OpSpan {
    start: u32,
    y0: i32,
    y1: i32,
}

impl OpSpan {
    fn touches(&self, band: Clip) -> bool {
        self.y0 < band.y1 && self.y1 > band.y0
    }
}

/// Op offsets in painter order: every op when `spans` is None, otherwise
/// the indexed ops whose rows meet `band`, starting at word offset `from`.
struct OpCursor<'a> {
    spans: Option<&'a [OpSpan]>,
    band: Clip,
    cursor: usize,
}

impl<'a> OpCursor<'a> {
    fn new(spans: Option<&'a [OpSpan]>, band: Clip, from: usize) -> Self {
        let cursor = spans.map_or(from, |spans| {
            spans.partition_point(|span| (span.start as usize) < from)
        });
        Self { spans, band, cursor }
    }

    /// The next op at or after word offset `from`, or None at the end.
    fn next(&mut self, words: &[u32], from: usize) -> Option<usize> {
        let Some(spans) = self.spans else {
            return (from < words.len()).then_some(from);
        };
        while self.cursor < spans.len()
            && ((spans[self.cursor].start as usize) < from
                || !spans[self.cursor].touches(self.band))
        {
            self.cursor += 1;
        }
        spans.get(self.cursor).map(|span| span.start as usize)
    }
}

/// Painter state at one DrawList position: the op index and its clip stack.
#[derive(Clone, Copy)]
struct PaintStart {
    screen: Clip,
    index: usize,
    clip: Clip,
    stack: [Clip; MAX_CLIP_DEPTH],
    depth: usize,
}

impl PaintStart {
    fn first(screen: Clip) -> Self {
        Self {
            screen,
            index: 0,
            clip: screen,
            stack: [screen; MAX_CLIP_DEPTH],
            depth: 0,
        }
    }

    /// The last opaque RECT or GRAD_RECT that covers all of `screen` hides
    /// the clear and every earlier op, so painting starts there. Any op the
    /// scan cannot decode disables the shortcut.
    fn occluding(words: &[u32], screen: Clip, spans: Option<&[OpSpan]>) -> Option<Self> {
        let mut state = Self::first(screen);
        let mut found = None;
        let mut ops = OpCursor::new(spans, screen, 0);
        let mut next = 0usize;
        while let Some(i) = ops.next(words, next) {
            state.index = i;
            let len = word_len(words, i).ok()?;
            match words[i] {
                spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
                    let opaque = words[i + 3] >> 24 == 255
                        && (words[i] == spec::draw_op::RECT || words[i + 4] >> 24 == 255);
                    if opaque
                        && logical_rect(words[i + 1], words[i + 2]).intersect(state.clip) == screen
                    {
                        found = Some(state);
                    }
                }
                spec::draw_op::SCISSOR => {
                    if state.depth >= MAX_CLIP_DEPTH {
                        return None;
                    }
                    state.stack[state.depth] = state.clip;
                    state.depth += 1;
                    state.clip = screen.intersect(logical_rect(words[i + 1], words[i + 2]));
                }
                spec::draw_op::SCISSOR_POP => {
                    if state.depth > 0 {
                        state.depth -= 1;
                        state.clip = state.stack[state.depth];
                    } else {
                        state.clip = screen;
                    }
                }
                _ => {}
            }
            next = i + len;
        }
        found
    }
}

/// Per-instance painter state. Presentation and persistent-buffer history are
/// owned by pocket-present, never by this driver.
pub struct Painter {
    config: RendererConfig,
    mask_storage: Vec<u128>,
    mask_offset: usize,
    mask_capacity: usize,
    mask_len: usize,
    mask_budget: usize,
    buffer_alignment: usize,
    alpha_texture_cache: Vec<(i32, u64, bool)>,
    raster_revision: u64,
    /// Row spans of the DrawList whose length and word hash are `spans_key`;
    /// `spans_valid` is false when that list holds an op the index does not
    /// decode, and every strip then walks every op.
    spans: Vec<OpSpan>,
    spans_key: Option<(usize, u64)>,
    spans_valid: bool,
    /// Opaque covers of the region being painted (see `collect_covers`).
    covers: Vec<(u32, Clip)>,
}
impl Painter {
    /// mask_budget bounds the A8 payload; alignment storage adds at most 143
    /// bytes. Zero disables A8 acceleration without disabling fill or SRM.
    pub fn new(config: RendererConfig, mask_budget: usize) -> Result<Self, RenderError> {
        if !(1..=pocket_raster::MAX_RENDER_SCALE).contains(&config.scale) {
            return Err(RenderError::Unsupported);
        }
        Ok(Self {
            config,
            mask_storage: Vec::new(),
            mask_offset: 0,
            mask_capacity: 0,
            mask_len: 0,
            mask_budget,
            buffer_alignment: 1,
            alpha_texture_cache: Vec::new(),
            raster_revision: 0,
            spans: Vec::new(),
            spans_key: None,
            spans_valid: false,
            covers: Vec::new(),
        })
    }
    pub fn config(&self) -> RendererConfig {
        self.config
    }
    /// Destination address and strip byte length must be multiples of this
    /// for any device call; other strips draw in software. Zero means one.
    pub fn set_buffer_alignment(&mut self, alignment: usize) {
        self.buffer_alignment = alignment.max(1);
    }
    pub fn buffer_alignment(&self) -> usize {
        self.buffer_alignment
    }
    /// Active A8 payload bytes for the most recent accelerated strip. This is
    /// bounded by mask_budget; allocation includes at most 143 alignment bytes.
    pub fn scratch_bytes(&self) -> usize {
        self.mask_len
    }
    /// Retained allocation, including alignment and previous larger strips.
    pub fn allocated_scratch_bytes(&self) -> usize {
        self.mask_storage.capacity() * core::mem::size_of::<u128>()
    }
    pub fn invalidate_resources(&mut self) {
        self.alpha_texture_cache.clear();
        self.raster_revision = 0;
        self.spans_key = None;
    }
    fn sync_resources(&mut self, resources: &(impl RenderResources + ?Sized)) {
        if self.raster_revision != resources.raster_revision() {
            self.alpha_texture_cache.clear();
            self.raster_revision = resources.raster_revision();
        }
    }
    fn ensure_mask(&mut self, len: usize) -> bool {
        if len > self.mask_budget {
            return false;
        }
        if self.mask_capacity < len {
            let Some(bytes) = len.checked_add(MASK_ALIGNMENT - 1) else {
                return false;
            };
            let count = bytes.div_ceil(16);
            let mut storage = Vec::new();
            if storage.try_reserve_exact(count).is_err() {
                return false;
            }
            storage.resize(count, 0u128);
            self.mask_storage = storage;
            let base = self.mask_storage.as_ptr() as usize;
            self.mask_offset = (MASK_ALIGNMENT - base % MASK_ALIGNMENT) % MASK_ALIGNMENT;
            self.mask_capacity = len;
        }
        self.mask_len = len;
        true
    }
    /// Every device call is synchronous. Unsupported surfaces retain the
    /// software byte path; unaligned RGB565 never becomes a u16 slice.
    pub fn render<O: PpaOps>(
        &mut self,
        resources: &(impl RenderResources + ?Sized),
        words: &[u32],
        target: &mut Surface<'_>,
        ppa: &mut O,
    ) -> Result<RenderStats, RenderError> {
        self.render_clipped(resources, words, target, None, ppa)
    }
    /// `requested` is the logical dirty rectangle, normally the frame's damage
    /// bounds from [`damage_clip`]. Pixels outside it keep their contents;
    /// `None` repaints the whole acquired region.
    pub fn render_clipped<O: PpaOps>(
        &mut self,
        resources: &(impl RenderResources + ?Sized),
        words: &[u32],
        target: &mut Surface<'_>,
        requested: Option<Clip>,
        ppa: &mut O,
    ) -> Result<RenderStats, RenderError> {
        if target.format() != PixelFormat::Rgb565 {
            return Err(RenderError::Unsupported);
        }
        let (vw, vh) = resources.viewport();
        if !vw.is_finite()
            || !vh.is_finite()
            || vw < 1.0
            || vh < 1.0
            || vw >= i32::MAX as f32
            || vh >= i32::MAX as f32
        {
            return Err(RenderError::InvalidFrame);
        }
        let viewport = Clip::new(0, 0, vw as i32, vh as i32);
        pocket_draw_ops::validate(words, viewport).map_err(|_| RenderError::InvalidFrame)?;
        // A no-draw operation applies raster's checked surface/viewport bounds.
        let noop = Operation {
            opcode: spec::draw_op::SCISSOR_POP,
            words: &[spec::draw_op::SCISSOR_POP],
            clip: viewport,
        };
        render_operation(resources, &noop, target, self.config.scale)?;
        self.sync_resources(resources);
        let region = target.region();
        let stride = target.stride_bytes();
        let scale = self.config.scale;
        let count = region.width as usize * region.height as usize;
        let mut stats = RenderStats {
            damage_regions: 1,
            damage_pixels: region.width.saturating_mul(region.height),
            damage_bounds: Rect {
                x: region.x,
                y: region.y,
                w: region.width,
                h: region.height,
            },
            full_redraw: requested.is_none(),
            ..RenderStats::default()
        };
        // The device addresses the packed strip as one output buffer; IDF
        // rejects an address or byte length off its DMA cache line.
        let hardware = region.x % scale == 0
            && region.y % scale == 0
            && region.width % scale == 0
            && region.height % scale == 0
            && stride == region.width as usize * 2
            && target.pixels().as_ptr().align_offset(2) == 0
            && (target.pixels().as_ptr() as usize).is_multiple_of(self.buffer_alignment)
            && (count * 2).is_multiple_of(self.buffer_alignment);
        let surface = Clip::new(
            (region.x / scale) as i32,
            (region.y / scale) as i32,
            ((region.x + region.width).div_ceil(scale)) as i32,
            ((region.y + region.height).div_ceil(scale)) as i32,
        );
        let draw_clip = requested
            .unwrap_or(surface)
            .intersect(surface)
            .intersect(viewport);
        let physical = physical_rect(draw_clip, scale);
        let x0 = physical.x.max(region.x);
        let y0 = physical.y.max(region.y);
        let x1 = (physical.x + physical.w).min(region.x + region.width);
        let y1 = (physical.y + physical.h).min(region.y + region.height);
        let physical = Rect {
            x: x0,
            y: y0,
            w: x1.saturating_sub(x0),
            h: y1.saturating_sub(y0),
        };
        if requested.is_some() {
            stats.damage_pixels = physical.area();
            stats.damage_bounds = physical;
        }
        if draw_clip.is_empty() || physical.is_empty() {
            return Ok(stats);
        }
        // Every strip of a frame, on either lane, sees the same list: its
        // length and word hash key the index.
        let key = (words.len(), words_signature(words));
        if self.spans_key != Some(key) {
            self.spans_valid = self.index_ops(resources, words);
            self.spans_key = Some(key);
        }
        let spans = core::mem::take(&mut self.spans);
        let span_view = self.spans_valid.then_some(&spans[..]);
        let start = PaintStart::occluding(words, draw_clip, span_view);
        if start.is_none() {
            let clear = Rect {
                x: physical.x - region.x,
                y: physical.y - region.y,
                w: physical.w,
                h: physical.h,
            };
            let mut cleared = false;
            if hardware && clear.area() >= self.config.min_fill_pixels {
                let pixels = strip_pixels(target, count);
                let filled =
                    accelerated(ppa.fill_rgb565(pixels, region.width, region.height, clear, 0));
                cleared = match filled {
                    Ok(cleared) => cleared,
                    Err(error) => {
                        self.spans = spans;
                        return Err(error);
                    }
                };
                if cleared {
                    stats.ppa_fills += 1;
                }
            }
            if !cleared {
                if requested.is_none() && !hardware {
                    // Physical acquisitions need not begin on a logical-pixel edge.
                    for row in 0..region.height as usize {
                        target.pixels_mut()[row * stride..row * stride + region.width as usize * 2]
                            .fill(0);
                    }
                } else {
                    for row in clear.y as usize..(clear.y + clear.h) as usize {
                        let start = row * stride + clear.x as usize * 2;
                        target.pixels_mut()[start..start + clear.w as usize * 2].fill(0);
                    }
                }
            }
        }
        let result = self.render_region(
            resources,
            words,
            target,
            count,
            hardware,
            surface,
            start.unwrap_or(PaintStart::first(draw_clip)),
            span_view,
            ppa,
            &mut stats,
        );
        self.spans = spans;
        result?;
        Ok(stats)
    }

    /// Record the logical rows each op can touch. Returns false for a list
    /// with an op the index does not decode; strips then walk every op.
    fn index_ops(&mut self, resources: &(impl RenderResources + ?Sized), words: &[u32]) -> bool {
        self.spans.clear();
        let everywhere = Clip::new(i32::MIN / 2, i32::MIN / 2, i32::MAX / 2, i32::MAX / 2);
        let mut i = 0usize;
        while i < words.len() {
            let Ok(len) = word_len(words, i) else {
                return false;
            };
            let rows = match words[i] {
                spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
                    Some(logical_rect(words[i + 1], words[i + 2]))
                }
                spec::draw_op::TEX_QUAD => Some(logical_rect(words[i + 2], words[i + 3])),
                spec::draw_op::GLYPH_RUN => {
                    Some(glyph_run_bounds(resources, &words[i..i + len], everywhere))
                }
                spec::draw_op::TRI => {
                    Some(triangle_bounds([words[i + 1], words[i + 2], words[i + 3]], everywhere))
                }
                spec::draw_op::TEX_TRI => {
                    Some(triangle_bounds([words[i + 2], words[i + 5], words[i + 8]], everywhere))
                }
                spec::draw_op::SCISSOR | spec::draw_op::SCISSOR_POP | spec::draw_op::TEXT_RUN => {
                    Some(everywhere)
                }
                // Painting skips application surfaces on this target.
                spec::draw_op::SURFACE_QUAD => None,
                _ => return false,
            };
            if let Some(rows) = rows.filter(|rows| !rows.is_empty()) {
                self.spans.push(OpSpan {
                    start: i as u32,
                    y0: rows.y0,
                    y1: rows.y1,
                });
            }
            i += len;
        }
        true
    }

    /// Paint the ops of one strip from `start`. `count` is the strip's pixel
    /// count and `hardware` whether the device may address it.
    #[allow(clippy::too_many_arguments)]
    fn render_region<O: PpaOps>(
        &mut self,
        resources: &(impl RenderResources + ?Sized),
        words: &[u32],
        target: &mut Surface<'_>,
        count: usize,
        hardware: bool,
        surface: Clip,
        start: PaintStart,
        spans: Option<&[OpSpan]>,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Result<(), RenderError> {
        let scale = self.config.scale;
        let region = target.region();
        let (width, height) = (region.width, region.height);
        let mask_ready = hardware && self.ensure_mask(count);
        let screen = start.screen;
        let mut covers = core::mem::take(&mut self.covers);
        collect_covers(words, &start, spans, &mut covers);
        let PaintStart {
            index: mut i,
            mut clip,
            mut stack,
            mut depth,
            ..
        } = start;
        let mut ops = OpCursor::new(spans, screen, i);
        let mut result = Ok(());
        while let Some(next) = ops.next(words, i) {
            i = next;
            let Ok(len) = word_len(words, i) else {
                result = Err(RenderError::InvalidFrame);
                break;
            };
            let op = &words[i..i + len];
            let mut advance = len;
            let drawn = match op[0] {
                spec::draw_op::RECT => {
                    let rect = logical_rect(op[1], op[2]).intersect(clip);
                    let translucent = op[3] >> 24 != 255;
                    let (pieces, count_pieces) = visible_pieces(&covers, i, rect, translucent);
                    let mut status = Ok(());
                    for &piece in &pieces[..count_pieces] {
                        let drawn = hardware
                            && self.try_rect(
                                strip_pixels(target, count),
                                width,
                                height,
                                surface,
                                piece,
                                op[3],
                                mask_ready,
                                ppa,
                                stats,
                            )?;
                        if !drawn {
                            status = self.software(resources, op, piece, target, stats);
                            if status.is_err() {
                                break;
                            }
                        }
                    }
                    status
                }
                spec::draw_op::GRAD_RECT => {
                    let rect = logical_rect(op[1], op[2]).intersect(clip);
                    let translucent = op[3] >> 24 != 255 || op[4] >> 24 != 255;
                    let (pieces, count_pieces) = visible_pieces(&covers, i, rect, translucent);
                    let mut status = Ok(());
                    for &piece in &pieces[..count_pieces] {
                        let drawn = hardware
                            && self.try_grad_rect(strip_pixels(target, count), width, surface, piece, op);
                        if !drawn {
                            status = self.software(resources, op, piece, target, stats);
                            if status.is_err() {
                                break;
                            }
                        }
                    }
                    status
                }
                spec::draw_op::GLYPH_RUN => {
                    let operation = Operation {
                        opcode: op[0],
                        words: op,
                        clip,
                    };
                    let cached = OperationResources::new(resources, &operation, scale)?;
                    let bounds = glyph_run_bounds(&cached, op, clip);
                    if bounds.is_empty() || visible_pieces(&covers, i, bounds, false).1 == 0 {
                        Ok(())
                    } else {
                        let drawn = mask_ready
                            && self.try_glyph_run(
                                &cached,
                                strip_pixels(target, count),
                                width,
                                height,
                                surface,
                                clip,
                                op,
                                ppa,
                                stats,
                            )?;
                        if drawn {
                            Ok(())
                        } else {
                            software_operation(&cached, &operation, target, scale, stats)
                        }
                    }
                }
                spec::draw_op::TEX_QUAD => {
                    let rect = logical_rect(op[2], op[3]).intersect(clip);
                    if rect.is_empty() || visible_pieces(&covers, i, rect, false).1 == 0 {
                        Ok(())
                    } else {
                        let operation = Operation {
                            opcode: op[0],
                            words: op,
                            clip,
                        };
                        let cached = OperationResources::new(resources, &operation, scale)?;
                        let end = if hardware {
                            self.try_tex_quad_run(
                                &cached,
                                words,
                                i,
                                strip_pixels(target, count),
                                width,
                                height,
                                surface,
                                clip,
                                mask_ready,
                                ppa,
                                stats,
                            )?
                        } else {
                            None
                        };
                        match end {
                            Some(end) => {
                                advance = end - i;
                                Ok(())
                            }
                            None => software_operation(&cached, &operation, target, scale, stats),
                        }
                    }
                }
                spec::draw_op::SCISSOR => {
                    if depth >= MAX_CLIP_DEPTH {
                        Err(RenderError::InvalidFrame)
                    } else {
                        stack[depth] = clip;
                        depth += 1;
                        clip = screen.intersect(logical_rect(op[1], op[2]));
                        Ok(())
                    }
                }
                spec::draw_op::SCISSOR_POP => {
                    if depth > 0 {
                        depth -= 1;
                        clip = stack[depth];
                    } else {
                        clip = screen;
                    }
                    Ok(())
                }
                spec::draw_op::TRI => {
                    if triangle_bounds([op[1], op[2], op[3]], clip).is_empty() {
                        Ok(())
                    } else {
                        self.software(resources, op, clip, target, stats)
                    }
                }
                spec::draw_op::TEX_TRI => {
                    if triangle_bounds([op[2], op[5], op[8]], clip).is_empty() {
                        Ok(())
                    } else {
                        self.software(resources, op, clip, target, stats)
                    }
                }
                // No application compositor on the PPA target; the shell
                // fallback keeps decoding later ops.
                spec::draw_op::SURFACE_QUAD => Ok(()),
                spec::draw_op::TEXT_RUN => self.software(resources, op, clip, target, stats),
                _ => Err(RenderError::InvalidFrame),
            };
            if let Err(error) = drawn {
                result = Err(error);
                break;
            }
            i += advance;
        }
        self.covers = covers;
        result
    }

    /// Draw `op` clipped to `clip` with the core rasterizer.
    fn software(
        &mut self,
        resources: &(impl RenderResources + ?Sized),
        op: &[u32],
        clip: Clip,
        target: &mut Surface<'_>,
        stats: &mut RenderStats,
    ) -> Result<(), RenderError> {
        if clip.is_empty() {
            return Ok(());
        }
        let operation = Operation {
            opcode: op[0],
            words: op,
            clip,
        };
        let cached = OperationResources::new(resources, &operation, self.config.scale)?;
        software_operation(&cached, &operation, target, self.config.scale, stats)
    }

    /// Fill or blend one logical rectangle: opaque fills take the PPA from
    /// `min_fill_pixels` and a row loop below it; translucent rectangles
    /// blend on the CPU up to [`CPU_BLEND_MAX_PIXELS`] or over a flat row,
    /// take the PPA from `min_blend_pixels`, and otherwise return false for
    /// the core rasterizer.
    #[allow(clippy::too_many_arguments)]
    fn try_rect<O: PpaOps>(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        logical: Clip,
        color: u32,
        mask_ready: bool,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Result<bool, RenderError> {
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return Ok(true);
        }
        let rect = local_physical_rect(logical, surface, self.config.scale);
        if rect.is_empty() {
            return Ok(true);
        }
        if a == 255 {
            if rect.area() >= self.config.min_fill_pixels
                && accelerated(ppa.fill_rgb565(destination, width, height, rect, pack_rgb565(r, g, b)))?
            {
                stats.ppa_fills += 1;
                return Ok(true);
            }
            fill_rgb565_rect(destination, width, rect, pack_rgb565(r, g, b));
            return Ok(true);
        }
        let cpu_max = self.config.cpu_blend_max_pixels;
        if cpu_max > 0 && (rect.area() <= cpu_max || flat_row(destination, width, rect)) {
            for row in rect.y..rect.y + rect.h {
                let start = row as usize * width as usize + rect.x as usize;
                blend_span(&mut destination[start..start + rect.w as usize], r, g, b, a);
            }
            return Ok(true);
        }
        if mask_ready && rect.area() >= self.config.min_blend_pixels {
            let mask = self.mask_mut();
            fill_mask_rect(mask, width, rect, a as u8);
            if accelerated(ppa.blend_a8_rgb565(
                destination,
                width,
                height,
                mask,
                rect,
                [r as u8, g as u8, b as u8],
                255,
            ))? {
                stats.ppa_blends += 1;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Vertical gradients paint whole rows: opaque rows fill, translucent rows
    /// blend. Row colors come from the software interpreter's `lerp_color` at
    /// the same physical pixel centers.
    fn try_grad_rect(
        &self,
        destination: &mut [u16],
        width: u32,
        surface: Clip,
        clip: Clip,
        op: &[u32],
    ) -> bool {
        let (from, to, dir) = (op[3], op[4], op[5]);
        let vertical =
            dir == spec::GradDir::ToBottom as u32 || dir == spec::GradDir::ToTop as u32;
        if !vertical {
            return false;
        }
        let (a, b) = if dir == spec::GradDir::ToTop as u32 {
            (to, from)
        } else {
            (from, to)
        };
        let logical = logical_rect(op[1], op[2]);
        let scale = self.config.scale as i32;
        let y = logical.y0 * scale;
        let h = (logical.y1 - logical.y0) * scale;
        let rect = local_physical_rect(logical.intersect(clip), surface, self.config.scale);
        if h <= 0 || rect.is_empty() {
            return true;
        }
        let inv = 1.0f32 / h as f32;
        let origin = surface.y0 * scale;
        for row in rect.y..rect.y + rect.h {
            let f = ((origin + row as i32 - y) as f32 + 0.5) * inv;
            let (r, g, b, alpha) = channels(lerp_color(a, b, f));
            let start = row as usize * width as usize + rect.x as usize;
            let span = &mut destination[start..start + rect.w as usize];
            if alpha >= 255 {
                fill_span(span, pack_rgb565(r, g, b));
            } else {
                blend_span(span, r, g, b, alpha);
            }
        }
        true
    }

    /// The run's coverage lands in the A8 mask straight from the atlas cells
    /// (one sample per pixel when the atlas density is the scale); a run up
    /// to `cpu_blend_max_pixels`, or below `min_blend_pixels`, blends that
    /// mask on the CPU, a larger one on the PPA.
    #[allow(clippy::too_many_arguments)]
    fn try_glyph_run<O: PpaOps>(
        &mut self,
        ui: &(impl RenderResources + ?Sized),
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        clip: Clip,
        op: &[u32],
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Result<bool, RenderError> {
        let slot = (op[1] & 0xff) as u8;
        let color = op[2];
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return Ok(true);
        }
        let Some(atlas) = ui.font_atlas(slot) else {
            return Ok(true);
        };
        let scale = self.config.scale as i32;
        let cell_w = atlas.cell_w as i32;
        let cell_h = atlas.cell_h as i32;
        let mut bounds = Clip::empty();
        for glyph in op[3..].as_chunks::<2>().0.iter() {
            let (x, y) = xy(glyph[0]);
            let gid = (glyph[1] & 0xffff) as u16;
            if gid < atlas.glyph_count {
                bounds = bounds.union(Clip {
                    x0: x,
                    y0: y,
                    x1: x + cell_w,
                    y1: y + cell_h,
                });
            }
        }
        bounds = bounds.intersect(clip);
        let global_rect = physical_rect(bounds, self.config.scale);
        let rect = local_physical_rect(bounds, surface, self.config.scale);
        if rect.is_empty() {
            return Ok(true);
        }
        let cpu_max = self.config.cpu_blend_max_pixels;
        let min_blend = self.config.min_blend_pixels;
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        let density = atlas.raster_density as i32;
        let coverage_w = atlas.coverage_width() as i32;
        let coverage_h = atlas.coverage_height() as i32;
        let bpr = atlas.bytes_per_row();
        let (clip_x0, clip_y0) = (global_rect.x as i32, global_rect.y as i32);
        let clip_x1 = (global_rect.x + global_rect.w) as i32;
        let clip_y1 = (global_rect.y + global_rect.h) as i32;
        for glyph in op[3..].as_chunks::<2>().0.iter() {
            let (gx, gy) = xy(glyph[0]);
            let gid = (glyph[1] & 0xffff) as u16;
            if gid >= atlas.glyph_count {
                continue;
            }
            let rows = atlas.glyph_rows(gid);
            let x0 = (gx * scale).max(clip_x0);
            let y0 = (gy * scale).max(clip_y0);
            let x1 = ((gx + cell_w) * scale).min(clip_x1);
            let y1 = ((gy + cell_h) * scale).min(clip_y1);
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            if density == scale {
                // One atlas sample per output pixel: walk coverage rows and
                // skip the empty cell padding.
                let sx0 = (x0 - gx * scale) as usize;
                let n = (x1 - x0) as usize;
                let local_x = (x0 - surface.x0 * scale) as usize;
                for py in y0..y1 {
                    let sy = coverage_index(py - gy * scale, scale, density, coverage_h);
                    let source = &rows[sy * bpr + sx0..sy * bpr + sx0 + n];
                    let start = (py - surface.y0 * scale) as usize * width as usize + local_x;
                    for (target, &coverage) in mask[start..start + n].iter_mut().zip(source) {
                        if coverage == 0 {
                            continue;
                        }
                        let value = if a == 255 {
                            coverage
                        } else {
                            ((coverage as u32 * a + 127) / 255) as u8
                        };
                        if *target == 0 {
                            *target = value;
                        } else {
                            composite_mask(target, value);
                        }
                    }
                }
                continue;
            }
            for py in y0..y1 {
                let sy = coverage_index(py - gy * scale, scale, density, coverage_h);
                let row = &rows[sy * bpr..];
                let local_y = (py - surface.y0 * scale) as usize;
                for px in x0..x1 {
                    let sx = coverage_index(px - gx * scale, scale, density, coverage_w);
                    let local_x = (px - surface.x0 * scale) as usize;
                    composite_mask(
                        &mut mask[local_y * width as usize + local_x],
                        ((row[sx] as u32 * a + 127) / 255) as u8,
                    );
                }
            }
        }
        if rect.area() <= cpu_max || rect.area() < min_blend {
            blend_mask_rect(mask, destination, width, rect, [r, g, b]);
            return Ok(true);
        }
        if accelerated(ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ))? {
            stats.ppa_blends += 1;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Draw the TEX_QUAD at `start` and the run of quads after it that share
    /// its texture and modulation. Returns the word offset after the run, or
    /// None when the core rasterizer draws the quad at `start`.
    #[allow(clippy::too_many_arguments)]
    fn try_tex_quad_run<O: PpaOps>(
        &mut self,
        ui: &(impl RenderResources + ?Sized),
        words: &[u32],
        start: usize,
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        clip: Clip,
        mask_ready: bool,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Result<Option<usize>, RenderError> {
        let op = &words[start..start + 9];
        let handle = op[1] as i32;
        let Some(view) = ui.texture(handle) else {
            return Ok(None);
        };

        if view.psm == spec::psm::PSM_5650 {
            let logical = logical_rect(op[2], op[3]).intersect(clip);
            let destination_rect = local_physical_rect(logical, surface, self.config.scale);
            if !destination_rect.is_empty() {
                if let Some((source_rect, mirror_x, mirror_y)) =
                    texture_source_rect(&view, op, logical)
                {
                    let one_to_one = source_rect.w == destination_rect.w
                        && source_rect.h == destination_rect.h;
                    // An unscaled, unmirrored, untinted copy is a row loop
                    // that swaps the red and blue fields. The PPA's SRM
                    // engine is the one that presents the lanes' strips, so
                    // a transaction waits behind them: about a millisecond
                    // each on the Tab5, whatever the block's size.
                    if one_to_one && !mirror_x && !mirror_y && op[8] == 0xffff_ffff {
                        copy_psm5650_rect(
                            view.pixels,
                            view.w,
                            source_rect,
                            destination,
                            width,
                            destination_rect,
                        );
                        return Ok(Some(start + 9));
                    }
                    if destination_rect.area() >= self.config.min_srm_pixels
                        && (one_to_one || view.linear)
                        && op[8] == 0xffff_ffff
                    {
                        let transform = SrmTransform {
                            mirror_x,
                            mirror_y,
                            ..SrmTransform::default()
                        };
                        if accelerated(ppa.srm_psm5650_to_rgb565(
                            destination,
                            width,
                            height,
                            view.pixels,
                            view.w,
                            view.h,
                            source_rect,
                            destination_rect,
                            transform,
                        ))? {
                            stats.ppa_srm += 1;
                            return Ok(Some(start + 9));
                        }
                    }
                }
            }
            return Ok(Some(self.color_quad(&view, op, destination, width, surface, clip, start)));
        }

        if !self.is_white_alpha_texture(handle, ui.texture_revision(handle), &view) {
            return Ok(Some(self.color_quad(&view, op, destination, width, surface, clip, start)));
        }
        let modulate = op[8];
        let mut end = start;
        let mut bounds = Clip::empty();
        while end + 9 <= words.len()
            && words[end] == spec::draw_op::TEX_QUAD
            && words[end + 1] == handle as u32
            && words[end + 8] == modulate
        {
            let next = Operation {
                opcode: spec::draw_op::TEX_QUAD,
                words: &words[end..end + 9],
                clip,
            };
            let _validated = OperationResources::new(ui, &next, self.config.scale)?;
            bounds = bounds.union(logical_rect(words[end + 2], words[end + 3]).intersect(clip));
            end += 9;
        }
        let (r, g, b, a) = channels(modulate);
        if a == 0 {
            return Ok(Some(end));
        }
        let rect = local_physical_rect(bounds, surface, self.config.scale);
        let cpu_max = self.config.cpu_blend_max_pixels;
        if rect.is_empty() || (rect.area() > cpu_max && rect.area() < self.config.min_blend_pixels)
        {
            return Ok(None);
        }
        let scale = self.config.scale;
        let run = &words[start..end];
        let quad_rect = |quad: &[u32]| {
            local_physical_rect(logical_rect(quad[2], quad[3]).intersect(clip), surface, scale)
        };
        let covered: u32 = run.as_chunks::<9>().0.iter().map(|quad| quad_rect(quad).area()).sum();
        if cpu_max > 0 && covered <= cpu_max && covered * 2 < rect.area() && quads_disjoint(run, clip)
        {
            // Rounded-box corners: blend each quad on its own bounds instead
            // of the whole box. Disjoint quads touch every pixel once, so this
            // equals compositing them into one mask first.
            let mut sink = BlendSink {
                destination: &mut *destination,
                color: [r, g, b],
            };
            for quad in run.as_chunks::<9>().0.iter() {
                for_each_quad_alpha(&view, quad, surface, clip, scale, width, a as u8, &mut sink);
            }
            return Ok(Some(end));
        }
        if !mask_ready {
            return Ok(None);
        }
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        for quad in run.as_chunks::<9>().0.iter() {
            alpha_quad_into_mask(&view, quad, surface, clip, scale, mask, width, a as u8);
        }
        if rect.area() <= cpu_max {
            blend_mask_rect(mask, destination, width, rect, [r, g, b]);
            return Ok(Some(end));
        }
        if accelerated(ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ))? {
            stats.ppa_blends += 1;
            Ok(Some(end))
        } else {
            Ok(None)
        }
    }

    /// Blend one TEX_QUAD of any color texture on the CPU, exactly as the
    /// core rasterizer samples, modulates and blends it. Returns the next op.
    #[allow(clippy::too_many_arguments)]
    fn color_quad(
        &self,
        view: &TexView<'_>,
        op: &[u32],
        destination: &mut [u16],
        width: u32,
        surface: Clip,
        clip: Clip,
        start: usize,
    ) -> usize {
        let modulate = op[8];
        let identity = modulate == 0xffff_ffff;
        let (mr, mg, mb, ma) = channels(modulate);
        for_each_quad_texel(
            view,
            op,
            surface,
            clip,
            self.config.scale,
            width,
            |index, mut r, mut g, mut b, mut a| {
                if !identity {
                    r = (r * mr + 127) / 255;
                    g = (g * mg + 127) / 255;
                    b = (b * mb + 127) / 255;
                    a = (a * ma + 127) / 255;
                }
                blend_rgb565_pixel(&mut destination[index], r, g, b, a);
            },
        );
        start + 9
    }

    fn mask_mut(&mut self) -> &mut [u8] {
        unsafe {
            core::slice::from_raw_parts_mut(
                (self.mask_storage.as_mut_ptr() as *mut u8).add(self.mask_offset),
                self.mask_len,
            )
        }
    }

    fn is_white_alpha_texture(
        &mut self,
        handle: i32,
        revision: Option<u64>,
        view: &TexView<'_>,
    ) -> bool {
        // T8 video planes can replace their palette and indices in place, so
        // their classification is intentionally never cached.
        if view.psm == spec::psm::PSM_T8 || revision.is_none() {
            return is_white_alpha_texture(view);
        }
        if let Some((_, _, result)) = self
            .alpha_texture_cache
            .iter()
            .find(|(cached, version, _)| *cached == handle && Some(*version) == revision)
        {
            return *result;
        }
        let result = is_white_alpha_texture(view);
        if self.alpha_texture_cache.len() == TEXTURE_CLASS_CACHE_LEN {
            self.alpha_texture_cache.remove(0);
        }
        self.alpha_texture_cache
            .retain(|(cached, _, _)| *cached != handle);
        self.alpha_texture_cache
            .push((handle, revision.unwrap(), result));
        result
    }
}

/// The strip's packed RGB565 pixels as u16, for a strip that passed the
/// alignment and stride checks.
fn strip_pixels<'a>(target: &'a mut Surface<'_>, count: usize) -> &'a mut [u16] {
    // SAFETY: the caller checked 2-byte alignment and that the strip holds
    // exactly `count` packed RGB565 pixels; the borrow of `target` lasts as
    // long as the slice.
    unsafe { core::slice::from_raw_parts_mut(target.pixels_mut().as_mut_ptr().cast::<u16>(), count) }
}

/// Draw one validated operation with the core rasterizer and count it.
fn software_operation(
    resources: &(impl RenderResources + ?Sized),
    operation: &Operation<'_>,
    target: &mut Surface<'_>,
    scale: u32,
    stats: &mut RenderStats,
) -> Result<(), RenderError> {
    render_operation(resources, operation, target, scale)?;
    if !matches!(
        operation.opcode,
        spec::draw_op::SCISSOR
            | spec::draw_op::SCISSOR_POP
            | spec::draw_op::TEXT_RUN
            | spec::draw_op::SURFACE_QUAD
    ) {
        stats.software_ops += 1;
        stats.software_words += operation.words.len() as u32;
    }
    Ok(())
}

/// FNV-1a over the list's words: the key of its op index.
fn words_signature(words: &[u32]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for &word in words {
        hash ^= word as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The opaque RECT and GRAD_RECT ops of a region from `start` on, by word
/// offset, clipped to their scissors. Each paints every pixel of its rect, so
/// it hides what earlier ops paint there. Empty when an op does not decode.
fn collect_covers(
    words: &[u32],
    start: &PaintStart,
    spans: Option<&[OpSpan]>,
    covers: &mut Vec<(u32, Clip)>,
) {
    covers.clear();
    let screen = start.screen;
    let (mut clip, mut stack, mut depth) = (start.clip, start.stack, start.depth);
    let mut ops = OpCursor::new(spans, screen, start.index);
    let mut next = start.index;
    while let Some(i) = ops.next(words, next) {
        let Ok(len) = word_len(words, i) else {
            covers.clear();
            return;
        };
        match words[i] {
            spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
                let opaque = words[i + 3] >> 24 == 255
                    && (words[i] == spec::draw_op::RECT || words[i + 4] >> 24 == 255);
                let rect = logical_rect(words[i + 1], words[i + 2]).intersect(clip);
                if opaque && !rect.is_empty() {
                    covers.push((i as u32, rect));
                }
            }
            spec::draw_op::SCISSOR => {
                if depth >= MAX_CLIP_DEPTH {
                    covers.clear();
                    return;
                }
                stack[depth] = clip;
                depth += 1;
                clip = screen.intersect(logical_rect(words[i + 1], words[i + 2]));
            }
            spec::draw_op::SCISSOR_POP => {
                if depth > 0 {
                    depth -= 1;
                    clip = stack[depth];
                } else {
                    clip = screen;
                }
            }
            _ => {}
        }
        next = i + len;
    }
}

/// The parts of `rect` that the covers painted after word offset `at` leave
/// visible, as up to `MAX_PIECES` rectangles; with `split` false, `rect`
/// itself unless the covers hide all of it. Translucent ops split: blending
/// costs per pixel, while splitting a fill only adds operations. A cover
/// that would split the pieces further is skipped: painting hidden pixels
/// is still exact.
fn visible_pieces(
    covers: &[(u32, Clip)],
    at: usize,
    rect: Clip,
    split: bool,
) -> ([Clip; MAX_PIECES], usize) {
    let mut pieces = [Clip::empty(); MAX_PIECES];
    if rect.is_empty() {
        return (pieces, 0);
    }
    pieces[0] = rect;
    let mut count = 1;
    let later = covers.partition_point(|&(offset, _)| offset as usize <= at);
    for &(_, cover) in covers[later..].iter().take(COVERS_AHEAD) {
        if count == 0 {
            break;
        }
        if pieces[..count]
            .iter()
            .all(|piece| piece.intersect(cover).is_empty())
        {
            continue;
        }
        let mut next = [Clip::empty(); MAX_PIECES];
        let mut kept = 0;
        let fits = pieces[..count].iter().all(|piece| {
            piece
                .subtract(cover)
                .into_iter()
                .filter(|part| !part.is_empty())
                .all(|part| {
                    if kept == MAX_PIECES {
                        return false;
                    }
                    next[kept] = part;
                    kept += 1;
                    true
                })
        });
        if fits {
            pieces = next;
            count = kept;
        }
    }
    if !split && count > 0 {
        pieces[0] = rect;
        count = 1;
    }
    (pieces, count)
}

/// Whether no two quads of a TEX_QUAD run overlap inside `clip`.
fn quads_disjoint(run: &[u32], clip: Clip) -> bool {
    const MAX_QUADS: usize = 8;
    let count = run.len() / 9;
    if count > MAX_QUADS {
        return false;
    }
    let mut rects = [Clip::empty(); MAX_QUADS];
    for (index, quad) in run.as_chunks::<9>().0.iter().enumerate() {
        rects[index] = logical_rect(quad[2], quad[3]).intersect(clip);
        if rects[..index]
            .iter()
            .any(|other| !other.intersect(rects[index]).is_empty())
        {
            return false;
        }
    }
    true
}

fn glyph_run_bounds(ui: &(impl RenderResources + ?Sized), words: &[u32], clip: Clip) -> Clip {
    if words.len() < 3 || words[2] >> 24 == 0 {
        return Clip::empty();
    }
    let slot = (words[1] & 0xff) as u8;
    let Some(atlas) = ui.font_atlas(slot) else {
        return Clip::empty();
    };
    let mut bounds = Clip::empty();
    for glyph in words[3..].as_chunks::<2>().0.iter() {
        let gid = (glyph[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        let (x, y) = xy(glyph[0]);
        bounds = bounds.union(Clip {
            x0: x,
            y0: y,
            x1: x + atlas.cell_w as i32,
            y1: y + atlas.cell_h as i32,
        });
    }
    bounds.intersect(clip)
}

fn triangle_bounds(vertices: [u32; 3], clip: Clip) -> Clip {
    let [(x0, y0), (x1, y1), (x2, y2)] = vertices.map(xy);
    Clip {
        x0: x0.min(x1).min(x2),
        y0: y0.min(y1).min(y2),
        x1: x0.max(x1).max(x2),
        y1: y0.max(y1).max(y2),
    }
    .intersect(clip)
}

#[inline]
fn xy(word: u32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32,
        (word >> 16) as u16 as i16 as i32,
    )
}

#[inline]
fn wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

#[inline]
fn logical_rect(xy_word: u32, wh_word: u32) -> Clip {
    let (x, y) = xy(xy_word);
    let (w, h) = wh(wh_word);
    Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    }
}

#[inline]
fn physical_rect(clip: Clip, scale: u32) -> Rect {
    if clip.is_empty() {
        return Rect::default();
    }
    Rect {
        x: clip.x0 as u32 * scale,
        y: clip.y0 as u32 * scale,
        w: (clip.x1 - clip.x0) as u32 * scale,
        h: (clip.y1 - clip.y0) as u32 * scale,
    }
}

#[inline]
fn local_physical_rect(clip: Clip, surface: Clip, scale: u32) -> Rect {
    let clip = clip.intersect(surface);
    if clip.is_empty() {
        return Rect::default();
    }
    Rect {
        x: (clip.x0 - surface.x0) as u32 * scale,
        y: (clip.y0 - surface.y0) as u32 * scale,
        w: (clip.x1 - clip.x0) as u32 * scale,
        h: (clip.y1 - clip.y0) as u32 * scale,
    }
}

#[inline]
fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}

/// Fill RGB565 pixels two at a time through aligned 32-bit stores.
fn fill_span(span: &mut [u16], color: u16) {
    // SAFETY: every u32 bit pattern is two valid u16 values.
    let (head, body, tail) = unsafe { span.align_to_mut::<u32>() };
    head.fill(color);
    body.fill(color as u32 * 0x0001_0001);
    tail.fill(color);
}

/// Fill `rect` of a packed RGB565 buffer `stride` pixels wide.
fn fill_rgb565_rect(destination: &mut [u16], stride: u32, rect: Rect, color: u16) {
    for y in rect.y..rect.y + rect.h {
        let start = y as usize * stride as usize + rect.x as usize;
        fill_span(&mut destination[start..start + rect.w as usize], color);
    }
}

/// Copy a PSM_5650 texture rect (little-endian u16, red in the low five
/// bits) over an RGB565 rect of the same size, row by row, as the SRM path
/// writes it with its red and blue fields swapped.
fn copy_psm5650_rect(
    pixels: &[u8],
    texture_width: u32,
    source: Rect,
    destination: &mut [u16],
    stride: u32,
    target: Rect,
) {
    let w = source.w.min(target.w) as usize;
    let h = source.h.min(target.h) as usize;
    for row in 0..h {
        let from = ((source.y as usize + row) * texture_width as usize + source.x as usize) * 2;
        let to = (target.y as usize + row) * stride as usize + target.x as usize;
        let Some(texels) = pixels.get(from..from + w * 2) else {
            return;
        };
        let Some(out) = destination.get_mut(to..to + w) else {
            return;
        };
        for (pixel, texel) in out.iter_mut().zip(texels.chunks_exact(2)) {
            let value = u16::from_le_bytes([texel[0], texel[1]]);
            *pixel = (value << 11) | (value & 0x07e0) | (value >> 11);
        }
    }
}

/// Blend one color over a span. A run of equal destination pixels reuses the
/// first result, so a translucent layer over a flat backdrop costs a fill.
fn blend_span(span: &mut [u16], r: u32, g: u32, b: u32, a: u32) {
    let Some(&first) = span.first() else {
        return;
    };
    let mut source = first;
    let mut result = first;
    blend_rgb565_pixel(&mut result, r, g, b, a);
    for pixel in span {
        if *pixel != source {
            source = *pixel;
            result = source;
            blend_rgb565_pixel(&mut result, r, g, b, a);
        }
        *pixel = result;
    }
}

/// Whether the first row under `rect` holds at most four runs of equal
/// pixels, so a CPU blend reuses its results across nearly every pixel.
fn flat_row(destination: &[u16], stride: u32, rect: Rect) -> bool {
    let start = rect.y as usize * stride as usize + rect.x as usize;
    let row = &destination[start..start + rect.w as usize];
    row.windows(2).filter(|pair| pair[0] != pair[1]).take(4).count() < 4
}

/// Blend one color through an A8 mask over `rect` of a packed RGB565 buffer
/// `stride` pixels wide, with the core rasterizer's arithmetic.
fn blend_mask_rect(mask: &[u8], destination: &mut [u16], stride: u32, rect: Rect, color: [u32; 3]) {
    for y in rect.y..rect.y + rect.h {
        let start = (y * stride + rect.x) as usize;
        let end = start + rect.w as usize;
        for (pixel, &alpha) in destination[start..end].iter_mut().zip(&mask[start..end]) {
            if alpha != 0 {
                blend_rgb565_pixel(pixel, color[0], color[1], color[2], alpha as u32);
            }
        }
    }
}

fn fill_mask_rect(mask: &mut [u8], stride: u32, rect: Rect, value: u8) {
    assert!(pocket_glyph_pages::fill_mask_rect(
        mask,
        stride as usize,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        value
    ));
}

fn texture_source_rect(
    view: &TexView<'_>,
    op: &[u32],
    clipped_destination: Clip,
) -> Option<(Rect, bool, bool)> {
    let destination = logical_rect(op[2], op[3]);
    if destination.is_empty() || clipped_destination.is_empty() {
        return None;
    }
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    if !u0.is_finite() || !v0.is_finite() || !u1.is_finite() || !v1.is_finite() {
        return None;
    }
    let destination_w = (destination.x1 - destination.x0) as f32;
    let destination_h = (destination.y1 - destination.y0) as f32;
    let map_u = |x: i32| u0 + (u1 - u0) * (x - destination.x0) as f32 / destination_w;
    let map_v = |y: i32| v0 + (v1 - v0) * (y - destination.y0) as f32 / destination_h;
    let source_u0 = exact_texel_edge(map_u(clipped_destination.x0), view.w)?;
    let source_v0 = exact_texel_edge(map_v(clipped_destination.y0), view.h)?;
    let source_u1 = exact_texel_edge(map_u(clipped_destination.x1), view.w)?;
    let source_v1 = exact_texel_edge(map_v(clipped_destination.y1), view.h)?;
    let x0 = source_u0.min(source_u1);
    let y0 = source_v0.min(source_v1);
    let x1 = source_u0.max(source_u1);
    let y1 = source_v0.max(source_v1);
    (x1 > x0 && y1 > y0).then_some((
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        },
        source_u0 > source_u1,
        source_v0 > source_v1,
    ))
}

/// PPA source block offsets are integral texels. Refuse fractional UV edges
/// instead of expanding them and changing the sampling transform. The small
/// tolerance only absorbs normal f32 interpolation error for exact atlas
/// boundaries.
#[inline]
fn exact_texel_edge(uv: f32, extent: u32) -> Option<u32> {
    let value = uv * extent as f32;
    if !value.is_finite() || value < 0.0 || value > extent as f32 {
        return None;
    }
    let rounded = (value + 0.5) as u32;
    let rounded_value = rounded as f32;
    let difference = if value >= rounded_value {
        value - rounded_value
    } else {
        rounded_value - value
    };
    (rounded <= extent && difference <= 0.0001).then_some(rounded)
}

fn is_white_alpha_texture(view: &TexView<'_>) -> bool {
    let count = view.w as usize * view.h as usize;
    match view.psm {
        spec::psm::PSM_8888 => view.pixels[..count * 4].as_chunks::<4>().0.iter().all(|p| {
            let white = p[0] == 255 && p[1] == 255 && p[2] == 255;
            white || (!view.linear && p[3] == 0)
        }),
        spec::psm::PSM_4444 => view.pixels[..count * 2].as_chunks::<2>().0.iter().all(|p| {
            let pixel = u16::from_le_bytes([p[0], p[1]]);
            pixel & 0x0fff == 0x0fff || (!view.linear && pixel >> 12 == 0)
        }),
        spec::psm::PSM_T8 => {
            let Some(palette) = view.palette else {
                return false;
            };
            let white_entry = |p: &[u8]| {
                (p[0] == 255 && p[1] == 255 && p[2] == 255) || (!view.linear && p[3] == 0)
            };
            // A palette of white entries makes every pixel white without a
            // pixel scan; glyph pages are large and classified every frame.
            palette.as_chunks::<4>().0.iter().all(|p| white_entry(p))
                || view.pixels[..count]
                    .iter()
                    .all(|&index| white_entry(&palette[index as usize * 4..index as usize * 4 + 4]))
        }
        _ => false,
    }
}

/// Bilinear alphas for one output row: `columns` hold each pixel's texel
/// pair and weight, `rows` the two texel row offsets and their weight, and
/// `texel` reads one texel's alpha. Matches [`sample_separable`].
#[inline(always)]
fn bilinear_row(
    texel: impl Fn(usize) -> u32,
    columns: &[LinearSample],
    (top, bottom, fy): (usize, usize, u32),
    global_alpha: u8,
    start: usize,
    sink: &mut impl AlphaSink,
) {
    let lerp = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    for (offset, column) in columns.iter().enumerate() {
        let (x0, x1) = (column.x0 as usize, column.x1 as usize);
        let (a00, a01) = (texel(top + x0), texel(top + x1));
        let (a10, a11) = (texel(bottom + x0), texel(bottom + x1));
        let mut alpha = if a00 | a01 | a10 | a11 == 0 {
            0
        } else {
            lerp(lerp(a00, a01, column.fx), lerp(a10, a11, column.fx), fy)
        };
        if global_alpha != 255 {
            alpha = (alpha * global_alpha as u32 + 127) / 255;
        }
        sink.pixel(start + offset, alpha);
    }
}

/// Visit the alphas of `count` consecutive texels starting at texel index
/// `first`, which must lie inside the texture.
#[inline]
fn for_each_texel_alpha(
    view: &TexView<'_>,
    first: usize,
    count: usize,
    mut visit: impl FnMut(usize, u32),
) {
    match view.psm {
        spec::psm::PSM_8888 => {
            let texels = &view.pixels[first * 4..(first + count) * 4];
            for (offset, texel) in texels.as_chunks::<4>().0.iter().enumerate() {
                visit(offset, texel[3] as u32);
            }
        }
        spec::psm::PSM_4444 => {
            let texels = &view.pixels[first * 2..(first + count) * 2];
            for (offset, texel) in texels.as_chunks::<2>().0.iter().enumerate() {
                visit(offset, ((u16::from_le_bytes([texel[0], texel[1]]) >> 12) as u32) * 17);
            }
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette.unwrap();
            for (offset, &index) in view.pixels[first..first + count].iter().enumerate() {
                visit(offset, palette[index as usize * 4 + 3] as u32);
            }
        }
        _ => (0..count).for_each(|offset| visit(offset, 0)),
    }
}

#[inline]
fn texel_alpha(view: &TexView<'_>, x: i32, y: i32) -> u32 {
    let x = x.clamp(0, view.w as i32 - 1) as usize;
    let y = y.clamp(0, view.h as i32 - 1) as usize;
    let index = y * view.w as usize + x;
    match view.psm {
        spec::psm::PSM_8888 => view.pixels[index * 4 + 3] as u32,
        spec::psm::PSM_4444 => {
            let o = index * 2;
            ((u16::from_le_bytes([view.pixels[o], view.pixels[o + 1]]) >> 12) as u32) * 17
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette.unwrap();
            palette[view.pixels[index] as usize * 4 + 3] as u32
        }
        _ => 0,
    }
}

#[allow(clippy::too_many_arguments)]
fn alpha_quad_into_mask(
    view: &TexView<'_>,
    op: &[u32],
    surface: Clip,
    clip: Clip,
    scale: u32,
    mask: &mut [u8],
    stride: u32,
    global_alpha: u8,
) {
    for_each_quad_alpha(
        view,
        op,
        surface,
        clip,
        scale,
        stride,
        global_alpha,
        &mut |index: usize, alpha: u32| {
            let target = &mut mask[index];
            if *target == 0 {
                *target = alpha as u8;
            } else {
                composite_mask(target, alpha as u8);
            }
        },
    );
}

/// Receives the sampled, global-scaled alphas of one alpha TEX_QUAD.
trait AlphaSink {
    fn pixel(&mut self, index: usize, alpha: u32);

    /// `count` pixels from buffer index `start` whose alphas are the texels
    /// from texel index `first` on.
    fn texels(
        &mut self,
        view: &TexView<'_>,
        start: usize,
        first: usize,
        count: usize,
        global_alpha: u8,
    ) {
        for_each_texel_alpha(view, first, count, |offset, mut alpha| {
            if global_alpha != 255 {
                alpha = (alpha * global_alpha as u32 + 127) / 255;
            }
            self.pixel(start + offset, alpha);
        });
    }
}

impl<F: FnMut(usize, u32)> AlphaSink for F {
    fn pixel(&mut self, index: usize, alpha: u32) {
        self(index, alpha)
    }
}

/// Blends a flat color through quad alphas straight into the target.
struct BlendSink<'a> {
    destination: &'a mut [u16],
    color: [u32; 3],
}

impl AlphaSink for BlendSink<'_> {
    fn pixel(&mut self, index: usize, alpha: u32) {
        let [r, g, b] = self.color;
        blend_rgb565_pixel(&mut self.destination[index], r, g, b, alpha);
    }

    fn texels(
        &mut self,
        view: &TexView<'_>,
        start: usize,
        first: usize,
        count: usize,
        global_alpha: u8,
    ) {
        if view.psm != spec::psm::PSM_8888 {
            for_each_texel_alpha(view, first, count, |offset, mut alpha| {
                if global_alpha != 255 {
                    alpha = (alpha * global_alpha as u32 + 127) / 255;
                }
                self.pixel(start + offset, alpha);
            });
            return;
        }
        // One texel per pixel of a row: walk both slices together.
        let [r, g, b] = self.color;
        let pixels = &mut self.destination[start..start + count];
        let texels = &view.pixels[first * 4..(first + count) * 4];
        let ga = global_alpha as u32;
        for (pixel, texel) in pixels.iter_mut().zip(texels.as_chunks::<4>().0.iter()) {
            let mut alpha = texel[3] as u32;
            if alpha == 0 {
                continue;
            }
            if ga != 255 {
                alpha = (alpha * ga + 127) / 255;
            }
            blend_rgb565_pixel(pixel, r, g, b, alpha);
        }
    }
}

/// Visit every covered pixel of one alpha TEX_QUAD with its buffer index
/// (row stride `stride`, origin at `surface`) and sampled, global-scaled
/// alpha.
#[allow(clippy::too_many_arguments)]
fn for_each_quad_alpha(
    view: &TexView<'_>,
    op: &[u32],
    surface: Clip,
    clip: Clip,
    scale: u32,
    stride: u32,
    global_alpha: u8,
    sink: &mut impl AlphaSink,
) {
    let logical = logical_rect(op[2], op[3]).intersect(clip);
    if logical.is_empty() || view.w == 0 || view.h == 0 {
        return;
    }
    let (x, y) = xy(op[2]);
    let (w, h) = wh(op[3]);
    let scale_i = scale as i32;
    let physical = physical_rect(logical, scale);
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    // Texture sampling is separable: texel columns depend on u alone and rows
    // on v alone. Columns resolve once per chunk and rows once per row, so the
    // inner loop only fetches texels.
    const COLUMNS: usize = 32;
    let mut columns = [EMPTY_SAMPLE; COLUMNS];
    let end_x = physical.x + physical.w;
    let mut chunk_x = physical.x;
    // The core rasterizer's exact expressions, reciprocal included.
    let inv_w = 1.0f32 / (w * scale_i) as f32;
    let inv_h = 1.0f32 / (h * scale_i) as f32;
    while chunk_x < end_x {
        let count = ((end_x - chunk_x) as usize).min(COLUMNS);
        for (column, px) in columns[..count].iter_mut().zip(chunk_x..) {
            let u = u0 + (u1 - u0) * ((px as i32 - x * scale_i) as f32 + 0.5) * inv_w;
            *column = sample_column(view, u);
        }
        // Columns on consecutive in-range texels with zero weight read one
        // texel per pixel: a quad drawn at its texture's own density.
        let unit_columns = columns[..count].iter().all(|column| column.fx == 0)
            && columns[..count]
                .windows(2)
                .all(|pair| pair[0].x0.checked_add(1) == Some(pair[1].x0))
            && columns[0].x0 < view.w
            && columns[count - 1].x0 < view.w;
        for py in physical.y..physical.y + physical.h {
            let v = v0 + (v1 - v0) * ((py as i32 - y * scale_i) as f32 + 0.5) * inv_h;
            let row = sample_column(view, v);
            let start = (py as i32 - surface.y0 * scale_i) as usize * stride as usize
                + (chunk_x as i32 - surface.x0 * scale_i) as usize;
            if unit_columns && row.fy == 0 && row.y0 < view.h {
                let first = row.y0 as usize * view.w as usize + columns[0].x0 as usize;
                sink.texels(view, start, first, count, global_alpha);
                continue;
            }
            if view.linear {
                // Clamped neighbors: every index lies inside the texture.
                let rows = (
                    row.y0 as usize * view.w as usize,
                    row.y1 as usize * view.w as usize,
                    row.fy,
                );
                let columns = &columns[..count];
                let pixels = view.pixels;
                match view.psm {
                    spec::psm::PSM_8888 => bilinear_row(
                        |i| pixels[i * 4 + 3] as u32,
                        columns,
                        rows,
                        global_alpha,
                        start,
                        sink,
                    ),
                    spec::psm::PSM_4444 => bilinear_row(
                        |i| ((u16::from_le_bytes([pixels[i * 2], pixels[i * 2 + 1]]) >> 12) as u32) * 17,
                        columns,
                        rows,
                        global_alpha,
                        start,
                        sink,
                    ),
                    spec::psm::PSM_T8 => {
                        let palette = view.palette.unwrap();
                        bilinear_row(
                            |i| palette[pixels[i] as usize * 4 + 3] as u32,
                            columns,
                            rows,
                            global_alpha,
                            start,
                            sink,
                        )
                    }
                    _ => bilinear_row(|_| 0, columns, rows, global_alpha, start, sink),
                }
                continue;
            }
            for (offset, column) in columns[..count].iter().enumerate() {
                let mut alpha = sample_separable(view, column, &row);
                if global_alpha != 255 {
                    alpha = (alpha * global_alpha as u32 + 127) / 255;
                }
                sink.pixel(start + offset, alpha);
            }
        }
        chunk_x += count as u32;
    }
}

/// Visit every covered pixel of one TEX_QUAD with its buffer index (row
/// stride `stride`, origin at `surface`) and its sampled RGBA: the core
/// rasterizer's nearest or integer bilinear sample, resolved per column and
/// per row.
#[allow(clippy::too_many_arguments)]
fn for_each_quad_texel(
    view: &TexView<'_>,
    op: &[u32],
    surface: Clip,
    clip: Clip,
    scale: u32,
    stride: u32,
    mut visit: impl FnMut(usize, u32, u32, u32, u32),
) {
    let logical = logical_rect(op[2], op[3]).intersect(clip);
    if logical.is_empty() || view.w == 0 || view.h == 0 {
        return;
    }
    let (x, y) = xy(op[2]);
    let (w, h) = wh(op[3]);
    let scale_i = scale as i32;
    let physical = physical_rect(logical, scale);
    let (u0, v0) = (f32::from_bits(op[4]), f32::from_bits(op[5]));
    let (u1, v1) = (f32::from_bits(op[6]), f32::from_bits(op[7]));
    let inv_w = 1.0f32 / (w * scale_i) as f32;
    let inv_h = 1.0f32 / (h * scale_i) as f32;
    let tw = view.w as usize;
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    const COLUMNS: usize = 32;
    let mut columns = [EMPTY_SAMPLE; COLUMNS];
    let end_x = physical.x + physical.w;
    let mut chunk_x = physical.x;
    while chunk_x < end_x {
        let count = ((end_x - chunk_x) as usize).min(COLUMNS);
        for (column, px) in columns[..count].iter_mut().zip(chunk_x..) {
            let u = u0 + (u1 - u0) * ((px as i32 - x * scale_i) as f32 + 0.5) * inv_w;
            *column = if view.linear {
                sample_column(view, u)
            } else {
                let tx = ((u * view.w as f32) as i32).clamp(0, tw_max);
                LinearSample {
                    x0: tx as u32,
                    ..EMPTY_SAMPLE
                }
            };
        }
        for py in physical.y..physical.y + physical.h {
            let v = v0 + (v1 - v0) * ((py as i32 - y * scale_i) as f32 + 0.5) * inv_h;
            let start = (py as i32 - surface.y0 * scale_i) as usize * stride as usize
                + (chunk_x as i32 - surface.x0 * scale_i) as usize;
            if !view.linear {
                let ty = ((v * view.h as f32) as i32).clamp(0, th_max) as usize;
                for (offset, column) in columns[..count].iter().enumerate() {
                    let Some((r, g, b, a)) = texel(view, ty * tw + column.x0 as usize) else {
                        return;
                    };
                    visit(start + offset, r, g, b, a);
                }
                continue;
            }
            let row = sample_column(view, v);
            let (top, bottom) = (row.y0 as usize * tw, row.y1 as usize * tw);
            let lerp = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
            for (offset, column) in columns[..count].iter().enumerate() {
                let (x0, x1) = (column.x0 as usize, column.x1 as usize);
                let (Some(c00), Some(c01), Some(c10), Some(c11)) = (
                    texel(view, top + x0),
                    texel(view, top + x1),
                    texel(view, bottom + x0),
                    texel(view, bottom + x1),
                ) else {
                    return;
                };
                let mix = |p: u32, q: u32, s: u32, t: u32| {
                    lerp(lerp(p, q, column.fx), lerp(s, t, column.fx), row.fy)
                };
                visit(
                    start + offset,
                    mix(c00.0, c01.0, c10.0, c11.0),
                    mix(c00.1, c01.1, c10.1, c11.1),
                    mix(c00.2, c01.2, c10.2, c11.2),
                    mix(c00.3, c01.3, c10.3, c11.3),
                );
            }
        }
        chunk_x += count as u32;
    }
}

const EMPTY_SAMPLE: LinearSample = LinearSample {
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
    fx: 0,
    fy: 0,
};

/// One axis of a texture lookup at normalized `t`. Nearest sampling keeps the
/// texel index (`x0` for u, `y0` for v); linear sampling keeps the core's
/// clamped neighbors and 8-bit weight.
fn sample_column(view: &TexView<'_>, t: f32) -> LinearSample {
    if !view.linear {
        let index = (t * view.w as f32) as i32;
        return LinearSample {
            x0: index as u32,
            y0: (t * view.h as f32) as i32 as u32,
            ..EMPTY_SAMPLE
        };
    }
    linear_sample_coordinates(view.w, view.h, t, t).unwrap_or(EMPTY_SAMPLE)
}

/// Texel alpha from a resolved column (x fields) and row (y fields): nearest
/// fetches one texel, linear blends four with integer weights.
fn sample_separable(view: &TexView<'_>, column: &LinearSample, row: &LinearSample) -> u32 {
    if !view.linear {
        return texel_alpha(view, column.x0 as i32, row.y0 as i32);
    }
    if view.w == 0 || view.h == 0 {
        return 0;
    }
    if column.fx == 0 && row.fy == 0 {
        // Zero weights select the base texel; a 1:1 quad samples texel centers.
        return texel_alpha(view, column.x0 as i32, row.y0 as i32);
    }
    let lerp = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let top = lerp(
        texel_alpha(view, column.x0 as i32, row.y0 as i32),
        texel_alpha(view, column.x1 as i32, row.y0 as i32),
        column.fx,
    );
    let bottom = lerp(
        texel_alpha(view, column.x0 as i32, row.y1 as i32),
        texel_alpha(view, column.x1 as i32, row.y1 as i32),
        column.fx,
    );
    lerp(top, bottom, row.fy)
}

/// Logical dirty bounds for one acquired strip: the union of the frame's
/// physical damage rectangles, clipped to `region` and widened to whole
/// logical pixels at `scale`. `None` repaints the whole strip: for an empty
/// damage list, one that misses the region, or one that covers it.
pub fn damage_clip(
    damage: impl IntoIterator<Item = Region>,
    region: Region,
    scale: u32,
) -> Option<Clip> {
    let scale = scale.max(1);
    let right = region.x.saturating_add(region.width);
    let bottom = region.y.saturating_add(region.height);
    let mut bounds: Option<(u32, u32, u32, u32)> = None;
    for rect in damage {
        let x0 = rect.x.max(region.x);
        let y0 = rect.y.max(region.y);
        let x1 = rect.x.saturating_add(rect.width).min(right);
        let y1 = rect.y.saturating_add(rect.height).min(bottom);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        bounds = Some(match bounds {
            None => (x0, y0, x1, y1),
            Some((bx0, by0, bx1, by1)) => (bx0.min(x0), by0.min(y0), bx1.max(x1), by1.max(y1)),
        });
    }
    let (x0, y0, x1, y1) = bounds?;
    if x0 == region.x && y0 == region.y && x1 == right && y1 == bottom {
        return None;
    }
    Some(Clip::new(
        (x0 / scale) as i32,
        (y0 / scale) as i32,
        x1.div_ceil(scale) as i32,
        y1.div_ceil(scale) as i32,
    ))
}

/// A registered PPA renderer owns one hardware device and its bounded scratch.
/// Each render call completes its CPU-visible writes, so submissions carry no
/// borrowed frame resources and multiple displays may share the instance.
/// Frame damage bounds each strip's repaint; the device's buffer alignment is
/// read once at construction.
pub struct PpaRenderer<O> {
    painter: Painter,
    device: O,
    last_stats: RenderStats,
}
impl<O: PpaOps> PpaRenderer<O> {
    pub fn new(config: RendererConfig, mask_budget: usize, device: O) -> Result<Self, RenderError> {
        let mut painter = Painter::new(config, mask_budget)?;
        painter.set_buffer_alignment(device.buffer_alignment());
        Ok(Self {
            painter,
            device,
            last_stats: RenderStats::default(),
        })
    }
    pub fn stats(&self) -> RenderStats {
        self.last_stats
    }
    pub fn device(&self) -> &O {
        &self.device
    }
    pub fn device_mut(&mut self) -> &mut O {
        &mut self.device
    }
    /// Active A8 payload size, excluding alignment and retained capacity.
    pub fn scratch_bytes(&self) -> usize {
        self.painter.scratch_bytes()
    }
    pub fn allocated_scratch_bytes(&self) -> usize {
        self.painter.allocated_scratch_bytes()
    }
}
impl<O: PpaOps> pocket_drivers::Renderer for PpaRenderer<O> {
    type Submission = ();
    fn descriptor(&self) -> pocket_drivers::RendererDescriptor {
        pocket_drivers::RendererDescriptor::new(
            &[PixelFormat::Rgb565],
            pocket_drivers::TargetOwnership::CpuVisible,
            pocket_drivers::Synchronization::Immediate,
            spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut pocket_drivers::FrameInput<'_>) -> Result<(), RenderError> {
        let pocket_drivers::Target::CpuVisible(surface) = &mut frame.target else {
            return Err(RenderError::Unsupported);
        };
        let requested = damage_clip(
            frame.damage.iter().copied(),
            surface.region(),
            self.painter.config().scale,
        );
        self.last_stats = self.painter.render_clipped(
            frame.resources,
            &frame.list.words,
            surface,
            requested,
            &mut self.device,
        )?;
        Ok(())
    }
    fn wait(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
    fn retire(&mut self, _: ()) {}
}
