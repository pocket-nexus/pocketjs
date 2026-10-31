//! Instance GLES renderer. The platform supplies context ownership.
#![no_std]
extern crate alloc;

use alloc::{rc::Rc, vec::Vec};
use core::{
    ffi::c_void,
    mem::size_of,
    sync::atomic::{AtomicU32, Ordering},
};
use pocket_drivers::{
    DamageRect, DeviceTarget, FrameInput, PixelFormat, Rect, RenderError, RenderResources,
    Renderer, RendererDescriptor, Synchronization, Target, TargetOwnership,
};
use pocket_glyph_pages::{GlyphPageLayout, GlyphSampler};
use pocket_spec as spec;
use pocket_tex_cache::{TextureCache, TextureKey};
mod geometry;
mod pixels;
pub mod raw;
use pixels::*;
use raw::*;

/// A pipeline only runs while its renderer's context is current.
///
/// # Safety
/// Implementations must use the owning context, retain no caller memory, and
/// preserve the shared vertex layout (position/UV/RGBA at byte offsets 0/8/16).
pub unsafe trait Pipeline: Sized {
    /// # Safety
    /// The owning context must be current; construction must clean up on failure.
    unsafe fn new() -> Option<Self>;
    /// # Safety
    /// The owning context must be current, with all submissions completed.
    unsafe fn destroy(&mut self);
    /// # Safety
    /// The owning context must be current and viewport dimensions positive.
    unsafe fn begin_frame(&self, width: f32, height: f32);
    /// # Safety
    /// The owning context must be current.
    unsafe fn set_blend(&self);
    /// # Safety
    /// A driver-owned VBO must be bound in the current context. Its vertices
    /// must use the documented position/UV/color layout and supplied stride.
    unsafe fn bind_vertices(&self, stride: GLsizei);
    /// # Safety
    /// The owning context must be current.
    unsafe fn unbind_vertices(&self);
}

