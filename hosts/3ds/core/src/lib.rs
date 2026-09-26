//! Nintendo 3DS C ABI for PocketJS's retained UI core.
//!
//! The libctru host owns QuickJS, the PICA200 and presentation, and calls this
//! library synchronously from its main thread. There is exactly one `Ui`
//! instance. Strings and blobs are borrowed as `(ptr, len)` for the duration of
//! a call and copied by the core whenever they must outlive it.
//!
//! Unlike engine/ui-cabi, the graphics backend is NOT in this crate: citro3d is
//! a C library of mostly `static inline` functions, so the DrawList word stream
//! itself crosses the ABI (`ui_draw`, `ui_draw_list_ptr`, `ui_draw_list_len`)
//! and hosts/3ds/src/gfx.c walks it. The same reason forces the texture and
//! font-atlas registries out over the ABI: the C backend resolves a DrawList
//! texture handle to pixels exactly the way engine/ui-cabi/src/gl/mod.rs's
//! `sync_resources`/`image_name` do, only from the other side of the boundary.
//!
//! All returned pointers borrow core-owned storage and stay valid until the
//! next call that can move it — a texture upload/free, a font-atlas load, a
//! `ui_draw`, `ui_init` or `ui_shutdown`. The host re-reads them every frame.

#![no_std]
#![feature(alloc_error_handler)]
#![allow(static_mut_refs)]
#![allow(clippy::not_unsafe_ptr_arg_deref)]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;

use pocketjs_core::package::{select_guest, GuestError, PackageError};
use pocketjs_core::spec;
use pocketjs_core::Ui;

// `extern crate alloc` owns the `alloc` name at the crate root, so the
// allocator module is mounted under a name of its own.
#[path = "alloc.rs"]
mod heap;

static mut UI: Option<Ui> = None;

/// Snapshot of the most recent `ui_draw`. The core's `Vec<u32>` reallocates as
/// a frame's op count changes, so this is refreshed per build rather than
/// cached by the caller across frames.
static mut DRAW_PTR: *const u32 = core::ptr::null();
static mut DRAW_LEN: usize = 0;
static mut AUX_DRAW_PTR: *const u32 = core::ptr::null();
static mut AUX_DRAW_LEN: usize = 0;

/// `ui:img.<name>` and `ui:sprite.<name>` registrations from the last
/// `ui_feed_pak`, in pak order. The host publishes them as `ui.__textures` /
/// `ui.__sprites` (hosts/psp/src/pak.rs feeds the same two tables).
static mut PAK_TEXTURES: Vec<(String, i32)> = Vec::new();
static mut PAK_SPRITES: Vec<PakSprite> = Vec::new();

/// Borrowed sections of one verified filesystem `.pocket`. The C runtime owns
/// the package allocation and keeps it alive until the guest is torn down.
#[repr(C)]
pub struct PocketGuestPackage {
    pub javascript: *const u8,
    pub javascript_length: usize,
    pub pak: *const u8,
    pub pak_length: usize,
    pub plan: *const u8,
    pub plan_length: usize,
    pub package_hash: u64,
    pub variant_hash: u64,
}

struct PakSprite {
    name: String,
    handle: i32,
    frames: u16,
    columns: u16,
    step: u16,
}

/// One live texture slot, as the C backend needs it: everything
/// `pocketjs_core::TexView` carries plus the slot's current generation-tagged
/// handle and content revision (the GPU cache key).
#[repr(C)]
pub struct PocketTexture {
    pub pixels: *const u8,
    pub pixels_len: usize,
    /// 1024-byte CLUT (256 x u32 ABGR), non-null exactly when `psm` is PSM_T8.
    pub palette: *const u8,
    pub palette_len: usize,
    pub width: u32,
    pub height: u32,
    /// spec::psm::* pixel format.
    pub psm: u32,
    /// Bilinear sampling hint (spec::img::FLAG_LINEAR); nearest otherwise.
    pub linear: u32,
    pub handle: i32,
    pub revision: u64,
}

