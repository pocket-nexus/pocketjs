use pocket_draw_ops::{DrawOps, Operation};
use pocket_drivers::{
    DamageRect, DeviceTarget, DrawList, FontView, FrameInput, PixelFormat, Rect, RenderError,
    RenderResources, Renderer, Surface, Synchronization, Target, TargetOwnership, TexView,
};
use pocket_raster::{render_operation, render_surface, RasterRenderer};
use pocket_spec::{draw_op, psm};

struct Resources {
    width: f32,
    height: f32,
}
impl Resources {
    fn fixture() -> Self {
        Self {
            width: 8.0,
            height: 6.0,
        }
    }
}
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (self.width, self.height)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        (handle == 0 || handle == 1).then_some(TexView {
            pixels: &[
                255, 0, 0, 255, 0, 255, 0, 192, 0, 0, 255, 128, 255, 255, 255, 64,
            ],
            w: 2,
            h: 2,
            psm: psm::PSM_8888,
            palette: None,
            linear: handle == 0,
        })
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        (slot == 0).then_some(FontView {
            bitmap: &[0, 90, 180, 255],
            cell_w: 2,
            cell_h: 2,
            raster_density: 1,
            glyph_count: 1,
        })
    }
}

fn xy(x: i16, y: i16) -> u32 {
    x as u16 as u32 | ((y as u16 as u32) << 16)
}
fn wh(w: u16, h: u16) -> u32 {
    w as u32 | ((h as u32) << 16)
}

fn words() -> Vec<u32> {
    vec![
        draw_op::RECT,
        xy(0, 0),
        wh(8, 6),
        0xff30_2010,
        draw_op::SCISSOR,
        xy(1, 1),
        wh(6, 4),
        draw_op::GRAD_RECT,
        xy(0, 0),
        wh(8, 6),
        0x8000_00ff,
        0xc000_ff00,
        pocket_spec::GradDir::ToRight as u32,
        draw_op::TRI,
        xy(1, 1),
        xy(7, 2),
        xy(2, 5),
        0xff00_00ff,
        0xff00_ff00,
        0xffff_0000,
        draw_op::TEX_QUAD,
        0,
        xy(2, 1),
        wh(4, 4),
        0,
        0,
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        0xd0ff_ffff,
        draw_op::TEX_TRI,
        1,
        xy(0, 0),
        0,
        0,
        xy(5, 0),
        1.0f32.to_bits(),
        0,
        xy(0, 5),
        0,
        1.0f32.to_bits(),
        0x80ff_ffff,
        draw_op::GLYPH_RUN,
        1 << 16,
        0xffff_ffff,
        xy(3, 3),
        0,
        draw_op::SCISSOR_POP,
        draw_op::TEXT_RUN,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        draw_op::SURFACE_QUAD,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ]
}

fn full_render(resources: &Resources, words: &[u32], format: PixelFormat, scale: u32) -> Vec<u8> {
    let pixels = resources.width as usize * resources.height as usize * (scale * scale) as usize;
    match format {
        PixelFormat::Rgba8888 => {
            let mut result = vec![0; pixels * 4];
            pocket_raster::render_scaled(resources, words, &mut result, scale);
            result
        }
        PixelFormat::Argb8888 => {
            let mut result = vec![0; pixels * 4];
            pocket_raster::render_scaled_argb(resources, words, &mut result, scale);
            result
        }
        PixelFormat::Rgb565 => {
            let mut result = vec![0u16; pixels];
            pocket_raster::render_scaled_rgb565(resources, words, &mut result, scale);
            result
                .iter()
                .flat_map(|pixel| pixel.to_le_bytes())
                .collect()
        }
        _ => unreachable!(),
    }
}

#[test]
fn descriptor_and_configuration_advertise_only_implemented_targets() {
    assert!(RasterRenderer::new(0).is_err());
    assert!(RasterRenderer::new(5).is_err());
    let renderer = RasterRenderer::new(2).unwrap();
    assert_eq!(renderer.scale(), 2);
    let descriptor = renderer.descriptor();
    assert_eq!(
        descriptor.formats(),
        &[
            PixelFormat::Rgba8888,
            PixelFormat::Argb8888,
            PixelFormat::Rgb565
        ]
    );
    assert_eq!(descriptor.target_ownership(), TargetOwnership::CpuVisible);
    assert_eq!(descriptor.synchronization(), Synchronization::Immediate);
    assert_eq!(
        descriptor.draw_list_version(),
        pocket_spec::DRAW_LIST_VERSION
    );
    assert!(!descriptor.zero_copy());
}

