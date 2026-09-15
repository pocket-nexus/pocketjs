use crate::Ui;

/// A host owns the retained UI and declares the input channels it can deliver.
pub trait Host {
    fn ui(&self) -> &Ui;
    fn ui_mut(&mut self) -> &mut Ui;
    fn into_ui(self) -> Ui;
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
impl HasButtons for Ui {}
impl<const MASK: u32> HasButton<MASK> for Ui {}