/// One registered font atlas. `coverage` is glyphCount x coverage_height rows
/// of `coverage_width` alpha bytes, top row first — the layout
/// `pocketjs_core::text::Atlas::glyph_rows` indexes.
#[repr(C)]
pub struct PocketFontAtlas {
    pub coverage: *const u8,
    pub coverage_len: usize,
    /// Logical cell size; DrawList glyph cells are drawn at exactly this size.
    pub cell_width: u32,
    pub cell_height: u32,
    /// Raster samples: cell size times the atlas's density.
    pub coverage_width: u32,
    pub coverage_height: u32,
    pub glyph_count: u32,
}

#[inline]
fn ui() -> &'static mut Ui {
    unsafe { UI.get_or_insert_with(Ui::new) }
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

fn package_error_code(error: GuestError) -> i32 {
    match error {
        GuestError::Package(PackageError::Truncated) => 1,
        GuestError::Package(PackageError::BadMagic) => 2,
        GuestError::Package(PackageError::BadVersion) => 3,
        GuestError::Package(PackageError::HashMismatch) => 4,
        GuestError::Package(PackageError::BadUtf8) => 5,
        GuestError::MissingVariant => 6,
        GuestError::HostAbiMismatch => 7,
        GuestError::MissingIdentity => 8,
        GuestError::MissingPlan => 9,
        GuestError::MissingJavaScript => 10,
        GuestError::JavaScriptNotTerminated => 11,
    }
}

/// Verify a complete `.pocket` and select one exact target/ABI variant.
/// Returns 0 on success; non-zero codes are stable for the C runtime's status
/// and recovery files (12 is a bad pointer or non-UTF-8 target argument).
#[no_mangle]
pub unsafe extern "C" fn pocket_package_open(
    ptr: *const u8,
    len: usize,
    target_ptr: *const u8,
    target_len: usize,
    host_abi: u32,
    out: *mut PocketGuestPackage,
) -> i32 {
    if ptr.is_null() || len == 0 || target_ptr.is_null() || target_len == 0 || out.is_null() {
        return 12;
    }
    let target = match core::str::from_utf8(bytes(target_ptr, target_len)) {
        Ok(value) if !value.is_empty() => value,
        _ => return 12,
    };
    match select_guest(bytes(ptr, len), target, host_abi, false) {
        Ok(guest) => {
            out.write(PocketGuestPackage {
                javascript: guest.js.as_ptr(),
                javascript_length: guest.js.len(),
                pak: guest.pak.as_ptr(),
                pak_length: guest.pak.len(),
                plan: guest.plan.as_ptr(),
                plan_length: guest.plan.len(),
                package_hash: guest.package_hash,
                variant_hash: guest.variant_hash,
            });
            0
        }
        Err(error) => package_error_code(error),
    }
}

/// QuickJS encodes lone UTF-16 surrogates (a string sliced mid-emoji) as WTF-8
/// bytes that are not valid UTF-8. They become U+FFFD, matching the web host,
/// instead of silently dropping the whole update. Valid input borrows.
#[inline]
unsafe fn text_lossy<'a>(ptr: *const u8, len: usize) -> alloc::borrow::Cow<'a, str> {
    alloc::string::String::from_utf8_lossy(bytes(ptr, len))
}

#[inline]
fn read_f64_le(record: &[u8], offset: usize) -> f64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&record[offset..offset + 8]);
    f64::from_le_bytes(raw)
}

fn clear_draw_snapshot() {
    unsafe {
        DRAW_PTR = core::ptr::null();
        DRAW_LEN = 0;
        AUX_DRAW_PTR = core::ptr::null();
        AUX_DRAW_LEN = 0;
    }
}

// ---- lifecycle -------------------------------------------------------------

