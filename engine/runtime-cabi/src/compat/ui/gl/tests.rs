#![allow(unused_variables)]
use super::*;
use alloc::vec::Vec;
use core::ffi::{c_char, c_void};
use pocket_gles::raw::*;
use std;
#[derive(Default)]
struct GlState {
    next: u32,
    events: Vec<&'static str>,
    uploads: Vec<Vec<u8>>,
    buffers: Vec<Vec<u8>>,
    error: u32,
    fail_upload: bool,
    fail_draw: bool,
}
std::thread_local! { static GL: std::cell::RefCell<GlState> = std::cell::RefCell::new(GlState::default()); }
fn event(value: &'static str) {
    GL.with(|gl| gl.borrow_mut().events.push(value));
}
#[no_mangle]
unsafe extern "C" fn glGetError() -> u32 {
    GL.with(|gl| core::mem::take(&mut gl.borrow_mut().error))
}
#[no_mangle]
unsafe extern "C" fn glGetIntegerv(_: u32, out: *mut i32) {
    *out = 2048;
}
#[no_mangle]
unsafe extern "C" fn glGenTextures(n: i32, out: *mut u32) {
    for i in 0..n {
        *out.add(i as usize) = GL.with(|gl| {
            let mut gl = gl.borrow_mut();
            gl.next += 1;
            gl.next
        });
    }
}
#[no_mangle]
unsafe extern "C" fn glGenBuffers(n: i32, out: *mut u32) {
    glGenTextures(n, out);
}
#[no_mangle]
unsafe extern "C" fn glFinish() {
    event("finish");
}
#[no_mangle]
unsafe extern "C" fn glDeleteTextures(_: i32, _: *const u32) {
    event("texture-delete");
}
#[no_mangle]
unsafe extern "C" fn glDeleteBuffers(_: i32, _: *const u32) {
    event("buffer-delete");
}
#[no_mangle]
unsafe extern "C" fn glBindBuffer(_: u32, _: u32) {}
#[no_mangle]
unsafe extern "C" fn glBindTexture(_: u32, _: u32) {}
#[no_mangle]
unsafe extern "C" fn glBufferData(_: u32, size: isize, data: *const c_void, _: u32) {
    GL.with(|gl| {
        gl.borrow_mut()
            .buffers
            .push(core::slice::from_raw_parts(data.cast(), size as usize).to_vec())
    });
}
#[no_mangle]
unsafe extern "C" fn glClear(_: u32) {
    event("clear");
}
#[no_mangle]
unsafe extern "C" fn glClearColor(_: f32, _: f32, _: f32, _: f32) {}
#[no_mangle]
unsafe extern "C" fn glDisable(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glEnable(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glDrawArrays(_: u32, _: i32, _: i32) {
    event("draw");
    GL.with(|gl| {
        let mut gl = gl.borrow_mut();
        if gl.fail_draw {
            gl.error = 0x0502;
        }
    });
}
#[no_mangle]
unsafe extern "C" fn glPixelStorei(_: u32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glScissor(_: i32, _: i32, _: i32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glViewport(_: i32, _: i32, _: i32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glTexParameteri(_: u32, _: u32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glTexImage2D(
    _: u32,
    _: i32,
    _: i32,
    w: i32,
    h: i32,
    _: i32,
    format: u32,
    _: u32,
    pixels: *const c_void,
) {
    GL.with(|gl| {
        let mut gl = gl.borrow_mut();
        let channels = if format == GL_RGBA { 4 } else { 2 };
        gl.uploads.push(
            core::slice::from_raw_parts(pixels.cast(), w as usize * h as usize * channels).to_vec(),
        );
        if gl.fail_upload {
            gl.error = 0x0505;
        }
    });
}
#[no_mangle]
unsafe extern "C" fn glActiveTexture(x: u32) {}
#[no_mangle]
unsafe extern "C" fn glBlendFunc(x: u32, y: u32) {}
#[no_mangle]
unsafe extern "C" fn glEnableClientState(x: u32) {}
#[no_mangle]
unsafe extern "C" fn glDisableClientState(x: u32) {}
#[no_mangle]
unsafe extern "C" fn glLoadIdentity() {}
#[no_mangle]
unsafe extern "C" fn glMatrixMode(x: u32) {}
#[no_mangle]
unsafe extern "C" fn glShadeModel(x: u32) {}
#[no_mangle]
unsafe extern "C" fn glTexEnvi(x: u32, y: u32, z: i32) {}
#[no_mangle]
unsafe extern "C" fn glOrthof(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {}
#[no_mangle]
unsafe extern "C" fn glVertexPointer(a: i32, b: u32, c: i32, d: *const c_void) {}
#[no_mangle]
unsafe extern "C" fn glTexCoordPointer(a: i32, b: u32, c: i32, d: *const c_void) {}
#[no_mangle]
unsafe extern "C" fn glColorPointer(a: i32, b: u32, c: i32, d: *const c_void) {}
#[no_mangle]
unsafe extern "C" fn glAttachShader(_: u32, _: u32) {}
#[no_mangle]
unsafe extern "C" fn glBindAttribLocation(_: u32, _: u32, _: *const c_char) {}
#[no_mangle]
unsafe extern "C" fn glBlendFuncSeparate(a: u32, b: u32, c: u32, d: u32) {}
#[no_mangle]
unsafe extern "C" fn glCompileShader(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glCreateProgram() -> u32 {
    42
}
#[no_mangle]
unsafe extern "C" fn glCreateShader(kind: u32) -> u32 {
    42
}
#[no_mangle]
unsafe extern "C" fn glDeleteProgram(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glDeleteShader(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glDisableVertexAttribArray(x: u32) {}
#[no_mangle]
unsafe extern "C" fn glEnableVertexAttribArray(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glGetProgramiv(_: u32, _: u32, value: *mut i32) {
    *value = 1;
}
#[no_mangle]
unsafe extern "C" fn glGetShaderiv(_: u32, _: u32, value: *mut i32) {
    *value = 1;
}
#[no_mangle]
unsafe extern "C" fn glGetUniformLocation(_: u32, _: *const c_char) -> i32 {
    0
}
#[no_mangle]
unsafe extern "C" fn glLinkProgram(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glShaderSource(_: u32, _: i32, source: *const *const c_char, _: *const i32) {}
#[no_mangle]
unsafe extern "C" fn glUniform1i(_: i32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glUniform2f(_: i32, x: f32, y: f32) {}
#[no_mangle]
unsafe extern "C" fn glUseProgram(x: u32) {}
#[no_mangle]
unsafe extern "C" fn glVertexAttribPointer(
    a: u32,
    b: i32,
    c: u32,
    d: u8,
    e: i32,
    f: *const c_void,
) {
}

extern "C" fn callback(stage: u32, commands: u32, vertices: u32) {
    TRACE_EVENTS.with(|events| events.borrow_mut().push((stage, commands, vertices)));
}
std::thread_local! {static TRACE_EVENTS:std::cell::RefCell<Vec<(u32,u32,u32)>>=std::cell::RefCell::new(Vec::new());}
#[test]
fn legacy_entry_point_uses_instance_driver_and_preserves_trace_stages() {
    use pocketjs_core::spec;
    let mut ui = Ui::new();
    ui.set_viewport(100.0, 50.0);
    let rect = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(rect, spec::prop::WIDTH, 20.0);
    ui.set_prop(rect, spec::prop::HEIGHT, 20.0);
    ui.set_prop(rect, spec::prop::BG_COLOR, u32::MAX as f64);
    ui.insert_before(spec::ROOT_ID, rect, 0);
    ui.tick();
    unsafe {
        assert!(initialize());
        set_trace(Some(callback));
        assert!(render(&mut ui, 0, 0, 100, 50, 100, 50));
    }
    TRACE_EVENTS.with(|events| {
        assert_eq!(
            events
                .borrow()
                .iter()
                .map(|value| value.0)
                .collect::<Vec<_>>(),
            [0, 1, 2, 3, 4, 5, 6]
        )
    });
    GL.with(|gl| {
        let gl = gl.borrow();
        assert!(!gl.buffers.is_empty());
        let finish = gl
            .events
            .iter()
            .position(|event| *event == "finish")
            .unwrap();
        let delete = gl
            .events
            .iter()
            .position(|event| *event == "buffer-delete")
            .unwrap();
        assert!(finish < delete);
    });
    unsafe {
        invalidate_font(0);
        invalidate_resources();
        reset_resources();
        assert!(render_over(&mut ui, 0, 0, 100, 50, 100, 50));
        set_trace(None);
        shutdown();
    }
}
