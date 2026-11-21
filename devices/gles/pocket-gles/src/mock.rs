//! One recording definition of every entry point in `raw`, for host tests of
//! the three GLES crates. Compiled for this crate's own tests and under the
//! `mock-gl` feature, which the pipeline crates enable from their
//! dev-dependencies. State is per thread, so parallel tests do not share it.
//!
//! Object names come from one counter. `glTexImage2D` keeps each upload's
//! bytes and `glBufferData` each buffer's bytes. `glGetError` returns and
//! clears the pending error; a failing upload sets `GL_OUT_OF_MEMORY`, a
//! failing draw `GL_INVALID_OPERATION`. Programs link unless `fail_link`.
extern crate std;

use crate::raw::*;
use alloc::vec::Vec;
use core::ffi::{c_char, c_void, CStr};
use std::cell::RefCell;

/// One recorded entry point call, with the arguments tests inspect.
#[derive(Clone, Debug, PartialEq)]
pub enum Call {
    ActiveTexture(GLenum),
    Finish,
    BindBuffer(GLenum, GLuint),
    BindTexture(GLenum, GLuint),
    BufferData(usize),
    Clear(GLbitfield),
    ClearColor,
    DeleteBuffers(GLsizei),
    DeleteTextures(GLsizei),
    Disable(GLenum),
    DrawArrays(GLenum, GLint, GLsizei),
    Enable(GLenum),
    GenBuffers(GLsizei),
    GenTextures(GLsizei),
    GetIntegerv(GLenum),
    PixelStorei(GLenum, GLint),
    Scissor([GLint; 4]),
    TexImage2D {
        width: GLsizei,
        height: GLsizei,
        format: GLenum,
    },
    TexParameteri(GLenum, GLenum, GLint),
    Viewport([GLint; 4]),
    BlendFunc(GLenum, GLenum),
    ColorPointer(GLint, GLenum, GLsizei, usize),
    DisableClientState(GLenum),
    EnableClientState(GLenum),
    LoadIdentity,
    MatrixMode(GLenum),
    ShadeModel(GLenum),
    Orthof([GLfloat; 6]),
    TexCoordPointer(GLint, GLenum, GLsizei, usize),
    TexEnvi(GLenum, GLenum, GLint),
    VertexPointer(GLint, GLenum, GLsizei, usize),
    AttachShader(GLuint, GLuint),
    BindAttribLocation(GLuint, GLuint),
    BlendFuncSeparate(GLenum, GLenum, GLenum, GLenum),
    CompileShader(GLuint),
    CreateProgram,
    CreateShader(GLenum),
    DeleteProgram(GLuint),
    DeleteShader(GLuint),
    DisableVertexAttribArray(GLuint),
    EnableVertexAttribArray(GLuint),
    GetProgramiv(GLuint, GLenum),
    GetShaderiv(GLuint, GLenum),
    GetUniformLocation(GLuint),
    LinkProgram(GLuint),
    ShaderSource(GLuint),
    Uniform1i(GLint, GLint),
    Uniform2f(GLint, GLfloat, GLfloat),
    UseProgram(GLuint),
    VertexAttribPointer(GLuint, GLint, GLenum, GLboolean, GLsizei, usize),
    /// A marker a test places in the call order with [`note`].
    Note(&'static str),
}

/// The recorded state of the calling thread's mock context.
#[derive(Default)]
pub struct Gl {
    pub next: u32,
    pub calls: Vec<Call>,
    pub uploads: Vec<Vec<u8>>,
    pub buffers: Vec<Vec<u8>>,
    pub shaders: Vec<Vec<u8>>,
    pub error: GLenum,
    pub fail_upload: bool,
    pub fail_draw: bool,
    pub fail_link: bool,
}

const GL_INVALID_OPERATION: GLenum = 0x0502;
const GL_OUT_OF_MEMORY: GLenum = 0x0505;

std::thread_local! {
    static GL: RefCell<Gl> = RefCell::new(Gl::default());
}

/// Read or change the calling thread's state.
pub fn with<R>(f: impl FnOnce(&mut Gl) -> R) -> R {
    GL.with(|gl| f(&mut gl.borrow_mut()))
}

/// Return the calling thread's state to its defaults.
pub fn reset() {
    with(|gl| *gl = Gl::default());
}

/// The calls recorded so far, in order.
pub fn calls() -> Vec<Call> {
    with(|gl| gl.calls.clone())
}

/// Record a marker in the call order.
pub fn note(label: &'static str) {
    record(Call::Note(label));
}

fn record(call: Call) {
    with(|gl| gl.calls.push(call));
}

#[no_mangle]
unsafe extern "C" fn glActiveTexture(texture: GLenum) {
    record(Call::ActiveTexture(texture));
}
#[no_mangle]
unsafe extern "C" fn glFinish() {
    record(Call::Finish);
}
#[no_mangle]
unsafe extern "C" fn glBindBuffer(target: GLenum, buffer: GLuint) {
    record(Call::BindBuffer(target, buffer));
}
#[no_mangle]
unsafe extern "C" fn glBindTexture(target: GLenum, texture: GLuint) {
    record(Call::BindTexture(target, texture));
}
#[no_mangle]
unsafe extern "C" fn glBufferData(
    _target: GLenum,
    size: GLsizeiptr,
    data: *const c_void,
    _usage: GLenum,
) {
    let bytes = core::slice::from_raw_parts(data.cast::<u8>(), size as usize).to_vec();
    with(|gl| {
        gl.calls.push(Call::BufferData(bytes.len()));
        gl.buffers.push(bytes);
    });
}
#[no_mangle]
unsafe extern "C" fn glClear(mask: GLbitfield) {
    record(Call::Clear(mask));
}
#[no_mangle]
unsafe extern "C" fn glClearColor(_: GLfloat, _: GLfloat, _: GLfloat, _: GLfloat) {
    record(Call::ClearColor);
}
#[no_mangle]
unsafe extern "C" fn glDeleteBuffers(count: GLsizei, _: *const GLuint) {
    record(Call::DeleteBuffers(count));
}
#[no_mangle]
unsafe extern "C" fn glDeleteTextures(count: GLsizei, _: *const GLuint) {
    record(Call::DeleteTextures(count));
}
#[no_mangle]
unsafe extern "C" fn glDisable(capability: GLenum) {
    record(Call::Disable(capability));
}
#[no_mangle]
unsafe extern "C" fn glDrawArrays(mode: GLenum, first: GLint, count: GLsizei) {
    with(|gl| {
        gl.calls.push(Call::DrawArrays(mode, first, count));
        if gl.fail_draw {
            gl.error = GL_INVALID_OPERATION;
        }
    });
}
#[no_mangle]
unsafe extern "C" fn glEnable(capability: GLenum) {
    record(Call::Enable(capability));
}
#[no_mangle]
unsafe extern "C" fn glGenBuffers(count: GLsizei, out: *mut GLuint) {
    record(Call::GenBuffers(count));
    generate(count, out);
}
#[no_mangle]
unsafe extern "C" fn glGenTextures(count: GLsizei, out: *mut GLuint) {
    record(Call::GenTextures(count));
    generate(count, out);
}
unsafe fn generate(count: GLsizei, out: *mut GLuint) {
    for index in 0..count {
        *out.add(index as usize) = with(|gl| {
            gl.next += 1;
            gl.next
        });
    }
}
#[no_mangle]
unsafe extern "C" fn glGetError() -> GLenum {
    with(|gl| core::mem::take(&mut gl.error))
}
#[no_mangle]
unsafe extern "C" fn glGetIntegerv(parameter: GLenum, value: *mut GLint) {
    record(Call::GetIntegerv(parameter));
    *value = 2048;
}
#[no_mangle]
unsafe extern "C" fn glPixelStorei(parameter: GLenum, value: GLint) {
    record(Call::PixelStorei(parameter, value));
}
#[no_mangle]
unsafe extern "C" fn glScissor(x: GLint, y: GLint, width: GLsizei, height: GLsizei) {
    record(Call::Scissor([x, y, width, height]));
}
#[no_mangle]
unsafe extern "C" fn glTexImage2D(
    _target: GLenum,
    _level: GLint,
    _internal_format: GLint,
    width: GLsizei,
    height: GLsizei,
    _border: GLint,
    format: GLenum,
    _kind: GLenum,
    pixels: *const c_void,
) {
    let channels = if format == GL_RGBA { 4 } else { 2 };
    let bytes = core::slice::from_raw_parts(
        pixels.cast::<u8>(),
        width as usize * height as usize * channels,
    )
    .to_vec();
    with(|gl| {
        gl.calls.push(Call::TexImage2D {
            width,
            height,
            format,
        });
        gl.uploads.push(bytes);
        if gl.fail_upload {
            gl.error = GL_OUT_OF_MEMORY;
        }
    });
}
#[no_mangle]
unsafe extern "C" fn glTexParameteri(target: GLenum, parameter: GLenum, value: GLint) {
    record(Call::TexParameteri(target, parameter, value));
}
#[no_mangle]
unsafe extern "C" fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei) {
    record(Call::Viewport([x, y, width, height]));
}

