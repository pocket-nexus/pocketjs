//! DrawList rendering on native wgpu devices, without a retained UI dependency.
//!
//! `Renderer` submissions own their buffers and cache references until terminal
//! waits and retirement. The encoder API also serves hosts which compose UI
//! with other passes: wgpu's command-buffer resource tracker owns references to
//! bound buffers, bind groups and attachment views. Dropping their Rust handles
//! does not destroy those resources. This driver never calls resource `destroy`.
//! Browser WebGPU cannot implement a blocking terminal wait; construction is
//! rejected on wasm until the runtime has an asynchronous presentation contract.

mod batch;
mod pipeline;
mod pixels;

use pocket_drivers::{
    DeviceTarget, FrameInput, PixelFormat, Rect, RenderError, RenderResources, Renderer,
    RendererDescriptor, Synchronization, Target, TargetOwnership,
};
use pocket_glyph_pages::GlyphPageLayout;
use pocket_spec as spec;
use pocket_tex_cache::{TextureCache, TextureKey};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};
use wgpu::util::DeviceExt;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn next_id() -> Result<u64, RenderError> {
    NEXT_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| RenderError::Failed)
}

#[derive(Clone, Copy, Debug)]
pub struct CacheLimits {
    pub image_entries: usize,
    pub image_bytes: usize,
    pub font_entries: usize,
    pub font_bytes: usize,
}
impl Default for CacheLimits {
    fn default() -> Self {
        Self {
            image_entries: 1024,
            image_bytes: 128 * 1024 * 1024,
            font_entries: 256,
            font_bytes: 32 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TargetId(u64);
#[derive(Clone, Debug)]
pub struct Submission(u64);

struct GpuContext {
    device: wgpu::Device,
    queue: wgpu::Queue,
}
struct RegisteredTarget {
    view: wgpu::TextureView,
    size: (u32, u32),
    scale: f32,
    load: wgpu::LoadOp<wgpu::Color>,
}
struct Pending {
    index: wgpu::SubmissionIndex,
    complete: bool,
    _lease: EncodeLease,
}
struct FontTexture {
    bind: wgpu::BindGroup,
    layout: GlyphPageLayout,
    logical: (f32, f32),
}
struct SurfaceBind {
    bind: wgpu::BindGroup,
    logical: (u32, u32),
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct UiVertex {
    pos: [f32; 2],
    uv: [f32; 2],
    color: u32,
    mode: u32,
    bounds: [f32; 4],
}
impl pocket_tri_batch::Vertex for UiVertex {
    fn from_components(pos: [f32; 2], uv: [f32; 2], color: u32) -> Self {
        Self {
            pos,
            uv,
            color,
            mode: 0,
            bounds: [0.0; 4],
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum TexBind {
    White,
    Image(TextureKey),
    Font(TextureKey),
    Surface(u32),
}
type DrawCmd = pocket_tri_batch::Batch<TexBind, (u32, u32, u32, u32)>;

/// CPU handles retained alongside an encoded pass. Native wgpu command buffers
/// also retain these resources, including after this lease is dropped.
#[must_use = "retain until completion, or transfer ownership to the wgpu encoder"]
pub struct EncodeLease {
    _vertices: Option<wgpu::Buffer>,
    _bindings: Vec<wgpu::BindGroup>,
    _target: wgpu::TextureView,
}
impl EncodeLease {
    /// The pass already bound each resource into the supplied wgpu encoder.
    /// Its resource tracker now owns GPU lifetime; no explicit destroy occurs.
    /// This supports an older host API whose submit happens after this call.
    pub fn retain_in_encoder(self) {}
}

// Scope state also unwinds before the caller drops a shared renderer adapter.
// A resource callback panic must not leave a validation scope on the device.
struct ValidationScope {
    device: wgpu::Device,
    active: bool,
}
impl ValidationScope {
    fn new(device: &wgpu::Device) -> Self {
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        Self {
            device: device.clone(),
            active: true,
        }
    }
    fn finish(mut self) -> Option<wgpu::Error> {
        self.active = false;
        pollster::block_on(self.device.pop_error_scope())
    }
}
impl Drop for ValidationScope {
    fn drop(&mut self) {
        if self.active {
            let _ = pollster::block_on(self.device.pop_error_scope());
        }
    }
}

pub struct WgpuRenderer {
    shutdown: bool,
    gpu: GpuContext,
    target_format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    image_format: wgpu::TextureFormat,
    bind_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    sampler_nearest: wgpu::Sampler,
    white: wgpu::BindGroup,
    surfaces: HashMap<u32, SurfaceBind>,
    targets: HashMap<u64, RegisteredTarget>,
    pending: HashMap<u64, Pending>,
    images: TextureCache<wgpu::BindGroup>,
    fonts: TextureCache<FontTexture>,
}

impl WgpuRenderer {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
    ) -> Result<Self, RenderError> {
        Self::with_limits(device, queue, format, CacheLimits::default())
    }
    pub fn with_limits(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        limits: CacheLimits,
    ) -> Result<Self, RenderError> {
        if cfg!(target_arch = "wasm32")
            || !matches!(
                format,
                wgpu::TextureFormat::Rgba8Unorm
                    | wgpu::TextureFormat::Rgba8UnormSrgb
                    | wgpu::TextureFormat::Bgra8Unorm
                    | wgpu::TextureFormat::Bgra8UnormSrgb
            )
        {
            return Err(RenderError::Unsupported);
        }
        Ok(Self::create(
            GpuContext {
                device: device.clone(),
                queue: queue.clone(),
            },
            format,
            limits,
        ))
    }
    fn pixel_format(&self) -> PixelFormat {
        match self.target_format {
            wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
                PixelFormat::Argb8888
            }
            _ => PixelFormat::Rgba8888,
        }
    }
    fn valid_size(&self, size: (u32, u32), scale: f32) -> bool {
        size.0 > 0
            && size.1 > 0
            && size.0 <= self.gpu.device.limits().max_texture_dimension_2d
            && size.1 <= self.gpu.device.limits().max_texture_dimension_2d
            && scale.is_finite()
            && scale > 0.0
            && (size.0 as f32 / scale).is_finite()
            && (size.1 as f32 / scale).is_finite()
            && size.0 as f32 / scale <= i32::MAX as f32
            && size.1 as f32 / scale <= i32::MAX as f32
    }
    /// Register a complete attachment. The view must match the declared size
    /// and this renderer's format. wgpu validation catches incompatible views.
    /// A view clone retains the allocation even if its host handle is dropped.
    pub fn register_target(
        &mut self,
        view: &wgpu::TextureView,
        size: (u32, u32),
        scale: f32,
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<TargetId, RenderError> {
        if self.shutdown {
            return Err(RenderError::Failed);
        }
        if !self.valid_size(size, scale) {
            return Err(RenderError::InvalidFrame);
        }
        let id = next_id()?;
        self.targets.insert(
            id,
            RegisteredTarget {
                view: view.clone(),
                size,
                scale,
                load,
            },
        );
        Ok(TargetId(id))
    }
    pub fn target(&self, id: TargetId) -> Result<DeviceTarget, RenderError> {
        if self.shutdown {
            return Err(RenderError::Failed);
        }
        let target = self.targets.get(&id.0).ok_or(RenderError::InvalidFrame)?;
        Ok(DeviceTarget::new(
            id.0,
            Rect::new(0, 0, target.size.0, target.size.1),
            self.pixel_format(),
        ))
    }
    /// Already-encoded submissions retain their own target view reference.
    pub fn unregister_target(&mut self, id: TargetId) -> bool {
        self.targets.remove(&id.0).is_some()
    }
    pub fn pending_submissions(&self) -> usize {
        self.pending.len()
    }
    pub fn is_shutdown(&self) -> bool {
        self.shutdown
    }

    /// Permanently stop this renderer. An empty queue submission flushes staged
    /// uploads and orders after every earlier submit, including work whose
    /// submission token was never recorded because rendering unwound. Wait for
    /// that checkpoint before releasing pending frames and cache versions.
    /// Repeated calls do nothing. Fallible work entry points return `Failed`
    /// after shutdown; the infallible surface-binding setter becomes a no-op.
    /// This does not destroy a shared wgpu device or
    /// invalidate resources retained by external, not-yet-submitted encoders.
    /// Ordinary frame retirement waits only its own token; it does not call this.
    pub fn shutdown(&mut self) {
        if self.shutdown {
            return;
        }
        self.wait_native(self.gpu.queue.submit([]));
        self.shutdown = true;
        self.pending.clear();
        // A panic may have pinned versions under an id never entered in pending.
        // All native reads/writes preceding the checkpoint are now terminal.
        self.images = TextureCache::new(0, 0);
        self.fonts = TextureCache::new(0, 0);
        self.surfaces.clear();
        self.targets.clear();
    }

    pub fn resident_images(&self) -> usize {
        self.images.len()
    }
    pub fn resident_fonts(&self) -> usize {
        self.fonts.len()
    }

    pub fn set_surface(&mut self, handle: u32, view: &wgpu::TextureView, logical: (u32, u32)) {
        if self.shutdown {
            return;
        }
        let bind = self
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pocket compositor surface"),
                layout: &self.bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler_nearest),
                    },
                ],
            });
        self.surfaces.insert(handle, SurfaceBind { bind, logical });
    }
    pub fn surface_handles(&self) -> impl Iterator<Item = u32> + '_ {
        self.surfaces.keys().copied()
    }
    pub fn retain_surfaces(&mut self, mut keep: impl FnMut(u32) -> bool) {
        self.surfaces.retain(|handle, _| keep(*handle));
    }

