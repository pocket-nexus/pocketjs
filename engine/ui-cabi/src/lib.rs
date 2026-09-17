//! Native C ABI for PocketJS's retained UI core, GLES1/GLES2 DrawList backend,
//! and deterministic software rasterizer.
//!
//! The platform host owns QuickJS and calls this library synchronously from its
//! UI thread. There is exactly one `Ui` instance. Strings and blobs are borrowed
//! as `(ptr, len)` for the duration of a call and copied by the core whenever
//! they must outlive it.
//!
//! The host owns the graphics context and calls the GLES entry points only
//! while it is current. The software capture entry points return tightly
//! packed, top-left-origin ARGB32 pixels; those pointers remain valid until
//! the next capture, viewport change, init, or shutdown call.

#![cfg_attr(any(target_os = "none", feature = "bare-platform"), no_std)]
#![cfg_attr(
    any(target_os = "none", feature = "bare-platform"),
    feature(alloc_error_handler)
)]
#![allow(static_mut_refs)]
#![allow(clippy::not_unsafe_ptr_arg_deref)]

extern crate alloc;

use alloc::vec::Vec;
#[cfg(any(target_os = "none", feature = "bare-platform"))]
use core::alloc::{GlobalAlloc, Layout};
#[cfg(any(target_os = "none", feature = "bare-platform"))]
use core::ffi::c_void;
use pocketjs_core::damage::{DamagePolicy, DamageTracker, DEFAULT_DAMAGE_REGIONS};
use pocketjs_core::raster;
use pocketjs_core::Ui;

pub mod extension;
#[cfg(all(
    any(target_os = "none", feature = "bare-platform", test),
    not(feature = "software-only")
))]
mod gl;

/// `malloc` and the supported host allocator ABIs provide `max_align_t`
/// storage: 16 bytes on their 64-bit targets and 8 on 32-bit ARM. Core texture
/// storage uses `Vec<u128>`, so rejecting that natural alignment makes every
/// texture allocation fail on a 64-bit C host.
#[cfg(any(target_os = "none", feature = "bare-platform", test))]
const C_MALLOC_ALIGNMENT: usize = if cfg!(target_pointer_width = "64") {
    16
} else {
    8
};

#[cfg(any(target_os = "none", feature = "bare-platform", test))]
#[inline]
const fn c_allocator_supports_alignment(alignment: usize) -> bool {
    alignment <= C_MALLOC_ALIGNMENT
}

#[cfg(all(
    any(target_os = "none", feature = "bare-platform"),
    not(feature = "host-allocator")
))]
unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
}

#[cfg(all(
    any(target_os = "none", feature = "bare-platform"),
    feature = "host-allocator"
))]
unsafe extern "C" {
    /// Must return storage aligned to at least `C_MALLOC_ALIGNMENT`.
    fn pocket_host_alloc(size: usize) -> *mut c_void;
    /// Must preserve alignment of the original allocation.
    fn pocket_host_realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn pocket_host_free(ptr: *mut c_void);
}

#[cfg(any(target_os = "none", feature = "bare-platform"))]
unsafe extern "C" {
    fn abort() -> !;
}

#[cfg(feature = "boot-stage")]
unsafe extern "C" {
    fn pocket_host_boot_stage(stage: i32);
}

#[inline]
fn report_boot_stage(stage: i32) {
    #[cfg(feature = "boot-stage")]
    unsafe {
        pocket_host_boot_stage(stage);
    }
    #[cfg(not(feature = "boot-stage"))]
    let _ = stage;
}

#[cfg(any(target_os = "none", feature = "bare-platform"))]
struct CAllocator;

