//! Deterministic software rasterizer: executes the core DrawList (spec.ts
//! "DRAWLIST op format") over an RGBA8, BGRA8, or RGB565 framebuffer.
//! DrawList coordinates remain logical; [`render_scaled`] maps them directly
//! onto an integer-scaled physical surface without first rasterizing a
//! low-resolution image.
//!
//! Determinism rules (byte-exact goldens depend on this):
//!   - Color math is INTEGER (u32/i64) everywhere: blending, gouraud triangle
//!     interpolation, texture modulation.
//!   - Triangle coverage uses exact integer edge functions evaluated at
//!     doubled pixel-center coordinates (vertex coords are i16 integers, so
//!     nothing ever rounds).
//!   - The only f32 involved is gradient/texture-coordinate interpolation —
//!     plain IEEE-754 add/mul/div on finite values (identical on every
//!     platform; no transcendental calls, no NaN paths: every divisor is
//!     checked > 0 first).
//!
//! Clipping: the core pre-clips every op to the screen AND to enclosing
//! scissors, but per the documented core degradations GLYPH_RUN cells and
//! (defensively) TEX_QUAD texels still rely on the backend scissor for
//! partial overlap at clip edges — so we keep a scissor stack and pixel-clip
//! EVERY op against the current rect (a no-op for the pre-clipped ones).
//!
//! RGBA framebuffer layout: row-major, top-left origin, 4 bytes/px R,G,B,A —
//! which is exactly a little-endian ABGR u32 (0xAABBGGRR), the spec color
//! format, so channel bytes map 1:1. The buffer is treated as opaque: the
//! destination alpha is always written back as 255.
//!
//! [`render_scaled_argb`] emits the same pixels as B,G,R,A bytes instead —
//! the little-endian memory layout of an ARGB8888 u32 word. Hosts whose blit
//! engines consume ARGB8888 words can present the framebuffer without a
//! per-frame reorder pass: byte placement is fused into the pixel writes, so
//! it costs nothing extra.
//!
//! [`render_scaled_rgb565`] writes native little-endian RGB565 words — the
//! low-bandwidth opaque target for 16-bit hosts. Hardware DrawList backends
//! reuse it (via [`render_scaled_rgb565_over`]) as their ordered software
//! fallback for ops their accelerator cannot express.
//!
//! [`render_scaled_premultiplied`] is the one target that keeps coverage: the
//! buffer starts transparent and every pixel ends as premultiplied R,G,B with
//! the alpha the DrawList's ops accumulated. A host that lays the interface
//! over a scene of its own (a 3D frame) composites that buffer with
//! `dst × (1 − a) + src`. Its colour bytes equal [`render_scaled`]'s.

#![no_std]

extern crate alloc;

use pocket_drivers::DamageRect;
use pocket_drivers::RenderResources;
use pocket_drivers::TexView;
use pocket_spec::{self as spec, draw_op};

pub mod abi;
pub mod incremental;
mod surface;
#[cfg(test)]
mod differential_tests;
#[cfg(test)]
mod reference;
#[cfg(test)]
mod triangle_tests;
pub use incremental::{
    render_scaled_argb_incremental, render_scaled_incremental, render_scaled_rgb565_incremental,
};
pub use surface::{
    render_operation, render_surface, render_surface_regions, OperationResources, RasterRenderer,
};

pub const MAX_RENDER_SCALE: u32 = 4;
/// Integer clip rect: x0/y0 inclusive, x1/y1 exclusive.
#[derive(Clone, Copy)]
struct Clip {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl Clip {
    #[inline]
    fn intersect(&self, o: Clip) -> Clip {
        Clip {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }
}

// ---- word decoding -----------------------------------------------------------

#[inline]
fn xy(word: u32, scale: i32) -> (i32, i32) {
    let (x, y) = pocket_render::xy(word);
    (x * scale, y * scale)
}

#[inline]
fn wh(word: u32, scale: i32) -> (i32, i32) {
    let (width, height) = pocket_render::wh(word);
    (width * scale, height * scale)
}

#[inline]
fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}

#[inline]
fn pixel_bytes<const ARGB: bool>(r: u32, g: u32, b: u32) -> [u8; 4] {
    if ARGB {
        [b as u8, g as u8, r as u8, 255]
    } else {
        [r as u8, g as u8, b as u8, 255]
    }
}

/// Fill an opaque, whole-pixel byte span. Host framebuffers are in practice
/// at least 4-byte aligned, so the hot path emits one native word per pixel
/// instead of routing every pixel through alpha blending and four
/// bounds-checked stores. The byte fallback keeps the API valid for any slice.
#[inline]
fn fill_opaque_span<const ARGB: bool>(span: &mut [u8], r: u32, g: u32, b: u32) {
    debug_assert_eq!(span.len() & 3, 0);
    let bytes = pixel_bytes::<ARGB>(r, g, b);
    if (span.as_ptr() as usize) & 3 == 0 {
        let pixel = u32::from_ne_bytes(bytes);
        // SAFETY: alignment is checked above, the span length is a multiple
        // of four, and the temporary word slice covers exactly this span.
        let words = unsafe {
            core::slice::from_raw_parts_mut(span.as_mut_ptr().cast::<u32>(), span.len() / 4)
        };
        words.fill(pixel);
    } else {
        for px in span.as_chunks_mut::<4>().0.iter_mut() {
            px.copy_from_slice(&bytes);
        }
    }
}

// ---- pixel targets --------------------------------------------------------------

/// Opaque framebuffer target. `blend` performs integer src-over compositing;
/// concrete targets differ only in storage format.
///
/// The span methods write consecutive pixels of one row and equal one
/// `blend` call per pixel. A target maps the span to its storage once, so
/// the interpreter's loops pay no address arithmetic or format dispatch per
/// pixel.
trait RenderTarget {
    fn pixel_len(&self) -> usize;
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32);
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32);

    /// Blend one colour over `len` pixels from `start`.
    #[inline]
    fn blend_fill(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32, a: u32) {
        for offset in start..start + len {
            self.blend(offset, r, g, b, a);
        }
    }

    /// Blend `colors` (`r | g << 8 | b << 16 | a << 24`, the DrawList colour
    /// word) over the pixels from `start`.
    #[inline]
    fn blend_span(&mut self, start: usize, colors: &[u32]) {
        for (index, &color) in colors.iter().enumerate() {
            let (r, g, b, a) = channels(color);
            self.blend(start + index, r, g, b, a);
        }
    }

    #[inline]
    fn clear_black(&mut self) {
        let len = self.pixel_len();
        self.fill_opaque(0, len, 0, 0, 0);
    }
}

struct RgbaTarget<'a, const ARGB: bool> {
    bytes: &'a mut [u8],
}

/// `RgbaTarget::blend` on one pixel's bytes.
#[inline]
fn blend_rgba_pixel<const ARGB: bool>(pixel: &mut [u8; 4], r: u32, g: u32, b: u32, a: u32) {
    let (ri, gi, bi, ai) = if ARGB { (2, 1, 0, 3) } else { (0, 1, 2, 3) };
    if a >= 255 {
        pixel[ri] = r as u8;
        pixel[gi] = g as u8;
        pixel[bi] = b as u8;
        pixel[ai] = 255;
        return;
    }
    if a == 0 {
        return;
    }
    let ia = 255 - a;
    let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
    pixel[ri] = mix(r, pixel[ri]);
    pixel[gi] = mix(g, pixel[gi]);
    pixel[bi] = mix(b, pixel[bi]);
    pixel[ai] = 255;
}

impl<const ARGB: bool> RenderTarget for RgbaTarget<'_, ARGB> {
    #[inline]
    fn pixel_len(&self) -> usize {
        assert_eq!(
            self.bytes.len() & 3,
            0,
            "scaled framebuffer byte length must be a multiple of four"
        );
        self.bytes.len() / 4
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let o = offset * 4;
        let (ri, gi, bi, ai) = if ARGB { (2, 1, 0, 3) } else { (0, 1, 2, 3) };
        if a >= 255 {
            self.bytes[o + ri] = r as u8;
            self.bytes[o + gi] = g as u8;
            self.bytes[o + bi] = b as u8;
            self.bytes[o + ai] = 255;
            return;
        }
        if a == 0 {
            return;
        }
        let ia = 255 - a;
        let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
        self.bytes[o + ri] = mix(r, self.bytes[o + ri]);
        self.bytes[o + gi] = mix(g, self.bytes[o + gi]);
        self.bytes[o + bi] = mix(b, self.bytes[o + bi]);
        self.bytes[o + ai] = 255;
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let byte_start = start * 4;
        fill_opaque_span::<ARGB>(&mut self.bytes[byte_start..byte_start + len * 4], r, g, b);
    }

    #[inline]
    fn blend_fill(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32, a: u32) {
        let span = &mut self.bytes[start * 4..(start + len) * 4];
        for pixel in span.as_chunks_mut::<4>().0.iter_mut() {
            blend_rgba_pixel::<ARGB>(pixel, r, g, b, a);
        }
    }

    #[inline]
    fn blend_span(&mut self, start: usize, colors: &[u32]) {
        let span = &mut self.bytes[start * 4..(start + colors.len()) * 4];
        for (pixel, &color) in span.as_chunks_mut::<4>().0.iter_mut().zip(colors) {
            let (r, g, b, a) = channels(color);
            blend_rgba_pixel::<ARGB>(pixel, r, g, b, a);
        }
    }
}

