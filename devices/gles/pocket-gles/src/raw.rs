//! GLES entry points shared by ES 1.1 and ES 2 pipelines.
use core::ffi::c_void;
pub type GLenum = u32;
pub type GLuint = u32;
pub type GLint = i32;
pub type GLsizei = i32;
pub type GLbitfield = u32;
pub type GLfloat = f32;
pub type GLsizeiptr = isize;

pub const GL_FLOAT: GLenum = 0x1406;
pub const GL_UNSIGNED_BYTE: GLenum = 0x1401;
pub const GL_TRIANGLES: GLenum = 0x0004;
pub const GL_ARRAY_BUFFER: GLenum = 0x8892;
pub const GL_DYNAMIC_DRAW: GLenum = 0x88e8;
pub const GL_TEXTURE_2D: GLenum = 0x0de1;
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
pub const GL_SRC_ALPHA: GLenum = 0x0302;
pub const GL_ONE_MINUS_SRC_ALPHA: GLenum = 0x0303;
pub const GL_COLOR_BUFFER_BIT: GLbitfield = 0x0000_4000;
pub const GL_SCISSOR_TEST: GLenum = 0x0c11;
pub const GL_DEPTH_TEST: GLenum = 0x0b71;
pub const GL_CULL_FACE: GLenum = 0x0b44;
pub const GL_MAX_TEXTURE_SIZE: GLenum = 0x0d33;
pub const GL_NO_ERROR: GLenum = 0;

unsafe extern "C" {
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