#[test]
fn strided_unaligned_acquired_regions_match_full_render_in_every_format() {
    let resources = Resources::fixture();
    let mut list = DrawList::new();
    list.words = words();
    for format in [
        PixelFormat::Rgba8888,
        PixelFormat::Argb8888,
        PixelFormat::Rgb565,
    ] {
        for scale in [1, 2, 3, 4] {
            let width = 8 * scale;
            let height = 6 * scale;
            // Include sub-logical-pixel origins at scale 2.
            let region = Rect::new(1, 3, width - 2, height - 4);
            let bpp = format.bits_per_pixel() / 8;
            let stride = region.width as usize * bpp + 5;
            let needed = (region.height as usize - 1) * stride + region.width as usize * bpp;
            let mut storage = vec![0x79; needed + 2];
            let expected = full_render(&resources, &list.words, format, scale);
            {
                // Offset by one byte; RGB565 cannot assume u16 alignment.
                let surface =
                    Surface::new(&mut storage[1..needed + 1], region, stride, format).unwrap();
                let mut frame =
                    FrameInput::new(&list, &resources, &[], Target::CpuVisible(surface));
                let mut renderer = RasterRenderer::new(scale).unwrap();
                renderer.render(&mut frame).unwrap();
                renderer.wait(&()).unwrap();
                renderer.retire(());
            }
            let mut acquired = vec![false; storage.len()];
            for row in 0..region.height as usize {
                let actual = 1 + row * stride;
                let source = ((row + region.y as usize) * width as usize + region.x as usize) * bpp;
                let row_bytes = region.width as usize * bpp;
                assert_eq!(
                    &storage[actual..actual + row_bytes],
                    &expected[source..source + row_bytes],
                    "format {format:?}, scale {scale}, row {row}"
                );
                acquired[actual..actual + row_bytes].fill(true);
            }
            for (index, &byte) in storage.iter().enumerate() {
                if !acquired[index] {
                    assert_eq!(byte, 0x79, "padding/guard changed at {index}");
                }
            }
        }
    }
}

#[test]
fn single_pixel_strips_reassemble_full_frame_without_a_staging_buffer() {
    let resources = Resources::fixture();
    let words = words();
    for format in [
        PixelFormat::Rgba8888,
        PixelFormat::Argb8888,
        PixelFormat::Rgb565,
    ] {
        let bpp = format.bits_per_pixel() / 8;
        let mut output = Vec::new();
        for y in 0..6 {
            let mut row = vec![0; 8 * bpp];
            let mut surface =
                Surface::new(&mut row, Rect::new(0, y, 8, 1), 8 * bpp, format).unwrap();
            render_surface(&resources, &words, &mut surface, 1).unwrap();
            output.extend_from_slice(&row);
        }
        assert_eq!(output, full_render(&resources, &words, format, 1));
    }
}

#[test]
fn per_operation_fallback_preserves_destination_and_inherited_clip() {
    let resources = Resources::fixture();
    let words = words();
    let mut pixels = vec![0; 8 * 6 * 4];
    let mut surface = Surface::new(
        &mut pixels,
        Rect::new(0, 0, 8, 6),
        32,
        PixelFormat::Rgba8888,
    )
    .unwrap();
    render_surface(&resources, &[], &mut surface, 1).unwrap();
    for operation in DrawOps::new(&words, DamageRect::new(0, 0, 8, 6)) {
        render_operation(&resources, &operation.unwrap(), &mut surface, 1).unwrap();
    }
    assert_eq!(
        pixels,
        full_render(&resources, &words, PixelFormat::Rgba8888, 1)
    );

    let op_words = [draw_op::RECT, xy(0, 0), wh(8, 6), 0xff00_00ff];
    let operation = Operation {
        opcode: draw_op::RECT,
        words: &op_words,
        clip: DamageRect::new(2, 1, 4, 3),
    };
    let mut pixels = vec![0x61; 8 * 6 * 4];
    let mut surface = Surface::new(
        &mut pixels,
        Rect::new(0, 0, 8, 6),
        32,
        PixelFormat::Rgba8888,
    )
    .unwrap();
    render_operation(&resources, &operation, &mut surface, 1).unwrap();
    for y in 0..6 {
        for x in 0..8 {
            let start = (y * 8 + x) * 4;
            let expected = if (2..4).contains(&x) && (1..3).contains(&y) {
                [255, 0, 0, 255]
            } else {
                [0x61; 4]
            };
            assert_eq!(pixels[start..start + 4], expected);
        }
    }
}