/// RGBA8 target that keeps coverage. The colour bytes are premultiplied: they
/// follow the same integer src-over as [`RgbaTarget`] does over its black
/// clear, so they are the bytes that target writes. Alpha follows
/// `a + da × (1 − a)` with the same rounding.
struct PremultipliedTarget<'a> {
    bytes: &'a mut [u8],
}

/// `PremultipliedTarget::blend` on one pixel's bytes.
#[inline]
fn blend_premultiplied_pixel(pixel: &mut [u8; 4], r: u32, g: u32, b: u32, a: u32) {
    if a >= 255 {
        *pixel = [r as u8, g as u8, b as u8, 255];
        return;
    }
    if a == 0 {
        return;
    }
    let ia = 255 - a;
    let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
    pixel[0] = mix(r, pixel[0]);
    pixel[1] = mix(g, pixel[1]);
    pixel[2] = mix(b, pixel[2]);
    pixel[3] = mix(255, pixel[3]);
}

impl RenderTarget for PremultipliedTarget<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        assert_eq!(
            self.bytes.len() & 3,
            0,
            "scaled framebuffer byte length must be a multiple of four"
        );
        self.bytes.len() / 4
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let o = offset * 4;
        if a >= 255 {
            self.bytes[o] = r as u8;
            self.bytes[o + 1] = g as u8;
            self.bytes[o + 2] = b as u8;
            self.bytes[o + 3] = 255;
            return;
        }
        if a == 0 {
            return;
        }
        let ia = 255 - a;
        let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
        self.bytes[o] = mix(r, self.bytes[o]);
        self.bytes[o + 1] = mix(g, self.bytes[o + 1]);
        self.bytes[o + 2] = mix(b, self.bytes[o + 2]);
        self.bytes[o + 3] = mix(255, self.bytes[o + 3]);
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let byte_start = start * 4;
        fill_opaque_span::<false>(&mut self.bytes[byte_start..byte_start + len * 4], r, g, b);
    }

    #[inline]
    fn blend_fill(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32, a: u32) {
        let span = &mut self.bytes[start * 4..(start + len) * 4];
        for pixel in span.as_chunks_mut::<4>().0.iter_mut() {
            blend_premultiplied_pixel(pixel, r, g, b, a);
        }
    }

    #[inline]
    fn blend_span(&mut self, start: usize, colors: &[u32]) {
        let span = &mut self.bytes[start * 4..(start + colors.len()) * 4];
        for (pixel, &color) in span.as_chunks_mut::<4>().0.iter_mut().zip(colors) {
            let (r, g, b, a) = channels(color);
            blend_premultiplied_pixel(pixel, r, g, b, a);
        }
    }

    /// The clear of this target is transparent: nothing is covered yet.
    #[inline]
    fn clear_black(&mut self) {
        self.bytes.fill(0);
    }
}

struct Rgb565Target<'a> {
    pixels: &'a mut [u16],
}

/// A tightly packed RGB565 window whose pixels retain their coordinates in the
/// full viewport. The rasterizer continues to produce full-surface linear
/// offsets so gradient, glyph, texture, and triangle sampling keep their global
/// phase; this adapter maps those offsets into the compact backing slice.
struct Rgb565WindowTarget<'a> {
    pixels: &'a mut [u16],
    full_stride: usize,
    full_pixel_len: usize,
    origin_x: usize,
    origin_y: usize,
    width: usize,
    height: usize,
}

#[inline]
pub const fn pack_rgb565(r: u32, g: u32, b: u32) -> u16 {
    (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) as u16
}

#[inline]
fn unpack_rgb565(pixel: u16) -> (u32, u32, u32) {
    let r5 = (pixel as u32 >> 11) & 0x1f;
    let g6 = (pixel as u32 >> 5) & 0x3f;
    let b5 = pixel as u32 & 0x1f;
    (
        (r5 << 3) | (r5 >> 2),
        (g6 << 2) | (g6 >> 4),
        (b5 << 3) | (b5 >> 2),
    )
}

/// Blend one straight-alpha RGB888 source pixel over an RGB565 pixel. Shared
/// by the full-frame and compact-window targets so a strip render stays
/// bit-identical to the same window of a full render by construction.
#[inline]
/// Blend straight-alpha RGB over one RGB565 pixel with the rasterizer's arithmetic.
pub fn blend_rgb565_pixel(pixel: &mut u16, r: u32, g: u32, b: u32, a: u32) {
    if a >= 255 {
        *pixel = pack_rgb565(r, g, b);
        return;
    }
    if a == 0 {
        return;
    }
    let (dr, dg, db) = unpack_rgb565(*pixel);
    let ia = 255 - a;
    let mix = |s: u32, d: u32| (s * a + d * ia + 127) / 255;
    *pixel = pack_rgb565(mix(r, dr), mix(g, dg), mix(b, db));
}

impl RenderTarget for Rgb565Target<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        self.pixels.len()
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        blend_rgb565_pixel(&mut self.pixels[offset], r, g, b, a);
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        self.pixels[start..start + len].fill(pack_rgb565(r, g, b));
    }

    #[inline]
    fn blend_fill(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32, a: u32) {
        for pixel in &mut self.pixels[start..start + len] {
            blend_rgb565_pixel(pixel, r, g, b, a);
        }
    }

    #[inline]
    fn blend_span(&mut self, start: usize, colors: &[u32]) {
        for (pixel, &color) in self.pixels[start..start + colors.len()]
            .iter_mut()
            .zip(colors)
        {
            let (r, g, b, a) = channels(color);
            blend_rgb565_pixel(pixel, r, g, b, a);
        }
    }
}

impl Rgb565WindowTarget<'_> {
    #[inline]
    fn local_offset(&self, full_offset: usize) -> usize {
        let y = full_offset / self.full_stride;
        let x = full_offset % self.full_stride;
        assert!(
            x >= self.origin_x
                && x < self.origin_x + self.width
                && y >= self.origin_y
                && y < self.origin_y + self.height,
            "raster write escaped the compact RGB565 window"
        );
        (y - self.origin_y) * self.width + (x - self.origin_x)
    }

    /// `local_offset` of the first of `len` pixels that lie in one window row.
    #[inline]
    fn span_offset(&self, start: usize, len: usize) -> usize {
        let full_x = start % self.full_stride;
        let local = self.local_offset(start);
        assert!(
            len <= self.origin_x + self.width - full_x,
            "raster span crossed a compact RGB565 window row"
        );
        local
    }
}

impl RenderTarget for Rgb565WindowTarget<'_> {
    #[inline]
    fn pixel_len(&self) -> usize {
        // This is the virtual target length used by full-viewport coordinate
        // calculations. The actual compact slice is validated by the window
        // entry point below.
        self.full_pixel_len
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let offset = self.local_offset(offset);
        blend_rgb565_pixel(&mut self.pixels[offset], r, g, b, a);
    }

    #[inline]
    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        let full_x = start % self.full_stride;
        let local = self.local_offset(start);
        assert!(
            len <= self.origin_x + self.width - full_x,
            "raster span crossed a compact RGB565 window row"
        );
        self.pixels[local..local + len].fill(pack_rgb565(r, g, b));
    }

    #[inline]
    fn blend_fill(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32, a: u32) {
        if len == 0 {
            return;
        }
        let local = self.span_offset(start, len);
        for pixel in &mut self.pixels[local..local + len] {
            blend_rgb565_pixel(pixel, r, g, b, a);
        }
    }

    #[inline]
    fn blend_span(&mut self, start: usize, colors: &[u32]) {
        if colors.is_empty() {
            return;
        }
        let local = self.span_offset(start, colors.len());
        for (pixel, &color) in self.pixels[local..local + colors.len()]
            .iter_mut()
            .zip(colors)
        {
            let (r, g, b, a) = channels(color);
            blend_rgb565_pixel(pixel, r, g, b, a);
        }
    }
}

