//! Turn one frame's plan into executor commands for one damage region.
//!
//! Every item is clipped to the region, checked against the executor's
//! capabilities and thresholds, and either submitted as a [`Cmd`] or
//! appended to a CPU batch. Consecutive CPU items share one rasterizer
//! dispatch into a tile that hardware copies out of and back into the
//! target, with fences around the CPU writes, so painter order holds on both
//! sides and the CPU never writes the device-owned target.

use alloc::vec::Vec;

use pocket_drivers::{RenderResources, TexView};
use pocket_raster::render_scaled_rgb565_window_over;
use pocket_spec as spec;

use crate::caps::Capabilities;
use crate::cmd::{Cmd, Corners, Filter, MaskId, MaskRef, Mirror, TexSrc, TileId, MODULATE_NONE};
use crate::executor::Executor;
use crate::geom::{channels, pack_wh, pack_xy, physical_rect, Clip, Point, Rect};
use crate::mask::{alpha_quad_into_mask, composite_glyph_run, fill_mask_window};
use crate::plan::PlanItem;
use crate::quad::{axis_aligned_texture_rect, texture_source_rect};
use crate::renderer::RenderStats;
use crate::textures::Textures;

/// A8 planes the emitter alternates between so CPU mask construction can
/// overlap an in-flight blend of the other plane.
pub(crate) const MASK_PLANES: u8 = 2;

/// RGB565 tiles the emitter alternates between for CPU fallback.
pub(crate) const CPU_TILES: u8 = 2;

/// Per-frame state shared by every region.
pub(crate) struct Context<'r, E: Executor> {
    pub executor: &'r mut E,
    pub textures: &'r mut Textures,
    pub res: &'r dyn RenderResources,
    pub caps: Capabilities,
    pub scale: u32,
    /// The logical viewport the target stores.
    pub surface: Clip,
    pub submission: u64,
    pub stats: &'r mut RenderStats,
    pub fallback: &'r mut Vec<u32>,
    pub mask_index: &'r mut u8,
    /// Logical union of every op in the pending CPU batch.
    pub cpu_bounds: Clip,
    /// Planes referenced by a `BlendA8` submitted since the last fence.
    pub mask_pending: [bool; MASK_PLANES as usize],
    pub tile_index: u8,
    /// A submitted command reads a portable registration.
    pub portable_used: bool,
}

