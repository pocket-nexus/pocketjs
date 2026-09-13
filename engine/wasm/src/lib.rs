//! pocketjs-wasm — extern "C" mirror of the core op surface + software
//! rasterizer, for wasm32-unknown-unknown (no wasm-bindgen; the JS host talks
//! plain numbers + wasm linear memory).
//!
//! `pocketjs_core::raster` is the shared deterministic rasterizer (blend,
//! gradients, triangles, glyphs, textures). `ui_render()` keeps the byte-exact
//! legacy 480x272 path while `ui_render_scaled(scale)` rasterizes the same
//! logical DrawList directly onto an integer-scaled physical surface.
//!
//! ABI (all little-endian, one exported fn per spec::op code):
//!   - Strings/buffers cross via linear memory: the host calls
//!     `ui_alloc(len)`, writes bytes at the returned offset, passes
//!     (ptr, len), then `ui_free(ptr, len)`. UTF-8 for text.
//!   - `ui_render[_scaled]()` performs a compatibility full render.
//!     `ui_render_incremental[_scaled]()` retains the same RGBA8 framebuffer
//!     and repaints only changed regions. The returned pointer stays valid
//!     until the next render or init call on this instance.
//!   - Single-threaded by construction (one wasm instance per Ui).

#![allow(static_mut_refs)]
// single-threaded wasm instance; one global Ui
// Every (ptr, len) export dereferences a host-written linear-memory buffer;
// safety IS the ABI contract (ui_alloc/ui_free above), not a Rust signature.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use pocketjs_core::damage::{DamagePolicy, DamageTracker, DEFAULT_DAMAGE_REGIONS};
use pocketjs_core::Ui;

use pocketjs_core::raster;

static mut UI: Option<Ui> = None;
static mut FRAMEBUFFER: Vec<u8> = Vec::new();
use pocketjs_core::compositor::CompositorRaster;
static mut AUXILIARY_FRAMEBUFFER: Vec<u8> = Vec::new();

/// Browser System hosts upload visible child AppInstance framebuffers here.
/// Values are arbitrary-size RGBA rasters indexed by the shell's compositor
/// handle. They deliberately do not enter the pow2 guest image texture pool.
static mut COMPOSITOR_RASTERS: Vec<Option<CompositorRaster>> = Vec::new();
/// Staged compositor frame records. Each record is ten u32 words:
/// handle, full x/y/w/h f32 bits, clip x/y/w/h f32 bits, focused (0/1).
static mut COMPOSITOR_FRAMES: Vec<u32> = Vec::new();
static mut DAMAGE_TRACKER: DamageTracker<DEFAULT_DAMAGE_REGIONS> = DamageTracker::new();
/// wrapText result staging (same lifetime contract as FRAMEBUFFER: the
/// pointer from `ui_wrap_text_ptr` stays valid until the next wrapText or
/// init call on this instance).
static mut WRAP_BREAKS: Vec<u32> = Vec::new();

#[inline]
fn ui() -> &'static mut Ui {
    unsafe { UI.get_or_insert_with(Ui::new) }
}

/// Borrow (ptr, len) from wasm linear memory. Empty slice on null.
#[inline]
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len)
    }
}

/// Borrow (ptr, len) as UTF-8 (lossy inputs are rejected -> "").
#[inline]
unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    core::str::from_utf8(bytes(ptr, len)).unwrap_or("")
}

// ---- lifecycle -------------------------------------------------------------

/// Create (or reset) the Ui instance. `raster_density` controls core-owned
/// bitmap resources such as rounded-corner masks; zero is the legacy default
/// of one sample per logical pixel. Idempotent; call before anything else.
#[no_mangle]
pub extern "C" fn ui_init(raster_density: u32) {
    unsafe {
        UI = Some(Ui::new_with_raster_density(raster_density.max(1)));
        FRAMEBUFFER.clear();
        AUXILIARY_FRAMEBUFFER.clear();
        COMPOSITOR_RASTERS.clear();
        COMPOSITOR_FRAMES.clear();
        DAMAGE_TRACKER = DamageTracker::new();
    }
}

/// Resize the logical layout/draw viewport. Existing stock hosts never call
/// this and retain the legacy 480x272 contract.
#[no_mangle]
pub extern "C" fn ui_set_viewport(width: f32, height: f32) {
    ui().set_viewport(width, height);
}

