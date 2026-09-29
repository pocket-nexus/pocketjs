//! PocketJS RGB565 DrawList renderer with optional accelerator callbacks.
//!
//! The render target is always opaque RGB565. Hardware-friendly operations
//! are submitted through [`PpaOps`]; unsupported operations are executed in
//! order by the core's RGB565 software rasterizer. A single aligned A8 scratch
//! plane batches glyphs and alpha-only quads, so antialiasing never requires
//! a 32-bit color framebuffer.

#![cfg_attr(not(test), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use pocketjs_core::resources::RenderResources;

use pocketjs_core::damage::{
    DamagePlan, DamagePolicy, DamageRect as Clip, DamageTarget, DamageTracker,
    DEFAULT_DAMAGE_REGIONS,
};
use pocketjs_core::raster::{
    coverage_index, linear_sample_coordinates, pack_rgb565, render_scaled_rgb565_over,
    render_scaled_rgb565_window_over,
};
#[cfg(test)]
use pocketjs_core::Ui;
use pocketjs_core::{spec, TexView};

const MASK_ALIGNMENT: usize = 128;
const CLIP_DEPTH: usize = 32;
const TEXTURE_CLASS_CACHE_LEN: usize = 64;
const MAX_DAMAGE_REGIONS: usize = DEFAULT_DAMAGE_REGIONS;
const FULL_REDRAW_PERCENT: u8 = 75;
const DAMAGE_TARGET_SIGNATURE: u64 = u32::from_be_bytes(*b"PPA5") as u64;

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
    const fn is_empty(self) -> bool {
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
/// once a method returns `true`, the destination pixels must be visible to
/// subsequent CPU or PPA operations. Returning `false` requests the ordered
/// software fallback.
pub trait PpaOps {
    /// Fill `rect` in the full RGB565 destination.
    fn fill_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        rect: Rect,
        color: u16,
    ) -> bool;

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
    ) -> bool;

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
    ) -> bool;
}

/// Heuristics controlling when transaction overhead is worth paying.
#[derive(Clone, Copy, Debug)]
pub struct RendererConfig {
    pub scale: u32,
    pub min_fill_pixels: u32,
    pub min_blend_pixels: u32,
    pub min_srm_pixels: u32,
}

