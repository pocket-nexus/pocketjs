//! The OpenGL ES 3 entry points the arcade renderer and its hosts call, linked
//! from the system's libGLESv2.
#![allow(non_snake_case)]
use std::ffi::{c_char, c_void, CString};

pub const TRIANGLES: u32 = 0x0004;
pub const FLOAT: u32 = 0x1406;
pub const UNSIGNED_BYTE: u32 = 0x1401;
pub const UNSIGNED_SHORT: u32 = 0x1403;
pub const UNSIGNED_INT: u32 = 0x1405;
pub const ARRAY_BUFFER: u32 = 0x8892;
pub const ELEMENT_ARRAY_BUFFER: u32 = 0x8893;
pub const STATIC_DRAW: u32 = 0x88e4;
pub const DYNAMIC_DRAW: u32 = 0x88e8;
pub const STREAM_DRAW: u32 = 0x88e0;
pub const VERTEX_SHADER: u32 = 0x8b31;
pub const FRAGMENT_SHADER: u32 = 0x8b30;
pub const COMPILE_STATUS: u32 = 0x8b81;
pub const LINK_STATUS: u32 = 0x8b82;
pub const COLOR_BUFFER_BIT: u32 = 0x4000;
pub const DEPTH_BUFFER_BIT: u32 = 0x0100;
pub const DEPTH_TEST: u32 = 0x0b71;
pub const CULL_FACE: u32 = 0x0b44;
pub const BLEND: u32 = 0x0be2;
pub const SCISSOR_TEST: u32 = 0x0c11;
pub const SRC_ALPHA: u32 = 0x0302;
pub const ONE_MINUS_SRC_ALPHA: u32 = 0x0303;
pub const ONE: u32 = 1;
pub const LEQUAL: u32 = 0x0203;
pub const TEXTURE_2D: u32 = 0x0de1;
pub const TEXTURE0: u32 = 0x84c0;
pub const TEXTURE_MIN_FILTER: u32 = 0x2801;
pub const TEXTURE_MAG_FILTER: u32 = 0x2800;
pub const TEXTURE_WRAP_S: u32 = 0x2802;
pub const TEXTURE_WRAP_T: u32 = 0x2803;
pub const CLAMP_TO_EDGE: i32 = 0x812f;
pub const LINEAR: i32 = 0x2601;
pub const NEAREST: i32 = 0x2600;
pub const LINEAR_MIPMAP_LINEAR: i32 = 0x2703;
pub const RGBA: u32 = 0x1908;
pub const RGBA8: u32 = 0x8058;
pub const R8: u32 = 0x8229;
pub const RED: u32 = 0x1903;
pub const COMPRESSED_RGBA_ASTC_4X4: u32 = 0x93b0;
pub const UNPACK_ALIGNMENT: u32 = 0x0cf5;
pub const PACK_ALIGNMENT: u32 = 0x0d05;
pub const FRAMEBUFFER: u32 = 0x8d40;
pub const RENDERBUFFER: u32 = 0x8d41;
pub const COLOR_ATTACHMENT0: u32 = 0x8ce0;
pub const DEPTH_ATTACHMENT: u32 = 0x8d00;
pub const DEPTH_COMPONENT24: u32 = 0x81a6;
pub const FRAMEBUFFER_COMPLETE: u32 = 0x8cd5;
pub const FRAMEBUFFER_BINDING: u32 = 0x8ca6;

