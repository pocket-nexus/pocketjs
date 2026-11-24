//! Driver entrypoints for bounded, strided CPU surfaces.

use pocket_render::{logical_rect, wh, word_len, DrawOps, Operation};
use pocket_drivers::{
    DamageRect, FontView, FrameInput, PixelFormat, Rect, RenderError, RenderResources, Renderer,
    RendererDescriptor, Surface, Synchronization, Target, TargetOwnership, TexView,
};
use pocket_spec::{draw_op, psm};

use super::{
    aligned_words_mut, blend_rgb565_pixel, blend_rgba_pixel, channels, clear_black_rect,
    fill_opaque_span, pack_rgb565, render_record, Clip, RenderTarget, RgbaTarget,
    MAX_RENDER_SCALE,
};
#[cfg(test)]
use super::render_scaled_clipped;

const FORMATS: &[PixelFormat] = &[
    PixelFormat::Rgba8888,
    PixelFormat::Argb8888,
    PixelFormat::Rgb565,
];

/// Synchronous software renderer with an explicit physical-pixels-per-logical
/// pixel scale. It clears and replays the DrawList inside each frame damage
/// rectangle that intersects the acquired region; an empty damage list
/// redraws the whole region. A rectangle under an opaque RECT or GRAD_RECT
/// is replayed from the last one that covers it, without the clear. No
/// temporary framebuffer or per-frame allocation is needed.
pub struct RasterRenderer {
    scale: u32,
}

impl RasterRenderer {
    pub fn new(scale: u32) -> Result<Self, RenderError> {
        if !(1..=MAX_RENDER_SCALE).contains(&scale) {
            return Err(RenderError::Unsupported);
        }
        Ok(Self { scale })
    }

    pub fn scale(&self) -> u32 {
        self.scale
    }
}

impl Renderer for RasterRenderer {
    type Submission = ();

    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            FORMATS,
            TargetOwnership::CpuVisible,
            Synchronization::Immediate,
            pocket_spec::DRAW_LIST_VERSION,
            false,
        )
        .expect("software descriptor has a fixed valid configuration")
    }

    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<(), RenderError> {
        match &mut frame.target {
            Target::CpuVisible(surface) if frame.damage.is_empty() => {
                render_surface(frame.resources, &frame.list.words, surface, self.scale)
            }
            Target::CpuVisible(surface) => render_surface_regions(
                frame.resources,
                &frame.list.words,
                surface,
                self.scale,
                frame.damage,
            ),
            _ => Err(RenderError::Unsupported),
        }
    }

    fn wait(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
    fn retire(&mut self, _: ()) {}
}

/// Clear the acquired region to opaque black, then render the DrawList.
/// Surface coordinates and stride are physical; DrawList geometry remains
/// logical. Padding and all bytes outside the acquired region are preserved.
/// Native text operations are known records and are skipped.
///
/// A decode error can leave partial pixels in the region; the caller must
/// discard its damage history. All writes have finished when this returns.
pub fn render_surface(
    resources: &(impl RenderResources + ?Sized),
    words: &[u32],
    surface: &mut Surface<'_>,
    scale: u32,
) -> Result<(), RenderError> {
    let geometry = Geometry::new(resources, surface, scale)?;
    let mut target = SurfaceTarget::new(surface, geometry);
    let cover = last_covers(words, geometry, &[geometry.region], scale)?[0];
    render_clipped(
        resources,
        words,
        &mut target,
        geometry,
        geometry.region,
        scale,
        cover,
    )
}

