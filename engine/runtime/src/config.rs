//! The program's software profile and limits, as exported at build time from
//! the program's host contract. The runtime reads facts, never JSON:
//! `pocket host export` writes them as `pocket_profile.h` for C programs
//! and `pocket_profile.rs` for Rust programs.
use crate::RuntimeError;
use alloc::borrow::Cow;
use pocket_drivers::InputClasses;
use pocket_package::HostFacts;

/// Facts the runtime admits packages and drivers against. Sizes are pixels;
/// `viewport` and `auxiliary` are physical panel sizes, the logical lists are
/// the sizes an application may declare for them. Names compare as strings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    /// The host's profile id, 1..65535 UTF-8 bytes without NUL. Reported to
    /// guests as `ui.__host`; admission does not compare it.
    pub id: Cow<'static, str>,
    /// Presented frames per second the host can drive. A package runs at the
    /// largest cadence its tick rate is a whole multiple of.
    pub cadences: Cow<'static, [u32]>,
    pub viewport: [u32; 2],
    pub logical_viewports: Cow<'static, [[u32; 2]]>,
    /// `[min, max]` logical sizes of a window or widget form.
    pub dynamic_viewport: Option<[[u32; 2]; 2]>,
    /// Presentation names a package viewport may use (`native`, `fit`, …).
    /// Empty states no list; admission then does not compare presentations.
    pub presentations: Cow<'static, [Cow<'static, str>]>,
    pub auxiliary: Option<[u32; 2]>,
    pub auxiliary_logical: Cow<'static, [[u32; 2]]>,
    pub density: u32,
    /// The animation class packages must be compiled for. Empty states no
    /// class; admission then does not compare it.
    pub animation: Cow<'static, str>,
    /// Capability names the host implements for applications.
    pub capabilities: Cow<'static, [Cow<'static, str>]>,
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
            || self.cadences.is_empty()
            || !self
                .cadences
                .iter()
                .all(|cadence| (1..=pocketjs_core::MAX_TICK_HZ).contains(cadence))
            || self.presentations.iter().any(|name| name.is_empty())
            || self.capabilities.iter().any(|name| name.is_empty())
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
    /// The facts package admission compares (`pocket_package::admission`).
    pub fn host_facts(
        &self,
        binding_generation: u32,
        profile_hash: [u8; 32],
    ) -> HostFacts<'_, Cow<'static, str>> {
        HostFacts {
            binding_generation,
            profile_hash,
            raster_density: self.density,
            animation: (!self.animation.is_empty()).then_some(&*self.animation),
            cadences: &self.cadences,
            logical_viewports: &self.logical_viewports,
            dynamic_viewport: self.dynamic_viewport,
            presentations: (!self.presentations.is_empty()).then_some(&*self.presentations),
            capabilities: &self.capabilities,
            auxiliary_logical: if self.auxiliary.is_some() {
                &self.auxiliary_logical
            } else {
                &[]
            },
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
