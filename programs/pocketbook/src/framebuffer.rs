//! Retained RGBA8 storage and pixel damage refinement for the e-ink display.
//!
//! Runtime's presentation coordinator computes DrawList damage and its raster
//! renderer writes acquired Surface regions. This module compares 16×16 tiles
//! inside those regions with the last blitted pixels. Inkview copies RGB24
//! into its screen storage; grayscale panels convert to luminance there.
//!
//! `rgba` retains the complete frame. `prev` advances after the changed tiles
//! are copied to Inkview. Idle frames skip rasterization and pixel scans.

use inkview::screen::{Screen, RGB24};
use pocket_drivers::{DisplayError, PixelFormat, Rect as PhysicalRect, Surface};
#[cfg(test)]
use pocketjs_core::damage::DamagePlan;
#[cfg(test)]
use pocketjs_core::damage::{DamagePolicy, DamageRect, DamageTracker};
#[cfg(test)]
use pocketjs_core::{raster, Ui};

use crate::Geometry;

/// One changed tile, in render-buffer pixel coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirtyRect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// Dirty-tile granularity. 16×16 matches the slint backend's damage grain and
/// keeps partial-update rects small without an excessive rect count.
const TILE: usize = 16;

pub struct FramebufferPipeline {
    /// Persistent render target, RGBA8 — always the complete current frame.
    rgba: Vec<u8>,
    /// What the last diff ran against; advanced only inside dirty tiles.
    prev: Vec<u8>,
    w: usize,
    h: usize,
    #[cfg(test)]
    density: u32,
    /// DrawList snapshot for the pixels retained in `rgba`.
    #[cfg(test)]
    tracker: DamageTracker,
}

impl FramebufferPipeline {
    /// `w`/`h` are the RENDER-buffer dimensions (logical × density).
    pub fn new(w: usize, h: usize, _density: u32) -> Self {
        let n = w * h * 4;
        Self {
            rgba: vec![0u8; n],
            prev: vec![0u8; n],
            w,
            h,
            #[cfg(test)]
            density: _density,
            #[cfg(test)]
            tracker: DamageTracker::new(),
        }
    }

    /// Rasterize the DrawList into the retained RGBA8 buffer, repainting only
    /// DrawList damage. Returns the logical damage plan; malformed DrawLists
    /// conservatively fall back to a full render.
    #[cfg(test)]
    pub fn rasterize(&mut self, ui: &Ui, words: &[u32]) -> DamagePlan {
        match raster::render_scaled_incremental(
            ui,
            words,
            &mut self.rgba,
            self.density,
            &mut self.tracker,
            DamagePolicy::default(),
        ) {
            Ok(plan) => plan,
            Err(_) => {
                raster::render_scaled(ui, words, &mut self.rgba, self.density);
                self.tracker.invalidate();
                let logical = DamageRect::new(
                    0,
                    0,
                    (self.w / self.density as usize) as i32,
                    (self.h / self.density as usize) as i32,
                );
                DamagePlan::full(logical)
            }
        }
    }

