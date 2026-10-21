use super::*;
use pocket_gles::Pipeline as _;
use std::{cell::RefCell, vec::Vec};
#[derive(Default)]
struct State {
    events: Vec<(u32, Vec<f32>)>,
    shaders: Vec<Vec<u8>>,
    fail_link: bool,
}
std::thread_local! {static STATE:RefCell<State>=RefCell::new(State::default());}
fn event(kind: u32, args: &[f32]) {
    STATE.with(|state| state.borrow_mut().events.push((kind, args.to_vec())));
}
#[no_mangle]
unsafe extern "C" fn glGetError() -> u32 {
    0
}
#[no_mangle]
unsafe extern "C" fn glActiveTexture(x: u32) {
    event(1, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glAttachShader(_: u32, _: u32) {}
#[no_mangle]
unsafe extern "C" fn glBindAttribLocation(_: u32, _: u32, _: *const c_char) {}
#[no_mangle]
unsafe extern "C" fn glBlendFuncSeparate(a: u32, b: u32, c: u32, d: u32) {
    event(2, &[a as f32, b as f32, c as f32, d as f32]);
}
#[no_mangle]
unsafe extern "C" fn glCompileShader(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glCreateProgram() -> u32 {
    3
}
#[no_mangle]
unsafe extern "C" fn glCreateShader(kind: u32) -> u32 {
    kind
}
#[no_mangle]
unsafe extern "C" fn glDeleteProgram(_: u32) {
    event(3, &[]);
}
#[no_mangle]
unsafe extern "C" fn glDeleteShader(_: u32) {
    event(4, &[]);
}
#[no_mangle]
unsafe extern "C" fn glDisableVertexAttribArray(x: u32) {
    event(5, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glEnableVertexAttribArray(_: u32) {}
#[no_mangle]
unsafe extern "C" fn glGetProgramiv(_: u32, _: u32, value: *mut i32) {
    *value = STATE.with(|state| !state.borrow().fail_link) as i32;
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
unsafe extern "C" fn glShaderSource(_: u32, _: i32, source: *const *const c_char, _: *const i32) {
    STATE.with(|state| {
        state
            .borrow_mut()
            .shaders
            .push(core::ffi::CStr::from_ptr(*source).to_bytes().to_vec())
    });
}
#[no_mangle]
unsafe extern "C" fn glUniform1i(_: i32, _: i32) {}
#[no_mangle]
unsafe extern "C" fn glUniform2f(_: i32, x: f32, y: f32) {
    event(6, &[x, y]);
}
#[no_mangle]
unsafe extern "C" fn glUseProgram(x: u32) {
    event(7, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glVertexAttribPointer(
    a: u32,
    b: i32,
    c: u32,
    d: u8,
    e: i32,
    f: *const c_void,
) {
    event(
        8,
        &[
            a as f32,
            b as f32,
            c as f32,
            d as f32,
            e as f32,
            f as usize as f32,
        ],
    );
}
#[test]
fn shader_pipeline_retains_color_normalization_and_alpha_blend() {
    unsafe {
        let mut pipeline = Pipeline::new().unwrap();
        pipeline.begin_frame(360.0, 640.0);
        pipeline.set_blend();
        pipeline.bind_vertices(20);
        pipeline.unbind_vertices();
        pipeline.destroy();
    }
    STATE.with(|state| {
        let state = state.borrow();
        assert_eq!(state.shaders[0], &VERTEX_SHADER[..VERTEX_SHADER.len() - 1]);
        assert_eq!(
            state.shaders[1],
            &FRAGMENT_SHADER[..FRAGMENT_SHADER.len() - 1]
        );
        assert!(state.events.contains(&(6, std::vec![360.0, 640.0])));
        assert!(state.events.contains(&(
            2,
            std::vec![
                GL_SRC_ALPHA as f32,
                GL_ONE_MINUS_SRC_ALPHA as f32,
                1.0,
                GL_ONE_MINUS_SRC_ALPHA as f32
            ]
        )));
        for (index, size, kind, normalized, offset) in [
            (0, 2, GL_FLOAT, 0, 0),
            (1, 2, GL_FLOAT, 0, 8),
            (2, 4, GL_UNSIGNED_BYTE, 1, 16),
        ] {
            assert!(state.events.contains(&(
                8,
                std::vec![
                    index as f32,
                    size as f32,
                    kind as f32,
                    normalized as f32,
                    20.0,
                    offset as f32
                ]
            )));
        }
        assert_eq!(
            state.events.iter().filter(|(kind, _)| *kind == 5).count(),
            3
        );
    });
}
#[test]
fn failed_link_releases_both_shaders_and_program() {
    STATE.with(|state| state.borrow_mut().fail_link = true);
    assert!(unsafe { Pipeline::new() }.is_none());
    STATE.with(|state| {
        let state = state.borrow();
        assert_eq!(
            state.events.iter().filter(|(kind, _)| *kind == 4).count(),
            2
        );
        assert_eq!(
            state.events.iter().filter(|(kind, _)| *kind == 3).count(),
            1
        );
    });
}