    /// Record into a host-owned encoder. Every upload copies borrowed resource
    /// bytes; every call uses its own immutable vertex buffer. Multiple encoders
    /// may therefore wait for submission while the UI's resource versions change.
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &mut self,
        resources: &dyn RenderResources,
        words: &[u32],
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        size: (u32, u32),
        scale: f32,
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<EncodeLease, RenderError> {
        if self.shutdown {
            return Err(RenderError::Failed);
        }
        let id = next_id()?;
        let result =
            self.encode_inner(resources, words, encoder, view, size, scale, load, Some(id));
        // A completed pass has transferred native references to the encoder.
        // Keep the returned Rust lease as well if the host tracks submissions.
        self.release(id);
        result
    }
    #[allow(clippy::too_many_arguments)]
    fn encode_inner(
        &mut self,
        resources: &dyn RenderResources,
        words: &[u32],
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        size: (u32, u32),
        scale: f32,
        load: wgpu::LoadOp<wgpu::Color>,
        submission: Option<u64>,
    ) -> Result<EncodeLease, RenderError> {
        if !self.valid_size(size, scale) {
            return Err(RenderError::InvalidFrame);
        }
        let viewport = pocket_drivers::DamageRect::new(
            0,
            0,
            (size.0 as f32 / scale).ceil() as i32,
            (size.1 as f32 / scale).ceil() as i32,
        );
        pocket_draw_ops::validate(words, viewport).map_err(|_| RenderError::InvalidFrame)?;
        // Bound vertex expansion before allocating or uploading resources.
        let limit = (self.gpu.device.limits().max_buffer_size / size_of::<UiVertex>() as u64)
            .min(u32::MAX as u64);
        let mut required = 0u64;
        for operation in pocket_draw_ops::DrawOps::new(words, viewport) {
            let operation = operation.map_err(|_| RenderError::InvalidFrame)?;
            let count = match operation.opcode {
                spec::draw_op::TEXT_RUN => return Err(RenderError::Unsupported),
                spec::draw_op::TRI | spec::draw_op::TEX_TRI => 3,
                spec::draw_op::GLYPH_RUN => (operation.words[1] >> 16) as u64 * 6,
                spec::draw_op::SCISSOR | spec::draw_op::SCISSOR_POP => 0,
                _ => 6,
            };
            required = required
                .checked_add(count)
                .filter(|n| *n <= limit)
                .ok_or(RenderError::InvalidFrame)?;
        }
        let scope = ValidationScope::new(&self.gpu.device);
        let result = (|| {
            let (vertices, commands) =
                self.build_batches(resources, words, size, scale, viewport, submission)?;
            if vertices.len() > u32::MAX as usize
                || vertices
                    .iter()
                    .any(|v| v.pos.iter().chain(&v.uv).any(|n| !n.is_finite()))
            {
                return Err(RenderError::InvalidFrame);
            }
            let bytes = bytemuck::cast_slice(&vertices);
            if bytes.len() as u64 > self.gpu.device.limits().max_buffer_size {
                return Err(RenderError::InvalidFrame);
            }
            let buffer = (!vertices.is_empty()).then(|| {
                self.gpu
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("pocket frame vertices"),
                        contents: bytes,
                        usage: wgpu::BufferUsages::VERTEX,
                    })
            });
            let bindings: Vec<_> = commands
                .iter()
                .map(|command| {
                    Ok(match command.texture {
                        TexBind::White => self.white.clone(),
                        TexBind::Image(key) => self
                            .images
                            .get(key)
                            .ok_or(RenderError::InvalidFrame)?
                            .clone(),
                        TexBind::Font(key) => self
                            .fonts
                            .get(key)
                            .ok_or(RenderError::InvalidFrame)?
                            .bind
                            .clone(),
                        TexBind::Surface(handle) => self.surfaces[&handle].bind.clone(),
                    })
                })
                .collect::<Result<_, RenderError>>()?;
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("pocket DrawList"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                if let Some(buffer) = &buffer {
                    pass.set_pipeline(&self.pipeline);
                    pass.set_vertex_buffer(0, buffer.slice(..));
                    for (command, binding) in commands.iter().zip(&bindings) {
                        let (x, y, width, height) = command.clip;
                        if width == 0 || height == 0 {
                            continue;
                        }
                        pass.set_scissor_rect(x, y, width, height);
                        pass.set_bind_group(0, binding, &[]);
                        pass.draw(
                            command.first as u32..(command.first + command.count) as u32,
                            0..1,
                        );
                    }
                }
            }
            Ok(EncodeLease {
                _vertices: buffer,
                _bindings: bindings,
                _target: view.clone(),
            })
        })();
        let validation = scope.finish();
        if validation.is_some() || result.is_err() {
            // queue.write_texture may have staged uploads. Submit/drain them
            // before exposing a terminal error or discarding submission refs.
            let index = self.gpu.queue.submit([]);
            self.wait_native(index);
            if let Some(id) = submission {
                self.release(id);
            }
            return Err(result.err().unwrap_or(RenderError::Failed));
        }
        result
    }
    fn wait_native(&self, index: wgpu::SubmissionIndex) {
        // wgpu 25's only PollError is Timeout, which is explicitly nonterminal.
        // Keep ownership and retry; returning Err here would violate Renderer.
        while self
            .gpu
            .device
            .poll(wgpu::PollType::WaitForSubmissionIndex(index.clone()))
            .is_err()
        {}
    }
    fn release(&mut self, id: u64) {
        self.images.retire(id, drop);
        self.fonts.retire(id, drop);
    }
}

