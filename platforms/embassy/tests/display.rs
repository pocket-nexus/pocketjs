use pocket_drivers::{DisplayOutput, DisplayRole, PixelFormat, Rect, Target};
use pocket_embassy::display::{BufferedDisplay, Frame, Transport};
use std::{
    future::{Future, pending},
    task::{Context, Waker},
};
struct Screen {
    pending: bool,
    pixels: Vec<u8>,
}
impl Transport for Screen {
    type Error = ();
    async fn write(&mut self, frame: Frame<'_>) -> Result<(), ()> {
        self.pixels = frame.pixels.to_vec();
        if self.pending {
            pending::<()>().await;
        }
        Ok(())
    }
}
#[test]
fn tokens_regions_and_frame_ownership_follow_the_display_contract() {
    for format in [
        PixelFormat::Rgb565,
        PixelFormat::Rgba8888,
        PixelFormat::Argb8888,
    ] {
        let length = format.row_bytes(4).unwrap() * 2;
        let (mut output, mut presenter) =
            BufferedDisplay::new(DisplayRole::Primary, 4, 2, format, length).unwrap();
        let before = output.frame_identity().unwrap().unwrap().generation;
        assert!(output.acquire(Rect::new(0, 0, 5, 2)).is_err());
        {
            let Target::CpuVisible(mut surface) = output.acquire(Rect::new(0, 0, 4, 2)).unwrap()
            else {
                panic!()
            };
            surface.pixels_mut().fill(0x7f);
        }
        assert!(output.flush(&[Rect::new(0, 0, 5, 2)]).is_err());
        let token = output.flush(&[Rect::new(0, 0, 4, 2)]).unwrap();
        assert!(output.wait(token + 1).is_err());
        assert!(output.acquire(Rect::new(0, 0, 4, 2)).is_err());
        output.wait(token).unwrap();
        assert!(output.wait(token).is_err());
        let mut screen = Screen {
            pending: true,
            pixels: Vec::new(),
        };
        {
            let mut transfer = std::pin::pin!(presenter.present(&mut screen));
            assert!(
                transfer
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                    .is_pending()
            );
            assert!(output.acquire(Rect::new(0, 0, 4, 2)).is_err());
        }
        assert_eq!(screen.pixels, vec![0x7f; length]);
        assert!(output.frame_identity().unwrap().unwrap().generation > before);
        assert!(output.acquire(Rect::new(0, 0, 4, 2)).is_ok());
    }
}
#[test]
fn output_checks_memory_budget_and_supported_formats() {
    assert!(BufferedDisplay::new(DisplayRole::Primary, 4, 2, PixelFormat::Rgb565, 15).is_err());
    assert!(
        BufferedDisplay::new(
            DisplayRole::Primary,
            u32::MAX,
            u32::MAX,
            PixelFormat::Argb8888,
            usize::MAX
        )
        .is_err()
    );
    assert!(BufferedDisplay::new(DisplayRole::Primary, 4, 2, PixelFormat::Mono1, 64).is_err());
}
