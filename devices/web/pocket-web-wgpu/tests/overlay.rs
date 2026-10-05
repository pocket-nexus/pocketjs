//! The overlay pass on this machine's GPU: a frame is cleared, a premultiplied
//! picture is laid over it, and the frame is read back. A machine with no GPU
//! this crate's features reach (wgpu here is built for Metal and for WebGPU)
//! skips the test and says so.

use pocket_web_wgpu::gpu::{Gpu, Screen};
use pocket_web_wgpu::overlay::Overlay;
use pocket_web_wgpu::task;

#[test]
fn a_premultiplied_picture_goes_over_a_frame() {
    let gpu = match task::wait(Gpu::headless()) {
        Ok(gpu) => gpu,
        Err(why) => {
            eprintln!("skipped: {why}");
            return;
        }
    };
    for samples in [1, 4] {
        let (width, height) = (8u32, 4u32);
        let screen = Screen::texture(&gpu, width, height, samples);
        let mut overlay = Overlay::new(&gpu, screen.format);
        // The left half is clear; the right half is red at half strength, premultiplied.
        let picture: Vec<u8> = (0..width * height).flat_map(|i| if i % width < width / 2 { [0, 0, 0, 0] } else { [128, 0, 0, 128] }).collect();
        overlay.write(&gpu, &picture, width, height).unwrap();
        assert!(overlay.write(&gpu, &picture, width, height + 1).is_err(), "a picture of another size than it says");

        let draw = |overlay: &Overlay| {
            let frame = screen.frame(&gpu).unwrap();
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            // (a game's scene would be drawn in this pass)
            drop(frame.pass(&mut encoder, [0.0, 0.0, 1.0]));
            overlay.draw(&mut encoder, &frame);
            gpu.queue.submit([encoder.finish()]);
            frame.present();
            task::wait(screen.read(&gpu)).unwrap()
        };
        let pixels = draw(&overlay);
        let at = |pixels: &[u8], x: u32, y: u32| -> [u8; 4] { pixels[((y * width + x) * 4) as usize..][..4].try_into().unwrap() };
        assert_eq!(at(&pixels, 1, 1), [0, 0, 255, 255], "where the picture is clear the frame shows ({samples} samples)");
        let over = at(&pixels, 6, 2);
        // blue x (1 - 128/255) + the picture's own colour
        assert!(over[0].abs_diff(128) <= 1 && over[1] == 0 && over[2].abs_diff(127) <= 1 && over[3] == 255, "{over:?} ({samples} samples)");

        overlay.hide();
        assert_eq!(at(&draw(&overlay), 6, 2), [0, 0, 255, 255], "a hidden picture is not laid over");
    }
}