impl<'r, E: Executor> Context<'r, E> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        executor: &'r mut E,
        textures: &'r mut Textures,
        res: &'r dyn RenderResources,
        scale: u32,
        surface: Clip,
        submission: u64,
        stats: &'r mut RenderStats,
        fallback: &'r mut Vec<u32>,
        mask_index: &'r mut u8,
    ) -> Self {
        fallback.clear();
        let caps = executor.caps();
        Self {
            executor,
            textures,
            res,
            caps,
            scale,
            surface,
            submission,
            stats,
            fallback,
            mask_index,
            cpu_bounds: Clip::empty(),
            mask_pending: [false; MASK_PLANES as usize],
            tile_index: 0,
            portable_used: false,
        }
    }

    fn local(&self, clip: Clip) -> Rect {
        physical_rect(clip.intersect(self.surface), self.scale)
    }

    fn fence(&mut self) -> Option<()> {
        self.executor.fence().ok()?;
        self.stats.fences += 1;
        self.mask_pending = [false; MASK_PLANES as usize];
        Some(())
    }

    /// Reserve the next A8 plane, fencing first when a blend that reads it
    /// may still be in flight.
    fn next_mask(&mut self) -> Option<MaskId> {
        let id = MaskId(*self.mask_index);
        *self.mask_index = (*self.mask_index + 1) % MASK_PLANES;
        if self.mask_pending[id.0 as usize] {
            self.fence()?;
        }
        Some(id)
    }

    /// Append one DrawList op to the pending CPU batch under `clip`.
    fn push_cpu(&mut self, words: &[u32], at: usize, len: usize, clip: Clip) {
        if clip.is_empty() {
            return;
        }
        self.push_cpu_words(&words[at..at + len], clip);
        self.stats.software_ops += 1;
        self.stats.software_words += len as u32;
    }

    fn push_cpu_words(&mut self, op: &[u32], clip: Clip) {
        self.fallback.push(spec::draw_op::SCISSOR);
        self.fallback.push(pack_xy(clip.x0, clip.y0));
        self.fallback
            .push(pack_wh(clip.x1 - clip.x0, clip.y1 - clip.y0));
        self.fallback.extend_from_slice(op);
        self.fallback.push(spec::draw_op::SCISSOR_POP);
        self.cpu_bounds = self.cpu_bounds.union(clip);
    }

    /// Render the pending CPU batch through tile round-trips: copy the
    /// target band out, rasterize over it, copy it back.
    fn flush_cpu(&mut self) -> Option<()> {
        if self.fallback.is_empty() {
            return Some(());
        }
        let bounds = self.cpu_bounds.intersect(self.surface);
        if bounds.is_empty() {
            self.fallback.clear();
            self.cpu_bounds = Clip::empty();
            return Some(());
        }
        let scale = self.scale;
        let capacity = self.caps.tile_pixels;
        let limit = self.caps.coordinate_limit;
        let mut visit = |band: Clip| -> Option<()> {
            let local = self.local(band);
            let tile = TileId(self.tile_index);
            self.tile_index = (self.tile_index + 1) % CPU_TILES;
            self.executor
                .submit(&[Cmd::TileOut { tile, src: local }])
                .ok()?;
            self.fence()?;
            let pixels = local.area() as usize;
            let plane = self.executor.tile_mut(tile);
            if plane.len() < pixels {
                return None;
            }
            render_scaled_rgb565_window_over(
                self.res,
                self.fallback,
                &mut plane[..pixels],
                scale,
                band,
            );
            self.executor
                .submit(&[Cmd::TileIn { tile, dst: local }])
                .ok()?;
            self.stats.cpu_tiles += 1;
            self.stats.cpu_tile_pixels += local.area();
            Some(())
        };
        for_each_band(bounds, scale, Some(capacity), limit, &mut visit)?;
        self.fallback.clear();
        self.cpu_bounds = Clip::empty();
        Some(())
    }

    fn submit(&mut self, cmd: Cmd) -> Option<()> {
        self.flush_cpu()?;
        if let Cmd::BlendA8 { mask, .. } = cmd {
            self.mask_pending[mask.mask.0 as usize] = true;
        }
        self.executor.submit(&[cmd]).ok()
    }

    /// Clear `region` to black before replaying the DrawList into it.
    pub(crate) fn clear_region(&mut self, region: Clip) -> Option<()> {
        let physical = self.local(region);
        if physical.is_empty() {
            return Some(());
        }
        if self.caps.fill_opaque && physical.area() >= self.caps.thresholds.min_fill {
            self.fill(region, [0, 0, 0], 255)?;
        } else {
            let clear = [
                spec::draw_op::RECT,
                pack_xy(region.x0, region.y0),
                pack_wh(region.x1 - region.x0, region.y1 - region.y0),
                0xff00_0000,
            ];
            self.push_cpu_words(&clear, region);
        }
        Some(())
    }

    /// Emit every plan item that touches `region`, then the CPU batch.
    pub(crate) fn emit_region(
        &mut self,
        words: &[u32],
        plan: &[PlanItem],
        region: Clip,
    ) -> Option<()> {
        for item in plan {
            match *item {
                PlanItem::Rect { logical, color } => {
                    let logical = logical.intersect(region);
                    if logical.is_empty() {
                        continue;
                    }
                    self.rect(logical, color)?;
                }
                PlanItem::Gradient {
                    at,
                    original,
                    logical,
                    from,
                    to,
                    direction,
                    clip,
                } => {
                    let logical = logical.intersect(region);
                    if logical.is_empty() {
                        continue;
                    }
                    if !self.gradient(original, logical, from, to, direction)? {
                        self.push_cpu(words, at, 6, clip.intersect(region));
                    }
                }
                PlanItem::Glyphs {
                    at,
                    len,
                    bounds,
                    slot,
                    color,
                    clip,
                } => {
                    let bounds = bounds.intersect(region);
                    if bounds.is_empty() {
                        continue;
                    }
                    let op = &words[at..at + len];
                    if !self.glyphs(op, bounds, slot, color)? {
                        self.push_cpu(words, at, len, clip.intersect(region));
                    }
                }
                PlanItem::AlphaQuads {
                    at,
                    count,
                    handle,
                    modulate,
                    bounds,
                    clip,
                } => {
                    let bounds = bounds.intersect(region);
                    if bounds.is_empty() {
                        continue;
                    }
                    let clip = clip.intersect(region);
                    if !self.alpha_quads(words, at, count, handle, modulate, bounds, clip)? {
                        for index in 0..count {
                            self.push_cpu(words, at + index * 9, 9, clip);
                        }
                    }
                }
                PlanItem::TexQuad {
                    at,
                    handle,
                    logical,
                    clip,
                } => {
                    let logical = logical.intersect(region);
                    if logical.is_empty() {
                        continue;
                    }
                    let op = &words[at..at + 9];
                    if !self.tex_quad(op, handle, logical)? {
                        self.push_cpu(words, at, 9, clip.intersect(region));
                    }
                }
                PlanItem::TriPair {
                    at,
                    quad,
                    color,
                    bounds,
                    axis_aligned,
                    clip,
                } => {
                    let bounds = bounds.intersect(region);
                    if bounds.is_empty() {
                        continue;
                    }
                    if !self.tri_pair(quad, color, bounds, axis_aligned)? {
                        let clip = clip.intersect(region);
                        self.push_cpu(words, at, 7, clip);
                        self.push_cpu(words, at + 7, 7, clip);
                    }
                }
                PlanItem::TexTriPair {
                    at,
                    handle,
                    modulate,
                    source_rect,
                    quad,
                    bounds,
                    clip,
                } => {
                    let bounds = bounds.intersect(region);
                    if bounds.is_empty() {
                        continue;
                    }
                    if !self.tex_tri_pair(handle, modulate, source_rect, quad, bounds)? {
                        let clip = clip.intersect(region);
                        self.push_cpu(words, at, 12, clip);
                        self.push_cpu(words, at + 12, 12, clip);
                    }
                }
                PlanItem::Cpu { at, len, clip } => {
                    self.push_cpu(words, at, len, clip.intersect(region));
                }
            }
        }
        self.flush_cpu()
    }

    fn rect(&mut self, logical: Clip, color: u32) -> Option<()> {
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return Some(());
        }
        let rect = self.local(logical);
        let rgb = [r as u8, g as u8, b as u8];
        let opaque = a == 255;
        let threshold = if opaque {
            self.caps.thresholds.min_fill
        } else {
            self.caps.thresholds.min_blend
        };
        let hardware_fill = if opaque {
            self.caps.fill_opaque
        } else {
            self.caps.fill_alpha
        };
        if hardware_fill && rect.area() >= threshold {
            return self.fill(logical, rgb, a as u8);
        }
        if !opaque && self.caps.a8_blend && rect.area() >= self.caps.thresholds.min_blend {
            let alpha = a as u8;
            return self.blend_a8(logical, rgb, |plane, stride, window, _band| {
                fill_mask_window(plane, stride, window, alpha);
            });
        }
        // Small or unsupported: replay the rectangle on the CPU with the
        // exact integer blend, batched with its neighbours.
        let op = [
            spec::draw_op::RECT,
            pack_xy(logical.x0, logical.y0),
            pack_wh(logical.x1 - logical.x0, logical.y1 - logical.y0),
            color,
        ];
        self.push_cpu_words(&op, logical);
        self.stats.software_ops += 1;
        self.stats.software_words += 4;
        Some(())
    }

    /// Fill the logical `bounds`, split into pieces the executor's
    /// coordinate registers can address.
    fn fill(&mut self, bounds: Clip, color: [u8; 3], alpha: u8) -> Option<()> {
        let limit = self.caps.coordinate_limit;
        let scale = self.scale;
        let mut visit = |piece: Clip| -> Option<()> {
            let dst = self.local(piece);
            if dst.is_empty() {
                return Some(());
            }
            let cmd = if alpha == 255 {
                Cmd::Fill { dst, color }
            } else {
                Cmd::FillAlpha { dst, color, alpha }
            };
            self.submit(cmd)?;
            self.stats.epic_fills += 1;
            Some(())
        };
        for_each_band(bounds, scale, None, limit, &mut visit)
    }

    /// True when a physical rectangle fits the executor's coordinate
    /// registers.
    fn addressable(&self, rect: Rect) -> bool {
        rect.w <= self.caps.coordinate_limit && rect.h <= self.caps.coordinate_limit
    }

    /// Blend one A8 run covering the logical `bounds`, split into row bands
    /// that fit the executor's planes. `compose(plane, stride, window, band)`
    /// fills the plane for one band (`window` in physical pixels, `band` in
    /// logical pixels).
    fn blend_a8(
        &mut self,
        bounds: Clip,
        color: [u8; 3],
        compose: impl Fn(&mut [u8], u32, Rect, Clip),
    ) -> Option<()> {
        if self.local(bounds).is_empty() {
            return Some(());
        }
        let capacity = self.caps.mask_bytes;
        let scale = self.scale;
        let limit = self.caps.coordinate_limit;
        let mut bands = 0u32;
        let mut visit = |band: Clip| -> Option<()> {
            let window = self.local(band);
            let stride = window.w;
            let mask = self.next_mask()?;
            let plane = self.executor.mask_mut(mask);
            if plane.len() < (stride * window.h) as usize {
                return None;
            }
            compose(plane, stride, window, band);
            self.submit(Cmd::BlendA8 {
                dst: window,
                mask: MaskRef {
                    mask,
                    offset: 0,
                    stride,
                },
                color,
                alpha: 255,
            })?;
            self.stats.epic_blends += 1;
            bands += 1;
            Some(())
        };
        for_each_band(bounds, scale, Some(capacity), limit, &mut visit)?;
        if bands > 1 {
            self.stats.mask_bands += bands;
        }
        Some(())
    }

    fn gradient(
        &mut self,
        original: Clip,
        logical: Clip,
        from: u32,
        to: u32,
        direction: u32,
    ) -> Option<bool> {
        // Restarting a hardware gradient at a damage/scissor edge changes its
        // phase. Clipped gradients stay on the exact software path.
        if !self.caps.gradient
            || logical != original
            || original.intersect(self.surface) != original
        {
            return Some(false);
        }
        let (_, _, _, from_alpha) = channels(from);
        let (_, _, _, to_alpha) = channels(to);
        if from_alpha != 255 || to_alpha != 255 {
            return Some(false);
        }
        let corners = match direction {
            value if value == spec::GradDir::ToBottom as u32 => Corners {
                top_left: from,
                top_right: from,
                bottom_left: to,
                bottom_right: to,
            },
            value if value == spec::GradDir::ToTop as u32 => Corners {
                top_left: to,
                top_right: to,
                bottom_left: from,
                bottom_right: from,
            },
            value if value == spec::GradDir::ToRight as u32 => Corners {
                top_left: from,
                top_right: to,
                bottom_left: from,
                bottom_right: to,
            },
            value if value == spec::GradDir::ToLeft as u32 => Corners {
                top_left: to,
                top_right: from,
                bottom_left: to,
                bottom_right: from,
            },
            _ => return Some(false),
        };
        let rect = self.local(logical);
        if rect.is_empty()
            || rect.area() < self.caps.thresholds.min_gradient
            || !self.addressable(rect)
        {
            return Some(false);
        }
        self.submit(Cmd::Gradient { dst: rect, corners })?;
        self.stats.epic_gradients += 1;
        Some(true)
    }

    fn glyphs(&mut self, op: &[u32], bounds: Clip, slot: u8, color: u32) -> Option<bool> {
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return Some(true);
        }
        let res = self.res;
        let Some(atlas) = res.font_atlas(slot) else {
            return Some(true);
        };
        let rect = self.local(bounds);
        if !self.caps.a8_blend || rect.is_empty() || rect.area() < self.caps.thresholds.min_blend {
            return Some(false);
        }
        let scale = self.scale;
        self.blend_a8(
            bounds,
            [r as u8, g as u8, b as u8],
            |plane, stride, window, band| {
                fill_mask_window(plane, stride, window, 0);
                composite_glyph_run(
                    &atlas,
                    op,
                    physical_rect(band, scale),
                    scale,
                    a,
                    plane,
                    stride,
                    window,
                );
            },
        )?;
        Some(true)
    }

    #[allow(clippy::too_many_arguments)]
    fn alpha_quads(
        &mut self,
        words: &[u32],
        at: usize,
        count: usize,
        handle: i32,
        modulate: u32,
        bounds: Clip,
        clip: Clip,
    ) -> Option<bool> {
        let (r, g, b, a) = channels(modulate);
        if a == 0 {
            return Some(true);
        }
        let res = self.res;
        let Some(view) = res.texture(handle) else {
            return Some(false);
        };
        let rect = self.local(bounds);
        if !self.caps.a8_blend || rect.is_empty() || rect.area() < self.caps.thresholds.min_blend {
            return Some(false);
        }
        let scale = self.scale;
        self.blend_a8(
            bounds,
            [r as u8, g as u8, b as u8],
            |plane, stride, window, band| {
                fill_mask_window(plane, stride, window, 0);
                let band_clip = clip.intersect(band);
                for index in 0..count {
                    let op = &words[at + index * 9..at + index * 9 + 9];
                    alpha_quad_into_mask(
                        &view, op, band_clip, scale, plane, stride, a as u8, window,
                    );
                }
            },
        )?;
        Some(true)
    }

    fn tex_quad(&mut self, op: &[u32], handle: i32, logical: Clip) -> Option<bool> {
        let res = self.res;
        let Some(view) = res.texture(handle) else {
            return Some(false);
        };
        let modulate = op[8];
        let destination = self.local(logical);
        if destination.is_empty() {
            return Some(true);
        }
        if destination.area() < self.caps.thresholds.min_blit || !self.addressable(destination) {
            return Some(false);
        }
        let (_, _, _, alpha) = channels(modulate);
        if alpha == 0 {
            return Some(true);
        }
        // A fractional texel edge is a sampling transform a blit cannot
        // express; the op stays on the CPU rather than shifting its phase.
        let Some((source_rect, mirror_x, mirror_y)) = texture_source_rect(&view, op, logical)
        else {
            return Some(false);
        };
        let Some(src) = self.blit_source(handle, &view, modulate, false, mirror_y)? else {
            return Some(false);
        };
        self.submit(Cmd::Blit {
            src,
            src_rect: source_rect,
            dst: destination,
            clip: destination,
            mirror: Mirror {
                x: mirror_x,
                y: mirror_y,
            },
            modulate,
            filter: filter(&view),
        })?;
        self.stats.epic_copies += 1;
        Some(true)
    }

    /// The registration a blit of `handle` reads. `Some(None)` keeps the
    /// operation on the CPU: no hardware path for its tint, mirroring or
    /// layout. `None` is a failed registration.
    fn blit_source(
        &mut self,
        handle: i32,
        view: &TexView<'_>,
        modulate: u32,
        quad: bool,
        mirror_y: bool,
    ) -> Option<Option<TexSrc>> {
        let supported = if quad {
            self.caps.blit_quad
        } else {
            self.caps.blit && (!mirror_y || self.caps.blit_mirror_y)
        };
        if !supported || (modulate & 0x00ff_ffff != 0x00ff_ffff && !self.caps.blit_modulate) {
            return Some(None);
        }
        let resolved = self
            .textures
            .resolve(self.executor, self.res, handle, view, self.submission)
            .ok()?;
        Some(resolved.map(|resolved| {
            self.portable_used |= resolved.portable;
            TexSrc::Texture { id: resolved.id }
        }))
    }

    fn tri_pair(
        &mut self,
        quad: [Point; 4],
        color: u32,
        bounds: Clip,
        axis_aligned: bool,
    ) -> Option<bool> {
        let destination_clip = self.local(bounds);
        if destination_clip.area() < self.caps.thresholds.min_fill {
            return Some(false);
        }
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return Some(true);
        }
        if axis_aligned {
            // Z-only 2.5D projection and scaleX keep a solid card face axis
            // aligned; the rectangle fill covers it without a texture.
            let supported = if a == 255 {
                self.caps.fill_opaque
            } else {
                self.caps.fill_alpha
            };
            if !supported {
                return Some(false);
            }
            self.fill(bounds, [r as u8, g as u8, b as u8], a as u8)?;
            return Some(true);
        }
        if !self.caps.blit_quad || !self.addressable(destination_clip) {
            return Some(false);
        }
        let physical_quad = self.physical_quad(quad);
        self.submit(Cmd::BlitQuad {
            src: TexSrc::Solid { abgr: color },
            src_rect: Rect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
            quad: physical_quad,
            clip: destination_clip,
            modulate: MODULATE_NONE,
            filter: Filter::Nearest,
        })?;
        self.stats.epic_copies += 1;
        Some(true)
    }

    fn tex_tri_pair(
        &mut self,
        handle: i32,
        modulate: u32,
        source_rect: Rect,
        quad: [Point; 4],
        bounds: Clip,
    ) -> Option<bool> {
        let destination_clip = self.local(bounds);
        if destination_clip.area() < self.caps.thresholds.min_blit
            || !self.addressable(destination_clip)
        {
            return Some(false);
        }
        let (_, _, _, alpha) = channels(modulate);
        if alpha == 0 {
            return Some(true);
        }
        let res = self.res;
        let Some(view) = res.texture(handle) else {
            return Some(false);
        };
        let physical_quad = self.physical_quad(quad);
        if let Some(destination) = axis_aligned_texture_rect(physical_quad) {
            if let Some(src) = self.blit_source(handle, &view, modulate, false, false)? {
                self.submit(Cmd::Blit {
                    src,
                    src_rect: source_rect,
                    dst: destination,
                    clip: destination_clip,
                    mirror: Mirror::default(),
                    modulate,
                    filter: filter(&view),
                })?;
                self.stats.epic_copies += 1;
                return Some(true);
            }
        }
        let Some(src) = self.blit_source(handle, &view, modulate, true, false)? else {
            return Some(false);
        };
        self.submit(Cmd::BlitQuad {
            src,
            src_rect: source_rect,
            quad: physical_quad,
            clip: destination_clip,
            modulate,
            filter: filter(&view),
        })?;
        self.stats.epic_copies += 1;
        Some(true)
    }

    fn physical_quad(&self, quad: [Point; 4]) -> [Point; 4] {
        let scale = self.scale as i32;
        quad.map(|point| Point {
            x: (point.x - self.surface.x0) * scale,
            y: (point.y - self.surface.y0) * scale,
        })
    }
}

