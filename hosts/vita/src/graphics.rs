//! vita2d/GXM DrawList backend shared by PocketJS apps and games.
//!
//! The core stays at its deterministic 480x272 logical viewport. Geometry is
//! presented at 2x while density-aware fonts, vectors, images and masks supply
//! native 960x544 raster detail without relayout.

use std::collections::HashMap;
#[cfg(feature = "capture")]
use std::fs;
#[cfg(feature = "capture")]
use std::io;
#[cfg(feature = "capture")]
use std::path::Path;

use pocketjs_core::{spec, text::Atlas, Ui};
use vita2d_sys::*;

mod build_plan {
    include!(concat!(env!("OUT_DIR"), "/build_plan.rs"));
}

pub use build_plan::{
    INTEGER_SCALE, LOGICAL_H, LOGICAL_W, PHYSICAL_H, PHYSICAL_W, RASTER_DENSITY, SCALE,
};
pub const DEFAULT_POOL_BYTES: u32 = 2 * 1024 * 1024;
/// Cross-guest same-size texture reuse avoids Vita3K's live texture-destroy
/// instability, but an unbounded union of every app's size buckets would turn
/// launcher browsing into monotonic CDRAM growth. Trim only at a guest boundary
/// after GXM is known idle.
const RECYCLED_TEXTURE_BUDGET: usize = 16 * 1024 * 1024;
/// Conservative GXM font-atlas limit. App textures keep the portable 512px
/// contract, but density-2 ASCII at the 36px slot needs a 1024x1024 atlas.
const VITA_FONT_TEXTURE_MAX_DIM: u32 = 2048;

#[derive(Clone, Copy)]
struct Texture {
    ptr: *mut vita2d_texture,
    w: u32,
    h: u32,
}

struct RetiredTexture {
    texture: Texture,
    // Set only after the GPU wait at the next scene boundary. A texture
    // retired during the current scene may still be sampled by that scene.
    reusable_in_scene: bool,
}

#[derive(Clone, Copy)]
struct FontTexture {
    texture: Texture,
    glyph_count: u16,
    /// Source coverage-cell dimensions in GXM texels.
    coverage_w: u32,
    coverage_h: u32,
    /// Destination dimensions before the logical-to-physical scale.
    logical_w: u32,
    logical_h: u32,
    raster_density: u8,
    cols: u32,
}

static mut INITIALIZED: bool = false;
static mut TEXTURES: Option<HashMap<i32, Texture>> = None;
static mut RECYCLED_TEXTURES: Option<Vec<RetiredTexture>> = None;
static mut FONTS: Option<HashMap<u8, FontTexture>> = None;
static mut CLIP_STACK: Option<Vec<(i32, i32, i32, i32)>> = None;

unsafe fn textures() -> &'static mut HashMap<i32, Texture> {
    if TEXTURES.is_none() {
        TEXTURES = Some(HashMap::new());
    }
    TEXTURES.as_mut().unwrap()
}

unsafe fn recycle_texture(texture: Texture) {
    RECYCLED_TEXTURES
        .get_or_insert_with(Vec::new)
        .push(RetiredTexture {
            texture,
            reusable_in_scene: false,
        });
}

/// Whether the GPU is known idle since the last `present`. Reusing a recycled
/// texture rewrites memory the previous frame may still sample, so the rare
/// texture-recycle path drains GXM once per frame at most; the common path
/// never blocks on the GPU.
static mut GPU_IDLE: bool = true;
/// True only while callers may record vita2d commands for the current scene.
/// Only textures retired before this scene's GPU wait can be reused here.
static mut SCENE_OPEN: bool = false;

unsafe fn ensure_rendering_done() {
    if !GPU_IDLE {
        vita2d_wait_rendering_done();
        GPU_IDLE = true;
    }
}

unsafe fn take_recycled_texture(w: u32, h: u32) -> Option<Texture> {
    let recycled = RECYCLED_TEXTURES.as_mut()?;
    let index = recycled.iter().position(|entry| {
        entry.texture.w == w && entry.texture.h == h && (!SCENE_OPEN || entry.reusable_in_scene)
    })?;
    ensure_rendering_done();
    Some(recycled.swap_remove(index).texture)
}

