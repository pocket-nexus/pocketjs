use crate::RuntimeError;
use alloc::{
    string::{String, ToString},
    vec::Vec,
};
use pocket_drivers::InputClasses;
use serde_json::Value;

#[derive(Clone)]
pub struct RuntimeConfig {
    pub profile_hash: [u8; 32],
    pub host_abi: u32,
    pub tick_hz: u32,
    pub heap_limit: usize,
    pub frame_buffer_budget: usize,
    pub profile_json: Vec<u8>,
}

pub(crate) struct Profile {
    pub id: String,
    pub viewport: [u32; 2],
    pub logical_viewports: Vec<[u32; 2]>,
    pub auxiliary: Option<[u32; 2]>,
    pub auxiliary_logical: Vec<[u32; 2]>,
    pub density: u32,
    pub required_inputs: InputClasses,
}

fn viewport(value: &Value) -> Result<[u32; 2], RuntimeError> {
    let a = value.as_array().ok_or(RuntimeError::InvalidConfiguration)?;
    if a.len() != 2 {
        return Err(RuntimeError::InvalidConfiguration);
    }
    let dimension = |v: &Value| {
        v.as_u64()
            .filter(|&n| n > 0 && n <= 65535)
            .map(|n| n as u32)
            .ok_or(RuntimeError::InvalidConfiguration)
    };
    Ok([dimension(&a[0])?, dimension(&a[1])?])
}
fn viewports(value: &Value) -> Result<Vec<[u32; 2]>, RuntimeError> {
    let a = value.as_array().ok_or(RuntimeError::InvalidConfiguration)?;
    if a.is_empty() {
        return Err(RuntimeError::InvalidConfiguration);
    }
    a.iter().map(viewport).collect()
}

impl RuntimeConfig {
    pub(crate) fn profile(&self) -> Result<Profile, RuntimeError> {
        if !(1..=240).contains(&self.tick_hz)
            || self.host_abi == 0
            || self.heap_limit == 0
            || self.frame_buffer_budget == 0
        {
            return Err(RuntimeError::InvalidConfiguration);
        }
        // The caller supplies canonical projection bytes from profile export.
        // Hash those exact bytes; do not invent a second JSON canonicalizer.
        if pocket_package::sha256::sha256(&self.profile_json) != self.profile_hash {
            return Err(RuntimeError::ProfileMismatch);
        }
        let value: Value = serde_json::from_slice(&self.profile_json)
            .map_err(|_| RuntimeError::InvalidConfiguration)?;
        let object = value
            .as_object()
            .ok_or(RuntimeError::InvalidConfiguration)?;
        for key in object.keys() {
            if ![
                "id",
                "platform",
                "form",
                "tickHz",
                "display",
                "capabilities",
                "roleCapabilities",
            ]
            .contains(&key.as_str())
            {
                return Err(RuntimeError::InvalidConfiguration);
            }
        }
        let id = value["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(RuntimeError::InvalidConfiguration)?
            .to_string();
        if value["platform"]
            .as_str()
            .filter(|s| !s.is_empty())
            .is_none()
            || value["form"].as_str().is_none()
            || value["tickHz"].as_u64() != Some(self.tick_hz as u64)
        {
            return Err(RuntimeError::InvalidConfiguration);
        }
        let display = &value["display"];
        let physical = viewport(&display["physicalViewport"])?;
        let logical = viewports(&display["logicalViewports"])?;
        let density = display["rasterDensity"]
            .as_u64()
            .filter(|&n| n > 0 && n <= 255)
            .ok_or(RuntimeError::InvalidConfiguration)? as u32;
        let (auxiliary, auxiliary_logical) = match display.get("auxiliary") {
            Some(aux) => {
                if aux["rasterDensity"].as_u64() != Some(density as u64) {
                    return Err(RuntimeError::InvalidConfiguration);
                }
                (
                    Some(viewport(&aux["physicalViewport"])?),
                    viewports(&aux["logicalViewports"])?,
                )
            }
            None => (None, Vec::new()),
        };
        let capabilities = value["capabilities"]
            .as_array()
            .ok_or(RuntimeError::InvalidConfiguration)?;
        let mut required_inputs = InputClasses::NONE;
        for capability in capabilities {
            let cap = capability
                .as_str()
                .ok_or(RuntimeError::InvalidConfiguration)?;
            required_inputs |= match cap {
                "input.buttons" => InputClasses::BUTTONS,
                "input.analog.left" | "input.analog.right" => InputClasses::AXIS_ABSOLUTE,
                "input.axis.relative" => InputClasses::AXIS_RELATIVE,
                "input.pointer" => InputClasses::POINTER,
                "input.touch" | "input.touch.auxiliary" => InputClasses::CONTACT,
                "input.text" | "input.ime" => InputClasses::TEXT,
                "input.motion.gravity" | "input.motion.inertial" | "input.motion.geomagnetic" => {
                    InputClasses::MOTION
                }
                _ => InputClasses::NONE,
            };
        }
        Ok(Profile {
            id,
            viewport: physical,
            logical_viewports: logical,
            auxiliary,
            auxiliary_logical,
            density,
            required_inputs,
        })
    }
}
