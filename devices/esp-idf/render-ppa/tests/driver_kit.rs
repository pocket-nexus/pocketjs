//! pocket-driver-kit conformance: the renderer's CPU frame contract on an
//! unaligned allocation with row padding, against hand-computed RGB565 pixels.
//! The device probe records calls; it does not emulate PPA rendering.

use pocket_driver_kit::{check_cpu_frame, PixelViolation};
use pocket_drivers::{DrawList, FontView, PixelFormat, Rect, RenderResources, TexView};
use pocket_render_esp_ppa::{
    PpaError, PpaOps, PpaRenderer, Rect as PpaRect, RendererConfig, SrmTransform,
};
use pocket_spec::draw_op;

struct Resources;
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (4.0, 3.0)
    }
    fn raster_revision(&self) -> u64 {
        0
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}
#[derive(Default)]
struct Device {
    calls: usize,
}
impl PpaOps for Device {
    fn fill_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: PpaRect,
        _: u16,
    ) -> Result<(), PpaError> {
        self.calls += 1;
        Err(PpaError::Unsupported)
    }
    fn blend_a8_rgb565(
        &mut self,
        _: &mut [u16],
        _: u32,
        _: u32,
        _: &[u8],
        _: PpaRect,
        _: [u8; 3],
        _: u8,
    ) -> Result<(), PpaError> {
        self.calls += 1;
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
        _: PpaRect,
        _: PpaRect,
        _: SrmTransform,
    ) -> Result<(), PpaError> {
        self.calls += 1;
        Err(PpaError::Unsupported)
    }
    fn buffer_alignment(&self) -> usize {
        4
    }
}

#[test]
fn cpu_frame_matches_an_independent_oracle_and_keeps_padding() {
    let config = RendererConfig {
        min_fill_pixels: 1,
        ..RendererConfig::default()
    };
    let mut renderer = PpaRenderer::new(config, 64, Device::default()).unwrap();
    // An opaque red rectangle over the left half, then an opaque blue one
    // over the bottom-right pixel; the rest clears to black.
    let mut list = DrawList::new();
    list.words = vec![
        draw_op::RECT,
        0,
        2 | 3 << 16,
        0xff00_00ff,
        draw_op::RECT,
        3 | 2 << 16,
        1 | 1 << 16,
        0xffff_0000,
    ];
    const RED: [u8; 2] = 0xf800u16.to_le_bytes();
    const BLUE: [u8; 2] = 0x001fu16.to_le_bytes();
    const BLACK: [u8; 2] = [0, 0];
    let rows = [
        [RED, RED, BLACK, BLACK],
        [RED, RED, BLACK, BLACK],
        [RED, RED, BLACK, BLUE],
    ];
    let expected: Vec<u8> = rows.iter().flatten().flatten().copied().collect();
    let region = Rect::new(0, 0, 4, 3);
    // check_cpu_frame offsets the surface by one byte: the strip misses the
    // device alignment, so every operation draws in software.
    check_cpu_frame(
        &mut renderer,
        &list,
        &Resources,
        region,
        PixelFormat::Rgb565,
        10,
        &expected,
    )
    .unwrap();
    assert_eq!(
        renderer.device().calls,
        0,
        "an unaligned strip reached the device"
    );
    let mut wrong = expected.clone();
    wrong[0] ^= 1;
    assert_eq!(
        check_cpu_frame(
            &mut renderer,
            &list,
            &Resources,
            region,
            PixelFormat::Rgb565,
            10,
            &wrong
        ),
        Err(PixelViolation::Pixels)
    );
    // The renderer declares RGB565 only.
    assert_eq!(
        check_cpu_frame(
            &mut renderer,
            &list,
            &Resources,
            region,
            PixelFormat::Rgba8888,
            16,
            &[0; 48]
        ),
        Err(PixelViolation::Descriptor)
    );
}