    /// Acquire a bounded view into the retained RGBA buffer. Runtime owns
    /// DrawList damage planning; the panel driver only refines changed pixels.
    pub fn surface(&mut self, region: PhysicalRect) -> Result<Surface<'_>, DisplayError> {
        if region.width == 0
            || region.height == 0
            || region
                .x
                .checked_add(region.width)
                .is_none_or(|x| x as usize > self.w)
            || region
                .y
                .checked_add(region.height)
                .is_none_or(|y| y as usize > self.h)
        {
            return Err(DisplayError::InvalidTarget);
        }
        let offset = (region.y as usize * self.w + region.x as usize) * 4;
        Surface::new(
            &mut self.rgba[offset..],
            region,
            self.w * 4,
            PixelFormat::Rgba8888,
        )
    }
    pub fn physical_diff(&self, regions: &[PhysicalRect]) -> Vec<DirtyRect> {
        let regions = regions
            .iter()
            .map(|r| DirtyRect {
                x: r.x as usize,
                y: r.y as usize,
                w: r.width as usize,
                h: r.height as usize,
            })
            .collect::<Vec<_>>();
        self.diff_regions(&regions)
    }

    /// Diff the current frame against `prev` inside the plan's regions and
    /// return the changed tiles (buffer coordinates). Pixels outside the plan
    /// are untouched by construction, so they are never scanned. Does NOT
    /// advance `prev`; call [`Self::advance`] after blitting.
    #[cfg(test)]
    pub fn diff(&self, plan: &DamagePlan) -> Vec<DirtyRect> {
        let scale = self.density as usize;
        let regions = plan
            .regions()
            .iter()
            .map(|r| DirtyRect {
                x: r.x0.max(0) as usize * scale,
                y: r.y0.max(0) as usize * scale,
                w: (r.x1 - r.x0).max(0) as usize * scale,
                h: (r.y1 - r.y0).max(0) as usize * scale,
            })
            .collect::<Vec<_>>();
        self.diff_regions(&regions)
    }
    fn diff_regions(&self, regions: &[DirtyRect]) -> Vec<DirtyRect> {
        if regions.is_empty() {
            return Vec::new();
        }
        let (w, h) = (self.w, self.h);
        let tx = w.div_ceil(TILE);
        let ty = h.div_ceil(TILE);
        let mut flags = vec![false; tx * ty];
        for region in regions {
            for y in region.y.min(h)..region.y.saturating_add(region.h).min(h) {
                for x in region.x.min(w)..region.x.saturating_add(region.w).min(w) {
                    let i = (y * w + x) * 4;
                    if self.rgba[i..i + 3] != self.prev[i..i + 3] {
                        flags[(y / TILE) * tx + x / TILE] = true;
                    }
                }
            }
        }
        flags
            .iter()
            .enumerate()
            .filter(|(_, d)| **d)
            .map(|(i, _)| {
                let px = (i % tx) * TILE;
                let py = (i / tx) * TILE;
                DirtyRect {
                    x: px,
                    y: py,
                    w: TILE.min(w - px),
                    h: TILE.min(h - py),
                }
            })
            .collect()
    }

    /// Latch the blitted tiles into `prev`. Pixels outside `dirty` are equal
    /// in both buffers already (unchanged, or repainted byte-identically).
    pub fn advance(&mut self, dirty: &[DirtyRect]) {
        for r in dirty {
            for dy in 0..r.h {
                let start = ((r.y + dy) * self.w + r.x) * 4;
                let end = start + r.w * 4;
                let (rgba, prev) = (&self.rgba[start..end], &mut self.prev[start..end]);
                prev.copy_from_slice(rgba);
            }
        }
    }

    /// Latch the complete frame (after a `blit_all` full presentation).
    pub fn advance_full(&mut self) {
        self.prev.copy_from_slice(&self.rgba);
    }

    /// Blit changed tiles to the inkview framebuffer, scaling through `geo`.
    /// Issues no panel update — the caller drives that through `refresh`.
    pub fn blit_dirty(&self, screen: &mut Screen, dirty: &[DirtyRect], geo: &Geometry) {
        for r in dirty {
            let (sx_min, sy_min, sw, sh) = geo.render_rect_to_screen(r.x, r.y, r.w, r.h);
            for dy in 0..sh {
                let sy = sy_min + dy;
                let src_y = geo.screen_to_render_y(sy);
                for dx in 0..sw {
                    let sx = sx_min + dx;
                    let src_x = geo.screen_to_render_x(sx);
                    let i = (src_y * self.w + src_x) * 4;
                    screen.draw(
                        sx,
                        sy,
                        RGB24(self.rgba[i], self.rgba[i + 1], self.rgba[i + 2]),
                    );
                }
            }
        }
    }

    /// Full-buffer blit scaled through `geo` (used on Show / before a
    /// full_update). `rgba` is always the complete current frame, so a full
    /// panel redraw needs no re-rasterization.
    pub fn blit_all(&self, screen: &mut Screen, geo: &Geometry) {
        for sy in geo.oy..(geo.oy + geo.disp_h) {
            let src_y = geo.screen_to_render_y(sy);
            for sx in geo.ox..(geo.ox + geo.disp_w) {
                let src_x = geo.screen_to_render_x(sx);
                let i = (src_y * self.w + src_x) * 4;
                screen.draw(
                    sx,
                    sy,
                    RGB24(self.rgba[i], self.rgba[i + 1], self.rgba[i + 2]),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketjs_core::spec::draw_op;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn frame(x: i16, color: u32) -> Vec<u32> {
        vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(64, 32),
            0xff20_1008,
            draw_op::RECT,
            xy_word(x, 4),
            wh_word(6, 6),
            color,
        ]
    }

    fn reference(ui: &Ui, words: &[u32], w: usize, h: usize, density: u32) -> Vec<u8> {
        let mut full = vec![0u8; w * h * 4];
        raster::render_scaled(ui, words, &mut full, density);
        full
    }

    #[test]
    fn incremental_pipeline_matches_full_renders_across_frames() {
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let frames = [
            frame(2, 0xff00_00ff),
            frame(20, 0xff00_ff00),
            frame(40, 0xffff_0000),
        ];
        for words in &frames {
            let plan = fb.rasterize(&ui, words);
            let dirty = fb.diff(&plan);
            fb.advance(&dirty);
            assert_eq!(fb.rgba, reference(&ui, words, 64, 32, 1));
            assert_eq!(fb.prev, fb.rgba, "prev latches every changed pixel");
        }
    }

    #[test]
    fn unchanged_frames_produce_no_damage_and_no_dirty_tiles() {
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let words = frame(2, 0xff00_00ff);
        let plan = fb.rasterize(&ui, &words);
        assert!(plan.is_full_redraw(), "first frame repaints everything");
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        let plan = fb.rasterize(&ui, &words);
        assert!(plan.is_empty(), "unchanged DrawList → zero raster work");
        assert!(fb.diff(&plan).is_empty());
    }

    #[test]
    fn dirty_tiles_are_scoped_to_the_damage_regions() {
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let plan = fb.rasterize(&ui, &frame(2, 0xff00_00ff));
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        // Move the small rect: damage = old box ∪ new box, both in y 4..10.
        let plan = fb.rasterize(&ui, &frame(40, 0xff00_00ff));
        assert!(!plan.is_full_redraw());
        let dirty = fb.diff(&plan);
        assert!(!dirty.is_empty());
        for tile in &dirty {
            assert!(tile.y < 16, "dirty tiles stay in the damaged band");
        }
        fb.advance(&dirty);
        assert_eq!(fb.prev, fb.rgba);
    }

    #[test]
    fn equal_pixels_inside_damage_produce_no_panel_refresh() {
        // A DrawList change that renders identical pixels damages the region
        // but must not dirty any tile — the pixel diff is what protects the
        // e-ink panel from needless flashes.
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let base = vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(64, 32),
            0xff10_2030,
            draw_op::RECT,
            xy_word(4, 4),
            wh_word(8, 8),
            0xffff_ffff,
        ];
        // Same pixels: the white rect painted twice (opaque over itself).
        let repainted = vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(64, 32),
            0xff10_2030,
            draw_op::RECT,
            xy_word(4, 4),
            wh_word(8, 8),
            0xffff_ffff,
            draw_op::RECT,
            xy_word(4, 4),
            wh_word(8, 8),
            0xffff_ffff,
        ];
        let plan = fb.rasterize(&ui, &base);
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        // Structural change (op count differs) → conservative full replan,
        // but the pixels are identical → zero dirty tiles, zero e-ink work.
        let plan = fb.rasterize(&ui, &repainted);
        assert!(plan.is_full_redraw());
        assert!(fb.diff(&plan).is_empty());
    }

    #[test]
    fn density_two_scopes_damage_to_physical_pixels() {
        let mut ui = Ui::new_with_raster_density(2);
        ui.set_viewport(32.0, 16.0);
        let mut fb = FramebufferPipeline::new(64, 32, 2);
        let plan = fb.rasterize(&ui, &frame(1, 0xff00_00ff));
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        let words = frame(1, 0xff00_ff00);
        let plan = fb.rasterize(&ui, &words);
        assert!(!plan.is_full_redraw());
        let dirty = fb.diff(&plan);
        assert!(!dirty.is_empty());
        fb.advance(&dirty);
        assert_eq!(fb.rgba, reference(&ui, &words, 64, 32, 2));
        assert_eq!(fb.prev, fb.rgba);
    }
    #[test]
    fn runtime_surface_regions_refine_physical_damage_without_touching_other_pixels() {
        let mut ui = Ui::new_with_raster_density(2);
        ui.set_viewport(32., 16.);
        let mut fb = FramebufferPipeline::new(64, 32, 2);
        let full = PhysicalRect::new(0, 0, 64, 32);
        let words = frame(1, 0xff00_00ff);
        raster::render_surface(&ui, &words, &mut fb.surface(full).unwrap(), 2).unwrap();
        assert_eq!(fb.rgba, reference(&ui, &words, 64, 32, 2));
        let dirty = fb.physical_diff(&[full]);
        fb.advance(&dirty);
        assert!(fb.physical_diff(&[full]).is_empty());
        let before = fb.rgba.clone();
        let region = PhysicalRect::new(2, 8, 12, 12);
        let words = frame(1, 0xff00_ff00);
        raster::render_surface(&ui, &words, &mut fb.surface(region).unwrap(), 2).unwrap();
        let expected = reference(&ui, &words, 64, 32, 2);
        for y in 0..32 {
            for x in 0..64 {
                let at = (y * 64 + x) * 4;
                let wanted = if (2..14).contains(&x) && (8..20).contains(&y) {
                    &expected
                } else {
                    &before
                };
                assert_eq!(&fb.rgba[at..at + 4], &wanted[at..at + 4]);
            }
        }
        let dirty = fb.physical_diff(&[region]);
        assert!(!dirty.is_empty());
        fb.advance(&dirty);
        assert!(fb.physical_diff(&[full]).is_empty());
        assert!(fb.surface(PhysicalRect::new(64, 32, 0, 1)).is_err());
        assert!(fb.surface(PhysicalRect::new(u32::MAX, 0, 2, 1)).is_err());
    }
}
