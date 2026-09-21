//! Native implementation of the same contract exported by app.ts.
#![no_std]

extern crate alloc;

use alloc::{vec, vec::Vec};
use core::ops::{Deref, DerefMut};
use microts::spec::btn;
use microts::{HasButton, HasRelativeAxis, Host, Input, Ui};

#[path = "../gen/mod.rs"]
pub mod generated;
pub use generated::{
    AppApp, AppEvent, AppProps, AppView, AppViewModel, Feature, FeatureToggleViewModel, LabTheme,
};

#[derive(Default)]
pub struct ToggleState {
    presses: i32,
}

impl FeatureToggleViewModel for ToggleState {
    fn presses(&self) -> i32 {
        self.presses
    }
    fn press(&mut self) -> i32 {
        self.presses = self.presses.wrapping_add(1);
        self.presses
    }
}

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

pub struct LabViewModel {
    pub count: i32,
    pub features: Vec<Feature>,
    pub theme: LabTheme,
    axis_remainder: i32,
}

impl Default for LabViewModel {
    fn default() -> Self {
        Self {
            count: 0,
            axis_remainder: 0,
            theme: LabTheme {
                enabledLabel: "ON".into(),
            },
            features: vec![
                Feature {
                    id: "model".into(),
                    label: "MODEL".into(),
                    enabled: true,
                },
                Feature {
                    id: "for".into(),
                    label: "V-FOR".into(),
                    enabled: true,
                },
                Feature {
                    id: "slots".into(),
                    label: "SLOTS".into(),
                    enabled: true,
                },
            ],
        }
    }
}

#[allow(non_snake_case)]
impl AppViewModel for LabViewModel {
    type FeatureToggle = ToggleState;
    fn count(&self) -> i32 {
        self.count
    }
    fn set_count(&mut self, value: i32) {
        self.count = value;
    }
    fn features(&self) -> &[Feature] {
        &self.features
    }
    fn theme(&self) -> &LabTheme {
        &self.theme
    }
    fn enabledCount(&self) -> i32 {
        self.features
            .iter()
            .filter(|feature| feature.enabled)
            .count() as i32
    }
    fn toggleFeature(&mut self, id: alloc::string::String) {
        if let Some(feature) = self.features.iter_mut().find(|feature| feature.id == id) {
            feature.enabled = !feature.enabled;
        }
    }
    fn adjustCount(&mut self, delta: i32) {
        let total = i64::from(self.axis_remainder) + i64::from(delta);
        let steps = (total / 15_000) as i32;
        self.axis_remainder = (total % 15_000) as i32;
        self.count = self.count.wrapping_add(steps).max(0);
    }
    fn resetCount(&mut self) {
        self.count = 0;
        self.axis_remainder = 0;
    }
}

/// Hosts provide input once per tick and draw through the existing core.
pub struct LabApp {
    native: AppApp<LabViewModel, LabHost>,
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
            native: AppApp::new(LabHost(ui), AppProps {}, LabViewModel::default()),
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
    type Target = AppApp<LabViewModel, LabHost>;
    fn deref(&self) -> &Self::Target {
        &self.native
    }
}

impl DerefMut for LabApp {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.native
    }
}