/// Fill an already-clipped span rect with one flat color.
fn fill_rect<T: RenderTarget>(target: &mut T, stride: i32, c: Clip, color: u32) {
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    if a >= 255 {
        let row_pixels = (c.x1 - c.x0) as usize;
        for y in c.y0..c.y1 {
            let start = (y * stride + c.x0) as usize;
            target.fill_opaque(start, row_pixels, r, g, b);
        }
        return;
    }
    let row_pixels = (c.x1 - c.x0) as usize;
    for y in c.y0..c.y1 {
        target.blend_fill((y * stride + c.x0) as usize, row_pixels, r, g, b, a);
    }
}

/// Integer lerp of two packed ABGR colors at f in `[0,1]` (round-to-nearest;
/// f itself is a deterministic f32 pixel-center fraction).
#[inline]
pub fn lerp_color(from: u32, to: u32, f: f32) -> u32 {
    let mix = |a: u32, b: u32| {
        let af = a as f32;
        (af + (b as f32 - af) * f + 0.5) as u32
    };
    let (fr, fg, fb_, fa) = channels(from);
    let (tr, tg, tb, ta) = channels(to);
    mix(fr, tr) | (mix(fg, tg) << 8) | (mix(fb_, tb) << 16) | (mix(fa, ta) << 24)
}

// ---- the interpreter --------------------------------------------------------------

/// Execute `words` into the UI's logical viewport at one sample per pixel.
/// The stock viewport remains 480x272, preserving the legacy golden output.
pub fn render(ui: &(impl RenderResources + ?Sized), words: &[u32], fb: &mut [u8]) {
    render_scaled(ui, words, fb, 1);
}

/// Execute `words` (a full DrawList) directly into an integer-scaled physical
/// surface. `fb` must contain exactly `viewport_width*scale ×
/// viewport_height*scale` RGBA8 pixels. Geometry, clips and gradient/triangle
/// sample points are evaluated at physical resolution; textures are sampled
/// over that destination and font coverage accounts for the atlas's own raster
/// density.
/// `ui` supplies font atlases and textures. The framebuffer is cleared to
/// opaque black first (the PSP host clears the draw buffer the same way).
pub fn render_scaled(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
) {
    let mut target = RgbaTarget::<false> { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Same as [`render_scaled`] but emits B,G,R,A bytes per pixel — the
/// little-endian in-memory layout of an ARGB8888 u32 word, for hosts that
/// present ARGB8888 directly. Byte-identical to shuffling the RGBA output,
/// but fused into the rasterizer so hosts skip a per-frame reorder copy.
/// Output determinism matches the RGBA path pixel-for-pixel; only the byte
/// placement differs.
pub fn render_scaled_argb(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
) {
    let mut target = RgbaTarget::<true> { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Execute `words` into an RGBA8 buffer that keeps coverage. `fb` has the size
/// [`render_scaled`] takes. The buffer is cleared to transparent first; each
/// pixel ends as premultiplied R,G,B and the alpha its ops accumulated:
/// 0 where the DrawList draws nothing, 255 under an opaque op. The R,G,B bytes
/// equal [`render_scaled`]'s for the same DrawList.
pub fn render_scaled_premultiplied(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
) {
    let mut target = PremultipliedTarget { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Execute a complete DrawList into a little-endian RGB565 framebuffer.
pub fn render_scaled_rgb565(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
) {
    let mut target = Rgb565Target { pixels: fb };
    render_scaled_impl(ui, words, &mut target, scale, true);
}

/// Execute DrawList words over an existing RGBA8 framebuffer without
/// clearing it. Render backends composite these into their own scene.
/// Uncovered pixels retain their original alpha; the clearing variants
/// paint the full-frame opaque-black background.
pub fn render_scaled_over(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
) {
    let mut target = RgbaTarget::<false> { bytes: fb };
    render_scaled_impl(ui, words, &mut target, scale, false);
}

/// Execute DrawList words over an existing RGB565 framebuffer without
/// clearing it. Hardware backends use this for ordered fallback segments.
pub fn render_scaled_rgb565_over(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
) {
    let mut target = Rgb565Target { pixels: fb };
    render_scaled_impl(ui, words, &mut target, scale, false);
}

/// Execute DrawList words over a tightly packed RGB565 sub-window without
/// clearing it.
///
/// `window` is expressed in global logical viewport coordinates with half-open
/// bounds. `fb` must contain exactly
/// `(window.width * scale) * (window.height * scale)` pixels. Raster sampling
/// remains anchored to the full viewport; only storage is translated to the
/// compact window. Hardware backends use this for ordered software fallback
/// while rendering a dirty strip.
pub fn render_scaled_rgb565_window_over(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
    window: DamageRect,
) {
    assert!(
        (1..=MAX_RENDER_SCALE).contains(&scale),
        "render scale must be 1 through 4"
    );
    let scale_i = scale as i32;
    let (viewport_w, viewport_h) = ui.viewport();
    let logical_screen = DamageRect::new(0, 0, viewport_w as i32, viewport_h as i32);
    assert!(
        !window.is_empty() && window.intersect(logical_screen) == window,
        "compact RGB565 window must be non-empty and inside the viewport"
    );

    let full_width = logical_screen.x1 * scale_i;
    let full_height = logical_screen.y1 * scale_i;
    let physical = Clip {
        x0: window.x0 * scale_i,
        y0: window.y0 * scale_i,
        x1: window.x1 * scale_i,
        y1: window.y1 * scale_i,
    };
    let width = (physical.x1 - physical.x0) as usize;
    let height = (physical.y1 - physical.y0) as usize;
    assert_eq!(
        fb.len(),
        width * height,
        "compact RGB565 window has the wrong pixel length"
    );

    let mut target = Rgb565WindowTarget {
        pixels: fb,
        full_stride: full_width as usize,
        full_pixel_len: full_width as usize * full_height as usize,
        origin_x: physical.x0 as usize,
        origin_y: physical.y0 as usize,
        width,
        height,
    };
    render_scaled_clipped(ui, words, &mut target, full_width, scale_i, physical);
}

/// Clear and repaint only the supplied logical damage rectangles into an
/// existing RGBA8 framebuffer.
///
/// Each region replays the complete DrawList under an additional root clip,
/// preserving painter order for unchanged translucent operations.
pub fn render_scaled_regions(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    regions: &[DamageRect],
) {
    let mut target = RgbaTarget::<false> { bytes: fb };
    render_scaled_regions_impl(ui, words, &mut target, scale, regions);
}

/// ARGB/BGRA-memory equivalent of [`render_scaled_regions`].
pub fn render_scaled_argb_regions(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    regions: &[DamageRect],
) {
    let mut target = RgbaTarget::<true> { bytes: fb };
    render_scaled_regions_impl(ui, words, &mut target, scale, regions);
}

/// RGB565 equivalent of [`render_scaled_regions`].
pub fn render_scaled_rgb565_regions(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
    regions: &[DamageRect],
) {
    let mut target = Rgb565Target { pixels: fb };
    render_scaled_regions_impl(ui, words, &mut target, scale, regions);
}

fn render_scaled_impl<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    target: &mut T,
    scale: u32,
    clear: bool,
) {
    let (width, _height, screen) = target_geometry(ui, target, scale);
    if clear {
        target.clear_black();
    }
    render_scaled_clipped(ui, words, target, width, scale as i32, screen);
}

fn render_scaled_regions_impl<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    target: &mut T,
    scale: u32,
    regions: &[DamageRect],
) {
    let (width, height, screen) = target_geometry(ui, target, scale);
    render_damage_regions(
        ui,
        words,
        target,
        width,
        height,
        scale as i32,
        screen,
        regions,
    );
}

fn target_geometry<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    target: &T,
    scale: u32,
) -> (i32, i32, Clip) {
    let (width, height) = validate_framebuffer(ui, target.pixel_len(), scale);
    let screen = Clip {
        x0: 0,
        y0: 0,
        x1: width,
        y1: height,
    };
    (width, height, screen)
}

/// Validate a tightly packed framebuffer and return its physical dimensions.
/// Presentation uses this before planning damage, preserving the raster API's
/// validation order. `pixel_count` counts pixels rather than bytes.
///
/// # Panics
/// Panics for scales outside 1 through 4, nonpositive viewport dimensions, or
/// a pixel count that does not match the scaled viewport.
pub fn validate_framebuffer(
    ui: &(impl RenderResources + ?Sized),
    pixel_count: usize,
    scale: u32,
) -> (i32, i32) {
    assert!(
        (1..=MAX_RENDER_SCALE).contains(&scale),
        "render scale must be 1 through 4"
    );
    let scale = scale as i32;
    let (viewport_w, viewport_h) = ui.viewport();
    let width = viewport_w as i32 * scale;
    let height = viewport_h as i32 * scale;
    assert!(
        width > 0 && height > 0,
        "viewport must have positive dimensions"
    );
    let expected = width as usize * height as usize;
    assert_eq!(
        pixel_count, expected,
        "scaled framebuffer has the wrong pixel count"
    );
    (width, height)
}

#[allow(clippy::too_many_arguments)]
fn render_damage_regions<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    target: &mut T,
    width: i32,
    height: i32,
    scale: i32,
    screen: Clip,
    regions: &[DamageRect],
) {
    let logical_screen = DamageRect::new(0, 0, width / scale, height / scale);
    for &region in regions {
        let region = region.intersect(logical_screen);
        if region.is_empty() {
            continue;
        }
        let physical = Clip {
            x0: region.x0 * scale,
            y0: region.y0 * scale,
            x1: region.x1 * scale,
            y1: region.y1 * scale,
        }
        .intersect(screen);
        if physical.x0 >= physical.x1 || physical.y0 >= physical.y1 {
            continue;
        }
        clear_black_rect(target, width, physical);
        render_scaled_clipped(ui, words, target, width, scale, physical);
    }
}

fn clear_black_rect<T: RenderTarget>(target: &mut T, stride: i32, rect: Clip) {
    let row_pixels = (rect.x1 - rect.x0) as usize;
    for y in rect.y0..rect.y1 {
        let start = (y * stride + rect.x0) as usize;
        target.fill_opaque(start, row_pixels, 0, 0, 0);
    }
}

fn render_scaled_clipped<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    words: &[u32],
    target: &mut T,
    width: i32,
    scale: i32,
    screen: Clip,
) {
    let mut stack: [Clip; 32] = [screen; 32];
    let mut depth: usize = 0;
    let mut clip = screen;

    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            draw_op::RECT => {
                if i + 4 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                let c = clip.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                if c.x0 < c.x1 && c.y0 < c.y1 {
                    fill_rect(target, width, c, words[i + 3]);
                }
                i += 4;
            }
            draw_op::GRAD_RECT => {
                if i + 6 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                grad_rect(
                    target,
                    width,
                    clip,
                    x,
                    y,
                    w,
                    h,
                    words[i + 3],
                    words[i + 4],
                    words[i + 5],
                );
                i += 6;
            }
            draw_op::GLYPH_RUN => {
                if i + 3 > words.len() {
                    return;
                }
                let slot = (words[i + 1] & 0xff) as u8;
                let n = (words[i + 1] >> 16) as usize;
                let color = words[i + 2];
                if i + 3 + 2 * n > words.len() {
                    return;
                }
                glyph_run(
                    ui,
                    target,
                    width,
                    scale,
                    clip,
                    slot,
                    color,
                    &words[i + 3..i + 3 + 2 * n],
                );
                i += 3 + 2 * n;
            }
            draw_op::TEX_QUAD => {
                if i + 9 > words.len() {
                    return;
                }
                tex_quad(ui, target, width, scale, clip, &words[i + 1..i + 9]);
                i += 9;
            }
            draw_op::SCISSOR => {
                if i + 3 > words.len() || depth >= stack.len() {
                    return;
                }
                stack[depth] = clip;
                depth += 1;
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                // The core emits scissor rects already intersected with every
                // enclosing scissor — SET (still guard against the screen).
                clip = screen.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                i += 3;
            }
            draw_op::SCISSOR_POP => {
                if depth > 0 {
                    depth -= 1;
                    clip = stack[depth];
                } else {
                    clip = screen;
                }
                i += 1;
            }
            draw_op::TRI => {
                if i + 7 > words.len() {
                    return;
                }
                tri(target, width, scale, clip, &words[i + 1..i + 7]);
                i += 7;
            }
            draw_op::TEX_TRI => {
                if i + 12 > words.len() {
                    return;
                }
                tex_tri(ui, target, width, scale, clip, &words[i + 1..i + 12]);
                i += 12;
            }
            draw_op::TEXT_RUN => {
                // Native-text op (host text system shapes the run); the
                // software rasterizer has no shaper, so hosts that raster run
                // with baked measurement and never receive it. Skipped, not a
                // stop: the op is a known member of the closed set. Variable
                // length: 8 header words + the packed UTF-8 payload.
                if i + 8 > words.len() {
                    return;
                }
                let payload = (words[i + 7] as usize).div_ceil(4);
                i += 8 + payload;
            }
            // The op set is closed per DrawList version; anything else means
            // corrupt data — stop instead of misinterpreting the stream.
            _ => return,
        }
    }
}

