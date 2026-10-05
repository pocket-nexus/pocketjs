//! The Pocket3D title card.
//!
//! A game built on Pocket3D shows this card when it starts: the mark and the
//! name in white on the plum ground, faded in from black, held, and faded back to
//! black. [`TICKS`] ticks at 60 Hz, 2.4 seconds.
//!
//! The card needs no GPU. [`draw`] writes one tick's frame into a CPU-visible
//! frame buffer, so a game plays it before it starts its renderer and the
//! card costs the renderer nothing afterwards. [`play`] runs the whole card
//! over a `present` closure; [`vita::play`] is that loop for the PS Vita.
//! Nintendo 3DS hosts are C, and use `include/pocket3d_title.h`, which draws
//! the same frames.
//!
//! The art is baked by `tools/pocket3d-title.ts` from
//! `site/pocket3d/title-card.html`: `art/full.bin` (624 x 192) for a screen at
//! least 900 pixels wide and `art/half.bin` (312 x 96) for the others.
#![no_std]

/// Length of the card in ticks of 1/60 s.
pub const TICKS: u32 = 144;
/// Ticks the card takes to come up from black.
pub const FADE_IN: u32 = 20;
/// Ticks the card takes to go back to black.
pub const FADE_OUT: u32 = 28;

static FULL: &[u8] = include_bytes!("../art/full.bin");
static HALF: &[u8] = include_bytes!("../art/half.bin");
/// The widest art, and so the longest row the decoder holds.
const ROW: usize = 624;

/// How a frame buffer stores its pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// Rows from the top, 4 bytes a pixel: red, green, blue, 255. `stride` is
    /// pixels per row. PS Vita `A8B8G8R8` and PSP `8888`.
    Rgba8,
    /// The Nintendo 3DS frame buffer: columns from the left, each column from
    /// the bottom of the screen up, 3 bytes a pixel: blue, green, red.
    /// `stride` is pixels per column, 240.
    Bgr8Columns,
}

/// A frame buffer the card is drawn into.
pub struct Surface<'a> {
    pub pixels: &'a mut [u8],
    /// Width of the screen in pixels.
    pub width: u32,
    /// Height of the screen in pixels.
    pub height: u32,
    /// See [`Layout`].
    pub stride: u32,
    pub layout: Layout,
}

impl Surface<'_> {
    fn fits(&self) -> bool {
        let (w, h, s) = (self.width as usize, self.height as usize, self.stride as usize);
        w > 0
            && h > 0
            && match self.layout {
                Layout::Rgba8 => s >= w && self.pixels.len() >= s * h * 4,
                Layout::Bgr8Columns => s >= h && self.pixels.len() >= w * s * 3,
            }
    }

    #[inline]
    fn put(&mut self, x: usize, y: usize, [r, g, b]: [u8; 3]) {
        match self.layout {
            Layout::Rgba8 => {
                let at = (y * self.stride as usize + x) * 4;
                self.pixels[at..at + 4].copy_from_slice(&[r, g, b, 255]);
            }
            Layout::Bgr8Columns => {
                let at = (x * self.stride as usize + (self.height as usize - 1 - y)) * 3;
                self.pixels[at..at + 3].copy_from_slice(&[b, g, r]);
            }
        }
    }

    fn fill(&mut self, colour: [u8; 3]) {
        match self.layout {
            Layout::Rgba8 => {
                let [r, g, b] = colour;
                let (w, h, s) = (self.width as usize, self.height as usize, self.stride as usize);
                for row in self.pixels.chunks_exact_mut(s * 4).take(h) {
                    for pixel in row[..w * 4].chunks_exact_mut(4) {
                        pixel.copy_from_slice(&[r, g, b, 255]);
                    }
                }
            }
            Layout::Bgr8Columns => {
                let [r, g, b] = colour;
                let (w, h, s) = (self.width as usize, self.height as usize, self.stride as usize);
                for column in self.pixels.chunks_exact_mut(s * 3).take(w) {
                    for pixel in column[..h * 3].chunks_exact_mut(3) {
                        pixel.copy_from_slice(&[b, g, r]);
                    }
                }
            }
        }
    }
}

/// The art as baked: a palette and run-length rows.
struct Art {
    width: usize,
    height: usize,
    palette: &'static [u8],
    rows: &'static [u8],
    data: &'static [u8],
}

impl Art {
    fn parse(bytes: &'static [u8]) -> Self {
        let word = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize;
        let (width, height, colours) = (word(4), word(6), word(8));
        let rows = 12 + colours * 3;
        let data = rows + height * 4;
        Art { width, height, palette: &bytes[12..rows], rows: &bytes[rows..data], data: &bytes[data..] }
    }