#[cfg(any(target_os = "none", feature = "bare-platform"))]
unsafe impl GlobalAlloc for CAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !c_allocator_supports_alignment(layout.align()) {
            return core::ptr::null_mut();
        }
        #[cfg(feature = "host-allocator")]
        return pocket_host_alloc(layout.size().max(1)).cast();
        #[cfg(not(feature = "host-allocator"))]
        return malloc(layout.size().max(1)).cast();
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        #[cfg(feature = "host-allocator")]
        pocket_host_free(ptr.cast());
        #[cfg(not(feature = "host-allocator"))]
        free(ptr.cast());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if !c_allocator_supports_alignment(layout.align()) {
            return core::ptr::null_mut();
        }
        #[cfg(feature = "host-allocator")]
        return pocket_host_realloc(ptr.cast(), size.max(1)).cast();
        #[cfg(not(feature = "host-allocator"))]
        return realloc(ptr.cast(), size.max(1)).cast();
    }
}

#[cfg(any(target_os = "none", feature = "bare-platform"))]
#[global_allocator]
static ALLOCATOR: CAllocator = CAllocator;

#[cfg(any(target_os = "none", feature = "bare-platform"))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { abort() }
}

#[cfg(any(target_os = "none", feature = "bare-platform"))]
#[alloc_error_handler]
fn allocation_error(_layout: Layout) -> ! {
    unsafe { abort() }
}

static mut UI: Option<Ui> = None;
static mut FRAMEBUFFER: Vec<u8> = Vec::new();
static mut DAMAGE_TRACKER: DamageTracker<DEFAULT_DAMAGE_REGIONS> = DamageTracker::new();
/// wrapText result staging (FRAMEBUFFER lifetime contract: valid until the
/// next wrapText or init call).
static mut WRAP_BREAKS: Vec<u32> = Vec::new();
/*
 * Damage statistics for the incremental raster path.
 *
 * These exist because the failure mode they describe is invisible without
 * them: when damage planning returns Err the renderer quietly draws a complete
 * frame, and a per-frame failure is then indistinguishable from the machine
 * simply being slow. `failures` counts planning that FAILED; `full_redraws`
 * counts a plan that legitimately chose to cover everything.
 */
static mut DAMAGE_ATTEMPTS: u64 = 0;
static mut DAMAGE_FAILURES: u64 = 0;
static mut DAMAGE_FULL_REDRAWS: u64 = 0;
static mut DAMAGE_REGIONS: u32 = 0;
static mut DAMAGE_PIXELS: u64 = 0;
static mut DAMAGE_BOUNDS: [i32; 4] = [0, 0, 0, 0];
static mut FRAMEBUFFER_WIDTH: u32 = 0;
static mut FRAMEBUFFER_HEIGHT: u32 = 0;
static mut FRAMEBUFFER_STRIDE: u32 = 0;

/// Stock cores have no application-specific native surface. A custom static
/// library depends on this crate with default features disabled and exports
/// the same symbol with its versioned callback table.
#[cfg(feature = "standalone-extension-provider")]
#[no_mangle]
pub extern "C" fn pocketjs_symbian_extension_v1() -> *const extension::ExtensionV1 {
    core::ptr::null()
}

#[inline]
fn ui() -> &'static mut Ui {
    unsafe { UI.get_or_insert_with(Ui::new) }
}

/// Run `f` against an already initialized C ABI `Ui` singleton.
///
/// In-process harness crates enable `harness-access` to inspect DrawList words
/// or replay mutations against the same core instance as the C guest runtime.
/// Returns `None` before `ui_init` or after `ui_shutdown`; it never creates an
/// implicit replacement instance.
///
/// # Safety
///
/// The caller must ensure there is no concurrent or reentrant UI access, must
/// not call any `ui_*` C ABI function from `f`, and must prevent `ui_init` and
/// `ui_shutdown` for the duration of the closure. Violating these requirements
/// can alias the mutable borrow or drop the borrowed value.
#[cfg(feature = "harness-access")]
pub unsafe fn with_initialized_ui_unchecked<R>(f: impl FnOnce(&mut Ui) -> R) -> Option<R> {
    unsafe { UI.as_mut().map(f) }
}

#[inline]
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len)
    }
}

#[inline]
unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    core::str::from_utf8(bytes(ptr, len)).unwrap_or("")
}

#[inline]
fn read_f64_le(record: &[u8], offset: usize) -> f64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&record[offset..offset + 8]);
    f64::from_le_bytes(raw)
}

