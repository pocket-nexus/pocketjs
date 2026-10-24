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

use pocket_drivers::{PixelFormat, Rect as Region, Surface};
use pocket_render_esp_ppa::{Painter, PpaError, PpaOps, Rect, RendererConfig, SrmTransform};
use pocketjs_core::raster::render_scaled_rgb565;
use pocketjs_core::{spec, Ui};

struct Renderer(Painter);
impl Renderer {
    fn render_strip<O: PpaOps>(
        &mut self,
        ui: &Ui,
        words: &[u32],
        pixels: &mut [u16],
        region: Rect,
        ppa: &mut O,
    ) -> Option<()> {
        let scale = self.0.config().scale;
        let stride = ui.viewport().0 as usize * scale as usize * 2;
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(pixels.as_mut_ptr().cast::<u8>(), pixels.len() * 2)
        };
        let origin = region.x as usize * scale as usize * 2;
        let physical = Region::new(
            region.x * scale,
            region.y * scale,
            region.w * scale,
            region.h * scale,
        );
        let mut surface =
            Surface::new(&mut bytes[origin..], physical, stride, PixelFormat::Rgb565).ok()?;
        self.0.render(ui, words, &mut surface, ppa).ok().map(|_| ())
    }
}

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
    fn fill_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: Rect,
        _: u16,
    ) -> Result<(), PpaError> {
        Err(PpaError::Unsupported)
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
    ) -> Result<(), PpaError> {
        Err(PpaError::Unsupported)
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
    ) -> Result<(), PpaError> {
        Err(PpaError::Unsupported)
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
    fn fill_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: Rect,
        _: u16,
    ) -> Result<(), PpaError> {
        Err(PpaError::Unsupported)
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
    ) -> Result<(), PpaError> {
        Err(PpaError::Unsupported)
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
    ) -> Result<(), PpaError> {
        if transform.mirror_x
            || transform.mirror_y
            || source_rect.w != destination_rect.w
            || source_rect.h != destination_rect.h
        {
            return Err(PpaError::Unsupported);
        }
        self.srm_calls += 1;
        self.last_destination_rect = destination_rect;
        for dy in 0..destination_rect.h {
            let sy = source_rect.y + dy;
            for dx in 0..destination_rect.w {
                let sx = source_rect.x + dx;
                let source_index = (sy * source_width + sx) as usize * 2;
                let psm5650 = u16::from_le_bytes([source[source_index], source[source_index + 1]]);
                let rgb565 =
                    ((psm5650 & 0x001f) << 11) | (psm5650 & 0x07e0) | ((psm5650 & 0xf800) >> 11);
                let destination_index = (destination_rect.y + dy) as usize * width as usize
                    + (destination_rect.x + dx) as usize;
                destination[destination_index] = rgb565;
            }
        }
        Ok(())
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
    Renderer(
        Painter::new(
            RendererConfig {
                scale,
                min_fill_pixels: 1,
                min_blend_pixels: 1,
                min_srm_pixels: 1,
                ..RendererConfig::default()
            },
            65536,
        )
        .unwrap(),
    )
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
        // opaque reversed vertical gradient crossing every band
        spec::draw_op::GRAD_RECT,
        xy_word(0, 1),
        wh_word(3, 9),
        0xff80_10f0,
        0xff10_8030,
        spec::GradDir::ToTop as u32,
        // translucent vertical gradient with varying alpha over mixed pixels
        spec::draw_op::GRAD_RECT,
        xy_word(2, 0),
        wh_word(9, 10),
        0x30ff_8000,
        0xc000_40ff,
        spec::GradDir::ToBottom as u32,
        // translucent rect small enough for the CPU blend
        spec::draw_op::RECT,
        xy_word(5, 3),
        wh_word(6, 5),
        0x6040_ff20,
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

#[test]
fn occluded_strips_resume_inside_the_scissor_stack() {
    let mut ui = Ui::new();
    ui.set_viewport(16.0, 10.0);
    let words = vec![
        // hidden by the scissored cover below inside rows 2..6
        spec::draw_op::RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0xff10_2030,
        spec::draw_op::SCISSOR,
        xy_word(0, 2),
        wh_word(16, 4),
        // covers rows 2..6 once the scissor clips it
        spec::draw_op::GRAD_RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0xff40_8020,
        0xff20_40c0,
        spec::GradDir::ToBottom as u32,
        spec::draw_op::RECT,
        xy_word(3, 0),
        wh_word(4, 10),
        0x80ff_ffff,
        spec::draw_op::SCISSOR_POP,
        // after the pop, this must reach every row again
        spec::draw_op::RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0x4000_ff00,
    ];
    let full = full_reference(&ui, &words, 16, 10, 1);
    let mut renderer = renderer(1);
    let mut tiled = vec![0u16; 16 * 10];
    for y in 0..10u32 {
        // Stale pixels expose a skipped clear that the cover does not hide.
        let mut strip = vec![0xa5a5u16; 16];
        let region = Rect {
            x: 0,
            y,
            w: 16,
            h: 1,
        };
        renderer
            .render_strip(&ui, &words, &mut strip, region, &mut NoPpa)
            .unwrap();
        tiled[y as usize * 16..(y as usize + 1) * 16].copy_from_slice(&strip);
    }
    assert_eq!(tiled, full);
}

#[test]
fn small_white_alpha_quads_blend_like_the_software_sampler() {
    let mut ui = Ui::new_with_raster_density(2);
    ui.set_viewport(16.0, 10.0);
    // A white texture whose alpha ramps, like a baked corner disc.
    let mut texels = Vec::new();
    for i in 0..64u32 {
        texels.extend_from_slice(&[255, 255, 255, (i * 4 + 3) as u8]);
    }
    let disc = ui.upload_texture(&texels, 8, 8, spec::psm::PSM_8888);
    assert!(disc >= 0);
    let mut words = vec![
        spec::draw_op::RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0xff30_2010,
    ];
    // One-row corner strips at both ends of a box, each tinted differently.
    for row in 0..6u16 {
        let v0 = row as f32 / 6.0;
        let v1 = (row + 1) as f32 / 6.0;
        for (x, u0, u1) in [(1i16, 0.0f32, 0.5f32), (12, 0.5, 1.0)] {
            words.extend_from_slice(&[
                spec::draw_op::TEX_QUAD,
                disc as u32,
                xy_word(x, 2 + row as i16),
                wh_word(3, 1),
                u0.to_bits(),
                v0.to_bits(),
                u1.to_bits(),
                v1.to_bits(),
                0xc000_0000 | (row as u32 * 0x0010_2030),
            ]);
        }
    }
    let full = full_reference(&ui, &words, 16, 10, 2);
    let mut renderer = renderer(2);
    let bands: Vec<(u32, u32)> = (0..10).map(|y| (y, 1)).collect();
    let tiled = assemble_strips(&mut renderer, &ui, &words, 16, &bands, 2, &mut NoPpa);
    assert_eq!(tiled, full);
}

fn assemble_indexed_strips(
    renderer: &mut Renderer,
    ui: &Ui,
    words: &[u32],
    width: usize,
    bands: &[(u32, u32)],
    scale: u32,
) -> Vec<u16> {
    let physical_width = width * scale as usize;
    let total_rows: u32 = bands.iter().map(|&(_, h)| h).sum();
    let mut output = vec![0u16; physical_width * (total_rows * scale) as usize];
    for &(y, h) in bands {
        // Stale pixels expose any op the index wrongly skips.
        let mut strip = vec![0xa5a5u16; physical_width * (h * scale) as usize];
        let region = Rect {
            x: 0,
            y,
            w: width as u32,
            h,
        };
        renderer
            .render_strip(ui, words, &mut strip, region, &mut NoPpa)
            .unwrap_or_else(|| panic!("indexed strip y={y} h={h} failed"));
        let dst = (y * scale) as usize * physical_width;
        output[dst..dst + strip.len()].copy_from_slice(&strip);
    }
    output
}

#[test]
fn indexed_strips_reassemble_the_full_frame_for_every_op_family() {
    let (ui, words) = full_matrix_scene();
    for scale in [1, 2] {
        let full = full_reference(&ui, &words, 16, 10, scale);
        let mut renderer = renderer(scale);
        let rows: Vec<(u32, u32)> = (0..10).map(|y| (y, 1)).collect();
        assert_eq!(
            assemble_indexed_strips(&mut renderer, &ui, &words, 16, &rows, scale),
            full
        );
        let bands = [(0, 3), (3, 4), (7, 3)];
        assert_eq!(
            assemble_indexed_strips(&mut renderer, &ui, &words, 16, &bands, scale),
            full
        );
    }
}

#[test]
fn changed_words_reindex_the_draw_list() {
    let (ui, words) = full_matrix_scene();
    let mut renderer = renderer(1);
    let rows: Vec<(u32, u32)> = (0..10).map(|y| (y, 1)).collect();
    // Index an empty list first; the matrix must rebuild the cached geometry.
    assemble_indexed_strips(&mut renderer, &ui, &[], 16, &rows, 1);
    let full = full_reference(&ui, &words, 16, 10, 1);
    assert_eq!(
        assemble_indexed_strips(&mut renderer, &ui, &words, 16, &rows, 1),
        full
    );
}

#[test]
fn scaled_alpha_textures_sample_like_the_software_sampler() {
    let mut ui = Ui::new_with_raster_density(2);
    ui.set_viewport(16.0, 10.0);
    // A glyph-page-like CLUT8 texture: white entries with ramped alpha and
    // empty runs, and a 4444 twin.
    let mut paletted = Vec::new();
    for entry in 0..256u32 {
        paletted.extend_from_slice(&[255, 255, 255, entry as u8]);
    }
    let indices: Vec<u8> = (0..64u32)
        .map(|i| if i % 5 == 0 { 0 } else { (i * 37 % 256) as u8 })
        .collect();
    paletted.extend_from_slice(&indices);
    let glyphs =
        ui.upload_texture_flags(&paletted, 8, 8, spec::psm::PSM_T8, spec::img::FLAG_LINEAR);
    let packed: Vec<u8> = (0..64u32)
        .flat_map(|i| (0x0fff_u16 | (((i * 7) % 16) as u16) << 12).to_le_bytes())
        .collect();
    let ramp = ui.upload_texture_flags(&packed, 8, 8, spec::psm::PSM_4444, spec::img::FLAG_LINEAR);
    assert!(glyphs >= 0 && ramp >= 0);
    let quad = |tex: i32, x: i16, y: i16, w: u16, h: u16, color: u32| {
        [
            spec::draw_op::TEX_QUAD,
            tex as u32,
            xy_word(x, y),
            wh_word(w, h),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            color,
        ]
    };
    let mut words = vec![
        spec::draw_op::RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0xff30_2010,
    ];
    // Magnified 21/16 like a lifted row, and minified.
    words.extend_from_slice(&quad(glyphs, 1, 1, 9, 7, 0xffff_ffff));
    words.extend_from_slice(&quad(ramp, 9, 2, 6, 5, 0xa040_80ff));
    words.extend_from_slice(&quad(glyphs, 11, 6, 3, 3, 0x80ff_ffff));
    let full = full_reference(&ui, &words, 16, 10, 2);
    let mut renderer = renderer(2);
    let bands: Vec<(u32, u32)> = (0..10).map(|y| (y, 1)).collect();
    let tiled = assemble_strips(&mut renderer, &ui, &words, 16, &bands, 2, &mut NoPpa);
    assert_eq!(tiled, full);
}

#[test]
fn ops_under_later_opaque_boxes_keep_their_visible_pixels() {
    let ui = {
        let mut ui = Ui::new_with_raster_density(2);
        ui.set_viewport(16.0, 10.0);
        ui
    };
    let mut words = vec![
        spec::draw_op::RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0xff20_4060,
    ];
    // Translucent shadows, a gradient and a glyph-free quad under two boxes,
    // one of them inside a scissor that clips its cover.
    words.extend_from_slice(&[
        spec::draw_op::RECT,
        xy_word(1, 2),
        wh_word(8, 7),
        0x5000_0000,
    ]);
    words.extend_from_slice(&[
        spec::draw_op::RECT,
        xy_word(0, 1),
        wh_word(10, 8),
        0x2000_0000,
    ]);
    words.extend_from_slice(&[
        spec::draw_op::GRAD_RECT,
        xy_word(9, 0),
        wh_word(6, 9),
        0x80ff_0000,
        0x4000_ff00,
        spec::GradDir::ToBottom as u32,
    ]);
    words.extend_from_slice(&[
        spec::draw_op::RECT,
        xy_word(1, 1),
        wh_word(8, 7),
        0xff30_3030,
    ]);
    words.extend_from_slice(&[spec::draw_op::SCISSOR, xy_word(10, 0), wh_word(3, 10)]);
    words.extend_from_slice(&[
        spec::draw_op::GRAD_RECT,
        xy_word(8, 1),
        wh_word(8, 6),
        0xff10_2030,
        0xff60_5040,
        spec::GradDir::ToBottom as u32,
    ]);
    words.push(spec::draw_op::SCISSOR_POP);
    let full = full_reference(&ui, &words, 16, 10, 2);
    let mut renderer = renderer(2);
    for bands in [
        vec![(0u32, 10u32)],
        (0..10).map(|y| (y, 1)).collect::<Vec<_>>(),
    ] {
        let tiled = assemble_strips(&mut renderer, &ui, &words, 16, &bands, 2, &mut NoPpa);
        assert_eq!(tiled, full);
    }
}

#[test]
fn color_textures_sample_like_the_software_sampler() {
    let mut ui = Ui::new_with_raster_density(2);
    ui.set_viewport(16.0, 10.0);
    // A one-color icon whose transparent texels are black, a multi-color
    // CLUT8 texture and an opaque 5650 texture, nearest and bilinear.
    let icon: Vec<u8> = (0..64u32)
        .flat_map(|i| {
            if i % 3 == 0 {
                [0, 0, 0, 0]
            } else {
                [0xd3, 0xd7, 0xdc, (i * 4) as u8]
            }
        })
        .collect();
    let icon_linear =
        ui.upload_texture_flags(&icon, 8, 8, spec::psm::PSM_8888, spec::img::FLAG_LINEAR);
    let icon_nearest = ui.upload_texture(&icon, 8, 8, spec::psm::PSM_8888);
    let mut paletted = Vec::new();
    for entry in 0..256u32 {
        paletted.extend_from_slice(&[entry as u8, (255 - entry) as u8, (entry * 3) as u8, 200]);
    }
    paletted.extend((0..64u32).map(|i| (i * 13 % 256) as u8));
    let clut = ui.upload_texture_flags(&paletted, 8, 8, spec::psm::PSM_T8, spec::img::FLAG_LINEAR);
    let opaque: Vec<u8> = (0..16u32)
        .flat_map(|i| ((i * 4093) as u16).to_le_bytes())
        .collect();
    let tile = ui.upload_texture_flags(&opaque, 4, 4, spec::psm::PSM_5650, spec::img::FLAG_LINEAR);
    assert!(icon_linear >= 0 && icon_nearest >= 0 && clut >= 0 && tile >= 0);
    let quad = |tex: i32, x: i16, y: i16, w: u16, h: u16, uv: [f32; 4], color: u32| {
        [
            spec::draw_op::TEX_QUAD,
            tex as u32,
            xy_word(x, y),
            wh_word(w, h),
            uv[0].to_bits(),
            uv[1].to_bits(),
            uv[2].to_bits(),
            uv[3].to_bits(),
            color,
        ]
    };
    let mut words = vec![
        spec::draw_op::RECT,
        xy_word(0, 0),
        wh_word(16, 10),
        0xff30_2010,
    ];
    words.extend_from_slice(&quad(
        icon_linear,
        1,
        1,
        4,
        4,
        [0.0, 0.0, 1.0, 1.0],
        0xffff_ffff,
    ));
    words.extend_from_slice(&quad(
        icon_linear,
        6,
        1,
        5,
        3,
        [0.25, 0.0, 0.875, 0.75],
        0x80ff_c080,
    ));
    words.extend_from_slice(&quad(
        icon_nearest,
        1,
        6,
        6,
        3,
        [0.0, 0.0, 1.0, 1.0],
        0xc0ff_ffff,
    ));
    words.extend_from_slice(&quad(clut, 9, 5, 6, 4, [0.0, 0.0, 1.0, 1.0], 0xffff_ffff));
    words.extend_from_slice(&quad(tile, 12, 0, 3, 3, [0.0, 0.0, 1.0, 1.0], 0xa0ff_ffff));
    let full = full_reference(&ui, &words, 16, 10, 2);
    let mut renderer = renderer(2);
    let bands: Vec<(u32, u32)> = (0..10).map(|y| (y, 1)).collect();
    let tiled = assemble_strips(&mut renderer, &ui, &words, 16, &bands, 2, &mut NoPpa);
    assert_eq!(tiled, full);
}

#[test]
fn overlapping_alpha_quads_keep_sequential_rgb565_rounding() {
    let mut ui = Ui::new();
    ui.set_viewport(16.0, 10.0);
    let handle = ui.upload_texture(&[255, 255, 255, 47], 1, 1, spec::psm::PSM_8888);
    let mut words = vec![spec::draw_op::RECT, 0, wh_word(16, 10), 0xff27_3159];
    for x in [1, 3, 5] {
        words.extend([
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(x, 2),
            wh_word(8, 6),
            0,
            0,
            1f32.to_bits(),
            1f32.to_bits(),
            0x9a32_74bb,
        ]);
    }
    let mut painter = renderer(1);
    assert_eq!(
        assemble_strips(&mut painter, &ui, &words, 16, &[(0, 10)], 1, &mut NoPpa),
        full_reference(&ui, &words, 16, 10, 1)
    );
}

#[test]
fn cached_words_can_be_mutated_in_place_and_recovered_after_a_bad_tail() {
    let (ui, mut words) = full_matrix_scene();
    let mut painter = renderer(1);
    let bands = [(0, 4), (4, 6)];
    assemble_strips(&mut painter, &ui, &words, 16, &bands, 1, &mut NoPpa);
    words[3] ^= 0x0000_ffff;
    assert_eq!(
        assemble_strips(&mut painter, &ui, &words, 16, &bands, 1, &mut NoPpa),
        full_reference(&ui, &words, 16, 10, 1)
    );
    words.push(spec::draw_op::SCISSOR_POP);
    let mut pixels = vec![0xa5a5; 160];
    assert!(painter
        .render_strip(
            &ui,
            &words,
            &mut pixels,
            Rect {
                x: 0,
                y: 0,
                w: 16,
                h: 10
            },
            &mut NoPpa
        )
        .is_none());
    assert!(pixels.iter().all(|&p| p == 0xa5a5));
    words.pop();
    assert_eq!(
        assemble_strips(&mut painter, &ui, &words, 16, &bands, 1, &mut NoPpa),
        full_reference(&ui, &words, 16, 10, 1)
    );
}

#[test]
fn overlapping_glyphs_keep_sequential_rgb565_rounding() {
    let (ui, _) = full_matrix_scene();
    let words = vec![
        spec::draw_op::RECT,
        0,
        wh_word(16, 10),
        0xff27_3159,
        spec::draw_op::GLYPH_RUN,
        2 << 16,
        0x9a32_74bb,
        xy_word(2, 2),
        0,
        xy_word(2, 2),
        0,
    ];
    let mut painter = renderer(1);
    assert_eq!(
        assemble_strips(&mut painter, &ui, &words, 16, &[(0, 10)], 1, &mut NoPpa),
        full_reference(&ui, &words, 16, 10, 1)
    );
}

#[test]
fn native_records_preserve_software_fallback_pixels_and_validate_their_lengths() {
    let (ui, _) = full_matrix_scene();
    let mut words = vec![
        spec::draw_op::RECT,
        0,
        wh_word(16, 10),
        0xff27_3159,
        spec::draw_op::TEXT_RUN,
        0,
        0,
        0,
        0,
        0,
        0,
        4,
        spec::draw_op::RECT,
        spec::draw_op::SURFACE_QUAD,
        17,
        0,
        0,
        0,
        0,
        xy_word(1, 1),
        wh_word(4, 3),
        255,
        spec::draw_op::RECT,
        xy_word(2, 2),
        wh_word(6, 4),
        0x9a32_74bb,
    ];
    let mut painter = renderer(1);
    assert_eq!(
        assemble_strips(
            &mut painter,
            &ui,
            &words,
            16,
            &[(0, 3), (3, 7)],
            1,
            &mut NoPpa
        ),
        full_reference(&ui, &words, 16, 10, 1)
    );
    for tail in [
        vec![spec::draw_op::TEXT_RUN, 0, 0, 0, 0, 0, 0, 8, 0],
        vec![spec::draw_op::SURFACE_QUAD, 17, 0, 0, 0, 0, 0, 0],
    ] {
        let length = words.len();
        words.extend(tail);
        let mut pixels = vec![0xa5a5; 160];
        assert!(painter
            .render_strip(
                &ui,
                &words,
                &mut pixels,
                Rect {
                    x: 0,
                    y: 0,
                    w: 16,
                    h: 10
                },
                &mut NoPpa,
            )
            .is_none());
        assert!(pixels.iter().all(|&pixel| pixel == 0xa5a5));
        words.truncate(length);
    }
}