    /// Expand row `y` into palette indices.
    fn row(&self, y: usize, line: &mut [u8; ROW]) {
        let offset = &self.rows[y * 4..y * 4 + 4];
        let mut at = u32::from_le_bytes([offset[0], offset[1], offset[2], offset[3]]) as usize;
        let mut x = 0;
        while x < self.width {
            let run = self.data[at] as usize + 1;
            line[x..x + run].fill(self.data[at + 1]);
            x += run;
            at += 2;
        }
    }
}

/// The card's light at `tick`, from 0 (black) to 256 (full).
///
/// It rises over [`FADE_IN`] ticks, holds, falls over [`FADE_OUT`] ticks and
/// is 0 on the last tick and after it, so the card ends on a black frame.
pub fn level(tick: u32) -> u32 {
    // smoothstep in 8.8 fixed point: 3t^2 - 2t^3
    fn smooth(n: u32, d: u32) -> u32 {
        let t = n * 256 / d;
        (t * t * (768 - 2 * t)) >> 16
    }
    if tick >= TICKS {
        0
    } else if tick < FADE_IN {
        smooth(tick + 1, FADE_IN)
    } else if tick >= TICKS - FADE_OUT {
        smooth(TICKS - 1 - tick, FADE_OUT)
    } else {
        256
    }
}

fn lit(colour: &[u8], level: u32) -> [u8; 3] {
    [
        ((colour[0] as u32 * level) >> 8) as u8,
        ((colour[1] as u32 * level) >> 8) as u8,
        ((colour[2] as u32 * level) >> 8) as u8,
    ]
}

/// Draw the card's frame for `tick` over the whole surface.
///
/// The ground fills the screen and the art sits in the middle: the 624 x 192
/// art when the screen is at least 900 x 400, the 312 x 96 art otherwise. A
/// screen smaller than the art gets the ground alone.
///
/// Returns `false`, and writes nothing, when `pixels` is too short for the
/// surface it describes.
pub fn draw(surface: &mut Surface, tick: u32) -> bool {
    if !surface.fits() {
        return false;
    }
    let level = level(tick);
    let art = Art::parse(if surface.width >= 900 && surface.height >= 400 { FULL } else { HALF });
    surface.fill(lit(&art.palette[..3], level));
    let (w, h) = (surface.width as usize, surface.height as usize);
    if level == 0 || art.width > w || art.height > h {
        return true;
    }
    let mut palette = [[0u8; 3]; 256];
    for (entry, colour) in palette.iter_mut().zip(art.palette.chunks_exact(3)) {
        *entry = lit(colour, level);
    }
    let (x0, y0) = ((w - art.width) / 2, (h - art.height) / 2);
    let mut line = [0u8; ROW];
    for y in 0..art.height {
        art.row(y, &mut line);
        for (x, &index) in line[..art.width].iter().enumerate() {
            // entry 0 is the ground, which the fill already wrote
            if index != 0 {
                surface.put(x0 + x, y0 + y, palette[index as usize]);
            }
        }
    }
    true
}

/// Fill the surface with the card's ground at `tick` and no art: the second
/// screen of a console that has two.
pub fn clear(surface: &mut Surface, tick: u32) -> bool {
    if !surface.fits() {
        return false;
    }
    surface.fill(lit(&FULL[12..15], level(tick)));
    true
}

/// Whether the frame at `tick` differs from the frame before it. A host with
/// one frame buffer skips the draw while this is `false`.
pub fn changed(tick: u32) -> bool {
    tick == 0 || level(tick) != level(tick - 1)
}

/// Play the whole card on a surface that keeps what was drawn into it.
///
/// `present` shows the surface and waits for the next vertical blank. It runs
/// [`TICKS`] times; the surface is redrawn on the ticks where the frame
/// changes.
///
/// The card ends on black, and `play` then sets every byte of `pixels` to
/// zero. In [`Layout::Rgba8`] a black pixel is `0, 0, 0, 255`; a renderer that
/// next shows the same memory as 16-bit pixels, as a PSP game with a 5650
/// frame buffer does, would read those bytes as `0x0000, 0xff00` columns
/// until its first frame. Zero bytes are black in every format.
pub fn play(surface: &mut Surface, mut present: impl FnMut(&mut Surface)) {
    for tick in 0..TICKS {
        if changed(tick) {
            draw(surface, tick);
        }
        present(surface);
    }
    surface.pixels.fill(0);
}