/// Visit logical sub-rectangles of `bounds` whose physical area at `scale`
/// fits `capacity` pixels (`None` capacity = unlimited): full-width row
/// bands when a row fits, otherwise single rows split into column chunks.
/// Fails when one logical pixel exceeds the capacity.
fn for_each_band(
    bounds: Clip,
    scale: u32,
    capacity: Option<u32>,
    extent_limit: u32,
    mut visit: impl FnMut(Clip) -> Option<()>,
) -> Option<()> {
    if bounds.is_empty() {
        return Some(());
    }
    let width = (bounds.x1 - bounds.x0) as u32;
    let height = (bounds.y1 - bounds.y0) as u32;
    // Logical pixels per axis that keep one band under the executor's
    // coordinate registers.
    let axis_max = (extent_limit / scale).max(1);
    let capacity = match capacity {
        Some(capacity) => capacity,
        None if width <= axis_max && height <= axis_max => return visit(bounds),
        None => u32::MAX,
    };
    let pixel = scale * scale;
    if pixel == 0 || capacity < pixel {
        return None;
    }
    let (cols, rows) = if width * pixel <= capacity {
        (width, (capacity / (width * pixel)).clamp(1, height))
    } else {
        ((capacity / pixel).clamp(1, width), 1)
    };
    let cols = cols.min(axis_max);
    let rows = rows.min(axis_max);
    let mut y = bounds.y0;
    while y < bounds.y1 {
        let y1 = (y + rows as i32).min(bounds.y1);
        let mut x = bounds.x0;
        while x < bounds.x1 {
            let x1 = (x + cols as i32).min(bounds.x1);
            visit(Clip::new(x, y, x1, y1))?;
            x = x1;
        }
        y = y1;
    }
    Some(())
}

fn filter(view: &TexView<'_>) -> Filter {
    if view.linear {
        Filter::Linear
    } else {
        Filter::Nearest
    }
}
