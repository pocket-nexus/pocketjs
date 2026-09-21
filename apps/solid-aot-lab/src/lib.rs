//! Host glue for the model compiled from app.ts.
#![no_std]

extern crate alloc;

use core::ops::{Deref, DerefMut};
use microts::spec::btn;
use microts::{HasButton, HasRelativeAxis, Host, Input, Ui};

#[path = "../gen/mod.rs"]
pub mod generated;
pub use generated::{
    AppApp, AppEvent, AppProps, AppView, AppViewModel, Feature, FeatureToggleViewModel, LabTheme,
};

pub use generated::AppModel;

/// The embedding host supplies button samples and primary-axis millidegrees.
pub struct LabHost(pub Ui);
impl Host for LabHost {
    fn ui(&self) -> &Ui {
        &self.0
    }
    fn ui_mut(&mut self) -> &mut Ui {
        &mut self.0
    }
    fn into_ui(self) -> Ui {
        self.0
    }
}
impl HasButton<{ btn::CROSS }> for LabHost {}
impl HasRelativeAxis<0> for LabHost {}

/// Hosts provide input once per tick and draw through the existing core.
pub struct LabApp {
    native: AppApp<AppModel, LabHost>,
}

impl Default for LabApp {
    fn default() -> Self {
        Self::new(Ui::new())
    }
}

impl LabApp {
    pub fn new(mut ui: Ui) -> Self {
        assert!(ui.load_styles(include_bytes!("../gen/styles.bin")));
        ui.core_mut().set_viewport(480.0, 272.0);
        Self {
            native: AppApp::new(LabHost(ui), AppProps {}, AppModel::default()),
        }
    }

    /// Use after a host changes the model between frames.
    pub fn invalidate(&mut self) {
        self.native.invalidate();
    }

    pub fn frame(&mut self, input: Input) -> &[AppEvent] {
        self.native.frame(&input)
    }

    pub fn unmount(self) -> Ui {
        self.native.unmount()
    }
}

impl Deref for LabApp {
    type Target = AppApp<AppModel, LabHost>;
    fn deref(&self) -> &Self::Target {
        &self.native
    }
}

impl DerefMut for LabApp {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.native
    }
}
