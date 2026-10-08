mod input;
#[cfg(feature = "rkrga")]
mod rkrga;

#[cfg(not(feature = "rkrga"))]
use std::slice;
use std::{
    fs,
    os::fd::AsRawFd,
    ptr,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;
#[cfg(feature = "rkrga")]
use pocketjs_core::damage::{DamagePlan, DamagePolicy, DamageRect, DamageTracker};

const LOGICAL_W: f32 = 360.0;
const LOGICAL_H: f32 = 640.0;
const DENSITY: u32 = 2;
const FRAME_INTERVAL: Duration = Duration::from_nanos(16_666_667);
const HOST_ID: &str = "linux-fbdev";
const HOST_ABI: u32 = 1;
const FBIOGET_VSCREENINFO: libc::c_ulong = 0x4600;
const FBIOGET_FSCREENINFO: libc::c_ulong = 0x4602;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Bitfield {
    offset: u32,
    length: u32,
    msb_right: u32,
}

#[repr(C)]
#[derive(Default)]
struct VarInfo {
    xres: u32,
    yres: u32,
    xres_virtual: u32,
    yres_virtual: u32,
    xoffset: u32,
    yoffset: u32,
    bits_per_pixel: u32,
    grayscale: u32,
    red: Bitfield,
    green: Bitfield,
    blue: Bitfield,
    transp: Bitfield,
    nonstd: u32,
    activate: u32,
    height: u32,
    width: u32,
    accel_flags: u32,
    pixclock: u32,
    left_margin: u32,
    right_margin: u32,
    upper_margin: u32,
    lower_margin: u32,
    hsync_len: u32,
    vsync_len: u32,
    sync: u32,
    vmode: u32,
    rotate: u32,
    colorspace: u32,
    reserved: [u32; 4],
}

#[repr(C)]
struct FixInfo {
    id: [libc::c_char; 16],
    smem_start: libc::c_ulong,
    smem_len: u32,
    type_: u32,
    type_aux: u32,
    visual: u32,
    xpanstep: u16,
    ypanstep: u16,
    ywrapstep: u16,
    line_length: u32,
    mmio_start: libc::c_ulong,
    mmio_len: u32,
    accel: u32,
    capabilities: u16,
    reserved: [u16; 2],
}

struct Framebuffer {
    map: *mut u8,
    map_len: usize,
    info: VarInfo,
    stride: usize,
    direct_bgrx: bool,
}

impl Framebuffer {
    fn open(path: &str) -> Result<Self> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .with_context(|| format!("opening framebuffer {path}"))?;
        let mut info = VarInfo::default();
        let mut fixed = unsafe { std::mem::zeroed::<FixInfo>() };
        if unsafe { libc::ioctl(file.as_raw_fd(), FBIOGET_VSCREENINFO, &mut info) } < 0
            || unsafe { libc::ioctl(file.as_raw_fd(), FBIOGET_FSCREENINFO, &mut fixed) } < 0
        {
            return Err(std::io::Error::last_os_error()).context("querying fbdev mode");
        }
        if !matches!(info.bits_per_pixel, 16 | 24 | 32) {
            bail!(
                "unsupported fbdev depth {} (expected 16, 24, or 32)",
                info.bits_per_pixel
            );
        }
        if info.xres == 0 || info.yres == 0 || fixed.line_length == 0 || fixed.smem_len == 0 {
            bail!("fbdev reported invalid geometry or memory size");
        }
        let map_len = fixed.smem_len as usize;
        let map = unsafe {
            libc::mmap(
                ptr::null_mut(),
                map_len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if map == libc::MAP_FAILED {
            return Err(std::io::Error::last_os_error()).context("mapping framebuffer memory");
        }
        log::info!(
            "fbdev {}x{} depth={} stride={} bytes, channel offsets R{} G{} B{}",
            info.xres,
            info.yres,
            info.bits_per_pixel,
            fixed.line_length,
            info.red.offset,
            info.green.offset,
            info.blue.offset
        );
        let direct_bgrx = info.bits_per_pixel == 32
            && info.red.offset == 16
            && info.red.length == 8
            && info.green.offset == 8
            && info.green.length == 8
            && info.blue.offset == 0
            && info.blue.length == 8
            && info.red.msb_right == 0
            && info.green.msb_right == 0
            && info.blue.msb_right == 0;
        if direct_bgrx {
            log::info!("fbdev present: BGRX8888 row-copy fast path");
        }
        Ok(Self {
            map: map.cast(),
            map_len,
            info,
            stride: fixed.line_length as usize,
            direct_bgrx,
        })
    }

    #[cfg(not(feature = "rkrga"))]
    fn present(&mut self, pixels: &[u8], source_width: usize, source_height: usize) -> Result<()> {
        let source_size = source_width
            .checked_mul(source_height)
            .and_then(|pixels| pixels.checked_mul(4))
            .context("software framebuffer dimensions overflow")?;
        if pixels.len() != source_size {
            bail!("software framebuffer has the wrong size");
        }
        let bpp = (self.info.bits_per_pixel / 8) as usize;
        let width = self.info.xres as usize;
        let height = self.info.yres as usize;
        let xoff = self.info.xoffset as usize;
        let yoff = self.info.yoffset as usize;
        let needed = (yoff + height).saturating_sub(1) * self.stride + (xoff + width) * bpp;
        if needed > self.map_len {
            bail!("fbdev visible area exceeds mapped memory");
        }
        let dst = unsafe { slice::from_raw_parts_mut(self.map, self.map_len) };
        if self.direct_bgrx {
            let row_bytes = width.min(source_width) * 4;
            for y in 0..height.min(source_height) {
                let src_at = y * source_width * 4;
                let dst_at = (y + yoff) * self.stride + xoff * 4;
                dst[dst_at..dst_at + row_bytes]
                    .copy_from_slice(&pixels[src_at..src_at + row_bytes]);
            }
            return Ok(());
        }
        for y in 0..height.min(source_height) {
            for x in 0..width.min(source_width) {
                let i = (y * source_width + x) * 4;
                let rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
                let pixel = pack(
                    rgb,
                    self.info.red,
                    self.info.green,
                    self.info.blue,
                    self.info.transp,
                );
                let at = (y + yoff) * self.stride + (x + xoff) * bpp;
                for n in 0..bpp {
                    dst[at + n] = (pixel >> (8 * n)) as u8;
                }
            }
        }
        Ok(())
    }

    #[cfg(feature = "rkrga")]
    fn present_rkrga(&mut self, rkrga: &mut rkrga::RkrgaPresenter) -> Result<()> {
        if !self.direct_bgrx {
            bail!("RK RGA presenter requires a BGRX8888 framebuffer");
        }
        let width = self.info.xres as usize;
        let height = self.info.yres as usize;
        let xoff = self.info.xoffset as usize;
        let yoff = self.info.yoffset as usize;
        let destination_offset = yoff * self.stride + xoff * 4;
        let needed = destination_offset + height.saturating_sub(1) * self.stride + width * 4;
        if needed > self.map_len {
            bail!("fbdev visible area exceeds mapped memory");
        }
        let destination = unsafe { self.map.add(destination_offset) };
        rkrga.present(destination)
    }
}

impl Drop for Framebuffer {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.map.cast(), self.map_len);
        }
    }
}

