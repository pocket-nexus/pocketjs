//! Compatibility exports for rasterization and presentation entrypoints.

pub use pocket_raster::*;
pub use pocket_present::incremental::*;

#[cfg(test)]
use crate::{spec, Ui};
#[cfg(test)]
use crate::spec::draw_op;
#[cfg(test)]
use crate::damage::{DamageTracker, DamagePolicy};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::damage::DEFAULT_DAMAGE_REGIONS;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn framebuffer(scale: u32) -> Vec<u8> {
        vec![
            0;
            spec::SCREEN_W as usize * scale as usize * spec::SCREEN_H as usize * scale as usize * 4
        ]
    }

    fn rgba(fb: &[u8], scale: u32, x: usize, y: usize) -> [u8; 4] {
        let width = spec::SCREEN_W as usize * scale as usize;
        let offset = (y * width + x) * 4;
        fb[offset..offset + 4].try_into().unwrap()
    }

    #[test]
    fn render_scaled_over_composites_without_clearing() {
        // The OVER variant must leave untouched pixels exactly as supplied
        // (a transparent scratch stays transparent outside the ops — the
        // gpui tri-batch fallback's contract), while the clearing variant
        // paints the opaque-black background everywhere.
        let ui = Ui::new();
        let words = [
            spec::draw_op::RECT,
            xy_word(10, 10),
            wh_word(20, 20),
            0xff00_00ff, // opaque red (ABGR)
        ];
        let mut over = framebuffer(1);
        over.fill(7); // sentinel: pre-existing content
        render_scaled_over(&ui, &words, &mut over, 1);
        assert_eq!(rgba(&over, 1, 15, 15), [255, 0, 0, 255], "op painted");
        assert_eq!(
            rgba(&over, 1, 5, 5),
            [7, 7, 7, 7],
            "untouched pixel preserved"
        );

        let mut cleared = framebuffer(1);
        cleared.fill(7);
        render_scaled(&ui, &words, &mut cleared, 1);
        assert_eq!(
            rgba(&cleared, 1, 5, 5),
            [0, 0, 0, 255],
            "clearing variant blacks out"
        );
    }

    #[test]
    fn premultiplied_output_keeps_coverage_and_the_opaque_colour_bytes() {
        let ui = Ui::new();
        let words = [
            // an opaque red square
            draw_op::RECT,
            xy_word(10, 10),
            wh_word(20, 20),
            0xff00_00ff,
            // a white square at alpha 128, over part of it and over nothing
            draw_op::RECT,
            xy_word(20, 20),
            wh_word(20, 20),
            0x80ff_ffff,
            // a second layer of the same over a corner of the first
            draw_op::RECT,
            xy_word(30, 30),
            wh_word(20, 20),
            0x80ff_ffff,
            // a gradient from clear to opaque blue
            draw_op::GRAD_RECT,
            xy_word(60, 10),
            wh_word(64, 8),
            0x00ff_0000,
            0xffff_0000,
            spec::GradDir::ToRight as u32,
        ];
        for scale in [1, 2] {
            let mut over = framebuffer(scale);
            over.fill(7); // the clear is this target's own: no earlier content survives
            render_scaled_premultiplied(&ui, &words, &mut over, scale);
            let mut opaque = framebuffer(scale);
            render_scaled(&ui, &words, &mut opaque, scale);
            for (index, (a, b)) in over.chunks_exact(4).zip(opaque.chunks_exact(4)).enumerate() {
                assert_eq!(a[..3], b[..3], "colour bytes at pixel {index}, scale {scale}");
                assert_eq!(b[3], 255);
            }
            let at = |x: usize, y: usize| rgba(&over, scale, x * scale as usize, y * scale as usize);
            assert_eq!(at(5, 5), [0, 0, 0, 0], "nothing drawn: clear");
            assert_eq!(at(15, 15), [255, 0, 0, 255], "an opaque op: covered");
            assert_eq!(at(25, 25), [255, 128, 128, 255], "over an opaque pixel alpha stays 255");
            assert_eq!(at(35, 25), [128, 128, 128, 128], "one layer over nothing");
            // 128 + 128 x (1 - 128/255), rounded as the colour is
            assert_eq!(at(35, 35), [192, 192, 192, 192], "two layers accumulate");
            assert!(at(60, 12)[3] < 4, "a gradient's clear end");
            assert!(at(123, 12)[3] > 245, "and its opaque end");
        }
    }

    #[test]
    fn linear_sample_coordinates_pin_clamped_edge_semantics() {
        assert_eq!(
            linear_sample_coordinates(2, 1, 0.125, 0.5),
            Some(LinearSample {
                x0: 0,
                y0: 0,
                x1: 1,
                y1: 0,
                fx: 192,
                fy: 0,
            })
        );
        assert_eq!(linear_sample_coordinates(0, 1, 0.5, 0.5), None);
    }

    #[test]
    fn scale_one_wrapper_is_byte_exact() {
        let ui = Ui::new();
        let words = vec![
            draw_op::RECT,
            xy_word(3, 4),
            wh_word(7, 5),
            0xff33_2211,
            draw_op::GRAD_RECT,
            xy_word(12, 4),
            wh_word(8, 6),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(24, 4),
            xy_word(30, 10),
            xy_word(20, 10),
            0xff00_00ff,
            0xff00_ff00,
            0xffff_0000,
        ];
        let mut legacy = framebuffer(1);
        let mut scaled = framebuffer(1);
        render(&ui, &words, &mut legacy);
        render_scaled(&ui, &words, &mut scaled, 1);
        assert_eq!(legacy, scaled);
    }

    #[test]
    fn argb_output_uses_le_argb8888_memory_layout() {
        let ui = Ui::new();
        let words = vec![
            draw_op::RECT,
            xy_word(3, 4),
            wh_word(7, 5),
            0xff33_2211,
            // Semi-transparent rect exercises the dst-read blend path, which
            // must read B,G,R,A offsets in ARGB mode.
            draw_op::RECT,
            xy_word(4, 5),
            wh_word(5, 3),
            0x8033_2211,
            draw_op::GRAD_RECT,
            xy_word(12, 4),
            wh_word(8, 6),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(24, 4),
            xy_word(30, 10),
            xy_word(20, 10),
            0xff00_00ff,
            0xff00_ff00,
            0xffff_0000,
        ];
        let mut rgba_fb = framebuffer(1);
        let mut argb_fb = framebuffer(1);
        render_scaled(&ui, &words, &mut rgba_fb, 1);
        render_scaled_argb(&ui, &words, &mut argb_fb, 1);
        for px in 0..rgba_fb.len() / 4 {
            let o = px * 4;
            assert_eq!(argb_fb[o], rgba_fb[o + 2], "blue at pixel {px}");
            assert_eq!(argb_fb[o + 1], rgba_fb[o + 1], "green at pixel {px}");
            assert_eq!(argb_fb[o + 2], rgba_fb[o], "red at pixel {px}");
            assert_eq!(argb_fb[o + 3], rgba_fb[o + 3], "alpha at pixel {px}");
        }
    }

    #[test]
    fn rgb565_output_is_native_and_ordered_fallback_preserves_existing_pixels() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 2.0);
        let red = 0xff00_00ff;
        let green = 0xff00_ff00;
        let words = vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(4, 2),
            red,
            draw_op::RECT,
            xy_word(1, 0),
            wh_word(2, 2),
            green,
        ];
        let mut fb = vec![0u16; 8];
        render_scaled_rgb565(&ui, &words, &mut fb, 1);
        assert_eq!(
            fb,
            [
                pack_rgb565(255, 0, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(255, 0, 0),
                pack_rgb565(255, 0, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(0, 255, 0),
                pack_rgb565(255, 0, 0),
            ]
        );

        let blue = pack_rgb565(0, 0, 255);
        fb.fill(blue);
        let overlay = [draw_op::RECT, xy_word(1, 0), wh_word(2, 1), red];
        render_scaled_rgb565_over(&ui, &overlay, &mut fb, 1);
        assert_eq!(
            fb,
            [
                blue,
                pack_rgb565(255, 0, 0),
                pack_rgb565(255, 0, 0),
                blue,
                blue,
                blue,
                blue,
                blue,
            ]
        );
    }

    #[test]
    fn incremental_rgba_argb_and_rgb565_match_full_renders() {
        let mut ui = Ui::new();
        ui.set_viewport(24.0, 12.0);
        let frame = |moving_x: i16, moving_color: u32| {
            vec![
                draw_op::RECT,
                xy_word(0, 0),
                wh_word(24, 12),
                0xff20_1008,
                draw_op::RECT,
                xy_word(moving_x, 2),
                wh_word(8, 8),
                moving_color,
                // This unchanged translucent overlay intersects both the old
                // and new moving rectangle and must be replayed in order.
                draw_op::RECT,
                xy_word(8, 4),
                wh_word(8, 6),
                0x8000_ff00,
            ]
        };
        let previous = frame(2, 0x8000_00ff);
        let current = frame(6, 0x80ff_0000);
        let scale = 2;
        let pixels = 24 * scale as usize * 12 * scale as usize;

        let mut rgba = vec![0u8; pixels * 4];
        let mut rgba_state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        let first = render_scaled_incremental(
            &ui,
            &previous,
            &mut rgba,
            scale,
            &mut rgba_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(first.is_full_redraw());
        let changed = render_scaled_incremental(
            &ui,
            &current,
            &mut rgba,
            scale,
            &mut rgba_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(!changed.is_full_redraw());
        let mut rgba_full = vec![0u8; pixels * 4];
        render_scaled(&ui, &current, &mut rgba_full, scale);
        assert_eq!(rgba, rgba_full);
        let before = rgba.clone();
        let unchanged = render_scaled_incremental(
            &ui,
            &current,
            &mut rgba,
            scale,
            &mut rgba_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(unchanged.is_empty());
        assert_eq!(rgba, before);

        let mut argb = vec![0u8; pixels * 4];
        let mut argb_state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_argb_incremental(
            &ui,
            &previous,
            &mut argb,
            scale,
            &mut argb_state,
            DamagePolicy::default(),
        )
        .unwrap();
        render_scaled_argb_incremental(
            &ui,
            &current,
            &mut argb,
            scale,
            &mut argb_state,
            DamagePolicy::default(),
        )
        .unwrap();
        let mut argb_full = vec![0u8; pixels * 4];
        render_scaled_argb(&ui, &current, &mut argb_full, scale);
        assert_eq!(argb, argb_full);

        let mut rgb565 = vec![0u16; pixels];
        let mut rgb565_state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_rgb565_incremental(
            &ui,
            &previous,
            &mut rgb565,
            scale,
            &mut rgb565_state,
            DamagePolicy::default(),
        )
        .unwrap();
        render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut rgb565,
            scale,
            &mut rgb565_state,
            DamagePolicy::default(),
        )
        .unwrap();
        let mut rgb565_full = vec![0u16; pixels];
        render_scaled_rgb565(&ui, &current, &mut rgb565_full, scale);
        assert_eq!(rgb565, rgb565_full);

        rgb565_state.invalidate();
        let invalidated = render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut rgb565,
            scale,
            &mut rgb565_state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(invalidated.is_full_redraw());
        assert_eq!(rgb565, rgb565_full);
    }

    #[test]
    fn incremental_software_raster_tracks_double_buffers_independently() {
        let mut ui = Ui::new();
        ui.set_viewport(24.0, 8.0);
        let frame = |x: i16, color: u32| {
            vec![
                draw_op::RECT,
                xy_word(0, 0),
                wh_word(24, 8),
                0xff10_0804,
                draw_op::RECT,
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
        let mut states = [
            DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new(),
            DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new(),
        ];
        let mut outputs = [vec![0u16; 24 * 8], vec![0u16; 24 * 8]];

        for (index, words) in frames.iter().enumerate() {
            let target = index & 1;
            let plan = render_scaled_rgb565_incremental(
                &ui,
                words,
                &mut outputs[target],
                1,
                &mut states[target],
                DamagePolicy::default(),
            )
            .unwrap();
            assert_eq!(plan.is_full_redraw(), index < 2);

            let mut expected = vec![0u16; 24 * 8];
            render_scaled_rgb565(&ui, words, &mut expected, 1);
            assert_eq!(outputs[target], expected);
        }
    }

    #[test]
    fn incremental_default_capacity_merges_nine_regions_without_pixel_regression() {
        assert_eq!(DEFAULT_DAMAGE_REGIONS, 8);
        let mut ui = Ui::new();
        ui.set_viewport(96.0, 8.0);
        let frame = |color: u32| {
            let mut words = vec![draw_op::RECT, xy_word(0, 0), wh_word(96, 8), 0xff10_0804];
            for index in 0..9 {
                words.extend_from_slice(&[
                    draw_op::RECT,
                    xy_word((index * 10 + 1) as i16, 2),
                    wh_word(2, 2),
                    color,
                ]);
            }
            words
        };
        let previous = frame(0xff00_00ff);
        let current = frame(0xff00_ff00);
        let mut incremental = vec![0u16; 96 * 8];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_rgb565_incremental(
            &ui,
            &previous,
            &mut incremental,
            1,
            &mut tracker,
            DamagePolicy::default(),
        )
        .unwrap();
        let plan = render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut incremental,
            1,
            &mut tracker,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(!plan.is_full_redraw());
        assert_eq!(plan.region_count(), DEFAULT_DAMAGE_REGIONS);

        let mut full = vec![0u16; incremental.len()];
        render_scaled_rgb565(&ui, &current, &mut full, 1);
        assert_eq!(incremental, full);
    }

    #[test]
    fn incremental_target_signature_prevents_cross_format_reuse() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 2.0);
        let words = [draw_op::RECT, xy_word(0, 0), wh_word(4, 2), 0xff33_2211];
        let mut bytes = vec![0u8; 4 * 2 * 4];
        let mut state = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_incremental(
            &ui,
            &words,
            &mut bytes,
            1,
            &mut state,
            DamagePolicy::default(),
        )
        .unwrap();

        let argb = render_scaled_argb_incremental(
            &ui,
            &words,
            &mut bytes,
            1,
            &mut state,
            DamagePolicy::default(),
        )
        .unwrap();
        assert!(argb.is_full_redraw());
        assert!(bytes
            .chunks_exact(4)
            .all(|pixel| pixel == [0x33, 0x22, 0x11, 0xff]));
    }

    #[test]
    fn incremental_complex_ops_match_a_full_render() {
        let mut ui = Ui::new_with_raster_density(2);
        ui.set_viewport(40.0, 24.0);
        let texture_pixels = (0..16)
            .flat_map(|value| [(value * 16) as u8, 32, 192, 255])
            .collect::<Vec<_>>();
        let texture = ui.upload_texture(&texture_pixels, 4, 4, spec::psm::PSM_8888);
        assert!(texture >= 0);
        assert!(ui.load_font_atlas(&density_two_font()));

        let frame = |offset: i16, tint: u32| {
            vec![
                draw_op::RECT,
                xy_word(0, 0),
                wh_word(40, 24),
                0xff18_1008,
                draw_op::SCISSOR,
                xy_word(1, 1),
                wh_word(12, 9),
                draw_op::GRAD_RECT,
                xy_word(2 + offset, 2),
                wh_word(7, 5),
                tint,
                0xffff_ffff,
                spec::GradDir::ToRight as u32,
                draw_op::SCISSOR_POP,
                draw_op::TEX_QUAD,
                texture as u32,
                xy_word(15 + offset, 2),
                wh_word(5, 5),
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                1.0f32.to_bits(),
                tint,
                draw_op::TRI,
                xy_word(23 + offset, 2),
                xy_word(29 + offset, 8),
                xy_word(22 + offset, 8),
                tint,
                0xff00_ff00,
                0xffff_0000,
                draw_op::TEX_TRI,
                texture as u32,
                xy_word(3 + offset, 13),
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                xy_word(9 + offset, 19),
                1.0f32.to_bits(),
                1.0f32.to_bits(),
                xy_word(2 + offset, 19),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                tint,
                draw_op::GLYPH_RUN,
                1 << 16,
                tint,
                xy_word(15 + offset, 13),
                0,
            ]
        };
        let previous = frame(0, 0xff00_00ff);
        let current = frame(2, 0xc0ff_8000);
        let scale = 2;
        let mut incremental = vec![0u16; 40 * scale as usize * 24 * scale as usize];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        render_scaled_rgb565_incremental(
            &ui,
            &previous,
            &mut incremental,
            scale,
            &mut tracker,
            DamagePolicy::new(100),
        )
        .unwrap();
        let plan = render_scaled_rgb565_incremental(
            &ui,
            &current,
            &mut incremental,
            scale,
            &mut tracker,
            DamagePolicy::new(100),
        )
        .unwrap();
        assert!(!plan.is_full_redraw());
        assert!(!plan.is_empty());

        let mut full = vec![0u16; incremental.len()];
        render_scaled_rgb565(&ui, &current, &mut full, scale);
        assert_eq!(incremental, full);
    }

    #[test]
    fn psm5650_textures_decode_into_native_rgb565() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 1.0);
        // PSP PSM 5650 is B5:G6:R5: 0x001f is red and 0xf800 is blue.
        let handle = ui.upload_texture(&[0x1f, 0x00, 0x00, 0xf8], 2, 1, spec::psm::PSM_5650);
        assert!(handle >= 0);
        let words = [
            draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(2, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut fb = vec![0u16; 2];
        render_scaled_rgb565(&ui, &words, &mut fb, 1);
        assert_eq!(fb, [pack_rgb565(255, 0, 0), pack_rgb565(0, 0, 255)]);
    }

    #[test]
    fn custom_viewport_controls_framebuffer_dimensions() {
        let mut ui = Ui::new();
        ui.set_viewport(7.0, 5.0);
        let mut fb = vec![0; 7 * 2 * 5 * 2 * 4];
        render_scaled(&ui, &[], &mut fb, 2);
        assert!(fb.chunks_exact(4).all(|pixel| pixel == [0, 0, 0, 255]));
    }

    #[test]
    fn geometry_gradients_triangles_and_scissors_use_physical_samples() {
        let ui = Ui::new();
        let words = vec![
            draw_op::SCISSOR,
            xy_word(1, 1),
            wh_word(2, 2),
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(4, 4),
            0xff00_00ff,
            draw_op::SCISSOR_POP,
            draw_op::GRAD_RECT,
            xy_word(4, 0),
            wh_word(2, 2),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(8, 0),
            xy_word(10, 2),
            xy_word(8, 2),
            0xff00_ff00,
            0xff00_ff00,
            0xff00_ff00,
        ];
        let mut fb = framebuffer(2);
        render_scaled(&ui, &words, &mut fb, 2);

        assert_eq!(rgba(&fb, 2, 1, 1), [0, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 2, 2), [255, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 5, 5), [255, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 6, 6), [0, 0, 0, 255]);

        let gradient = (8..12).map(|x| rgba(&fb, 2, x, 0)[0]).collect::<Vec<_>>();
        assert_eq!(gradient.len(), 4);
        assert!(gradient.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(rgba(&fb, 2, 17, 2), [0, 255, 0, 255]);
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

    #[test]
    fn textures_and_font_coverage_are_sampled_at_physical_resolution() {
        let mut ui = Ui::new_with_raster_density(2);
        let pixels = (0..16)
            .flat_map(|value| [(value * 16) as u8, 0, 0, 255])
            .collect::<Vec<_>>();
        let texture = ui.upload_texture(&pixels, 4, 4, spec::psm::PSM_8888);
        assert!(texture >= 0);
        assert!(ui.load_font_atlas(&density_two_font()));

        let words = vec![
            draw_op::TEX_QUAD,
            texture as u32,
            xy_word(0, 0),
            wh_word(2, 2),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
            draw_op::GLYPH_RUN,
            1 << 16,
            0xffff_ffff,
            xy_word(3, 0),
            0,
        ];
        let mut fb = framebuffer(2);
        render_scaled(&ui, &words, &mut fb, 2);

        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(rgba(&fb, 2, x, y)[0], ((y * 4 + x) * 16) as u8);
            }
        }
        let expected = density_two_font();
        let coverage = &expected[24..];
        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(rgba(&fb, 2, 6 + x, y)[0], coverage[y * 4 + x]);
            }
        }
    }
}