impl Renderer for WgpuRenderer {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[self.pixel_format()],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        if self.shutdown {
            return Err(RenderError::Failed);
        }
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::Unsupported);
        };
        let registered = self
            .targets
            .get(&target.handle)
            .ok_or(RenderError::InvalidFrame)?;
        if target.format != self.pixel_format()
            || target.region != Rect::new(0, 0, registered.size.0, registered.size.1)
        {
            return Err(RenderError::InvalidFrame);
        }
        let (view, size, scale, load) = (
            registered.view.clone(),
            registered.size,
            registered.scale,
            registered.load,
        );
        let id = next_id()?;
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        let lease = self.encode_inner(
            frame.resources,
            &frame.list.words,
            &mut encoder,
            &view,
            size,
            scale,
            load,
            Some(id),
        )?;
        let scope = ValidationScope::new(&self.gpu.device);
        let index = self.gpu.queue.submit([encoder.finish()]);
        if scope.finish().is_some() {
            self.wait_native(index);
            self.release(id);
            return Err(RenderError::Failed);
        }
        self.pending.insert(
            id,
            Pending {
                index,
                complete: false,
                _lease: lease,
            },
        );
        Ok(Submission(id))
    }
    fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
        let pending = self
            .pending
            .get(&submission.0)
            .ok_or(RenderError::InvalidFrame)?;
        if !pending.complete {
            self.wait_native(pending.index.clone());
        }
        self.pending.get_mut(&submission.0).unwrap().complete = true;
        Ok(())
    }
    fn retire(&mut self, submission: Submission) {
        if self.wait(&submission).is_ok() {
            self.pending.remove(&submission.0);
            self.release(submission.0);
        }
    }
}
impl Drop for WgpuRenderer {
    fn drop(&mut self) {
        self.shutdown();
    }
}