impl Default for RendererConfig {
    fn default() -> Self {
        Self {
            scale: 1,
            min_fill_pixels: 1024,
            min_blend_pixels: 256,
            min_srm_pixels: 256,
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

/// Core damage snapshot describing the pixels stored in one framebuffer.
pub type RenderTargetState = DamageTracker<MAX_DAMAGE_REGIONS>;

/// Damage plan produced for one persistent render target.
pub type RenderDamagePlan = DamagePlan<MAX_DAMAGE_REGIONS>;

/// Persistent DrawList renderer. The A8 plane and fallback word buffer are
/// reused across frames.
pub struct Renderer {
    config: RendererConfig,
    mask_storage: Vec<u128>,
    mask_offset: usize,
    mask_capacity: usize,
    mask_len: usize,
    fallback_words: Vec<u32>,
    alpha_texture_cache: Vec<(i32, bool)>,
    raster_revision: u64,
}

impl Renderer {
    pub fn new(config: RendererConfig) -> Option<Self> {
        if !(1..=pocketjs_core::raster::MAX_RENDER_SCALE).contains(&config.scale) {
            return None;
        }
        Some(Self {
            config,
            mask_storage: Vec::new(),
            mask_offset: 0,
            mask_capacity: 0,
            mask_len: 0,
            fallback_words: Vec::with_capacity(16),
            alpha_texture_cache: Vec::new(),
            raster_revision: 0,
        })
    }

    pub fn config(&self) -> RendererConfig {
        self.config
    }

    /// Drop classifications derived from texture bytes after resources are
    /// changed in place. Framebuffer states must be invalidated separately.
    pub fn invalidate_resources(&mut self) {
        self.alpha_texture_cache.clear();
        self.raster_revision = 0;
    }

    fn sync_resources(&mut self, ui: &impl RenderResources) {
        let revision = ui.raster_revision();
        if self.raster_revision != revision {
            self.alpha_texture_cache.clear();
            self.raster_revision = revision;
        }
    }

    /// Render a complete DrawList. `destination` dimensions must equal the
    /// UI viewport multiplied by `config.scale`.
    pub fn render<O: PpaOps>(
        &mut self,
        ui: &impl RenderResources,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        ppa: &mut O,
    ) -> Option<RenderStats> {
        self.sync_resources(ui);
        let screen = self.target_screen(ui, destination, width, height)?;
        let damage = DamagePlan::<MAX_DAMAGE_REGIONS>::full(screen);
        self.render_damage(ui, words, destination, width, height, &damage, true, ppa)
    }

    /// Compute damage against the DrawList last committed to `target`.
    ///
    /// This does not mutate `target`. Call [`commit_damage`](Self::commit_damage)
    /// only after every corresponding output update has completed successfully,
    /// or [`abort_damage`](Self::abort_damage) after a failed/partial update.
    pub fn prepare_damage(
        &mut self,
        target: &RenderTargetState,
        ui: &impl RenderResources,
        words: &[u32],
    ) -> Option<RenderDamagePlan> {
        self.sync_resources(ui);
        let damage_target = self.damage_target(ui)?;
        target
            .prepare(ui, words, damage_target)
            .ok()?
            .with_policy(DamagePolicy::new(FULL_REDRAW_PERCENT))
            .ok()
    }

    /// Record a successfully presented DrawList in one persistent target.
    pub fn commit_damage(
        &self,
        target: &mut RenderTargetState,
        ui: &impl RenderResources,
        words: &[u32],
    ) -> bool {
        let Some(damage_target) = self.damage_target(ui) else {
            target.invalidate();
            return false;
        };
        target.commit(ui, words, damage_target);
        true
    }

    /// Invalidate a persistent target after an aborted or partial update.
    pub fn abort_damage(&self, target: &mut RenderTargetState) {
        target.invalidate();
    }

    /// Repaint only pixels whose DrawList operations differ from the snapshot
    /// stored in `target`.
    ///
    /// The destination must retain the pixels produced by the same
    /// `RenderTargetState`; double-buffered hosts therefore keep one state per
    /// buffer. Structural DrawList changes, invalidated resources, and damage
    /// covering most of the screen conservatively fall back to a full redraw.
    #[allow(clippy::too_many_arguments)]
    pub fn render_incremental<O: PpaOps>(
        &mut self,
        target: &mut RenderTargetState,
        ui: &impl RenderResources,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        ppa: &mut O,
    ) -> Option<RenderStats> {
        self.target_screen(ui, destination, width, height)?;
        let damage = self.prepare_damage(target, ui, words)?;
        let full_redraw = damage.is_full_redraw();

        let result = self.render_damage(
            ui,
            words,
            destination,
            width,
            height,
            &damage,
            full_redraw,
            ppa,
        );
        if result.is_some() {
            if !self.commit_damage(target, ui, words) {
                return None;
            }
        } else {
            self.abort_damage(target);
        }
        result
    }

    /// Render one global logical dirty rectangle into a tightly packed
    /// full-width horizontal strip.
    ///
    /// `region.y..region.y + region.h` defines both the strip's global vertical
    /// interval and its height. The backing buffer is
    /// `viewport_width * region.h` pixels at `config.scale`; pixels outside
    /// `region.x..region.x + region.w` are left untouched. DrawList geometry and
    /// sampling remain in global viewport coordinates while all PPA surfaces
    /// and mask offsets are translated to strip-local coordinates.
    pub fn render_strip<O: PpaOps>(
        &mut self,
        ui: &impl RenderResources,
        words: &[u32],
        destination: &mut [u16],
        region: Rect,
        ppa: &mut O,
    ) -> Option<RenderStats> {
        self.sync_resources(ui);
        if region.is_empty() {
            return None;
        }
        let (viewport_w, viewport_h) = ui.viewport();
        let logical_width = viewport_w as u32;
        let logical_height = viewport_h as u32;
        let x1 = region.x.checked_add(region.w)?;
        let y1 = region.y.checked_add(region.h)?;
        if logical_width == 0 || logical_height == 0 || x1 > logical_width || y1 > logical_height {
            return None;
        }

        let scale = self.config.scale;
        let width = logical_width.checked_mul(scale)?;
        let height = region.h.checked_mul(scale)?;
        if destination.len() != width as usize * height as usize {
            return None;
        }

        let surface = Clip {
            x0: 0,
            y0: region.y as i32,
            x1: logical_width as i32,
            y1: y1 as i32,
        };
        let clip = Clip {
            x0: region.x as i32,
            y0: region.y as i32,
            x1: x1 as i32,
            y1: y1 as i32,
        };
        let local = local_physical_rect(clip, surface, scale);
        let mut stats = RenderStats {
            damage_regions: 1,
            damage_pixels: region.area().saturating_mul(scale).saturating_mul(scale),
            damage_bounds: physical_rect(clip, scale),
            ..RenderStats::default()
        };

        self.ensure_mask(destination.len());
        if local.area() >= self.config.min_fill_pixels
            && ppa.fill_rgb565(destination, width, height, local, 0)
        {
            stats.ppa_fills += 1;
        } else {
            fill_rgb565_rect(destination, width, local, 0);
        }
        self.render_region(
            ui,
            words,
            destination,
            width,
            height,
            surface,
            clip,
            ppa,
            &mut stats,
        )?;
        Some(stats)
    }

    fn damage_target(&self, ui: &impl RenderResources) -> Option<DamageTarget> {
        let scale = self.config.scale;
        let (viewport_w, viewport_h) = ui.viewport();
        let width = (viewport_w as u32).checked_mul(scale)?;
        let height = (viewport_h as u32).checked_mul(scale)?;
        if width == 0 || height == 0 {
            return None;
        }
        Some(DamageTarget::new(
            width,
            height,
            scale,
            DAMAGE_TARGET_SIGNATURE,
        ))
    }

    fn target_screen(
        &self,
        ui: &impl RenderResources,
        destination: &[u16],
        width: u32,
        height: u32,
    ) -> Option<Clip> {
        let scale = self.config.scale;
        let (viewport_w, viewport_h) = ui.viewport();
        if viewport_w as u32 * scale != width
            || viewport_h as u32 * scale != height
            || destination.len() != width as usize * height as usize
        {
            return None;
        }
        Some(Clip {
            x0: 0,
            y0: 0,
            x1: viewport_w as i32,
            y1: viewport_h as i32,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn render_damage<O: PpaOps>(
        &mut self,
        ui: &impl RenderResources,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        damage: &DamagePlan<MAX_DAMAGE_REGIONS>,
        full_redraw: bool,
        ppa: &mut O,
    ) -> Option<RenderStats> {
        let scale = self.config.scale;
        let surface = Clip {
            x0: 0,
            y0: 0,
            x1: (width / scale) as i32,
            y1: (height / scale) as i32,
        };
        let mut stats = RenderStats {
            damage_regions: damage.region_count() as u32,
            damage_pixels: damage
                .area()
                .saturating_mul(scale as u64)
                .saturating_mul(scale as u64)
                .min(u32::MAX as u64) as u32,
            damage_bounds: physical_rect(damage.bounds(), scale),
            full_redraw,
            ..RenderStats::default()
        };
        if damage.is_empty() {
            return Some(stats);
        }

        self.ensure_mask(destination.len());
        for &region in damage.regions() {
            let physical = local_physical_rect(region, surface, scale);
            if physical.area() >= self.config.min_fill_pixels
                && ppa.fill_rgb565(destination, width, height, physical, 0)
            {
                stats.ppa_fills += 1;
            } else {
                fill_rgb565_rect(destination, width, physical, 0);
            }
            self.render_region(
                ui,
                words,
                destination,
                width,
                height,
                surface,
                region,
                ppa,
                &mut stats,
            )?;
        }
        Some(stats)
    }

    #[allow(clippy::too_many_arguments)]
    fn render_region<O: PpaOps>(
        &mut self,
        ui: &impl RenderResources,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        screen: Clip,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Option<()> {
        let mut stack = [screen; CLIP_DEPTH];
        let mut depth = 0usize;
        let mut clip = screen;
        let mut i = 0usize;
        while i < words.len() {
            match words[i] {
                spec::draw_op::RECT if i + 4 <= words.len() => {
                    let rect = logical_rect(words[i + 1], words[i + 2]).intersect(clip);
                    let op = &words[i..i + 4];
                    if !rect.is_empty()
                        && !self.try_rect(
                            destination,
                            width,
                            height,
                            surface,
                            rect,
                            words[i + 3],
                            ppa,
                            stats,
                        )
                    {
                        self.software_op(ui, destination, surface, clip, op, stats);
                    }
                    i += 4;
                }
                spec::draw_op::GRAD_RECT if i + 6 <= words.len() => {
                    if !logical_rect(words[i + 1], words[i + 2])
                        .intersect(clip)
                        .is_empty()
                    {
                        self.software_op(ui, destination, surface, clip, &words[i..i + 6], stats);
                    }
                    i += 6;
                }
                spec::draw_op::GLYPH_RUN if i + 3 <= words.len() => {
                    let count = (words[i + 1] >> 16) as usize;
                    let next = i.checked_add(3 + count * 2)?;
                    if next > words.len() {
                        return None;
                    }
                    let op = &words[i..next];
                    if !glyph_run_bounds(ui, op, clip).is_empty()
                        && !self.try_glyph_run(
                            ui,
                            destination,
                            width,
                            height,
                            surface,
                            clip,
                            op,
                            ppa,
                            stats,
                        )
                    {
                        self.software_op(ui, destination, surface, clip, op, stats);
                    }
                    i = next;
                }
                spec::draw_op::TEX_QUAD if i + 9 <= words.len() => {
                    if logical_rect(words[i + 2], words[i + 3])
                        .intersect(clip)
                        .is_empty()
                    {
                        i += 9;
                        continue;
                    }
                    let next = self.try_tex_quad_run(
                        ui,
                        words,
                        i,
                        destination,
                        width,
                        height,
                        surface,
                        clip,
                        ppa,
                        stats,
                    );
                    if let Some(next) = next {
                        i = next;
                    } else {
                        self.software_op(ui, destination, surface, clip, &words[i..i + 9], stats);
                        i += 9;
                    }
                }
                spec::draw_op::SCISSOR if i + 3 <= words.len() => {
                    if depth >= stack.len() {
                        return None;
                    }
                    stack[depth] = clip;
                    depth += 1;
                    clip = screen.intersect(logical_rect(words[i + 1], words[i + 2]));
                    i += 3;
                }
                spec::draw_op::SCISSOR_POP => {
                    if depth > 0 {
                        depth -= 1;
                        clip = stack[depth];
                    } else {
                        clip = screen;
                    }
                    i += 1;
                }
                spec::draw_op::TRI if i + 7 <= words.len() => {
                    if !triangle_bounds([words[i + 1], words[i + 2], words[i + 3]], clip).is_empty()
                    {
                        self.software_op(ui, destination, surface, clip, &words[i..i + 7], stats);
                    }
                    i += 7;
                }
                spec::draw_op::TEX_TRI if i + 12 <= words.len() => {
                    if !triangle_bounds([words[i + 2], words[i + 5], words[i + 8]], clip).is_empty()
                    {
                        self.software_op(ui, destination, surface, clip, &words[i..i + 12], stats);
                    }
                    i += 12;
                }
                spec::draw_op::SURFACE_QUAD if i + 9 <= words.len() => {
                    // No application compositor on the PPA target; preserve the
                    // shell fallback and keep decoding later shell ops.
                    i += 9;
                }
                _ => return None,
            }
        }
        Some(())
    }

    fn try_rect<O: PpaOps>(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        logical: Clip,
        color: u32,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> bool {
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return true;
        }
        let rect = local_physical_rect(logical, surface, self.config.scale);
        if a == 255 && rect.area() >= self.config.min_fill_pixels {
            if ppa.fill_rgb565(destination, width, height, rect, pack_rgb565(r, g, b)) {
                stats.ppa_fills += 1;
                return true;
            }
        } else if rect.area() >= self.config.min_blend_pixels {
            let mask = self.mask_mut();
            fill_mask_rect(mask, width, rect, a as u8);
            if ppa.blend_a8_rgb565(
                destination,
                width,
                height,
                mask,
                rect,
                [r as u8, g as u8, b as u8],
                255,
            ) {
                stats.ppa_blends += 1;
                return true;
            }
        }
        false
    }

    #[allow(clippy::too_many_arguments)]
    fn try_glyph_run<O: PpaOps>(
        &mut self,
        ui: &impl RenderResources,
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        clip: Clip,
        op: &[u32],
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> bool {
        let slot = (op[1] & 0xff) as u8;
        let color = op[2];
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return true;
        }
        let Some(atlas) = ui.font_atlas(slot) else {
            return true;
        };
        let scale = self.config.scale as i32;
        let cell_w = atlas.cell_w as i32;
        let cell_h = atlas.cell_h as i32;
        let mut bounds = Clip::empty();
        for glyph in op[3..].chunks_exact(2) {
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
        if rect.is_empty() || rect.area() < self.config.min_blend_pixels {
            return false;
        }
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        let density = atlas.raster_density as i32;
        let coverage_w = atlas.coverage_width() as i32;
        let coverage_h = atlas.coverage_height() as i32;
        let bpr = atlas.bytes_per_row();
        for glyph in op[3..].chunks_exact(2) {
            let (gx, gy) = xy(glyph[0]);
            let gid = (glyph[1] & 0xffff) as u16;
            if gid >= atlas.glyph_count {
                continue;
            }
            let rows = atlas.glyph_rows(gid);
            let x0 = (gx * scale).max(global_rect.x as i32);
            let y0 = (gy * scale).max(global_rect.y as i32);
            let x1 = ((gx + cell_w) * scale).min((global_rect.x + global_rect.w) as i32);
            let y1 = ((gy + cell_h) * scale).min((global_rect.y + global_rect.h) as i32);
            for py in y0..y1 {
                let sy = coverage_index(py - gy * scale, scale, density, coverage_h);
                let row = &rows[sy * bpr..];
                for px in x0..x1 {
                    let sx = coverage_index(px - gx * scale, scale, density, coverage_w);
                    let local_x = px - surface.x0 * scale;
                    let local_y = py - surface.y0 * scale;
                    composite_mask(
                        &mut mask[local_y as usize * width as usize + local_x as usize],
                        ((row[sx] as u32 * a + 127) / 255) as u8,
                    );
                }
            }
        }
        if ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ) {
            stats.ppa_blends += 1;
            true
        } else {
            false
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn try_tex_quad_run<O: PpaOps>(
        &mut self,
        ui: &impl RenderResources,
        words: &[u32],
        start: usize,
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        clip: Clip,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Option<usize> {
        let op = &words[start..start + 9];
        let handle = op[1] as i32;
        let view = ui.texture(handle)?;

        if view.psm == spec::psm::PSM_5650 {
            let logical = logical_rect(op[2], op[3]).intersect(clip);
            let destination_rect = local_physical_rect(logical, surface, self.config.scale);
            if destination_rect.area() >= self.config.min_srm_pixels {
                let (source_rect, mirror_x, mirror_y) = texture_source_rect(&view, op, logical)?;
                let one_to_one =
                    source_rect.w == destination_rect.w && source_rect.h == destination_rect.h;
                if (one_to_one || view.linear) && op[8] == 0xffff_ffff {
                    let transform = SrmTransform {
                        mirror_x,
                        mirror_y,
                        ..SrmTransform::default()
                    };
                    if ppa.srm_psm5650_to_rgb565(
                        destination,
                        width,
                        height,
                        view.pixels,
                        view.w,
                        view.h,
                        source_rect,
                        destination_rect,
                        transform,
                    ) {
                        stats.ppa_srm += 1;
                        return Some(start + 9);
                    }
                }
            }
            return None;
        }

        if !self.is_white_alpha_texture(handle, &view) {
            return None;
        }
        let modulate = op[8];
        let mut end = start;
        let mut bounds = Clip::empty();
        while end + 9 <= words.len()
            && words[end] == spec::draw_op::TEX_QUAD
            && words[end + 1] == handle as u32
            && words[end + 8] == modulate
        {
            bounds = bounds.union(logical_rect(words[end + 2], words[end + 3]).intersect(clip));
            end += 9;
        }
        let (r, g, b, a) = channels(modulate);
        if a == 0 {
            return Some(end);
        }
        let rect = local_physical_rect(bounds, surface, self.config.scale);
        if rect.is_empty() || rect.area() < self.config.min_blend_pixels {
            return None;
        }
        let scale = self.config.scale;
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        let mut cursor = start;
        while cursor < end {
            alpha_quad_into_mask(
                &view,
                &words[cursor..cursor + 9],
                surface,
                clip,
                scale,
                mask,
                width,
                a as u8,
            );
            cursor += 9;
        }
        if ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ) {
            stats.ppa_blends += 1;
            Some(end)
        } else {
            None
        }
    }

    fn software_op(
        &mut self,
        ui: &impl RenderResources,
        destination: &mut [u16],
        surface: Clip,
        clip: Clip,
        op: &[u32],
        stats: &mut RenderStats,
    ) {
        if clip.is_empty() {
            return;
        }
        self.fallback_words.clear();
        self.fallback_words.push(spec::draw_op::SCISSOR);
        self.fallback_words.push(pack_xy(clip.x0, clip.y0));
        self.fallback_words
            .push(pack_wh(clip.x1 - clip.x0, clip.y1 - clip.y0));
        self.fallback_words.extend_from_slice(op);
        let full_screen = {
            let (viewport_w, viewport_h) = ui.viewport();
            Clip {
                x0: 0,
                y0: 0,
                x1: viewport_w as i32,
                y1: viewport_h as i32,
            }
        };
        if surface == full_screen {
            render_scaled_rgb565_over(ui, &self.fallback_words, destination, self.config.scale);
        } else {
            render_scaled_rgb565_window_over(
                ui,
                &self.fallback_words,
                destination,
                self.config.scale,
                surface,
            );
        }
        stats.software_ops += 1;
        stats.software_words += op.len() as u32;
    }

    fn ensure_mask(&mut self, len: usize) {
        if self.mask_capacity < len {
            let bytes = len + MASK_ALIGNMENT - 1;
            self.mask_storage = alloc::vec![0u128; bytes.div_ceil(16)];
            let base = self.mask_storage.as_ptr() as usize;
            self.mask_offset = (MASK_ALIGNMENT - base % MASK_ALIGNMENT) % MASK_ALIGNMENT;
            self.mask_capacity = len;
        }
        self.mask_len = len;
    }

    fn mask_mut(&mut self) -> &mut [u8] {
        unsafe {
            core::slice::from_raw_parts_mut(
                (self.mask_storage.as_mut_ptr() as *mut u8).add(self.mask_offset),
                self.mask_len,
            )
        }
    }

    fn is_white_alpha_texture(&mut self, handle: i32, view: &TexView<'_>) -> bool {
        // T8 video planes can replace their palette and indices in place, so
        // their classification is intentionally never cached.
        if view.psm == spec::psm::PSM_T8 {
            return is_white_alpha_texture(view);
        }
        if let Some((_, result)) = self
            .alpha_texture_cache
            .iter()
            .find(|(cached, _)| *cached == handle)
        {
            return *result;
        }
        let result = is_white_alpha_texture(view);
        if self.alpha_texture_cache.len() == TEXTURE_CLASS_CACHE_LEN {
            self.alpha_texture_cache.remove(0);
        }
        self.alpha_texture_cache.push((handle, result));
        result
    }
}

fn glyph_run_bounds(ui: &impl RenderResources, words: &[u32], clip: Clip) -> Clip {
    if words.len() < 3 || words[2] >> 24 == 0 {
        return Clip::empty();
    }
    let slot = (words[1] & 0xff) as u8;
    let Some(atlas) = ui.font_atlas(slot) else {
        return Clip::empty();
    };
    let mut bounds = Clip::empty();
    for glyph in words[3..].chunks_exact(2) {
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

fn fill_rgb565_rect(destination: &mut [u16], stride: u32, rect: Rect, color: u16) {
    for y in rect.y..rect.y + rect.h {
        let start = y as usize * stride as usize + rect.x as usize;
        destination[start..start + rect.w as usize].fill(color);
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

#[inline]
fn pack_xy(x: i32, y: i32) -> u32 {
    x as i16 as u16 as u32 | ((y as i16 as u16 as u32) << 16)
}

#[inline]
fn pack_wh(w: i32, h: i32) -> u32 {
    w as u16 as u32 | ((h as u16 as u32) << 16)
}

#[inline]
fn fill_mask_rect(mask: &mut [u8], stride: u32, rect: Rect, value: u8) {
    for y in rect.y..rect.y + rect.h {
        let start = y as usize * stride as usize + rect.x as usize;
        mask[start..start + rect.w as usize].fill(value);
    }
}

#[inline]
fn composite_mask(destination: &mut u8, source: u8) {
    let d = *destination as u32;
    let s = source as u32;
    *destination = (s + (d * (255 - s) + 127) / 255) as u8;
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
        spec::psm::PSM_8888 => view.pixels[..count * 4].chunks_exact(4).all(|p| {
            let white = p[0] == 255 && p[1] == 255 && p[2] == 255;
            white || (!view.linear && p[3] == 0)
        }),
        spec::psm::PSM_4444 => view.pixels[..count * 2].chunks_exact(2).all(|p| {
            let pixel = u16::from_le_bytes([p[0], p[1]]);
            pixel & 0x0fff == 0x0fff || (!view.linear && pixel >> 12 == 0)
        }),
        spec::psm::PSM_T8 => {
            let Some(palette) = view.palette else {
                return false;
            };
            view.pixels[..count].iter().all(|&index| {
                let p = index as usize * 4;
                let white = palette[p] == 255 && palette[p + 1] == 255 && palette[p + 2] == 255;
                white || (!view.linear && palette[p + 3] == 0)
            })
        }
        _ => false,
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

fn sample_alpha(view: &TexView<'_>, u: f32, v: f32) -> u8 {
    if !view.linear {
        return texel_alpha(view, (u * view.w as f32) as i32, (v * view.h as f32) as i32) as u8;
    }
    let Some(sample) = linear_sample_coordinates(view.w, view.h, u, v) else {
        return 0;
    };
    let lerp = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let top = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y0 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y0 as i32),
        sample.fx,
    );
    let bottom = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y1 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y1 as i32),
        sample.fx,
    );
    lerp(top, bottom, sample.fy) as u8
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
    let logical = logical_rect(op[2], op[3]).intersect(clip);
    if logical.is_empty() {
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
    for py in physical.y..physical.y + physical.h {
        let v = v0 + (v1 - v0) * ((py as i32 - y * scale_i) as f32 + 0.5) / (h * scale_i) as f32;
        for px in physical.x..physical.x + physical.w {
            let u =
                u0 + (u1 - u0) * ((px as i32 - x * scale_i) as f32 + 0.5) / (w * scale_i) as f32;
            let alpha = (sample_alpha(view, u, v) as u32 * global_alpha as u32 + 127) / 255;
            let local_x = px as i32 - surface.x0 * scale_i;
            let local_y = py as i32 - surface.y0 * scale_i;
            composite_mask(
                &mut mask[local_y as usize * stride as usize + local_x as usize],
                alpha as u8,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[derive(Default)]
    struct MockPpa {
        fills: u32,
        blends: u32,
        srm: u32,
        last_mask_max: u8,
        last_mask: Vec<u8>,
        last_global_alpha: u8,
        last_surface_width: u32,
        last_surface_height: u32,
        last_fill_rect: Rect,
        last_blend_rect: Rect,
        last_mask_len: usize,
        last_source_rect: Rect,
        last_destination_rect: Rect,
        last_transform: SrmTransform,
    }

    impl PpaOps for MockPpa {
        fn fill_rgb565(
            &mut self,
            destination: &mut [u16],
            width: u32,
            height: u32,
            rect: Rect,
            color: u16,
        ) -> bool {
            self.fills += 1;
            self.last_surface_width = width;
            self.last_surface_height = height;
            self.last_fill_rect = rect;
            for y in rect.y..rect.y + rect.h {
                let start = y as usize * width as usize + rect.x as usize;
                destination[start..start + rect.w as usize].fill(color);
            }
            true
        }

        fn blend_a8_rgb565(
            &mut self,
            destination: &mut [u16],
            width: u32,
            height: u32,
            mask: &[u8],
            rect: Rect,
            color: [u8; 3],
            global_alpha: u8,
        ) -> bool {
            self.blends += 1;
            self.last_surface_width = width;
            self.last_surface_height = height;
            self.last_blend_rect = rect;
            self.last_mask_len = mask.len();
            self.last_mask_max = mask.iter().copied().max().unwrap_or(0);
            self.last_mask.clear();
            self.last_mask.extend_from_slice(mask);
            self.last_global_alpha = global_alpha;
            for y in rect.y..rect.y + rect.h {
                for x in rect.x..rect.x + rect.w {
                    let index = y as usize * width as usize + x as usize;
                    let alpha = (mask[index] as u32 * global_alpha as u32 + 127) / 255;
                    blend_rgb565(&mut destination[index], color, alpha);
                }
            }
            true
        }

        fn srm_psm5650_to_rgb565(
            &mut self,
            destination: &mut [u16],
            width: u32,
            _height: u32,
            source: &[u8],
            source_width: u32,
            _source_height: u32,
            source_rect: Rect,
            destination_rect: Rect,
            transform: SrmTransform,
        ) -> bool {
            self.srm += 1;
            self.last_source_rect = source_rect;
            self.last_destination_rect = destination_rect;
            self.last_transform = transform;
            if transform.rotation != QuarterTurn::None
                || source_rect.w != destination_rect.w
                || source_rect.h != destination_rect.h
            {
                return false;
            }
            for dy in 0..destination_rect.h {
                let sy = if transform.mirror_y {
                    source_rect.y + source_rect.h - 1 - dy
                } else {
                    source_rect.y + dy
                };
                for dx in 0..destination_rect.w {
                    let sx = if transform.mirror_x {
                        source_rect.x + source_rect.w - 1 - dx
                    } else {
                        source_rect.x + dx
                    };
                    let source_index = (sy * source_width + sx) as usize * 2;
                    let psm5650 =
                        u16::from_le_bytes([source[source_index], source[source_index + 1]]);
                    let rgb565 = ((psm5650 & 0x001f) << 11)
                        | (psm5650 & 0x07e0)
                        | ((psm5650 & 0xf800) >> 11);
                    let destination_index = (destination_rect.y + dy) as usize * width as usize
                        + (destination_rect.x + dx) as usize;
                    destination[destination_index] = rgb565;
                }
            }
            true
        }
    }

    fn blend_rgb565(destination: &mut u16, color: [u8; 3], alpha: u32) {
        if alpha == 0 {
            return;
        }
        if alpha >= 255 {
            *destination = pack_rgb565(color[0] as u32, color[1] as u32, color[2] as u32);
            return;
        }
        let r5 = (*destination as u32 >> 11) & 0x1f;
        let g6 = (*destination as u32 >> 5) & 0x3f;
        let b5 = *destination as u32 & 0x1f;
        let destination_color = [
            (r5 << 3) | (r5 >> 2),
            (g6 << 2) | (g6 >> 4),
            (b5 << 3) | (b5 >> 2),
        ];
        let inverse_alpha = 255 - alpha;
        let mix = |source: u8, destination: u32| {
            (source as u32 * alpha + destination * inverse_alpha + 127) / 255
        };
        *destination = pack_rgb565(
            mix(color[0], destination_color[0]),
            mix(color[1], destination_color[1]),
            mix(color[2], destination_color[2]),
        );
    }

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn renderer() -> Renderer {
        Renderer::new(RendererConfig {
            scale: 1,
            min_fill_pixels: 1,
            min_blend_pixels: 1,
            min_srm_pixels: 1,
        })
        .unwrap()
    }

    #[test]
    fn core_resource_revision_invalidates_texture_classifications() {
        let mut ui = Ui::new();
        let mut renderer = renderer();
        renderer.sync_resources(&ui);
        renderer.alpha_texture_cache.push((7, true));

        assert_eq!(
            ui.upload_texture(&[0xff, 0xff], 1, 1, spec::psm::PSM_5650),
            0
        );
        renderer.sync_resources(&ui);
        assert!(renderer.alpha_texture_cache.is_empty());
        assert_eq!(renderer.raster_revision, ui.raster_revision());
    }

    fn full_reference(ui: &Ui, words: &[u32], width: usize, height: usize) -> Vec<u16> {
        let mut output = vec![0u16; width * height];
        pocketjs_core::raster::render_scaled_rgb565(ui, words, &mut output, 1);
        output
    }

    #[test]
    fn compact_strip_matches_the_same_window_of_a_full_render() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 10.0);
        let words = [
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(16, 10),
            0xff20_1008,
            spec::draw_op::GRAD_RECT,
            xy_word(2, 2),
            wh_word(12, 6),
            0xff00_0040,
            0xffc0_8000,
            spec::GradDir::ToRight as u32,
            spec::draw_op::RECT,
            xy_word(5, 3),
            wh_word(5, 5),
            0x8000_ff00,
        ];
        let region = Rect {
            x: 3,
            y: 4,
            w: 9,
            h: 3,
        };
        let untouched = 0x5aa5;
        let mut strip = vec![untouched; 16 * region.h as usize];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render_strip(&ui, &words, &mut strip, region, &mut ppa)
            .unwrap();
        let full = full_reference(&ui, &words, 16, 10);

        assert_eq!(stats.damage_bounds, region);
        assert!(
            stats.software_ops > 0,
            "gradient must exercise window fallback"
        );
        for local_y in 0..region.h as usize {
            let global_y = region.y as usize + local_y;
            for x in 0..16usize {
                let actual = strip[local_y * 16 + x];
                if x >= region.x as usize && x < (region.x + region.w) as usize {
                    assert_eq!(actual, full[global_y * 16 + x], "pixel ({x},{global_y})");
                } else {
                    assert_eq!(actual, untouched, "strip write escaped dirty x range");
                }
            }
        }
    }

    #[test]
    fn strip_ppa_rects_and_masks_are_local_and_mask_length_tracks_each_strip() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 10.0);
        let words = [
            spec::draw_op::RECT,
            xy_word(4, 5),
            wh_word(3, 2),
            0x8000_00ff,
        ];
        let mut renderer = renderer();

        let mut large = vec![0u16; 16 * 4];
        let mut large_ppa = MockPpa::default();
        renderer
            .render_strip(
                &ui,
                &words,
                &mut large,
                Rect {
                    x: 4,
                    y: 3,
                    w: 3,
                    h: 4,
                },
                &mut large_ppa,
            )
            .unwrap();
        assert_eq!(large_ppa.last_mask_len, 16 * 4);

        let mut small = vec![0u16; 16 * 2];
        let mut small_ppa = MockPpa::default();
        renderer
            .render_strip(
                &ui,
                &words,
                &mut small,
                Rect {
                    x: 4,
                    y: 5,
                    w: 3,
                    h: 2,
                },
                &mut small_ppa,
            )
            .unwrap();
        assert_eq!(small_ppa.last_surface_width, 16);
        assert_eq!(small_ppa.last_surface_height, 2);
        assert_eq!(
            small_ppa.last_blend_rect,
            Rect {
                x: 4,
                y: 0,
                w: 3,
                h: 2,
            }
        );
        assert_eq!(small_ppa.last_mask_len, 16 * 2);
    }

    #[test]
    fn split_damage_transactions_track_two_native_targets_independently() {
        let mut ui = Ui::new();
        ui.set_viewport(24.0, 8.0);
        let frame = |x: i16, color: u32| {
            vec![
                spec::draw_op::RECT,
                xy_word(0, 0),
                wh_word(24, 8),
                0xff10_0804,
                spec::draw_op::RECT,
                xy_word(x, 2),
                wh_word(3, 3),
                color,
            ]
        };
        let first = frame(1, 0xff00_00ff);
        let second = frame(5, 0xff00_ff00);
        let third = frame(9, 0xffff_0000);
        let mut states = [RenderTargetState::new(), RenderTargetState::new()];
        let mut renderer = renderer();

        assert!(renderer
            .prepare_damage(&states[0], &ui, &first)
            .unwrap()
            .is_full_redraw());
        assert!(renderer.commit_damage(&mut states[0], &ui, &first));
        assert!(renderer
            .prepare_damage(&states[1], &ui, &second)
            .unwrap()
            .is_full_redraw());
        assert!(renderer.commit_damage(&mut states[1], &ui, &second));

        let target_zero = renderer.prepare_damage(&states[0], &ui, &third).unwrap();
        assert!(!target_zero.is_full_redraw());
        assert!(!target_zero.is_empty());
        let target_one_unchanged = renderer.prepare_damage(&states[1], &ui, &second).unwrap();
        assert!(target_one_unchanged.is_empty());
    }

    #[test]
    fn incremental_render_skips_an_unchanged_target() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 8.0);
        let words = [
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(16, 8),
            0xff20_1008,
            spec::draw_op::RECT,
            xy_word(2, 2),
            wh_word(4, 3),
            0xff00_00ff,
        ];
        let mut output = vec![0u16; 16 * 8];
        let mut state = RenderTargetState::new();
        let mut renderer = renderer();
        let first = renderer
            .render_incremental(
                &mut state,
                &ui,
                &words,
                &mut output,
                16,
                8,
                &mut MockPpa::default(),
            )
            .unwrap();
        assert!(first.full_redraw);
        assert_eq!(first.damage_regions, 1);
        assert_eq!(first.damage_pixels, 16 * 8);

        let before = output.clone();
        let mut ppa = MockPpa::default();
        let second = renderer
            .render_incremental(&mut state, &ui, &words, &mut output, 16, 8, &mut ppa)
            .unwrap();
        assert!(!second.full_redraw);
        assert_eq!(second.damage_regions, 0);
        assert_eq!(second.damage_pixels, 0);
        assert_eq!(ppa.fills + ppa.blends + ppa.srm, 0);
        assert_eq!(output, before);
    }

    #[test]
    fn incremental_render_keeps_disjoint_damage_regions() {
        let mut ui = Ui::new();
        ui.set_viewport(32.0, 16.0);
        let frame = |left: u32, right: u32| {
            vec![
                spec::draw_op::RECT,
                xy_word(0, 0),
                wh_word(32, 16),
                0xff20_1008,
                spec::draw_op::RECT,
                xy_word(2, 4),
                wh_word(4, 4),
                left,
                spec::draw_op::RECT,
                xy_word(26, 4),
                wh_word(4, 4),
                right,
                spec::draw_op::GRAD_RECT,
                xy_word(13, 10),
                wh_word(6, 3),
                0xff00_0000,
                0xffff_ffff,
                spec::GradDir::ToRight as u32,
            ]
        };
        let previous = frame(0xff00_00ff, 0xff00_ff00);
        let current = frame(0xffff_0000, 0xffff_ffff);
        let mut output = vec![0u16; 32 * 16];
        let mut state = RenderTargetState::new();
        let mut renderer = renderer();
        renderer
            .render_incremental(
                &mut state,
                &ui,
                &previous,
                &mut output,
                32,
                16,
                &mut MockPpa::default(),
            )
            .unwrap();

        let stats = renderer
            .render_incremental(
                &mut state,
                &ui,
                &current,
                &mut output,
                32,
                16,
                &mut MockPpa::default(),
            )
            .unwrap();
        assert!(!stats.full_redraw);
        assert_eq!(stats.damage_regions, 2);
        assert_eq!(stats.damage_pixels, 32);
        assert_eq!(stats.software_ops, 0, "unchanged off-damage gradient");
        assert_eq!(output, full_reference(&ui, &current, 32, 16));
    }

    #[test]
    fn incremental_render_merges_a_ninth_region_at_default_capacity() {
        assert_eq!(MAX_DAMAGE_REGIONS, 8);
        let mut ui = Ui::new();
        ui.set_viewport(96.0, 8.0);
        let frame = |color: u32| {
            let mut words = vec![
                spec::draw_op::RECT,
                xy_word(0, 0),
                wh_word(96, 8),
                0xff10_0804,
            ];
            for index in 0..9 {
                words.extend_from_slice(&[
                    spec::draw_op::RECT,
                    xy_word((index * 10 + 1) as i16, 2),
                    wh_word(2, 2),
                    color,
                ]);
            }
            words
        };
        let previous = frame(0xff00_00ff);
        let current = frame(0xff00_ff00);
        let mut output = vec![0u16; 96 * 8];
        let mut state = RenderTargetState::new();
        let mut renderer = renderer();
        renderer
            .render_incremental(
                &mut state,
                &ui,
                &previous,
                &mut output,
                96,
                8,
                &mut MockPpa::default(),
            )
            .unwrap();

        let stats = renderer
            .render_incremental(
                &mut state,
                &ui,
                &current,
                &mut output,
                96,
                8,
                &mut MockPpa::default(),
            )
            .unwrap();
        assert!(!stats.full_redraw);
        assert_eq!(stats.damage_regions, MAX_DAMAGE_REGIONS as u32);
        assert_eq!(output, full_reference(&ui, &current, 96, 8));
    }

    #[test]
    fn incremental_render_replays_unchanged_overlays_in_painter_order() {
        let mut ui = Ui::new();
        ui.set_viewport(24.0, 12.0);
        let frame = |moving_x: i16, moving_color: u32| {
            vec![
                spec::draw_op::RECT,
                xy_word(0, 0),
                wh_word(24, 12),
                0xff20_1008,
                spec::draw_op::RECT,
                xy_word(moving_x, 2),
                wh_word(8, 8),
                moving_color,
                spec::draw_op::RECT,
                xy_word(8, 4),
                wh_word(8, 6),
                0x8000_ff00,
            ]
        };
        let previous = frame(2, 0x8000_00ff);
        let current = frame(6, 0x80ff_0000);
        let mut output = vec![0u16; 24 * 12];
        let mut state = RenderTargetState::new();
        let mut renderer = renderer();
        renderer
            .render_incremental(
                &mut state,
                &ui,
                &previous,
                &mut output,
                24,
                12,
                &mut MockPpa::default(),
            )
            .unwrap();

        let stats = renderer
            .render_incremental(
                &mut state,
                &ui,
                &current,
                &mut output,
                24,
                12,
                &mut MockPpa::default(),
            )
            .unwrap();
        assert!(!stats.full_redraw);
        assert_eq!(output, full_reference(&ui, &current, 24, 12));
    }

    #[test]
    fn incremental_render_tracks_each_double_buffer_independently() {
        let mut ui = Ui::new();
        ui.set_viewport(24.0, 8.0);
        let frame = |x: i16, color: u32| {
            vec![
                spec::draw_op::RECT,
                xy_word(0, 0),
                wh_word(24, 8),
                0xff10_0804,
                spec::draw_op::RECT,
                xy_word(x, 2),
                wh_word(3, 3),
                color,
            ]
        };
        let frames = [
            frame(1, 0xff00_00ff),
            frame(5, 0xff00_ff00),
            frame(9, 0xffff_0000),
            frame(13, 0xffff_ffff),
        ];
        let mut renderer = renderer();
        let mut states = [RenderTargetState::new(), RenderTargetState::new()];
        let mut outputs = [vec![0u16; 24 * 8], vec![0u16; 24 * 8]];

        for (index, words) in frames.iter().enumerate() {
            let target = index & 1;
            let stats = renderer
                .render_incremental(
                    &mut states[target],
                    &ui,
                    words,
                    &mut outputs[target],
                    24,
                    8,
                    &mut MockPpa::default(),
                )
                .unwrap();
            assert_eq!(stats.full_redraw, index < 2);
            assert_eq!(outputs[target], full_reference(&ui, words, 24, 8));
        }
    }

    #[test]
    fn incremental_render_falls_back_for_structural_changes_and_invalidation() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 8.0);
        let previous = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(16, 8),
            0xff10_0804,
            spec::draw_op::RECT,
            xy_word(2, 2),
            wh_word(3, 3),
            0xff00_00ff,
        ];
        let current = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(16, 8),
            0xff10_0804,
        ];
        let mut renderer = renderer();
        let mut state = RenderTargetState::new();
        let mut output = vec![0u16; 16 * 8];
        renderer
            .render_incremental(
                &mut state,
                &ui,
                &previous,
                &mut output,
                16,
                8,
                &mut MockPpa::default(),
            )
            .unwrap();

        let structural = renderer
            .render_incremental(
                &mut state,
                &ui,
                &current,
                &mut output,
                16,
                8,
                &mut MockPpa::default(),
            )
            .unwrap();
        assert!(structural.full_redraw);
        assert_eq!(output, full_reference(&ui, &current, 16, 8));

        state.invalidate();
        let invalidated = renderer
            .render_incremental(
                &mut state,
                &ui,
                &current,
                &mut output,
                16,
                8,
                &mut MockPpa::default(),
            )
            .unwrap();
        assert!(invalidated.full_redraw);
        assert_eq!(invalidated.damage_pixels, 16 * 8);
    }

    #[test]
    fn accelerates_fills_and_keeps_gradient_fallback_in_order() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let words = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(8, 8),
            0xff00_00ff,
            spec::draw_op::GRAD_RECT,
            xy_word(2, 2),
            wh_word(4, 4),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_fills, 2, "clear plus the red rectangle");
        assert_eq!(stats.software_ops, 1);
        assert_eq!(ppa.fills, 2);
        assert_eq!(output[0], pack_rgb565(255, 0, 0));
        assert_ne!(output[2 * 8 + 2], output[2 * 8 + 5]);
    }

    #[test]
    fn batches_white_alpha_quads_into_one_a8_blend() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let mut texture = vec![0u8; 4 * 4 * 4];
        for (i, pixel) in texture.chunks_exact_mut(4).enumerate() {
            pixel.copy_from_slice(&[255, 255, 255, (i * 17) as u8]);
        }
        let handle = ui.upload_texture(&texture, 4, 4, spec::psm::PSM_8888);
        let quad = |x: i16| {
            [
                spec::draw_op::TEX_QUAD,
                handle as u32,
                xy_word(x, 0),
                wh_word(4, 4),
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                1.0f32.to_bits(),
                0xff00_ffff,
            ]
        };
        let words = [quad(0), quad(4)].concat();
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(ppa.blends, 1);
    }

    #[test]
    fn linear_alpha_mask_matches_core_edge_sampling() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 1.0);
        let handle = ui.upload_texture_flags(
            &[
                255, 255, 255, 0, //
                255, 255, 255, 255,
            ],
            2,
            1,
            spec::psm::PSM_8888,
            spec::img::FLAG_LINEAR,
        );
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(4, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xff00_ffff,
        ];
        let mut expected = vec![0u16; 4];
        pocketjs_core::raster::render_scaled_rgb565(&ui, &words, &mut expected, 1);
        let mut output = vec![0u16; 4];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 4, 1, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(&ppa.last_mask[..4], &[191, 63, 191, 255]);
        assert_eq!(output, expected);
    }

    #[test]
    fn linear_transparent_color_uses_software_fallback() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 1.0);
        let handle = ui.upload_texture_flags(
            &[
                0, 0, 0, 0, //
                255, 255, 255, 255,
            ],
            2,
            1,
            spec::psm::PSM_8888,
            spec::img::FLAG_LINEAR,
        );
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(4, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut expected = vec![0u16; 4];
        pocketjs_core::raster::render_scaled_rgb565(&ui, &words, &mut expected, 1);
        let mut output = vec![0u16; 4];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 4, 1, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 0);
        assert_eq!(stats.software_ops, 1);
        assert_eq!(ppa.blends, 0);
        assert_eq!(output, expected);
    }

    #[test]
    fn nearest_transparent_color_remains_alpha_only() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 1.0);
        let handle = ui.upload_texture(
            &[
                0, 0, 0, 0, //
                255, 255, 255, 255,
            ],
            2,
            1,
            spec::psm::PSM_8888,
        );
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(2, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut expected = vec![0u16; 2];
        pocketjs_core::raster::render_scaled_rgb565(&ui, &words, &mut expected, 1);
        let mut output = vec![0u16; 2];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 2, 1, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(output, expected);
    }

    #[test]
    fn folds_global_alpha_into_a8_before_batching_overlaps() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 2.0);
        let handle = ui.upload_texture(&[255, 255, 255, 255], 1, 1, spec::psm::PSM_8888);
        let quad = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(2, 2),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0x80ff_ffff,
        ];
        let words = [quad, quad].concat();
        let mut output = vec![0u16; 4];
        let mut ppa = MockPpa::default();
        renderer()
            .render(&ui, &words, &mut output, 2, 2, &mut ppa)
            .unwrap();

        assert_eq!(ppa.blends, 1);
        assert_eq!(ppa.last_global_alpha, 255);
        assert_eq!(ppa.last_mask_max, 192);
    }

    #[test]
    fn routes_opaque_psm5650_texture_to_srm() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let pixels = vec![0x1f, 0x00].repeat(64);
        let handle = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_5650);
        assert!(handle >= 0);
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(8, 8),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_srm, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(ppa.srm, 1);
        assert!(output.iter().all(|&pixel| pixel == pack_rgb565(255, 0, 0)));
    }

    #[test]
    fn clips_psm5650_source_and_destination_without_rescaling() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let pixels = vec![0x1f, 0x00].repeat(64);
        let handle = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_5650);
        let words = [
            spec::draw_op::SCISSOR,
            xy_word(2, 1),
            wh_word(4, 6),
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(8, 8),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
            spec::draw_op::SCISSOR_POP,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(
            ppa.last_source_rect,
            Rect {
                x: 2,
                y: 1,
                w: 4,
                h: 6,
            }
        );
        assert_eq!(ppa.last_destination_rect, ppa.last_source_rect);
        assert_eq!(ppa.last_transform, SrmTransform::default());
    }

    #[test]
    fn fractional_psm5650_uv_edges_use_ordered_software_fallback() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let pixels = vec![0x1f, 0x00].repeat(64);
        let handle = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_5650);
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(8, 8),
            0.1f32.to_bits(),
            0.0f32.to_bits(),
            0.9f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_srm, 0);
        assert_eq!(stats.software_ops, 1);
    }

    #[test]
    fn empty_scissors_skip_software_fallbacks() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let words = [
            spec::draw_op::SCISSOR,
            xy_word(20, 20),
            wh_word(4, 4),
            spec::draw_op::GRAD_RECT,
            xy_word(0, 0),
            wh_word(8, 8),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            spec::draw_op::SCISSOR_POP,
        ];
        let mut output = vec![pack_rgb565(255, 0, 0); 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.software_ops, 0);
        assert!(output.iter().all(|&pixel| pixel == 0));
    }
}
