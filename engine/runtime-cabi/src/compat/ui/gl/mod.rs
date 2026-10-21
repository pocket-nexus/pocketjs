//! Legacy singleton entry points adapting Ui to the instance GLES drivers.
//!
//! The C host must make its context current before initialize, render, reset,
//! and shutdown. Resource invalidation does not call GL. New hosts implement
//! ContextAccess and select pocket-gles1 or pocket-gles2 by Rust type.

use pocket_drivers::{FrameInput, PixelFormat, RenderError, Renderer, Target};
pub use pocket_gles::Trace;
use pocket_gles::{ClearMode, ContextAccess, TargetConfig, Viewport};
use pocketjs_core::Ui;

struct LegacyContext;
// The old C entry points are unsafe and require a current host-owned context.
// They have no context-switch callback; this adapter preserves that contract.
unsafe impl ContextAccess for LegacyContext {
    type NativeTarget = ();
    fn ensure_current(&mut self) -> Result<(), RenderError> {
        Ok(())
    }
    fn bind_target(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
}
#[cfg(feature = "gles1")]
type Driver = pocket_gles1::Renderer<LegacyContext>;
#[cfg(not(feature = "gles1"))]
type Driver = pocket_gles2::Renderer<LegacyContext>;
struct LegacyRenderer {
    driver: Driver,
    warmed: bool,
}
static mut RENDERER: Option<LegacyRenderer> = None;
static mut TRACE: Option<Trace> = None;

extern "C" fn driver_trace(stage: u32, commands: u32, vertices: u32) {
    // Ui draw timing remains in stages 0/1; the driver owns stages 2..6.
    if stage >= 2 {
        unsafe {
            if let Some(callback) = TRACE {
                callback(stage, commands, vertices);
            }
        }
    }
}
pub unsafe fn set_trace(trace: Option<Trace>) {
    TRACE = trace;
}
pub unsafe fn initialize() -> bool {
    drop(RENDERER.take());
    RENDERER = Driver::new(LegacyContext).ok().map(|mut driver| {
        driver.set_trace(Some(driver_trace));
        LegacyRenderer {
            driver,
            warmed: false,
        }
    });
    RENDERER.is_some()
}
pub unsafe fn reset_resources() {
    if let Some(renderer) = RENDERER.as_mut() {
        let _ = renderer.driver.reset_resources();
        renderer.warmed = false;
    }
}
pub unsafe fn invalidate_resources() {
    if let Some(renderer) = RENDERER.as_mut() {
        renderer.driver.invalidate_resources();
        renderer.warmed = false;
    }
}
pub unsafe fn invalidate_font(slot: u8) {
    if let Some(renderer) = RENDERER.as_mut() {
        renderer.driver.invalidate_font(slot);
    }
}
pub unsafe fn shutdown() {
    drop(RENDERER.take());
}

unsafe fn render_frame(
    ui: &mut Ui,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    window_width: i32,
    window_height: i32,
    clear: ClearMode,
) -> bool {
    let Some(renderer) = RENDERER.as_mut() else {
        return false;
    };
    if window_width <= 0 || window_height <= 0 {
        return true;
    }
    if width <= 0 || height <= 0 {
        if clear == ClearMode::OpaqueBlack {
            use pocket_gles::raw::*;
            glDisable(GL_SCISSOR_TEST);
            glViewport(0, 0, window_width, window_height);
            glClearColor(0.0, 0.0, 0.0, 1.0);
            glClear(GL_COLOR_BUFFER_BIT);
            glFinish();
        }
        return true;
    }
    if let Some(callback) = TRACE {
        callback(0, 0, 0);
    }
    if !renderer.warmed {
        // Core preparation belongs to this Ui adapter. The driver receives
        // only the resulting borrowed DrawList and RenderResources views.
        ui.warm_static_glyph_pages(2 * 1024 * 1024);
        renderer.warmed = true;
    }
    ui.draw();
    if let Some(callback) = TRACE {
        callback(1, 0, 0);
    }
    let mut config = TargetConfig::new(
        (),
        [window_width as u32, window_height as u32],
        Viewport::new(x, y, width as u32, height as u32),
        PixelFormat::Rgba8888,
    );
    config.clear = clear;
    config.external_compositor = true;
    let Ok(handle) = renderer.driver.register_target(config) else {
        return false;
    };
    let target = renderer.driver.target(handle).unwrap();
    let mut frame = FrameInput::new(ui.current_draw_list(), ui, &[], Target::DeviceOwned(target));
    let result = match renderer.driver.render(&mut frame) {
        Ok(submission) => {
            let result = renderer.driver.wait(&submission);
            renderer.driver.retire(submission);
            result.is_ok()
        }
        Err(_) => false,
    };
    let _ = renderer.driver.unregister_target(handle);
    result
}
pub unsafe fn render(
    ui: &mut Ui,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    window_width: i32,
    window_height: i32,
) -> bool {
    render_frame(
        ui,
        x,
        y,
        width,
        height,
        window_width,
        window_height,
        ClearMode::OpaqueBlack,
    )
}
pub unsafe fn render_over(
    ui: &mut Ui,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    window_width: i32,
    window_height: i32,
) -> bool {
    render_frame(
        ui,
        x,
        y,
        width,
        height,
        window_width,
        window_height,
        ClearMode::Preserve,
    )
}

#[cfg(test)]
mod tests;
