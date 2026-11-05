//! Runtime registration of the process GXM renderer through the device
//! target contract (`pocket_drivers::target`). The process keeps the renderer
//! in its `RendererCell` for native drawing and subsequent guests; each
//! runtime registration owns a terminal boundary, and its display reaches the
//! renderer only through a `TargetPort`.
use crate::{Device, GxmRenderer};
use pocket_drivers::target::{PendingUnregister, RendererCell, TargetPort, TargetRenderer};
use pocket_drivers::{DeviceTarget, Rect, RenderError};

/// The renderer a runtime registers. Dropping it waits for the queued display
/// transfers, then closes any open scene and retires its submissions; the
/// renderer stays in the process cell.
pub type SharedRenderer<D> = pocket_drivers::target::Registration<GxmRenderer<D>>;

/// The renderer owns one target covering its configured physical viewport.
/// Registering and unregistering are unsupported, so no pending submission
/// can lose its target. Context loss does not exist on GXM; a failed
/// submission or swap closes the scene and the next frame starts clean.
impl<D: Device> TargetRenderer for GxmRenderer<D> {
    type TargetConfig = ();
    const PENDING_UNREGISTER: PendingUnregister = PendingUnregister::Fixed;
    fn register_target(&mut self, _: ()) -> Result<u64, RenderError> {
        Err(RenderError::Unsupported)
    }
    fn unregister_target(&mut self, _: u64) -> Result<(), RenderError> {
        Err(RenderError::Unsupported)
    }
    fn target(&self, handle: u64) -> Result<DeviceTarget, RenderError> {
        let target = GxmRenderer::target(self);
        if handle == target.handle {
            Ok(target)
        } else {
            Err(RenderError::InvalidFrame)
        }
    }
    /// The display's queued flush: close the scene and queue the swap behind
    /// its GPU work.
    fn queue_present(&mut self, handle: u64) -> Result<(), RenderError> {
        TargetRenderer::target(self, handle)?;
        self.queue_display()
    }
    fn drain_present(&mut self) -> Result<(), RenderError> {
        self.wait_display()
    }
    fn end_registration(&mut self) {
        // Finish prior display transfers before discard_frame retires any
        // submission. No current scene is flushed during this cleanup.
        let _ = self.wait_display();
        let _ = self.discard_frame();
    }
}

/// The display of one registration, on the renderer's owning thread. It
/// holds the renderer's fixed target and a port; it never keeps the renderer
/// alive. Drop waits for its queued swap while the renderer exists; a
/// renderer dropped first has already drained the display queue.
pub struct GxmDisplay<D: Device> {
    role: pocket_drivers::DisplayRole,
    port: TargetPort<GxmRenderer<D>>,
    handle: u64,
    region: Rect,
    acquired: bool,
    pending: Option<u64>,
    next: u64,
}
impl<D: Device> pocket_drivers::DisplayOutput for GxmDisplay<D> {
    type Token = u64;
    fn descriptor(&self) -> pocket_drivers::DisplayDescriptor {
        let mut d = pocket_drivers::DisplayDescriptor::new(
            self.role,
            self.region.width,
            self.region.height,
            pocket_drivers::PixelFormat::Rgba8888,
            self.region.width as usize * 4,
            pocket_drivers::TargetOwnership::DeviceOwned,
        );
        d.vsync = pocket_drivers::VsyncSource::Display;
        // vita2d queues the swap behind the scene's GXM sync object.
        d.queued_flush = true;
        d
    }
    fn acquire(
        &mut self,
        region: pocket_drivers::Rect,
    ) -> Result<pocket_drivers::Target<'_>, pocket_drivers::DisplayError> {
        let target = self
            .port
            .target(self.handle)
            .map_err(|_| pocket_drivers::DisplayError::InvalidTarget)?;
        if self.pending.is_some() || region != target.region {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.acquired = true;
        Ok(pocket_drivers::Target::DeviceOwned(target))
    }
    fn flush(&mut self, _: &[pocket_drivers::Rect]) -> Result<u64, pocket_drivers::DisplayError> {
        if !self.acquired || self.pending.is_some() {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.acquired = false;
        let token = self.next;
        self.next = self
            .next
            .checked_add(1)
            .ok_or(pocket_drivers::DisplayError::Failed)?;
        self.port
            .queue_present(self.handle)
            .map_err(|_| pocket_drivers::DisplayError::Failed)?;
        self.pending = Some(token);
        Ok(token)
    }
    /// The swap stays queued. GXM sync objects keep the display buffers from
    /// being rendered while scanned out, and retirement releases only vertex
    /// and texture storage covered by the renderer wait, so no display-queue
    /// drain runs per frame.
    fn wait(&mut self, token: u64) -> Result<(), pocket_drivers::DisplayError> {
        if self.pending != Some(token) {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.pending = None;
        Ok(())
    }
    fn vsync(&mut self) -> pocket_drivers::VsyncSource {
        pocket_drivers::VsyncSource::Display
    }
}
impl<D: Device> Drop for GxmDisplay<D> {
    fn drop(&mut self) {
        if self.pending.take().is_some() {
            let _ = self.port.drain_present();
        }
    }
}

impl<D: Device> GxmDisplay<D> {
    /// A display of the renderer's fixed target. `Failed` when the cell is
    /// empty or in use.
    pub fn new(
        renderer: &RendererCell<GxmRenderer<D>>,
        role: pocket_drivers::DisplayRole,
    ) -> Result<Self, RenderError> {
        let target = renderer.with(|renderer| GxmRenderer::target(renderer))?;
        Ok(Self {
            port: renderer.port(),
            handle: target.handle,
            region: target.region,
            role,
            acquired: false,
            pending: None,
            next: 1,
        })
    }
}