// ---- GRAD_RECT: per-axis gouraud lerp ---------------------------------------------

/// Pixels the interpreter shades into a stack buffer before one
/// `RenderTarget::blend_span` call.
const SPAN: usize = 64;

#[allow(clippy::too_many_arguments)]
fn grad_rect<T: RenderTarget>(
    target: &mut T,
    stride: i32,
    clip: Clip,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    from: u32,
    to: u32,
    dir: u32,
) {
    if w <= 0 || h <= 0 {
        return;
    }
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let horizontal = dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32;
    // "from" sits at the axis start for ToBottom/ToRight, at the axis end for
    // ToTop/ToLeft (matches core draw.rs corner_color()).
    let reversed = dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32;
    let (a, b) = if reversed { (to, from) } else { (from, to) };
    if horizontal {
        // One colour per column: shade a band of columns once, then blend
        // it over every row. A colour without alpha blends nothing.
        let inv = 1.0f32 / w as f32;
        let mut colors = [0u32; SPAN];
        let mut band = c.x0;
        while band < c.x1 {
            let count = ((c.x1 - band) as usize).min(SPAN);
            for (index, color) in colors[..count].iter_mut().enumerate() {
                let px = band + index as i32;
                let f = ((px - x) as f32 + 0.5) * inv;
                *color = lerp_color(a, b, f);
            }
            for py in c.y0..c.y1 {
                target.blend_span((py * stride + band) as usize, &colors[..count]);
            }
            band += count as i32;
        }
    } else {
        let inv = 1.0f32 / h as f32;
        let row_pixels = (c.x1 - c.x0) as usize;
        for py in c.y0..c.y1 {
            let f = ((py - y) as f32 + 0.5) * inv;
            let col = lerp_color(a, b, f);
            let (r, g, bb, al) = channels(col);
            if al == 0 {
                continue;
            }
            let start = (py * stride + c.x0) as usize;
            if al >= 255 {
                target.fill_opaque(start, row_pixels, r, g, bb);
                continue;
            }
            target.blend_fill(start, row_pixels, r, g, bb, al);
        }
    }
}

// ---- TRI: barycentric gouraud fill --------------------------------------------------

