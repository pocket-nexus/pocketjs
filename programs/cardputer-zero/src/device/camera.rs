//! The live camera. While the Camera tool is open one `rpicam-vid` streams
//! 640x360 MJPEG on its stdout (linux.rs `live_stream`). A reader thread
//! splits the stream after each JPEG's end marker, keeps the latest frame's
//! bytes (a picture is that frame, written as it is) and decodes it to the
//! 256x128 RGBA texture the video plane copies into the viewfinder's texture
//! (video.rs). While the tool scans, a second
//! thread reads QR codes from the latest frame about four times a second,
//! with zxing-cpp when the system has it (zxing.rs) and rqrr otherwise. libcamera takes 9 to 11 s to deliver the first frame on the
//! CardputerZero (measured 2026-10-28 with 53 MiB free and swap in use), so
//! the topic reports `starting` until it lands; from then the stream runs at
//! about 12.7 frames a second, about 11 KiB a frame.

// The stream itself runs on Linux only; the host build answers from the mock.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::sync::Arc;
use zune_jpeg::zune_core::{colorspace::ColorSpace, options::DecoderOptions};

pub const WIDTH: u32 = 640;
pub const HEIGHT: u32 = 360;
pub const FRAMERATE: u32 = 15;
/// The viewfinder texture: 256x128 RGBA, the whole frame box-sampled into it.
pub const TEXTURE_W: usize = 256;
pub const TEXTURE_H: usize = 128;
/// `GET /dev/camera/thumbnail.rgb565`: the last photo at 128x64 in PSM_5650,
/// small enough for the worker's channels (16 KiB).
pub const THUMB_W: usize = 128;
pub const THUMB_H: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Phase {
    #[default]
    Off,
    Starting,
    Live,
    Failed,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Off => "off",
            Phase::Starting => "starting",
            Phase::Live => "live",
            Phase::Failed => "failed",
        }
    }
}

#[derive(Default)]
pub struct Live {
    pub phase: Phase,
    pub error: Option<String>,
    /// Bumped by every start and stop: a thread whose generation is gone
    /// ends without touching the state.
    pub generation: u64,
    pub started_ms: u64,
    pub frame: u32,
    pub fps: f32,
    pub jpeg: Option<Arc<Vec<u8>>>,
    pub rgba: Option<Arc<Vec<u8>>>,
    pub pid: Option<u32>,
    pub scanning: bool,
    /// The last QR code read while scanning, and the frame it came from.
    pub qr: Option<String>,
    pub qr_frame: u32,
}

/// Cuts an MJPEG byte stream into JPEG files. Inside a JPEG's entropy-coded
/// data a 0xFF byte is followed by 0x00 or a restart marker, so 0xFF 0xD9
/// appears only as the end-of-image marker.
#[derive(Default)]
pub struct Splitter {
    buffer: Vec<u8>,
    scanned: usize,
}

impl Splitter {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let from = self.scanned.saturating_sub(1);
            let Some(end) = self.buffer[from..].windows(2).position(|w| w == [0xff, 0xd9]).map(|at| from + at + 2) else {
                self.scanned = self.buffer.len();
                break;
            };
            let frame: Vec<u8> = self.buffer.drain(..end).collect();
            self.scanned = 0;
            if let Some(start) = frame.windows(2).position(|w| w == [0xff, 0xd8]) {
                out.push(frame[start..].to_vec());
            }
        }
        // A stream that never ends a frame is not MJPEG: keep the tail bounded.
        if self.buffer.len() > 4 * 1024 * 1024 {
            self.buffer.clear();
            self.scanned = 0;
        }
        out
    }
}

fn decode(jpeg: &[u8], colorspace: ColorSpace) -> Result<(Vec<u8>, usize, usize), String> {
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(std::io::Cursor::new(jpeg), DecoderOptions::default().jpeg_set_out_colorspace(colorspace));
    let pixels = decoder.decode().map_err(|e| format!("{e:?}"))?;
    let info = decoder.info().ok_or("no picture info")?;
    let (w, h) = (info.width as usize, info.height as usize);
    if w == 0 || h == 0 || pixels.len() < w * h * colorspace.num_components() {
        return Err("picture is empty".into());
    }
    Ok((pixels, w, h))
}

/// Box-sample packed RGB into the 256x128 RGBA texture.
pub fn texture_from_rgb(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    let (ow, oh) = (TEXTURE_W, TEXTURE_H);
    let mut out = vec![0u8; ow * oh * 4];
    for y in 0..oh {
        let sy0 = y * h / oh;
        let sy1 = ((y + 1) * h / oh).max(sy0 + 1).min(h);
        for x in 0..ow {
            let sx0 = x * w / ow;
            let sx1 = ((x + 1) * w / ow).max(sx0 + 1).min(w);
            let mut sum = [0u32; 3];
            let mut count = 0u32;
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let at = (sy * w + sx) * 3;
                    sum[0] += pixels[at] as u32;
                    sum[1] += pixels[at + 1] as u32;
                    sum[2] += pixels[at + 2] as u32;
                    count += 1;
                }
            }
            let o = (y * ow + x) * 4;
            out[o] = (sum[0] / count) as u8;
            out[o + 1] = (sum[1] / count) as u8;
            out[o + 2] = (sum[2] / count) as u8;
            out[o + 3] = 255;
        }
    }
    out
}

