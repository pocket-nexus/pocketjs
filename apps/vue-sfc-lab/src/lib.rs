//! Native implementation of the same contract exported by app.ts.
#![no_std]

extern crate alloc;

use alloc::{vec, vec::Vec};
use core::ops::{Deref, DerefMut};
use pocket_vapor::{Input, Ui};

#[path = "../gen/mod.rs"]
pub mod generated;
pub use generated::{AppApp, AppEvent, AppProps, AppView, AppViewModel, Feature};

pub struct LabViewModel {
    pub count: i32,
    pub features: Vec<Feature>,
}

impl Default for LabViewModel {
    fn default() -> Self {
        Self {
            count: 0,
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
    fn count(&self) -> i32 {
        self.count
    }
    fn set_count(&mut self, value: i32) {
        self.count = value;
    }
    fn features(&self) -> &[Feature] {
        &self.features
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
}

/// Hosts provide input once per tick and draw through the existing core.
pub struct LabApp {
    native: AppApp<LabViewModel>,
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
            native: AppApp::new(ui, AppProps {}, LabViewModel::default()),
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
    type Target = AppApp<LabViewModel>;
    fn deref(&self) -> &Self::Target {
        &self.native
    }
}

impl DerefMut for LabApp {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.native
    }
}