/// Reset the single UI instance. `raster_density == 0` selects density 1.
#[no_mangle]
pub extern "C" fn ui_init(raster_density: u32) {
    unsafe {
        UI = Some(Ui::new_with_raster_density(raster_density.max(1)));
        PAK_TEXTURES = Vec::new();
        PAK_SPRITES = Vec::new();
    }
    clear_draw_snapshot();
}

/// Drop all retained UI, texture and font allocations.
#[no_mangle]
pub extern "C" fn ui_shutdown() {
    unsafe {
        UI = None;
        PAK_TEXTURES = Vec::new();
        PAK_SPRITES = Vec::new();
    }
    clear_draw_snapshot();
}

/// Set the logical viewport. The 3DS host owns the whole 400x240 top screen,
/// so this is called once at boot and never changes (form "takeover").
#[no_mangle]
pub extern "C" fn ui_set_viewport(width: f32, height: f32) {
    ui().set_viewport(width, height);
    clear_draw_snapshot();
}

#[no_mangle]
pub extern "C" fn ui_viewport_width() -> u32 {
    ui().viewport().0 as u32
}

#[no_mangle]
pub extern "C" fn ui_viewport_height() -> u32 {
    ui().viewport().1 as u32
}

#[no_mangle]
pub extern "C" fn ui_create_auxiliary_surface(width: f32, height: f32) -> i32 {
    let root = ui().create_auxiliary_surface(width, height);
    clear_draw_snapshot();
    root
}

#[no_mangle]
pub extern "C" fn ui_auxiliary_surface_root() -> i32 {
    ui().auxiliary_surface_root()
}

#[no_mangle]
pub extern "C" fn ui_auxiliary_viewport_width() -> u32 {
    ui().auxiliary_viewport().map_or(0, |viewport| viewport.0 as u32)
}

#[no_mangle]
pub extern "C" fn ui_auxiliary_viewport_height() -> u32 {
    ui().auxiliary_viewport().map_or(0, |viewport| viewport.1 as u32)
}

/// Optional C-side scratch allocation out of the Rust heap. The caller must
/// release it with the exact same `len`; ordinary borrowed HostOps arguments
/// do not need this.
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

// ---- HostOps ---------------------------------------------------------------

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
    ui().set_text(id, unsafe { &text_lossy(ptr, len) });
}

