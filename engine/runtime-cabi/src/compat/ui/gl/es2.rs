//! OpenGL ES 2 pipeline: a two-attribute shader program.
//!
//! This is the pipeline the Nokia E7 Qt host uses. The vertex shader does the
//! pixel-to-NDC transform the fixed-function matrix stack would otherwise do,
//! and the fragment shader modulates the texture by the per-vertex color.
//! `super` owns the DrawList walk, the texture cache and the batching; this
//! module owns only what changes between GL generations.

use core::ffi::{c_char, c_void};
use core::ptr;

// Child modules can reach their ancestor's private items, so the shared type
// aliases, enum constants and `glGetError` binding are imported rather than
// redeclared — one definition of each, in `super`.
use super::{
    glGetError, GLenum, GLfloat, GLint, GLsizei, GLuint, GL_FLOAT, GL_NO_ERROR,
    GL_ONE_MINUS_SRC_ALPHA, GL_SRC_ALPHA, GL_UNSIGNED_BYTE,
};

/// Only the separate-alpha blend path needs this factor.
const GL_ONE: GLenum = 1;

type GLboolean = u8;
const GL_FALSE: GLboolean = 0;

const GL_VERTEX_SHADER: GLenum = 0x8b31;
const GL_FRAGMENT_SHADER: GLenum = 0x8b30;
const GL_COMPILE_STATUS: GLenum = 0x8b81;
const GL_LINK_STATUS: GLenum = 0x8b82;
const GL_TEXTURE0: GLenum = 0x84c0;

unsafe extern "C" {
    fn glActiveTexture(texture: GLenum);
    fn glAttachShader(program: GLuint, shader: GLuint);
    fn glBindAttribLocation(program: GLuint, index: GLuint, name: *const c_char);
    fn glBlendFuncSeparate(
        source_rgb: GLenum,
        destination_rgb: GLenum,
        source_alpha: GLenum,
        destination_alpha: GLenum,
    );
    fn glCompileShader(shader: GLuint);
    fn glCreateProgram() -> GLuint;
    fn glCreateShader(kind: GLenum) -> GLuint;
    fn glDeleteProgram(program: GLuint);
    fn glDeleteShader(shader: GLuint);
    fn glDisableVertexAttribArray(index: GLuint);
    fn glEnableVertexAttribArray(index: GLuint);
    fn glGetProgramiv(program: GLuint, parameter: GLenum, value: *mut GLint);
    fn glGetShaderiv(shader: GLuint, parameter: GLenum, value: *mut GLint);
    fn glGetUniformLocation(program: GLuint, name: *const c_char) -> GLint;
    fn glLinkProgram(program: GLuint);
    fn glShaderSource(
        shader: GLuint,
        count: GLsizei,
        source: *const *const c_char,
        length: *const GLint,
    );
    fn glUniform1i(location: GLint, value: GLint);
    fn glUniform2f(location: GLint, x: GLfloat, y: GLfloat);
    fn glUseProgram(program: GLuint);
    fn glVertexAttribPointer(
        index: GLuint,
        size: GLint,
        kind: GLenum,
        normalized: GLboolean,
        stride: GLsizei,
        pointer: *const c_void,
    );
}

const VERTEX_SHADER: &[u8] = b"
attribute vec2 a_position;
attribute vec2 a_uv;
attribute vec4 a_color;
uniform vec2 u_viewport;
varying mediump vec2 v_uv;
varying lowp vec4 v_color;
void main() {
    vec2 ndc = vec2(
        a_position.x * 2.0 / u_viewport.x - 1.0,
        1.0 - a_position.y * 2.0 / u_viewport.y
    );
    gl_Position = vec4(ndc, 0.0, 1.0);
    v_uv = a_uv;
    v_color = a_color;
}
\0";

const FRAGMENT_SHADER: &[u8] = b"
precision mediump float;
uniform sampler2D u_texture;
varying mediump vec2 v_uv;
varying lowp vec4 v_color;
void main() {
    gl_FragColor = texture2D(u_texture, v_uv) * v_color;
}
\0";

const ATTR_POSITION: &[u8] = b"a_position\0";
const ATTR_UV: &[u8] = b"a_uv\0";
const ATTR_COLOR: &[u8] = b"a_color\0";
const UNIFORM_VIEWPORT: &[u8] = b"u_viewport\0";
const UNIFORM_TEXTURE: &[u8] = b"u_texture\0";

