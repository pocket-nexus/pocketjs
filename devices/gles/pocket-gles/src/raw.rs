//! GLES entry points and constants. The module root holds the set both
//! pipelines call; `es1` holds the ES 1.1 fixed-function set and `es2` the
//! ES 2 program set.
//!
//! A declaration creates no symbol reference. A pipeline crate references
//! only the entry points it calls, so an archive that links one pipeline
//! crate references the common set and that pipeline's set.
use core::ffi::{c_char, c_void};
pub type GLenum = u32;
pub type GLuint = u32;
pub type GLint = i32;
pub type GLsizei = i32;
pub type GLbitfield = u32;
pub type GLfloat = f32;
pub type GLsizeiptr = isize;
pub type GLboolean = u8;

pub const GL_FLOAT: GLenum = 0x1406;
pub const GL_UNSIGNED_BYTE: GLenum = 0x1401;
pub const GL_TRIANGLES: GLenum = 0x0004;
pub const GL_ARRAY_BUFFER: GLenum = 0x8892;
pub const GL_DYNAMIC_DRAW: GLenum = 0x88e8;
pub const GL_TEXTURE_2D: GLenum = 0x0de1;
pub const GL_TEXTURE0: GLenum = 0x84c0;
pub const GL_RGBA: GLenum = 0x1908;
pub const GL_LUMINANCE_ALPHA: GLenum = 0x190a;
pub const GL_LINEAR: GLint = 0x2601;
pub const GL_NEAREST: GLint = 0x2600;
pub const GL_CLAMP_TO_EDGE: GLint = 0x812f;
pub const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
pub const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
pub const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
pub const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
pub const GL_UNPACK_ALIGNMENT: GLenum = 0x0cf5;
pub const GL_BLEND: GLenum = 0x0be2;
pub const GL_ONE: GLenum = 1;
pub const GL_SRC_ALPHA: GLenum = 0x0302;
pub const GL_ONE_MINUS_SRC_ALPHA: GLenum = 0x0303;
pub const GL_COLOR_BUFFER_BIT: GLbitfield = 0x0000_4000;
pub const GL_SCISSOR_TEST: GLenum = 0x0c11;
pub const GL_DEPTH_TEST: GLenum = 0x0b71;
pub const GL_CULL_FACE: GLenum = 0x0b44;
pub const GL_MAX_TEXTURE_SIZE: GLenum = 0x0d33;
pub const GL_NO_ERROR: GLenum = 0;

