//! Rendering consumes DrawList without introducing another command language.

use crate::{abi, DrawList, PixelFormat, Rect, RenderResources, Target, TargetOwnership};

/// When presentation completes a frame: renderer wait, display flush and
/// wait, retirement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
#[repr(u32)]
pub enum Synchronization {
    /// The frame completes before the present call returns.
    Immediate = abi::POCKET_SYNC_IMMEDIATE,
    /// The frame stays in flight while the next guest turn runs. It completes
    /// at the start of the next present, at an explicit completion, display
    /// refresh, or coordinator destruction. Device-owned targets only.
    Deferred = abi::POCKET_SYNC_DEFERRED,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RenderError {
    Unsupported,
    InvalidFrame,
    Failed,
}

/// The constructor rejects deferred CPU-visible writes. Such writes would
/// outlive the exclusive borrow granted by `Surface`.
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct RendererDescriptor {
    formats: [PixelFormat; 7],
    format_count: usize,
    target_ownership: TargetOwnership,
    synchronization: Synchronization,
    draw_list_version: u32,
    zero_copy: bool,
}

impl RendererDescriptor {
    pub fn new(
        formats: &[PixelFormat],
        target_ownership: TargetOwnership,
        synchronization: Synchronization,
        draw_list_version: u32,
        zero_copy: bool,
    ) -> Result<Self, RenderError> {
        if formats.is_empty()
            || formats.len() > 7
            || draw_list_version == 0
            || (target_ownership == TargetOwnership::CpuVisible
                && synchronization != Synchronization::Immediate)
        {
            return Err(RenderError::Unsupported);
        }
        let mut copied = [PixelFormat::Rgb565; 7];
        copied[..formats.len()].copy_from_slice(formats);
        Ok(Self {
            formats: copied,
            format_count: formats.len(),
            target_ownership,
            synchronization,
            draw_list_version,
            zero_copy,
        })
    }

    pub fn formats(&self) -> &[PixelFormat] {
        &self.formats[..self.format_count]
    }
    pub fn target_ownership(&self) -> TargetOwnership {
        self.target_ownership
    }
    pub fn synchronization(&self) -> Synchronization {
        self.synchronization
    }
    pub fn draw_list_version(&self) -> u32 {
        self.draw_list_version
    }
    pub fn zero_copy(&self) -> bool {
        self.zero_copy
    }
    pub fn accepts(&self, target: &Target<'_>) -> bool {
        self.target_ownership == target.ownership() && self.formats().contains(&target.format())
    }
}

/// All resource borrows last only for the render call, except texture storage
/// a zero-copy render retains as `Renderer::render_zero_copy` describes. CPU
/// target access is exclusive, so render takes `&mut FrameInput` rather than a
/// shared reference.
///
/// `damage` lists physical rectangles inside the target region whose pixels
/// need repainting since the display's retained contents. Presentation also
/// flushes any pixels it moved before rendering. A renderer must repaint every
/// pixel inside them and may repaint any other pixel of the region.
/// Presentation supplies at least one rectangle.
#[non_exhaustive]
pub struct FrameInput<'a> {
    pub list: &'a DrawList,
    pub resources: &'a dyn RenderResources,
    pub damage: &'a [Rect],
    pub target: Target<'a>,
}

impl<'a> FrameInput<'a> {
    pub fn new(
        list: &'a DrawList,
        resources: &'a dyn RenderResources,
        damage: &'a [Rect],
        target: Target<'a>,
    ) -> Self {
        Self {
            list,
            resources,
            damage,
            target,
        }
    }
}

/// A renderer may serve multiple displays, each with its own submission.
/// Driver-owned vertex/texture versions remain alive until their last
/// referencing submission retires, even when waits complete out of order.
///
/// Safe callers may forge, repeat, drop, or retire submissions out of order.
/// Implementations must validate identity/state, reject invalid targets, and
/// stop hardware before releasing memory. Calling `retire` early must either
/// leave pending resources owned by the driver or wait before freeing them.
/// Destruction must stop all hardware access. Only `render_zero_copy` adds
/// caller-side memory-safety preconditions.
pub trait Renderer {
    type Submission;

    fn descriptor(&self) -> RendererDescriptor;
    /// CPU-visible output must be complete before returning. Deferred device
    /// work may reference only driver-owned data: copy borrowed words, pixels,
    /// and glyphs before returning. On error drain or cancel all submitted
    /// work before returning; errors cannot leave memory in use by hardware.
    ///
    /// Software fallback may write only the acquired CPU region, after
    /// draining prior GPU work and making caches visible. Device-owned targets
    /// require full operation support or driver-owned staging textures.
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Self::Submission, RenderError>;

    /// The explicit exception to the normal resource-copy rule.
    ///
    /// # Safety
    /// The descriptor must declare zero_copy. CPU-visible writes still finish
    /// before this method returns. An Immediate renderer may read every
    /// resource referenced by `frame` until `wait` returns; the caller keeps
    /// them alive and unchanged until then. A Deferred renderer's submission
    /// outlives the present call, so it may retain only the pixel and palette
    /// storage returned by `RenderResources::texture`. The caller keeps that
    /// storage alive and unchanged until the submission retires; the DrawList
    /// words, damage, resource object and font atlases are borrowed for this
    /// call only and must be copied before it returns. Presentation calls
    /// this on a Deferred renderer only when its caller made that promise
    /// (`pocket_present::Coordinator::enable_deferred_zero_copy`).
    unsafe fn render_zero_copy(
        &mut self,
        frame: &mut FrameInput<'_>,
    ) -> Result<Self::Submission, RenderError> {
        self.render(frame)
    }

    /// Both Ok and Err mean hardware has completed or stopped; neither means
    /// pending. Presentation waits here before display flush, except for a
    /// `queued_flush` display bound to a Deferred renderer. On failure it
    /// invalidates the display's damage history and waits for display work
    /// before retirement. A Deferred renderer is waited at the next present.
    fn wait(&mut self, submission: &Self::Submission) -> Result<(), RenderError>;
    /// Presentation calls this after render and display waits. The driver
    /// must guard invalid or premature retirement as described above. A
    /// runtime being destroyed waits on every renderer/display first.
    fn retire(&mut self, submission: Self::Submission);
}
