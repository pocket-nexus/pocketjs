//! GE DrawList rendering without a retained UI or guest-engine dependency.
#![no_std]
extern crate alloc;
use alloc::rc::Rc;
use core::{
    cell::RefCell,
    sync::atomic::{AtomicU32, Ordering},
};
use pocket_drivers::{
    DeviceTarget, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, FrameInput,
    PixelFormat, Rect, RenderError, Renderer, RendererDescriptor, Synchronization, Target,
    TargetOwnership,
};
mod encode;
pub use encode::Encoder;
#[cfg(target_os = "psp")]
pub mod native;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Primitive {
    Sprites,
    TriangleStrip,
    Triangles,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VertC {
    pub color: u32,
    pub x: i16,
    pub y: i16,
    pub z: i16,
    pub padding: i16,
}
impl VertC {
    fn new(color: u32, x: i16, y: i16) -> Self {
        Self {
            color,
            x,
            y,
            z: 0,
            padding: 0,
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VertTC {
    pub u: i16,
    pub v: i16,
    pub color: u32,
    pub x: i16,
    pub y: i16,
    pub z: i16,
    pub padding: i16,
}
impl VertTC {
    fn new(color: u32, x: i16, y: i16, u: i16, v: i16) -> Self {
        Self {
            u,
            v,
            color,
            x,
            y,
            z: 0,
            padding: 0,
        }
    }
}
pub enum Vertices<'a> {
    Colored(&'a [VertC]),
    Textured(&'a [VertTC]),
}
#[derive(Clone, Copy, Debug)]
pub struct TextureBinding {
    pub pixels: *const u8,
    pub bytes: usize,
    pub palette: *const u8,
    pub palette_bytes: usize,
    pub width: u32,
    pub height: u32,
    pub psm: u32,
    pub linear: bool,
}
/// Native operations confined to one GE context and owning thread.
///
/// # Safety
/// All pointers passed to publish/bind/draw remain live until terminal wait.
/// The implementation must not retain them after wait, including Err. A panic
/// in a device operation must leave stop() able to finish/cancel native work.
/// stop() must never unwind and must establish terminal completion.
/// finish may submit asynchronously; present runs only after terminal wait.
/// Device callbacks must not reenter any renderer or display sharing this
/// device. The GE command context and its submission state are exclusive.
pub unsafe trait Device {
    fn begin(&mut self) -> Result<(), RenderError>;
    fn begin_pass(&mut self, clear: bool);
    fn clip(&mut self, clip: pocket_drivers::DamageRect);
    /// # Safety
    /// The pointer covers `bytes` readable CPU bytes for this call.
    unsafe fn publish(&mut self, pointer: *const u8, bytes: usize);
    /// # Safety
    /// Image and palette pointers remain live and immutable until wait/stop.
    unsafe fn bind(&mut self, texture: Option<TextureBinding>);
    /// # Safety
    /// Vertex storage remains live and immutable until wait/stop.
    unsafe fn draw(&mut self, primitive: Primitive, vertices: Vertices<'_>);
    fn end_pass(&mut self);
    fn finish(&mut self) -> Result<(), RenderError>;
    fn wait(&mut self) -> Result<(), RenderError>;
    fn present(&mut self) -> Result<(), DisplayError>;
    fn stop(&mut self);
}
#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub clear: bool,
}
impl Config {
    pub const fn psp() -> Self {
        Self { clear: true }
    }
}
impl Default for Config {
    fn default() -> Self {
        Self::psp()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Submission {
    owner: u32,
    id: u64,
}
static OWNER: AtomicU32 = AtomicU32::new(1);
struct Pending {
    id: u64,
    terminal: Option<bool>,
}
pub struct GeRenderer<D: Device> {
    device: D,
    encoder: Encoder,
    config: Config,
    owner: u32,
    next: u64,
    pending: Option<Pending>,
    in_call: bool,
    acquired: bool,
    display_pending: Option<u64>,
    display_next: u64,
}
impl<D: Device> GeRenderer<D> {
    pub fn new(device: D, config: Config) -> Result<Self, RenderError> {
        let owner = OWNER
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| RenderError::Failed)?;
        Ok(Self {
            device,
            encoder: Encoder::new(),
            config,
            owner,
            next: 0,
            pending: None,
            in_call: false,
            acquired: false,
            display_pending: None,
            display_next: 0,
        })
    }
    pub fn target(&self) -> DeviceTarget {
        DeviceTarget::new(
            u64::from(self.owner),
            Rect::new(0, 0, 480, 272),
            PixelFormat::Rgba8888,
        )
    }
    pub fn resident_bytes(&self) -> usize {
        self.encoder.resident_bytes()
    }
    fn valid(&self, submission: &Submission) -> bool {
        submission.owner == self.owner
            && self.pending.as_ref().is_some_and(|p| p.id == submission.id)
    }
    fn submit(
        &mut self,
        frame: &mut FrameInput<'_>,
        zero_copy: bool,
    ) -> Result<Submission, RenderError> {
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::Unsupported);
        };
        if self.pending.is_some()
            || self.display_pending.is_some()
            || target.handle != u64::from(self.owner)
            || target.region != Rect::new(0, 0, 480, 272)
            || target.format != PixelFormat::Rgba8888
        {
            return Err(RenderError::InvalidFrame);
        }
        Encoder::validate(&frame.list.words, frame.resources)?;
        self.next = self.next.checked_add(1).ok_or(RenderError::Failed)?;
        self.in_call = true;
        let result = (|| {
            self.device.begin()?;
            unsafe {
                self.encoder.encode_open(
                    &mut self.device,
                    frame.resources,
                    &frame.list.words,
                    zero_copy,
                    self.config.clear,
                )?;
            }
            self.device.finish()
        })();
        if let Err(error) = result {
            self.device.stop();
            unsafe {
                self.encoder.retire();
            }
            self.in_call = false;
            return Err(error);
        }
        self.in_call = false;
        self.pending = Some(Pending {
            id: self.next,
            terminal: None,
        });
        Ok(Submission {
            owner: self.owner,
            id: self.next,
        })
    }
    /// Stop outstanding work and release guest resources. Displays retain
    /// their target identity so the same device can serve the next guest.
    pub fn reset(&mut self) {
        self.device.stop();
        unsafe {
            self.encoder.retire();
            self.encoder.reset_fonts();
        }
        self.pending = None;
        self.in_call = false;
        self.acquired = false;
        self.display_pending = None;
    }
}
impl<D: Device> Renderer for GeRenderer<D> {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgba8888],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            pocket_spec::DRAW_LIST_VERSION,
            true,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        self.submit(frame, false)
    }
    unsafe fn render_zero_copy(
        &mut self,
        frame: &mut FrameInput<'_>,
    ) -> Result<Submission, RenderError> {
        self.submit(frame, true)
    }
    fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
        if !self.valid(submission) {
            return Err(RenderError::InvalidFrame);
        }
        if let Some(success) = self.pending.as_ref().unwrap().terminal {
            return if success {
                Ok(())
            } else {
                Err(RenderError::Failed)
            };
        }
        self.in_call = true;
        let result = self.device.wait();
        self.pending.as_mut().unwrap().terminal = Some(result.is_ok());
        self.in_call = false;
        result
    }
    fn retire(&mut self, submission: Submission) {
        if !self.valid(&submission) {
            return;
        }
        let _ = self.wait(&submission);
        unsafe {
            self.encoder.retire();
        }
        self.pending = None;
    }
}
impl<D: Device> Drop for GeRenderer<D> {
    fn drop(&mut self) {
        self.device.stop();
    }
}

pub struct SharedRenderer<D: Device>(Rc<RefCell<GeRenderer<D>>>);
impl<D: Device> Clone for SharedRenderer<D> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<D: Device> SharedRenderer<D> {
    pub fn new(renderer: GeRenderer<D>) -> Self {
        Self(Rc::new(RefCell::new(renderer)))
    }
    pub fn reset(&self) {
        self.0.borrow_mut().reset();
    }
    pub fn resident_bytes(&self) -> usize {
        self.0.borrow().resident_bytes()
    }
    pub fn target(&self) -> DeviceTarget {
        self.0.borrow().target()
    }
}
impl<D: Device> Renderer for SharedRenderer<D> {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        self.0.borrow().descriptor()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| RenderError::Failed)?
            .render(frame)
    }
    unsafe fn render_zero_copy(
        &mut self,
        frame: &mut FrameInput<'_>,
    ) -> Result<Submission, RenderError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| RenderError::Failed)?
            .render_zero_copy(frame)
    }
    fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
        self.0
            .try_borrow_mut()
            .map_err(|_| RenderError::Failed)?
            .wait(submission)
    }
    fn retire(&mut self, submission: Submission) {
        if let Ok(mut renderer) = self.0.try_borrow_mut() {
            renderer.retire(submission);
        }
    }
}
impl<D: Device> Drop for SharedRenderer<D> {
    fn drop(&mut self) {
        // The coordinator may drop one renderer handle while a display or host
        // retains another clone. That drop must still stop all native access.
        if let Ok(mut renderer) = self.0.try_borrow_mut() {
            if renderer.in_call || renderer.pending.is_some() || renderer.display_pending.is_some()
            {
                renderer.reset();
            }
        }
    }
}
pub struct GeDisplay<D: Device> {
    renderer: SharedRenderer<D>,
}
impl<D: Device> GeDisplay<D> {
    pub fn new(renderer: SharedRenderer<D>) -> Self {
        Self { renderer }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct DisplayToken {
    owner: u32,
    id: u64,
}
impl<D: Device> DisplayOutput for GeDisplay<D> {
    type Token = DisplayToken;
    fn descriptor(&self) -> DisplayDescriptor {
        let mut desc = DisplayDescriptor::new(
            DisplayRole::Primary,
            480,
            272,
            PixelFormat::Rgba8888,
            512 * 4,
            TargetOwnership::DeviceOwned,
        );
        desc.double_buffered = true;
        desc.device_frame_storage = true;
        desc.refresh_granularity = [480, 272];
        desc
    }
    fn vsync(&mut self) -> pocket_drivers::VsyncSource {
        pocket_drivers::VsyncSource::None
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        let mut r = self
            .renderer
            .0
            .try_borrow_mut()
            .map_err(|_| DisplayError::Failed)?;
        if region != Rect::new(0, 0, 480, 272) || r.pending.is_some() || r.display_pending.is_some()
        {
            return Err(DisplayError::InvalidTarget);
        }
        r.acquired = true;
        Ok(Target::DeviceOwned(r.target()))
    }
    fn flush(&mut self, damage: &[Rect]) -> Result<Self::Token, DisplayError> {
        let mut r = self
            .renderer
            .0
            .try_borrow_mut()
            .map_err(|_| DisplayError::Failed)?;
        if !r.acquired || r.display_pending.is_some() || damage != [Rect::new(0, 0, 480, 272)] {
            return Err(DisplayError::InvalidTarget);
        }
        if let Some(pending) = r.pending.as_ref() {
            let submission = Submission {
                owner: r.owner,
                id: pending.id,
            };
            r.wait(&submission).map_err(|_| DisplayError::Failed)?;
        }
        r.display_next = r.display_next.checked_add(1).ok_or(DisplayError::Failed)?;
        r.device.present()?;
        r.acquired = false;
        r.display_pending = Some(r.display_next);
        Ok(DisplayToken {
            owner: r.owner,
            id: r.display_next,
        })
    }
    fn wait(&mut self, token: Self::Token) -> Result<(), DisplayError> {
        let mut r = self
            .renderer
            .0
            .try_borrow_mut()
            .map_err(|_| DisplayError::Failed)?;
        if token.owner != r.owner || r.display_pending != Some(token.id) {
            return Err(DisplayError::InvalidTarget);
        }
        r.display_pending = None;
        Ok(())
    }
}
#[cfg(test)]
mod tests;