#[cfg(not(feature = "rkrga"))]
fn pack(rgb: [u8; 3], r: Bitfield, g: Bitfield, b: Bitfield, a: Bitfield) -> u32 {
    fn channel(value: u8, f: Bitfield) -> u32 {
        if f.length == 0 {
            return 0;
        }
        ((value as u32 * ((1u32 << f.length.min(8)) - 1) + 127) / 255) << f.offset
    }
    channel(rgb[0], r)
        | channel(rgb[1], g)
        | channel(rgb[2], b)
        | if a.length > 0 {
            ((1u32 << a.length.min(8)) - 1) << a.offset
        } else {
            0
        }
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let fb_path = std::env::var("POCKET_FB").unwrap_or_else(|_| "/dev/fb0".into());
    let mut fb = Framebuffer::open(&fb_path)?;
    let pak_path = std::env::var("POCKET_PAK").unwrap_or_else(|_| "app.pak".into());
    let js_path = std::env::var("POCKET_JS").unwrap_or_else(|_| "app.js".into());
    let pak = fs::read(&pak_path).with_context(|| format!("reading {pak_path}"))?;
    let bundle = fs::read_to_string(&js_path).with_context(|| format!("reading {js_path}"))?;
    let surface = UiSurface::new_with_density((LOGICAL_W, LOGICAL_H), DENSITY);
    surface.set_identity(HOST_ID, HOST_ABI);
    surface.feed_pak(&pak);
    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval("app", &bundle)?;
    anyhow::ensure!(guest.has_frame(), "bundle installed no frame()");
    #[cfg(feature = "rkrga")]
    let raster_scale = 1u32;
    #[cfg(not(feature = "rkrga"))]
    let raster_scale = DENSITY;
    let raster_width = LOGICAL_W as usize * raster_scale as usize;
    let raster_height = LOGICAL_H as usize * raster_scale as usize;
    #[cfg(feature = "rkrga")]
    let mut rkrga = {
        if !fb.direct_bgrx || fb.stride % 4 != 0 {
            bail!("RK RGA requires a BGRX8888 framebuffer with a pixel-aligned stride");
        }
        let path = std::env::var("POCKET_RKRGA_LIB").unwrap_or_else(|_| "librga.so".into());
        log::info!(
            "RK RGA present: CPU {}x{} incremental raster -> {}x{} resize via {path}",
            raster_width,
            raster_height,
            fb.info.xres,
            fb.info.yres
        );
        rkrga::RkrgaPresenter::open(
            &path,
            raster_width,
            raster_height,
            fb.info.xres as usize,
            fb.info.yres as usize,
            fb.stride / 4,
            fb.info.yres as usize,
        )?
    };
    #[cfg(feature = "rkrga")]
    let mut damage_tracker: DamageTracker = DamageTracker::new();
    #[cfg(not(feature = "rkrga"))]
    let mut rgba = vec![0u8; raster_width * raster_height * 4];
    let input_path = std::env::var("POCKET_INPUT").unwrap_or_else(|_| "/dev/input/event0".into());
    let mut input = input::TouchInput::open(&input_path)
        .with_context(|| format!("opening touch input {input_path}"))?;
    let bench_frames = std::env::var("POCKET_BENCH_FRAMES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok());
    let bench_start = Instant::now();
    let mut frame_count = 0u64;
    let mut guest_tick_time = Duration::ZERO;
    let mut raster_time = Duration::ZERO;
    let mut present_time = Duration::ZERO;
    let mut presented_frames = 0u64;
    #[cfg(feature = "rkrga")]
    let mut damage_pixels = 0u64;
    #[cfg(feature = "rkrga")]
    let mut full_redraws = 0u64;
    let mut last = Instant::now();
    loop {
        let elapsed = last.elapsed();
        if bench_frames.is_none() && elapsed < FRAME_INTERVAL {
            std::thread::sleep(FRAME_INTERVAL - elapsed);
        }
        last = Instant::now();
        let guest_tick_start = Instant::now();
        let touches = input.poll();
        guest.frame_with_touches(0, pocketjs_core::spec::ANALOG_CENTER, &touches)?;
        surface.tick();
        guest_tick_time += guest_tick_start.elapsed();
        let raster_start = Instant::now();
        #[cfg(feature = "rkrga")]
        let damage = {
            let rgba = rkrga.source_buffer();
            surface.with_ui(|ui| {
                let words = ui.draw().words.clone();
                match pocketjs_core::raster::render_scaled_argb_incremental(
                    ui,
                    &words,
                    rgba,
                    raster_scale,
                    &mut damage_tracker,
                    DamagePolicy::default(),
                ) {
                    Ok(plan) => plan,
                    Err(error) => {
                        log::warn!(
                            "DrawList damage planning failed ({error:?}); rendering a full frame"
                        );
                        pocketjs_core::raster::render_scaled_argb(ui, &words, rgba, raster_scale);
                        damage_tracker.invalidate();
                        DamagePlan::full(DamageRect::new(0, 0, LOGICAL_W as i32, LOGICAL_H as i32))
                    }
                }
            })
        };
        #[cfg(not(feature = "rkrga"))]
        surface.with_ui(|ui| {
            let words = ui.draw().words.clone();
            if fb.direct_bgrx {
                pocketjs_core::raster::render_scaled_argb(ui, &words, &mut rgba, raster_scale);
            } else {
                pocketjs_core::raster::render_scaled(ui, &words, &mut rgba, raster_scale);
            }
        });
        raster_time += raster_start.elapsed();
        let present_start = Instant::now();
        #[cfg(feature = "rkrga")]
        if !damage.is_empty() {
            fb.present_rkrga(&mut rkrga)?;
            presented_frames += 1;
            damage_pixels += damage.area();
            if damage.is_full_redraw() {
                full_redraws += 1;
            }
        }
        #[cfg(not(feature = "rkrga"))]
        {
            fb.present(&rgba, raster_width, raster_height)?;
            presented_frames += 1;
        }
        present_time += present_start.elapsed();
        frame_count += 1;
        if bench_frames.is_some_and(|limit| frame_count >= limit) {
            let seconds = bench_start.elapsed().as_secs_f64();
            let guest_tick_seconds = guest_tick_time.as_secs_f64();
            let raster_seconds = raster_time.as_secs_f64();
            let present_seconds = present_time.as_secs_f64();
            log::info!(
                "benchmark: {} frames ({} presented); total {:.3}s = {:.2} fps; guest+tick {:.3}s ({:.2} ms/frame); raster {:.3}s = {:.2} fps ({:.2} ms/frame); fbdev-present {:.3}s ({:.2} ms/frame)",
                frame_count,
                presented_frames,
                seconds,
                frame_count as f64 / seconds,
                guest_tick_seconds,
                guest_tick_seconds * 1000.0 / frame_count as f64,
                raster_seconds,
                frame_count as f64 / raster_seconds,
                raster_seconds * 1000.0 / frame_count as f64,
                present_seconds,
                present_seconds * 1000.0 / frame_count as f64
            );
            #[cfg(feature = "rkrga")]
            log::info!(
                "RK RGA damage: {} presented / {} ticks; {} full redraws; {:.1} logical pixels/tick average",
                presented_frames,
                frame_count,
                full_redraws,
                damage_pixels as f64 / frame_count as f64,
            );
            break Ok(());
        }
    }
}