/// Clear and replay the DrawList inside each physical rectangle of `regions`
/// intersected with the acquired region, in list order. Every rectangle
/// replays the DrawList under that root clip, so painter order holds for
/// translucent operations; a rectangle that an opaque RECT or GRAD_RECT
/// covers is replayed from the last such operation, without the clear
/// ([`last_covers`]). Pixels outside the rectangles keep their previous
/// values; an empty list writes nothing. The [`render_surface`] rules for
/// coordinates, padding, skipped records, and decode errors apply.
pub fn render_surface_regions(
    resources: &(impl RenderResources + ?Sized),
    words: &[u32],
    surface: &mut Surface<'_>,
    scale: u32,
    regions: &[Rect],
) -> Result<(), RenderError> {
    let geometry = Geometry::new(resources, surface, scale)?;
    let mut target = SurfaceTarget::new(surface, geometry);
    for regions in regions.chunks(COVER_ROOTS) {
        let mut roots = [geometry.region; COVER_ROOTS];
        let mut count = 0;
        for &region in regions {
            let root = physical(region).intersect(geometry.region);
            if root.x0 < root.x1 && root.y0 < root.y1 {
                roots[count] = root;
                count += 1;
            }
        }
        let covers = last_covers(words, geometry, &roots[..count], scale)?;
        for (&root, cover) in roots[..count].iter().zip(covers) {
            render_clipped(resources, words, &mut target, geometry, root, scale, cover)?;
        }
    }
    Ok(())
}

/// Rectangles whose replays share one scan of the DrawList for their covers.
const COVER_ROOTS: usize = 8;

/// For each of `roots` (at most [`COVER_ROOTS`], physical, not empty), the
/// index of the last operation that sets every pixel of it whatever the
/// pixel held: a RECT, or a GRAD_RECT, without transparency, whose rectangle
/// under its scissors contains the root. Neither the clear nor an operation
/// before that index changes what the root shows after the replay.
fn last_covers(
    words: &[u32],
    geometry: Geometry,
    roots: &[Clip],
    scale: u32,
) -> Result<[Option<usize>; COVER_ROOTS], RenderError> {
    let mut covers = [None; COVER_ROOTS];
    let scale = scale as i32;
    // A cover is at least as wide and as high as the smallest root.
    let width = roots.iter().map(|root| root.x1 - root.x0).min().unwrap_or(0);
    let height = roots.iter().map(|root| root.y1 - root.y0).min().unwrap_or(0);
    for (index, operation) in DrawOps::new(words, geometry.viewport).enumerate() {
        let operation = operation.map_err(|_| RenderError::InvalidFrame)?;
        let opaque = match operation.opcode {
            draw_op::RECT => channels(operation.words[3]).3 == 255,
            draw_op::GRAD_RECT => {
                channels(operation.words[3]).3 == 255 && channels(operation.words[4]).3 == 255
            }
            _ => continue,
        };
        let (w, h) = wh(operation.words[2]);
        if !opaque || w.saturating_mul(scale) < width || h.saturating_mul(scale) < height {
            continue;
        }
        let painted = logical_rect(operation.words[1], operation.words[2])
            .intersect(operation.clip)
            .intersect(geometry.viewport);
        for (cover, root) in covers.iter_mut().zip(roots) {
            if painted.x0.saturating_mul(scale) <= root.x0
                && painted.y0.saturating_mul(scale) <= root.y0
                && painted.x1.saturating_mul(scale) >= root.x1
                && painted.y1.saturating_mul(scale) >= root.y1
            {
                *cover = Some(index);
            }
        }
    }
    Ok(covers)
}

/// Replay the DrawList under the clip `root`: from the operation `cover`
/// ([`last_covers`]), or from the first one after clearing `root` to opaque
/// black.
fn render_clipped(
    resources: &(impl RenderResources + ?Sized),
    words: &[u32],
    target: &mut SurfaceTarget<'_>,
    geometry: Geometry,
    root: Clip,
    scale: u32,
    cover: Option<usize>,
) -> Result<(), RenderError> {
    if cover.is_none() {
        clear_black_rect(target, geometry.width, root);
    }
    let first = cover.unwrap_or(0);
    for (index, operation) in DrawOps::new(words, geometry.viewport).enumerate() {
        let operation = operation.map_err(|_| RenderError::InvalidFrame)?;
        if index >= first {
            render_one(resources, &operation, target, geometry, root, scale)?;
        }
    }
    Ok(())
}

