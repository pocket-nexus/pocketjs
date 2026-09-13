//! Opt-in physical-device receipts. Production builds perform no capture or IO.
//! Samples measure CPU frame work through swap submission, not GPU timestamps.
use std::{fs, io::Write, time::Instant};

use pocketjs_vita::graphics;

pub struct Bench {
    directory: String,
    samples: Vec<(u32, u128, u128)>,
    epoch: Instant,
    frame_start: Instant,
}

impl Bench {
    pub fn new() -> Self {
        let now = Instant::now();
        Self {
            directory: format!("ux0:/data/pocketjs-bench/{}", env!("POCKETJS_BUNDLE_HASH")),
            samples: Vec::with_capacity(720),
            epoch: now,
            frame_start: now,
        }
    }

    pub fn begin(&mut self) {
        self.frame_start = Instant::now();
    }

    /// Call after present, before any next scene can reuse its memory.
    pub unsafe fn end(&mut self, frame: u32) -> std::io::Result<()> {
        if frame >= 720 {
            return Ok(());
        }
        self.samples.push((
            frame,
            self.frame_start.duration_since(self.epoch).as_micros(),
            self.frame_start.elapsed().as_micros(),
        ));
        if [120, 360, 600].contains(&frame) {
            // libvita2d exposes frontBufferIndex; swap_buffers advances that
            // index to the scene we just submitted. Its display pitch is 960.
            // https://github.com/xerpi/libvita2d/blob/master/libvita2d/source/vita2d.c
            let framebuffer = vita2d_sys::vita2d_get_current_fb().cast::<u8>();
            if (graphics::PHYSICAL_W, graphics::PHYSICAL_H) != (960, 544) {
                return Err(std::io::Error::other(
                    "unsupported libvita2d framebuffer geometry",
                ));
            }
            if framebuffer.is_null() {
                return Err(std::io::Error::other("GXM framebuffer is null"));
            }
            // This wait and file write occur after the timing sample. Exclude
            // these frames and the following start interval from statistics.
            vita2d_sys::vita2d_wait_rendering_done();
            fs::create_dir_all(&self.directory)?;
            let bytes = std::slice::from_raw_parts(
                framebuffer,
                (graphics::PHYSICAL_W * graphics::PHYSICAL_H * 4) as usize,
            );
            fs::write(format!("{}/f{frame:04}.rgba", self.directory), bytes)?;
        }
        if frame == 719 {
            fs::create_dir_all(&self.directory)?;
            let mut file = fs::File::create(format!("{}/frames.csv", self.directory))?;
            writeln!(file, "frame,start_us,cpu_frame_us")?;
            for (frame, start, work) in &self.samples {
                writeln!(file, "{frame},{start},{work}")?;
            }
            fs::write(format!("{}/receipt.json", self.directory), format!(
                "{{\"bundle\":\"{}\",\"width\":{},\"height\":{},\"format\":\"RGBA8\",\"capture\":\"GXM render buffer after GPU completion\",\"captureFrames\":[120,360,600],\"frames\":720}}\n",
                env!("POCKETJS_BUNDLE_HASH"), graphics::PHYSICAL_W, graphics::PHYSICAL_H))?;
            self.samples.clear();
        }
        Ok(())
    }
}