#[no_mangle]
unsafe extern "C" fn glBlendFunc(source: GLenum, destination: GLenum) {
    record(Call::BlendFunc(source, destination));
}
#[no_mangle]
unsafe extern "C" fn glColorPointer(
    size: GLint,
    kind: GLenum,
    stride: GLsizei,
    pointer: *const c_void,
) {
    record(Call::ColorPointer(size, kind, stride, pointer as usize));
}
#[no_mangle]
unsafe extern "C" fn glDisableClientState(array: GLenum) {
    record(Call::DisableClientState(array));
}
#[no_mangle]
unsafe extern "C" fn glEnableClientState(array: GLenum) {
    record(Call::EnableClientState(array));
}
#[no_mangle]
unsafe extern "C" fn glLoadIdentity() {
    record(Call::LoadIdentity);
}
#[no_mangle]
unsafe extern "C" fn glMatrixMode(mode: GLenum) {
    record(Call::MatrixMode(mode));
}
#[no_mangle]
unsafe extern "C" fn glShadeModel(mode: GLenum) {
    record(Call::ShadeModel(mode));
}
#[no_mangle]
unsafe extern "C" fn glOrthof(
    left: GLfloat,
    right: GLfloat,
    bottom: GLfloat,
    top: GLfloat,
    near: GLfloat,
    far: GLfloat,
) {
    record(Call::Orthof([left, right, bottom, top, near, far]));
}
#[no_mangle]
unsafe extern "C" fn glTexCoordPointer(
    size: GLint,
    kind: GLenum,
    stride: GLsizei,
    pointer: *const c_void,
) {
    record(Call::TexCoordPointer(size, kind, stride, pointer as usize));
}
#[no_mangle]
unsafe extern "C" fn glTexEnvi(target: GLenum, parameter: GLenum, value: GLint) {
    record(Call::TexEnvi(target, parameter, value));
}
#[no_mangle]
unsafe extern "C" fn glVertexPointer(
    size: GLint,
    kind: GLenum,
    stride: GLsizei,
    pointer: *const c_void,
) {
    record(Call::VertexPointer(size, kind, stride, pointer as usize));
}