/// The interpreter over an acquired surface under `clip`, optionally after
/// clearing it: what `render_one` runs for one operation, for the
/// differential tests.
#[cfg(test)]
pub(crate) fn interpret_for_test(
    resources: &(impl RenderResources + ?Sized),
    words: &[u32],
    surface: &mut Surface<'_>,
    scale: u32,
    clip: Clip,
    clear: bool,
) {
    let geometry = Geometry::new(resources, surface, scale).expect("test surface");
    let mut target = SurfaceTarget::new(surface, geometry);
    if clear {
        clear_black_rect(&mut target, geometry.width, clip);
    }
    render_scaled_clipped(
        resources,
        words,
        &mut target,
        geometry.width,
        scale as i32,
        clip,
    );
}

/// Physical rectangle as a clip. Coordinates saturate at `i32::MAX`, beyond
/// any acquired region.
fn physical(rect: Rect) -> Clip {
    let bound = |value: u64| value.min(i32::MAX as u64) as i32;
    Clip {
        x0: bound(u64::from(rect.x)),
        y0: bound(u64::from(rect.y)),
        x1: bound(u64::from(rect.x) + u64::from(rect.width)),
        y1: bound(u64::from(rect.y) + u64::from(rect.height)),
    }
}

/// Draw one decoded operation over existing target pixels without clearing.
/// The operation retains its global viewport coordinates and inherited clip.
/// This is the ordered software fallback for CPU-visible targets; a driver
/// must drain earlier GPU work and make caches visible before calling it.
///
/// SCISSOR/SCISSOR_POP do no drawing because `Operation::clip` already holds
/// the decoder's current clip. TEXT_RUN retains the software path's skip
/// behavior. Records with mismatched opcode or length are rejected.
pub fn render_operation(
    resources: &(impl RenderResources + ?Sized),
    operation: &Operation<'_>,
    surface: &mut Surface<'_>,
    scale: u32,
) -> Result<(), RenderError> {
    if operation.words.first().copied() != Some(operation.opcode)
        || word_len(operation.words, 0).map_err(|_| RenderError::InvalidFrame)?
            != operation.words.len()
    {
        return Err(RenderError::InvalidFrame);
    }
    let geometry = Geometry::new(resources, surface, scale)?;
    let mut target = SurfaceTarget::new(surface, geometry);
    render_one(
        resources,
        operation,
        &mut target,
        geometry,
        geometry.region,
        scale,
    )
}

fn render_one(
    resources: &(impl RenderResources + ?Sized),
    operation: &Operation<'_>,
    target: &mut SurfaceTarget<'_>,
    geometry: Geometry,
    root: Clip,
    scale: u32,
) -> Result<(), RenderError> {
    if matches!(
        operation.opcode,
        draw_op::SCISSOR | draw_op::SCISSOR_POP | draw_op::TEXT_RUN
    ) {
        return Ok(());
    }
    let logical = operation.clip.intersect(geometry.viewport);
    if logical.is_empty() {
        return Ok(());
    }
    let scale = scale as i32;
    let clip = Clip {
        x0: logical.x0 * scale,
        y0: logical.y0 * scale,
        x1: logical.x1 * scale,
        y1: logical.y1 * scale,
    }
    .intersect(root);
    if clip.x0 >= clip.x1 || clip.y0 >= clip.y1 {
        return Ok(());
    }
    let resources = OperationResources::new(resources, operation, scale as u32)?;
    // One validated drawing record: no scissor stack to set up.
    render_record(
        &resources,
        operation.words,
        0,
        target,
        geometry.width,
        scale,
        clip,
    );
    Ok(())
}

