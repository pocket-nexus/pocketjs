//! Driver entrypoints for bounded, strided CPU surfaces.

use pocket_draw_ops::{word_len, DrawOps, Operation};
use pocket_drivers::{
    DamageRect, FontView, FrameInput, PixelFormat, RenderError, RenderResources, Renderer,
    RendererDescriptor, Surface, Synchronization, Target, TargetOwnership, TexView,
};
use pocket_spec::{draw_op, psm};

use super::{
    blend_rgb565_pixel, clear_black_rect, fill_opaque_span, pack_rgb565, render_scaled_clipped,
    Clip, RenderTarget, RgbaTarget, MAX_RENDER_SCALE,
};

const FORMATS: &[PixelFormat] = &[
    PixelFormat::Rgba8888,
    PixelFormat::Argb8888,
    PixelFormat::Rgb565,
];

/// Synchronous software renderer with an explicit physical-pixels-per-logical
/// pixel scale. It redraws the acquired region and may ignore frame damage.
/// No temporary framebuffer or per-frame allocation is needed.
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
            Target::CpuVisible(surface) => {
                render_surface(frame.resources, &frame.list.words, surface, self.scale)
            }
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
/// Native text and compositor operations are known records and are skipped.
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
    clear_black_rect(&mut target, geometry.width, geometry.region);
    for operation in DrawOps::new(words, geometry.viewport) {
        let operation = operation.map_err(|_| RenderError::InvalidFrame)?;
        render_one(resources, &operation, &mut target, geometry, scale)?;
    }
    Ok(())
}

/// Draw one decoded operation over existing target pixels without clearing.
/// The operation retains its global viewport coordinates and inherited clip.
/// This is the ordered software fallback for CPU-visible targets; a driver
/// must drain earlier GPU work and make caches visible before calling it.
///
/// SCISSOR/SCISSOR_POP do no drawing because `Operation::clip` already holds
/// the decoder's current clip. TEXT_RUN/SURFACE_QUAD retain the software
/// path's skip behavior. Records with mismatched opcode or length are rejected.
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
    render_one(resources, operation, &mut target, geometry, scale)
}

fn render_one(
    resources: &(impl RenderResources + ?Sized),
    operation: &Operation<'_>,
    target: &mut SurfaceTarget<'_>,
    geometry: Geometry,
    scale: u32,
) -> Result<(), RenderError> {
    if matches!(
        operation.opcode,
        draw_op::SCISSOR | draw_op::SCISSOR_POP | draw_op::TEXT_RUN | draw_op::SURFACE_QUAD
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
    .intersect(geometry.region);
    if clip.x0 >= clip.x1 || clip.y0 >= clip.y1 {
        return Ok(());
    }
    let resources = OperationResources::new(resources, operation, scale as u32)?;
    render_scaled_clipped(
        &resources,
        operation.words,
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
}

impl<'a> SurfaceTarget<'a> {
    fn new(surface: &'a mut Surface<'_>, geometry: Geometry) -> Self {
        let format = surface.format();
        let stride = surface.stride_bytes();
        let bytes_per_pixel = format.bits_per_pixel() / 8;
        Self {
            pixels: surface.pixels_mut(),
            format,
            stride,
            bytes_per_pixel,
            geometry,
        }
    }

    fn local_offset(&self, full_offset: usize, length: usize) -> usize {
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

impl RenderTarget for SurfaceTarget<'_> {
    fn pixel_len(&self) -> usize {
        self.geometry.width as usize * self.geometry.height as usize
    }

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
                let color = pack_rgb565(r, g, b).to_le_bytes();
                for pixel in span.as_chunks_mut::<2>().0.iter_mut() {
                    pixel.copy_from_slice(&color);
                }
            }
            PixelFormat::Rgba8888 => fill_opaque_span::<false>(span, r, g, b),
            PixelFormat::Argb8888 => fill_opaque_span::<true>(span, r, g, b),
            _ => unreachable!("surface format validated before rendering"),
        }
    }
}