#[no_mangle]
pub extern "C" fn ui_create_auxiliary_surface(width: f32, height: f32) -> i32 {
    if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 || width > 4096.0 || height > 4096.0 { return 0; }
    ui().create_auxiliary_surface(width, height)
}

#[no_mangle]
pub extern "C" fn ui_hit_test_auxiliary(x: f32, y: f32) -> i32 { ui().hit_test_auxiliary(x, y) }
#[no_mangle]
pub extern "C" fn ui_hit_test_bounds_auxiliary(x: f32, y: f32) -> i32 { ui().hit_test_bounds_auxiliary(x, y) }

struct AuxiliaryResources<'a>(&'a Ui);
impl pocketjs_core::resources::RenderResources for AuxiliaryResources<'_> {
    fn viewport(&self) -> (f32, f32) { self.0.auxiliary_viewport().unwrap() }
    fn raster_revision(&self) -> u64 { self.0.raster_revision() }
    fn texture(&self, handle: i32) -> Option<pocketjs_core::TexView<'_>> { self.0.texture(handle) }
    fn font_atlas(&self, slot: u8) -> Option<pocketjs_core::resources::FontView<'_>> {
        pocketjs_core::resources::RenderResources::font_atlas(self.0, slot)
    }
}

/// Auxiliary pixels share textures and frame time, with their own viewport.
#[no_mangle]
pub extern "C" fn ui_render_auxiliary() -> *const u8 {
    let u = ui();
    let Some((width, height)) = u.auxiliary_viewport() else { return core::ptr::null(); };
    let Some(draw) = u.draw_auxiliary() else { return core::ptr::null(); };
    let words = draw.words.clone();
    unsafe {
        AUXILIARY_FRAMEBUFFER.resize(width as usize * height as usize * 4, 0);
        raster::render(&AuxiliaryResources(u), &words, &mut AUXILIARY_FRAMEBUFFER);
        AUXILIARY_FRAMEBUFFER.as_ptr()
    }
}

/// Allocate `len` bytes of scratch in linear memory for host -> wasm buffers.
#[no_mangle]
pub extern "C" fn ui_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

/// Free a buffer previously returned by `ui_alloc` with the same `len`.
#[no_mangle]
pub extern "C" fn ui_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) };
    }
}

// ---- op mirror (see spec::op + docs/DESIGN.md "The native contract") -------------

#[no_mangle]
pub extern "C" fn ui_create_node(node_type: u32) -> i32 {
    ui().create_node(node_type as u8)
}

#[no_mangle]
pub extern "C" fn ui_destroy_node(id: i32) {
    ui().destroy_node(id)
}

#[no_mangle]
pub extern "C" fn ui_insert_before(parent: i32, child: i32, anchor: i32) {
    ui().insert_before(parent, child, anchor)
}

#[no_mangle]
pub extern "C" fn ui_remove_child(parent: i32, child: i32) {
    ui().remove_child(parent, child)
}

#[no_mangle]
pub extern "C" fn ui_set_style(id: i32, style_id: i32) {
    ui().set_style(id, style_id)
}

#[no_mangle]
pub extern "C" fn ui_set_prop(id: i32, prop: u32, value: f64) {
    ui().set_prop(id, prop as u8, value)
}

#[no_mangle]
pub extern "C" fn ui_set_text(id: i32, ptr: *const u8, len: usize) {
    ui().set_text(id, unsafe { text(ptr, len) })
}

#[no_mangle]
pub extern "C" fn ui_replace_text(id: i32, ptr: *const u8, len: usize) {
    ui().replace_text(id, unsafe { text(ptr, len) })
}

#[no_mangle]
pub extern "C" fn ui_upload_texture(ptr: *const u8, len: usize, w: u32, h: u32, psm: u32) -> i32 {
    ui().upload_texture(unsafe { bytes(ptr, len) }, w, h, psm)
}

/// Upload a self-contained IMG pak entry (spec op uploadImgEntry;
/// framework/compiler/pak.ts layout — v2 PSM_T8 palette + optional RLE + filter flags
/// parsed core-side). Returns the generation-tagged handle or -1.
#[no_mangle]
pub extern "C" fn ui_upload_img_entry(ptr: *const u8, len: usize) -> i32 {
    ui().upload_img_entry(unsafe { bytes(ptr, len) })
}