/// The 256x128 RGBA texture box-sampled to the 128x64 thumbnail in the
/// core's PSM_5650 (16 bits, little endian, red in the low five bits and
/// blue in the high five, as the GE stores it).
pub fn thumbnail_rgb565(rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(THUMB_W * THUMB_H * 2);
    for y in 0..THUMB_H {
        for x in 0..THUMB_W {
            let mut sum = [0u32; 3];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let at = ((y * 2 + dy) * TEXTURE_W + x * 2 + dx) * 4;
                for channel in 0..3 {
                    sum[channel] += rgba.get(at + channel).copied().unwrap_or(0) as u32;
                }
            }
            let [r, g, b] = sum.map(|value| value / 4);
            let packed = ((b >> 3) << 11 | (g >> 2) << 5 | r >> 3) as u16;
            out.extend_from_slice(&packed.to_le_bytes());
        }
    }
    out
}

/// A JPEG as the viewfinder texture, with the picture's own size.
pub fn texture(jpeg: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let (pixels, w, h) = decode(jpeg, ColorSpace::RGB)?;
    Ok((texture_from_rgb(&pixels, w, h), w as u32, h as u32))
}

/// The text of the first QR code in a greyscale picture.
pub fn read_qr_luma(luma: &[u8], w: usize, h: usize) -> Option<String> {
    if luma.len() < w * h {
        return None;
    }
    #[cfg(target_os = "linux")]
    if let Some(zxing) = super::zxing::get() {
        return zxing.read(luma, w, h);
    }
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| luma[y * w + x]);
    prepared.detect_grids().into_iter().find_map(|grid| grid.decode().ok().map(|(_, text)| text)).filter(|text| !text.is_empty())
}

/// The text of the first QR code in a JPEG.
pub fn read_qr(jpeg: &[u8]) -> Result<Option<String>, String> {
    let (luma, w, h) = decode(jpeg, ColorSpace::Luma)?;
    Ok(read_qr_luma(&luma, w, h))
}

/// Frames per second over the frames of the last two seconds.
#[derive(Default)]
pub struct Rate {
    times: std::collections::VecDeque<f64>,
}

impl Rate {
    pub fn tick(&mut self, t: f64) -> f32 {
        self.times.push_back(t);
        while self.times.front().is_some_and(|&first| t - first > 2.0) {
            self.times.pop_front();
        }
        match (self.times.front(), self.times.len()) {
            (Some(&first), n) if n > 1 && t > first => ((n - 1) as f64 / (t - first)) as f32,
            _ => 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_splitter_cuts_after_each_end_marker_across_chunks() {
        let a = [0xff, 0xd8, 1, 2, 0xff, 0x00, 3, 0xff, 0xd9];
        let b = [0xff, 0xd8, 9, 0xff, 0xd9];
        let stream: Vec<u8> = a.iter().chain(b.iter()).copied().collect();
        let mut splitter = Splitter::default();
        let mut frames = Vec::new();
        // One byte at a time: a marker split between two chunks still ends a frame.
        for byte in &stream {
            frames.extend(splitter.push(&[*byte]));
        }
        assert_eq!(frames, vec![a.to_vec(), b.to_vec()]);
        // Bytes before a frame's start marker are dropped.
        let mut splitter = Splitter::default();
        assert_eq!(splitter.push(&[7, 7, 0xff, 0xd8, 5, 0xff, 0xd9, 0xff]), vec![vec![0xff, 0xd8, 5, 0xff, 0xd9]]);
    }

    #[test]
    fn the_texture_samples_the_whole_frame() {
        let (w, h) = (640, 360);
        let mut rgb = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in w / 2..w {
                rgb[(y * w + x) * 3] = 200;
            }
        }
        let texture = texture_from_rgb(&rgb, w, h);
        assert_eq!(texture.len(), TEXTURE_W * TEXTURE_H * 4);
        assert_eq!(texture[0], 0);
        assert_eq!(texture[(TEXTURE_W - 1) * 4], 200);
        assert_eq!(texture[3], 255);
    }

    #[test]
    fn the_thumbnail_halves_the_texture_into_rgb565() {
        let mut rgba = vec![0u8; TEXTURE_W * TEXTURE_H * 4];
        for pixel in rgba.chunks_mut(4) {
            pixel.copy_from_slice(&[255, 0, 0, 255]);
        }
        let thumbnail = thumbnail_rgb565(&rgba);
        assert_eq!(thumbnail.len(), THUMB_W * THUMB_H * 2);
        // Red is the low five bits.
        assert_eq!(u16::from_le_bytes([thumbnail[0], thumbnail[1]]), 0x001f);
    }

    #[test]
    fn a_small_soft_code_reads_from_a_viewfinder_frame() {
        // "https://pocket.nexus" at 3.3 pixels a module with a white margin,
        // blurred (sigma 1.1) and JPEG-compressed in a 640x360 frame: a 5 cm
        // code 25 cm from the Zero's camera.
        let jpeg = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/qr-viewfinder.jpg"));
        #[cfg(target_os = "linux")]
        if super::super::zxing::get().is_some() {
            assert_eq!(read_qr(jpeg).unwrap().as_deref(), Some("https://pocket.nexus"));
            return;
        }
        eprintln!("without zxing-cpp, rqrr reads {:?}", read_qr(jpeg));
    }

    #[test]
    fn the_rate_counts_frames_over_two_seconds() {
        let mut rate = Rate::default();
        let mut fps = 0.0;
        for i in 0..40 {
            fps = rate.tick(i as f64 * 0.08);
        }
        assert!((fps - 12.5).abs() < 0.1, "{fps}");
    }
}