#[inline]
fn texture_bytes(texture: Texture) -> usize {
    // libvita2d aligns RGBA row widths to 8 pixels and CDRAM allocations to
    // 256 KiB. Counting only logical pixels let tiny textures evade the cap.
    let bytes = (texture.w as usize).div_ceil(8) * 8 * texture.h as usize * 4;
    bytes.div_ceil(256 * 1024) * (256 * 1024)
}

/// Retire every GPU handle belonging to the outgoing guest. vita2d itself is
/// process-owned and remains initialized for the next guest.
///
/// # Safety
///
/// Call on the Vita render thread with no open scene and no outstanding guest
/// texture references. This function owns the required GXM idle wait.
pub unsafe fn reset_guest() {
    assert!(
        !SCENE_OPEN,
        "cannot reset guest GPU state inside a vita2d scene"
    );
    ensure_rendering_done();

    if let Some(guest_textures) = TEXTURES.take() {
        for texture in guest_textures.into_values() {
            recycle_texture(texture);
        }
    }
    if let Some(guest_fonts) = FONTS.take() {
        for font in guest_fonts.into_values() {
            recycle_texture(font.texture);
        }
    }
    CLIP_STACK = None;

    let recycled = RECYCLED_TEXTURES.get_or_insert_with(Vec::new);
    let mut bytes: usize = recycled
        .iter()
        .map(|entry| texture_bytes(entry.texture))
        .sum();
    while bytes > RECYCLED_TEXTURE_BUDGET && !recycled.is_empty() {
        let texture = recycled.remove(0).texture;
        bytes = bytes.saturating_sub(texture_bytes(texture));
        vita2d_free_texture(texture.ptr);
    }
}

unsafe fn fonts() -> &'static mut HashMap<u8, FontTexture> {
    if FONTS.is_none() {
        FONTS = Some(HashMap::new());
    }
    FONTS.as_mut().unwrap()
}

unsafe fn clip_stack() -> &'static mut Vec<(i32, i32, i32, i32)> {
    CLIP_STACK.get_or_insert_with(Vec::new)
}

pub fn init() -> Result<(), &'static str> {
    init_with_pool(DEFAULT_POOL_BYTES)
}

/// Initialize vita2d once. Games with large projected worlds should call
/// this with a larger pool before constructing `Runtime` (8 MiB is typical).
pub fn init_with_pool(pool_bytes: u32) -> Result<(), &'static str> {
    unsafe {
        if INITIALIZED {
            return Ok(());
        }
        if vita2d_init_advanced(pool_bytes) < 0 {
            return Err("vita2d_init_advanced failed");
        }
        vita2d_set_vblank_wait(1);
        vita2d_set_clear_color(0xff00_0000);
        INITIALIZED = true;
        Ok(())
    }
}

/// Start and clear one shared scene. Draw 3D first, then call
/// `Runtime::render_over`, then `present` exactly once.
///
/// # Safety
///
/// Call on the Vita render thread after [`init`], with no scene already open.
pub unsafe fn begin_frame(clear: u32) {
    assert!(!SCENE_OPEN, "vita2d scene is already open");
    // libvita2d owns one GPU-visible temporary vertex pool and resets it in
    // `vita2d_start_drawing`. Wait at the last responsible moment so the CPU
    // can run simulation/JS for frame N+1 while frame N is on the GPU without
    // overwriting vertices that are still in flight.
    ensure_rendering_done();
    if let Some(recycled) = RECYCLED_TEXTURES.as_mut() {
        for entry in recycled {
            entry.reusable_in_scene = true;
        }
    }
    vita2d_set_clear_color(clear);
    vita2d_start_drawing();
    SCENE_OPEN = true;
    vita2d_disable_clipping();
    vita2d_clear_screen();
}

/// Finish the scene and queue the swap. The CPU does not drain the GPU here:
/// simulation and JS for frame N+1 overlap frame N's GPU work. [`begin_frame`]
/// waits immediately before libvita2d reuses its single temporary vertex pool;
/// texture recycling uses the same safety point when it happens earlier.
///
/// # Safety
///
/// Call on the Vita render thread with exactly one scene opened by
/// [`begin_frame`]. Raw `vita2d_start_drawing` callers are not tracked by this
/// module and must pair their scene without using `present`.
pub unsafe fn present() {
    assert!(SCENE_OPEN, "no vita2d scene is open");
    vita2d_disable_clipping();
    vita2d_end_drawing();
    vita2d_swap_buffers();
    SCENE_OPEN = false;
    GPU_IDLE = false;
}