unsafe extern "C" {
    pub fn glActiveTexture(texture: GLenum);
    pub fn glFinish();
    pub fn glBindBuffer(target: GLenum, buffer: GLuint);
    pub fn glBindTexture(target: GLenum, texture: GLuint);
    pub fn glBufferData(target: GLenum, size: GLsizeiptr, data: *const c_void, usage: GLenum);
    pub fn glClear(mask: GLbitfield);
    pub fn glClearColor(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat);
    pub fn glDeleteBuffers(count: GLsizei, buffers: *const GLuint);
    pub fn glDeleteTextures(count: GLsizei, textures: *const GLuint);
    pub fn glDisable(capability: GLenum);
    pub fn glDrawArrays(mode: GLenum, first: GLint, count: GLsizei);
    pub fn glEnable(capability: GLenum);
    pub fn glGenBuffers(count: GLsizei, buffers: *mut GLuint);
    pub fn glGenTextures(count: GLsizei, textures: *mut GLuint);
    pub fn glGetError() -> GLenum;
    pub fn glGetIntegerv(parameter: GLenum, value: *mut GLint);
    pub fn glPixelStorei(parameter: GLenum, value: GLint);
    pub fn glScissor(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
    pub fn glTexImage2D(
        target: GLenum,
        level: GLint,
        internal_format: GLint,
        width: GLsizei,
        height: GLsizei,
        border: GLint,
        format: GLenum,
        kind: GLenum,
        pixels: *const c_void,
    );
    pub fn glTexParameteri(target: GLenum, parameter: GLenum, value: GLint);
    pub fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
}

/// The ES 1.1 fixed-function entry points: matrix stack, client arrays and
/// the texture environment.
pub mod es1 {
    use super::*;
    pub const GL_PROJECTION: GLenum = 0x1701;
    pub const GL_MODELVIEW: GLenum = 0x1700;
    pub const GL_TEXTURE: GLenum = 0x1702;
    pub const GL_SMOOTH: GLenum = 0x1d01;
    pub const GL_VERTEX_ARRAY: GLenum = 0x8074;
    pub const GL_TEXTURE_COORD_ARRAY: GLenum = 0x8078;
    pub const GL_COLOR_ARRAY: GLenum = 0x8076;
    pub const GL_TEXTURE_ENV: GLenum = 0x2300;
    pub const GL_TEXTURE_ENV_MODE: GLenum = 0x2200;
    pub const GL_MODULATE: GLint = 0x2100;

    unsafe extern "C" {
        pub fn glBlendFunc(source: GLenum, destination: GLenum);
        pub fn glColorPointer(size: GLint, kind: GLenum, stride: GLsizei, pointer: *const c_void);
        pub fn glDisableClientState(array: GLenum);
        pub fn glEnableClientState(array: GLenum);
        pub fn glLoadIdentity();
        pub fn glMatrixMode(mode: GLenum);
        pub fn glShadeModel(mode: GLenum);
        pub fn glOrthof(
            left: GLfloat,
            right: GLfloat,
            bottom: GLfloat,
            top: GLfloat,
            near: GLfloat,
            far: GLfloat,
        );
        pub fn glTexCoordPointer(
            size: GLint,
            kind: GLenum,
            stride: GLsizei,
            pointer: *const c_void,
        );
        pub fn glTexEnvi(target: GLenum, parameter: GLenum, value: GLint);
        pub fn glVertexPointer(size: GLint, kind: GLenum, stride: GLsizei, pointer: *const c_void);
    }
}

/// The ES 2 program entry points: shaders, programs, uniforms and vertex
/// attributes.
pub mod es2 {
    use super::*;
    pub const GL_FALSE: GLboolean = 0;
    pub const GL_VERTEX_SHADER: GLenum = 0x8b31;
    pub const GL_FRAGMENT_SHADER: GLenum = 0x8b30;
    pub const GL_COMPILE_STATUS: GLenum = 0x8b81;
    pub const GL_LINK_STATUS: GLenum = 0x8b82;

    unsafe extern "C" {
        pub fn glAttachShader(program: GLuint, shader: GLuint);
        pub fn glBindAttribLocation(program: GLuint, index: GLuint, name: *const c_char);
        pub fn glBlendFuncSeparate(
            source_rgb: GLenum,
            destination_rgb: GLenum,
            source_alpha: GLenum,
            destination_alpha: GLenum,
        );
        pub fn glCompileShader(shader: GLuint);
        pub fn glCreateProgram() -> GLuint;
        pub fn glCreateShader(kind: GLenum) -> GLuint;
        pub fn glDeleteProgram(program: GLuint);
        pub fn glDeleteShader(shader: GLuint);
        pub fn glDisableVertexAttribArray(index: GLuint);
        pub fn glEnableVertexAttribArray(index: GLuint);
        pub fn glGetProgramiv(program: GLuint, parameter: GLenum, value: *mut GLint);
        pub fn glGetShaderiv(shader: GLuint, parameter: GLenum, value: *mut GLint);
        pub fn glGetUniformLocation(program: GLuint, name: *const c_char) -> GLint;
        pub fn glLinkProgram(program: GLuint);
        pub fn glShaderSource(
            shader: GLuint,
            count: GLsizei,
            source: *const *const c_char,
            length: *const GLint,
        );
        pub fn glUniform1i(location: GLint, value: GLint);
        pub fn glUniform2f(location: GLint, x: GLfloat, y: GLfloat);
        pub fn glUseProgram(program: GLuint);
        pub fn glVertexAttribPointer(
            index: GLuint,
            size: GLint,
            kind: GLenum,
            normalized: GLboolean,
            stride: GLsizei,
            pointer: *const c_void,
        );
    }
}
