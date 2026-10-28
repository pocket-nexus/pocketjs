//! The camera as the runtime's video plane (spec ops 34..37: `videoOpen`,
//! `videoTick`, `videoTexture`, `videoClose`). `videoOpen("camera")` starts
//! the device's live stream (device/camera.rs) and allocates one 256x128
//! RGBA texture; each `videoTick()` copies the newest decoded frame into that
//! texture in place (`Ui::update_texture_rect`) and answers the frame's
//! number, so an Image node bound to `videoTexture()` follows the lens while
//! no frame crosses JavaScript or the worker's channels. `videoClose()`
//! stops the stream and frees the texture.
use crate::device::{camera, Device};
use pocket_runtime::{OpArg, OpProvider, OpResult, RuntimeError};

const OPEN: u16 = 34;
const TICK: u16 = 35;
const TEXTURE: u16 = 36;
const CLOSE: u16 = 37;

/// The one stream this provider opens.
pub const CAMERA: &str = "camera";

pub struct CameraPlane {
    device: Device,
    texture: i32,
    shown: Option<u32>,
}

impl CameraPlane {
    pub fn new(device: Device) -> Self {
        Self {
            device,
            texture: -1,
            shown: None,
        }
    }
}

impl OpProvider for CameraPlane {
    fn supports_op(&self, op: u16) -> bool {
        matches!(op, OPEN..=CLOSE)
    }

    fn dispatch(
        &mut self,
        ui: &mut pocketjs_core::Ui,
        op: u16,
        args: &[OpArg<'_>],
    ) -> Result<OpResult, RuntimeError> {
        match op {
            OPEN => {
                let Some(OpArg::Bytes(path)) = args.first() else {
                    return Err(RuntimeError::InvalidArgument);
                };
                if *path != CAMERA.as_bytes() || self.device.start_live().is_err() {
                    return Ok(OpResult::Integer(0));
                }
                if self.texture < 0 {
                    let blank = vec![0u8; camera::TEXTURE_W * camera::TEXTURE_H * 4];
                    self.texture = ui.upload_texture(
                        &blank,
                        camera::TEXTURE_W as u32,
                        camera::TEXTURE_H as u32,
                        pocket_spec::psm::PSM_8888,
                    );
                }
                self.shown = None;
                Ok(OpResult::Integer(i64::from(self.texture >= 0)))
            }
            TICK => {
                if self.texture >= 0 {
                    if let Some((frame, rgba)) = self.device.newest_frame(self.shown) {
                        if ui.update_texture_rect(
                            self.texture,
                            0,
                            0,
                            camera::TEXTURE_W as u32,
                            camera::TEXTURE_H as u32,
                            &rgba,
                        ) {
                            self.shown = Some(frame);
                        }
                    }
                }
                Ok(OpResult::Integer(self.shown.map_or(-1, i64::from)))
            }
            TEXTURE => Ok(OpResult::Integer(i64::from(self.texture))),
            CLOSE => {
                self.device.stop_live();
                if self.texture >= 0 {
                    ui.free_texture(self.texture);
                }
                self.texture = -1;
                self.shown = None;
                Ok(OpResult::None)
            }
            _ => Err(RuntimeError::UnsupportedOperation),
        }
    }
}
