//! GXM DrawList renderer. Hosts supply scenes and display presentation;
//! no retained UI tree or script engine belongs to this crate.
#![no_std]
extern crate alloc;
use alloc::{rc::Rc, vec::Vec};
use core::sync::atomic::{AtomicU32, Ordering};
use pocket_drivers::{
    DamageRect, DeviceTarget, FrameInput, PixelFormat, Rect, RenderError, RenderResources,
    Renderer, RendererDescriptor, Synchronization, Target, TargetOwnership,
};
use pocket_glyph_pages::{GlyphPageLayout, GlyphSampler};
use pocket_spec as spec;
use pocket_tex_cache::{TextureCache, TextureKey};
pub mod registered;
mod geometry;
#[cfg(target_os = "vita")]
pub mod native;
mod pixels;

/// Copied geometry, with logical coordinates converted to physical pixels
/// before Device::submit. GXM uses a fixed z of 0.5 for this UI pass.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct Vertex {
    pub position: [f32; 2],
    pub uv: [f32; 2],
    pub color: u32,
}
impl pocket_tri_batch::Vertex for Vertex {
    fn from_components(position: [f32; 2], uv: [f32; 2], color: u32) -> Self {
        Self {
            position,
            uv,
            color,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clip {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}
/// Texture zero means untextured vertex color. Other ids belong to Device.
pub type Command = pocket_tri_batch::Batch<u32, Clip>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextureFormat {
    Rgba,
    Coverage,
}

/// GXM operations used by this renderer, not an API shared with other GPUs.
///
/// # Safety
/// Texture ids must identify device-owned immutable storage until release.
/// submit must copy all borrowed geometry into GPU-visible owned storage and
/// retain it in Frame. On submit error it must stop GPU work before freeing
/// partial allocations. wait must end open scenes and reach a terminal GPU
/// state on both Ok and Err. release/retire run after terminal completion.
/// The device is confined to its owning render thread.
pub unsafe trait Device {
    type Frame;
    fn upload(
        &mut self,
        pixels: &[u8],
        width: u32,
        height: u32,
        format: TextureFormat,
        linear: bool,
    ) -> Result<u32, RenderError>;
    /// Rewrite an unreferenced allocation synchronously. The renderer never
    /// invokes this while a submission reads the texture. Errors invalidate
    /// that cache version, including errors after a partial write.
    fn update(
        &mut self,
        _id: u32,
        _pixels: &[u8],
        _width: u32,
        _height: u32,
        _format: TextureFormat,
        _linear: bool,
    ) -> Result<(), RenderError> {
        Err(RenderError::Unsupported)
    }
    fn release_texture(&mut self, id: u32);
    fn submit(
        &mut self,
        vertices: &[Vertex],
        commands: &[Command],
        clear: Option<u32>,
    ) -> Result<Self::Frame, RenderError>;
    fn wait(&mut self) -> Result<(), RenderError>;
    fn retire(&mut self, frame: Self::Frame);
    /// Open a shared scene for native 3D and one or more UI submissions.
    fn begin_external(&mut self, _clear: u32) -> Result<(), RenderError> {
        Err(RenderError::Unsupported)
    }
    /// Close an open scene and queue its display transfer without waiting.
    /// The device starts the transfer after the scene's rendering completes.
    fn flush(&mut self) -> Result<(), RenderError> {
        Err(RenderError::Unsupported)
    }
    /// Drain the display queue. Shutdown, guest reset and the compatibility
    /// `present` use it; Deferred frames do not wait for it.
    fn wait_display(&mut self) -> Result<(), RenderError> {
        Ok(())
    }
    /// Recycled storage can be trimmed at a closed guest boundary.
    fn reset_guest(&mut self) {}
}
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct Config {
    pub width: u32,
    pub height: u32,
    pub scale: u32,
    pub image_entries: usize,
    pub image_bytes: usize,
    pub glyph_pages: usize,
    pub glyph_bytes: usize,
    pub external_compositor: bool,
}
impl Config {
    pub const fn new(width: u32, height: u32, scale: u32) -> Self {
        Self {
            width,
            height,
            scale,
            image_entries: 256,
            image_bytes: 32 * 1024 * 1024,
            glyph_pages: 128,
            glyph_bytes: 8 * 1024 * 1024,
            external_compositor: false,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Submission {
    owner: u32,
    id: u64,
}
static OWNER: AtomicU32 = AtomicU32::new(1);
#[derive(Clone, Copy)]
struct ImageTexture {
    handle: i32,
    name: u32,
}
#[derive(Clone, Copy)]
struct GlyphTexture {
    sampler: GlyphSampler,
}
struct FontTexture {
    logical_w: u32,
    logical_h: u32,
    glyph_count: u16,
    pages: Vec<GlyphSampler>,
}
struct Pending<F> {
    id: u64,
    frame: F,
    terminal: Option<bool>,
}

pub struct GxmRenderer<D: Device> {
    device: D,
    config: Config,
    owner: u32,
    next: u64,
    pending: Vec<Pending<D::Frame>>,
    image_cache: TextureCache<ImageTexture>,
    glyph_cache: TextureCache<GlyphTexture>,
    glyph_keys: Vec<TextureKey>,
    image_keys: Vec<TextureKey>,
    images: Vec<ImageTexture>,
    fonts: Vec<Option<FontTexture>>,
    vertices: Vec<Vertex>,
    commands: Vec<Command>,
    white: u32,
    external: bool,
    failed: bool,
    _thread: core::marker::PhantomData<Rc<()>>,
}
impl<D: Device> GxmRenderer<D> {
    pub fn new(device: D, config: Config) -> Result<Self, RenderError> {
        if config.width == 0
            || config.height == 0
            || config.width > i32::MAX as u32
            || config.height > i32::MAX as u32
            || config.scale == 0
            || config.scale > 16
        {
            return Err(RenderError::InvalidFrame);
        }
        let owner = OWNER
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| RenderError::Failed)?;
        Ok(Self {
            device,
            config,
            owner,
            next: 1,
            pending: Vec::new(),
            image_cache: TextureCache::new(config.image_entries, config.image_bytes),
            glyph_cache: TextureCache::new(config.glyph_pages, config.glyph_bytes),
            glyph_keys: Vec::new(),
            image_keys: Vec::new(),
            images: Vec::new(),
            fonts: Vec::new(),
            vertices: Vec::new(),
            commands: Vec::new(),
            white: 0,
            external: false,
            failed: false,
            _thread: core::marker::PhantomData,
        })
    }
    pub fn target(&self) -> DeviceTarget {
        DeviceTarget::new(
            (self.owner as u64) << 32 | 1,
            Rect::new(0, 0, self.config.width, self.config.height),
            PixelFormat::Rgba8888,
        )
    }
    pub fn begin_frame(&mut self, clear: u32) -> Result<(), RenderError> {
        if self.external {
            return Err(RenderError::Failed);
        }
        self.finish()?;
        self.device.begin_external(clear)?;
        self.external = true;
        self.failed = false;
        Ok(())
    }
    /// The compatibility scene can contain native 3D and several UI passes.
    /// Finish GPU work, queue the display swap, then retire. Retirement frees
    /// only vertex and texture storage the GPU wait covers; the display queue
    /// is not drained.
    pub fn present(&mut self) -> Result<(), RenderError> {
        let gpu = self.finish();
        self.external = false;
        let result = if gpu.is_ok() && !self.failed {
            self.device.flush()
        } else {
            Err(RenderError::Failed)
        };
        while let Some(pending) = self.pending.last() {
            self.retire(Submission {
                owner: self.owner,
                id: pending.id,
            });
        }
        result
    }
    /// DeviceOwned DisplayOutput half of a Deferred coordinator frame: close
    /// the UI scene and queue its swap behind the GPU work. The renderer wait
    /// follows at the next present. A flush error waits for the scene before
    /// returning, so no queued work survives it.
    pub fn queue_display(&mut self) -> Result<(), RenderError> {
        self.external = false;
        if self.failed {
            let _ = self.finish();
            return Err(RenderError::Failed);
        }
        let result = self.device.flush();
        if result.is_err() {
            let _ = self.finish();
        }
        result
    }
    /// Wait for the GPU, then queue the display swap. Direct embedding calls
    /// use this order; the registered display uses `queue_display`.
    pub fn flush_display(&mut self) -> Result<(), RenderError> {
        let result = self.finish();
        self.external = false;
        result?;
        if self.failed {
            return Err(RenderError::Failed);
        }
        let result = self.device.flush();
        if result.is_err() {
            let _ = self.device.wait_display();
        }
        result
    }
    pub fn wait_display(&mut self) -> Result<(), RenderError> {
        self.device.wait_display()
    }
    /// Close a native scene after a coordinator error without displaying a
    /// partial frame. No borrowed frame data survives this terminal boundary.
    pub fn discard_frame(&mut self) -> Result<(), RenderError> {
        let result = self.finish();
        self.external = false;
        while let Some(pending) = self.pending.last() {
            self.retire(Submission {
                owner: self.owner,
                id: pending.id,
            });
        }
        result
    }
    fn finish(&mut self) -> Result<(), RenderError> {
        let result = self.device.wait();
        for pending in &mut self.pending {
            if pending.terminal.is_none() {
                pending.terminal = Some(result.is_ok());
            }
        }
        result
    }
    pub fn invalidate_texture(&mut self, handle: i32) {
        for key in &self.image_keys {
            if key.handle == handle {
                self.image_cache.invalidate(*key);
            }
        }
    }
    pub fn invalidate_font(&mut self, slot: u8) {
        for key in &self.glyph_keys {
            if key.handle as u32 >> 16 == slot as u32 {
                self.glyph_cache.invalidate(*key);
            }
        }
    }
    pub fn reset_guest(&mut self) -> Result<(), RenderError> {
        if self.external {
            return Err(RenderError::Failed);
        }
        self.finish()?;
        while let Some(pending) = self.pending.last() {
            self.retire(Submission {
                owner: self.owner,
                id: pending.id,
            });
        }
        self.image_cache
            .clear(|image| self.device.release_texture(image.name))
            .map_err(|_| RenderError::Failed)?;
        self.glyph_cache
            .clear(|page| self.device.release_texture(page.sampler.handle))
            .map_err(|_| RenderError::Failed)?;
        self.image_keys.clear();
        self.glyph_keys.clear();
        self.images.clear();
        self.fonts.clear();
        self.device.reset_guest();
        Ok(())
    }
    pub fn texture_resident(&self, handle: i32) -> bool {
        self.image_keys
            .iter()
            .any(|key| key.handle == handle && self.image_cache.get(*key).is_some())
    }
    pub fn font_resident(&self, slot: u8) -> bool {
        self.glyph_keys.iter().any(|key| {
            key.handle as u32 >> 16 == slot as u32 && self.glyph_cache.get(*key).is_some()
        })
    }
    fn image(
        &mut self,
        res: &dyn RenderResources,
        handle: i32,
        id: u64,
    ) -> Result<(), RenderError> {
        if self.images.iter().any(|image| image.handle == handle) {
            return Ok(());
        }
        let Some(view) = res.texture(handle) else {
            return Ok(());
        };
        if view.w == 0 || view.h == 0 || view.w > spec::TEX_MAX_DIM || view.h > spec::TEX_MAX_DIM {
            return Err(RenderError::InvalidFrame);
        }
        let key = TextureKey {
            handle,
            revision: res
                .texture_revision(handle)
                .unwrap_or(res.raster_revision()),
        };
        // Native CDRAM allocation has 8-texel pitch and 256 KiB granularity.
        let bytes = texture_bytes(view.w, view.h, 4).ok_or(RenderError::InvalidFrame)?;
        if self.image_cache.get(key).is_none() {
            if let Some(old) = self
                .image_keys
                .iter()
                .rev()
                .find(|old| old.handle == handle)
                .copied()
            {
                let device = &mut self.device;
                let updated = self
                    .image_cache
                    .update_unreferenced(old, key, bytes, |image| {
                        let pixels = pixels::texture_rgba(view).ok_or(RenderError::InvalidFrame)?;
                        device.update(
                            image.name,
                            &pixels,
                            view.w,
                            view.h,
                            TextureFormat::Rgba,
                            view.linear,
                        )
                    });
                match updated {
                    Ok(_) | Err(RenderError::Unsupported) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        let mut released = Vec::new();
        let device = &mut self.device;
        let result = self
            .image_cache
            .get_or_upload(
                key,
                bytes,
                Some(id),
                || {
                    let pixels = pixels::texture_rgba(view).ok_or(RenderError::InvalidFrame)?;
                    device
                        .upload(&pixels, view.w, view.h, TextureFormat::Rgba, view.linear)
                        .map(|name| ImageTexture { handle, name })
                },
                |image| released.push(image.name),
            )
            .copied();
        for name in released {
            self.device.release_texture(name);
        }
        let image = result.map_err(cache_error)?;
        self.image_keys
            .retain(|old| old.handle != handle && self.image_cache.get(*old).is_some());
        self.image_keys.push(key);
        self.images.push(image);
        Ok(())
    }
    fn glyph(
        &mut self,
        res: &dyn RenderResources,
        slot: u8,
        gid: u16,
        id: u64,
    ) -> Result<(), RenderError> {
        let Some(font) = res.font_atlas(slot) else {
            return Ok(());
        };
        if gid >= font.glyph_count {
            return Ok(());
        }
        let layout =
            GlyphPageLayout::with_limit(font, gid, 2048).ok_or(RenderError::InvalidFrame)?;
        if self.fonts.len() <= slot as usize {
            self.fonts.resize_with(slot as usize + 1, || None);
        }
        let metadata = self.fonts[slot as usize].get_or_insert_with(|| FontTexture {
            logical_w: font.cell_w,
            logical_h: font.cell_h,
            glyph_count: font.glyph_count,
            pages: Vec::new(),
        });
        if metadata.pages.iter().any(|page| page.contains(gid)) {
            return Ok(());
        }
        let key = TextureKey {
            handle: (((slot as u32) << 16) | layout.page()) as i32,
            revision: res.font_revision(slot).unwrap_or(res.raster_revision()),
        };
        let bytes =
            texture_bytes(layout.width(), layout.height(), 1).ok_or(RenderError::InvalidFrame)?;
        let mut released = Vec::new();
        let device = &mut self.device;
        let result = self
            .glyph_cache
            .get_or_upload(
                key,
                bytes,
                Some(id),
                || {
                    let mut pixels = alloc::vec![0;layout.coverage_bytes()];
                    if !layout.expand_a8(font, &mut pixels) {
                        return Err(RenderError::InvalidFrame);
                    }
                    device
                        .upload(
                            &pixels,
                            layout.width(),
                            layout.height(),
                            TextureFormat::Coverage,
                            false,
                        )
                        .map(|name| GlyphTexture {
                            sampler: layout.sampler(name),
                        })
                },
                |page| released.push(page.sampler.handle),
            )
            .copied();
        for name in released {
            self.device.release_texture(name);
        }
        let page = result.map_err(cache_error)?;
        self.glyph_keys
            .retain(|old| old.handle != key.handle && self.glyph_cache.get(*old).is_some());
        self.glyph_keys.push(key);
        metadata.pages.push(page.sampler);
        Ok(())
    }
    fn prepare(
        &mut self,
        frame: &FrameInput<'_>,
        id: u64,
        logical: DamageRect,
    ) -> Result<(), RenderError> {
        self.images.clear();
        self.fonts.clear();
        for operation in pocket_draw_ops::DrawOps::new(&frame.list.words, logical) {
            let op = operation.map_err(|_| RenderError::InvalidFrame)?;
            match op.opcode {
                spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI => {
                    self.image(frame.resources, op.words[1] as i32, id)?
                }
                spec::draw_op::GLYPH_RUN => {
                    for glyph in op.words[3..].as_chunks::<2>().0 {
                        self.glyph(frame.resources, op.words[1] as u8, glyph[1] as u16, id)?;
                    }
                }
                spec::draw_op::TEXT_RUN => return Err(RenderError::Unsupported),
                spec::draw_op::SURFACE_QUAD if !self.config.external_compositor => {
                    return Err(RenderError::Unsupported)
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn render_inner(
        &mut self,
        frame: &mut FrameInput<'_>,
        id: u64,
    ) -> Result<D::Frame, RenderError> {
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::Unsupported);
        };
        if target.handle != self.target().handle
            || target.format != PixelFormat::Rgba8888
            || target.region != self.target().region
        {
            return Err(RenderError::InvalidFrame);
        }
        let (w, h) = frame.resources.viewport();
        if !w.is_finite()
            || !h.is_finite()
            || w < 1.0
            || h < 1.0
            || w >= i32::MAX as f32
            || h >= i32::MAX as f32
        {
            return Err(RenderError::InvalidFrame);
        }
        let (w, h) = (w as u32, h as u32);
        if w.checked_mul(self.config.scale) != Some(self.config.width)
            || h.checked_mul(self.config.scale) != Some(self.config.height)
        {
            return Err(RenderError::InvalidFrame);
        }
        let logical = DamageRect::new(0, 0, w as i32, h as i32);
        pocket_draw_ops::validate(&frame.list.words, logical)
            .map_err(|_| RenderError::InvalidFrame)?;
        self.prepare(frame, id, logical)?;
        self.build(&frame.list.words, w, h)?;
        for vertex in &mut self.vertices {
            vertex.position[0] *= self.config.scale as f32;
            vertex.position[1] *= self.config.scale as f32;
        }
        for command in &mut self.commands {
            command.clip.x *= self.config.scale as i32;
            command.clip.y *= self.config.scale as i32;
            command.clip.w *= self.config.scale as i32;
            command.clip.h *= self.config.scale as i32;
        }
        self.device.submit(
            &self.vertices,
            &self.commands,
            if self.external {
                None
            } else {
                Some(0xff00_0000)
            },
        )
    }
}
fn cache_error(error: pocket_tex_cache::CacheError<RenderError>) -> RenderError {
    match error {
        pocket_tex_cache::CacheError::Upload(error) => error,
        _ => RenderError::Failed,
    }
}
pub fn texture_bytes(w: u32, h: u32, bpp: usize) -> Option<usize> {
    let bytes = (w as usize)
        .div_ceil(8)
        .checked_mul(8)?
        .checked_mul(h as usize)?
        .checked_mul(bpp)?;
    bytes
        .checked_add(256 * 1024 - 1)
        .map(|n| n / (256 * 1024) * (256 * 1024))
}
impl<D: Device> Renderer for GxmRenderer<D> {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgba8888],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        let id = self.next;
        let Some(next) = id.checked_add(1) else {
            self.failed = true;
            let _ = self.finish();
            return Err(RenderError::Failed);
        };
        self.next = next;
        match self.render_inner(frame, id) {
            Ok(frame) => {
                self.pending.push(Pending {
                    id,
                    frame,
                    terminal: None,
                });
                Ok(Submission {
                    owner: self.owner,
                    id,
                })
            }
            Err(error) => {
                self.failed = true;
                let _ = self.finish();
                self.image_cache
                    .retire(id, |image| self.device.release_texture(image.name));
                self.glyph_cache
                    .retire(id, |page| self.device.release_texture(page.sampler.handle));
                Err(error)
            }
        }
    }
    unsafe fn render_zero_copy(
        &mut self,
        _: &mut FrameInput<'_>,
    ) -> Result<Submission, RenderError> {
        Err(RenderError::Unsupported)
    }
    fn wait(&mut self, token: &Submission) -> Result<(), RenderError> {
        if token.owner != self.owner {
            return Err(RenderError::InvalidFrame);
        }
        let pending = self
            .pending
            .iter()
            .find(|pending| pending.id == token.id)
            .ok_or(RenderError::InvalidFrame)?;
        match pending.terminal {
            Some(true) => Ok(()),
            Some(false) => Err(RenderError::Failed),
            None => self.finish(),
        }
    }
    fn retire(&mut self, token: Submission) {
        if token.owner != self.owner {
            return;
        }
        let Some(index) = self
            .pending
            .iter()
            .position(|pending| pending.id == token.id)
        else {
            return;
        };
        if self.pending[index].terminal.is_none() {
            let _ = self.finish();
        }
        let pending = self.pending.remove(index);
        self.device.retire(pending.frame);
        self.image_cache
            .retire(token.id, |image| self.device.release_texture(image.name));
        self.glyph_cache.retire(token.id, |page| {
            self.device.release_texture(page.sampler.handle)
        });
    }
}
impl<D: Device> Drop for GxmRenderer<D> {
    fn drop(&mut self) {
        let _ = self.finish();
        let _ = self.device.wait_display();
        while let Some(p) = self.pending.last() {
            self.retire(Submission {
                owner: self.owner,
                id: p.id,
            });
        }
        let _ = self
            .image_cache
            .clear(|image| self.device.release_texture(image.name));
        let _ = self
            .glyph_cache
            .clear(|page| self.device.release_texture(page.sampler.handle));
        self.device.reset_guest();
    }
}

#[cfg(test)]
mod tests;

// UINT16_MAX is divisible by three; every native draw stays within vita2d's
// 16-bit linear index storage and starts at the next complete triangle.
#[cfg(any(target_os = "vita", test))]
fn triangle_ranges(count: usize) -> impl Iterator<Item = core::ops::Range<usize>> {
    (0..count)
        .step_by(u16::MAX as usize)
        .map(move |start| start..start.saturating_add(u16::MAX as usize).min(count))
}