fn texture_rgba(view: pocketjs_core::TexView<'_>) -> Option<Vec<u8>> {
    let pixels = (view.w as usize).checked_mul(view.h as usize)?;
    let mut out = vec![0u8; pixels.checked_mul(4)?];
    match view.psm {
        spec::psm::PSM_5650 => {
            if view.pixels.len() < pixels * 2 {
                return None;
            }
            for (i, src) in view.pixels[..pixels * 2].chunks_exact(2).enumerate() {
                let px = u16::from_le_bytes([src[0], src[1]]) as u32;
                let r = px & 0x1f;
                let g = (px >> 5) & 0x3f;
                let b = (px >> 11) & 0x1f;
                out[i * 4] = ((r << 3) | (r >> 2)) as u8;
                out[i * 4 + 1] = ((g << 2) | (g >> 4)) as u8;
                out[i * 4 + 2] = ((b << 3) | (b >> 2)) as u8;
                out[i * 4 + 3] = 255;
            }
        }
        spec::psm::PSM_8888 => {
            let len = out.len();
            if view.pixels.len() < len {
                return None;
            }
            out.copy_from_slice(&view.pixels[..len]);
        }
        spec::psm::PSM_4444 => {
            if view.pixels.len() < pixels * 2 {
                return None;
            }
            for (i, src) in view.pixels[..pixels * 2].chunks_exact(2).enumerate() {
                let px = u16::from_le_bytes([src[0], src[1]]);
                out[i * 4] = ((px & 0x000f) as u8) * 17;
                out[i * 4 + 1] = (((px >> 4) & 0x000f) as u8) * 17;
                out[i * 4 + 2] = (((px >> 8) & 0x000f) as u8) * 17;
                out[i * 4 + 3] = (((px >> 12) & 0x000f) as u8) * 17;
            }
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette?;
            if palette.len() < 1024 || view.pixels.len() < pixels {
                return None;
            }
            for (i, &index) in view.pixels[..pixels].iter().enumerate() {
                let p = index as usize * 4;
                out[i * 4..i * 4 + 4].copy_from_slice(&palette[p..p + 4]);
            }
        }
        _ => return None,
    }
    Some(out)
}

unsafe fn upload_rgba(w: u32, h: u32, rgba: &[u8], linear: bool) -> Option<Texture> {
    if w == 0 || h == 0 || rgba.len() < w as usize * h as usize * 4 {
        return None;
    }
    // Vita3K's GXM emulation can fault when a live app repeatedly destroys
    // vita2d textures. Recycle same-sized RGBA allocations instead. This also
    // bounds each power-of-two size bucket by its historical resident high
    // water mark. `take_recycled_texture` drains GXM before handing an
    // allocation back, so a recycled allocation is no longer in flight.
    let ptr = take_recycled_texture(w, h)
        .map(|texture| texture.ptr)
        .unwrap_or_else(|| {
            vita2d_create_empty_texture_format(
                w,
                h,
                SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR,
            )
        });
    if ptr.is_null() {
        return None;
    }
    let stride = vita2d_texture_get_stride(ptr) as usize;
    let dst = vita2d_texture_get_datap(ptr) as *mut u8;
    let row_bytes = w as usize * 4;
    for row in 0..h as usize {
        core::ptr::copy_nonoverlapping(
            rgba.as_ptr().add(row * row_bytes),
            dst.add(row * stride),
            row_bytes,
        );
    }
    let filter = if linear {
        SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR
    } else {
        SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT
    };
    vita2d_texture_set_filters(ptr, filter, filter);
    Some(Texture { ptr, w, h })
}

pub fn register_texture(ui: &Ui, handle: i32) {
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let Some(rgba) = texture_rgba(view) else {
        return;
    };
    unsafe {
        let Some(texture) = upload_rgba(view.w, view.h, &rgba, view.linear) else {
            return;
        };
        if let Some(old) = textures().insert(handle, texture) {
            recycle_texture(old);
        }
    }
}

/// Resolve a DrawList texture in the Vita GPU cache, uploading core-owned
/// textures (for example the baked rounded-corner discs) on first use.
/// Pak/JS textures are registered eagerly, but textures minted internally by
/// `Ui::draw` never cross those upload hooks.
unsafe fn resolve_texture(ui: &Ui, handle: i32) -> Option<Texture> {
    if let Some(texture) = textures().get(&handle).copied() {
        return Some(texture);
    }
    register_texture(ui, handle);
    textures().get(&handle).copied()
}

