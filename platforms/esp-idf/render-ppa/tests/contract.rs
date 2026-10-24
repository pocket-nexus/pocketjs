//! Host-side routing, bounds, and error contracts. The device probe records calls;
//! it does not emulate PPA rendering or establish hardware pixel correctness.

use pocket_drivers::{
    DamageRect, DrawList, FontView, FrameInput, PixelFormat, Rect as Region, RenderError,
    RenderResources, Renderer, Surface, Target, TexView,
};
use pocket_render_esp_ppa::{
    damage_clip, Painter, PpaError, PpaOps, PpaRenderer, Rect, RendererConfig, SrmTransform,
};
use pocket_spec::draw_op;

struct Resources;
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (8.0, 6.0)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        Some(FontView {
            bitmap: &[64, 128, 192, 255],
            cell_w: 2,
            cell_h: 2,
            raster_density: 1,
            glyph_count: 1,
        })
    }
}
#[derive(Default)]
struct Device {
    calls: usize,
    blends: usize,
    fail_at: Option<usize>,
    unsupported: bool,
    alignment: usize,
    rects: Vec<Rect>,
}
impl PpaOps for Device {
    fn fill_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        _h: u32,
        r: Rect,
        _c: u16,
    ) -> Result<(), PpaError> {
        self.calls += 1;
        self.rects.push(r);
        if self.fail_at == Some(self.calls) {
            d[r.y as usize * w as usize + r.x as usize] = 0x1234;
            return Err(PpaError::Failed);
        }
        if self.unsupported {
            return Err(PpaError::Unsupported);
        }
        Ok(())
    }
    fn blend_a8_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: &[u8],
        r: Rect,
        _: [u8; 3],
        _: u8,
    ) -> Result<(), PpaError> {
        self.blends += 1;
        self.rects.push(r);
        if self.unsupported {
            return Err(PpaError::Unsupported);
        }
        Ok(())
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
    fn buffer_alignment(&self) -> usize {
        self.alignment
    }
}
fn config() -> RendererConfig {
    RendererConfig {
        scale: 1,
        min_fill_pixels: 1,
        min_blend_pixels: 1,
        min_srm_pixels: 1,
        cpu_blend_max_pixels: 0,
    }
}
fn wh(w: u32, h: u32) -> u32 {
    w | h << 16
}
fn words() -> Vec<u32> {
    vec![
        draw_op::RECT,
        0,
        wh(8, 6),
        0xff00_00ff,
        draw_op::RECT,
        wh(1, 1),
        wh(4, 3),
        0x80ff_0000,
        draw_op::GLYPH_RUN,
        1 << 16,
        0xff00_ff00,
        wh(3, 2),
        0,
    ]
}
fn bytes(pixels: &mut [u16]) -> &mut [u8] {
    unsafe { std::slice::from_raw_parts_mut(pixels.as_mut_ptr().cast(), pixels.len() * 2) }
}
/// The pure software render of `words()` into a full 8x6 RGB565 surface.
fn reference() -> Vec<u16> {
    let mut pixels = vec![0u16; 48];
    let mut s = Surface::new(
        bytes(&mut pixels),
        Region::new(0, 0, 8, 6),
        16,
        PixelFormat::Rgb565,
    )
    .unwrap();
    pocket_raster::render_surface(&Resources, &words(), &mut s, 1).unwrap();
    pixels
}
#[test]
fn rejected_operations_draw_in_software_with_reference_pixels() {
    let mut d = vec![0xffffu16; 48];
    let mut device = Device {
        unsupported: true,
        ..Default::default()
    };
    let mut painter = Painter::new(config(), 48).unwrap();
    let mut s = Surface::new(
        bytes(&mut d),
        Region::new(0, 0, 8, 6),
        16,
        PixelFormat::Rgb565,
    )
    .unwrap();
    let stats = painter
        .render(&Resources, &words(), &mut s, &mut device)
        .unwrap();
    assert!(
        device.calls >= 1 && device.blends >= 2,
        "the opaque background and both blends were offered"
    );
    assert_eq!((stats.ppa_fills, stats.ppa_blends), (0, 0));
    assert_eq!(d, reference());
}
#[test]
fn unaligned_strips_never_reach_the_device() {
    #[repr(C, align(64))]
    struct Aligned([u16; 64]);
    let mut storage = Aligned([0u16; 64]);
    let list = DrawList {
        words: words(),
        ..DrawList::new()
    };
    let mut renderer = PpaRenderer::new(
        config(),
        128,
        Device {
            alignment: 64,
            ..Default::default()
        },
    )
    .unwrap();
    // 64 aligned bytes are accepted; 96 bytes and a one-pixel offset are not.
    for (offset, rows, accelerated) in [(0usize, 4u32, true), (0, 6, false), (1, 4, false)] {
        let pixels = &mut storage.0[offset..offset + 8 * rows as usize];
        let surface = Surface::new(
            bytes(pixels),
            Region::new(0, 0, 8, rows),
            16,
            PixelFormat::Rgb565,
        )
        .unwrap();
        let mut frame = FrameInput::new(&list, &Resources, &[], Target::CpuVisible(surface));
        renderer.render(&mut frame).unwrap();
        let device = renderer.device_mut();
        assert_eq!(
            device.calls + device.blends > 0,
            accelerated,
            "offset {offset} rows {rows}"
        );
        device.calls = 0;
        device.blends = 0;
    }
}
#[test]
fn frame_damage_bounds_limit_writes_to_dirty_pixels() {
    let list = DrawList {
        words: words(),
        ..DrawList::new()
    };
    let reference = reference();
    // Rows 2..4 are dirty, delivered as two full-width records.
    let damage = [Region::new(0, 2, 8, 1), Region::new(0, 3, 8, 1)];
    for unsupported in [false, true] {
        let mut d = vec![0xffffu16; 48];
        let mut renderer = PpaRenderer::new(
            config(),
            48,
            Device {
                unsupported,
                ..Default::default()
            },
        )
        .unwrap();
        let surface = Surface::new(
            bytes(&mut d),
            Region::new(0, 0, 8, 6),
            16,
            PixelFormat::Rgb565,
        )
        .unwrap();
        let mut frame = FrameInput::new(&list, &Resources, &damage, Target::CpuVisible(surface));
        renderer.render(&mut frame).unwrap();
        let stats = renderer.stats();
        assert!(!stats.full_redraw);
        assert_eq!(
            stats.damage_bounds,
            Rect {
                x: 0,
                y: 2,
                w: 8,
                h: 2
            }
        );
        let device = renderer.device();
        assert!(device.calls > 0);
        assert!(
            device.rects.iter().all(|r| r.y >= 2 && r.y + r.h <= 4),
            "device rectangles stay inside the dirty rows: {:?}",
            device.rects
        );
        assert!(
            d[..16].iter().chain(&d[32..]).all(|&v| v == 0xffff),
            "pixels outside the damage keep their contents"
        );
        if unsupported {
            assert_eq!(d[16..32], reference[16..32]);
        }
    }
}
#[test]
fn damage_clip_unions_records_and_keeps_covered_strips_unclipped() {
    let strip = Region::new(0, 4, 8, 2);
    assert_eq!(damage_clip(std::iter::empty(), strip, 1), None);
    assert_eq!(damage_clip([Region::new(0, 0, 8, 6)], strip, 1), None);
    assert_eq!(
        damage_clip([Region::new(0, 4, 8, 1), Region::new(0, 5, 8, 1)], strip, 1),
        None
    );
    assert_eq!(damage_clip([Region::new(0, 0, 8, 4)], strip, 1), None);
    assert_eq!(
        damage_clip([Region::new(2, 5, 3, 3), Region::new(6, 4, 1, 1)], strip, 1),
        Some(DamageRect::new(2, 4, 7, 6))
    );
    // Physical damage widens to whole logical pixels at scale 2.
    assert_eq!(
        damage_clip([Region::new(1, 5, 2, 1)], strip, 2),
        Some(DamageRect::new(0, 2, 2, 3))
    );
}
#[test]
fn supported_and_unsupported_operations_follow_the_device_contract() {
    for unsupported in [false, true] {
        let mut d = vec![0u16; 48];
        let mut device = Device {
            unsupported,
            ..Default::default()
        };
        let mut painter = Painter::new(config(), 48).unwrap();
        let mut s = Surface::new(
            bytes(&mut d),
            Region::new(0, 0, 8, 6),
            16,
            PixelFormat::Rgb565,
        )
        .unwrap();
        painter
            .render(&Resources, &words(), &mut s, &mut device)
            .unwrap();
        assert!(device.calls >= 1);
        assert!(device.blends >= 2);
        assert_eq!(painter.scratch_bytes(), 48);
    }
}
#[test]
fn failed_after_write_aborts_without_replay_or_later_operations() {
    let mut d = vec![0u16; 48];
    let mut device = Device {
        fail_at: Some(1),
        ..Default::default()
    };
    let mut painter = Painter::new(config(), 48).unwrap();
    let mut s = Surface::new(
        bytes(&mut d),
        Region::new(0, 0, 8, 6),
        16,
        PixelFormat::Rgb565,
    )
    .unwrap();
    assert_eq!(
        painter.render(&Resources, &words(), &mut s, &mut device),
        Err(RenderError::Failed)
    );
    assert_eq!(device.calls, 1);
    assert_eq!(device.blends, 0);
    assert_eq!(d[0], 0x1234);
    assert!(d[1..].iter().all(|&v| v == 0));
}
#[test]
fn malformed_tail_is_rejected_before_first_device_write() {
    let mut d = vec![0x9876u16; 48];
    let mut device = Device::default();
    let mut painter = Painter::new(config(), 48).unwrap();
    let mut ops = words();
    ops.push(draw_op::RECT);
    let mut s = Surface::new(
        bytes(&mut d),
        Region::new(0, 0, 8, 6),
        16,
        PixelFormat::Rgb565,
    )
    .unwrap();
    assert_eq!(
        painter.render(&Resources, &ops, &mut s, &mut device),
        Err(RenderError::InvalidFrame)
    );
    assert_eq!(device.calls, 0);
    assert!(d.iter().all(|&v| v == 0x9876));
}
#[test]
fn zero_budget_keeps_fill_and_falls_back_for_a8() {
    let mut d = vec![0u16; 48];
    let mut device = Device::default();
    let mut painter = Painter::new(config(), 0).unwrap();
    let mut s = Surface::new(
        bytes(&mut d),
        Region::new(0, 0, 8, 6),
        16,
        PixelFormat::Rgb565,
    )
    .unwrap();
    painter
        .render(&Resources, &words(), &mut s, &mut device)
        .unwrap();
    assert!(device.calls >= 1);
    assert_eq!(device.blends, 0);
    assert_eq!(painter.scratch_bytes(), 0);
}
#[test]
fn packed_strips_keep_mask_storage_within_the_budget() {
    let mut painter = Painter::new(config(), 16).unwrap();
    let mut device = Device::default();
    for y in (0..6).step_by(2) {
        let mut d = vec![0u16; 16];
        let mut s = Surface::new(
            bytes(&mut d),
            Region::new(0, y, 8, 2),
            16,
            PixelFormat::Rgb565,
        )
        .unwrap();
        painter
            .render(&Resources, &words(), &mut s, &mut device)
            .unwrap();
        assert!(painter.scratch_bytes() <= 16);
    }
}
#[test]
fn odd_byte_alignment_and_stride_padding_use_safe_software_path() {
    let mut aligned = [0u16; 80];
    let data = bytes(&mut aligned);
    data.fill(0x71);
    let mut painter = Painter::new(config(), 48).unwrap();
    let mut device = Device::default();
    {
        let mut s = Surface::new(
            &mut data[1..],
            Region::new(1, 1, 4, 3),
            11,
            PixelFormat::Rgb565,
        )
        .unwrap();
        painter
            .render(&Resources, &words(), &mut s, &mut device)
            .unwrap();
    }
    assert_eq!(device.calls, 0);
    assert_eq!(device.blends, 0);
    assert_eq!(data[0], 0x71);
    for y in 0..3 {
        for x in 8..11 {
            assert_eq!(data[1 + y * 11 + x], 0x71);
        }
    }
}
#[test]
fn renderer_contract_is_immediate_rgb565_and_rejects_other_formats() {
    let mut renderer = PpaRenderer::new(config(), 48, Device::default()).unwrap();
    let d = renderer.descriptor();
    assert_eq!(d.formats(), &[PixelFormat::Rgb565]);
    assert_eq!(
        d.synchronization(),
        pocket_drivers::Synchronization::Immediate
    );
    assert!(!d.zero_copy());
    let list = DrawList {
        words: words(),
        ..DrawList::new()
    };
    let mut pixels = [0u8; 192];
    let surface = Surface::new(
        &mut pixels,
        Region::new(0, 0, 8, 6),
        32,
        PixelFormat::Rgba8888,
    )
    .unwrap();
    let mut f = FrameInput::new(&list, &Resources, &[], Target::CpuVisible(surface));
    assert_eq!(renderer.render(&mut f), Err(RenderError::Unsupported));
}
#[test]
fn operation_resource_cache_rejects_missing_words_without_panicking() {
    for words in [&[][..], &[draw_op::TEX_QUAD][..]] {
        let op = pocket_draw_ops::Operation {
            opcode: draw_op::TEX_QUAD,
            words,
            clip: DamageRect::new(0, 0, 8, 6),
        };
        assert!(pocket_raster::OperationResources::new(&Resources, &op, 1).is_err());
    }
}
#[test]
fn texture_revision_invalidates_classification_without_global_revision_change() {
    struct Dynamic(std::cell::Cell<bool>);
    impl RenderResources for Dynamic {
        fn viewport(&self) -> (f32, f32) {
            (8.0, 6.0)
        }
        fn raster_revision(&self) -> u64 {
            0
        }
        fn texture_revision(&self, _: i32) -> Option<u64> {
            Some(self.0.get() as u64)
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            Some(TexView {
                pixels: if self.0.get() {
                    &[255, 0, 0, 255]
                } else {
                    &[255, 255, 255, 255]
                },
                w: 1,
                h: 1,
                psm: pocket_spec::psm::PSM_8888,
                palette: None,
                linear: false,
            })
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    let resources = Dynamic(std::cell::Cell::new(false));
    let mut painter = Painter::new(config(), 48).unwrap();
    let mut device = Device::default();
    let ops = [
        draw_op::TEX_QUAD,
        0,
        0,
        wh(8, 6),
        0,
        0,
        1f32.to_bits(),
        1f32.to_bits(),
        0xffff_ffff,
    ];
    for red in [false, true] {
        resources.0.set(red);
        let mut d = vec![0u16; 48];
        let mut s = Surface::new(
            bytes(&mut d),
            Region::new(0, 0, 8, 6),
            16,
            PixelFormat::Rgb565,
        )
        .unwrap();
        let before = device.blends;
        painter
            .render(&resources, &ops, &mut s, &mut device)
            .unwrap();
        if red {
            assert_eq!(
                device.blends, before,
                "color texture must leave the alpha-only path"
            );
        } else {
            assert!(
                device.blends > before,
                "white texture uses the alpha-only path"
            );
        }
    }
}
#[test]
fn malformed_external_texture_and_font_return_error() {
    struct Broken;
    impl RenderResources for Broken {
        fn viewport(&self) -> (f32, f32) {
            (8., 6.)
        }
        fn raster_revision(&self) -> u64 {
            0
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            Some(TexView {
                pixels: &[],
                w: 0,
                h: 1,
                psm: pocket_spec::psm::PSM_8888,
                palette: None,
                linear: false,
            })
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            Some(FontView {
                bitmap: &[],
                cell_w: 2,
                cell_h: 2,
                raster_density: 0,
                glyph_count: 1,
            })
        }
    }
    for ops in [
        vec![
            draw_op::TEX_QUAD,
            0,
            0,
            wh(1, 1),
            0,
            0,
            1f32.to_bits(),
            1f32.to_bits(),
            0xffff_ffff,
        ],
        vec![draw_op::GLYPH_RUN, 1 << 16, 0xffff_ffff, 0, 0],
    ] {
        let mut d = vec![0u16; 48];
        let mut s = Surface::new(
            bytes(&mut d),
            Region::new(0, 0, 8, 6),
            16,
            PixelFormat::Rgb565,
        )
        .unwrap();
        let mut painter = Painter::new(config(), 48).unwrap();
        assert_eq!(
            painter.render(&Broken, &ops, &mut s, &mut Device::default()),
            Err(RenderError::InvalidFrame)
        );
    }
}