#[cfg_attr(target_os = "linux", link(name = "GLESv2"))]
unsafe extern "C" {
    pub fn glActiveTexture(texture: u32);
    pub fn glAttachShader(program: u32, shader: u32);
    pub fn glBindAttribLocation(program: u32, index: u32, name: *const c_char);
    pub fn glBindBuffer(target: u32, buffer: u32);
    pub fn glBindFramebuffer(target: u32, framebuffer: u32);
    pub fn glBindRenderbuffer(target: u32, renderbuffer: u32);
    pub fn glBindTexture(target: u32, texture: u32);
    pub fn glBindVertexArray(array: u32);
    pub fn glBlendFunc(source: u32, destination: u32);
    pub fn glBufferData(target: u32, size: isize, data: *const c_void, usage: u32);
    pub fn glBufferSubData(target: u32, offset: isize, size: isize, data: *const c_void);
    pub fn glCheckFramebufferStatus(target: u32) -> u32;
    pub fn glClear(mask: u32);
    pub fn glClearColor(red: f32, green: f32, blue: f32, alpha: f32);
    pub fn glColorMask(red: u8, green: u8, blue: u8, alpha: u8);
    pub fn glCompileShader(shader: u32);
    pub fn glCompressedTexImage2D(
        target: u32,
        level: i32,
        format: u32,
        width: i32,
        height: i32,
        border: i32,
        size: i32,
        data: *const c_void,
    );
    pub fn glCreateProgram() -> u32;
    pub fn glCreateShader(kind: u32) -> u32;
    pub fn glDeleteBuffers(count: i32, buffers: *const u32);
    pub fn glDeleteFramebuffers(count: i32, framebuffers: *const u32);
    pub fn glDeleteProgram(program: u32);
    pub fn glDeleteRenderbuffers(count: i32, renderbuffers: *const u32);
    pub fn glDeleteShader(shader: u32);
    pub fn glDeleteTextures(count: i32, textures: *const u32);
    pub fn glDeleteVertexArrays(count: i32, arrays: *const u32);
    pub fn glDepthFunc(function: u32);
    pub fn glDepthMask(flag: u8);
    pub fn glDisable(capability: u32);
    pub fn glDisableVertexAttribArray(index: u32);
    pub fn glDrawArrays(mode: u32, first: i32, count: i32);
    pub fn glDrawElements(mode: u32, count: i32, kind: u32, offset: *const c_void);
    pub fn glDrawElementsInstanced(
        mode: u32,
        count: i32,
        kind: u32,
        offset: *const c_void,
        instances: i32,
    );
    pub fn glEnable(capability: u32);
    pub fn glEnableVertexAttribArray(index: u32);
    pub fn glFinish();
    pub fn glFlush();
    pub fn glFramebufferRenderbuffer(
        target: u32,
        attachment: u32,
        renderbuffer_target: u32,
        renderbuffer: u32,
    );
    pub fn glFramebufferTexture2D(
        target: u32,
        attachment: u32,
        texture_target: u32,
        texture: u32,
        level: i32,
    );
    pub fn glGenBuffers(count: i32, buffers: *mut u32);
    pub fn glGenFramebuffers(count: i32, framebuffers: *mut u32);
    pub fn glGenRenderbuffers(count: i32, renderbuffers: *mut u32);
    pub fn glGenTextures(count: i32, textures: *mut u32);
    pub fn glGenVertexArrays(count: i32, arrays: *mut u32);
    pub fn glGenerateMipmap(target: u32);
    pub fn glGetError() -> u32;
    pub fn glGetIntegerv(parameter: u32, value: *mut i32);
    pub fn glGetProgramInfoLog(program: u32, size: i32, length: *mut i32, log: *mut c_char);
    pub fn glGetProgramiv(program: u32, parameter: u32, value: *mut i32);
    pub fn glGetShaderInfoLog(shader: u32, size: i32, length: *mut i32, log: *mut c_char);
    pub fn glGetShaderiv(shader: u32, parameter: u32, value: *mut i32);
    pub fn glGetUniformLocation(program: u32, name: *const c_char) -> i32;
    pub fn glLinkProgram(program: u32);
    pub fn glPixelStorei(parameter: u32, value: i32);
    pub fn glPolygonOffset(factor: f32, units: f32);
    pub fn glReadPixels(
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        format: u32,
        kind: u32,
        pixels: *mut c_void,
    );
    pub fn glRenderbufferStorage(target: u32, format: u32, width: i32, height: i32);
    pub fn glScissor(x: i32, y: i32, width: i32, height: i32);
    pub fn glShaderSource(
        shader: u32,
        count: i32,
        source: *const *const c_char,
        length: *const i32,
    );
    pub fn glTexImage2D(
        target: u32,
        level: i32,
        internal: i32,
        width: i32,
        height: i32,
        border: i32,
        format: u32,
        kind: u32,
        pixels: *const c_void,
    );
    pub fn glTexParameteri(target: u32, parameter: u32, value: i32);
    pub fn glTexSubImage2D(
        target: u32,
        level: i32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        format: u32,
        kind: u32,
        pixels: *const c_void,
    );
    pub fn glUniform1f(location: i32, value: f32);
    pub fn glUniform1i(location: i32, value: i32);
    pub fn glUniform2f(location: i32, x: f32, y: f32);
    pub fn glUniform3f(location: i32, x: f32, y: f32, z: f32);
    pub fn glUniform4f(location: i32, x: f32, y: f32, z: f32, w: f32);
    pub fn glUniformMatrix4fv(location: i32, count: i32, transpose: u8, value: *const f32);
    pub fn glUseProgram(program: u32);
    pub fn glVertexAttrib4f(index: u32, x: f32, y: f32, z: f32, w: f32);
    pub fn glVertexAttribDivisor(index: u32, divisor: u32);
    pub fn glVertexAttribPointer(
        index: u32,
        size: i32,
        kind: u32,
        normalized: u8,
        stride: i32,
        offset: *const c_void,
    );
    pub fn glViewport(x: i32, y: i32, width: i32, height: i32);
}