/// Rewrite an existing GPU mirror's pixels in place from the core texture —
/// the per-frame video-plane path (register_texture would allocate + drain
/// GXM once per presented frame at 24 fps). Falls back to full registration
/// when no mirror exists or the size changed. Call inside the GPU-idle
/// window (right after begin_frame's ensure_rendering_done — the previous
/// scene has finished sampling, the next one reads the new pixels at swap).
pub fn update_texture_in_place(ui: &Ui, handle: i32) {
    let Some(view) = ui.texture(handle) else {
        return;
    };
    unsafe {
        let Some(existing) = textures().get(&handle).copied() else {
            register_texture(ui, handle);
            return;
        };
        if existing.w != view.w || existing.h != view.h {
            register_texture(ui, handle);
            return;
        }
        let Some(rgba) = texture_rgba(view) else {
            return;
        };
        ensure_rendering_done();
        let stride = vita2d_texture_get_stride(existing.ptr) as usize;
        let dst = vita2d_texture_get_datap(existing.ptr) as *mut u8;
        let row_bytes = view.w as usize * 4;
        for row in 0..view.h as usize {
            core::ptr::copy_nonoverlapping(
                rgba.as_ptr().add(row * row_bytes),
                dst.add(row * stride),
                row_bytes,
            );
        }
    }
}

pub fn free_texture(handle: i32) {
    unsafe {
        if let Some(texture) = textures().remove(&handle) {
            recycle_texture(texture);
        }
    }
}

#[inline]
fn next_pow2(mut value: u32) -> u32 {
    if value <= 1 {
        return 1;
    }
    value -= 1;
    value |= value >> 1;
    value |= value >> 2;
    value |= value >> 4;
    value |= value >> 8;
    value |= value >> 16;
    value + 1
}

fn font_grid(glyphs: u32, cell_w: u32, cell_h: u32) -> Option<(u32, u32, u32)> {
    if glyphs == 0
        || cell_w == 0
        || cell_h == 0
        || cell_w > VITA_FONT_TEXTURE_MAX_DIM
        || cell_h > VITA_FONT_TEXTURE_MAX_DIM
    {
        return None;
    }
    let max_cols = VITA_FONT_TEXTURE_MAX_DIM / cell_w;
    let mut cols = 1u32;
    while cols < max_cols && cols.saturating_mul(cols) < glyphs {
        cols += 1;
    }
    let dimensions = |cols: u32| -> Option<(u32, u32)> {
        let rows = glyphs.div_ceil(cols);
        let width = next_pow2(cols.checked_mul(cell_w)?);
        let height = next_pow2(rows.checked_mul(cell_h)?);
        Some((width, height))
    };
    let (mut tex_w, mut tex_h) = dimensions(cols)?;
    // A square-ish grid can overflow one axis after pow2 padding. Retry with
    // the maximum legal column count before rejecting the atlas.
    if tex_w > VITA_FONT_TEXTURE_MAX_DIM || tex_h > VITA_FONT_TEXTURE_MAX_DIM {
        cols = max_cols;
        (tex_w, tex_h) = dimensions(cols)?;
    }
    if tex_w > VITA_FONT_TEXTURE_MAX_DIM || tex_h > VITA_FONT_TEXTURE_MAX_DIM {
        return None;
    }
    Some((cols, tex_w, tex_h))
}

fn evict_font(slot: u8) {
    unsafe {
        if let Some(old) = fonts().remove(&slot) {
            recycle_texture(old.texture);
        }
    }
}