/// Release a texture slot (spec op freeTexture). Stale handles are no-ops;
/// anything still referencing the freed handle draws nothing.
/// (No tileset op here — wasm hosts stream tiles via the JS __pak fallback
/// and this entry point.)
#[no_mangle]
pub extern "C" fn ui_free_texture(handle: i32) {
    ui().free_texture(handle)
}

#[no_mangle]
pub extern "C" fn ui_set_image(id: i32, tex: i32) {
    ui().set_image(id, tex)
}

#[no_mangle]
pub extern "C" fn ui_set_compositor_surface(id: i32, surface: i32, focused: i32) {
    ui().set_compositor_surface(id, surface, focused != 0)
}

/// Replace one browser compositor surface's retained RGBA8 framebuffer.
/// This is a host-only wasm ABI: guest code can declare a surface binding,
/// but cannot upload or inspect another AppInstance's pixels.
#[no_mangle]
pub extern "C" fn ui_compositor_upload_surface(
    surface: u32,
    ptr: *const u8,
    len: usize,
    width: u32,
    height: u32,
) -> i32 {
    let Some(expected) = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
    else {
        return -1;
    };
    if width == 0 || height == 0 || expected != len {
        return -1;
    }
    let slot = surface as usize;
    unsafe {
        if COMPOSITOR_RASTERS.len() <= slot {
            COMPOSITOR_RASTERS.resize(slot + 1, None);
        }
        COMPOSITOR_RASTERS[slot] = Some(CompositorRaster {
            pixels: bytes(ptr, len).to_vec(),
            width,
            height,
            density: 1,
        });
        i32::try_from(surface).unwrap_or(-1)
    }
}

/// Release one retained browser compositor surface framebuffer.
#[no_mangle]
pub extern "C" fn ui_compositor_free_surface(surface: u32) {
    let slot = surface as usize;
    unsafe {
        COMPOSITOR_RASTERS.get_mut(slot).and_then(Option::take);
    }
}

/// Stage the shell's visible compositor frames in exact painter order.
#[no_mangle]
pub extern "C" fn ui_compositor_frames() -> u32 {
    let frames = ui().compositor_surface_frames();
    unsafe {
        COMPOSITOR_FRAMES.clear();
        COMPOSITOR_FRAMES.reserve(frames.len() * 10);
        for frame in frames {
            COMPOSITOR_FRAMES.extend_from_slice(&[
                frame.handle,
                frame.full[0].to_bits(),
                frame.full[1].to_bits(),
                frame.full[2].to_bits(),
                frame.full[3].to_bits(),
                frame.clip[0].to_bits(),
                frame.clip[1].to_bits(),
                frame.clip[2].to_bits(),
                frame.clip[3].to_bits(),
                u32::from(frame.focused),
            ]);
        }
        (COMPOSITOR_FRAMES.len() / 10) as u32
    }
}

/// Pointer to records staged by [`ui_compositor_frames`].
#[no_mangle]
pub extern "C" fn ui_compositor_frames_ptr() -> *const u32 {
    unsafe { COMPOSITOR_FRAMES.as_ptr() }
}

#[no_mangle]
pub extern "C" fn ui_set_sprite(id: i32, atlas: i32, frames: u32, cols: u32, step: u32) {
    ui().set_sprite(id, atlas, frames, cols, step)
}

#[no_mangle]
pub extern "C" fn ui_animate(
    id: i32,
    prop: u32,
    to: f64,
    dur_ms: u32,
    easing: u32,
    delay_ms: u32,
) -> i32 {
    ui().animate(id, prop as u8, to, dur_ms, easing as u8, delay_ms)
}

#[no_mangle]
pub extern "C" fn ui_cancel_anim(anim_id: i32) {
    ui().cancel_anim(anim_id)
}

#[no_mangle]
pub extern "C" fn ui_set_focus(id: i32) {
    ui().set_focus(id)
}

#[no_mangle]
pub extern "C" fn ui_set_active(id: i32, active: i32) {
    ui().set_active(id, active != 0)
}

// ---- virtual cursor ops (spec ops 27..29, input.cursor) ----------------------