fn clear_framebuffer() {
    unsafe {
        FRAMEBUFFER.clear();
        DAMAGE_TRACKER = DamageTracker::new();
        FRAMEBUFFER_WIDTH = 0;
        FRAMEBUFFER_HEIGHT = 0;
        FRAMEBUFFER_STRIDE = 0;
    }
}

// ---- lifecycle and transfer buffers ---------------------------------------

/// Reset the single UI instance. `raster_density == 0` selects density 1.
#[no_mangle]
pub extern "C" fn ui_init(raster_density: u32) {
    report_boot_stage(101);
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        // This call may happen without a current GL context, so the backend
        // only marks its caches stale and defers replacement until render.
        gl::invalidate_resources();
    }
    unsafe {
        UI = Some(Ui::new_with_raster_density(raster_density.max(1)));
    }
    report_boot_stage(102);
    clear_framebuffer();
    report_boot_stage(103);
}

/// Drop all retained UI, texture, font, and framebuffer allocations.
#[no_mangle]
pub extern "C" fn ui_shutdown() {
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        gl::invalidate_resources();
    }
    unsafe {
        UI = None;
    }
    clear_framebuffer();
}

/// Set the host's logical viewport. Dynamic-window hosts update it whenever
/// their client area changes; fixed-screen hosts set it once during boot.
#[no_mangle]
pub extern "C" fn ui_set_viewport(width: f32, height: f32) {
    ui().set_viewport(width, height);
    clear_framebuffer();
}

#[no_mangle]
pub extern "C" fn ui_viewport_width() -> u32 {
    ui().viewport().0 as u32
}

#[no_mangle]
pub extern "C" fn ui_viewport_height() -> u32 {
    ui().viewport().1 as u32
}

/// Optional C-side scratch allocation. The caller must release it with the
/// exact same `len`; ordinary borrowed HostOps arguments do not need this.
#[no_mangle]
pub extern "C" fn ui_alloc(len: usize) -> *mut u8 {
    let mut value = Vec::<u8>::with_capacity(len.max(1));
    let ptr = value.as_mut_ptr();
    core::mem::forget(value);
    ptr
}

#[no_mangle]
pub extern "C" fn ui_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
        }
    }
}

// ---- HostOps core ----------------------------------------------------------

#[no_mangle]
pub extern "C" fn ui_create_node(node_type: u32) -> i32 {
    ui().create_node(node_type as u8)
}

#[no_mangle]
pub extern "C" fn ui_destroy_node(id: i32) {
    ui().destroy_node(id);
}

#[no_mangle]
pub extern "C" fn ui_insert_before(parent: i32, child: i32, anchor: i32) {
    ui().insert_before(parent, child, anchor);
}

#[no_mangle]
pub extern "C" fn ui_remove_child(parent: i32, child: i32) {
    ui().remove_child(parent, child);
}

#[no_mangle]
pub extern "C" fn ui_set_style(id: i32, style_id: i32) {
    ui().set_style(id, style_id);
}

#[no_mangle]
pub extern "C" fn ui_set_prop(id: i32, prop: u32, value: f64) {
    ui().set_prop(id, prop as u8, value);
}

/// Apply packed little-endian Float64 triples `[nodeId, propId, value]`.
/// A trailing partial record is ignored.
#[no_mangle]
pub extern "C" fn ui_set_prop_batch(ptr: *const u8, len: usize) {
    let (records, _) = unsafe { bytes(ptr, len) }.as_chunks::<24>();
    let instance = ui();
    for record in records {
        instance.set_prop(
            read_f64_le(record, 0) as i32,
            read_f64_le(record, 8) as u8,
            read_f64_le(record, 16),
        );
    }
}

#[no_mangle]
pub extern "C" fn ui_set_text(id: i32, ptr: *const u8, len: usize) {
    ui().set_text(id, unsafe { text(ptr, len) });
}

#[no_mangle]
pub extern "C" fn ui_replace_text(id: i32, ptr: *const u8, len: usize) {
    ui().replace_text(id, unsafe { text(ptr, len) });
}