unsafe fn compile_shader(kind: GLenum, source: &[u8]) -> Option<GLuint> {
    let shader = glCreateShader(kind);
    if shader == 0 {
        return None;
    }
    let pointer = source.as_ptr() as *const c_char;
    glShaderSource(shader, 1, &pointer, ptr::null());
    glCompileShader(shader);
    let mut ok: GLint = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &mut ok);
    if ok == 0 {
        glDeleteShader(shader);
        return None;
    }
    Some(shader)
}

/// The ES 2 pipeline state: one linked program and its viewport uniform.
pub(super) struct Pipeline {
    program: GLuint,
    viewport_uniform: GLint,
}

impl Pipeline {
    /// A field-valid instance for unit tests that never touch a GL context.
    #[cfg(test)]
    pub(super) fn stub() -> Self {
        Self {
            program: 0,
            viewport_uniform: 0,
        }
    }

    pub(super) unsafe fn new() -> Option<Self> {
        let vertex = compile_shader(GL_VERTEX_SHADER, VERTEX_SHADER)?;
        let fragment = match compile_shader(GL_FRAGMENT_SHADER, FRAGMENT_SHADER) {
            Some(shader) => shader,
            None => {
                glDeleteShader(vertex);
                return None;
            }
        };
        let program = glCreateProgram();
        if program == 0 {
            glDeleteShader(vertex);
            glDeleteShader(fragment);
            return None;
        }
        glAttachShader(program, vertex);
        glAttachShader(program, fragment);
        glBindAttribLocation(program, 0, ATTR_POSITION.as_ptr() as *const c_char);
        glBindAttribLocation(program, 1, ATTR_UV.as_ptr() as *const c_char);
        glBindAttribLocation(program, 2, ATTR_COLOR.as_ptr() as *const c_char);
        glLinkProgram(program);
        glDeleteShader(vertex);
        glDeleteShader(fragment);
        let mut ok: GLint = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &mut ok);
        if ok == 0 {
            glDeleteProgram(program);
            return None;
        }

        glUseProgram(program);
        let viewport_uniform =
            glGetUniformLocation(program, UNIFORM_VIEWPORT.as_ptr() as *const c_char);
        let texture_uniform =
            glGetUniformLocation(program, UNIFORM_TEXTURE.as_ptr() as *const c_char);
        if viewport_uniform < 0 || texture_uniform < 0 {
            glDeleteProgram(program);
            return None;
        }
        glUniform1i(texture_uniform, 0);
        glActiveTexture(GL_TEXTURE0);
        if glGetError() != GL_NO_ERROR {
            glDeleteProgram(program);
            return None;
        }
        Some(Self {
            program,
            viewport_uniform,
        })
    }

    pub(super) unsafe fn destroy(&mut self) {
        glDeleteProgram(self.program);
        self.program = 0;
    }

    /// Bind the program and tell it the logical viewport for this frame.
    pub(super) unsafe fn begin_frame(&self, logical_width: f32, logical_height: f32) {
        glUseProgram(self.program);
        glUniform2f(self.viewport_uniform, logical_width, logical_height);
        glActiveTexture(GL_TEXTURE0);
    }

    /// Straight alpha for color, accumulate-to-opaque for the destination.
    pub(super) unsafe fn set_blend(&self) {
        glBlendFuncSeparate(
            GL_SRC_ALPHA,
            GL_ONE_MINUS_SRC_ALPHA,
            GL_ONE,
            GL_ONE_MINUS_SRC_ALPHA,
        );
    }

    /// Point the three attributes at the interleaved vertex buffer.
    pub(super) unsafe fn bind_vertices(&self, stride: GLsizei) {
        glEnableVertexAttribArray(0);
        glEnableVertexAttribArray(1);
        glEnableVertexAttribArray(2);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, stride, ptr::null());
        glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, stride, 8usize as *const c_void);
        glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, 1, stride, 16usize as *const c_void);
    }

    pub(super) unsafe fn unbind_vertices(&self) {
        glDisableVertexAttribArray(0);
        glDisableVertexAttribArray(1);
        glDisableVertexAttribArray(2);
    }
}