#[no_mangle]
pub extern "C" fn ui_hit_test(x: f32, y: f32) -> i32 {
    ui().hit_test(x, y)
}

// ---- touch hit facts (spec op 42 hitTestBounds; docs/TOUCH.md) ---------------

#[no_mangle]
pub extern "C" fn ui_hit_test_bounds(x: f32, y: f32) -> i32 {
    ui().hit_test_bounds(x, y)
}

#[no_mangle]
pub extern "C" fn ui_set_cursor(tex: i32, hot_x: f32, hot_y: f32, w: f32, h: f32) {
    ui().set_cursor(tex, hot_x, hot_y, w, h)
}

#[no_mangle]
pub extern "C" fn ui_set_cursor_pos(x: f32, y: f32) {
    ui().set_cursor_pos(x, y)
}

#[no_mangle]
pub extern "C" fn ui_load_styles(ptr: *const u8, len: usize) -> i32 {
    ui().load_styles(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_load_font_atlas(ptr: *const u8, len: usize) -> i32 {
    ui().load_font_atlas(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_measure_text(ptr: *const u8, len: usize, font_slot: u32) -> f32 {
    ui().measure_text(unsafe { text(ptr, len) }, font_slot as u8)
}

/// OP wrapText: stage the soft-wrap break columns (ascending UTF-16 code
/// units) for one line under `max_w` px and return their count; the host
/// reads them from `ui_wrap_text_ptr` before its next wasm call.
#[no_mangle]
pub extern "C" fn ui_wrap_text(ptr: *const u8, len: usize, font_slot: u32, max_w: f32) -> u32 {
    let breaks = ui().wrap_text(unsafe { text(ptr, len) }, font_slot as u8, max_w);
    unsafe {
        WRAP_BREAKS = breaks;
        WRAP_BREAKS.len() as u32
    }
}

/// The staged wrapText columns (valid until the next wrapText/init call).
#[no_mangle]
pub extern "C" fn ui_wrap_text_ptr() -> *const u32 {
    unsafe { WRAP_BREAKS.as_ptr() }
}

// ---- frame ------------------------------------------------------------------

/// Advance one fixed-dt (1/60 s) frame: animations, then layout if dirty.
#[no_mangle]
pub extern "C" fn ui_tick() {
    ui().tick()
}

/// Return a deterministic content hash for the current DrawList without
/// rasterizing the framebuffer. Browser hosts use this as the same dirty
/// signal as pocket-widget's EmbeddedUi: a settled guest can keep ticking
/// while skipping the expensive software render and texture upload.
#[no_mangle]
pub extern "C" fn ui_draw_hash() -> u64 {
    draw_hash(&ui().draw().words)
}

fn draw_hash(words: &[u32]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for word in words {
        for byte in word.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

#[inline]
#[cfg(test)]
fn packed_xy(x: i32, y: i32) -> u32 {
    (x as i16 as u16 as u32) | ((y as i16 as u16 as u32) << 16)
}

#[inline]
#[cfg(test)]
fn packed_wh(width: i32, height: i32) -> u32 {
    (width as u16 as u32) | ((height as u16 as u32) << 16)
}

fn render_composited_words(ui: &Ui, words: &[u32], framebuffer: &mut [u8], scale: u32) {
    unsafe {
        pocketjs_core::compositor::render(ui, words, framebuffer, scale, &COMPOSITOR_RASTERS);
    }
}

// ---- DevTools ops (spec ops 18..22, docs/DEVTOOLS.md) -----------------------------

#[no_mangle]
pub extern "C" fn ui_debug_inspect(id: i32) {
    ui().debug_inspect(id)
}

#[no_mangle]
pub extern "C" fn ui_debug_rect_xy() -> i32 {
    ui().debug_rect_xy()
}

#[no_mangle]
pub extern "C" fn ui_debug_rect_wh() -> i32 {
    ui().debug_rect_wh()
}

#[no_mangle]
pub extern "C" fn ui_debug_pause(on: i32) {
    ui().debug_pause(on != 0)
}

#[no_mangle]
pub extern "C" fn ui_debug_step() {
    ui().debug_step()
}

fn render_at_scale(scale: u32) -> *const u8 {
    if !(1..=raster::MAX_RENDER_SCALE).contains(&scale) {
        return core::ptr::null();
    }
    let u = ui();
    let (viewport_w, viewport_h) = u.viewport();
    let logical_width = viewport_w as usize;
    let logical_height = viewport_h as usize;
    let Some(width) = logical_width.checked_mul(scale as usize) else {
        return core::ptr::null();
    };
    let Some(height) = logical_height.checked_mul(scale as usize) else {
        return core::ptr::null();
    };
    let Some(bytes) = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
    else {
        return core::ptr::null();
    };
    // draw() borrows `u` mutably for the returned &DrawList; the rasterizer
    // then needs a shared &Ui for atlases/textures. Both live in the single
    // static; nothing mutates during rasterization, and this module is
    // single-threaded by construction, so the raw-pointer reborrow is sound.
    let dl: *const pocketjs_core::DrawList = u.draw();
    let u_ref: &Ui = unsafe { &*(u as *const Ui) };
    unsafe {
        FRAMEBUFFER.resize(bytes, 0);
        if scale == 1 {
            raster::render(u_ref, &(*dl).words, &mut FRAMEBUFFER);
        } else {
            raster::render_scaled(u_ref, &(*dl).words, &mut FRAMEBUFFER, scale);
        }
        // A compatibility full render changed the retained framebuffer
        // outside the incremental tracker's plan/commit transaction.
        DAMAGE_TRACKER.invalidate();
        FRAMEBUFFER.as_ptr()
    }
}

fn render_composited_at_scale(scale: u32) -> *const u8 {
    if !(1..=raster::MAX_RENDER_SCALE).contains(&scale) {
        return core::ptr::null();
    }
    let u = ui();
    let (viewport_w, viewport_h) = u.viewport();
    let Some(bytes) = (viewport_w as usize)
        .checked_mul(scale as usize)
        .and_then(|width| {
            (viewport_h as usize)
                .checked_mul(scale as usize)
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
    else {
        return core::ptr::null();
    };
    let dl: *const pocketjs_core::DrawList = u.draw();
    let u_ref: &Ui = unsafe { &*(u as *const Ui) };
    unsafe {
        FRAMEBUFFER.resize(bytes, 0);
        render_composited_words(u_ref, &(*dl).words, &mut FRAMEBUFFER, scale);
        DAMAGE_TRACKER.invalidate();
        FRAMEBUFFER.as_ptr()
    }
}

fn render_incremental_at_scale(scale: u32) -> *const u8 {
    if !(1..=raster::MAX_RENDER_SCALE).contains(&scale) {
        return core::ptr::null();
    }
    let u = ui();
    let (viewport_w, viewport_h) = u.viewport();
    let logical_width = viewport_w as usize;
    let logical_height = viewport_h as usize;
    let Some(width) = logical_width.checked_mul(scale as usize) else {
        return core::ptr::null();
    };
    let Some(height) = logical_height.checked_mul(scale as usize) else {
        return core::ptr::null();
    };
    let Some(bytes) = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
    else {
        return core::ptr::null();
    };
    let dl: *const pocketjs_core::DrawList = u.draw();
    let u_ref: &Ui = unsafe { &*(u as *const Ui) };
    unsafe {
        FRAMEBUFFER.resize(bytes, 0);
        if raster::render_scaled_incremental(
            u_ref,
            &(*dl).words,
            &mut FRAMEBUFFER,
            scale,
            &mut DAMAGE_TRACKER,
            DamagePolicy::default(),
        )
        .is_err()
        {
            raster::render_scaled(u_ref, &(*dl).words, &mut FRAMEBUFFER, scale);
            DAMAGE_TRACKER.invalidate();
        }
        FRAMEBUFFER.as_ptr()
    }
}

/// Rasterize the current tree and return the byte-exact RGBA8 framebuffer
/// pointer at the logical viewport size. Kept as a dedicated ABI entry for
/// existing hosts.
#[no_mangle]
pub extern "C" fn ui_render() -> *const u8 {
    render_at_scale(1)
}

/// Rasterize directly at an integer physical scale (currently 1 through 4).
/// Returns null for an unsupported scale.
#[no_mangle]
pub extern "C" fn ui_render_scaled(scale: u32) -> *const u8 {
    render_at_scale(scale)
}

/// Rasterize the shell with retained child AppInstance framebuffers inserted
/// at SURFACE_QUAD painter positions.
#[no_mangle]
pub extern "C" fn ui_render_composited() -> *const u8 {
    render_composited_at_scale(1)
}

/// Integer-scaled equivalent of [`ui_render_composited`].
#[no_mangle]
pub extern "C" fn ui_render_composited_scaled(scale: u32) -> *const u8 {
    render_composited_at_scale(scale)
}

/// Incrementally rasterize at the logical viewport size.
#[no_mangle]
pub extern "C" fn ui_render_incremental() -> *const u8 {
    render_incremental_at_scale(1)
}

/// Incrementally rasterize at an integer physical scale (1 through 4).
#[no_mangle]
pub extern "C" fn ui_render_incremental_scaled(scale: u32) -> *const u8 {
    render_incremental_at_scale(scale)
}

#[cfg(test)]
mod tests {
    use super::{
        draw_hash, packed_wh, packed_xy, render_composited_words, CompositorRaster,
        COMPOSITOR_RASTERS,
    };
    use pocketjs_core::{spec, Ui};

    #[test]
    fn draw_hash_is_stable_and_content_sensitive() {
        let words = [0x0102_0304, 0x0506_0708];
        assert_eq!(draw_hash(&words), draw_hash(&words));
        assert_ne!(draw_hash(&words), draw_hash(&[0x0102_0304, 0x0506_0709]));
        assert_ne!(draw_hash(&[]), draw_hash(&words));
    }

    #[test]
    fn shared_compositor_preserves_child_pixels_at_two_densities() {
        for density in [1, 2] {
            let mut ui = Ui::new();
            ui.set_viewport(2.0, 1.0);
            let pixels: Vec<u8> = (0..2 * density * density)
                .flat_map(|i| [i as u8 * 20, 40, 80, 255])
                .collect();
            let surfaces = [
                None,
                Some(CompositorRaster {
                    pixels: pixels.clone(),
                    width: 2,
                    height: 1,
                    density,
                }),
            ];
            let words = [
                spec::draw_op::SURFACE_QUAD,
                1,
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                2.0f32.to_bits(),
                1.0f32.to_bits(),
                packed_xy(0, 0),
                packed_wh(2, 1),
                1,
            ];
            let mut framebuffer = vec![0; pixels.len()];
            pocketjs_core::compositor::render(&ui, &words, &mut framebuffer, density, &surfaces);
            assert_eq!(framebuffer, pixels);
        }
    }

    #[test]
    fn browser_compositor_keeps_child_between_shell_ops() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 4.0);
        let red = [255u8, 0, 0, 255].repeat(6);
        unsafe {
            COMPOSITOR_RASTERS = vec![
                None,
                Some(CompositorRaster {
                    pixels: red,
                    width: 3,
                    height: 2,
                    density: 1,
                }),
            ];
        }
        let words = [
            spec::draw_op::RECT,
            packed_xy(0, 0),
            packed_wh(4, 4),
            0xffff_0000,
            spec::draw_op::SCISSOR,
            packed_xy(0, 0),
            packed_wh(2, 2),
            spec::draw_op::SURFACE_QUAD,
            1,
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            3.0f32.to_bits(),
            2.0f32.to_bits(),
            packed_xy(0, 0),
            packed_wh(2, 2),
            1,
            spec::draw_op::RECT,
            packed_xy(1, 1),
            packed_wh(2, 2),
            0xff00_ff00,
            spec::draw_op::SCISSOR_POP,
        ];
        let mut framebuffer = vec![0; 4 * 4 * 4];
        render_composited_words(&ui, &words, &mut framebuffer, 1);
        assert_eq!(&framebuffer[0..4], &[255, 0, 0, 255]);
        let center = (1 * 4 + 1) * 4;
        assert_eq!(&framebuffer[center..center + 4], &[0, 255, 0, 255]);
        let outside = 2 * 4;
        assert_eq!(&framebuffer[outside..outside + 4], &[0, 0, 255, 255]);
        let clipped_overlay = (2 * 4 + 2) * 4;
        assert_eq!(
            &framebuffer[clipped_overlay..clipped_overlay + 4],
            &[0, 0, 255, 255]
        );
    }
}