#[no_mangle]
pub extern "C" fn ui_upload_texture(
    ptr: *const u8,
    len: usize,
    width: u32,
    height: u32,
    psm: u32,
) -> i32 {
    ui().upload_texture(unsafe { bytes(ptr, len) }, width, height, psm)
}

#[no_mangle]
pub extern "C" fn ui_upload_img_entry(ptr: *const u8, len: usize) -> i32 {
    ui().upload_img_entry(unsafe { bytes(ptr, len) })
}

/// Decode one tile from a complete TILESET pak entry.
#[no_mangle]
pub extern "C" fn ui_upload_tileset_tile(ptr: *const u8, len: usize, index: u32) -> i32 {
    ui().upload_tileset_tile(unsafe { bytes(ptr, len) }, index)
}

#[no_mangle]
pub extern "C" fn ui_update_texture_t8(
    handle: i32,
    palette_ptr: *const u8,
    palette_len: usize,
    pixels_ptr: *const u8,
    pixels_len: usize,
) -> i32 {
    ui().update_texture_t8(handle, unsafe { bytes(palette_ptr, palette_len) }, unsafe {
        bytes(pixels_ptr, pixels_len)
    }) as i32
}

#[no_mangle]
pub extern "C" fn ui_free_texture(handle: i32) {
    ui().free_texture(handle);
}

#[no_mangle]
pub extern "C" fn ui_set_image(id: i32, texture: i32) {
    ui().set_image(id, texture);
}

#[no_mangle]
pub extern "C" fn ui_set_sprite(id: i32, atlas: i32, frames: u32, columns: u32, step: u32) {
    ui().set_sprite(id, atlas, frames, columns, step);
}

#[no_mangle]
pub extern "C" fn ui_animate(
    id: i32,
    prop: u32,
    to: f64,
    duration_ms: u32,
    easing: u32,
    delay_ms: u32,
) -> i32 {
    ui().animate(id, prop as u8, to, duration_ms, easing as u8, delay_ms)
}

#[no_mangle]
pub extern "C" fn ui_cancel_anim(animation_id: i32) {
    ui().cancel_anim(animation_id);
}

#[no_mangle]
pub extern "C" fn ui_set_focus(id: i32) {
    ui().set_focus(id);
}

#[no_mangle]
pub extern "C" fn ui_set_active(id: i32, active: i32) {
    ui().set_active(id, active != 0);
}

#[no_mangle]
pub extern "C" fn ui_hit_test(x: f32, y: f32) -> i32 {
    ui().hit_test(x, y)
}

#[no_mangle]
pub extern "C" fn ui_hit_test_bounds(x: f32, y: f32) -> i32 {
    ui().hit_test_bounds(x, y)
}

#[no_mangle]
pub extern "C" fn ui_set_cursor(texture: i32, hot_x: f32, hot_y: f32, width: f32, height: f32) {
    ui().set_cursor(texture, hot_x, hot_y, width, height);
}

#[no_mangle]
pub extern "C" fn ui_set_cursor_pos(x: f32, y: f32) {
    ui().set_cursor_pos(x, y);
}

#[no_mangle]
pub extern "C" fn ui_load_styles(ptr: *const u8, len: usize) -> i32 {
    ui().load_styles(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_load_font_atlas(ptr: *const u8, len: usize) -> i32 {
    let blob = unsafe { bytes(ptr, len) };
    let loaded = ui().load_font_atlas(blob);
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    if loaded {
        if let Some(&slot) = blob.get(12) {
            unsafe {
                // Loading happens in a host callback, not necessarily with
                // QGLWidget's context current. Defer GL deletion/re-upload.
                gl::invalidate_font(slot);
            }
        }
    }
    loaded as i32
}

#[no_mangle]
pub extern "C" fn ui_measure_text(ptr: *const u8, len: usize, font_slot: u32) -> f32 {
    ui().measure_text(unsafe { text(ptr, len) }, font_slot as u8)
}

/// OP wrapText: stage the soft-wrap break columns (ascending UTF-16 code
/// units) for one line under `max_w` px and return their count; the host
/// reads them from `ui_wrap_text_ptr` before its next call.
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

// ---- fixed-step frame and DevTools ----------------------------------------

#[no_mangle]
pub extern "C" fn ui_tick() {
    ui().tick();
}

#[no_mangle]
pub extern "C" fn ui_gl_initialize() -> i32 {
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        return gl::initialize() as i32;
    }
    #[cfg(any(
        feature = "software-only",
        not(any(target_os = "none", feature = "bare-platform"))
    ))]
    0
}

