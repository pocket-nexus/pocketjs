//! Hardware DrawList backend, shared by two GL generations.
//!
//! The host owns the context; these entry points are called only while it is
//! current. Geometry remains the core's deterministic, CPU-clipped DrawList;
//! the GPU owns rasterization, texture filtering, blending, and presentation.
//!
//! Everything in this module — the DrawList walk, the image and font-atlas
//! caches, batching by texture and scissor, and the physical clip arithmetic —
//! is generation-independent. The parts that are not live in [`es2`] (a shader
//! program, for the Nokia E7's OpenGL ES 2) and [`es1`] (the fixed-function
//! matrix stack and client arrays, for the original iPhone's OpenGL ES 1.1
//! MBX Lite). Exactly one is compiled in, chosen by the `gles1` feature, and
//! both satisfy the same small interface: `new`, `destroy`, `begin_frame`,
//! `set_blend`, `bind_vertices`, `unbind_vertices`.

#![cfg_attr(test, allow(dead_code))]

// Only the selected generation is compiled; the other's extern bindings and
// enum values would otherwise be dead code on every build.
#[cfg(feature = "gles1")]
mod es1;
#[cfg(not(feature = "gles1"))]
mod es2;

#[cfg(feature = "gles1")]
use es1::Pipeline;
#[cfg(not(feature = "gles1"))]
use es2::Pipeline;

use alloc::{vec, vec::Vec};
use core::ffi::c_void;
use core::mem::size_of;

use pocketjs_core::spec;
use pocketjs_core::{TexView, Ui};

pub type Trace = extern "C" fn(u32, u32, u32);
static mut TRACE: Option<Trace> = None;

pub unsafe fn set_trace(trace: Option<Trace>) {
    TRACE = trace;
}

#[inline]
unsafe fn trace(stage: u32, commands: usize, vertices: usize) {
    if let Some(callback) = TRACE {
        callback(stage, commands as u32, vertices as u32);
    }
}

type GLenum = u32;
type GLuint = u32;
type GLint = i32;
type GLsizei = i32;
type GLbitfield = u32;
type GLfloat = f32;
type GLsizeiptr = isize;

const GL_FLOAT: GLenum = 0x1406;
const GL_UNSIGNED_BYTE: GLenum = 0x1401;
const GL_TRIANGLES: GLenum = 0x0004;
const GL_ARRAY_BUFFER: GLenum = 0x8892;
const GL_DYNAMIC_DRAW: GLenum = 0x88e8;
const GL_TEXTURE_2D: GLenum = 0x0de1;
const GL_RGBA: GLenum = 0x1908;
const GL_LUMINANCE_ALPHA: GLenum = 0x190a;
const GL_LINEAR: GLint = 0x2601;
const GL_NEAREST: GLint = 0x2600;
const GL_CLAMP_TO_EDGE: GLint = 0x812f;
const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
const GL_UNPACK_ALIGNMENT: GLenum = 0x0cf5;
const GL_BLEND: GLenum = 0x0be2;
const GL_SRC_ALPHA: GLenum = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA: GLenum = 0x0303;
const GL_COLOR_BUFFER_BIT: GLbitfield = 0x0000_4000;
const GL_SCISSOR_TEST: GLenum = 0x0c11;
const GL_DEPTH_TEST: GLenum = 0x0b71;
const GL_CULL_FACE: GLenum = 0x0b44;
const GL_MAX_TEXTURE_SIZE: GLenum = 0x0d33;
const GL_NO_ERROR: GLenum = 0;

