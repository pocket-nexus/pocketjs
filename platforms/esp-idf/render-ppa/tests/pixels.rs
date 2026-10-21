#![allow(dead_code, clippy::too_many_arguments)]
//! Maintained pixel/strip fixtures from the pre-contract RGB565 entrypoint.
//! The facade below exists only to preserve those fixtures against Painter.
extern crate alloc;
use pocket_drivers::{PixelFormat, RenderResources, Surface};
use pocket_present::{
    damage::{DamagePlan, DamagePolicy, DamageRect as Clip, DamageTracker, DEFAULT_DAMAGE_REGIONS},
    DamageTransaction,
};
use pocket_render_esp_ppa::{Painter, PpaError};
use pocket_render_esp_ppa::{QuarterTurn, Rect, RenderStats, RendererConfig, SrmTransform};
const MAX_DAMAGE_REGIONS: usize = DEFAULT_DAMAGE_REGIONS;
const DAMAGE_TARGET_SIGNATURE: u64 = u32::from_be_bytes(*b"PPA5") as u64;
pub type RenderTargetState = DamageTracker<MAX_DAMAGE_REGIONS>;
pub type RenderDamagePlan = DamagePlan<MAX_DAMAGE_REGIONS>;
use alloc::vec::Vec;
use pocket_raster::pack_rgb565;
use pocket_spec as spec;
use pocketjs_core::Ui;
pub trait PpaOps {
    /// A callback which started device work must mark a terminal failure so
    /// the compatibility bridge does not redraw over partially written pixels.
    fn failed(&self) -> bool {
        false
    }

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

struct Adapter<'a, O>(&'a mut O);
impl<O: PpaOps> Adapter<'_, O> {
    fn result(&self, done: bool) -> Result<(), PpaError> {
        if done {
            Ok(())
        } else if self.0.failed() {
            Err(PpaError::Failed)
        } else {
            Err(PpaError::Unsupported)
        }
    }
}
impl<O: PpaOps> pocket_render_esp_ppa::PpaOps for Adapter<'_, O> {
    fn fill_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        h: u32,
        r: Rect,
        c: u16,
    ) -> Result<(), PpaError> {
        let ok = self.0.fill_rgb565(d, w, h, r, c);
        self.result(ok)
    }
    fn blend_a8_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        h: u32,
        m: &[u8],
        r: Rect,
        c: [u8; 3],
        a: u8,
    ) -> Result<(), PpaError> {
        let ok = self.0.blend_a8_rgb565(d, w, h, m, r, c, a);
        self.result(ok)
    }
    fn srm_psm5650_to_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        h: u32,
        s: &[u8],
        sw: u32,
        sh: u32,
        sr: Rect,
        dr: Rect,
        t: SrmTransform,
    ) -> Result<(), PpaError> {
        let ok = self.0.srm_psm5650_to_rgb565(d, w, h, s, sw, sh, sr, dr, t);
        self.result(ok)
    }
}
pub struct Renderer {
    painter: Painter,
}
impl Renderer {
    pub fn new(config: RendererConfig) -> Option<Self> {
        Some(Self {
            painter: Painter::new(config, usize::MAX).ok()?,
        })
    }
    pub fn config(&self) -> RendererConfig {
        self.painter.config()
    }
    pub fn invalidate_resources(&mut self) {
        self.painter.invalidate_resources();
    }
    fn transaction(&self) -> DamageTransaction {
        DamageTransaction::new(
            self.config().scale,
            DAMAGE_TARGET_SIGNATURE,
            DamagePolicy::new(75),
        )
    }
    pub fn prepare_damage(
        &mut self,
        t: &RenderTargetState,
        r: &impl RenderResources,
        w: &[u32],
    ) -> Option<RenderDamagePlan> {
        self.transaction().prepare(t, r, w).ok()
    }
    pub fn commit_damage(
        &self,
        t: &mut RenderTargetState,
        r: &impl RenderResources,
        w: &[u32],
    ) -> bool {
        self.transaction().commit(t, r, w)
    }
    pub fn abort_damage(&self, t: &mut RenderTargetState) {
        self.transaction().abort(t)
    }
    pub fn render<O: PpaOps>(
        &mut self,
        r: &impl RenderResources,
        w: &[u32],
        d: &mut [u16],
        width: u32,
        height: u32,
        o: &mut O,
    ) -> Option<RenderStats> {
        let scale = self.config().scale;
        let (vw, vh) = r.viewport();
        if (vw as u32).checked_mul(scale)? != width
            || (vh as u32).checked_mul(scale)? != height
            || d.len() != (width as usize).checked_mul(height as usize)?
        {
            return None;
        }
        let mut stats = self.render_strip(
            r,
            w,
            d,
            Rect {
                x: 0,
                y: 0,
                w: vw as u32,
                h: vh as u32,
            },
            o,
        )?;
        stats.full_redraw = true;
        Some(stats)
    }
    pub fn render_strip<O: PpaOps>(
        &mut self,
        r: &impl RenderResources,
        w: &[u32],
        d: &mut [u16],
        region: Rect,
        o: &mut O,
    ) -> Option<RenderStats> {
        let scale = self.config().scale;
        let (vw, vh) = r.viewport();
        let width = (vw as u32).checked_mul(scale)?;
        if region.is_empty()
            || region.x.checked_add(region.w)? > vw as u32
            || region.y.checked_add(region.h)? > vh as u32
        {
            return None;
        }
        let height = region.h.checked_mul(scale)?;
        if d.len() != (width as usize).checked_mul(height as usize)? {
            return None;
        }
        let len = d.len().checked_mul(2)?;
        let bytes = unsafe { core::slice::from_raw_parts_mut(d.as_mut_ptr().cast::<u8>(), len) };
        let mut surface = Surface::new(
            bytes,
            pocket_drivers::Rect::new(0, region.y.checked_mul(scale)?, width, height),
            (width as usize).checked_mul(2)?,
            PixelFormat::Rgb565,
        )
        .ok()?;
        self.painter
            .render_clipped(
                r,
                w,
                &mut surface,
                Some(Clip::new(
                    region.x as i32,
                    region.y as i32,
                    (region.x + region.w) as i32,
                    (region.y + region.h) as i32,
                )),
                &mut Adapter(o),
            )
            .ok()
    }
    pub fn render_incremental<O: PpaOps>(
        &mut self,
        t: &mut RenderTargetState,
        r: &impl RenderResources,
        w: &[u32],
        d: &mut [u16],
        width: u32,
        height: u32,
        o: &mut O,
    ) -> Option<RenderStats> {
        let scale = self.config().scale;
        let (vw, vh) = r.viewport();
        if (vw as u32).checked_mul(scale)? != width
            || (vh as u32).checked_mul(scale)? != height
            || d.len() != (width as usize).checked_mul(height as usize)?
        {
            return None;
        }
        self.transaction().run(t, r, w, |plan| {
            let mut stats = RenderStats {
                damage_regions: plan.region_count() as u32,
                damage_pixels: (plan.area() * scale as u64 * scale as u64).min(u32::MAX as u64)
                    as u32,
                full_redraw: plan.is_full_redraw(),
                ..RenderStats::default()
            };
            let b = plan.bounds();
            stats.damage_bounds = Rect {
                x: b.x0.max(0) as u32 * scale,
                y: b.y0.max(0) as u32 * scale,
                w: b.x1.saturating_sub(b.x0).max(0) as u32 * scale,
                h: b.y1.saturating_sub(b.y0).max(0) as u32 * scale,
            };
            let bytes = unsafe {
                core::slice::from_raw_parts_mut(
                    d.as_mut_ptr().cast::<u8>(),
                    d.len().checked_mul(2)?,
                )
            };
            let mut surface = Surface::new(
                bytes,
                pocket_drivers::Rect::new(0, 0, width, height),
                (width as usize).checked_mul(2)?,
                PixelFormat::Rgb565,
            )
            .ok()?;
            for &clip in plan.regions() {
                let part = self
                    .painter
                    .render_clipped(r, w, &mut surface, Some(clip), &mut Adapter(o))
                    .ok()?;
                stats.ppa_fills += part.ppa_fills;
                stats.ppa_blends += part.ppa_blends;
                stats.ppa_srm += part.ppa_srm;
                stats.software_ops += part.software_ops;
                stats.software_words += part.software_words;
            }
            Some(stats)
        })
    }
}
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
        for (i, pixel) in texture.as_chunks_mut::<4>().0.iter_mut().enumerate() {
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
        let pixels = [0x1f, 0x00].repeat(64);
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
        let pixels = [0x1f, 0x00].repeat(64);
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
        let pixels = [0x1f, 0x00].repeat(64);
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

mod strip_parity {
    //! Strip-vs-full parity: `render_strip` must produce, for any horizontal
    //! band, exactly the bytes a full render puts in that band — the invariant
    //! transactional display hosts rely on when they reassemble a frame from
    //! reusable strips.
    //!
    //! The matrix covers every DrawList op family (RECT, GRAD_RECT both axes,
    //! SCISSOR, TRI, TEX_QUAD 8888, TEX_TRI, GLYPH_RUN, SRM-eligible 5650
    //! TEX_QUAD), all-software fallback via a declining PPA, SRM-through-PPA
    //! strip locality and band splits, scale 2, per-row strips, offset windows,
    //! and repeat determinism across mask reallocation.

    use super::{PpaOps, Rect, Renderer, RendererConfig, SrmTransform};
    use pocketjs_core::raster::render_scaled_rgb565;
    use pocketjs_core::{spec, Ui};

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    /// Declines every op: forces the renderer through the software window
    /// fallback (`render_scaled_rgb565_window_over`) for every op family.
    struct NoPpa;

    impl PpaOps for NoPpa {
        fn fill_rgb565(&mut self, _: &mut [u16], _: u32, _: u32, _: Rect, _: u16) -> bool {
            false
        }
        fn blend_a8_rgb565(
            &mut self,
            _: &mut [u16],
            _: u32,
            _: u32,
            _: &[u8],
            _: Rect,
            _: [u8; 3],
            _: u8,
        ) -> bool {
            false
        }
        fn srm_psm5650_to_rgb565(
            &mut self,
            _: &mut [u16],
            _: u32,
            _: u32,
            _: &[u8],
            _: u32,
            _: u32,
            _: Rect,
            _: Rect,
            _: SrmTransform,
        ) -> bool {
            false
        }
    }

    /// Accepts only one-to-one SRM copies (software emulation, mirroring the
    /// crate's MockPpa), declines fills/blends — probes SRM strip locality.
    #[derive(Default)]
    struct SrmOnlyPpa {
        srm_calls: u32,
        last_destination_rect: Rect,
    }

    impl PpaOps for SrmOnlyPpa {
        fn fill_rgb565(&mut self, _: &mut [u16], _: u32, _: u32, _: Rect, _: u16) -> bool {
            false
        }
        fn blend_a8_rgb565(
            &mut self,
            _: &mut [u16],
            _: u32,
            _: u32,
            _: &[u8],
            _: Rect,
            _: [u8; 3],
            _: u8,
        ) -> bool {
            false
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
            if transform.mirror_x
                || transform.mirror_y
                || source_rect.w != destination_rect.w
                || source_rect.h != destination_rect.h
            {
                return false;
            }
            self.srm_calls += 1;
            self.last_destination_rect = destination_rect;
            for dy in 0..destination_rect.h {
                let sy = source_rect.y + dy;
                for dx in 0..destination_rect.w {
                    let sx = source_rect.x + dx;
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

    fn density_two_font() -> Vec<u8> {
        let coverage = [
            0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 255,
        ];
        let mut atlas = Vec::new();
        atlas.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
        atlas.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
        atlas.extend_from_slice(&1u16.to_le_bytes());
        atlas.extend_from_slice(&[2, 2, 2, 2, 0, 0, 2, 0]);
        atlas.extend_from_slice(&65u32.to_le_bytes());
        atlas.extend_from_slice(&0u16.to_le_bytes());
        atlas.extend_from_slice(&[2, 0]);
        atlas.extend_from_slice(&coverage);
        atlas
    }

    fn renderer(scale: u32) -> Renderer {
        Renderer::new(RendererConfig {
            scale,
            min_fill_pixels: 1,
            min_blend_pixels: 1,
            min_srm_pixels: 1,
        })
        .unwrap()
    }

    /// A 16x10 frame touching every op family, with ops deliberately crossing
    /// horizontal strip boundaries so sampling phase matters.
    fn full_matrix_scene() -> (Ui, Vec<u32>) {
        let mut ui = Ui::new_with_raster_density(2);
        ui.set_viewport(16.0, 10.0);
        assert!(ui.load_font_atlas(&density_two_font()));

        let rgba_pixels: Vec<u8> = (0..16u32)
            .flat_map(|value| {
                [
                    (value * 16) as u8,
                    255 - (value * 16) as u8,
                    (value * 7) as u8,
                    255,
                ]
            })
            .collect();
        let tex_rgba = ui.upload_texture(&rgba_pixels, 4, 4, spec::psm::PSM_8888);
        assert!(tex_rgba >= 0);

        let psm5650_pixels: Vec<u8> = (0..16u32)
            .flat_map(|value| ((value * 4093) as u16).to_le_bytes())
            .collect();
        let tex_5650 = ui.upload_texture(&psm5650_pixels, 4, 4, spec::psm::PSM_5650);
        assert!(tex_5650 >= 0);

        let words = vec![
            // opaque background rect
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(16, 10),
            0xff20_1008,
            // translucent horizontal gradient over everything
            spec::draw_op::GRAD_RECT,
            xy_word(0, 0),
            wh_word(16, 10),
            0x8000_0040,
            0x80c0_8000,
            spec::GradDir::ToRight as u32,
            // opaque vertical gradient column (fill_opaque rows in the window target)
            spec::draw_op::GRAD_RECT,
            xy_word(12, 0),
            wh_word(4, 10),
            0xff00_2010,
            0xffff_f0c0,
            spec::GradDir::ToBottom as u32,
            // scissored translucent gouraud triangle crossing all strip bands
            spec::draw_op::SCISSOR,
            xy_word(1, 1),
            wh_word(14, 8),
            spec::draw_op::TRI,
            xy_word(2, 1),
            xy_word(14, 9),
            xy_word(2, 9),
            0x80ff_0000,
            0x8000_ff00,
            0x8000_00ff,
            spec::draw_op::SCISSOR_POP,
            // RGBA texture quad straddling band 0/1
            spec::draw_op::TEX_QUAD,
            tex_rgba as u32,
            xy_word(4, 2),
            wh_word(4, 4),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
            // modulated translucent textured triangle straddling band 1/2
            spec::draw_op::TEX_TRI,
            tex_rgba as u32,
            xy_word(8, 3),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            xy_word(15, 3),
            1.0f32.to_bits(),
            0.0f32.to_bits(),
            xy_word(8, 9),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            0x80ff_ffff,
            // glyphs in band 0 and band 2
            spec::draw_op::GLYPH_RUN,
            1 << 16,
            0xff00_ffcc,
            xy_word(3, 0),
            0,
            spec::draw_op::GLYPH_RUN,
            1 << 16,
            0xffff_4080,
            xy_word(9, 7),
            0,
            // SRM-eligible opaque one-to-one 5650 quad straddling band 1/2
            spec::draw_op::TEX_QUAD,
            tex_5650 as u32,
            xy_word(0, 6),
            wh_word(4, 4),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        (ui, words)
    }

    fn full_reference(ui: &Ui, words: &[u32], width: usize, height: usize, scale: u32) -> Vec<u16> {
        let mut output = vec![0u16; width * height * (scale * scale) as usize];
        render_scaled_rgb565(ui, words, &mut output, scale);
        output
    }

    fn assemble_strips<O: PpaOps>(
        renderer: &mut Renderer,
        ui: &Ui,
        words: &[u32],
        width: usize,
        bands: &[(u32, u32)],
        scale: u32,
        ppa: &mut O,
    ) -> Vec<u16> {
        let physical_width = width * scale as usize;
        let total_rows: u32 = bands.iter().map(|&(_, h)| h).sum();
        let base_row = bands.iter().map(|&(y, _)| y).min().unwrap_or(0);
        let mut output = vec![0u16; physical_width * (total_rows * scale) as usize];
        for &(y, h) in bands {
            let mut strip = vec![0u16; physical_width * (h * scale) as usize];
            let region = Rect {
                x: 0,
                y,
                w: width as u32,
                h,
            };
            renderer
                .render_strip(ui, words, &mut strip, region, ppa)
                .unwrap_or_else(|| panic!("strip y={y} h={h} failed"));
            let dst = ((y - base_row) * scale) as usize * physical_width;
            output[dst..dst + strip.len()].copy_from_slice(&strip);
        }
        output
    }

    #[test]
    fn uneven_strip_tiling_reassembles_the_full_frame_for_every_op_family() {
        let (ui, words) = full_matrix_scene();
        let full = full_reference(&ui, &words, 16, 10, 1);
        let mut renderer = renderer(1);
        let tiled = assemble_strips(
            &mut renderer,
            &ui,
            &words,
            16,
            &[(0, 3), (3, 4), (7, 3)],
            1,
            &mut NoPpa,
        );
        assert_eq!(
            tiled, full,
            "3-band tiling must be byte-identical to a full render"
        );
    }

    #[test]
    fn one_pixel_row_strips_reassemble_the_full_frame() {
        let (ui, words) = full_matrix_scene();
        let full = full_reference(&ui, &words, 16, 10, 1);
        let mut renderer = renderer(1);
        let bands: Vec<(u32, u32)> = (0..10).map(|y| (y, 1)).collect();
        let tiled = assemble_strips(&mut renderer, &ui, &words, 16, &bands, 1, &mut NoPpa);
        assert_eq!(
            tiled, full,
            "1px strips must be byte-identical to a full render"
        );
    }

    #[test]
    fn scale_two_strip_tiling_reassembles_the_full_frame() {
        let (ui, words) = full_matrix_scene();
        let full = full_reference(&ui, &words, 16, 10, 2);
        let mut renderer = renderer(2);
        let tiled = assemble_strips(
            &mut renderer,
            &ui,
            &words,
            16,
            &[(0, 4), (4, 3), (7, 3)],
            2,
            &mut NoPpa,
        );
        assert_eq!(
            tiled, full,
            "scale-2 tiling must be byte-identical to a full render"
        );
    }

    #[test]
    fn offset_window_matches_full_interior_and_leaves_exterior_untouched() {
        let (ui, words) = full_matrix_scene();
        let full = full_reference(&ui, &words, 16, 10, 1);
        let mut renderer = renderer(1);
        let region = Rect {
            x: 2,
            y: 1,
            w: 11,
            h: 5,
        };
        let untouched = 0x5aa5u16;
        let mut strip = vec![untouched; 16 * region.h as usize];
        renderer
            .render_strip(&ui, &words, &mut strip, region, &mut NoPpa)
            .unwrap();
        for local_y in 0..region.h as usize {
            let global_y = region.y as usize + local_y;
            for x in 0..16usize {
                let actual = strip[local_y * 16 + x];
                if x >= region.x as usize && x < (region.x + region.w) as usize {
                    assert_eq!(actual, full[global_y * 16 + x], "pixel ({x},{global_y})");
                } else {
                    assert_eq!(
                        actual, untouched,
                        "write escaped dirty x at ({x},{global_y})"
                    );
                }
            }
        }
    }

    #[test]
    fn rendering_the_same_strip_twice_is_byte_identical_despite_mask_churn() {
        let (ui, words) = full_matrix_scene();
        let mut renderer = renderer(1);
        let region = Rect {
            x: 0,
            y: 3,
            w: 16,
            h: 4,
        };
        let render_once = |renderer: &mut Renderer| {
            let mut strip = vec![0u16; 16 * 4];
            renderer
                .render_strip(&ui, &words, &mut strip, region, &mut NoPpa)
                .unwrap();
            strip
        };
        let first = render_once(&mut renderer);
        // churn the mask allocation with a taller and a 1px strip in between
        let mut tall = vec![0u16; 16 * 9];
        renderer
            .render_strip(
                &ui,
                &words,
                &mut tall,
                Rect {
                    x: 0,
                    y: 0,
                    w: 16,
                    h: 9,
                },
                &mut NoPpa,
            )
            .unwrap();
        let mut thin = vec![0u16; 16];
        renderer
            .render_strip(
                &ui,
                &words,
                &mut thin,
                Rect {
                    x: 0,
                    y: 9,
                    w: 16,
                    h: 1,
                },
                &mut NoPpa,
            )
            .unwrap();
        let second = render_once(&mut renderer);
        assert_eq!(
            first, second,
            "strip renders must be reproducible across mask churn"
        );
    }

    #[test]
    fn srm_through_ppa_lands_in_strip_local_coordinates_and_matches_software() {
        let (ui, words) = full_matrix_scene();
        let full = full_reference(&ui, &words, 16, 10, 1);
        let mut renderer = renderer(1);
        let mut ppa = SrmOnlyPpa::default();
        // band y=6..10 contains the whole one-to-one 5650 quad (0,6)-(4,10)
        let region = Rect {
            x: 0,
            y: 6,
            w: 16,
            h: 4,
        };
        let mut strip = vec![0u16; 16 * 4];
        renderer
            .render_strip(&ui, &words, &mut strip, region, &mut ppa)
            .unwrap();
        assert!(ppa.srm_calls >= 1, "SRM path must engage for the 5650 quad");
        assert_eq!(
            ppa.last_destination_rect,
            Rect {
                x: 0,
                y: 0,
                w: 4,
                h: 4
            },
            "SRM destination must be strip-local"
        );
        for local_y in 0..4usize {
            let global_y = 6 + local_y;
            for x in 0..16usize {
                assert_eq!(
                    strip[local_y * 16 + x],
                    full[global_y * 16 + x],
                    "pixel ({x},{global_y})"
                );
            }
        }
    }

    #[test]
    fn split_srm_band_boundary_matches_software() {
        // Split the 5650 quad across two strips (y=6..8 and y=8..10): the SRM
        // source rect must advance with the band, not restart at the texture top.
        let (ui, words) = full_matrix_scene();
        let full = full_reference(&ui, &words, 16, 10, 1);
        let mut renderer = renderer(1);
        let mut ppa = SrmOnlyPpa::default();
        let tiled = assemble_strips(
            &mut renderer,
            &ui,
            &words,
            16,
            &[(6, 2), (8, 2)],
            1,
            &mut ppa,
        );
        assert!(ppa.srm_calls >= 2, "both half-bands must engage SRM");
        for local_y in 0..4usize {
            let global_y = 6 + local_y;
            for x in 0..16usize {
                assert_eq!(
                    tiled[local_y * 16 + x],
                    full[global_y * 16 + x],
                    "pixel ({x},{global_y})"
                );
            }
        }
    }
}