/// Exact integer edge function at doubled coordinates:
/// cross(b - a, p - a) where all inputs are 2x integer screen coords.
#[inline]
fn orient(ax: i64, ay: i64, bx: i64, by: i64, px: i64, py: i64) -> i64 {
    (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/// Smallest edge weight a covered pixel centre may have on edge `u -> v` of a
/// counter-clockwise triangle (top-left rule): 0 on a left edge (the weight
/// grows with x) or a top edge (horizontal, the weight grows with y), 1 on
/// every other edge. A centre exactly on an edge shared by two triangles is
/// covered by one of them, so a fanned quad blends each pixel once.
#[inline]
fn edge_bias(u: (i64, i64), v: (i64, i64)) -> i64 {
    let left = v.1 < u.1;
    let top = v.1 == u.1 && v.0 > u.0;
    if left || top {
        0
    } else {
        1
    }
}

/// `n / d` for `n >= 0` and `d > 0`. Operands that fit 32 bits divide as
/// such: a 32-bit target has no 64-bit divide instruction.
#[inline]
fn div_nonnegative(n: i64, d: i64) -> i64 {
    if n <= u32::MAX as i64 && d <= u32::MAX as i64 {
        (n as u32 / d as u32) as i64
    } else {
        n / d
    }
}

/// Exact covered interval on one pixel row of a counter-clockwise triangle.
/// Each doubled-coordinate edge is linear in x. Intersect the half-line where
/// it reaches its `edge_bias` with the clip, then advance the original integer
/// weights by addition. Thin rotated images no longer scan their whole
/// bounding box.
struct TriangleRow {
    x: i32,
    end: i32,
    weights: [i64; 3],
    step: [i64; 3],
}

impl TriangleRow {
    fn new(a: (i64, i64), b: (i64, i64), c: (i64, i64), y: i32, min_x: i32, max_x: i32) -> Self {
        let sx = 2 * min_x as i64 + 1;
        let sy = 2 * y as i64 + 1;
        let weights = [
            orient(b.0, b.1, c.0, c.1, sx, sy),
            orient(c.0, c.1, a.0, a.1, sx, sy),
            orient(a.0, a.1, b.0, b.1, sx, sy),
        ];
        let step = [-2 * (c.1 - b.1), -2 * (a.1 - c.1), -2 * (b.1 - a.1)];
        let bias = [edge_bias(b, c), edge_bias(c, a), edge_bias(a, b)];
        Self::from_weights(weights, step, bias, min_x, max_x)
    }

    /// The row whose edge weights at the centre of pixel `min_x` are
    /// `weights` and change by `step` per pixel; a covered centre has at
    /// least `bias` on every edge.
    fn from_weights(
        mut weights: [i64; 3],
        step: [i64; 3],
        bias: [i64; 3],
        min_x: i32,
        max_x: i32,
    ) -> Self {
        let mut first = 0i64;
        let mut end = (max_x as i64 - min_x as i64).max(0);
        for ((&w, &dx), &bias) in weights.iter().zip(&step).zip(&bias) {
            if dx > 0 {
                if w < bias {
                    // bias - w >= 1: the numerator is positive.
                    first = first.max(div_nonnegative(bias - w + dx - 1, dx));
                }
            } else if dx < 0 {
                if w < bias {
                    end = 0;
                } else {
                    end = end.min(div_nonnegative(w - bias, -dx) + 1);
                }
            } else if w < bias {
                end = 0;
            }
        }
        if first >= end {
            return Self {
                x: min_x,
                end: min_x,
                weights,
                step,
            };
        }
        for (w, &dx) in weights.iter_mut().zip(&step) {
            *w += first * dx;
        }
        Self {
            x: min_x + first as i32,
            end: min_x + end as i32,
            weights,
            step,
        }
    }
}

impl Iterator for TriangleRow {
    type Item = (i32, [i64; 3]);
    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.x >= self.end {
            return None;
        }
        let item = (self.x, self.weights);
        self.x += 1;
        for (w, &dx) in self.weights.iter_mut().zip(&self.step) {
            *w += dx;
        }
        Some(item)
    }
}

/// The rows of one triangle from a first row down. An edge function is
/// linear in y as in x, so the weights at the clip's first column advance
/// from row to row by one addition each. The `edge_bias` of an edge is the
/// same on every row.
struct TriangleRows {
    weights: [i64; 3],
    step: [i64; 3],
    row_step: [i64; 3],
    bias: [i64; 3],
    min_x: i32,
    max_x: i32,
}

impl TriangleRows {
    fn new(a: (i64, i64), b: (i64, i64), c: (i64, i64), y: i32, min_x: i32, max_x: i32) -> Self {
        let sx = 2 * min_x as i64 + 1;
        let sy = 2 * y as i64 + 1;
        Self {
            weights: [
                orient(b.0, b.1, c.0, c.1, sx, sy),
                orient(c.0, c.1, a.0, a.1, sx, sy),
                orient(a.0, a.1, b.0, b.1, sx, sy),
            ],
            step: [-2 * (c.1 - b.1), -2 * (a.1 - c.1), -2 * (b.1 - a.1)],
            row_step: [2 * (c.0 - b.0), 2 * (a.0 - c.0), 2 * (b.0 - a.0)],
            bias: [edge_bias(b, c), edge_bias(c, a), edge_bias(a, b)],
            min_x,
            max_x,
        }
    }

    /// The covered interval of the current row; moves to the row below.
    #[inline]
    fn next_row(&mut self) -> TriangleRow {
        let row = TriangleRow::from_weights(
            self.weights,
            self.step,
            self.bias,
            self.min_x,
            self.max_x,
        );
        for (w, &dy) in self.weights.iter_mut().zip(&self.row_step) {
            *w += dy;
        }
        row
    }
}

fn tri<T: RenderTarget>(target: &mut T, stride: i32, scale: i32, clip: Clip, p: &[u32]) {
    let (x0, y0) = xy(p[0], scale);
    let (x1, y1) = xy(p[1], scale);
    let (x2, y2) = xy(p[2], scale);
    let c0 = p[3];
    let (mut c1, mut c2) = (p[4], p[5]);
    // Doubled coords: vertices at 2*v, sample points at 2*px+1 (pixel center).
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        // Wind CCW-positive so all edge functions share the sign of `area`.
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut c1, &mut c2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (r0, g0, b0, a0) = channels(c0);
    let (r1, g1, b1, a1) = channels(c1);
    let (r2, g2, b2, a2) = channels(c2);
    let flat = c0 == c1 && c1 == c2;
    let half = area / 2;
    let mut rows = TriangleRows::new((ax, ay), (bx, by), (cx, cy), min_y, min_x, max_x);
    if flat {
        // One colour: every covered row is one span.
        if a0 == 0 {
            return;
        }
        for py in min_y..max_y {
            let row = rows.next_row();
            if row.x >= row.end {
                continue;
            }
            let start = (py * stride + row.x) as usize;
            let len = (row.end - row.x) as usize;
            if a0 >= 255 {
                target.fill_opaque(start, len, r0, g0, b0);
            } else {
                target.blend_fill(start, len, r0, g0, b0, a0);
            }
        }
        return;
    }
    // Integer barycentric interpolation, round-to-nearest:
    // (v0*w0 + v1*w1 + v2*w2 + half) / area per channel. A covered centre
    // has every weight at or above its `edge_bias` (0 or 1), so the weights
    // are nonnegative, and they sum to `area`: the numerator is at most
    // 255 * area + half. When that fits 32 bits (every triangle below
    // two million pixels) the numerators step by addition along the row
    // and divide as u32: the same quotients without 64-bit arithmetic.
    if area <= (u32::MAX as i64 - half) / 255 {
        let (area, half) = (area as u32, half as u32);
        let channel = [(r0, r1, r2), (g0, g1, g2), (b0, b1, b2), (a0, a1, a2)];
        let step = rows.step;
        let numerator_step = channel.map(|(v0, v1, v2)| {
            (v0 as i64 * step[0] + v1 as i64 * step[1] + v2 as i64 * step[2]) as u32
        });
        let mut colors = [0u32; SPAN];
        for py in min_y..max_y {
            let row = rows.next_row();
            if row.x >= row.end {
                // The weights of a row without a covered pixel are not
                // barycentric.
                continue;
            }
            let [w0, w1, w2] = row.weights.map(|w| w as u32);
            let mut numerator =
                channel.map(|(v0, v1, v2)| v0 * w0 + v1 * w1 + v2 * w2 + half);
            let mut px = row.x;
            while px < row.end {
                let count = ((row.end - px) as usize).min(SPAN);
                for color in &mut colors[..count] {
                    *color = (numerator[0] / area)
                        | ((numerator[1] / area) << 8)
                        | ((numerator[2] / area) << 16)
                        | ((numerator[3] / area) << 24);
                    for (n, &step) in numerator.iter_mut().zip(&numerator_step) {
                        *n = n.wrapping_add(step);
                    }
                }
                target.blend_span((py * stride + px) as usize, &colors[..count]);
                px += count as i32;
            }
        }
        return;
    }
    for py in min_y..max_y {
        for (px, [w0, w1, w2]) in rows.next_row() {
            let mix = |v0: u32, v1: u32, v2: u32| {
                ((v0 as i64 * w0 + v1 as i64 * w1 + v2 as i64 * w2 + half) / area) as u32
            };
            target.blend(
                (py * stride + px) as usize,
                mix(r0, r1, r2),
                mix(g0, g1, g2),
                mix(b0, b1, b2),
                mix(a0, a1, a2),
            );
        }
    }
}

// ---- GLYPH_RUN: coverage atlas cells -----------------------------------------------

/// Map a scaled destination pixel (relative to its glyph cell origin) to the
/// atlas coverage row/column it samples. Shared with hardware DrawList
/// backends so their glyph masks reproduce the software fallback exactly.
#[inline]
pub fn coverage_index(
    destination_px: i32,
    output_scale: i32,
    atlas_density: i32,
    limit: i32,
) -> usize {
    // Nearest-neighbour at destination pixel centers. This is identical to a
    // 1:1 lookup when output_scale == atlas_density, duplicates coverage when
    // the output is denser, and samples the center of each source interval
    // when a high-density atlas is rendered onto a lower-density surface.
    ((((2 * destination_px + 1) * atlas_density) / (2 * output_scale)).clamp(0, limit - 1)) as usize
}

#[allow(clippy::too_many_arguments)]
fn glyph_run<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    target: &mut T,
    stride: i32,
    output_scale: i32,
    clip: Clip,
    slot: u8,
    color: u32,
    glyphs: &[u32],
) {
    let Some(atlas) = ui.font_atlas(slot) else {
        return;
    };
    let (_, _, _, a) = channels(color);
    if a == 0 {
        return;
    }
    let rgb = color & 0x00ff_ffff;
    let cell_w = atlas.cell_w as i32 * output_scale;
    let cell_h = atlas.cell_h as i32 * output_scale;
    let atlas_density = atlas.raster_density as i32;
    let coverage_w = atlas.coverage_width() as i32;
    let coverage_h = atlas.coverage_height() as i32;
    let bpr = atlas.bytes_per_row();
    let mut columns = [0usize; SPAN];
    let mut colors = [0u32; SPAN];
    for pair in glyphs.as_chunks::<2>().0.iter() {
        let (gx, gy) = xy(pair[0], output_scale);
        let gid = (pair[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        // Cell-vs-clip pixel window (partial glyphs at scissor edges clip here).
        let x0 = gx.max(clip.x0);
        let x1 = (gx + cell_w).min(clip.x1);
        let y0 = gy.max(clip.y0);
        let y1 = (gy + cell_h).min(clip.y1);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        let rows = atlas.glyph_rows(gid);
        // The coverage column of a pixel is the same on every row: look a
        // band of columns up once, then shade and blend it row by row.
        let mut band = x0;
        while band < x1 {
            let count = ((x1 - band) as usize).min(SPAN);
            for (index, column) in columns[..count].iter_mut().enumerate() {
                let px = band + index as i32;
                *column = coverage_index(px - gx, output_scale, atlas_density, coverage_w);
            }
            for py in y0..y1 {
                let sy = coverage_index(py - gy, output_scale, atlas_density, coverage_h);
                let row = &rows[sy * bpr..];
                for (color, &cx) in colors[..count].iter_mut().zip(&columns[..count]) {
                    let cov = row[cx] as u32;
                    // No coverage leaves the alpha at zero: nothing blends.
                    *color = if cov != 0 {
                        rgb | (((a * cov + 127) / 255) << 24)
                    } else {
                        0
                    };
                }
                target.blend_span((py * stride + band) as usize, &colors[..count]);
            }
            band += count as i32;
        }
    }
}

// ---- texel fetch + samplers ----------------------------------------------------------

/// Fetch texel `idx` (row-major) as (r, g, b, a) channels 0..255. None for
/// an unknown psm (corrupt stream — callers abort the op, matching the old
/// inline `_ => return` arms byte-for-byte on the known formats).
#[inline]
pub fn texel(view: &TexView, idx: usize) -> Option<(u32, u32, u32, u32)> {
    match view.psm {
        spec::psm::PSM_5650 => {
            // PSP PSM 5650: u16 LE, B5:G6:R5 (red in the low bits). Always
            // opaque — there is no alpha channel to expand.
            let o = idx * 2;
            let px16 = view.pixels[o] as u32 | ((view.pixels[o + 1] as u32) << 8);
            let r5 = px16 & 0x1f;
            let g6 = (px16 >> 5) & 0x3f;
            let b5 = (px16 >> 11) & 0x1f;
            Some((
                (r5 << 3) | (r5 >> 2),
                (g6 << 2) | (g6 >> 4),
                (b5 << 3) | (b5 >> 2),
                255,
            ))
        }
        spec::psm::PSM_8888 => {
            let o = idx * 4;
            Some((
                view.pixels[o] as u32,
                view.pixels[o + 1] as u32,
                view.pixels[o + 2] as u32,
                view.pixels[o + 3] as u32,
            ))
        }
        spec::psm::PSM_4444 => {
            // u16 LE, nibbles A<<12 | B<<8 | G<<4 | R; expand n -> n*17.
            let o = idx * 2;
            let px16 = view.pixels[o] as u32 | ((view.pixels[o + 1] as u32) << 8);
            Some((
                (px16 & 0xf) * 17,
                ((px16 >> 4) & 0xf) * 17,
                ((px16 >> 8) & 0xf) * 17,
                ((px16 >> 12) & 0xf) * 17,
            ))
        }
        spec::psm::PSM_T8 => {
            // CLUT8: one palette index/px; palette bytes are RGBA in memory
            // (same byte order as 8888 pixels). Index * 4 <= 1020 < 1024, so
            // the lookup can never leave the 1024-byte CLUT.
            let pal = view.palette?;
            let o = view.pixels[idx] as usize * 4;
            Some((
                pal[o] as u32,
                pal[o + 1] as u32,
                pal[o + 2] as u32,
                pal[o + 3] as u32,
            ))
        }
        _ => None,
    }
}

/// Coordinate selection shared by software and hardware-assisted texture
/// paths. Texel coordinates are 24.8 fixed point centered on texel centers
/// (`uf = u*w*256 - 128`). Clamp the base coordinate before selecting its
/// second neighbor so every backend preserves the core's edge sampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinearSample {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    pub fx: u32,
    pub fy: u32,
}

#[inline]
pub fn linear_sample_coordinates(width: u32, height: u32, u: f32, v: f32) -> Option<LinearSample> {
    if width == 0 || height == 0 {
        return None;
    }
    let (tw_max, th_max) = (width as i32 - 1, height as i32 - 1);
    let uf = (u * width as f32 * 256.0) as i32 - 128;
    let vf = (v * height as f32 * 256.0) as i32 - 128;
    let x0 = (uf >> 8).clamp(0, tw_max);
    let y0 = (vf >> 8).clamp(0, th_max);
    Some(LinearSample {
        x0: x0 as u32,
        y0: y0 as u32,
        x1: (x0 + 1).min(tw_max) as u32,
        y1: (y0 + 1).min(th_max) as u32,
        fx: (uf & 255) as u32,
        fy: (vf & 255) as u32,
    })
}

/// Deterministic integer bilinear sample at normalized (u, v). The four
/// clamp-addressed neighbors blend with 8-bit weights, horizontal first then
/// vertical — integer math only, so byte-exact on every host.
#[inline]
fn sample_linear(view: &TexView, u: f32, v: f32) -> Option<(u32, u32, u32, u32)> {
    let sample = linear_sample_coordinates(view.w, view.h, u, v)?;
    let w = view.w as usize;
    let c00 = texel(view, sample.y0 as usize * w + sample.x0 as usize)?;
    let c01 = texel(view, sample.y0 as usize * w + sample.x1 as usize)?;
    let c10 = texel(view, sample.y1 as usize * w + sample.x0 as usize)?;
    let c11 = texel(view, sample.y1 as usize * w + sample.x1 as usize)?;
    let lerp8 = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let mix = |c0: u32, c1: u32, c2: u32, c3: u32| {
        lerp8(
            lerp8(c0, c1, sample.fx),
            lerp8(c2, c3, sample.fx),
            sample.fy,
        )
    };
    Some((
        mix(c00.0, c01.0, c10.0, c11.0),
        mix(c00.1, c01.1, c10.1, c11.1),
        mix(c00.2, c01.2, c10.2, c11.2),
        mix(c00.3, c01.3, c10.3, c11.3),
    ))
}

// ---- validated views: one fetch per pixel format ----------------------------------

/// The storage of a view whose every texel has its bytes: the loops below
/// fetch without the per-texel format match of [`texel`], and no fetch can
/// leave the storage. Other views take the per-pixel loops, which keep the
/// behaviour of [`texel`] for them.
#[derive(Clone, Copy)]
enum Texels<'a> {
    Rgb565(&'a [u8]),
    Rgba8888(&'a [u8]),
    Rgba4444(&'a [u8]),
    Indexed(&'a [u8], &'a [u8]),
}

impl<'a> Texels<'a> {
    /// None for an unknown format, a view without texels, T8 without a
    /// whole palette, more texels than an `i32` index reaches, or fewer
    /// bytes than `w * h` texels need.
    fn new(view: &TexView<'a>) -> Option<Self> {
        let texels = (view.w as usize).checked_mul(view.h as usize)?;
        if texels == 0 || texels > i32::MAX as usize {
            return None;
        }
        let holds = |bytes_per_texel: usize| {
            texels
                .checked_mul(bytes_per_texel)
                .is_some_and(|bytes| bytes <= view.pixels.len())
        };
        match view.psm {
            spec::psm::PSM_5650 if holds(2) => Some(Self::Rgb565(view.pixels)),
            spec::psm::PSM_8888 if holds(4) => Some(Self::Rgba8888(view.pixels)),
            spec::psm::PSM_4444 if holds(2) => Some(Self::Rgba4444(view.pixels)),
            spec::psm::PSM_T8 if holds(1) => {
                let palette = view.palette.filter(|palette| palette.len() >= 1024)?;
                Some(Self::Indexed(view.pixels, palette))
            }
            _ => None,
        }
    }
}

/// Texel `index` (row-major) as a packed colour, `r | g << 8 | b << 16 |
/// a << 24`: the channels [`texel`] returns for the format.
trait Fetch: Copy {
    fn fetch(self, index: usize) -> u32;
}

#[derive(Clone, Copy)]
struct FetchRgb565<'a>(&'a [u8]);
#[derive(Clone, Copy)]
struct FetchRgba8888<'a>(&'a [u8]);
#[derive(Clone, Copy)]
struct FetchRgba4444<'a>(&'a [u8]);
#[derive(Clone, Copy)]
struct FetchIndexed<'a>(&'a [u8], &'a [u8]);