/// Fetch once per operation and retain the validated views. A public resource
/// provider may return a different view on its next lookup, so validation and
/// drawing must use the same borrow.
pub struct OperationResources<'a, R: RenderResources + ?Sized> {
    source: &'a R,
    texture: Option<TexView<'a>>,
    font: Option<FontView<'a>>,
}

impl<'a, R: RenderResources + ?Sized> OperationResources<'a, R> {
    pub fn new(source: &'a R, operation: &Operation<'_>, scale: u32) -> Result<Self, RenderError> {
        if !(1..=MAX_RENDER_SCALE).contains(&scale)
            || operation.words.first().copied() != Some(operation.opcode)
            || word_len(operation.words, 0).map_err(|_| RenderError::InvalidFrame)?
                != operation.words.len()
        {
            return Err(RenderError::InvalidFrame);
        }
        let mut result = Self {
            source,
            texture: None,
            font: None,
        };
        match operation.opcode {
            draw_op::TEX_QUAD | draw_op::TEX_TRI => {
                if let Some(view) = source.texture(operation.words[1] as i32) {
                    if !validate_texture(&view)? {
                        return Ok(result);
                    }
                    let coordinates: &[usize] = if operation.opcode == draw_op::TEX_QUAD {
                        &[4, 5, 6, 7]
                    } else {
                        &[3, 4, 6, 7, 9, 10]
                    };
                    for (index, &word) in coordinates.iter().enumerate() {
                        let uv = f32::from_bits(operation.words[word]);
                        let extent = if index % 2 == 0 { view.w } else { view.h };
                        // The fixed-point linear sampler subtracts 128 from
                        // a signed coordinate. Leave room for interpolation
                        // intermediates, including clamped out-of-range UVs.
                        if !uv.is_finite()
                            || (view.linear
                                && uv.abs() * extent as f32 * 256.0 > i32::MAX as f32 / 4.0)
                        {
                            return Err(RenderError::InvalidFrame);
                        }
                    }
                    result.texture = Some(view);
                }
            }
            draw_op::GLYPH_RUN => {
                if let Some(view) = source.font_atlas(operation.words[1] as u8) {
                    // Missing glyphs have always been skipped. An empty run
                    // or one containing only out-of-range ids needs no atlas.
                    if operation.words[3..]
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .any(|pair| (pair[1] as u16) < view.glyph_count)
                    {
                        validate_font(&view, scale)?;
                        result.font = Some(view);
                    }
                }
            }
            _ => {}
        }
        Ok(result)
    }
}

impl<R: RenderResources + ?Sized> RenderResources for OperationResources<'_, R> {
    fn viewport(&self) -> (f32, f32) {
        self.source.viewport()
    }
    fn raster_revision(&self) -> u64 {
        self.source.raster_revision()
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        self.texture
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        self.font
    }
    fn texture_revision(&self, handle: i32) -> Option<u64> {
        self.source.texture_revision(handle)
    }
    fn font_revision(&self, slot: u8) -> Option<u64> {
        self.source.font_revision(slot)
    }
    fn font_texture_width(&self, slot: u8) -> Option<u32> {
        self.source.font_texture_width(slot)
    }
}

fn validate_texture(view: &TexView<'_>) -> Result<bool, RenderError> {
    let bpp = match view.psm {
        psm::PSM_8888 => 4,
        psm::PSM_5650 | psm::PSM_4444 => 2,
        psm::PSM_T8 => 1,
        // The legacy sampler skips unknown formats.
        _ => return Ok(false),
    };
    let pixels = view
        .w
        .checked_mul(view.h)
        .ok_or(RenderError::InvalidFrame)?;
    let bytes = (pixels as usize)
        .checked_mul(bpp)
        .ok_or(RenderError::InvalidFrame)?;
    if view.w == 0
        || view.h == 0
        || pixels > i32::MAX as u32
        || bytes > view.pixels.len()
        || (view.psm == psm::PSM_T8 && view.palette.is_none_or(|palette| palette.len() < 1024))
    {
        return Err(RenderError::InvalidFrame);
    }
    Ok(true)
}