#[test]
fn unsupported_and_invalid_targets_are_rejected_before_writes() {
    let resources = Resources::fixture();
    let list = DrawList::new();
    let device = DeviceTarget::new(1, Rect::new(0, 0, 8, 6), PixelFormat::Rgb565);
    let mut frame = FrameInput::new(&list, &resources, &[], Target::DeviceOwned(device));
    assert_eq!(
        RasterRenderer::new(1).unwrap().render(&mut frame),
        Err(RenderError::Unsupported)
    );

    let mut pixels = [0x37; 64];
    let mut surface =
        Surface::new(&mut pixels, Rect::new(0, 0, 8, 6), 8, PixelFormat::Gray8).unwrap();
    assert_eq!(
        render_surface(&resources, &[], &mut surface, 1),
        Err(RenderError::Unsupported)
    );
    assert!(pixels.iter().all(|&byte| byte == 0x37));

    let mut surface =
        Surface::new(&mut pixels, Rect::new(7, 5, 2, 1), 4, PixelFormat::Rgb565).unwrap();
    assert_eq!(
        render_surface(&resources, &[], &mut surface, 1),
        Err(RenderError::InvalidFrame)
    );
    assert!(pixels.iter().all(|&byte| byte == 0x37));

    for width in [f32::NAN, f32::INFINITY, 0.0, 65_536.0] {
        let invalid = Resources {
            width,
            height: 65_536.0,
        };
        let mut surface =
            Surface::new(&mut pixels, Rect::new(0, 0, 1, 1), 2, PixelFormat::Rgb565).unwrap();
        assert_eq!(
            render_surface(&invalid, &[], &mut surface, 1),
            Err(RenderError::InvalidFrame)
        );
    }
}

#[test]
fn malformed_and_forged_operation_records_return_errors() {
    let resources = Resources::fixture();
    let clip = DamageRect::new(0, 0, 8, 6);
    let mut pixels = [0u8; 8 * 6 * 2];
    let mut surface =
        Surface::new(&mut pixels, Rect::new(0, 0, 8, 6), 16, PixelFormat::Rgb565).unwrap();
    for words in [
        vec![u32::MAX],
        vec![draw_op::RECT],
        vec![draw_op::SCISSOR_POP],
        vec![draw_op::SCISSOR, xy(0, 0), wh(1, 1)],
    ] {
        assert_eq!(
            render_surface(&resources, &words, &mut surface, 1),
            Err(RenderError::InvalidFrame)
        );
    }
    let rect = [draw_op::RECT, xy(0, 0), wh(1, 1), 0xff00_00ff];
    let wrong_opcode = Operation {
        opcode: draw_op::TRI,
        words: &rect,
        clip,
    };
    assert_eq!(
        render_operation(&resources, &wrong_opcode, &mut surface, 1),
        Err(RenderError::InvalidFrame)
    );
    let extra_words = [rect, rect].concat();
    let not_one_record = Operation {
        opcode: draw_op::RECT,
        words: &extra_words,
        clip,
    };
    assert_eq!(
        render_operation(&resources, &not_one_record, &mut surface, 1),
        Err(RenderError::InvalidFrame)
    );
}

struct Views {
    texture: Option<TexView<'static>>,
    font: Option<FontView<'static>>,
}

impl RenderResources for Views {
    fn viewport(&self) -> (f32, f32) {
        (8.0, 6.0)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        self.texture
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        self.font
    }
}

fn quad_words() -> [u32; 9] {
    [
        draw_op::TEX_QUAD,
        0,
        0,
        wh(2, 2),
        0,
        0,
        1.0f32.to_bits(),
        1.0f32.to_bits(),
        u32::MAX,
    ]
}

fn assert_invalid_resource(resources: &impl RenderResources, words: &[u32]) {
    let mut pixels = [0; 8 * 6 * 4];
    let mut surface = Surface::new(
        &mut pixels,
        Rect::new(0, 0, 8, 6),
        32,
        PixelFormat::Rgba8888,
    )
    .unwrap();
    assert_eq!(
        render_surface(resources, words, &mut surface, 1),
        Err(RenderError::InvalidFrame)
    );
    let operation = Operation {
        opcode: words[0],
        words,
        clip: DamageRect::new(0, 0, 8, 6),
    };
    assert_eq!(
        render_operation(resources, &operation, &mut surface, 1),
        Err(RenderError::InvalidFrame)
    );
}