pub fn register_font_atlas(slot: u8, atlas: &Atlas) {
    let coverage_w = atlas.coverage_width();
    let coverage_h = atlas.coverage_height();
    let Some((cols, tex_w, tex_h)) = font_grid(atlas.glyph_count as u32, coverage_w, coverage_h)
    else {
        evict_font(slot);
        crate::vita_log(format_args!(
            "[PocketJS Vita] font atlas slot {slot} rejected: {} glyphs, logical {}x{}, coverage {}x{} at density {}, max texture {}",
            atlas.glyph_count,
            atlas.cell_w,
            atlas.cell_h,
            coverage_w,
            coverage_h,
            atlas.raster_density,
            VITA_FONT_TEXTURE_MAX_DIM,
        ));
        return;
    };
    let Some(rgba_len) = (tex_w as usize)
        .checked_mul(tex_h as usize)
        .and_then(|pixels| pixels.checked_mul(4))
    else {
        evict_font(slot);
        crate::vita_log(format_args!(
            "[PocketJS Vita] font atlas slot {slot} rejected: {tex_w}x{tex_h} RGBA size overflow"
        ));
        return;
    };
    let mut rgba = vec![0u8; rgba_len];
    for gid in 0..atlas.glyph_count {
        let src = atlas.glyph_rows(gid);
        let gx = (gid as u32 % cols) * coverage_w;
        let gy = (gid as u32 / cols) * coverage_h;
        for y in 0..coverage_h as usize {
            for x in 0..coverage_w as usize {
                let dst = ((gy as usize + y) * tex_w as usize + gx as usize + x) * 4;
                rgba[dst] = 255;
                rgba[dst + 1] = 255;
                rgba[dst + 2] = 255;
                rgba[dst + 3] = src[y * atlas.bytes_per_row() + x];
            }
        }
    }
    unsafe {
        let Some(texture) = upload_rgba(tex_w, tex_h, &rgba, false) else {
            evict_font(slot);
            crate::vita_log(format_args!(
                "[PocketJS Vita] font atlas slot {slot} GPU upload failed: {tex_w}x{tex_h}"
            ));
            return;
        };
        let font = FontTexture {
            texture,
            glyph_count: atlas.glyph_count,
            coverage_w,
            coverage_h,
            logical_w: atlas.cell_w,
            logical_h: atlas.cell_h,
            raster_density: atlas.raster_density,
            cols,
        };
        if let Some(old) = fonts().insert(slot, font) {
            recycle_texture(old.texture);
        }
    }
}

#[inline]
fn xy(word: u32) -> (f32, f32) {
    (
        (word & 0xffff) as u16 as i16 as f32 * SCALE,
        (word >> 16) as u16 as i16 as f32 * SCALE,
    )
}

#[inline]
fn wh(word: u32) -> (f32, f32) {
    ((word & 0xffff) as f32 * SCALE, (word >> 16) as f32 * SCALE)
}

unsafe fn color_vertices(values: &[vita2d_color_vertex], mode: SceGxmPrimitiveType) {
    let bytes = core::mem::size_of_val(values);
    let dst = vita2d_pool_memalign(bytes as u32, 4) as *mut vita2d_color_vertex;
    if dst.is_null() {
        return;
    }
    core::ptr::copy_nonoverlapping(values.as_ptr(), dst, values.len());
    vita2d_draw_array(mode, dst, values.len());
}

unsafe fn texture_vertices(
    texture: *const vita2d_texture,
    values: &[vita2d_texture_vertex],
    mode: SceGxmPrimitiveType,
    color: u32,
) {
    let bytes = core::mem::size_of_val(values);
    let dst = vita2d_pool_memalign(bytes as u32, 4) as *mut vita2d_texture_vertex;
    if dst.is_null() {
        return;
    }
    core::ptr::copy_nonoverlapping(values.as_ptr(), dst, values.len());
    vita2d_draw_array_textured(texture, mode, dst, values.len(), color);
}

/// Clear and draw one standalone UI scene. `present` remains explicit.
///
/// # Safety
///
/// Call on the Vita render thread after [`init`], with no scene already open.
pub unsafe fn render(ui: &Ui, words: &[u32]) {
    begin_frame(0xff00_0000);
    render_over(ui, words);
}