#[no_mangle]
pub extern "C" fn ui_gl_reset_resources() {
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        gl::reset_resources();
    }
}

#[no_mangle]
pub extern "C" fn ui_gl_shutdown() {
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        gl::shutdown();
    }
}

#[no_mangle]
pub extern "C" fn ui_gl_set_trace(callback: Option<extern "C" fn(u32, u32, u32)>) {
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        gl::set_trace(callback);
    }
    #[cfg(any(
        feature = "software-only",
        not(any(target_os = "none", feature = "bare-platform"))
    ))]
    let _ = callback;
}

#[no_mangle]
pub extern "C" fn ui_gl_render(
    target_x: i32,
    target_y: i32,
    target_width: i32,
    target_height: i32,
    window_width: i32,
    window_height: i32,
) -> i32 {
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        return gl::render(
            ui(),
            target_x,
            target_y,
            target_width,
            target_height,
            window_width,
            window_height,
        ) as i32;
    }
    #[cfg(any(
        feature = "software-only",
        not(any(target_os = "none", feature = "bare-platform"))
    ))]
    {
        let _ = (
            target_x,
            target_y,
            target_width,
            target_height,
            window_width,
            window_height,
        );
        0
    }
}

/// Draw the retained UI over an application-owned color buffer. Native 3D
/// extensions render and clear first; this pass preserves their color output
/// while the backend disables depth testing for the HUD.
#[no_mangle]
pub extern "C" fn ui_gl_render_over(
    target_x: i32,
    target_y: i32,
    target_width: i32,
    target_height: i32,
    window_width: i32,
    window_height: i32,
) -> i32 {
    #[cfg(all(
        any(target_os = "none", feature = "bare-platform"),
        not(feature = "software-only")
    ))]
    unsafe {
        return gl::render_over(
            ui(),
            target_x,
            target_y,
            target_width,
            target_height,
            window_width,
            window_height,
        ) as i32;
    }
    #[cfg(any(
        feature = "software-only",
        not(any(target_os = "none", feature = "bare-platform"))
    ))]
    {
        let _ = (
            target_x,
            target_y,
            target_width,
            target_height,
            window_width,
            window_height,
        );
        0
    }
}

#[no_mangle]
pub extern "C" fn ui_draw_hash() -> u64 {
    draw_hash(&ui().draw().words)
}