/// Platform-owned context activation and native framebuffer binding.
///
/// # Safety
/// Success must make this renderer's context current on the calling thread.
/// The context and its GL entry points remain valid through driver destruction.
/// An `ensure_current` error must mean context loss has stopped all GPU work;
/// it cannot mean a temporary failure to acquire a still-running context.
/// `bind_target` must validate its own native target before accessing it. The
/// driver calls it only after successful activation. It must retain no borrow.
pub unsafe trait ContextAccess {
    type NativeTarget;
    fn ensure_current(&mut self) -> Result<(), RenderError>;
    fn bind_target(&mut self, target: &Self::NativeTarget) -> Result<(), RenderError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ClearMode {
    OpaqueBlack,
    Preserve,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Viewport {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Viewport {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// The viewport maps logical pixels into the device target. Window dimensions
/// supply the GL bottom-left conversion. A native compositor can own surface
/// quads; otherwise those records are rejected before any drawing.
#[non_exhaustive]
pub struct TargetConfig<T> {
    pub native: T,
    pub window_width: u32,
    pub window_height: u32,
    pub viewport: Viewport,
    pub format: PixelFormat,
    pub clear: ClearMode,
    pub external_compositor: bool,
}

impl<T> TargetConfig<T> {
    pub fn new(native: T, window: [u32; 2], viewport: Viewport, format: PixelFormat) -> Self {
        Self {
            native,
            window_width: window[0],
            window_height: window[1],
            viewport,
            format,
            clear: ClearMode::OpaqueBlack,
            external_compositor: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Submission {
    owner: u32,
    id: u64,
}
pub type Trace = extern "C" fn(u32, u32, u32);
static NEXT_OWNER: AtomicU32 = AtomicU32::new(1);

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Vertex {
    position: [f32; 2],
    uv: [f32; 2],
    color: u32,
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
struct Clip {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}
type Command = pocket_tri_batch::Batch<GLuint, Clip>;
#[derive(Clone, Copy)]
struct ImageTexture {
    handle: i32,
    name: GLuint,
    white_uv: Option<[f32; 2]>,
}
#[derive(Clone, Copy)]
struct GlyphTexture {
    name: GLuint,
    sampler: GlyphSampler,
    white_uv: Option<[f32; 2]>,
}
struct FontTexture {
    logical_w: u32,
    logical_h: u32,
    glyph_count: u16,
    pages: Vec<GlyphSampler>,
}
struct Pending {
    id: u64,
    target: u64,
    buffer: GLuint,
    terminal: Option<bool>,
}
struct Registered<T> {
    handle: u64,
    config: TargetConfig<T>,
}

/// Resident GPU texture limits. Upload staging may coexist with the cache;
/// pending VBOs and the four-byte white texture are outside these limits.
/// Images charge four bytes per pixel even when the upload uses two-byte LA.
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct CacheLimits {
    pub image_entries: usize,
    pub image_bytes: usize,
    pub glyph_pages: usize,
    pub glyph_bytes: usize,
}
impl CacheLimits {
    pub const fn new(
        image_entries: usize,
        image_bytes: usize,
        glyph_pages: usize,
        glyph_bytes: usize,
    ) -> Self {
        Self {
            image_entries,
            image_bytes,
            glyph_pages,
            glyph_bytes,
        }
    }
}
impl Default for CacheLimits {
    fn default() -> Self {
        Self {
            image_entries: 512,
            image_bytes: 64 * 1024 * 1024,
            glyph_pages: 128,
            glyph_bytes: 4 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct CacheUsage {
    pub image_entries: usize,
    pub image_bytes: usize,
    pub glyph_pages: usize,
    pub glyph_bytes: usize,
}

/// One GLES context's renderer. It never owns or traverses a retained UI tree.
/// Each queued submission owns a VBO and retains its GPU texture versions.
pub struct GlesRenderer<P: Pipeline, C: ContextAccess> {
    pipeline: P,
    context: C,
    owner: u32,
    next_target: u32,
    next_submission: u64,
    targets: Vec<Registered<C::NativeTarget>>,
    pending: Vec<Pending>,
    white: GLuint,
    image_cache: TextureCache<ImageTexture>,
    glyph_cache: TextureCache<GlyphTexture>,
    glyph_keys: Vec<TextureKey>,
    images: Vec<ImageTexture>,
    fonts: Vec<Option<FontTexture>>,
    vertices: Vec<Vertex>,
    commands: Vec<Command>,
    max_texture_size: u32,
    trace: Option<Trace>,
    lost: bool,
    swap_synchronized: bool,
    _thread: core::marker::PhantomData<Rc<()>>,
}

impl<P: Pipeline, C: ContextAccess> GlesRenderer<P, C> {
    pub fn new(context: C) -> Result<Self, RenderError> {
        Self::with_limits(context, CacheLimits::default())
    }
    pub fn with_limits(mut context: C, limits: CacheLimits) -> Result<Self, RenderError> {
        context.ensure_current()?;
        let owner = NEXT_OWNER
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| RenderError::Failed)?;
        unsafe {
            clear_errors();
            let mut pipeline = P::new().ok_or(RenderError::Failed)?;
            let mut max = 0;
            glGetIntegerv(GL_MAX_TEXTURE_SIZE, &mut max);
            if max <= 0 || glGetError() != GL_NO_ERROR {
                pipeline.destroy();
                return Err(RenderError::Failed);
            }
            let white = match upload_texture(&[255; 4], 1, 1, GL_RGBA, false) {
                Some(name) => name,
                None => {
                    pipeline.destroy();
                    return Err(RenderError::Failed);
                }
            };
            Ok(Self {
                pipeline,
                context,
                owner,
                next_target: 1,
                next_submission: 1,
                targets: Vec::new(),
                pending: Vec::new(),
                white,
                image_cache: TextureCache::new(limits.image_entries, limits.image_bytes),
                glyph_cache: TextureCache::new(limits.glyph_pages, limits.glyph_bytes),
                glyph_keys: Vec::new(),
                images: Vec::new(),
                fonts: Vec::new(),
                vertices: Vec::new(),
                commands: Vec::new(),
                max_texture_size: max as u32,
                trace: None,
                lost: false,
                swap_synchronized: false,
                _thread: core::marker::PhantomData,
            })
        }
    }
    fn valid_config(config: &TargetConfig<C::NativeTarget>) -> bool {
        let v = config.viewport;
        config.window_width > 0
            && config.window_height > 0
            && config.window_width <= i32::MAX as u32
            && config.window_height <= i32::MAX as u32
            && v.width > 0
            && v.height > 0
            && v.width <= i32::MAX as u32
            && v.height <= i32::MAX as u32
            && (v.x as i64 + v.width as i64) <= i32::MAX as i64
            && (v.y as i64 + v.height as i64) <= i32::MAX as i64
            && i32::try_from(config.window_height as i64 - v.y as i64).is_ok()
            && i32::try_from(config.window_height as i64 - v.y as i64 - v.height as i64).is_ok()
            && matches!(
                config.format,
                PixelFormat::Rgb565 | PixelFormat::Rgba8888 | PixelFormat::Argb8888
            )
    }
    pub fn register_target(
        &mut self,
        config: TargetConfig<C::NativeTarget>,
    ) -> Result<u64, RenderError> {
        if !Self::valid_config(&config) {
            return Err(RenderError::InvalidFrame);
        }
        let serial = self.next_target;
        self.next_target = serial.checked_add(1).ok_or(RenderError::Failed)?;
        let handle = ((self.owner as u64) << 32) | serial as u64;
        self.targets.push(Registered { handle, config });
        Ok(handle)
    }
    pub fn unregister_target(&mut self, handle: u64) -> Result<(), RenderError> {
        if self.pending.iter().any(|p| p.target == handle) {
            return Err(RenderError::Failed);
        }
        let index = self
            .targets
            .iter()
            .position(|target| target.handle == handle)
            .ok_or(RenderError::InvalidFrame)?;
        self.targets.remove(index);
        Ok(())
    }
    pub fn target(&self, handle: u64) -> Result<DeviceTarget, RenderError> {
        let target = &self
            .targets
            .iter()
            .find(|target| target.handle == handle)
            .ok_or(RenderError::InvalidFrame)?
            .config;
        Ok(DeviceTarget::new(
            handle,
            Rect::new(0, 0, target.window_width, target.window_height),
            target.format,
        ))
    }
    pub fn cache_usage(&self) -> CacheUsage {
        CacheUsage {
            image_entries: self.image_cache.len(),
            image_bytes: self.image_cache.resident_bytes(),
            glyph_pages: self.glyph_cache.len(),
            glyph_bytes: self.glyph_cache.resident_bytes(),
        }
    }
    pub fn set_trace(&mut self, trace: Option<Trace>) {
        self.trace = trace;
    }
    /// The platform presents with a buffer swap right after this renderer, on the
    /// same context, and keeps no CPU reads of the target. Waiting then needs no
    /// `glFinish`: the swap orders the frame and GL defers deleting what is in use.
    /// A `glFinish` before a swap makes the CPU wait out the GPU's whole frame.
    pub fn set_swap_synchronized(&mut self, enabled: bool) {
        self.swap_synchronized = enabled;
    }
    fn trace(&self, stage: u32) {
        if let Some(callback) = self.trace {
            callback(
                stage,
                self.commands.len() as u32,
                self.vertices.len() as u32,
            );
        }
    }
    pub fn invalidate_resources(&mut self) {
        self.image_cache.invalidate_all();
        self.glyph_cache.invalidate_all();
        self.glyph_keys.clear();
    }
    pub fn invalidate_font(&mut self, slot: u8) {
        for key in &self.glyph_keys {
            if (key.handle as u32 >> 16) == slot as u32 {
                self.glyph_cache.invalidate(*key);
            }
        }
    }
    fn activate(&mut self) -> Result<(), RenderError> {
        if self.lost {
            return Err(RenderError::Failed);
        }
        if let Err(error) = self.context.ensure_current() {
            self.lost = true;
            for pending in &mut self.pending {
                pending.terminal = Some(false);
            }
            return Err(error);
        }
        Ok(())
    }
    fn finish(&mut self) -> Result<(), RenderError> {
        self.activate()?;
        if !self.swap_synchronized {
            unsafe {
                glFinish();
            }
        }
        let ok = unsafe { glGetError() == GL_NO_ERROR };
        for pending in &mut self.pending {
            if pending.terminal.is_none() {
                pending.terminal = Some(ok);
            }
        }
        if ok {
            Ok(())
        } else {
            Err(RenderError::Failed)
        }
    }
    pub fn reset_resources(&mut self) -> Result<(), RenderError> {
        self.finish()?;
        // Completed submissions still belong to their display until retire.
        self.invalidate_resources();
        unsafe {
            self.image_cache
                .collect(|image| glDeleteTextures(1, &image.name));
            self.glyph_cache
                .collect(|page| glDeleteTextures(1, &page.name));
        }
        Ok(())
    }
    unsafe fn image(
        &mut self,
        resources: &dyn RenderResources,
        handle: i32,
        submission: u64,
    ) -> Result<(), RenderError> {
        if self.images.iter().any(|image| image.handle == handle) {
            return Ok(());
        }
        let Some(view) = resources.texture(handle) else {
            return Ok(());
        };
        if view.w == 0
            || view.h == 0
            || view.w > self.max_texture_size
            || view.h > self.max_texture_size
        {
            return Err(RenderError::InvalidFrame);
        }
        let key = TextureKey {
            handle,
            revision: resources
                .texture_revision(handle)
                .unwrap_or(resources.raster_revision()),
        };
        let bytes = (view.w as usize)
            .checked_mul(view.h as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or(RenderError::InvalidFrame)?;
        let image = *self
            .image_cache
            .get_or_upload(
                key,
                bytes,
                Some(submission),
                || {
                    let (pixels, format, channels) =
                        if let Some(la) = coverage_luminance_alpha(view) {
                            (la, GL_LUMINANCE_ALPHA, 2)
                        } else {
                            (
                                texture_rgba(view).ok_or(RenderError::InvalidFrame)?,
                                GL_RGBA,
                                4,
                            )
                        };
                    let white_uv = white_patch(&pixels, view.w, view.h, channels);
                    let name = upload_texture(&pixels, view.w, view.h, format, view.linear)
                        .ok_or(RenderError::Failed)?;
                    Ok::<_, RenderError>(ImageTexture {
                        handle,
                        name,
                        white_uv,
                    })
                },
                |image| glDeleteTextures(1, &image.name),
            )
            .map_err(|error| match error {
                pocket_tex_cache::CacheError::Upload(error) => error,
                _ => RenderError::Failed,
            })?;
        self.images.push(image);
        Ok(())
    }
    unsafe fn glyph(
        &mut self,
        resources: &dyn RenderResources,
        slot: u8,
        gid: u16,
        submission: u64,
    ) -> Result<(), RenderError> {
        let Some(font) = resources.font_atlas(slot) else {
            return Ok(());
        };
        if gid >= font.glyph_count {
            return Ok(());
        }
        let layout =
            GlyphPageLayout::with_limit(font, gid, self.max_texture_size.min(spec::TEX_MAX_DIM))
                .ok_or(RenderError::InvalidFrame)?;
        if self.fonts.len() <= slot as usize {
            self.fonts.resize_with(slot as usize + 1, || None);
        }
        let cached = self.fonts[slot as usize].get_or_insert_with(|| FontTexture {
            logical_w: font.cell_w,
            logical_h: font.cell_h,
            glyph_count: font.glyph_count,
            pages: Vec::new(),
        });
        if cached.pages.iter().any(|page| page.contains(gid)) {
            return Ok(());
        }
        let key = TextureKey {
            handle: (((slot as u32) << 16) | layout.page()) as i32,
            revision: resources
                .font_revision(slot)
                .unwrap_or(resources.raster_revision()),
        };
        let bytes = layout
            .coverage_bytes()
            .checked_mul(2)
            .ok_or(RenderError::InvalidFrame)?;
        let page = *self
            .glyph_cache
            .get_or_upload(
                key,
                bytes,
                Some(submission),
                || {
                    let mut coverage = alloc::vec![0;layout.coverage_bytes()];
                    if !layout.expand_a8(font, &mut coverage) {
                        return Err(RenderError::InvalidFrame);
                    }
                    let mut pixels = Vec::with_capacity(bytes);
                    for alpha in coverage {
                        pixels.extend_from_slice(&[255, alpha]);
                    }
                    let white_uv = white_patch(&pixels, layout.width(), layout.height(), 2);
                    let name = upload_texture(
                        &pixels,
                        layout.width(),
                        layout.height(),
                        GL_LUMINANCE_ALPHA,
                        true,
                    )
                    .ok_or(RenderError::Failed)?;
                    Ok::<_, RenderError>(GlyphTexture {
                        name,
                        sampler: layout.sampler(name),
                        white_uv,
                    })
                },
                |page| glDeleteTextures(1, &page.name),
            )
            .map_err(|error| match error {
                pocket_tex_cache::CacheError::Upload(error) => error,
                _ => RenderError::Failed,
            })?;
        // get_or_upload invalidates older revisions of this page. They can
        // remain pinned, but invalidate_font only needs the current key.
        self.glyph_keys
            .retain(|old| old.handle != key.handle && self.glyph_cache.get(*old).is_some());
        self.glyph_keys.push(key);
        cached.pages.push(page.sampler);
        self.images.push(ImageTexture {
            handle: -1,
            name: page.name,
            white_uv: page.white_uv,
        });
        Ok(())
    }
    unsafe fn prepare(
        &mut self,
        frame: &FrameInput<'_>,
        submission: u64,
        viewport: DamageRect,
        compositor: bool,
    ) -> Result<(), RenderError> {
        self.images.clear();
        self.fonts.clear();
        for op in pocket_draw_ops::DrawOps::new(&frame.list.words, viewport) {
            let op = op.map_err(|_| RenderError::InvalidFrame)?;
            match op.opcode {
                spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI => {
                    self.image(frame.resources, op.words[1] as i32, submission)?
                }
                spec::draw_op::GLYPH_RUN => {
                    let slot = op.words[1] as u8;
                    for glyph in op.words[3..].as_chunks::<2>().0 {
                        self.glyph(frame.resources, slot, glyph[1] as u16, submission)?;
                    }
                }
                spec::draw_op::SURFACE_QUAD if !compositor => return Err(RenderError::Unsupported),
                spec::draw_op::TEXT_RUN => return Err(RenderError::Unsupported),
                _ => {}
            }
        }
        Ok(())
    }
}

impl<P: Pipeline, C: ContextAccess> Renderer for GlesRenderer<P, C> {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[
                PixelFormat::Rgb565,
                PixelFormat::Rgba8888,
                PixelFormat::Argb8888,
            ],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        let result = self.render_inner(frame);
        if result.is_err() {
            let _ = self.finish();
        }
        result
    }
    unsafe fn render_zero_copy(
        &mut self,
        _frame: &mut FrameInput<'_>,
    ) -> Result<Submission, RenderError> {
        Err(RenderError::Unsupported)
    }
    fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
        if submission.owner != self.owner {
            return Err(RenderError::InvalidFrame);
        }
        let pending = self
            .pending
            .iter()
            .find(|pending| pending.id == submission.id)
            .ok_or(RenderError::InvalidFrame)?;
        match pending.terminal {
            Some(true) => Ok(()),
            Some(false) => Err(RenderError::Failed),
            None => self.finish(),
        }
    }
    fn retire(&mut self, submission: Submission) {
        if submission.owner != self.owner {
            return;
        }
        let Some(index) = self
            .pending
            .iter()
            .position(|pending| pending.id == submission.id)
        else {
            return;
        };
        if self.pending[index].terminal.is_none() {
            let _ = self.finish();
        }
        let pending = self.pending.remove(index);
        let live = !self.lost;
        // Context activation is required even for already completed work: the
        // platform may have switched contexts while the display was waiting.
        let live = live && self.activate().is_ok();
        unsafe {
            if live && pending.buffer != 0 {
                glDeleteBuffers(1, &pending.buffer);
            }
            self.image_cache.retire(submission.id, |texture| {
                if live {
                    glDeleteTextures(1, &texture.name)
                }
            });
            self.glyph_cache.retire(submission.id, |page| {
                if live {
                    glDeleteTextures(1, &page.name)
                }
            });
        }
    }
}
impl<P: Pipeline, C: ContextAccess> Drop for GlesRenderer<P, C> {
    fn drop(&mut self) {
        let _ = self.finish();
        while let Some(pending) = self.pending.last() {
            self.retire(Submission {
                owner: self.owner,
                id: pending.id,
            });
        }
        let live = !self.lost;
        unsafe {
            let _ = self.image_cache.clear(|texture| {
                if live {
                    glDeleteTextures(1, &texture.name)
                }
            });
            let _ = self.glyph_cache.clear(|page| {
                if live {
                    glDeleteTextures(1, &page.name)
                }
            });
            if live {
                glDeleteTextures(1, &self.white);
                self.pipeline.destroy();
            }
        }
    }
}

impl<P: Pipeline, C: ContextAccess> GlesRenderer<P, C> {
    fn render_inner(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::Unsupported);
        };
        let handle = target.handle;
        let region = target.region;
        let index = self
            .targets
            .iter()
            .position(|registered| registered.handle == handle)
            .ok_or(RenderError::InvalidFrame)?;
        let config = &self.targets[index].config;
        if target.format != config.format
            || region.width == 0
            || region.height == 0
            || region
                .x
                .checked_add(region.width)
                .is_none_or(|end| end > config.window_width)
            || region
                .y
                .checked_add(region.height)
                .is_none_or(|end| end > config.window_height)
        {
            return Err(RenderError::InvalidFrame);
        }
        let (window_width, window_height, viewport, clear, compositor) = (
            config.window_width,
            config.window_height,
            config.viewport,
            config.clear,
            config.external_compositor,
        );
        let (width, height) = frame.resources.viewport();
        if !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
            || width >= i32::MAX as f32
            || height >= i32::MAX as f32
        {
            return Err(RenderError::InvalidFrame);
        }
        let (width, height) = (width.max(1.0) as u32, height.max(1.0) as u32);
        let logical = DamageRect::new(0, 0, width as i32, height as i32);
        pocket_draw_ops::validate(&frame.list.words, logical)
            .map_err(|_| RenderError::InvalidFrame)?;
        self.activate()?;
        if let Err(error) = self.context.bind_target(&self.targets[index].config.native) {
            let _ = self.finish();
            return Err(error);
        }
        let id = self.next_submission;
        self.next_submission = id.checked_add(1).ok_or(RenderError::Failed)?;
        let submission = Submission {
            owner: self.owner,
            id,
        };
        self.pending.push(Pending {
            id,
            target: handle,
            buffer: 0,
            terminal: None,
        });
        self.vertices.clear();
        self.commands.clear();
        self.trace(0);
        self.trace(1);
        unsafe {
            clear_errors();
        }
        let prepared = unsafe { self.prepare(frame, id, logical, compositor) }.and_then(|()| {
            self.trace(2);
            self.build(&frame.list.words, width, height)
        });
        if let Err(error) = prepared {
            let _ = self.finish();
            self.retire(submission);
            return Err(error);
        }
        self.trace(3);
        let byte_length = self
            .vertices
            .len()
            .checked_mul(size_of::<Vertex>())
            .filter(|&bytes| bytes <= isize::MAX as usize);
        if byte_length.is_none() || self.vertices.len() > i32::MAX as usize {
            let _ = self.finish();
            self.retire(submission);
            return Err(RenderError::InvalidFrame);
        }
        unsafe {
            if clear == ClearMode::OpaqueBlack {
                glEnable(GL_SCISSOR_TEST);
                glScissor(
                    region.x as i32,
                    (window_height - region.y - region.height) as i32,
                    region.width as i32,
                    region.height as i32,
                );
                glViewport(0, 0, window_width as i32, window_height as i32);
                glClearColor(0.0, 0.0, 0.0, 1.0);
                glClear(GL_COLOR_BUFFER_BIT);
            }
            self.pipeline.begin_frame(width as f32, height as f32);
            glViewport(
                viewport.x,
                (window_height as i64 - viewport.y as i64 - viewport.height as i64) as i32,
                viewport.width as i32,
                viewport.height as i32,
            );
            glDisable(GL_DEPTH_TEST);
            glDisable(GL_CULL_FACE);
            glEnable(GL_BLEND);
            self.pipeline.set_blend();
            glEnable(GL_SCISSOR_TEST);
            if !self.vertices.is_empty() {
                let mut buffer = 0;
                glGenBuffers(1, &mut buffer);
                self.pending.last_mut().unwrap().buffer = buffer;
                if buffer == 0 {
                    let _ = self.finish();
                    self.retire(submission);
                    return Err(RenderError::Failed);
                }
                glBindBuffer(GL_ARRAY_BUFFER, buffer);
                glBufferData(
                    GL_ARRAY_BUFFER,
                    byte_length.unwrap() as isize,
                    self.vertices.as_ptr().cast::<c_void>(),
                    GL_DYNAMIC_DRAW,
                );
                self.pipeline.bind_vertices(size_of::<Vertex>() as i32);
            }
            self.trace(4);
            let mut bound = 0;
            let mut scissor = None;
            for command in &self.commands {
                if command.texture != bound {
                    glBindTexture(GL_TEXTURE_2D, command.texture);
                    bound = command.texture;
                }
                let physical = Self::physical_clip(
                    command.clip,
                    width as i32,
                    height as i32,
                    viewport.x,
                    viewport.y,
                    viewport.width as i32,
                    viewport.height as i32,
                    window_height as i32,
                );
                let left = (physical.x as i64).max(region.x as i64);
                let right =
                    (physical.x as i64 + physical.w as i64).min((region.x + region.width) as i64);
                let bottom =
                    (physical.y as i64).max((window_height - region.y - region.height) as i64);
                let top =
                    (physical.y as i64 + physical.h as i64).min((window_height - region.y) as i64);
                if right <= left || top <= bottom {
                    continue;
                }
                let clipped = Clip {
                    x: left as i32,
                    y: bottom as i32,
                    w: (right - left) as i32,
                    h: (top - bottom) as i32,
                };
                if scissor != Some(clipped) {
                    glScissor(clipped.x, clipped.y, clipped.w, clipped.h);
                    scissor = Some(clipped);
                }
                glDrawArrays(GL_TRIANGLES, command.first as i32, command.count as i32);
            }
            glDisable(GL_SCISSOR_TEST);
            self.pipeline.unbind_vertices();
            glBindBuffer(GL_ARRAY_BUFFER, 0);
            glBindTexture(GL_TEXTURE_2D, 0);
            self.trace(5);
            if glGetError() != GL_NO_ERROR {
                let _ = self.finish();
                self.retire(submission);
                return Err(RenderError::Failed);
            }
        }
        self.trace(6);
        Ok(submission)
    }
}

#[cfg(test)]
extern crate std;
#[cfg(test)]
mod tests;