/// Draw a PocketJS HUD into the caller's open vita2d scene.
///
/// # Safety
///
/// Call on the Vita render thread while a vita2d scene is open. `words` and
/// every texture referenced by it must remain valid for this submission.
pub unsafe fn render_over(ui: &Ui, words: &[u32]) {
    // Keep the nesting stack's high-water capacity across frames; UI clip
    // traversal otherwise allocates a fresh Vec on every render.
    let scissors = clip_stack();
    scissors.clear();
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT if i + 4 <= words.len() => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                vita2d_draw_rectangle(x, y, w, h, words[i + 3]);
                i += 4;
            }
            spec::draw_op::GRAD_RECT if i + 6 <= words.len() => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let from = words[i + 3];
                let to = words[i + 4];
                let (tl, tr, bl, br) = match words[i + 5] {
                    d if d == spec::GradDir::ToTop as u32 => (to, to, from, from),
                    d if d == spec::GradDir::ToLeft as u32 => (to, from, to, from),
                    d if d == spec::GradDir::ToRight as u32 => (from, to, from, to),
                    _ => (from, from, to, to),
                };
                color_vertices(
                    &[
                        vita2d_color_vertex {
                            x,
                            y,
                            z: 0.5,
                            color: tl,
                        },
                        vita2d_color_vertex {
                            x: x + w,
                            y,
                            z: 0.5,
                            color: tr,
                        },
                        vita2d_color_vertex {
                            x,
                            y: y + h,
                            z: 0.5,
                            color: bl,
                        },
                        vita2d_color_vertex {
                            x: x + w,
                            y: y + h,
                            z: 0.5,
                            color: br,
                        },
                    ],
                    SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLE_STRIP,
                );
                i += 6;
            }
            spec::draw_op::TRI if i + 7 <= words.len() => {
                let mut vertices = [vita2d_color_vertex {
                    x: 0.0,
                    y: 0.0,
                    z: 0.5,
                    color: 0,
                }; 3];
                for k in 0..3 {
                    let (x, y) = xy(words[i + 1 + k]);
                    vertices[k] = vita2d_color_vertex {
                        x,
                        y,
                        z: 0.5,
                        color: words[i + 4 + k],
                    };
                }
                color_vertices(&vertices, SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES);
                i += 7;
            }
            spec::draw_op::GLYPH_RUN if i + 3 <= words.len() => {
                let meta = words[i + 1];
                let slot = (meta & 0xff) as u8;
                let count = (meta >> 16) as usize;
                let next = i + 3 + count * 2;
                if next > words.len() {
                    break;
                }
                if let Some(&font) = fonts().get(&slot) {
                    let color = words[i + 2];
                    for k in 0..count {
                        let (x, y) = xy(words[i + 3 + k * 2]);
                        let gid = words[i + 4 + k * 2] & 0xffff;
                        if gid >= font.glyph_count as u32 {
                            continue;
                        }
                        let sx = (gid % font.cols) * font.coverage_w;
                        let sy = (gid / font.cols) * font.coverage_h;
                        // DrawList geometry remains logical. Source coverage is
                        // density-scaled, while the destination is always the
                        // logical cell multiplied by Vita's presentation scale.
                        // With density=2 and SCALE=2 these factors are exactly 1.
                        debug_assert_eq!(
                            font.coverage_w,
                            font.logical_w * font.raster_density as u32
                        );
                        debug_assert_eq!(
                            font.coverage_h,
                            font.logical_h * font.raster_density as u32
                        );
                        let coverage_scale = SCALE / font.raster_density as f32;
                        vita2d_draw_texture_tint_part_scale(
                            font.texture.ptr,
                            x,
                            y,
                            sx as f32,
                            sy as f32,
                            font.coverage_w as f32,
                            font.coverage_h as f32,
                            coverage_scale,
                            coverage_scale,
                            color,
                        );
                    }
                }
                i = next;
            }
            spec::draw_op::TEX_QUAD if i + 9 <= words.len() => {
                let handle = words[i + 1] as i32;
                if let Some(texture) = resolve_texture(ui, handle) {
                    let (x, y) = xy(words[i + 2]);
                    let (w, h) = wh(words[i + 3]);
                    let u0 = f32::from_bits(words[i + 4]);
                    let v0 = f32::from_bits(words[i + 5]);
                    let u1 = f32::from_bits(words[i + 6]);
                    let v1 = f32::from_bits(words[i + 7]);
                    let tw = (u1 - u0) * texture.w as f32;
                    let th = (v1 - v0) * texture.h as f32;
                    if tw > 0.0 && th > 0.0 {
                        vita2d_draw_texture_tint_part_scale(
                            texture.ptr,
                            x,
                            y,
                            u0 * texture.w as f32,
                            v0 * texture.h as f32,
                            tw,
                            th,
                            w / tw,
                            h / th,
                            words[i + 8],
                        );
                    }
                }
                i += 9;
            }
            spec::draw_op::TEX_TRI if i + 12 <= words.len() => {
                let handle = words[i + 1] as i32;
                if let Some(texture) = resolve_texture(ui, handle) {
                    let mut vertices = [vita2d_texture_vertex {
                        x: 0.0,
                        y: 0.0,
                        z: 0.5,
                        u: 0.0,
                        v: 0.0,
                    }; 3];
                    for (k, vertex) in vertices.iter_mut().enumerate() {
                        let o = i + 2 + k * 3;
                        let (x, y) = xy(words[o]);
                        *vertex = vita2d_texture_vertex {
                            x,
                            y,
                            z: 0.5,
                            u: f32::from_bits(words[o + 1]),
                            v: f32::from_bits(words[o + 2]),
                        };
                    }
                    texture_vertices(
                        texture.ptr,
                        &vertices,
                        SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
                        words[i + 11],
                    );
                }
                i += 12;
            }
            spec::draw_op::SCISSOR if i + 3 <= words.len() => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let rect = (x as i32, y as i32, w as i32, h as i32);
                scissors.push(rect);
                vita2d_set_clip_rectangle(rect.0, rect.1, rect.0 + rect.2, rect.1 + rect.3);
                vita2d_enable_clipping();
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                scissors.pop();
                if let Some(&(x, y, w, h)) = scissors.last() {
                    vita2d_set_clip_rectangle(x, y, x + w, y + h);
                } else {
                    vita2d_disable_clipping();
                }
                i += 1;
            }
            spec::draw_op::SURFACE_QUAD if i + 9 <= words.len() => {
                i += 9;
            }
            _ => break,
        }
    }
    vita2d_disable_clipping();
}