fn validate_font(view: &FontView<'_>, scale: u32) -> Result<(), RenderError> {
    let density = view.raster_density as u32;
    if density == 0 || view.cell_w == 0 || view.cell_h == 0 {
        return Err(RenderError::InvalidFrame);
    }
    let coverage_w = view
        .cell_w
        .checked_mul(density)
        .ok_or(RenderError::InvalidFrame)?;
    let coverage_h = view
        .cell_h
        .checked_mul(density)
        .ok_or(RenderError::InvalidFrame)?;
    let bytes = (coverage_w as usize)
        .checked_mul(coverage_h as usize)
        .and_then(|cell| cell.checked_mul(view.glyph_count as usize))
        .ok_or(RenderError::InvalidFrame)?;
    if bytes > view.bitmap.len() || coverage_w > i32::MAX as u32 || coverage_h > i32::MAX as u32 {
        return Err(RenderError::InvalidFrame);
    }
    for logical in [view.cell_w, view.cell_h] {
        let physical = u64::from(logical) * u64::from(scale);
        // Bound gx + cell and the integer center-sample expression
        // (2 * destination + 1) * density used by coverage_index.
        if physical + (i16::MAX as u64) * u64::from(scale) > i32::MAX as u64
            || (2 * physical - 1) * u64::from(density) > i32::MAX as u64
        {
            return Err(RenderError::InvalidFrame);
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Geometry {
    viewport: DamageRect,
    width: i32,
    height: i32,
    region: Clip,
}

impl Geometry {
    fn new(
        resources: &(impl RenderResources + ?Sized),
        surface: &Surface<'_>,
        scale: u32,
    ) -> Result<Self, RenderError> {
        if !(1..=MAX_RENDER_SCALE).contains(&scale) || !FORMATS.contains(&surface.format()) {
            return Err(RenderError::Unsupported);
        }
        let (viewport_w, viewport_h) = resources.viewport();
        if !viewport_w.is_finite()
            || !viewport_h.is_finite()
            || viewport_w < 1.0
            || viewport_h < 1.0
            || viewport_w >= i32::MAX as f32
            || viewport_h >= i32::MAX as f32
        {
            return Err(RenderError::InvalidFrame);
        }
        // Match the legacy rasterizer's truncation of fractional viewports.
        let viewport = DamageRect::new(0, 0, viewport_w as i32, viewport_h as i32);
        let width = viewport
            .x1
            .checked_mul(scale as i32)
            .ok_or(RenderError::InvalidFrame)?;
        let height = viewport
            .y1
            .checked_mul(scale as i32)
            .ok_or(RenderError::InvalidFrame)?;
        // Pixel interpreters use signed full-viewport offsets; exclude shapes
        // for which their address arithmetic could overflow before mapping.
        width.checked_mul(height).ok_or(RenderError::InvalidFrame)?;
        let region = surface.region();
        let x1 = region
            .x
            .checked_add(region.width)
            .ok_or(RenderError::InvalidFrame)?;
        let y1 = region
            .y
            .checked_add(region.height)
            .ok_or(RenderError::InvalidFrame)?;
        if x1 > width as u32 || y1 > height as u32 {
            return Err(RenderError::InvalidFrame);
        }
        Ok(Self {
            viewport,
            width,
            height,
            region: Clip {
                x0: region.x as i32,
                y0: region.y as i32,
                x1: x1 as i32,
                y1: y1 as i32,
            },
        })
    }
}

/// Full-viewport pixel offsets map to the acquired region's strided bytes.
/// RGB565 accesses use byte pairs so no pointer alignment is assumed.
struct SurfaceTarget<'a> {
    pixels: &'a mut [u8],
    format: PixelFormat,
    stride: usize,
    bytes_per_pixel: usize,
    geometry: Geometry,
    /// The full-viewport offsets of the region's first pixel and of the
    /// pixel after its last one, when the region holds whole viewport rows
    /// without row padding (a strip of a strip display). An offset then maps
    /// to its byte by one subtraction; other layouts divide by the width.
    rows: Option<(usize, usize)>,
}

impl<'a> SurfaceTarget<'a> {
    fn new(surface: &'a mut Surface<'_>, geometry: Geometry) -> Self {
        let format = surface.format();
        let stride = surface.stride_bytes();
        let bytes_per_pixel = format.bits_per_pixel() / 8;
        let width = geometry.width as usize;
        let region = geometry.region;
        let rows = (region.x0 == 0 && region.x1 == geometry.width && stride == width * bytes_per_pixel)
            .then(|| (region.y0 as usize * width, region.y1 as usize * width));
        Self {
            pixels: surface.pixels_mut(),
            format,
            stride,
            bytes_per_pixel,
            geometry,
            rows,
        }
    }

    /// Byte offset of the pixel at `full_offset`. Panics unless `length`
    /// pixels from it lie in one row of the acquired region.
    #[inline]
    fn local_offset(&self, full_offset: usize, length: usize) -> usize {
        if let Some((first, end)) = self.rows {
            let width = self.geometry.width as usize;
            assert!(
                full_offset >= first
                    && full_offset < end
                    && (length <= 1 || length <= width - full_offset % width),
                "raster write escaped the acquired surface"
            );
            return (full_offset - first) * self.bytes_per_pixel;
        }
        let y = full_offset / self.geometry.width as usize;
        let x = full_offset % self.geometry.width as usize;
        let region = self.geometry.region;
        assert!(
            x >= region.x0 as usize
                && x < region.x1 as usize
                && length <= region.x1 as usize - x
                && y >= region.y0 as usize
                && y < region.y1 as usize,
            "raster write escaped the acquired surface"
        );
        (y - region.y0 as usize) * self.stride + (x - region.x0 as usize) * self.bytes_per_pixel
    }
}

/// `blend_rgb565_pixel` on the two little-endian bytes of one pixel.
#[inline]
fn blend_rgb565_bytes(pixel: &mut [u8; 2], r: u32, g: u32, b: u32, a: u32) {
    if a >= 255 {
        *pixel = pack_rgb565(r, g, b).to_le_bytes();
        return;
    }
    if a == 0 {
        return;
    }
    let mut value = u16::from_le_bytes(*pixel);
    blend_rgb565_pixel(&mut value, r, g, b, a);
    *pixel = value.to_le_bytes();
}

/// `blend_rgb565_pixel` on one pixel held as a native word of
/// little-endian storage.
#[inline]
fn blend_rgb565_word(word: u16, r: u32, g: u32, b: u32, a: u32) -> u16 {
    if a >= 255 {
        return pack_rgb565(r, g, b).to_le();
    }
    if a == 0 {
        return word;
    }
    let mut value = u16::from_le(word);
    blend_rgb565_pixel(&mut value, r, g, b, a);
    value.to_le()
}

impl RenderTarget for SurfaceTarget<'_> {
    fn pixel_len(&self) -> usize {
        self.geometry.width as usize * self.geometry.height as usize
    }

    #[inline]
    fn blend(&mut self, offset: usize, r: u32, g: u32, b: u32, a: u32) {
        let local = self.local_offset(offset, 1);
        match self.format {
            PixelFormat::Rgb565 => {
                let mut pixel = u16::from_le_bytes([self.pixels[local], self.pixels[local + 1]]);
                blend_rgb565_pixel(&mut pixel, r, g, b, a);
                self.pixels[local..local + 2].copy_from_slice(&pixel.to_le_bytes());
            }
            PixelFormat::Rgba8888 => RgbaTarget::<false> {
                bytes: &mut self.pixels[local..local + 4],
            }
            .blend(0, r, g, b, a),
            PixelFormat::Argb8888 => RgbaTarget::<true> {
                bytes: &mut self.pixels[local..local + 4],
            }
            .blend(0, r, g, b, a),
            _ => unreachable!("surface format validated before rendering"),
        }
    }

    fn fill_opaque(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32) {
        if len == 0 {
            return;
        }
        let local = self.local_offset(start, len);
        let span = &mut self.pixels[local..local + len * self.bytes_per_pixel];
        match self.format {
            PixelFormat::Rgb565 => {
                let color = pack_rgb565(r, g, b);
                let [low, high] = color.to_le_bytes();
                if low == high {
                    // Black, white and the greys between: one byte value.
                    span.fill(low);
                } else if let Some(words) = aligned_words_mut::<u16>(span) {
                    words.fill(color.to_le());
                } else {
                    for pixel in span.as_chunks_mut::<2>().0.iter_mut() {
                        *pixel = [low, high];
                    }
                }
            }
            PixelFormat::Rgba8888 => fill_opaque_span::<false>(span, r, g, b),
            PixelFormat::Argb8888 => fill_opaque_span::<true>(span, r, g, b),
            _ => unreachable!("surface format validated before rendering"),
        }
    }

    // The span methods resolve the row and the pixel format once; the loops
    // below hold one format's blend each.

    fn blend_fill(&mut self, start: usize, len: usize, r: u32, g: u32, b: u32, a: u32) {
        if len == 0 || a == 0 {
            return;
        }
        let local = self.local_offset(start, len);
        let span = &mut self.pixels[local..local + len * self.bytes_per_pixel];
        match self.format {
            PixelFormat::Rgb565 => {
                if let Some(words) = aligned_words_mut::<u16>(span) {
                    for word in words {
                        *word = blend_rgb565_word(*word, r, g, b, a);
                    }
                } else {
                    for pixel in span.as_chunks_mut::<2>().0.iter_mut() {
                        blend_rgb565_bytes(pixel, r, g, b, a);
                    }
                }
            }
            PixelFormat::Rgba8888 => {
                for pixel in span.as_chunks_mut::<4>().0.iter_mut() {
                    blend_rgba_pixel::<false>(pixel, r, g, b, a);
                }
            }
            PixelFormat::Argb8888 => {
                for pixel in span.as_chunks_mut::<4>().0.iter_mut() {
                    blend_rgba_pixel::<true>(pixel, r, g, b, a);
                }
            }
            _ => unreachable!("surface format validated before rendering"),
        }
    }

    fn blend_span(&mut self, start: usize, colors: &[u32]) {
        if colors.is_empty() {
            return;
        }
        let local = self.local_offset(start, colors.len());
        let span = &mut self.pixels[local..local + colors.len() * self.bytes_per_pixel];
        match self.format {
            PixelFormat::Rgb565 => {
                if let Some(words) = aligned_words_mut::<u16>(span) {
                    for (word, &color) in words.iter_mut().zip(colors) {
                        let (r, g, b, a) = channels(color);
                        *word = blend_rgb565_word(*word, r, g, b, a);
                    }
                } else {
                    for (pixel, &color) in span.as_chunks_mut::<2>().0.iter_mut().zip(colors) {
                        let (r, g, b, a) = channels(color);
                        blend_rgb565_bytes(pixel, r, g, b, a);
                    }
                }
            }
            PixelFormat::Rgba8888 => {
                for (pixel, &color) in span.as_chunks_mut::<4>().0.iter_mut().zip(colors) {
                    let (r, g, b, a) = channels(color);
                    blend_rgba_pixel::<false>(pixel, r, g, b, a);
                }
            }
            PixelFormat::Argb8888 => {
                for (pixel, &color) in span.as_chunks_mut::<4>().0.iter_mut().zip(colors) {
                    let (r, g, b, a) = channels(color);
                    blend_rgba_pixel::<true>(pixel, r, g, b, a);
                }
            }
            _ => unreachable!("surface format validated before rendering"),
        }
    }
}