#[no_mangle]
pub extern "C" fn ui_replace_text(id: i32, ptr: *const u8, len: usize) {
    ui().replace_text(id, unsafe { &text_lossy(ptr, len) });
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

/// Decode one tile from a complete TILESET pak entry (spec op 23).
#[no_mangle]
pub extern "C" fn ui_upload_tileset_tile(ptr: *const u8, len: usize, index: u32) -> i32 {
    ui().upload_tileset_tile(unsafe { bytes(ptr, len) }, index)
}

#[no_mangle]
pub extern "C" fn ui_free_texture(handle: i32) {
    ui().free_texture(handle);
}

#[no_mangle]
pub extern "C" fn ui_register_external_texture(width: u32, height: u32) -> i32 {
    ui().register_external_texture(width, height)
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
pub extern "C" fn ui_hit_test_auxiliary(x: f32, y: f32) -> i32 {
    ui().hit_test_auxiliary(x, y)
}

#[no_mangle]
pub extern "C" fn ui_hit_test_bounds_auxiliary(x: f32, y: f32) -> i32 {
    ui().hit_test_bounds_auxiliary(x, y)
}

#[no_mangle]
pub extern "C" fn ui_touch_hits_auxiliary(
    packed: *const u32,
    length: usize,
    out: *mut i32,
    out_length: usize,
) -> usize {
    let contacts = if packed.is_null() || length == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(packed, length.min(8)) }
    };
    let mut hits = [0i32; 8];
    let count = ui().touch_hits_auxiliary(contacts, &mut hits);
    let written = count.min(out_length);
    if !out.is_null() && written > 0 {
        unsafe { core::ptr::copy_nonoverlapping(hits.as_ptr(), out, written) };
    }
    written
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
    ui().load_font_atlas(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_measure_text(ptr: *const u8, len: usize, font_slot: u32) -> f32 {
    ui().measure_text(unsafe { &text_lossy(ptr, len) }, font_slot as u8)
}

// ---- fixed-step frame and DrawList -----------------------------------------

#[no_mangle]
pub extern "C" fn ui_tick() {
    ui().tick();
}

/// Build this frame's DrawList and return its length in words.
///
/// Call exactly once per presented frame: the build is not idempotent (it
/// advances the DevTools highlight glide) and it is the only thing that
/// refreshes what `ui_draw_list_ptr`/`ui_draw_list_len` report.
#[no_mangle]
pub extern "C" fn ui_draw() -> usize {
    let words = &ui().draw().words;
    unsafe {
        DRAW_PTR = words.as_ptr();
        DRAW_LEN = words.len();
        DRAW_LEN
    }
}

/// The word stream built by the last `ui_draw` (null before the first one).
/// Format: contracts/spec/spec.ts "DRAWLIST op format".
#[no_mangle]
pub extern "C" fn ui_draw_list_ptr() -> *const u32 {
    unsafe { DRAW_PTR }
}

#[no_mangle]
pub extern "C" fn ui_draw_list_len() -> usize {
    unsafe { DRAW_LEN }
}

#[no_mangle]
pub extern "C" fn ui_draw_auxiliary() -> usize {
    let Some(draw_list) = ui().draw_auxiliary() else {
        unsafe {
            AUX_DRAW_PTR = core::ptr::null();
            AUX_DRAW_LEN = 0;
        }
        return 0;
    };
    unsafe {
        AUX_DRAW_PTR = draw_list.words.as_ptr();
        AUX_DRAW_LEN = draw_list.words.len();
        AUX_DRAW_LEN
    }
}

#[no_mangle]
pub extern "C" fn ui_draw_auxiliary_list_ptr() -> *const u32 {
    unsafe { AUX_DRAW_PTR }
}

#[no_mangle]
pub extern "C" fn ui_draw_auxiliary_list_len() -> usize {
    unsafe { AUX_DRAW_LEN }
}

/// FNV-1a64 over the last built word stream — the cheap frame identity the
/// golden tooling compares when pixels are not available.
#[no_mangle]
pub extern "C" fn ui_draw_hash() -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    // from_raw_parts requires a non-null aligned pointer even at length zero;
    // before the first draw (and after shutdown) the snapshot is deliberately
    // null, so spell the empty case without constructing an invalid slice.
    let words: &[u32] = unsafe {
        if DRAW_LEN == 0 {
            &[]
        } else {
            core::slice::from_raw_parts(DRAW_PTR, DRAW_LEN)
        }
    };
    for word in words {
        for byte in word.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

// ---- texture and font registries (what gfx.c binds) ------------------------

/// Number of texture slots ever allocated — the walk bound for
/// `ui_texture_at`.
#[no_mangle]
pub extern "C" fn ui_texture_slot_count() -> usize {
    ui().texture_slot_count()
}

/// Mask that turns a DrawList texture handle into its slot index
/// (spec TEX_SLOT_BITS). The generation lives above it, so a cache entry is
/// only valid while its stored `handle` still equals the DrawList's word.
#[no_mangle]
pub extern "C" fn ui_texture_slot_mask() -> u32 {
    spec::TEX_SLOT_MASK
}

/// Fill `out` with the live texture in `slot`. Returns 1 when the slot holds
/// one, 0 when it is free (leaving `out` untouched).
#[no_mangle]
pub extern "C" fn ui_texture_at(slot: u32, out: *mut PocketTexture) -> i32 {
    if out.is_null() {
        return 0;
    }
    let Some((handle, revision, view)) = ui().texture_at_versioned(slot) else {
        return 0;
    };
    unsafe {
        (*out).pixels = view.pixels.as_ptr();
        (*out).pixels_len = view.pixels.len();
        (*out).palette = view.palette.map_or(core::ptr::null(), |p| p.as_ptr());
        (*out).palette_len = view.palette.map_or(0, |p| p.len());
        (*out).width = view.w;
        (*out).height = view.h;
        (*out).psm = view.psm;
        (*out).linear = view.linear as u32;
        (*out).handle = handle;
        (*out).revision = revision;
    }
    1
}

/// Font slots the core can hold (spec MAX_FONT_SLOTS) — the walk bound for
/// `ui_font_atlas`.
#[no_mangle]
pub extern "C" fn ui_font_slot_count() -> usize {
    spec::MAX_FONT_SLOTS
}

/// Fill `out` with the atlas registered in `slot`. Returns 1 when one is
/// registered, 0 otherwise. `coverage` doubles as the cache identity: loading
/// a new atlas into a slot replaces the allocation.
#[no_mangle]
pub extern "C" fn ui_font_atlas(slot: u32, out: *mut PocketFontAtlas) -> i32 {
    if out.is_null() || slot >= spec::MAX_FONT_SLOTS as u32 {
        return 0;
    }
    let Some(atlas) = ui().font_atlas(slot as u8) else {
        return 0;
    };
    unsafe {
        (*out).coverage = atlas.bitmap.as_ptr();
        (*out).coverage_len = atlas.bitmap.len();
        (*out).cell_width = atlas.cell_w;
        (*out).cell_height = atlas.cell_h;
        (*out).coverage_width = atlas.coverage_width();
        (*out).coverage_height = atlas.coverage_height();
        (*out).glyph_count = atlas.glyph_count as u32;
    }
    1
}

// ---- asset pack ------------------------------------------------------------

/// Feed every recognized entry of an app pak straight to the core, before any
/// JS runs — styles.bin, font atlases, images and sprite atlases, with zero
/// QuickJS-heap transit. Malformed entries are skipped, never fatal.
///
/// Returns the number of entries fed. The `ui:img.*` and `ui:sprite.*` name
/// tables the host publishes as `ui.__textures` / `ui.__sprites` are then read
/// back through the accessors below. `ui:tile.*` is deliberately skipped:
/// deep-zoom tiles stream one at a time through `ui_upload_tileset_tile`.
#[no_mangle]
pub extern "C" fn ui_feed_pak(ptr: *const u8, len: usize) -> u32 {
    let pak = unsafe { bytes(ptr, len) };
    let instance = ui();
    let mut fed = 0u32;
    let mut textures = Vec::new();
    let mut sprites = Vec::new();
    for entry in pocketjs_core::pak::entries(pak) {
        let blob = entry.blob;
        if entry.key == "ui:styles" {
            fed += instance.load_styles(blob) as u32;
        } else if entry.key.starts_with("ui:font.") {
            fed += instance.load_font_atlas(blob) as u32;
        } else if let Some(name) = entry.key.strip_prefix("ui:img.") {
            // Keep pak-fed images on the same parser as the public
            // uploadImgEntry op. The header's flags byte carries PackBits-RLE
            // and bilinear-sampling semantics; re-parsing only width/height/
            // psm here would silently turn those off on this host.
            let handle = instance.upload_img_entry(blob);
            if handle >= 0 {
                textures.push((String::from(name), handle));
                fed += 1;
            }
        } else if let Some(name) = entry.key.strip_prefix("ui:sprite.") {
            // SPRITE entry: 16-byte header {u16 atlasW, u16 atlasH, u8 psm,
            // u8 pad, u16 frameCount, u16 cols, u16 frameStep, 4B pad} + atlas
            // pixels (framework/compiler/pak.ts encodeSpriteEntry).
            let (
                Some(width),
                Some(height),
                Some(&psm),
                Some(frames),
                Some(columns),
                Some(step),
                Some(pixels),
            ) = (
                read_u16(blob, 0),
                read_u16(blob, 2),
                blob.get(4),
                read_u16(blob, 6),
                read_u16(blob, 8),
                read_u16(blob, 10),
                blob.get(16..),
            )
            else {
                continue;
            };
            let handle = instance.upload_texture(pixels, width as u32, height as u32, psm as u32);
            if handle >= 0 {
                sprites.push(PakSprite {
                    name: String::from(name),
                    handle,
                    frames,
                    columns,
                    step,
                });
                fed += 1;
            }
        }
        // unknown keys: ignored (forward compatible)
    }
    unsafe {
        PAK_TEXTURES = textures;
        PAK_SPRITES = sprites;
    }
    fed
}

/// Look up one pak entry's blob by exact key — the runtime side of the
/// streaming ops (`loadTileTexture`'s `ui:tile.<name>` keys, which
/// `ui_feed_pak` skips). Returns the blob length, 0 on a miss.
#[no_mangle]
pub extern "C" fn ui_pak_find(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    out: *mut *const u8,
) -> usize {
    let pak = unsafe { bytes(ptr, len) };
    let key = unsafe { text(key_ptr, key_len) };
    match pocketjs_core::pak::find(pak, key) {
        Some(blob) => {
            if !out.is_null() {
                unsafe { *out = blob.as_ptr() };
            }
            blob.len()
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn ui_pak_texture_count() -> usize {
    unsafe { PAK_TEXTURES.len() }
}

/// The bare `src` name of registration `index` — NOT NUL-terminated; pair it
/// with `ui_pak_texture_name_len`.
#[no_mangle]
pub extern "C" fn ui_pak_texture_name(index: usize) -> *const u8 {
    unsafe {
        PAK_TEXTURES
            .get(index)
            .map_or(core::ptr::null(), |(name, _)| name.as_ptr())
    }
}

#[no_mangle]
pub extern "C" fn ui_pak_texture_name_len(index: usize) -> usize {
    unsafe { PAK_TEXTURES.get(index).map_or(0, |(name, _)| name.len()) }
}

#[no_mangle]
pub extern "C" fn ui_pak_texture_handle(index: usize) -> i32 {
    unsafe { PAK_TEXTURES.get(index).map_or(-1, |&(_, handle)| handle) }
}

#[no_mangle]
pub extern "C" fn ui_pak_sprite_count() -> usize {
    unsafe { PAK_SPRITES.len() }
}

#[no_mangle]
pub extern "C" fn ui_pak_sprite_name(index: usize) -> *const u8 {
    unsafe {
        PAK_SPRITES
            .get(index)
            .map_or(core::ptr::null(), |sprite| sprite.name.as_ptr())
    }
}

#[no_mangle]
pub extern "C" fn ui_pak_sprite_name_len(index: usize) -> usize {
    unsafe { PAK_SPRITES.get(index).map_or(0, |sprite| sprite.name.len()) }
}

#[no_mangle]
pub extern "C" fn ui_pak_sprite_handle(index: usize) -> i32 {
    unsafe { PAK_SPRITES.get(index).map_or(-1, |sprite| sprite.handle) }
}

#[no_mangle]
pub extern "C" fn ui_pak_sprite_frames(index: usize) -> u32 {
    unsafe {
        PAK_SPRITES
            .get(index)
            .map_or(0, |sprite| sprite.frames as u32)
    }
}

#[no_mangle]
pub extern "C" fn ui_pak_sprite_columns(index: usize) -> u32 {
    unsafe {
        PAK_SPRITES
            .get(index)
            .map_or(0, |sprite| sprite.columns as u32)
    }
}

#[no_mangle]
pub extern "C" fn ui_pak_sprite_step(index: usize) -> u32 {
    unsafe {
        PAK_SPRITES
            .get(index)
            .map_or(0, |sprite| sprite.step as u32)
    }
}

// ---- DevTools (spec ops 18..22) --------------------------------------------

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

#[inline]
fn read_u16(blob: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *blob.get(offset)?,
        *blob.get(offset + 1)?,
    ]))
}