#[test]
fn invalid_resource_views_return_errors_at_both_public_entrypoints() {
    let texture = TexView {
        pixels: &[255; 16],
        w: 2,
        h: 2,
        psm: psm::PSM_8888,
        palette: None,
        linear: false,
    };
    for view in [
        TexView { w: 0, ..texture },
        TexView { h: 0, ..texture },
        TexView {
            pixels: &[255; 15],
            ..texture
        },
        TexView {
            psm: psm::PSM_5650,
            pixels: &[255; 7],
            ..texture
        },
        TexView {
            psm: psm::PSM_4444,
            pixels: &[255; 7],
            ..texture
        },
        TexView {
            psm: psm::PSM_T8,
            palette: None,
            ..texture
        },
        TexView {
            psm: psm::PSM_T8,
            palette: Some(&[255; 1023]),
            ..texture
        },
        TexView {
            psm: psm::PSM_T8,
            palette: Some(&[255; 1024]),
            pixels: &[255; 3],
            ..texture
        },
        TexView {
            w: u32::MAX,
            ..texture
        },
        TexView {
            w: 65536,
            h: 65536,
            ..texture
        },
    ] {
        assert_invalid_resource(
            &Views {
                texture: Some(view),
                font: None,
            },
            &quad_words(),
        );
    }
    let font = FontView {
        bitmap: &[255; 4],
        cell_w: 2,
        cell_h: 2,
        raster_density: 1,
        glyph_count: 1,
    };
    let glyph = [draw_op::GLYPH_RUN, 1 << 16, u32::MAX, 0, 0];
    for view in [
        FontView { cell_w: 0, ..font },
        FontView { cell_h: 0, ..font },
        FontView {
            bitmap: &[255; 3],
            ..font
        },
        FontView {
            raster_density: 0,
            ..font
        },
        FontView {
            cell_w: u32::MAX,
            ..font
        },
        FontView {
            cell_w: u32::MAX,
            raster_density: 255,
            ..font
        },
    ] {
        assert_invalid_resource(
            &Views {
                texture: None,
                font: Some(view),
            },
            &glyph,
        );
    }
    for coordinate in [f32::NAN, f32::NEG_INFINITY, f32::MIN] {
        let mut quad = quad_words();
        quad[4] = coordinate.to_bits();
        assert_invalid_resource(
            &Views {
                texture: Some(TexView {
                    linear: true,
                    ..texture
                }),
                font: None,
            },
            &quad,
        );
    }
}

#[test]
fn missing_resources_and_out_of_range_glyphs_keep_skip_behavior() {
    let missing = Views {
        texture: None,
        font: None,
    };
    let invalid_glyph = Views {
        texture: None,
        font: Some(FontView {
            bitmap: &[],
            cell_w: 0,
            cell_h: 0,
            raster_density: 0,
            glyph_count: 1,
        }),
    };
    let quad = quad_words();
    let glyph = [draw_op::GLYPH_RUN, 1 << 16, u32::MAX, 0, 1];
    for (resources, words) in [
        (&missing, quad.as_slice()),
        (&missing, glyph.as_slice()),
        (&invalid_glyph, glyph.as_slice()),
    ] {
        let mut pixels = [0x57; 8 * 6 * 4];
        let mut surface = Surface::new(
            &mut pixels,
            Rect::new(0, 0, 8, 6),
            32,
            PixelFormat::Rgba8888,
        )
        .unwrap();
        let operation = Operation {
            opcode: words[0],
            words,
            clip: DamageRect::new(0, 0, 8, 6),
        };
        render_operation(resources, &operation, &mut surface, 1).unwrap();
        assert!(pixels.iter().all(|&byte| byte == 0x57));
    }
}

#[test]
fn each_operation_draws_from_the_same_resource_view_that_was_validated() {
    struct ChangingResources {
        calls: std::cell::Cell<usize>,
    }
    impl RenderResources for ChangingResources {
        fn viewport(&self) -> (f32, f32) {
            (8.0, 6.0)
        }
        fn raster_revision(&self) -> u64 {
            0
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            let calls = self.calls.get();
            self.calls.set(calls + 1);
            Some(TexView {
                pixels: if calls == 0 { &[255; 16] } else { &[] },
                w: 2,
                h: 2,
                psm: psm::PSM_8888,
                palette: None,
                linear: false,
            })
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    let resources = ChangingResources {
        calls: std::cell::Cell::new(0),
    };
    let mut pixels = [0; 8 * 6 * 4];
    let mut surface = Surface::new(
        &mut pixels,
        Rect::new(0, 0, 8, 6),
        32,
        PixelFormat::Rgba8888,
    )
    .unwrap();
    render_surface(&resources, &quad_words(), &mut surface, 1).unwrap();
    assert_eq!(resources.calls.get(), 1);
    assert_eq!(&pixels[..8], &[255; 8]);
}