/// Compile and link a program, binding `attributes` to their list positions.
///
/// # Safety
/// A GLES 3 context must be current on this thread.
pub unsafe fn program(vertex: &str, fragment: &str, attributes: &[&str]) -> anyhow::Result<u32> {
    unsafe fn shader(kind: u32, source: &str) -> anyhow::Result<u32> {
        let id = glCreateShader(kind);
        let text = CString::new(source)?;
        let pointer = text.as_ptr();
        glShaderSource(id, 1, &pointer, std::ptr::null());
        glCompileShader(id);
        let mut ok = 0;
        glGetShaderiv(id, COMPILE_STATUS, &mut ok);
        if ok == 0 {
            let mut log = vec![0u8; 2048];
            let mut length = 0;
            glGetShaderInfoLog(id, 2048, &mut length, log.as_mut_ptr() as *mut c_char);
            anyhow::bail!(
                "shader: {}",
                String::from_utf8_lossy(&log[..length.max(0) as usize])
            );
        }
        Ok(id)
    }
    let vs = shader(VERTEX_SHADER, vertex)?;
    let fs = shader(FRAGMENT_SHADER, fragment)?;
    let id = glCreateProgram();
    glAttachShader(id, vs);
    glAttachShader(id, fs);
    for (index, name) in attributes.iter().enumerate() {
        let name = CString::new(*name)?;
        glBindAttribLocation(id, index as u32, name.as_ptr());
    }
    glLinkProgram(id);
    glDeleteShader(vs);
    glDeleteShader(fs);
    let mut ok = 0;
    glGetProgramiv(id, LINK_STATUS, &mut ok);
    if ok == 0 {
        let mut log = vec![0u8; 2048];
        let mut length = 0;
        glGetProgramInfoLog(id, 2048, &mut length, log.as_mut_ptr() as *mut c_char);
        anyhow::bail!(
            "link: {}",
            String::from_utf8_lossy(&log[..length.max(0) as usize])
        );
    }
    Ok(id)
}

/// # Safety
/// A GLES 3 context must be current on this thread.
pub unsafe fn uniform(program: u32, name: &str) -> i32 {
    let name = CString::new(name).unwrap();
    glGetUniformLocation(program, name.as_ptr())
}

/// A color texture with a depth renderbuffer to draw a game or a canvas into.
pub struct Canvas {
    pub framebuffer: u32,
    pub texture: u32,
    pub depth: u32,
    pub width: i32,
    pub height: i32,
}

impl Canvas {
    /// # Safety
    /// A GLES 3 context must be current on this thread.
    pub unsafe fn new(width: i32, height: i32, depth: bool) -> anyhow::Result<Self> {
        let (mut framebuffer, mut texture, mut renderbuffer) = (0, 0, 0);
        glGenTextures(1, &mut texture);
        glBindTexture(TEXTURE_2D, texture);
        glTexImage2D(
            TEXTURE_2D,
            0,
            RGBA8 as i32,
            width,
            height,
            0,
            RGBA,
            UNSIGNED_BYTE,
            std::ptr::null(),
        );
        glTexParameteri(TEXTURE_2D, TEXTURE_MIN_FILTER, LINEAR);
        glTexParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, LINEAR);
        glTexParameteri(TEXTURE_2D, TEXTURE_WRAP_S, CLAMP_TO_EDGE);
        glTexParameteri(TEXTURE_2D, TEXTURE_WRAP_T, CLAMP_TO_EDGE);
        glGenFramebuffers(1, &mut framebuffer);
        glBindFramebuffer(FRAMEBUFFER, framebuffer);
        glFramebufferTexture2D(FRAMEBUFFER, COLOR_ATTACHMENT0, TEXTURE_2D, texture, 0);
        if depth {
            glGenRenderbuffers(1, &mut renderbuffer);
            glBindRenderbuffer(RENDERBUFFER, renderbuffer);
            glRenderbufferStorage(RENDERBUFFER, DEPTH_COMPONENT24, width, height);
            glFramebufferRenderbuffer(FRAMEBUFFER, DEPTH_ATTACHMENT, RENDERBUFFER, renderbuffer);
        }
        let status = glCheckFramebufferStatus(FRAMEBUFFER);
        glBindFramebuffer(FRAMEBUFFER, 0);
        anyhow::ensure!(
            status == FRAMEBUFFER_COMPLETE,
            "framebuffer status {status:#x}"
        );
        Ok(Self {
            framebuffer,
            texture,
            depth: renderbuffer,
            width,
            height,
        })
    }

    /// # Safety
    /// The context that created this canvas must be current on this thread.
    pub unsafe fn bind(&self) {
        glBindFramebuffer(FRAMEBUFFER, self.framebuffer);
        glViewport(0, 0, self.width, self.height);
    }

    /// # Safety
    /// The context that created this canvas must be current on this thread.
    pub unsafe fn destroy(&mut self) {
        glDeleteFramebuffers(1, &self.framebuffer);
        glDeleteTextures(1, &self.texture);
        if self.depth != 0 {
            glDeleteRenderbuffers(1, &self.depth);
        }
    }
}