impl Fetch for FetchRgb565<'_> {
    #[inline(always)]
    fn fetch(self, index: usize) -> u32 {
        let texel = &self.0[index * 2..index * 2 + 2];
        let px16 = texel[0] as u32 | ((texel[1] as u32) << 8);
        let r5 = px16 & 0x1f;
        let g6 = (px16 >> 5) & 0x3f;
        let b5 = (px16 >> 11) & 0x1f;
        ((r5 << 3) | (r5 >> 2))
            | (((g6 << 2) | (g6 >> 4)) << 8)
            | (((b5 << 3) | (b5 >> 2)) << 16)
            | (255 << 24)
    }
}

impl Fetch for FetchRgba8888<'_> {
    #[inline(always)]
    fn fetch(self, index: usize) -> u32 {
        let texel = &self.0[index * 4..index * 4 + 4];
        u32::from_le_bytes([texel[0], texel[1], texel[2], texel[3]])
    }
}

impl Fetch for FetchRgba4444<'_> {
    #[inline(always)]
    fn fetch(self, index: usize) -> u32 {
        let texel = &self.0[index * 2..index * 2 + 2];
        let px16 = texel[0] as u32 | ((texel[1] as u32) << 8);
        ((px16 & 0xf) * 17)
            | ((((px16 >> 4) & 0xf) * 17) << 8)
            | ((((px16 >> 8) & 0xf) * 17) << 16)
            | ((((px16 >> 12) & 0xf) * 17) << 24)
    }
}