#[no_mangle]
unsafe extern "C" fn glAttachShader(program: GLuint, shader: GLuint) {
    record(Call::AttachShader(program, shader));
}
#[no_mangle]
unsafe extern "C" fn glBindAttribLocation(program: GLuint, index: GLuint, _: *const c_char) {
    record(Call::BindAttribLocation(program, index));
}
#[no_mangle]
unsafe extern "C" fn glBlendFuncSeparate(
    source_rgb: GLenum,
    destination_rgb: GLenum,
    source_alpha: GLenum,
    destination_alpha: GLenum,
) {
    record(Call::BlendFuncSeparate(
        source_rgb,
        destination_rgb,
        source_alpha,
        destination_alpha,
    ));
}
#[no_mangle]
unsafe extern "C" fn glCompileShader(shader: GLuint) {
    record(Call::CompileShader(shader));
}
#[no_mangle]
unsafe extern "C" fn glCreateProgram() -> GLuint {
    record(Call::CreateProgram);
    3
}
#[no_mangle]
unsafe extern "C" fn glCreateShader(kind: GLenum) -> GLuint {
    record(Call::CreateShader(kind));
    kind
}
#[no_mangle]
unsafe extern "C" fn glDeleteProgram(program: GLuint) {
    record(Call::DeleteProgram(program));
}
#[no_mangle]
unsafe extern "C" fn glDeleteShader(shader: GLuint) {
    record(Call::DeleteShader(shader));
}
#[no_mangle]
unsafe extern "C" fn glDisableVertexAttribArray(index: GLuint) {
    record(Call::DisableVertexAttribArray(index));
}
#[no_mangle]
unsafe extern "C" fn glEnableVertexAttribArray(index: GLuint) {
    record(Call::EnableVertexAttribArray(index));
}
#[no_mangle]
unsafe extern "C" fn glGetProgramiv(program: GLuint, parameter: GLenum, value: *mut GLint) {
    *value = with(|gl| {
        gl.calls.push(Call::GetProgramiv(program, parameter));
        !gl.fail_link
    }) as GLint;
}
#[no_mangle]
unsafe extern "C" fn glGetShaderiv(shader: GLuint, parameter: GLenum, value: *mut GLint) {
    record(Call::GetShaderiv(shader, parameter));
    *value = 1;
}
#[no_mangle]
unsafe extern "C" fn glGetUniformLocation(program: GLuint, _: *const c_char) -> GLint {
    record(Call::GetUniformLocation(program));
    0
}
#[no_mangle]
unsafe extern "C" fn glLinkProgram(program: GLuint) {
    record(Call::LinkProgram(program));
}
#[no_mangle]
unsafe extern "C" fn glShaderSource(
    shader: GLuint,
    _count: GLsizei,
    source: *const *const c_char,
    _length: *const GLint,
) {
    let bytes = CStr::from_ptr(*source).to_bytes().to_vec();
    with(|gl| {
        gl.calls.push(Call::ShaderSource(shader));
        gl.shaders.push(bytes);
    });
}
#[no_mangle]
unsafe extern "C" fn glUniform1i(location: GLint, value: GLint) {
    record(Call::Uniform1i(location, value));
}
#[no_mangle]
unsafe extern "C" fn glUniform2f(location: GLint, x: GLfloat, y: GLfloat) {
    record(Call::Uniform2f(location, x, y));
}
#[no_mangle]
unsafe extern "C" fn glUseProgram(program: GLuint) {
    record(Call::UseProgram(program));
}
#[no_mangle]
unsafe extern "C" fn glVertexAttribPointer(
    index: GLuint,
    size: GLint,
    kind: GLenum,
    normalized: GLboolean,
    stride: GLsizei,
    pointer: *const c_void,
) {
    record(Call::VertexAttribPointer(
        index,
        size,
        kind,
        normalized,
        stride,
        pointer as usize,
    ));
}