unsafe extern "C" {
    fn glBindBuffer(target: GLenum, buffer: GLuint);
    fn glBindTexture(target: GLenum, texture: GLuint);
    fn glBufferData(target: GLenum, size: GLsizeiptr, data: *const c_void, usage: GLenum);
    fn glClear(mask: GLbitfield);
    fn glClearColor(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat);
    fn glDeleteBuffers(count: GLsizei, buffers: *const GLuint);
    fn glDeleteTextures(count: GLsizei, textures: *const GLuint);
    fn glDisable(capability: GLenum);
    fn glDrawArrays(mode: GLenum, first: GLint, count: GLsizei);
    fn glEnable(capability: GLenum);
    fn glGenBuffers(count: GLsizei, buffers: *mut GLuint);
    fn glGenTextures(count: GLsizei, textures: *mut GLuint);
    fn glGetError() -> GLenum;
    fn glGetIntegerv(parameter: GLenum, value: *mut GLint);
    fn glPixelStorei(parameter: GLenum, value: GLint);
    fn glScissor(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
    fn glTexImage2D(
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
    fn glTexParameteri(target: GLenum, parameter: GLenum, value: GLint);
    fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Vertex {
    position: [f32; 2],
    uv: [f32; 2],
    /// DrawList colors are 0xAABBGGRR, whose little-endian bytes are RGBA.
    color: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Clip {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Command {
    texture: GLuint,
    first: i32,
    count: i32,
    clip: Clip,
}

#[derive(Clone, Copy)]
struct ImageTexture {
    handle: i32,
    revision: u64,
    name: GLuint,
    white_uv: Option<[f32; 2]>,
    dirty: bool,
}

impl ImageTexture {
    #[inline]
    fn matches(&self, handle: i32, revision: u64) -> bool {
        self.handle == handle && self.revision == revision && !self.dirty
    }
}

struct FontTexture {
    revision: u64,
    logical_w: u32,
    logical_h: u32,
    glyph_count: u16,
    pages: Vec<pocketjs_core::draw::GlyphSampler>,
}

struct Renderer {
    pipeline: Pipeline,
    vertex_buffer: GLuint,
    white: GLuint,
    images: Vec<Option<ImageTexture>>,
    fonts: Vec<Option<FontTexture>>,
    vertices: Vec<Vertex>,
    commands: Vec<Command>,
    max_texture_size: u32,
}

static mut RENDERER: Option<Renderer> = None;

#[inline]
fn xy(word: u32) -> (f32, f32) {
    (
        (word as u16 as i16) as f32,
        ((word >> 16) as u16 as i16) as f32,
    )
}

#[inline]
fn wh(word: u32) -> (f32, f32) {
    ((word & 0xffff) as f32, ((word >> 16) & 0xffff) as f32)
}

/// Drain stale context errors before an operation whose result we inspect.
///
/// A finite bound avoids hanging forever on a broken/lost context whose
/// implementation keeps reporting an error without clearing it.
unsafe fn clear_errors() {
    for _ in 0..32 {
        if glGetError() == GL_NO_ERROR {
            break;
        }
    }
}

unsafe fn upload_texture(
    pixels: &[u8],
    width: u32,
    height: u32,
    format: GLenum,
    linear: bool,
) -> Option<GLuint> {
    if width == 0 || height == 0 || pixels.is_empty() {
        return None;
    }
    clear_errors();
    let mut name = 0;
    glGenTextures(1, &mut name);
    if name == 0 {
        return None;
    }
    glBindTexture(GL_TEXTURE_2D, name);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    let filter = if linear { GL_LINEAR } else { GL_NEAREST };
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(
        GL_TEXTURE_2D,
        0,
        format as GLint,
        width as GLsizei,
        height as GLsizei,
        0,
        format,
        GL_UNSIGNED_BYTE,
        pixels.as_ptr() as *const c_void,
    );
    if glGetError() == GL_NO_ERROR {
        Some(name)
    } else {
        glDeleteTextures(1, &name);
        clear_errors();
        None
    }
}

fn texture_rgba(view: TexView<'_>) -> Option<Vec<u8>> {
    let count = (view.w as usize).checked_mul(view.h as usize)?;
    let mut rgba = vec![0u8; count.checked_mul(4)?];
    match view.psm {
        spec::psm::PSM_5650 => {
            if view.pixels.len() < count * 2 {
                return None;
            }
            for (index, bytes) in view.pixels[..count * 2].chunks_exact(2).enumerate() {
                let pixel = u16::from_le_bytes([bytes[0], bytes[1]]) as u32;
                let red = pixel & 0x1f;
                let green = (pixel >> 5) & 0x3f;
                let blue = (pixel >> 11) & 0x1f;
                rgba[index * 4] = ((red << 3) | (red >> 2)) as u8;
                rgba[index * 4 + 1] = ((green << 2) | (green >> 4)) as u8;
                rgba[index * 4 + 2] = ((blue << 3) | (blue >> 2)) as u8;
                rgba[index * 4 + 3] = 255;
            }
        }
        spec::psm::PSM_8888 => {
            if view.pixels.len() < rgba.len() {
                return None;
            }
            rgba.copy_from_slice(&view.pixels[..count * 4]);
        }
        spec::psm::PSM_4444 => {
            if view.pixels.len() < count * 2 {
                return None;
            }
            for (index, bytes) in view.pixels[..count * 2].chunks_exact(2).enumerate() {
                let pixel = u16::from_le_bytes([bytes[0], bytes[1]]) as u32;
                rgba[index * 4] = ((pixel & 0x0f) * 17) as u8;
                rgba[index * 4 + 1] = (((pixel >> 4) & 0x0f) * 17) as u8;
                rgba[index * 4 + 2] = (((pixel >> 8) & 0x0f) * 17) as u8;
                rgba[index * 4 + 3] = (((pixel >> 12) & 0x0f) * 17) as u8;
            }
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette?;
            if palette.len() < 1024 || view.pixels.len() < count {
                return None;
            }
            for (index, &palette_index) in view.pixels[..count].iter().enumerate() {
                let source = palette_index as usize * 4;
                rgba[index * 4..index * 4 + 4].copy_from_slice(&palette[source..source + 4]);
            }
        }
        _ => return None,
    }
    Some(rgba)
}

// Coverage-only indexed images (including shared glyph pages) need two
// GPU bytes per pixel, not four. Preserve arbitrary palette alpha values;
// colored palettes retain the RGBA upload path.
fn coverage_luminance_alpha(view: TexView<'_>) -> Option<Vec<u8>> {
    if view.psm != spec::psm::PSM_T8 { return None; }
    let palette = view.palette?;
    let count = (view.w as usize).checked_mul(view.h as usize)?;
    if palette.len() < 1024 || view.pixels.len() < count ||
        !palette[..1024].chunks_exact(4).all(|color| color[..3] == [255, 255, 255]) { return None; }
    let mut pixels = Vec::with_capacity(count.checked_mul(2)?);
    for &index in &view.pixels[..count] {
        pixels.extend_from_slice(&[255, palette[index as usize * 4 + 3]]);
    }
    Some(pixels)
}

// A constant UV in an existing opaque white block can draw solid fills
// without switching away from an image or rounded-corner mask. Four texels
// provide a guard for bilinear filtering and mediump UV interpolation.
// Inspect once when uploading; never alter the source pixels.
fn image_white_patch(rgba: &[u8], width: u32, height: u32) -> Option<[f32; 2]> {
    white_patch(rgba, width, height, 4)
}

fn white_patch(pixels: &[u8], width: u32, height: u32, channels: usize) -> Option<[f32; 2]> {
    if width < 4 || height < 4 || pixels.len() < width as usize * height as usize * channels {
        return None;
    }
    let stride = width as usize * channels;
    for y in 0..height - 3 {
        for x in 0..width - 3 {
            let offset = y as usize * stride + x as usize * channels;
            if (0..4).all(|row| pixels[offset + row * stride..offset + row * stride + 4 * channels]
                .iter().all(|&channel| channel == 255)) {
                return Some([(x as f32 + 2.0) / width as f32, (y as f32 + 2.0) / height as f32]);
            }
        }
    }
    None
}

impl Renderer {
    unsafe fn new() -> Option<Self> {
        clear_errors();
        let mut pipeline = Pipeline::new()?;

        let mut vertex_buffer = 0;
        glGenBuffers(1, &mut vertex_buffer);
        if vertex_buffer == 0 {
            pipeline.destroy();
            return None;
        }
        let mut max_texture_size = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &mut max_texture_size);
        if max_texture_size <= 0 || glGetError() != GL_NO_ERROR {
            glDeleteBuffers(1, &vertex_buffer);
            pipeline.destroy();
            return None;
        }
        let white = match upload_texture(&[255, 255, 255, 255], 1, 1, GL_RGBA, false) {
            Some(texture) => texture,
            None => {
                glDeleteBuffers(1, &vertex_buffer);
                pipeline.destroy();
                return None;
            }
        };
        Some(Self {
            pipeline,
            vertex_buffer,
            white,
            images: Vec::new(),
            fonts: Vec::new(),
            vertices: Vec::new(),
            commands: Vec::new(),
            max_texture_size: max_texture_size as u32,
        })
    }

    unsafe fn destroy(&mut self) {
        self.reset_resources();
        glDeleteTextures(1, &self.white);
        glDeleteBuffers(1, &self.vertex_buffer);
        self.pipeline.destroy();
        self.white = 0;
        self.vertex_buffer = 0;
    }

    unsafe fn reset_resources(&mut self) {
        for image in &mut self.images {
            if let Some(texture) = image.take() {
                glDeleteTextures(1, &texture.name);
            }
        }
        self.images.clear();
        self.fonts.clear();
        self.vertices.clear();
        self.commands.clear();
    }

    /// Mark caches stale without touching GL. Lifecycle and asset-loading C
    /// calls may run while QGLWidget's context is not current; deletion and
    /// replacement are deferred to the next `render`.
    fn invalidate_resources(&mut self) {
        for texture in self.images.iter_mut().flatten() {
            texture.dirty = true;
        }
        self.fonts.clear();
    }

    fn invalidate_font(&mut self, slot: u8) {
        if let Some(font) = self.fonts.get_mut(slot as usize) { *font = None; }
    }

    unsafe fn upload_image(&self, view: TexView<'_>) -> Option<(GLuint, Option<[f32; 2]>)> {
        if view.w > self.max_texture_size || view.h > self.max_texture_size {
            return None;
        }
        if let Some(pixels) = coverage_luminance_alpha(view) {
            let white_uv = white_patch(&pixels, view.w, view.h, 2);
            return upload_texture(&pixels, view.w, view.h, GL_LUMINANCE_ALPHA, view.linear).map(|name| (name, white_uv));
        }
        let rgba = texture_rgba(view)?;
        let white_uv = image_white_patch(&rgba, view.w, view.h);
        upload_texture(&rgba, view.w, view.h, GL_RGBA, view.linear).map(|name| (name, white_uv))
    }

    // Normal text and scaled text resolve the same core-owned coverage
    // pages. Preparing visible runs at full size removes first-scale uploads;
    // pages outside the bounded startup warmup are loaded on demand.
    fn prepare_fonts(&mut self, ui: &mut Ui) -> bool {
        if self.fonts.len() < spec::MAX_FONT_SLOTS {
            self.fonts.resize_with(spec::MAX_FONT_SLOTS, || None);
        }
        let mut index = 0;
        while index < ui.current_draw_list().words.len() {
            let words = &ui.current_draw_list().words;
            let len = match words[index] {
                spec::draw_op::GLYPH_RUN if index + 3 <= words.len() => {
                    let slot = (words[index + 1] & 0xff) as usize;
                    let count = (words[index + 1] >> 16) as usize;
                    let len = 3 + count * 2;
                    if index + len > words.len() { break; }
                    if slot >= self.fonts.len() { index += len; continue; }
                    if let Some(atlas) = ui.font_atlas(slot as u8) {
                        let revision = ui.font_atlas_revision(slot as u8);
                        if !self.fonts[slot].as_ref().is_some_and(|font| font.revision == revision) {
                            self.fonts[slot] = Some(FontTexture { revision, logical_w: atlas.cell_w,
                                logical_h: atlas.cell_h, glyph_count: atlas.glyph_count, pages: Vec::new() });
                        }
                        let font = self.fonts[slot].as_mut().unwrap();
                        // A caller may free a generated texture. Do not retain
                        // an alias to a recycled slot or an old font generation.
                        font.pages.retain(|page| ui.texture(page.handle as i32).is_some());
                        for glyph in 0..count {
                            let gid = (ui.current_draw_list().words[index + 4 + glyph * 2] & 0xffff) as u16;
                            if gid >= font.glyph_count || font.pages.iter().any(|page| page.contains(gid)) { continue; }
                            let Some(page) = ui.prepare_glyph_page(slot as u8, gid) else { return false; };
                            font.pages.push(page);
                        }
                    } else { self.fonts[slot] = None; }
                    len
                }
                spec::draw_op::RECT => 4,
                spec::draw_op::GRAD_RECT => 6,
                spec::draw_op::TRI => 7,
                spec::draw_op::TEX_QUAD | spec::draw_op::SURFACE_QUAD => 9,
                spec::draw_op::TEX_TRI => 12,
                spec::draw_op::SCISSOR => 3,
                spec::draw_op::SCISSOR_POP => 1,
                _ => break,
            };
            if index + len > ui.current_draw_list().words.len() { break; }
            index += len;
        }
        true
    }

    unsafe fn sync_resources(&mut self, ui: &Ui) -> bool {
        let mut ok = true;
        let slots = ui.texture_slot_count();
        if self.images.len() < slots {
            self.images.resize_with(slots, || None);
        }
        for slot in 0..self.images.len() {
            match ui.texture_at_versioned(slot as u32) {
                Some((handle, revision, view)) => {
                    if self.images[slot]
                        .as_ref()
                        .is_some_and(|texture| texture.matches(handle, revision))
                    {
                        continue;
                    }
                    if let Some(old) = self.images[slot].take() {
                        glDeleteTextures(1, &old.name);
                    }
                    self.images[slot] = match self.upload_image(view) {
                        Some((name, white_uv)) => Some(ImageTexture {
                            handle,
                            revision,
                            name,
                            white_uv,
                            dirty: false,
                        }),
                        None => {
                            ok = false;
                            None
                        }
                    };
                }
                None => {
                    if let Some(old) = self.images[slot].take() {
                        glDeleteTextures(1, &old.name);
                    }
                }
            }
        }

        ok
    }

    #[inline]
    fn image_name(&self, handle: i32) -> Option<GLuint> {
        if handle < 0 {
            return None;
        }
        let slot = handle as u32 & spec::TEX_SLOT_MASK;
        self.images
            .get(slot as usize)
            .and_then(|entry| *entry)
            .filter(|entry| entry.handle == handle)
            .map(|entry| entry.name)
    }

    fn fill_source(&self, texture: GLuint) -> (GLuint, [f32; 2]) {
        self.images.iter().flatten().find(|image| image.name == texture)
            .and_then(|image| image.white_uv)
            .map(|uv| (texture, uv))
            .unwrap_or((self.white, [0.5, 0.5]))
    }

    fn quad(
        &mut self,
        top_left: [f32; 2],
        bottom_right: [f32; 2],
        uv0: [f32; 2],
        uv1: [f32; 2],
        colors: [u32; 4],
    ) {
        let top_left_vertex = Vertex {
            position: top_left,
            uv: uv0,
            color: colors[0],
        };
        let top_right_vertex = Vertex {
            position: [bottom_right[0], top_left[1]],
            uv: [uv1[0], uv0[1]],
            color: colors[1],
        };
        let bottom_right_vertex = Vertex {
            position: bottom_right,
            uv: uv1,
            color: colors[2],
        };
        let bottom_left_vertex = Vertex {
            position: [top_left[0], bottom_right[1]],
            uv: [uv0[0], uv1[1]],
            color: colors[3],
        };
        self.vertices.extend_from_slice(&[
            top_left_vertex,
            top_right_vertex,
            bottom_right_vertex,
            top_left_vertex,
            bottom_right_vertex,
            bottom_left_vertex,
        ]);
    }

    fn flush(&mut self, texture: GLuint, clip: Clip, start: &mut usize) {
        let end = self.vertices.len();
        if end > *start {
            // A no-op clip push/pop can split otherwise contiguous geometry.
            // Merge only adjacent ranges with identical texture and scissor;
            // painter order and alpha compositing stay unchanged.
            if let Some(previous) = self.commands.last_mut() {
                if previous.texture == texture
                    && previous.clip == clip
                    && previous.first + previous.count == *start as i32
                {
                    previous.count += (end - *start) as i32;
                    *start = end;
                    return;
                }
            }
            self.commands.push(Command {
                texture,
                first: *start as i32,
                count: (end - *start) as i32,
                clip,
            });
            *start = end;
        }
    }

    fn build(&mut self, words: &[u32], logical_width: u32, logical_height: u32) {
        self.vertices.clear();
        self.commands.clear();
        let full = Clip {
            x: 0,
            y: 0,
            w: logical_width as i32,
            h: logical_height as i32,
        };
        let mut clip = full;
        let mut clip_stack = Vec::<Clip>::new();
        let mut texture = self.white;
        let mut fill_source = 0;
        let mut fill = (self.white, [0.5, 0.5]);
        let mut start = 0usize;
        let mut index = 0usize;

        while index < words.len() {
            match words[index] {
                spec::draw_op::RECT if index + 4 <= words.len() => {
                    if fill_source != texture {
                        fill = self.fill_source(texture);
                        fill_source = fill.0;
                    }
                    if texture != fill.0 {
                        self.flush(texture, clip, &mut start);
                        texture = fill.0;
                    }
                    let (x, y) = xy(words[index + 1]);
                    let (width, height) = wh(words[index + 2]);
                    let color = words[index + 3];
                    if width > 0.0 && height > 0.0 && color >> 24 != 0 {
                        self.quad([x, y], [x + width, y + height], fill.1, fill.1, [color; 4]);
                    }
                    index += 4;
                }
                spec::draw_op::GRAD_RECT if index + 6 <= words.len() => {
                    if fill_source != texture {
                        fill = self.fill_source(texture);
                        fill_source = fill.0;
                    }
                    if texture != fill.0 {
                        self.flush(texture, clip, &mut start);
                        texture = fill.0;
                    }
                    let (x, y) = xy(words[index + 1]);
                    let (width, height) = wh(words[index + 2]);
                    let from = words[index + 3];
                    let to = words[index + 4];
                    let direction = words[index + 5];
                    let colors = if direction == spec::GradDir::ToTop as u32 {
                        [to, to, from, from]
                    } else if direction == spec::GradDir::ToLeft as u32 {
                        [to, from, from, to]
                    } else if direction == spec::GradDir::ToRight as u32 {
                        [from, to, to, from]
                    } else {
                        [from, from, to, to]
                    };
                    if width > 0.0 && height > 0.0 {
                        self.quad([x, y], [x + width, y + height], fill.1, fill.1, colors);
                    }
                    index += 6;
                }
                spec::draw_op::GLYPH_RUN if index + 3 <= words.len() => {
                    let slot = (words[index + 1] & 0xff) as usize;
                    let count = (words[index + 1] >> 16) as usize;
                    let next = index + 3 + count * 2;
                    if next > words.len() {
                        break;
                    }
                    let Some(font) = self.fonts.get(slot).and_then(|font| font.as_ref()) else {
                        index = next;
                        continue;
                    };
                    let (logical_w, logical_h, glyph_count) = (font.logical_w, font.logical_h, font.glyph_count);
                    let mut page: Option<pocketjs_core::draw::GlyphSampler> = None;
                    let color = words[index + 2];
                    for glyph in 0..count {
                        let body = index + 3 + glyph * 2;
                        let (x, y) = xy(words[body]);
                        let gid = (words[body + 1] & 0xffff) as u16;
                        if gid >= glyph_count { continue; }
                        if !page.as_ref().is_some_and(|page| page.contains(gid)) {
                            page = self.fonts[slot].as_ref().unwrap().pages.iter().find(|page| page.contains(gid)).copied();
                            let Some(name) = page.and_then(|page| self.image_name(page.handle as i32)) else { page = None; continue; };
                            if texture != name {
                                self.flush(texture, clip, &mut start);
                                texture = name;
                            }
                        }
                        let Some(page) = page else { continue; };
                        let [u0, v0, u1, v1] = page.uv(gid);
                        self.quad([x, y], [x + logical_w as f32, y + logical_h as f32],
                            [u0, v0], [u1, v1], [color; 4]);
                    }
                    index = next;
                }
                spec::draw_op::TEX_QUAD if index + 9 <= words.len() => {
                    let handle = words[index + 1] as i32;
                    let Some(name) = self.image_name(handle) else {
                        index += 9;
                        continue;
                    };
                    if texture != name {
                        self.flush(texture, clip, &mut start);
                        texture = name;
                    }
                    let (x, y) = xy(words[index + 2]);
                    let (width, height) = wh(words[index + 3]);
                    if width > 0.0 && height > 0.0 {
                        self.quad(
                            [x, y],
                            [x + width, y + height],
                            [
                                f32::from_bits(words[index + 4]),
                                f32::from_bits(words[index + 5]),
                            ],
                            [
                                f32::from_bits(words[index + 6]),
                                f32::from_bits(words[index + 7]),
                            ],
                            [words[index + 8]; 4],
                        );
                    }
                    index += 9;
                }
                spec::draw_op::TEX_TRI if index + 12 <= words.len() => {
                    let handle = words[index + 1] as i32;
                    let Some(name) = self.image_name(handle) else {
                        index += 12;
                        continue;
                    };
                    if texture != name {
                        self.flush(texture, clip, &mut start);
                        texture = name;
                    }
                    let color = words[index + 11];
                    for vertex in 0..3 {
                        let offset = index + 2 + vertex * 3;
                        let (x, y) = xy(words[offset]);
                        self.vertices.push(Vertex {
                            position: [x, y],
                            uv: [
                                f32::from_bits(words[offset + 1]),
                                f32::from_bits(words[offset + 2]),
                            ],
                            color,
                        });
                    }
                    index += 12;
                }
                spec::draw_op::TRI if index + 7 <= words.len() => {
                    if texture != self.white {
                        self.flush(texture, clip, &mut start);
                        texture = self.white;
                    }
                    for vertex in 0..3 {
                        let (x, y) = xy(words[index + 1 + vertex]);
                        self.vertices.push(Vertex {
                            position: [x, y],
                            uv: [0.0, 0.0],
                            color: words[index + 4 + vertex],
                        });
                    }
                    index += 7;
                }
                spec::draw_op::SCISSOR if index + 3 <= words.len() => {
                    self.flush(texture, clip, &mut start);
                    clip_stack.push(clip);
                    let (x, y) = xy(words[index + 1]);
                    let (width, height) = wh(words[index + 2]);
                    clip = Clip {
                        x: x as i32,
                        y: y as i32,
                        w: width as i32,
                        h: height as i32,
                    };
                    index += 3;
                }
                spec::draw_op::SCISSOR_POP => {
                    self.flush(texture, clip, &mut start);
                    clip = clip_stack.pop().unwrap_or(full);
                    index += 1;
                }
                spec::draw_op::SURFACE_QUAD if index + 9 <= words.len() => {
                    index += 9;
                }
                _ => break,
            }
        }
        self.flush(texture, clip, &mut start);
    }

    fn physical_clip(
        clip: Clip,
        logical_width: i32,
        logical_height: i32,
        target_x: i32,
        target_y: i32,
        target_width: i32,
        target_height: i32,
        window_height: i32,
    ) -> Clip {
        let x0 = clip.x.clamp(0, logical_width);
        let y0 = clip.y.clamp(0, logical_height);
        let x1 = (clip.x + clip.w).clamp(0, logical_width);
        let y1 = (clip.y + clip.h).clamp(0, logical_height);
        let scale_floor = |value: i32, target: i32, logical: i32| -> i32 {
            if target == logical {
                return value;
            }
            (value as i64 * target as i64 / logical as i64) as i32
        };
        let scale_ceil = |value: i32, target: i32, logical: i32| -> i32 {
            if target == logical {
                return value;
            }
            ((value as i64 * target as i64 + logical as i64 - 1) / logical as i64) as i32
        };
        let left = target_x + scale_floor(x0, target_width, logical_width);
        let right = target_x + scale_ceil(x1, target_width, logical_width);
        let top = target_y + scale_floor(y0, target_height, logical_height);
        let bottom = target_y + scale_ceil(y1, target_height, logical_height);
        Clip {
            x: left,
            y: window_height - bottom,
            w: (right - left).max(0),
            h: (bottom - top).max(0),
        }
    }

    unsafe fn render(
        &mut self,
        ui: &mut Ui,
        target_x: i32,
        target_y: i32,
        target_width: i32,
        target_height: i32,
        window_width: i32,
        window_height: i32,
        clear_color: bool,
    ) -> bool {
        #[cfg(any(debug_assertions, feature = "gl-frame-validation"))]
        clear_errors();
        if window_width <= 0 || window_height <= 0 {
            return true;
        }
        if clear_color {
            glDisable(GL_SCISSOR_TEST);
            glViewport(0, 0, window_width, window_height);
            glClearColor(0.0, 0.0, 0.0, 1.0);
            glClear(GL_COLOR_BUFFER_BIT);
        }
        if target_width <= 0 || target_height <= 0 {
            return true;
        }

        trace(0, 0, 0);
        if self.fonts.is_empty() {
            // Small baked fonts were eager in the old GLES atlas path too.
            // Keep first reveal off the interaction path, now sharing these
            // pages with scaled text. Bound prefetch to 2 MiB CPU / 4 MiB GPU;
            // streamed and multi-page fonts remain demand-loaded.
            ui.warm_static_glyph_pages(2 * 1024 * 1024);
        }
        ui.draw();
        trace(1, 0, 0);
        if !self.prepare_fonts(ui) { return false; }
        let words = &ui.current_draw_list().words;
        let (logical_width, logical_height) = ui.viewport();
        let logical_width = logical_width.max(1.0) as u32;
        let logical_height = logical_height.max(1.0) as u32;
        if !self.sync_resources(ui) {
            return false;
        }
        trace(2, 0, 0);
        self.build(words, logical_width, logical_height);
        trace(3, self.commands.len(), self.vertices.len());

        self.pipeline
            .begin_frame(logical_width as f32, logical_height as f32);
        glViewport(
            target_x,
            window_height - target_y - target_height,
            target_width,
            target_height,
        );
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        glEnable(GL_BLEND);
        self.pipeline.set_blend();
        glEnable(GL_SCISSOR_TEST);

        if !self.vertices.is_empty() {
            glBindBuffer(GL_ARRAY_BUFFER, self.vertex_buffer);
            glBufferData(
                GL_ARRAY_BUFFER,
                (self.vertices.len() * size_of::<Vertex>()) as isize,
                self.vertices.as_ptr() as *const c_void,
                GL_DYNAMIC_DRAW,
            );
            self.pipeline.bind_vertices(size_of::<Vertex>() as i32);
        }

        trace(4, self.commands.len(), self.vertices.len());
        let mut bound = 0;
        let mut scissor = None;
        for command in &self.commands {
            if command.texture != bound {
                glBindTexture(GL_TEXTURE_2D, command.texture);
                bound = command.texture;
            }
            let physical = Self::physical_clip(
                command.clip,
                logical_width as i32,
                logical_height as i32,
                target_x,
                target_y,
                target_width,
                target_height,
                window_height,
            );
            if physical.w <= 0 || physical.h <= 0 {
                continue;
            }
            if scissor != Some(physical) {
                glScissor(physical.x, physical.y, physical.w, physical.h);
                scissor = Some(physical);
            }
            glDrawArrays(GL_TRIANGLES, command.first, command.count);
        }
        glDisable(GL_SCISSOR_TEST);
        self.pipeline.unbind_vertices();
        glBindBuffer(GL_ARRAY_BUFFER, 0);
        glBindTexture(GL_TEXTURE_2D, 0);
        trace(5, self.commands.len(), self.vertices.len());
        // Some mobile drivers serialize their command queue on glGetError.
        // Resource creation checks errors where recovery is possible; a
        // completed frame must stay queued so CPU work can overlap the GPU.
        #[cfg(any(debug_assertions, feature = "gl-frame-validation"))]
        let ok = glGetError() == GL_NO_ERROR;
        #[cfg(not(any(debug_assertions, feature = "gl-frame-validation")))]
        let ok = true;
        trace(6, self.commands.len(), self.vertices.len());
        ok
    }
}

pub unsafe fn initialize() -> bool {
    if let Some(renderer) = RENDERER.as_mut() {
        renderer.destroy();
    }
    RENDERER = Renderer::new();
    RENDERER.is_some()
}

pub unsafe fn reset_resources() {
    if let Some(renderer) = RENDERER.as_mut() {
        renderer.reset_resources();
    }
}

pub unsafe fn invalidate_resources() {
    if let Some(renderer) = RENDERER.as_mut() {
        renderer.invalidate_resources();
    }
}

pub unsafe fn invalidate_font(slot: u8) {
    if let Some(renderer) = RENDERER.as_mut() {
        renderer.invalidate_font(slot);
    }
}

pub unsafe fn shutdown() {
    if let Some(mut renderer) = RENDERER.take() {
        renderer.destroy();
    }
}

pub unsafe fn render(
    ui: &mut Ui,
    target_x: i32,
    target_y: i32,
    target_width: i32,
    target_height: i32,
    window_width: i32,
    window_height: i32,
) -> bool {
    RENDERER.as_mut().is_some_and(|renderer| {
        renderer.render(
            ui,
            target_x,
            target_y,
            target_width,
            target_height,
            window_width,
            window_height,
            true,
        )
    })
}

pub unsafe fn render_over(
    ui: &mut Ui,
    target_x: i32,
    target_y: i32,
    target_width: i32,
    target_height: i32,
    window_width: i32,
    window_height: i32,
) -> bool {
    RENDERER.as_mut().is_some_and(|renderer| {
        renderer.render(
            ui,
            target_x,
            target_y,
            target_width,
            target_height,
            window_width,
            window_height,
            false,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_xy(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn pack_wh(width: u16, height: u16) -> u32 {
        width as u32 | ((height as u32) << 16)
    }

    fn view<'a>(
        pixels: &'a [u8],
        width: u32,
        height: u32,
        psm: u32,
        palette: Option<&'a [u8]>,
    ) -> TexView<'a> {
        TexView {
            pixels,
            w: width,
            h: height,
            psm,
            palette,
            linear: false,
        }
    }

    fn planner(handle: i32, texture_name: GLuint) -> Renderer {
        let slot = (handle as u32 & spec::TEX_SLOT_MASK) as usize;
        let mut images = vec![None; slot + 1];
        images[slot] = Some(ImageTexture {
            handle,
            revision: 0,
            name: texture_name,
            white_uv: None,
            dirty: false,
        });
        Renderer {
            pipeline: Pipeline::stub(),
            vertex_buffer: 0,
            white: 1,
            images,
            fonts: Vec::new(),
            vertices: Vec::new(),
            commands: Vec::new(),
            max_texture_size: 2048,
        }
    }

    #[test]
    fn psm_fixtures_expand_to_rgba_and_reject_short_input() {
        let psm5650 = [
            0x1f, 0x00, // red
            0xe0, 0x07, // green
            0x00, 0xf8, // blue
        ];
        assert_eq!(
            texture_rgba(view(&psm5650, 3, 1, spec::psm::PSM_5650, None)),
            Some(vec![
                255, 0, 0, 255,
                0, 255, 0, 255,
                0, 0, 255, 255,
            ]),
        );

        assert_eq!(
            texture_rgba(view(&[0x21, 0x43], 1, 1, spec::psm::PSM_4444, None)),
            Some(vec![17, 34, 51, 68]),
        );
        assert_eq!(
            texture_rgba(view(&[1, 2, 3, 4], 1, 1, spec::psm::PSM_8888, None)),
            Some(vec![1, 2, 3, 4]),
        );

        let mut palette = vec![0u8; 1024];
        palette[8..12].copy_from_slice(&[9, 8, 7, 6]);
        assert_eq!(
            texture_rgba(view(
                &[2],
                1,
                1,
                spec::psm::PSM_T8,
                Some(&palette),
            )),
            Some(vec![9, 8, 7, 6]),
        );
        assert_eq!(
            texture_rgba(view(&[1, 2, 3], 1, 1, spec::psm::PSM_8888, None)),
            None,
        );
    }

    #[test]
    fn texture_cache_version_includes_revision_and_dirty_state() {
        let mut texture = ImageTexture {
            handle: 7,
            revision: 4,
            name: 9,
            white_uv: None,
            dirty: false,
        };
        assert!(texture.matches(7, 4));
        assert!(!texture.matches(7, 5));
        assert!(!texture.matches(8, 4));
        texture.dirty = true;
        assert!(!texture.matches(7, 4));
    }

    #[test]
    fn tex_tri_decoder_preserves_vertices_batches_and_nested_scissors() {
        let handle = 0;
        let texture = 9;
        let color = 0x8040_3020;
        let tri = [
            spec::draw_op::TEX_TRI,
            handle as u32,
            pack_xy(-3, 4),
            0.125f32.to_bits(),
            0.25f32.to_bits(),
            pack_xy(20, 5),
            0.75f32.to_bits(),
            0.25f32.to_bits(),
            pack_xy(7, 30),
            0.5f32.to_bits(),
            0.875f32.to_bits(),
            color,
        ];
        let mut words = vec![
            spec::draw_op::SCISSOR,
            pack_xy(10, 20),
            pack_wh(100, 80),
        ];
        words.extend_from_slice(&tri);
        words.extend_from_slice(&[
            spec::draw_op::SCISSOR,
            pack_xy(20, 30),
            pack_wh(50, 40),
        ]);
        words.extend_from_slice(&tri);
        words.extend_from_slice(&[
            spec::draw_op::SCISSOR_POP,
            spec::draw_op::SCISSOR_POP,
            0xffff_ffff, // Unknown ops stop safely; following words are ignored.
            spec::draw_op::RECT,
            pack_xy(0, 0),
            pack_wh(10, 10),
            0xffff_ffff,
        ]);

        let mut renderer = planner(handle, texture);
        renderer.build(&words, 200, 120);

        assert_eq!(renderer.vertices.len(), 6);
        assert_eq!(
            renderer.vertices[0],
            Vertex {
                position: [-3.0, 4.0],
                uv: [0.125, 0.25],
                color,
            },
        );
        assert_eq!(
            renderer.commands,
            vec![
                Command {
                    texture,
                    first: 0,
                    count: 3,
                    clip: Clip {
                        x: 10,
                        y: 20,
                        w: 100,
                        h: 80,
                    },
                },
                Command {
                    texture,
                    first: 3,
                    count: 3,
                    clip: Clip {
                        x: 20,
                        y: 30,
                        w: 50,
                        h: 40,
                    },
                },
            ],
        );
    }

    #[test]
    fn shared_glyph_pages_survive_scale_and_revalidate_free_and_reload() {
        let mut atlas = Vec::new();
        atlas.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
        atlas.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
        atlas.extend_from_slice(&50u16.to_le_bytes());
        atlas.extend_from_slice(&[64, 64, 60, 64, 0, 0, 1, 0]);
        for gid in 0..50u16 {
            atlas.extend_from_slice(&(65 + gid as u32).to_le_bytes());
            atlas.extend_from_slice(&gid.to_le_bytes());
            atlas.extend_from_slice(&[64, 0]);
        }
        atlas.resize(atlas.len() + 50 * 64 * 64, 127);
        let mut ui = Ui::new();
        assert!(ui.load_font_atlas(&atlas));
        let text = ui.create_node(spec::NodeType::Text as u8);
        ui.set_text(text, "ArA");
        ui.set_prop(text, spec::prop::WIDTH, 192.0);
        ui.set_prop(text, spec::prop::HEIGHT, 64.0);
        ui.insert_before(spec::ROOT_ID, text, 0);
        ui.tick();
        let words = ui.draw().words.clone();
        let mut renderer = planner(0, 9);
        assert!(renderer.prepare_fonts(&mut ui));
        let pages = renderer.fonts[0].as_ref().unwrap().pages.clone();
        assert_eq!(pages.len(), 2, "a run may cross pages and return to its first page");
        let slots = ui.texture_slot_count();
        renderer.images.clear();
        for page in &pages {
            let view = ui.texture(page.handle as i32).unwrap();
            let rgba = texture_rgba(view).unwrap();
            let la = coverage_luminance_alpha(view).unwrap();
            assert_eq!(la.len() * 2, rgba.len());
            for (rgba, la) in rgba.chunks_exact(4).zip(la.chunks_exact(2)) {
                assert_eq!([la[0], la[0], la[0], la[1]], rgba);
            }
            renderer.images.push(Some(ImageTexture { handle: page.handle as i32, revision: 0,
                name: 7 + renderer.images.len() as u32, white_uv: white_patch(&la, view.w, view.h, 2), dirty: false }));
        }
        renderer.build(&words, 480, 272);
        assert_eq!(renderer.vertices.len(), 18);
        assert_eq!(renderer.commands.iter().map(|c| c.texture).collect::<Vec<_>>(), [7, 8, 7]);
        assert_eq!(renderer.vertices[0].uv, renderer.vertices[12].uv);
        ui.set_prop(text, spec::prop::SCALE, 0.5);
        let scaled = ui.draw().words.clone();
        assert!(renderer.prepare_fonts(&mut ui));
        assert_eq!(ui.texture_slot_count(), slots, "first scale must not allocate a second atlas");
        assert_eq!(scaled[1], pages[0].handle);
        assert_eq!(scaled[10], pages[1].handle);
        ui.set_prop(text, spec::prop::SCALE, 1.0);
        ui.free_texture(pages[0].handle as i32);
        ui.draw();
        assert!(renderer.prepare_fonts(&mut ui));
        assert!(ui.texture(pages[0].handle as i32).is_none());
        assert!(renderer.fonts[0].as_ref().unwrap().pages.iter().all(|p| ui.texture(p.handle as i32).is_some()));
        assert!(ui.load_font_atlas(&atlas));
        assert!(renderer.prepare_fonts(&mut ui));
        assert!(ui.texture(pages[1].handle as i32).is_none(), "font revision invalidates every old page");
        assert_eq!(ui.texture_slot_count(), slots, "reload reuses storage");
        renderer.invalidate_font(0);
        assert!(renderer.prepare_fonts(&mut ui));
        assert_eq!(ui.texture_slot_count(), slots, "backend invalidation does not duplicate core pages");
    }

    #[test]
    fn indexed_coverage_optimization_rejects_colored_or_short_palettes() {
        let mut palette = vec![255; 1024];
        palette[3] = 0;
        palette[7] = 73;
        assert_eq!(coverage_luminance_alpha(view(&[0, 1], 2, 1, spec::psm::PSM_T8, Some(&palette))), Some(vec![255, 0, 255, 73]));
        assert!(coverage_luminance_alpha(view(&[0], 2, 1, spec::psm::PSM_T8, Some(&palette))).is_none());
        palette[0] = 0;
        assert!(coverage_luminance_alpha(view(&[0, 1], 2, 1, spec::psm::PSM_T8, Some(&palette))).is_none());
    }

    #[test]
    fn image_fill_patch_requires_guarded_opaque_white_pixels() {
        let mut pixels = vec![0; 8 * 8 * 4];
        for y in 2..6 {
            for x in 3..7 { pixels[(y * 8 + x) * 4..(y * 8 + x + 1) * 4].fill(255); }
        }
        assert_eq!(image_white_patch(&pixels, 8, 8), Some([5.0 / 8.0, 4.0 / 8.0]));
        pixels[(3 * 8 + 4) * 4 + 3] = 254;
        assert_eq!(image_white_patch(&pixels, 8, 8), None);
        assert_eq!(image_white_patch(&[255; 3 * 4 * 4], 3, 4), None);
    }

    #[test]
    fn image_and_fill_share_a_batch_without_changing_geometry_or_color() {
        let mut renderer = planner(0, 9);
        let words = [spec::draw_op::TEX_QUAD, 0, pack_xy(0, 0), pack_wh(8, 8),
            0.0f32.to_bits(), 0.0f32.to_bits(), 1.0f32.to_bits(), 1.0f32.to_bits(), 0xffffffff,
            spec::draw_op::RECT, pack_xy(8, 0), pack_wh(8, 8), 0x80765432];
        renderer.build(&words, 100, 50);
        assert_eq!(renderer.commands.len(), 2);
        let before: Vec<_> = renderer.vertices.iter().map(|v| (v.position, v.color)).collect();
        renderer.images[0].as_mut().unwrap().white_uv = Some([0.5, 0.5]);
        renderer.build(&words, 100, 50);
        assert_eq!(renderer.commands.len(), 1);
        assert_eq!(renderer.commands[0].texture, 9);
        assert_eq!(renderer.vertices.iter().map(|v| (v.position, v.color)).collect::<Vec<_>>(), before);
        assert!(renderer.vertices[6..].iter().all(|v| v.uv == [0.5, 0.5]));
    }

    #[test]
    fn no_op_scissors_merge_without_crossing_a_different_clip() {
        let mut renderer = planner(0, 9);
        let rect = |color| [spec::draw_op::RECT, pack_xy(2, 3), pack_wh(4, 5), color];
        let colors = [0x80112233, 0x80445566, 0x80778899, 0x80aabbcc, 0x80ddeeff];
        let mut words = rect(colors[0]).to_vec();
        words.extend_from_slice(&[spec::draw_op::SCISSOR, pack_xy(0, 0), pack_wh(100, 50)]);
        words.extend_from_slice(&rect(colors[1]));
        words.push(spec::draw_op::SCISSOR_POP);
        words.extend_from_slice(&rect(colors[2]));
        words.extend_from_slice(&[spec::draw_op::SCISSOR, pack_xy(0, 0), pack_wh(50, 50)]);
        words.extend_from_slice(&rect(colors[3]));
        words.push(spec::draw_op::SCISSOR_POP);
        words.extend_from_slice(&rect(colors[4]));
        renderer.build(&words, 100, 50);
        assert_eq!(renderer.vertices.len(), 30);
        for (vertices, color) in renderer.vertices.chunks(6).zip(colors) {
            assert!(vertices.iter().all(|v| v.color == color));
        }
        assert_eq!(
            renderer
                .commands
                .iter()
                .map(|c| (c.first, c.count, c.clip.w))
                .collect::<Vec<_>>(),
            vec![(0, 18, 100), (18, 6, 50), (24, 6, 100)]
        );
    }

    #[test]
    fn native_scissor_preserves_offset_clipping_and_y_inversion() {
        assert_eq!(
            Renderer::physical_clip(
                Clip {
                    x: -3,
                    y: -4,
                    w: 20,
                    h: 30
                },
                360,
                640,
                10,
                20,
                360,
                640,
                700,
            ),
            Clip {
                x: 10,
                y: 654,
                w: 17,
                h: 26
            }
        );
        assert_eq!(
            Renderer::physical_clip(
                Clip {
                    x: 630,
                    y: 350,
                    w: 20,
                    h: 30
                },
                640,
                360,
                0,
                0,
                640,
                360,
                360,
            ),
            Clip {
                x: 630,
                y: 0,
                w: 10,
                h: 10
            }
        );
    }

    #[test]
    fn truncated_draw_op_stops_without_partial_geometry() {
        let mut renderer = planner(0, 9);
        renderer.build(
            &[spec::draw_op::TEX_TRI, 0, pack_xy(1, 2)],
            100,
            50,
        );
        assert!(renderer.vertices.is_empty());
        assert!(renderer.commands.is_empty());
    }

    #[test]
    fn logical_scissor_maps_to_bottom_left_physical_coordinates() {
        assert_eq!(
            Renderer::physical_clip(
                Clip {
                    x: 25,
                    y: 10,
                    w: 50,
                    h: 20,
                },
                100,
                50,
                10,
                20,
                200,
                100,
                200,
            ),
            Clip {
                x: 60,
                y: 120,
                w: 100,
                h: 40,
            },
        );
    }
}
