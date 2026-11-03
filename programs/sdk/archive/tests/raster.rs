//! `pocket_raster_draw_op` exists in every archive; the `software-renderer`
//! feature decides whether it draws or reports UNSUPPORTED without writing.
use pocket_archive::pocket_raster_draw_op;
use pocket_drivers::abi::*;

#[test]
fn draw_op_follows_the_software_renderer_feature() {
    let mut pixels = [0xab_u8; 4 * 4 * 4];
    let region = PocketRect {
        width: 4,
        height: 4,
        ..PocketRect::empty()
    };
    let mut surface = PocketSurface {
        pixels: pixels.as_mut_ptr(),
        byte_length: pixels.len(),
        region: &region,
        stride_bytes: 16,
        pixel_format: POCKET_PIXEL_FORMAT_RGBA8888,
        ..PocketSurface::empty()
    };
    let words = [pocket_spec::draw_op::RECT, 0, 4 | (4 << 16), 0xff00_00ff];
    let clip = PocketLogicalClip {
        x1: 4,
        y1: 4,
        ..PocketLogicalClip::empty()
    };
    let op = PocketDrawOp {
        words: words.as_ptr(),
        word_count: words.len(),
        clip: &clip,
        scale: 1,
        ..PocketDrawOp::empty()
    };
    let resources = PocketRenderResources {
        viewport_width: 4.0,
        viewport_height: 4.0,
        ..PocketRenderResources::empty()
    };
    let status = unsafe { pocket_raster_draw_op(&mut surface, &op, &resources) };
    if cfg!(feature = "software-renderer") {
        assert_eq!(status, POCKET_STATUS_OK);
        assert!(pixels.chunks_exact(4).all(|p| p == [0xff, 0, 0, 0xff]));
    } else {
        assert_eq!(status, POCKET_STATUS_UNSUPPORTED);
        assert!(pixels.iter().all(|&byte| byte == 0xab));
    }
}