#[cfg(feature = "capture")]
fn validate_texture_residency(ui: &Ui, words: &[u32]) -> io::Result<()> {
    let mut i = 0usize;
    while i < words.len() {
        let next = match words[i] {
            spec::draw_op::RECT => i.checked_add(4),
            spec::draw_op::GRAD_RECT => i.checked_add(6),
            spec::draw_op::TRI => i.checked_add(7),
            spec::draw_op::GLYPH_RUN if i + 2 < words.len() => {
                let slot = (words[i + 1] & 0xff) as u8;
                if ui.font_atlas(slot).is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("DrawList references missing font atlas slot {slot}"),
                    ));
                }
                let resident = unsafe { fonts().contains_key(&slot) };
                if !resident {
                    return Err(io::Error::other(format!(
                        "Vita GPU font atlas slot {slot} was not resident after production rendering"
                    )));
                }
                let count = (words[i + 1] >> 16) as usize;
                i.checked_add(3 + count.saturating_mul(2))
            }
            spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI => {
                let op = words[i];
                let handle = *words.get(i + 1).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "truncated texture draw op")
                })? as i32;
                if ui.texture(handle).is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("DrawList references stale texture handle {handle}"),
                    ));
                }
                let resident = unsafe { textures().contains_key(&handle) };
                if !resident {
                    return Err(io::Error::other(format!(
                        "Vita GPU texture {handle} was not resident after production rendering"
                    )));
                }
                i.checked_add(if op == spec::draw_op::TEX_QUAD { 9 } else { 12 })
            }
            spec::draw_op::SCISSOR => i.checked_add(3),
            spec::draw_op::SCISSOR_POP => i.checked_add(1),
            spec::draw_op::SURFACE_QUAD => i.checked_add(9),
            op => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unknown DrawList op {op} at word {i}"),
                ));
            }
        }
        .filter(|next| *next <= words.len())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "truncated DrawList op"))?;
        i = next;
    }
    Ok(())
}

/// Render a deterministic golden directly at Vita's physical resolution.
/// Vita3K's Vulkan framebuffer is not read back: on current macOS builds that
/// surface is not coherent with guest CDRAM and produces black dumps. This
/// still runs the real Vita QuickJS/input/frame loop, while the CPU oracle
/// evaluates geometry, gradients, textures and density-aware font coverage at
/// the same 480x272 -> 960x544 integer presentation scale as production GXM.
#[cfg(feature = "capture")]
pub fn capture_golden(ui: &Ui, words: &[u32], path: &str) -> io::Result<()> {
    // The pixels below come from the deterministic CPU oracle because current
    // Vita3K/macOS GXM readback is black. Still verify that the production
    // renderer made every core texture and font atlas resident, so backend-
    // only omissions cannot hide behind a passing CPU golden.
    validate_texture_residency(ui, words)?;
    let mut pixels = vec![0u8; PHYSICAL_W as usize * PHYSICAL_H as usize * 4];
    pocketjs_core::raster::render_scaled(ui, words, &mut pixels, INTEGER_SCALE as u32);
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, pixels)
}