fn draw_hash(words: &[u32]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for word in words {
        for byte in word.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

#[no_mangle]
pub extern "C" fn ui_debug_inspect(id: i32) {
    ui().debug_inspect(id);
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
    ui().debug_pause(on != 0);
}

#[no_mangle]
pub extern "C" fn ui_debug_step() {
    ui().debug_step();
}

// ---- top-left BGRA bytes / ARGB32 words framebuffer -----------------------

fn framebuffer_geometry(instance: &Ui, scale: u32) -> Option<(usize, usize, usize)> {
    if !(1..=raster::MAX_RENDER_SCALE).contains(&scale) {
        return None;
    }
    let (logical_width, logical_height) = instance.viewport();
    let width = (logical_width as usize).checked_mul(scale as usize)?;
    let height = (logical_height as usize).checked_mul(scale as usize)?;
    let byte_len = width.checked_mul(height)?.checked_mul(4)?;
    Some((width, height, byte_len))
}

fn remember_framebuffer_geometry(width: usize, height: usize) {
    unsafe {
        FRAMEBUFFER_WIDTH = width as u32;
        FRAMEBUFFER_HEIGHT = height as u32;
        FRAMEBUFFER_STRIDE = (width * 4) as u32;
    }
}

fn render_at_scale(scale: u32, incremental: bool) -> *const u8 {
    let instance = ui();
    let Some((width, height, byte_len)) = framebuffer_geometry(instance, scale) else {
        return core::ptr::null();
    };
    let draw_list: *const pocketjs_core::DrawList = instance.draw();
    let instance_ref: &Ui = unsafe { &*(instance as *const Ui) };

    unsafe {
        if FRAMEBUFFER.len() != byte_len {
            FRAMEBUFFER.resize(byte_len, 0);
            DAMAGE_TRACKER.invalidate();
        }

        if incremental {
            DAMAGE_ATTEMPTS = DAMAGE_ATTEMPTS.wrapping_add(1);
            match raster::render_scaled_argb_incremental(
                instance_ref,
                &(*draw_list).words,
                &mut FRAMEBUFFER,
                scale,
                &mut DAMAGE_TRACKER,
                DamagePolicy::default(),
            ) {
                Ok(plan) => {
                    // The plan is the only evidence that damage is doing
                    // anything. Discarding it is what made a per-frame
                    // full-redraw regression indistinguishable from a slow
                    // machine, so record it instead.
                    let bounds = plan.bounds();
                    DAMAGE_REGIONS = plan.region_count() as u32;
                    DAMAGE_PIXELS = plan.area();
                    DAMAGE_BOUNDS = [bounds.x0, bounds.y0, bounds.x1, bounds.y1];
                    if plan.is_full_redraw() {
                        DAMAGE_FULL_REDRAWS = DAMAGE_FULL_REDRAWS.wrapping_add(1);
                    }
                }
                Err(_) => {
                    // Silent fallback to a complete frame. Counted separately
                    // from a policy-chosen full redraw, because this one means
                    // damage planning FAILED.
                    DAMAGE_FAILURES = DAMAGE_FAILURES.wrapping_add(1);
                    DAMAGE_REGIONS = 0;
                    DAMAGE_PIXELS = (width as u64) * (height as u64);
                    DAMAGE_BOUNDS = [0, 0, width as i32, height as i32];
                    raster::render_scaled_argb(
                        instance_ref,
                        &(*draw_list).words,
                        &mut FRAMEBUFFER,
                        scale,
                    );
                    DAMAGE_TRACKER.invalidate();
                }
            }
        } else {
            raster::render_scaled_argb(instance_ref, &(*draw_list).words, &mut FRAMEBUFFER, scale);
            DAMAGE_TRACKER.invalidate();
            DAMAGE_REGIONS = 0;
            DAMAGE_PIXELS = (width as u64) * (height as u64);
            DAMAGE_BOUNDS = [0, 0, width as i32, height as i32];
        }

        remember_framebuffer_geometry(width, height);
        FRAMEBUFFER.as_ptr()
    }
}

/// Incremental-raster statistics, so a host can tell a working damage plan
/// from a silent per-frame fallback. Counts are cumulative; the region,
/// pixel and bounds values describe the most recent frame.
#[no_mangle]
pub extern "C" fn ui_damage_attempts() -> u64 {
    unsafe { DAMAGE_ATTEMPTS }
}

/// Times damage planning returned an error and a complete frame was drawn.
#[no_mangle]
pub extern "C" fn ui_damage_failures() -> u64 {
    unsafe { DAMAGE_FAILURES }
}

/// Times a successful plan covered the whole target by policy.
#[no_mangle]
pub extern "C" fn ui_damage_full_redraws() -> u64 {
    unsafe { DAMAGE_FULL_REDRAWS }
}

/// Regions in the most recent plan; 0 means nothing changed.
#[no_mangle]
pub extern "C" fn ui_damage_regions() -> u32 {
    unsafe { DAMAGE_REGIONS }
}

/// Logical pixels the most recent plan covers.
#[no_mangle]
pub extern "C" fn ui_damage_pixels() -> u64 {
    unsafe { DAMAGE_PIXELS }
}

/// Union bounds of the most recent plan, packed x0,y0,x1,y1 into the caller's
/// four ints. Half-open, logical pixels, top-left origin — the same space the
/// DrawList uses. Returns 0 when the plan is empty.
#[no_mangle]
pub extern "C" fn ui_damage_bounds(out: *mut i32) -> i32 {
    if out.is_null() {
        return 0;
    }
    unsafe {
        let bounds = DAMAGE_BOUNDS;
        for (index, value) in bounds.iter().enumerate() {
            *out.add(index) = *value;
        }
        i32::from(bounds[2] > bounds[0] && bounds[3] > bounds[1])
    }
}

/// Full ARGB32 render at the logical viewport size.
#[no_mangle]
pub extern "C" fn ui_render() -> *const u8 {
    render_at_scale(1, false)
}

#[no_mangle]
pub extern "C" fn ui_render_scaled(scale: u32) -> *const u8 {
    render_at_scale(scale, false)
}

#[no_mangle]
pub extern "C" fn ui_render_incremental() -> *const u8 {
    render_at_scale(1, true)
}

#[no_mangle]
pub extern "C" fn ui_render_incremental_scaled(scale: u32) -> *const u8 {
    render_at_scale(scale, true)
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_width() -> u32 {
    unsafe { FRAMEBUFFER_WIDTH }
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_height() -> u32 {
    unsafe { FRAMEBUFFER_HEIGHT }
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_stride() -> u32 {
    unsafe { FRAMEBUFFER_STRIDE }
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_len() -> usize {
    unsafe { FRAMEBUFFER.len() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketjs_core::spec;

    #[test]
    fn c_allocator_supports_core_texture_alignment() {
        assert!(c_allocator_supports_alignment(1));
        assert!(c_allocator_supports_alignment(core::mem::align_of::<u128>()));
        assert!(c_allocator_supports_alignment(C_MALLOC_ALIGNMENT));
        assert!(!c_allocator_supports_alignment(C_MALLOC_ALIGNMENT * 2));
    }

    #[test]
    fn hash_is_stable_and_argb_framebuffer_matches_qimage_layout() {
        let words = [0x0102_0304, 0x0506_0708];
        assert_eq!(draw_hash(&words), draw_hash(&words));
        assert_ne!(draw_hash(&words), draw_hash(&[0x0102_0304, 0x0506_0709]));

        #[cfg(feature = "harness-access")]
        assert!(unsafe { with_initialized_ui_unchecked(|_| ()) }.is_none());
        ui_init(1);
        ui_set_viewport(2.0, 1.0);
        #[cfg(feature = "harness-access")]
        assert_eq!(
            unsafe { with_initialized_ui_unchecked(|ui| ui.viewport()) },
            Some((2.0, 1.0)),
        );
        // This unit test uses Rust's default allocator. The linked C fixture in
        // tests/ui-cabi-allocator.test.ts covers the bare-platform CAllocator.
        let pixel = [0xff, 0x00, 0x00, 0xff];
        assert!(ui_upload_texture(
            pixel.as_ptr(),
            pixel.len(),
            1,
            1,
            spec::psm::PSM_8888 as u32,
        ) >= 0);
        // Packed ABGR: R=0x33, G=0x22, B=0x11, A=0xff.
        ui_set_prop(
            spec::ROOT_ID,
            spec::prop::BG_COLOR as u32,
            0xff11_2233u32 as f64,
        );
        ui_tick();
        let framebuffer = ui_render();
        assert!(!framebuffer.is_null());
        assert_eq!(ui_framebuffer_width(), 2);
        assert_eq!(ui_framebuffer_height(), 1);
        assert_eq!(ui_framebuffer_stride(), 8);
        assert_eq!(ui_framebuffer_len(), 8);
        let pixels = unsafe { core::slice::from_raw_parts(framebuffer, 8) };
        assert_eq!(pixels, &[0x11, 0x22, 0x33, 0xff, 0x11, 0x22, 0x33, 0xff]);
        ui_shutdown();
        #[cfg(feature = "harness-access")]
        assert!(unsafe { with_initialized_ui_unchecked(|_| ()) }.is_none());
    }
}
