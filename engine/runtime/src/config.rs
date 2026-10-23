//! The program's software profile and limits, as exported at build time from
//! the profile the application was compiled for. The runtime reads facts,
//! never JSON: `pocket profile export` writes them as `pocket_profile.h` for C
//! programs and `pocket_profile.rs` for Rust programs.
use crate::RuntimeError;
use alloc::borrow::Cow;
use pocket_drivers::InputClasses;

/// Facts the runtime admits packages and drivers against. Sizes are pixels;
/// `viewport` and `auxiliary` are physical panel sizes, the logical lists are
/// the sizes an application may declare for them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    /// The package variant name, 1..65535 UTF-8 bytes without NUL.
    pub id: Cow<'static, str>,
    pub tick_hz: u32,
    pub viewport: [u32; 2],
    pub logical_viewports: Cow<'static, [[u32; 2]]>,
    /// `[min, max]` logical sizes of a window or widget form.
    pub dynamic_viewport: Option<[[u32; 2]; 2]>,
    pub auxiliary: Option<[u32; 2]>,
    pub auxiliary_logical: Cow<'static, [[u32; 2]]>,
    pub density: u32,
    /// Input classes the profile's capabilities require from registered sources.
    pub required_inputs: InputClasses,
}

#[derive(Clone)]
pub struct RuntimeConfig {
    pub profile_hash: [u8; 32],
    pub host_abi: u32,
    pub heap_limit: usize,
    /// CPU framebuffer bytes across all outputs; zero requires device-owned targets.
    pub frame_buffer_budget: usize,
    pub profile: Profile,
}

fn dimension(value: u32) -> bool {
    (1..=65535).contains(&value)
}
fn size(value: [u32; 2]) -> bool {
    dimension(value[0]) && dimension(value[1])
}

impl Profile {
    pub(crate) fn validate(&self) -> Result<(), RuntimeError> {
        let id = self.id.as_bytes();
        if id.is_empty()
            || id.len() > pocket_package::package_format::POCKET_TARGET_MAX_BYTES
            || id.contains(&0)
            || !(1..=pocketjs_core::MAX_TICK_HZ).contains(&self.tick_hz)
            || !size(self.viewport)
            || self.logical_viewports.is_empty()
            || !self.logical_viewports.iter().all(|v| size(*v))
            || !(1..=255).contains(&self.density)
        {
            return Err(RuntimeError::InvalidConfiguration);
        }
        if let Some([min, max]) = self.dynamic_viewport {
            if !size(min) || !size(max) || min[0] > max[0] || min[1] > max[1] {
                return Err(RuntimeError::InvalidConfiguration);
            }
        }
        match self.auxiliary {
            Some(physical) => {
                if !size(physical)
                    || self.auxiliary_logical.is_empty()
                    || !self.auxiliary_logical.iter().all(|v| size(*v))
                {
                    return Err(RuntimeError::InvalidConfiguration);
                }
            }
            None => {
                if !self.auxiliary_logical.is_empty() {
                    return Err(RuntimeError::InvalidConfiguration);
                }
            }
        }
        Ok(())
    }
    pub fn admits_viewport(&self, size: [u32; 2]) -> bool {
        if let Some([min, max]) = self.dynamic_viewport {
            size[0] >= min[0] && size[1] >= min[1] && size[0] <= max[0] && size[1] <= max[1]
        } else {
            self.logical_viewports.contains(&size)
        }
    }
}

impl RuntimeConfig {
    pub(crate) fn validate(&self) -> Result<(), RuntimeError> {
        if self.host_abi != pocket_spec::BINDING_GENERATION {
            return Err(RuntimeError::BindingGenerationMismatch);
        }
        if self.heap_limit == 0 {
            return Err(RuntimeError::InvalidConfiguration);
        }
        self.profile.validate()
    }
}
