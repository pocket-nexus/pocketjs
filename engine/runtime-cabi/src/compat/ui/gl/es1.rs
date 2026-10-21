//! OpenGL ES 1.1 pipeline: the fixed-function equivalent of `es2.rs`.
//!
//! The PowerVR MBX Lite in the original iPhone reports `OpenGL ES-CM 1.1` and
//! exports no `glCreateShader`, so the ES 2 program cannot exist there. It does
//! not need to: the two shaders it replaces are each expressible as fixed
//! function state, exactly.
//!
//! * The vertex shader's pixel-to-NDC transform, including its Y flip, is
//!   `glOrthof(0, w, h, 0, -1, 1)` on the projection matrix — left/right/
//!   bottom/top in that order puts the origin at the top left.
//! * The fragment shader's `texture2D(u_texture, v_uv) * v_color` is the
//!   default texture environment, `GL_MODULATE`, over a per-vertex color array.
//!
//! `super` owns the DrawList walk, the texture cache and the batching, so this
//! module is only the state those two lines of GLSL turn into.

use core::ffi::c_void;

use super::{
    glGetError, GLenum, GLfloat, GLint, GLsizei, GL_FLOAT, GL_NO_ERROR,
    GL_ONE_MINUS_SRC_ALPHA, GL_SRC_ALPHA, GL_UNSIGNED_BYTE,
};

const GL_PROJECTION: GLenum = 0x1701;
const GL_MODELVIEW: GLenum = 0x1700;
const GL_TEXTURE: GLenum = 0x1702;
const GL_TEXTURE_2D: GLenum = 0x0de1;
const GL_SMOOTH: GLenum = 0x1d01;
const GL_VERTEX_ARRAY: GLenum = 0x8074;
const GL_TEXTURE_COORD_ARRAY: GLenum = 0x8078;
const GL_COLOR_ARRAY: GLenum = 0x8076;
const GL_TEXTURE_ENV: GLenum = 0x2300;
const GL_TEXTURE_ENV_MODE: GLenum = 0x2200;
const GL_MODULATE: GLint = 0x2100;
const GL_TEXTURE0: GLenum = 0x84c0;

unsafe extern "C" {
    fn glActiveTexture(texture: GLenum);
    fn glBlendFunc(source: GLenum, destination: GLenum);
    fn glColorPointer(
        size: GLint,
        kind: GLenum,
        stride: GLsizei,
        pointer: *const c_void,
    );
    fn glDisableClientState(array: GLenum);
    fn glEnable(capability: GLenum);
    fn glEnableClientState(array: GLenum);
    fn glLoadIdentity();
    fn glMatrixMode(mode: GLenum);
    fn glShadeModel(mode: GLenum);
    fn glOrthof(
        left: GLfloat,
        right: GLfloat,
        bottom: GLfloat,
        top: GLfloat,
        near: GLfloat,
        far: GLfloat,
    );
    fn glTexCoordPointer(
        size: GLint,
        kind: GLenum,
        stride: GLsizei,
        pointer: *const c_void,
    );
    fn glTexEnvi(target: GLenum, parameter: GLenum, value: GLint);
    fn glVertexPointer(
        size: GLint,
        kind: GLenum,
        stride: GLsizei,
        pointer: *const c_void,
    );
}

/// The ES 1.1 pipeline has no program object, so there is no state to carry.
pub(super) struct Pipeline;

impl Pipeline {
    /// A field-valid instance for unit tests that never touch a GL context.
    #[cfg(test)]
    pub(super) fn stub() -> Self {
        Self
    }

    pub(super) unsafe fn new() -> Option<Self> {
        glActiveTexture(GL_TEXTURE0);
        Self::state();
        if glGetError() != GL_NO_ERROR {
            return None;
        }
        Some(Self)
    }

    /// The fixed-function state that stands in for having a shader at all.
    ///
    /// `glEnable(GL_TEXTURE_2D)` is the one that is easy to miss and total when
    /// missed: in ES 1.1 texturing is a per-unit *enable*, and with it off every
    /// fragment takes only the per-vertex colour — geometry and flat fills look
    /// right while all text, images and atlas content silently vanish. ES 2 has
    /// no equivalent, because sampling is written into the fragment shader, so
    /// nothing in the shared module ever needed to enable it.
    ///
    /// Every untextured draw binds the backend's 1x1 white texture, so this can
    /// stay on for the whole frame rather than toggling per batch.
    unsafe fn state() {
        glEnable(GL_TEXTURE_2D);
        // Modulate is the documented default, but state it rather than inherit
        // it — the drawable is shared with UIKit's compositor.
        glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
        // Gradients interpolate per-vertex colour across the quad.
        glShadeModel(GL_SMOOTH);
    }

    pub(super) unsafe fn destroy(&mut self) {}

    /// Replace the vertex shader: pixel coordinates in, top-left origin.
    pub(super) unsafe fn begin_frame(&self, logical_width: f32, logical_height: f32) {
        glMatrixMode(GL_PROJECTION);
        glLoadIdentity();
        glOrthof(0.0, logical_width, logical_height, 0.0, -1.0, 1.0);
        glMatrixMode(GL_MODELVIEW);
        glLoadIdentity();
        // The DrawList's UVs are already normalized, so the texture matrix must
        // contribute nothing.
        glMatrixMode(GL_TEXTURE);
        glLoadIdentity();
        glMatrixMode(GL_MODELVIEW);
        glActiveTexture(GL_TEXTURE0);
        Self::state();
    }

    /// MBX Lite exposes no `GL_OES_blend_func_separate`, so the destination
    /// alpha cannot be given its own factors. It does not matter here: the
    /// drawable is opaque and nothing ever reads its alpha back, so the color
    /// result is identical to the ES 2 path's.
    pub(super) unsafe fn set_blend(&self) {
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    }

    /// Point the three client arrays at the same interleaved buffer the ES 2
    /// attributes use — identical layout, identical stride, byte offsets 0/8/16.
    pub(super) unsafe fn bind_vertices(&self, stride: GLsizei) {
        glEnableClientState(GL_VERTEX_ARRAY);
        glEnableClientState(GL_TEXTURE_COORD_ARRAY);
        glEnableClientState(GL_COLOR_ARRAY);
        glVertexPointer(2, GL_FLOAT, stride, core::ptr::null());
        glTexCoordPointer(2, GL_FLOAT, stride, 8usize as *const c_void);
        // GL_UNSIGNED_BYTE colors are normalized by definition in ES 1.1, which
        // is what the ES 2 path asks for explicitly with normalized = 1.
        glColorPointer(4, GL_UNSIGNED_BYTE, stride, 16usize as *const c_void);
    }

    pub(super) unsafe fn unbind_vertices(&self) {
        glDisableClientState(GL_VERTEX_ARRAY);
        glDisableClientState(GL_TEXTURE_COORD_ARRAY);
        glDisableClientState(GL_COLOR_ARRAY);
    }
}