impl Fetch for FetchIndexed<'_> {
    #[inline(always)]
    fn fetch(self, index: usize) -> u32 {
        let entry = self.0[index] as usize * 4;
        let color = &self.1[entry..entry + 4];
        u32::from_le_bytes([color[0], color[1], color[2], color[3]])
    }
}

/// Run `$body` with `$fetch` bound to the fetch of `$texels`' format: one
/// copy of the loop per format, selected once per operation.
macro_rules! with_fetch {
    ($texels:expr, $fetch:ident => $body:expr) => {
        match $texels {
            Texels::Rgb565(pixels) => {
                let $fetch = FetchRgb565(pixels);
                $body
            }
            Texels::Rgba8888(pixels) => {
                let $fetch = FetchRgba8888(pixels);
                $body
            }
            Texels::Rgba4444(pixels) => {
                let $fetch = FetchRgba4444(pixels);
                $body
            }
            Texels::Indexed(pixels, palette) => {
                let $fetch = FetchIndexed(pixels, palette);
                $body
            }
        }
    };
}

/// The blend of [`sample_linear`] over four fetched neighbours. Two
/// channels share a word, eight bits apart: `a * (256 - f) + b * f` is at
/// most 255 * 256, so no lane carries into the next.
#[inline(always)]
fn lerp_neighbours(c00: u32, c01: u32, c10: u32, c11: u32, fx: u32, fy: u32) -> u32 {
    const LANES: u32 = 0x00ff_00ff;
    let lerp = |a: u32, b: u32, f: u32| ((a * (256 - f) + b * f) >> 8) & LANES;
    let mix = |shift: u32| {
        lerp(
            lerp((c00 >> shift) & LANES, (c01 >> shift) & LANES, fx),
            lerp((c10 >> shift) & LANES, (c11 >> shift) & LANES, fx),
            fy,
        )
    };
    mix(0) | (mix(8) << 8)
}

/// The integer modulate of TEX_QUAD and TEX_TRI, round-to-nearest, on every
/// colour of a shaded span.
#[inline]
fn modulate_span(colors: &mut [u32], [mr, mg, mb, ma]: [u32; 4]) {
    for color in colors {
        let (r, g, b, a) = channels(*color);
        *color = ((r * mr + 127) / 255)
            | (((g * mg + 127) / 255) << 8)
            | (((b * mb + 127) / 255) << 16)
            | (((a * ma + 127) / 255) << 24);
    }
}

// ---- TEX_TRI: barycentric textured triangle (affine UV; nearest, or integer
//      bilinear when the texture carries the linear flag) --------------------

