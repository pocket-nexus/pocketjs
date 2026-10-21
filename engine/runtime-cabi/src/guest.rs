use crate::{adapters::AdapterError, runtime::handle};
use alloc::vec::Vec;
use core::{cell::Cell, ffi::c_void, ptr};
use pocket_drivers::{abi::*, MotionState};
use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, OpContext, RuntimeError};

pub struct CGuest {
    table: PocketGuestV1,
    context: *mut c_void,
    runtime: *mut PocketRuntime,
}
struct Active<'a> {
    flag: &'a Cell<bool>,
    previous: bool,
}
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.flag.set(self.previous);
    }
}
impl CGuest {
    pub unsafe fn new(
        table: *const PocketGuestV1,
        context: *mut c_void,
        runtime: *mut PocketRuntime,
    ) -> Result<Self, AdapterError> {
        let table = unsafe { PocketGuestV1::read_prefix(table) }.ok_or(AdapterError::Invalid)?;
        if table.evaluate.is_none() || table.frame.is_none() {
            return Err(AdapterError::Unsupported);
        }
        Ok(Self {
            table,
            context,
            runtime,
        })
    }
    fn active(&self) -> Active<'_> {
        let flag = &unsafe { handle(self.runtime) }
            .expect("registered runtime is live")
            .guest_active;
        Active {
            previous: flag.replace(true),
            flag,
        }
    }
}
fn result(status: i32) -> Result<(), RuntimeError> {
    if status == 0 {
        Ok(())
    } else {
        Err(RuntimeError::Guest)
    }
}
impl Guest for CGuest {
    fn initialize(
        &mut self,
        _ops: OpContext,
        env: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        let Some(callback) = self.table.initialize else {
            return Ok(());
        };
        let _active = self.active();
        let textures: Vec<_> = env
            .assets
            .into_iter()
            .flat_map(|assets| assets.textures.iter())
            .map(|texture| PocketNamedTexture {
                name: texture.name.as_ptr(),
                name_length: texture.name.len(),
                handle: texture.handle,
                ..PocketNamedTexture::empty()
            })
            .collect();
        let sprites: Vec<_> = env
            .assets
            .into_iter()
            .flat_map(|assets| assets.sprites.iter())
            .map(|sprite| PocketNamedSprite {
                name: sprite.name.as_ptr(),
                name_length: sprite.name.len(),
                handle: sprite.handle,
                frames: sprite.frames,
                columns: sprite.columns,
                step: sprite.step,
                ..PocketNamedSprite::empty()
            })
            .collect();
        let auxiliary = env.auxiliary_viewport.unwrap_or([0; 2]);
        let environment = PocketGuestEnvironment {
            host: env.host.as_ptr(),
            host_length: env.host.len(),
            host_abi: env.host_abi,
            tick_hz: env.tick_hz,
            viewport_width: env.viewport[0],
            viewport_height: env.viewport[1],
            auxiliary_width: auxiliary[0],
            auxiliary_height: auxiliary[1],
            auxiliary_root: env.auxiliary_root,
            raster_density: env.raster_density,
            heap_limit: env.heap_limit,
            pak: env.pak.as_ptr(),
            pak_length: env.pak.len(),
            textures: textures.as_ptr(),
            texture_count: textures.len(),
            sprites: sprites.as_ptr(),
            sprite_count: sprites.len(),
            assets_present: u32::from(env.assets.is_some()),
            ..PocketGuestEnvironment::empty()
        };
        result(unsafe { callback(self.context, self.runtime, &environment) })
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        let _active = self.active();
        result(unsafe {
            self.table.evaluate.unwrap()(self.context, self.runtime, code.as_ptr(), code.len())
        })
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        let _active = self.active();
        let relative: Vec<_> = frame
            .axis_deltas
            .iter()
            .map(|axis| PocketAxisDelta {
                axis: axis.id,
                delta: axis.delta,
                ..PocketAxisDelta::empty()
            })
            .collect();
        let motion = frame.motion.map(motion_header);
        let frame = PocketGuestFrame {
            buttons: frame.buttons,
            analog: frame.analog,
            touches: frame.touches.as_ptr(),
            hits: frame.hits.as_ptr(),
            touch_surfaces: frame.touch_surfaces.as_ptr(),
            touch_count: frame.touches.len(),
            right_analog: frame.right_analog,
            axis_deltas: relative.as_ptr(),
            axis_delta_count: relative.len(),
            motion: motion.as_ref().map_or(ptr::null(), |motion| motion),
            ..PocketGuestFrame::empty()
        };
        result(unsafe { self.table.frame.unwrap()(self.context, &frame) })
    }
    fn collect(&mut self) -> Result<(), RuntimeError> {
        let _active = self.active();
        self.table
            .collect
            .map(|callback| result(unsafe { callback(self.context) }))
            .unwrap_or(Ok(()))
    }
    fn shutdown(&mut self) {
        if let Some(callback) = self.table.shutdown {
            unsafe {
                callback(self.context);
            }
        }
    }
}
fn motion_header(source: &MotionState) -> PocketMotionState {
    PocketMotionState {
        timestamp: source.timestamp,
        gravity_direction: source
            .gravity_direction
            .as_ref()
            .map_or(ptr::null(), |value| value),
        inclination: source
            .inclination
            .as_ref()
            .map_or(ptr::null(), |value| value),
        linear_acceleration: source
            .linear_acceleration
            .as_ref()
            .map_or(ptr::null(), |value| value),
        rotation_rate: source
            .rotation_rate
            .as_ref()
            .map_or(ptr::null(), |value| value),
        orientation: source
            .orientation
            .as_ref()
            .map_or(ptr::null(), |value| value),
        heading: source.heading.as_ref().map_or(ptr::null(), |value| value),
        screen_rotation: source
            .screen_rotation
            .as_ref()
            .map_or(ptr::null(), |value| value),
        tilt: source.tilt.as_ref().map_or(ptr::null(), |value| value),
        angles: source.angles.as_ref().map_or(ptr::null(), |value| value),
        ..PocketMotionState::empty()
    }
}