/// The card on a PS Vita.
#[cfg(target_os = "vita")]
pub mod vita {
    use super::{Layout, Surface};
    use core::ptr;
    use vitasdk_sys as sys;

    const WIDTH: u32 = 960;
    const HEIGHT: u32 = 544;
    /// Video memory is handed out in 256 KiB units.
    const UNIT: u32 = 256 * 1024;

    /// Play the card on the display and return when it has ended.
    ///
    /// Call it before `sceGxmInitialize`: it shows its own frame buffer
    /// through `sceDisplaySetFrameBuf`, then clears the display's buffer and
    /// frees the memory, so the renderer starts from the state it expects.
    /// Returns `false` without showing anything when the frame buffer cannot
    /// be allocated.
    pub fn play() -> bool {
        let bytes = WIDTH * HEIGHT * 4;
        let size = (bytes + UNIT - 1) / UNIT * UNIT;
        // SAFETY: the block is this function's own; the display stops reading
        // it (set to null, then one vertical blank) before it is freed.
        unsafe {
            let uid = sys::sceKernelAllocMemBlock(
                c"pocket3d-title".as_ptr(),
                sys::SCE_KERNEL_MEMBLOCK_TYPE_USER_CDRAM_RW,
                size,
                ptr::null_mut(),
            );
            if uid < 0 {
                return false;
            }
            let mut base = ptr::null_mut();
            if sys::sceKernelGetMemBlockBase(uid, &mut base) < 0 || base.is_null() {
                sys::sceKernelFreeMemBlock(uid);
                return false;
            }
            let frame = sys::SceDisplayFrameBuf {
                size: core::mem::size_of::<sys::SceDisplayFrameBuf>() as u32,
                base,
                pitch: WIDTH,
                pixelformat: sys::SCE_DISPLAY_PIXELFORMAT_A8B8G8R8,
                width: WIDTH,
                height: HEIGHT,
            };
            let mut surface = Surface {
                pixels: core::slice::from_raw_parts_mut(base.cast::<u8>(), bytes as usize),
                width: WIDTH,
                height: HEIGHT,
                stride: WIDTH,
                layout: Layout::Rgba8,
            };
            super::play(&mut surface, |_| {
                sys::sceDisplaySetFrameBuf(&frame, sys::SCE_DISPLAY_SETBUF_NEXTFRAME);
                sys::sceDisplayWaitVblankStart();
            });
            sys::sceDisplaySetFrameBuf(ptr::null(), sys::SCE_DISPLAY_SETBUF_NEXTFRAME);
            sys::sceDisplayWaitVblankStart();
            sys::sceKernelFreeMemBlock(uid);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec;
    use std::vec::Vec;

    fn fnv(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &byte| (hash ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3))
    }

    fn frame(width: u32, height: u32, stride: u32, layout: Layout, tick: u32) -> Vec<u8> {
        let bytes = match layout {
            Layout::Rgba8 => stride * height * 4,
            Layout::Bgr8Columns => width * stride * 3,
        };
        let mut pixels = vec![0u8; bytes as usize];
        assert!(draw(&mut Surface { pixels: &mut pixels, width, height, stride, layout }, tick));
        pixels
    }

    #[test]
    fn the_light_rises_holds_and_ends_on_black() {
        assert!(level(0) > 0 && level(0) < 16);
        assert_eq!(level(FADE_IN - 1), 256);
        assert_eq!(level(TICKS - FADE_OUT - 1), 256);
        assert_eq!(level(TICKS - 1), 0);
        assert_eq!(level(TICKS), 0);
        for tick in 1..FADE_IN {
            assert!(level(tick) >= level(tick - 1));
        }
        for tick in TICKS - FADE_OUT..TICKS {
            assert!(level(tick) <= level(tick - 1));
        }
        // the frame only changes while the light does
        // the last two ticks are both black
        assert!(changed(0) && changed(5) && !changed(60) && changed(TICKS - 2) && !changed(TICKS - 1));
    }

    #[test]
    fn a_held_frame_is_the_ground_with_the_art_in_the_middle() {
        let pixels = frame(960, 544, 960, Layout::Rgba8, 60);
        let at = |x: usize, y: usize| &pixels[(y * 960 + x) * 4..(y * 960 + x) * 4 + 4];
        assert_eq!(at(0, 0), [0x17, 0x12, 0x26, 255]);
        assert_eq!(at(959, 543), [0x17, 0x12, 0x26, 255]);
        // the art is 624 x 192, centred: rows 176..368, columns 168..792
        let outside = (0..544).flat_map(|y| (0..960).map(move |x| (x, y)))
            .filter(|&(x, y)| !(168..792).contains(&x) || !(176..368).contains(&y));
        assert!(outside.clone().all(|(x, y)| at(x, y) == [0x17, 0x12, 0x26, 255]));
        let inside = (176..368).flat_map(|y| (168..792).map(move |x| (x, y)))
            .filter(|&(x, y)| at(x, y) != [0x17, 0x12, 0x26, 255]).count();
        assert!(inside > 20_000, "the art covers {inside} pixels");
    }

    #[test]
    fn the_last_frame_is_black() {
        assert!(frame(480, 272, 480, Layout::Rgba8, TICKS - 1).chunks_exact(4).all(|pixel| pixel == [0, 0, 0, 255]));
        assert!(frame(400, 240, 240, Layout::Bgr8Columns, TICKS + 9).iter().all(|&byte| byte == 0));
    }

    #[test]
    fn both_layouts_hold_the_same_picture() {
        let rows = frame(400, 240, 400, Layout::Rgba8, 60);
        let columns = frame(400, 240, 240, Layout::Bgr8Columns, 60);
        for y in 0..240 {
            for x in 0..400 {
                let rgba = &rows[(y * 400 + x) * 4..][..3];
                let bgr = &columns[(x * 240 + (239 - y)) * 3..][..3];
                assert_eq!([rgba[0], rgba[1], rgba[2]], [bgr[2], bgr[1], bgr[0]], "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn padding_past_the_width_is_left_alone() {
        let mut pixels = vec![0xaau8; 512 * 272 * 4];
        assert!(draw(&mut Surface { pixels: &mut pixels, width: 480, height: 272, stride: 512, layout: Layout::Rgba8 }, 60));
        assert!(pixels.chunks_exact(512 * 4).all(|row| row[480 * 4..].iter().all(|&byte| byte == 0xaa)));
    }

    #[test]
    fn a_short_buffer_is_refused_untouched() {
        let mut pixels = vec![7u8; 960 * 544 * 4 - 1];
        assert!(!draw(&mut Surface { pixels: &mut pixels, width: 960, height: 544, stride: 960, layout: Layout::Rgba8 }, 60));
        assert!(!clear(&mut Surface { pixels: &mut pixels, width: 960, height: 544, stride: 960, layout: Layout::Rgba8 }, 60));
        assert!(pixels.iter().all(|&byte| byte == 7));
        // a screen smaller than the art gets the ground alone
        assert!(frame(200, 80, 200, Layout::Rgba8, 60).chunks_exact(4).all(|pixel| pixel == [0x17, 0x12, 0x26, 255]));
    }

    #[test]
    fn play_presents_every_tick_and_draws_only_changes() {
        let mut pixels = vec![0xaau8; 480 * 272 * 4];
        let mut surface = Surface { pixels: &mut pixels, width: 480, height: 272, stride: 480, layout: Layout::Rgba8 };
        let mut presented = 0;
        play(&mut surface, |_| presented += 1);
        assert_eq!(presented, TICKS);
        // the surface is left as zero bytes, black in a 32-bit and in a 16-bit display mode
        assert!(pixels.iter().all(|&byte| byte == 0));
        assert_eq!((0..TICKS).filter(|&tick| changed(tick)).count() as u32, FADE_IN + FADE_OUT - 1);
    }

    /// Frames the C header must reproduce byte for byte: (tick, FNV-1a 64 of a
    /// 400 x 240 Nintendo 3DS frame). `tests/pocket3d-title.test.ts` reads
    /// this table.
    const NINTENDO_3DS_FRAMES: [(u32, u64); 5] = [
        (0, 0xaf48_8c52_4099_8725),
        (9, 0xeb4f_0096_b8e5_68f6),
        (60, 0x2f22_1313_3624_58cb),
        (130, 0x4033_e986_bf01_6fbd),
        (143, 0xaf48_8c52_4099_8725),
    ];

    #[test]
    fn the_frames_are_the_recorded_ones() {
        for (tick, hash) in NINTENDO_3DS_FRAMES {
            let got = fnv(&frame(400, 240, 240, Layout::Bgr8Columns, tick));
            assert_eq!(got, hash, "tick {tick}: 0x{got:016x}");
        }
        // one frame of each art, on the consoles that show it
        assert_eq!(fnv(&frame(960, 544, 960, Layout::Rgba8, 60)), 0x94c3_6637_5fcd_ee99, "PS Vita");
        assert_eq!(fnv(&frame(480, 272, 512, Layout::Rgba8, 60)), 0xa0a1_0857_4d7f_d895, "PSP");
    }
}
