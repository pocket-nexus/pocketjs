use crate::Ui;

/// A host owns the retained UI and declares the input channels it can deliver.
pub trait Host {
    fn ui(&self) -> &Ui;
    fn ui_mut(&mut self) -> &mut Ui;
    fn into_ui(self) -> Ui;
    /// Initial model capabilities without consuming a frame or a delivery.
    fn model_initial_ready(&mut self) -> crate::Ready { self.ui().model_initial_ready() }
    /// One immutable readiness snapshot before this frame's dispatch.
    fn model_ready(&mut self) -> crate::Ready { self.ui_mut().model_ready() }
    /// Drain model commands after reaction, settle and view updates.
    /// Service-capable hosts override this to submit requests and queue deliveries.
    fn model_command(&mut self, command: crate::Cmd) { self.ui_mut().model_command(command); }
}
impl Host for Ui {
    fn ui(&self) -> &Ui {
        self
    }
    fn ui_mut(&mut self) -> &mut Ui {
        self
    }
    fn into_ui(self) -> Ui {
        self
    }
}
pub type CoreHost = Ui;
pub trait HasButtons: Host {}
pub trait HasButton<const MASK: u32>: Host {}
pub trait HasTouch: Host {}
pub trait HasRelativeAxis<const AXIS: u8>: Host {}
/// The host's motion driver publishes fused state at `spec::motion::level` LEVEL.
pub trait HasMotion<const LEVEL: u8>: Host {}
impl HasButtons for Ui {}
impl<const MASK: u32> HasButton<MASK> for Ui {}