fn tex_tri<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    target: &mut T,
    stride: i32,
    scale: i32,
    clip: Clip,
    p: &[u32],
) {
    let handle = p[0] as i32;
    let (x0, y0) = xy(p[1], scale);
    let (u0, v0) = (f32::from_bits(p[2]), f32::from_bits(p[3]));
    let (x1, y1) = xy(p[4], scale);
    let (mut u1, mut v1) = (f32::from_bits(p[5]), f32::from_bits(p[6]));
    let (x2, y2) = xy(p[7], scale);
    let (mut u2, mut v2) = (f32::from_bits(p[8]), f32::from_bits(p[9]));
    let modulate = p[10];
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut u1, &mut u2);
        core::mem::swap(&mut v1, &mut v2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_area = 1.0f32 / area as f32;
    // Covered weights are in 0..=area. The narrow conversion has the same
    // IEEE-754 result and avoids software i64-to-f32 helpers on Cortex-M.
    let narrow = area <= i32::MAX as i64;
    if narrow {
        if let Some(texels) = Texels::new(&view) {
            // The common case: shade each covered row into a span with the
            // format's fetch, the weights stepping as i32.
            let triangle = TexTriangle {
                rows: TriangleRows::new((ax, ay), (bx, by), (cx, cy), min_y, min_x, max_x),
                min_y,
                max_y,
                u: [u0, u1, u2],
                v: [v0, v1, v2],
                inv_area,
                width: view.w,
                height: view.h,
                modulate: (!identity).then_some([mr, mg, mb, ma]),
            };
            let target: &mut dyn RenderTarget = target;
            if view.linear {
                with_fetch!(texels, fetch => tex_tri_linear(target, stride, triangle, fetch));
            } else {
                with_fetch!(texels, fetch => tex_tri_nearest(target, stride, triangle, fetch));
            }
            return;
        }
    }
    for py in min_y..max_y {
        for (px, [w0, w1, w2]) in TriangleRow::new((ax, ay), (bx, by), (cx, cy), py, min_x, max_x) {
            let (f0, f1, f2) = if narrow {
                (
                    w0 as i32 as f32 * inv_area,
                    w1 as i32 as f32 * inv_area,
                    w2 as i32 as f32 * inv_area,
                )
            } else {
                (
                    w0 as f32 * inv_area,
                    w1 as f32 * inv_area,
                    w2 as f32 * inv_area,
                )
            };
            let u = u0 * f0 + u1 * f1 + u2 * f2;
            let v = v0 * f0 + v1 * f1 + v2 * f2;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                let ty = ((v * thf) as i32).clamp(0, th_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            target.blend((py * stride + px) as usize, r, g, b, a);
        }
    }
}

/// One textured triangle over a validated view, wound counter-clockwise,
/// with weights that fit `i32`.
struct TexTriangle {
    rows: TriangleRows,
    min_y: i32,
    max_y: i32,
    u: [f32; 3],
    v: [f32; 3],
    inv_area: f32,
    width: u32,
    height: u32,
    modulate: Option<[u32; 4]>,
}

impl TexTriangle {
    /// The texture coordinate at weights `w`: the expression of the
    /// per-pixel loop, operation for operation.
    #[inline(always)]
    fn uv(&self, w: [i32; 3]) -> (f32, f32) {
        let f0 = w[0] as f32 * self.inv_area;
        let f1 = w[1] as f32 * self.inv_area;
        let f2 = w[2] as f32 * self.inv_area;
        let u = self.u[0] * f0 + self.u[1] * f1 + self.u[2] * f2;
        let v = self.v[0] * f0 + self.v[1] * f1 + self.v[2] * f2;
        (u, v)
    }

    /// Shade every covered row with `sample` and blend it span by span.
    #[inline(always)]
    fn draw(mut self, target: &mut dyn RenderTarget, stride: i32, sample: impl Fn(f32, f32) -> u32) {
        let step = self.rows.step.map(|step| step as i32);
        let mut colors = [0u32; SPAN];
        for py in self.min_y..self.max_y {
            let row = self.rows.next_row();
            if row.x >= row.end {
                continue;
            }
            // Exact at every covered pixel, where a weight is in 0..=area.
            let mut w = row.weights.map(|weight| weight as i32);
            let mut px = row.x;
            while px < row.end {
                let count = ((row.end - px) as usize).min(SPAN);
                for color in &mut colors[..count] {
                    let (u, v) = self.uv(w);
                    *color = sample(u, v);
                    for (weight, &step) in w.iter_mut().zip(&step) {
                        *weight = weight.wrapping_add(step);
                    }
                }
                if let Some(modulate) = self.modulate {
                    modulate_span(&mut colors[..count], modulate);
                }
                target.blend_span((py * stride + px) as usize, &colors[..count]);
                px += count as i32;
            }
        }
    }
}

fn tex_tri_nearest<F: Fetch>(
    target: &mut dyn RenderTarget,
    stride: i32,
    triangle: TexTriangle,
    fetch: F,
) {
    let (twf, thf) = (triangle.width as f32, triangle.height as f32);
    let (tw_max, th_max) = (triangle.width as i32 - 1, triangle.height as i32 - 1);
    let width = triangle.width as i32;
    triangle.draw(target, stride, |u, v| {
        let tx = ((u * twf) as i32).clamp(0, tw_max);
        let ty = ((v * thf) as i32).clamp(0, th_max);
        fetch.fetch((ty * width + tx) as usize)
    });
}

fn tex_tri_linear<F: Fetch>(
    target: &mut dyn RenderTarget,
    stride: i32,
    triangle: TexTriangle,
    fetch: F,
) {
    let (width, height) = (triangle.width, triangle.height);
    let row = width as usize;
    triangle.draw(target, stride, |u, v| {
        // A validated view has texels: the coordinates always exist.
        let Some(sample) = linear_sample_coordinates(width, height, u, v) else {
            return 0;
        };
        lerp_neighbours(
            fetch.fetch(sample.y0 as usize * row + sample.x0 as usize),
            fetch.fetch(sample.y0 as usize * row + sample.x1 as usize),
            fetch.fetch(sample.y1 as usize * row + sample.x0 as usize),
            fetch.fetch(sample.y1 as usize * row + sample.x1 as usize),
            sample.fx,
            sample.fy,
        )
    });
}

// ---- TEX_QUAD: textured rect (nearest, or integer bilinear when the texture
//      carries the linear flag) --------------------------------------------------------

fn tex_quad<T: RenderTarget>(
    ui: &(impl RenderResources + ?Sized),
    target: &mut T,
    stride: i32,
    scale: i32,
    clip: Clip,
    p: &[u32],
) {
    let handle = p[0] as i32;
    let (x, y) = xy(p[1], scale);
    let (w, h) = wh(p[2], scale);
    let u0 = f32::from_bits(p[3]);
    let v0 = f32::from_bits(p[4]);
    let u1 = f32::from_bits(p[5]);
    let v1 = f32::from_bits(p[6]);
    let modulate = p[7];
    if w <= 0 || h <= 0 {
        return;
    }
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_w = 1.0f32 / w as f32;
    let inv_h = 1.0f32 / h as f32;
    if let Some(texels) = Texels::new(&view) {
        // The common case: the texel column of a pixel is the same on every
        // row and the texel row the same on every column.
        let quad = TexQuad {
            clip: c,
            x,
            y,
            u0,
            v0,
            u1,
            v1,
            inv_w,
            inv_h,
            width: view.w,
            height: view.h,
            modulate: (!identity).then_some([mr, mg, mb, ma]),
        };
        let target: &mut dyn RenderTarget = target;
        if view.linear {
            with_fetch!(texels, fetch => tex_quad_linear(target, stride, &quad, fetch));
        } else {
            with_fetch!(texels, fetch => tex_quad_nearest(target, stride, &quad, fetch));
        }
        return;
    }
    for py in c.y0..c.y1 {
        let v = v0 + (v1 - v0) * ((py - y) as f32 + 0.5) * inv_h;
        let ty = ((v * thf) as i32).clamp(0, th_max);
        for px in c.x0..c.x1 {
            let u = u0 + (u1 - u0) * ((px - x) as f32 + 0.5) * inv_w;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                // Integer modulate, round-to-nearest (includes alpha).
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            target.blend((py * stride + px) as usize, r, g, b, a);
        }
    }
}

/// One textured rectangle over a validated view.
struct TexQuad {
    clip: Clip,
    x: i32,
    y: i32,
    u0: f32,
    v0: f32,
    u1: f32,
    v1: f32,
    inv_w: f32,
    inv_h: f32,
    width: u32,
    height: u32,
    modulate: Option<[u32; 4]>,
}

impl TexQuad {
    /// The texture coordinates of column `px` and of row `py`: the
    /// expressions of the per-pixel loop, operation for operation.
    #[inline(always)]
    fn u(&self, px: i32) -> f32 {
        self.u0 + (self.u1 - self.u0) * ((px - self.x) as f32 + 0.5) * self.inv_w
    }

    #[inline(always)]
    fn v(&self, py: i32) -> f32 {
        self.v0 + (self.v1 - self.v0) * ((py - self.y) as f32 + 0.5) * self.inv_h
    }
}

fn tex_quad_nearest<F: Fetch>(
    target: &mut dyn RenderTarget,
    stride: i32,
    quad: &TexQuad,
    fetch: F,
) {
    let c = quad.clip;
    let (twf, thf) = (quad.width as f32, quad.height as f32);
    let (tw_max, th_max) = (quad.width as i32 - 1, quad.height as i32 - 1);
    let width = quad.width as i32;
    let mut columns = [0i32; SPAN];
    let mut colors = [0u32; SPAN];
    let mut band = c.x0;
    while band < c.x1 {
        let count = ((c.x1 - band) as usize).min(SPAN);
        for (index, tx) in columns[..count].iter_mut().enumerate() {
            let u = quad.u(band + index as i32);
            *tx = ((u * twf) as i32).clamp(0, tw_max);
        }
        for py in c.y0..c.y1 {
            let v = quad.v(py);
            let ty = ((v * thf) as i32).clamp(0, th_max);
            let row = ty * width;
            for (color, &tx) in colors[..count].iter_mut().zip(&columns[..count]) {
                *color = fetch.fetch((row + tx) as usize);
            }
            if let Some(modulate) = quad.modulate {
                modulate_span(&mut colors[..count], modulate);
            }
            target.blend_span((py * stride + band) as usize, &colors[..count]);
        }
        band += count as i32;
    }
}

fn tex_quad_linear<F: Fetch>(
    target: &mut dyn RenderTarget,
    stride: i32,
    quad: &TexQuad,
    fetch: F,
) {
    let c = quad.clip;
    let (tw_max, th_max) = (quad.width as i32 - 1, quad.height as i32 - 1);
    let width = quad.width as usize;
    // Per column: the two texel columns and their weight, the horizontal
    // half of `linear_sample_coordinates`.
    let mut columns = [(0usize, 0usize, 0u32); SPAN];
    let mut colors = [0u32; SPAN];
    let mut band = c.x0;
    while band < c.x1 {
        let count = ((c.x1 - band) as usize).min(SPAN);
        for (index, column) in columns[..count].iter_mut().enumerate() {
            let u = quad.u(band + index as i32);
            let uf = (u * quad.width as f32 * 256.0) as i32 - 128;
            let x0 = (uf >> 8).clamp(0, tw_max);
            *column = (
                x0 as usize,
                (x0 + 1).min(tw_max) as usize,
                (uf & 255) as u32,
            );
        }
        for py in c.y0..c.y1 {
            // The vertical half.
            let v = quad.v(py);
            let vf = (v * quad.height as f32 * 256.0) as i32 - 128;
            let y0 = (vf >> 8).clamp(0, th_max);
            let y1 = (y0 + 1).min(th_max);
            let fy = (vf & 255) as u32;
            let (row0, row1) = (y0 as usize * width, y1 as usize * width);
            for (color, &(x0, x1, fx)) in colors[..count].iter_mut().zip(&columns[..count]) {
                *color = lerp_neighbours(
                    fetch.fetch(row0 + x0),
                    fetch.fetch(row0 + x1),
                    fetch.fetch(row1 + x0),
                    fetch.fetch(row1 + x1),
                    fx,
                    fy,
                );
            }
            if let Some(modulate) = quad.modulate {
                modulate_span(&mut colors[..count], modulate);
            }
            target.blend_span((py * stride + band) as usize, &colors[..count]);
        }
        band += count as i32;
    }
}
