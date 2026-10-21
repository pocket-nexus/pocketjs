use crate::{Device, Primitive, TextureBinding, VertC, VertTC, Vertices};
use alloc::vec::Vec;
use core::mem::size_of;
use pocket_draw_ops::DrawOps;
use pocket_drivers::{DamageRect, FontView, RenderError, RenderResources, TexView};
use pocket_glyph_pages::{FontPages, GlyphSource};
use pocket_psp_ge::FramePool;
use pocket_spec as spec;

/// Storage for an open native GE pass. It owns geometry and font renditions.
/// The caller controls the native list and reports terminal completion through
/// `retire`. Source images are copied unless `zero_copy` is explicitly chosen.
#[derive(Default)]
pub struct Encoder {
    pool: FramePool,
    fonts: FontPages,
    images: Vec<(ImageKey, TextureBinding)>,
    published: Vec<ImageKey>,
    active: bool,
    next: u64,
    submission: u64,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct ImageKey {
    handle: i32,
    revision: u64,
    pixels: *const u8,
    palette: *const u8,
}
impl Encoder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn resident_bytes(&self) -> usize {
        self.pool.resident_bytes() + self.fonts.resident_bytes()
    }
    /// Validate before opening a list or borrowing device resources.
    pub fn validate(words: &[u32], resources: &dyn RenderResources) -> Result<(), RenderError> {
        if resources.viewport() != (480.0, 272.0) {
            return Err(RenderError::Unsupported);
        }
        for op in DrawOps::new(words, DamageRect::new(0, 0, 480, 272)) {
            let op = op.map_err(|_| RenderError::InvalidFrame)?;
            if matches!(
                op.opcode,
                spec::draw_op::SURFACE_QUAD | spec::draw_op::TEXT_RUN
            ) {
                return Err(RenderError::Unsupported);
            }
        }
        Ok(())
    }
    /// Encode one or more passes into the caller's already open native list.
    ///
    /// # Safety
    /// The device must retain pointers only until terminal completion. Do not
    /// drop/reset this encoder until all encoded work has stopped. With
    /// `zero_copy`, all source image bytes must also stay immutable and live.
    pub unsafe fn encode_open<D: Device>(
        &mut self,
        device: &mut D,
        resources: &dyn RenderResources,
        words: &[u32],
        zero_copy: bool,
        clear: bool,
    ) -> Result<(), RenderError> {
        Self::validate(words, resources)?;
        if !self.active {
            self.next = self.next.checked_add(1).ok_or(RenderError::Failed)?;
            self.submission = self.next;
            self.active = true;
        }
        device.begin_pass(clear);
        let result = self.encode(device, resources, words, zero_copy);
        device.end_pass();
        result
    }
    /// # Safety
    /// Every list that references this encoder must have completed or stopped.
    pub unsafe fn retire(&mut self) {
        if self.active {
            self.fonts.retire(self.submission);
        }
        self.pool.reset();
        self.images.clear();
        self.active = false;
    }
    /// # Safety
    /// No native list may still reference a font page from this encoder.
    pub unsafe fn reset_fonts(&mut self) {
        self.fonts = FontPages::default();
        self.published.clear();
    }
    unsafe fn colored(&mut self, count: usize) -> &mut [VertC] {
        core::slice::from_raw_parts_mut(self.pool.alloc(count * size_of::<VertC>()).cast(), count)
    }
    unsafe fn textured(&mut self, count: usize) -> &mut [VertTC] {
        core::slice::from_raw_parts_mut(self.pool.alloc(count * size_of::<VertTC>()).cast(), count)
    }
    unsafe fn image<D: Device>(
        &mut self,
        device: &mut D,
        resources: &dyn RenderResources,
        handle: i32,
        zero_copy: bool,
    ) -> Result<Option<TextureBinding>, RenderError> {
        let Some(mut view) = resources.texture(handle) else {
            return Ok(None);
        };
        validate_texture(view)?;
        let pixel_bytes = match view.psm {
            spec::psm::PSM_T8 => 1,
            spec::psm::PSM_8888 => 4,
            _ => 2,
        };
        view.pixels = &view.pixels[..(view.w * view.h * pixel_bytes) as usize];
        view.palette = if view.psm == spec::psm::PSM_T8 {
            view.palette.map(|palette| &palette[..1024])
        } else {
            None
        };
        let key = ImageKey {
            handle,
            revision: resources
                .texture_revision(handle)
                .ok_or(RenderError::InvalidFrame)?,
            pixels: view.pixels.as_ptr(),
            palette: view
                .palette
                .map_or(core::ptr::null(), |palette| palette.as_ptr()),
        };
        if let Some((_, binding)) = self.images.iter().find(|(old, _)| *old == key) {
            return Ok(Some(*binding));
        }
        let palette = view.palette.unwrap_or(&[]);
        let (pixels, buffer_width, bytes) = ge_texture_storage(
            &mut self.pool,
            view.pixels,
            view.w,
            view.h,
            pixel_bytes,
            zero_copy,
        );
        let clut = if palette.is_empty() {
            core::ptr::null()
        } else {
            ge_storage(&mut self.pool, palette, zero_copy)
        };
        let binding = TextureBinding {
            pixels,
            bytes,
            palette: clut,
            palette_bytes: palette.len(),
            width: view.w,
            height: view.h,
            buffer_width,
            psm: view.psm,
            linear: view.linear,
        };
        // Keep the optimized immutable-RAM path: a stable handle/revision is
        // published once, not on every frame. Copied/unaligned views get new
        // driver storage and must be published on each submission.
        let borrowed = pixels == key.pixels && clut == key.palette;
        if !borrowed || !self.published.contains(&key) {
            device.publish(pixels, binding.bytes);
            if !clut.is_null() {
                device.publish(clut, binding.palette_bytes);
            }
            if borrowed {
                self.published.retain(|old| old.handle != handle);
                if self.published.len() == 256 {
                    self.published.remove(0);
                }
                self.published.push(key);
            }
        }
        self.images.push((key, binding));
        Ok(Some(binding))
    }
    unsafe fn encode<D: Device>(
        &mut self,
        device: &mut D,
        resources: &dyn RenderResources,
        words: &[u32],
        zero_copy: bool,
    ) -> Result<(), RenderError> {
        let mut ops = DrawOps::new(words, DamageRect::new(0, 0, 480, 272));
        let mut last_clip = DamageRect::new(0, 0, 480, 272);
        loop {
            let start = ops.position();
            let Some(op) = ops.next() else {
                break;
            };
            let op = op.map_err(|_| RenderError::InvalidFrame)?;
            if op.clip.is_empty() {
                continue;
            }
            if op.clip != last_clip {
                device.clip(op.clip);
                last_clip = op.clip;
            }
            let opcode = op.opcode;
            if matches!(opcode, spec::draw_op::SCISSOR | spec::draw_op::SCISSOR_POP) {
                continue;
            }
            let width = match opcode {
                spec::draw_op::RECT => 4,
                spec::draw_op::TRI => 7,
                spec::draw_op::TEX_QUAD => 9,
                spec::draw_op::TEX_TRI => 12,
                _ => 0,
            };
            let mut count = 1;
            if width != 0 {
                let mut end = ops.position();
                while words.get(end) == Some(&opcode)
                    && (!matches!(opcode, spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI)
                        || words[end + 1] == op.words[1])
                {
                    count += 1;
                    end += width;
                }
                for _ in 1..count {
                    ops.next()
                        .ok_or(RenderError::InvalidFrame)?
                        .map_err(|_| RenderError::InvalidFrame)?;
                }
            }
            let data = &words[start..ops.position()];
            match opcode {
                spec::draw_op::RECT => {
                    let vertices = self.colored(count * 2);
                    for (k, w) in data.as_chunks::<4>().0.iter().enumerate() {
                        let (x, y) = xy(w[1]);
                        let (x1, y1) = end_xy(x, y, w[2])?;
                        vertices[k * 2] = VertC::new(w[3], x, y);
                        vertices[k * 2 + 1] = VertC::new(w[3], x1, y1);
                    }
                    device.draw(Primitive::Sprites, Vertices::Colored(vertices));
                }
                spec::draw_op::GRAD_RECT => {
                    let (x, y) = xy(data[1]);
                    let (x1, y1) = end_xy(x, y, data[2])?;
                    let (a, b) = (data[3], data[4]);
                    let colors = match data[5] {
                        d if d == spec::GradDir::ToTop as u32 => [b, b, a, a],
                        d if d == spec::GradDir::ToLeft as u32 => [b, a, b, a],
                        d if d == spec::GradDir::ToRight as u32 => [a, b, a, b],
                        _ => [a, a, b, b],
                    };
                    let v = self.colored(4);
                    v[0] = VertC::new(colors[0], x, y);
                    v[1] = VertC::new(colors[1], x1, y);
                    v[2] = VertC::new(colors[2], x, y1);
                    v[3] = VertC::new(colors[3], x1, y1);
                    device.draw(Primitive::TriangleStrip, Vertices::Colored(v));
                }
                spec::draw_op::TRI => {
                    let v = self.colored(count * 3);
                    for (k, w) in data.as_chunks::<7>().0.iter().enumerate() {
                        for c in 0..3 {
                            let (x, y) = xy(w[c + 1]);
                            v[k * 3 + c] = VertC::new(w[c + 4], x, y);
                        }
                    }
                    device.draw(Primitive::Triangles, Vertices::Colored(v));
                }
                spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI => {
                    let Some(binding) = self.image(device, resources, data[1] as i32, zero_copy)?
                    else {
                        continue;
                    };
                    device.bind(Some(binding));
                    if opcode == spec::draw_op::TEX_QUAD {
                        let v = self.textured(count * 2);
                        for (k, w) in data.as_chunks::<9>().0.iter().enumerate() {
                            let (x, y) = xy(w[2]);
                            let (x1, y1) = end_xy(x, y, w[3])?;
                            v[k * 2] = VertTC::new(
                                w[8],
                                x,
                                y,
                                uv(w[4], binding.width)?,
                                uv(w[5], binding.height)?,
                            );
                            v[k * 2 + 1] = VertTC::new(
                                w[8],
                                x1,
                                y1,
                                uv(w[6], binding.width)?,
                                uv(w[7], binding.height)?,
                            );
                        }
                        device.draw(Primitive::Sprites, Vertices::Textured(v));
                    } else {
                        let v = self.textured(count * 3);
                        for (k, w) in data.as_chunks::<12>().0.iter().enumerate() {
                            for c in 0..3 {
                                let (x, y) = xy(w[2 + c * 3]);
                                v[k * 3 + c] = VertTC::new(
                                    w[11],
                                    x,
                                    y,
                                    uv(w[3 + c * 3], binding.width)?,
                                    uv(w[4 + c * 3], binding.height)?,
                                );
                            }
                        }
                        device.draw(Primitive::Triangles, Vertices::Textured(v));
                    }
                    device.bind(None);
                }
                spec::draw_op::GLYPH_RUN => {
                    let slot = data[1] as u8;
                    let Some(font) = resources.font_atlas(slot) else {
                        continue;
                    };
                    let source = GlyphSource::new(
                        font,
                        slot,
                        resources
                            .font_texture_width(slot)
                            .ok_or(RenderError::InvalidFrame)?,
                    )
                    .ok_or(RenderError::InvalidFrame)?;
                    let revision = resources
                        .font_revision(slot)
                        .ok_or(RenderError::InvalidFrame)?;
                    let count = (data[1] >> 16) as usize;
                    let mut g = 0;
                    while g < count {
                        let gid = data[4 + 2 * g] as u16;
                        if gid >= font.glyph_count {
                            g += 1;
                            continue;
                        }
                        if let Some((page, changed)) =
                            self.fonts.get(source, revision, gid, self.submission)
                        {
                            let bytes = page.pixels.len() * 16;
                            // Vec<u128> only promises 8-byte alignment on MIPS.
                            // Keep the source page cached, but copy if an external
                            // allocator does not supply GE's 16-byte alignment.
                            let source_pixels =
                                core::slice::from_raw_parts(page.pixels.as_ptr().cast(), bytes);
                            let (pixels, buffer_width, bytes) = ge_texture_storage(
                                &mut self.pool,
                                source_pixels,
                                page.width,
                                page.height,
                                2,
                                true,
                            );
                            if changed || pixels != source_pixels.as_ptr() {
                                device.publish(pixels, bytes);
                            }
                            let binding = TextureBinding {
                                pixels,
                                bytes,
                                palette: core::ptr::null(),
                                palette_bytes: 0,
                                width: page.width,
                                height: page.height,
                                buffer_width,
                                psm: spec::psm::PSM_4444,
                                linear: font.raster_density != 1,
                            };
                            let (first, cols, cw, ch) = (
                                u32::from(page.first),
                                page.cols,
                                page.cell_width,
                                font.coverage_height(),
                            );
                            let mut end = g + 1;
                            while end < count && page.contains(data[4 + 2 * end] as u16) {
                                end += 1;
                            }
                            device.bind(Some(binding));
                            let v = self.textured((end - g) * 2);
                            for at in g..end {
                                let (x, y) = xy(data[3 + 2 * at]);
                                let id = (data[4 + 2 * at] & 65535) - first;
                                let (sx, sy) = (id % cols * cw, id / cols * ch);
                                let vi = (at - g) * 2;
                                v[vi] = VertTC::new(data[2], x, y, sx as i16, sy as i16);
                                v[vi + 1] = VertTC::new(
                                    data[2],
                                    add(x, cw / u32::from(font.raster_density))?,
                                    add(y, font.cell_h)?,
                                    (sx + cw) as i16,
                                    (sy + ch) as i16,
                                );
                            }
                            device.draw(Primitive::Sprites, Vertices::Textured(v));
                            device.bind(None);
                            g = end;
                        } else {
                            let (x, y) = xy(data[3 + 2 * g]);
                            self.paint_cpu_glyph(device, font, gid, x, y, data[2])?;
                            g += 1;
                        }
                    }
                }
                _ => return Err(RenderError::Unsupported),
            }
        }
        Ok(())
    }
    unsafe fn paint_cpu_glyph<D: Device>(
        &mut self,
        device: &mut D,
        font: FontView<'_>,
        gid: u16,
        gx: i16,
        gy: i16,
        color: u32,
    ) -> Result<(), RenderError> {
        let alpha = |x, y| glyph_alpha(color, logical_coverage(font, gid, x, y));
        let mut runs = 0;
        for y in 0..font.cell_h {
            let mut previous = 0;
            for x in 0..font.cell_w {
                let a = alpha(x, y);
                if a != 0 && a != previous {
                    runs += 1;
                }
                previous = a;
            }
        }
        if runs == 0 {
            return Ok(());
        }
        let v = self.colored(runs * 2);
        let mut at = 0;
        for y in 0..font.cell_h {
            let mut x = 0;
            while x < font.cell_w {
                let a = alpha(x, y);
                if a == 0 {
                    x += 1;
                    continue;
                }
                let start = x;
                while x < font.cell_w && alpha(x, y) == a {
                    x += 1;
                }
                let c = (color & 0xffffff) | ((a as u32) << 24);
                v[at] = VertC::new(c, add(gx, start)?, add(gy, y)?);
                v[at + 1] = VertC::new(c, add(gx, x)?, add(gy, y + 1)?);
                at += 2;
            }
        }
        device.draw(Primitive::Sprites, Vertices::Colored(v));
        Ok(())
    }
}
unsafe fn ge_storage(pool: &mut FramePool, bytes: &[u8], borrow: bool) -> *const u8 {
    if borrow && (bytes.as_ptr() as usize).is_multiple_of(16) {
        bytes.as_ptr()
    } else {
        let pointer = pool.alloc(bytes.len());
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
        pointer
    }
}
// Logical textures are tightly packed, while GE rounds the row pitch down to
// a multiple of 16 bytes and substitutes 16 for zero. Pad small rows instead
// of allowing the sampler to read the next allocation. The retained pool owns
// this copy through terminal retirement even for an explicit zero-copy call.
unsafe fn ge_texture_storage(
    pool: &mut FramePool,
    bytes: &[u8],
    width: u32,
    height: u32,
    pixel_bytes: u32,
    borrow: bool,
) -> (*const u8, u32, usize) {
    let row_bytes = (width * pixel_bytes) as usize;
    if row_bytes >= 16 {
        return (ge_storage(pool, bytes, borrow), width, bytes.len());
    }
    let size = 16 * height as usize;
    let pointer = pool.alloc(size);
    core::ptr::write_bytes(pointer, 0, size);
    for y in 0..height as usize {
        core::ptr::copy_nonoverlapping(
            bytes.as_ptr().add(y * row_bytes),
            pointer.add(y * 16),
            row_bytes,
        );
    }
    (pointer, 16 / pixel_bytes, size)
}
fn xy(word: u32) -> (i16, i16) {
    (word as u16 as i16, (word >> 16) as u16 as i16)
}
fn add(start: i16, amount: u32) -> Result<i16, RenderError> {
    i16::try_from(i64::from(start) + i64::from(amount)).map_err(|_| RenderError::InvalidFrame)
}
fn end_xy(x: i16, y: i16, wh: u32) -> Result<(i16, i16), RenderError> {
    Ok((add(x, wh & 65535)?, add(y, wh >> 16)?))
}
fn uv(word: u32, dimension: u32) -> Result<i16, RenderError> {
    let value = f32::from_bits(word) * dimension as f32;
    if !value.is_finite() || value < i16::MIN as f32 || value > i16::MAX as f32 {
        Err(RenderError::InvalidFrame)
    } else {
        Ok(value as i16)
    }
}
fn validate_texture(view: TexView<'_>) -> Result<(), RenderError> {
    if view.w == 0
        || view.h == 0
        || view.w > 512
        || view.h > 512
        || !view.w.is_power_of_two()
        || !view.h.is_power_of_two()
    {
        return Err(RenderError::Unsupported);
    }
    let bpp = match view.psm {
        spec::psm::PSM_5650 | spec::psm::PSM_4444 => 2,
        spec::psm::PSM_8888 => 4,
        spec::psm::PSM_T8 => 1,
        _ => return Err(RenderError::Unsupported),
    };
    if view.pixels.len() < (view.w * view.h * bpp) as usize
        || (view.psm == spec::psm::PSM_T8 && view.palette.is_none_or(|p| p.len() < 1024))
    {
        return Err(RenderError::InvalidFrame);
    }
    Ok(())
}
fn glyph_alpha(color: u32, coverage: u8) -> u8 {
    let base = color >> 24;
    let a = (base * u32::from(coverage) + 127) / 255;
    (((a + 8) / 17) * 17).min(255) as u8
}
fn logical_coverage(font: FontView<'_>, gid: u16, x: u32, y: u32) -> u8 {
    let density = u32::from(font.raster_density);
    let width = font.coverage_width();
    let height = font.coverage_height();
    let start = usize::from(gid) * width as usize * height as usize;
    let mut sum = 0;
    for dy in 0..density {
        for dx in 0..density {
            sum += u32::from(
                font.bitmap[start + ((y * density + dy) * width + x * density + dx) as usize],
            );
        }
    }
    ((sum + density * density / 2) / (density * density)) as u8
}
