use pocket_drivers::{
    DamageRect, DrawList, FontView, FrameInput, PixelFormat, Rect as Region, RenderError,
    RenderResources, Renderer, Surface, Target, TexView,
};
use pocket_render_esp_ppa::{
    Painter, PpaError, PpaOps, PpaRenderer, Rect, RendererConfig, SrmTransform,
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
}
impl PpaOps for Device {
    fn fill_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        _h: u32,
        r: Rect,
        c: u16,
    ) -> Result<(), PpaError> {
        self.calls += 1;
        if self.fail_at == Some(self.calls) {
            d[r.y as usize * w as usize + r.x as usize] = 0x1234;
            return Err(PpaError::Failed);
        }
        if self.unsupported {
            return Err(PpaError::Unsupported);
        }
        for y in r.y..r.y + r.h {
            for x in r.x..r.x + r.w {
                d[(y * w + x) as usize] = c;
            }
        }
        Ok(())
    }
    fn blend_a8_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        _h: u32,
        m: &[u8],
        r: Rect,
        c: [u8; 3],
        a: u8,
    ) -> Result<(), PpaError> {
        self.blends += 1;
        if self.unsupported {
            return Err(PpaError::Unsupported);
        }
        for y in r.y..r.y + r.h {
            for x in r.x..r.x + r.w {
                let i = (y * w + x) as usize;
                blend(
                    &mut d[i],
                    c[0] as u32,
                    c[1] as u32,
                    c[2] as u32,
                    (m[i] as u32 * a as u32 + 127) / 255,
                );
            }
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
}
fn blend(pixel: &mut u16, r: u32, g: u32, b: u32, a: u32) {
    let p = *pixel as u32;
    let r5 = (p >> 11) & 31;
    let g6 = (p >> 5) & 63;
    let b5 = p & 31;
    let (dr, dg, db) = (
        (r5 << 3) | (r5 >> 2),
        (g6 << 2) | (g6 >> 4),
        (b5 << 3) | (b5 >> 2),
    );
    let mix = |s: u32, d: u32| (s * a + d * (255 - a) + 127) / 255;
    *pixel = pocket_raster::pack_rgb565(mix(r, dr), mix(g, dg), mix(b, db));
}
fn config() -> RendererConfig {
    RendererConfig {
        scale: 1,
        min_fill_pixels: 1,
        min_blend_pixels: 1,
        min_srm_pixels: 1,
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
fn expected(words: &[u32]) -> Vec<u16> {
    let mut d = vec![0; 48];
    pocket_raster::render_scaled_rgb565(&Resources, words, &mut d, 1);
    d
}
#[test]
fn accelerated_and_unsupported_operations_preserve_pixel_order() {
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
        assert_eq!(d, expected(&words()));
        assert!(device.calls >= 2);
        assert!(device.blends >= 2);
        assert_eq!(painter.scratch_bytes(), 48);
    }
}
#[test]
fn failed_after_write_aborts_without_replay_or_later_operations() {
    let mut d = vec![0u16; 48];
    let mut device = Device {
        fail_at: Some(2),
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
    assert_eq!(device.calls, 2);
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
    assert_eq!(d, expected(&words()));
    assert!(device.calls >= 2);
    assert_eq!(device.blends, 0);
    assert_eq!(painter.scratch_bytes(), 0);
}
#[test]
fn packed_strips_match_full_frame_with_strip_sized_mask() {
    let expected = expected(&words());
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
        assert_eq!(d, expected[y as usize * 8..(y as usize + 2) * 8]);
        assert!(painter.scratch_bytes() <= 16);
    }
}
#[test]
fn odd_byte_alignment_and_stride_padding_use_safe_software_path() {
    let expected = expected(&words());
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
        for x in 0..4 {
            let at = 1 + y * 11 + x * 2;
            assert_eq!(
                u16::from_le_bytes([data[at], data[at + 1]]),
                expected[(y + 1) * 8 + x + 1]
            );
        }
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
fn clipped_clear_intersects_odd_physical_origin_before_addressing() {
    let mut painter = Painter::new(
        RendererConfig {
            scale: 2,
            ..config()
        },
        48,
    )
    .unwrap();
    let mut device = Device::default();
    let ops = words();
    let mut reference = vec![0u16; 192];
    pocket_raster::render_scaled_rgb565(&Resources, &ops, &mut reference, 2);
    for requested in [DamageRect::new(0, 0, 8, 6), DamageRect::new(1, 0, 2, 1)] {
        let mut d = vec![0x6789; 6];
        let mut s = Surface::new(
            bytes(&mut d),
            Region::new(1, 0, 3, 2),
            6,
            PixelFormat::Rgb565,
        )
        .unwrap();
        painter
            .render_clipped(&Resources, &ops, &mut s, Some(requested), &mut device)
            .unwrap();
        for y in 0..2 {
            for x in 0..3 {
                let global_x = x + 1;
                let touched =
                    global_x >= requested.x0 as usize * 2 && global_x < requested.x1 as usize * 2;
                assert_eq!(
                    d[y * 3 + x],
                    if touched {
                        reference[y * 16 + global_x]
                    } else {
                        0x6789
                    }
                );
            }
        }
    }
    assert_eq!(device.calls, 0);
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
        painter
            .render(&resources, &ops, &mut s, &mut device)
            .unwrap();
        assert!(d.iter().all(|&v| v == if red { 0xf800 } else { 0xffff }));
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
