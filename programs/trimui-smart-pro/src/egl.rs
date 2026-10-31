//! The firmware's PowerVR EGL: a null native window is the whole panel. There
//! is no windowing system; a window surface on display 0 scans out directly.
#![allow(non_snake_case)]
use std::ffi::c_void;

type Pointer = *mut c_void;
const NO_DISPLAY: Pointer = std::ptr::null_mut();
const OPENGL_ES_API: u32 = 0x30a0;
const NONE: i32 = 0x3038;
const CONTEXT_MAJOR_VERSION: i32 = 0x3098;
const WIDTH: i32 = 0x3057;
const HEIGHT: i32 = 0x3056;

#[link(name = "EGL")]
unsafe extern "C" {
    fn eglGetDisplay(native: Pointer) -> Pointer;
    fn eglInitialize(display: Pointer, major: *mut i32, minor: *mut i32) -> u32;
    fn eglBindAPI(api: u32) -> u32;
    fn eglChooseConfig(
        display: Pointer,
        attributes: *const i32,
        configs: *mut Pointer,
        size: i32,
        count: *mut i32,
    ) -> u32;
    fn eglCreateContext(
        display: Pointer,
        config: Pointer,
        share: Pointer,
        attributes: *const i32,
    ) -> Pointer;
    fn eglCreateWindowSurface(
        display: Pointer,
        config: Pointer,
        window: usize,
        attributes: *const i32,
    ) -> Pointer;
    fn eglMakeCurrent(display: Pointer, draw: Pointer, read: Pointer, context: Pointer) -> u32;
    fn eglSwapBuffers(display: Pointer, surface: Pointer) -> u32;
    fn eglSwapInterval(display: Pointer, interval: i32) -> u32;
    fn eglQuerySurface(display: Pointer, surface: Pointer, attribute: i32, value: *mut i32) -> u32;
    fn eglGetError() -> i32;
}

pub struct Egl {
    display: Pointer,
    surface: Pointer,
    pub width: i32,
    pub height: i32,
}

impl Egl {
    pub fn open() -> anyhow::Result<Self> {
        unsafe {
            let display = eglGetDisplay(NO_DISPLAY);
            anyhow::ensure!(!display.is_null(), "eglGetDisplay: {:#x}", eglGetError());
            let (mut major, mut minor) = (0, 0);
            anyhow::ensure!(
                eglInitialize(display, &mut major, &mut minor) != 0,
                "eglInitialize: {:#x}",
                eglGetError()
            );
            eglBindAPI(OPENGL_ES_API);
            // RGBA8888, depth 24, window surface, ES3, no MSAA: 4x costs a tile pass
            // the room's textured geometry does not need.
            let attributes = [
                0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3025, 24, 0x3033, 4, 0x3040, 0x40,
                NONE,
            ];
            let mut config = std::ptr::null_mut();
            let mut count = 0;
            anyhow::ensure!(
                eglChooseConfig(display, attributes.as_ptr(), &mut config, 1, &mut count) != 0
                    && count > 0,
                "eglChooseConfig: {:#x}",
                eglGetError()
            );
            let context = eglCreateContext(
                display,
                config,
                std::ptr::null_mut(),
                [CONTEXT_MAJOR_VERSION, 3, NONE].as_ptr(),
            );
            anyhow::ensure!(!context.is_null(), "eglCreateContext: {:#x}", eglGetError());
            let surface = eglCreateWindowSurface(display, config, 0, std::ptr::null());
            anyhow::ensure!(
                !surface.is_null(),
                "eglCreateWindowSurface: {:#x}",
                eglGetError()
            );
            anyhow::ensure!(
                eglMakeCurrent(display, surface, surface, context) != 0,
                "eglMakeCurrent: {:#x}",
                eglGetError()
            );
            eglSwapInterval(display, 1);
            let (mut width, mut height) = (0, 0);
            eglQuerySurface(display, surface, WIDTH, &mut width);
            eglQuerySurface(display, surface, HEIGHT, &mut height);
            Ok(Self {
                display,
                surface,
                width,
                height,
            })
        }
    }

    pub fn swap(&mut self) -> bool {
        unsafe { eglSwapBuffers(self.display, self.surface) != 0 }
    }
}
