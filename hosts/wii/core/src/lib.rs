//! Wii C ABI for PocketJS package admission.

#![no_std]
#![feature(alloc_error_handler)]
#![allow(static_mut_refs)]
#![allow(clippy::not_unsafe_ptr_arg_deref)]

extern crate alloc;

use alloc::borrow::Cow;
use alloc::string::String;
use alloc::vec::Vec;

use pocketjs_core::package::{select_guest, GuestError, PackageError};
use pocketjs_core::{spec, Ui};

#[path = "alloc.rs"]
mod heap;

/// Borrowed sections of a verified `.pocket`; the input bytes must outlive them.
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

/// Verify a package and select one exact target/host ABI variant.
/// Returns 0 on success, or 12 for null/empty arguments or a non-UTF-8 target.
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
    let bytes = core::slice::from_raw_parts(ptr, len);
    let target_bytes = core::slice::from_raw_parts(target_ptr, target_len);
    let Ok(target) = core::str::from_utf8(target_bytes) else {
        return 12;
    };
    if target.is_empty() {
        return 12;
    }

    match select_guest(bytes, target, host_abi, false) {
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

static mut UI: Option<Ui> = None;
static mut DRAW_PTR: *const u32 = core::ptr::null();
static mut DRAW_LEN: usize = 0;
static mut PAK_TEXTURES: Vec<(String, i32)> = Vec::new();
static mut PAK_SPRITES: Vec<PakSprite> = Vec::new();

struct PakSprite {
    name: String,
    handle: i32,
    frames: u16,
    columns: u16,
    step: u16,
}

/// Current texture data for the Wii GX renderer. Returned pointers borrow core
/// storage until a texture change, font load, draw, init, or shutdown call.
#[repr(C)]
pub struct PocketTexture {
    pub pixels: *const u8,
    pub pixels_len: usize,
    pub palette: *const u8,
    pub palette_len: usize,
    pub width: u32,
    pub height: u32,
    pub psm: u32,
    pub linear: u32,
    pub handle: i32,
    pub revision: u64,
}

/// One baked font atlas, laid out identically to the 3DS core ABI.
#[repr(C)]
pub struct PocketFontAtlas {
    pub coverage: *const u8,
    pub coverage_len: usize,
    pub cell_width: u32,
    pub cell_height: u32,
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

#[inline]
unsafe fn text_lossy<'a>(ptr: *const u8, len: usize) -> Cow<'a, str> {
    String::from_utf8_lossy(bytes(ptr, len))
}

fn clear_draw_snapshot() {
    unsafe {
        DRAW_PTR = core::ptr::null();
        DRAW_LEN = 0;
    }
}

#[no_mangle]
pub extern "C" fn ui_init(raster_density: u32) {
    unsafe {
        UI = Some(Ui::new_with_raster_density(raster_density.max(1)));
        PAK_TEXTURES = Vec::new();
        PAK_SPRITES = Vec::new();
    }
    clear_draw_snapshot();
}

#[no_mangle]
pub extern "C" fn ui_shutdown() {
    unsafe {
        UI = None;
        PAK_TEXTURES = Vec::new();
        PAK_SPRITES = Vec::new();
    }
    clear_draw_snapshot();
}

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

// HostOps. setPropBatch is intentionally absent: QuickJS Float64Array storage
// is native-endian on Wii, while that wire format is explicitly little-endian.
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

#[no_mangle]
pub extern "C" fn ui_set_text(id: i32, ptr: *const u8, len: usize) {
    let value = unsafe { text_lossy(ptr, len) };
    ui().set_text(id, &value);
}

#[no_mangle]
pub extern "C" fn ui_replace_text(id: i32, ptr: *const u8, len: usize) {
    let value = unsafe { text_lossy(ptr, len) };
    ui().replace_text(id, &value);
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

#[no_mangle]
pub extern "C" fn ui_upload_tileset_tile(ptr: *const u8, len: usize, index: u32) -> i32 {
    ui().upload_tileset_tile(unsafe { bytes(ptr, len) }, index)
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
pub extern "C" fn ui_load_styles(ptr: *const u8, len: usize) -> i32 {
    ui().load_styles(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_load_font_atlas(ptr: *const u8, len: usize) -> i32 {
    ui().load_font_atlas(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_measure_text(ptr: *const u8, len: usize, font_slot: u32) -> f32 {
    let value = unsafe { text_lossy(ptr, len) };
    ui().measure_text(&value, font_slot as u8)
}

#[no_mangle]
pub extern "C" fn ui_tick() {
    ui().tick();
}

#[no_mangle]
pub extern "C" fn ui_draw() -> usize {
    let words = &ui().draw().words;
    unsafe {
        DRAW_PTR = words.as_ptr();
        DRAW_LEN = words.len();
        DRAW_LEN
    }
}

#[no_mangle]
pub extern "C" fn ui_draw_list_ptr() -> *const u32 {
    unsafe { DRAW_PTR }
}

#[no_mangle]
pub extern "C" fn ui_draw_list_len() -> usize {
    unsafe { DRAW_LEN }
}

#[no_mangle]
pub extern "C" fn ui_texture_slot_count() -> usize {
    ui().texture_slot_count()
}

#[no_mangle]
pub extern "C" fn ui_texture_slot_mask() -> u32 {
    spec::TEX_SLOT_MASK
}

#[no_mangle]
pub extern "C" fn ui_texture_at(slot: u32, out: *mut PocketTexture) -> i32 {
    if out.is_null() {
        return 0;
    }
    let Some((handle, revision, view)) = ui().texture_at_versioned(slot) else {
        return 0;
    };
    unsafe {
        out.write(PocketTexture {
            pixels: view.pixels.as_ptr(),
            pixels_len: view.pixels.len(),
            palette: view.palette.map_or(core::ptr::null(), |p| p.as_ptr()),
            palette_len: view.palette.map_or(0, |p| p.len()),
            width: view.w,
            height: view.h,
            psm: view.psm,
            linear: view.linear as u32,
            handle,
            revision,
        });
    }
    1
}

#[no_mangle]
pub extern "C" fn ui_font_slot_count() -> usize {
    spec::MAX_FONT_SLOTS
}

#[no_mangle]
pub extern "C" fn ui_font_atlas(slot: u32, out: *mut PocketFontAtlas) -> i32 {
    if out.is_null() || slot >= spec::MAX_FONT_SLOTS as u32 {
        return 0;
    }
    let Some(atlas) = ui().font_atlas(slot as u8) else {
        return 0;
    };
    unsafe {
        out.write(PocketFontAtlas {
            coverage: atlas.bitmap.as_ptr(),
            coverage_len: atlas.bitmap.len(),
            cell_width: atlas.cell_w,
            cell_height: atlas.cell_h,
            coverage_width: atlas.coverage_width(),
            coverage_height: atlas.coverage_height(),
            glyph_count: atlas.glyph_count as u32,
        });
    }
    1
}

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
            let handle = instance.upload_img_entry(blob);
            if handle >= 0 {
                textures.push((String::from(name), handle));
                fed += 1;
            }
        } else if let Some(name) = entry.key.strip_prefix("ui:sprite.") {
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
    }
    unsafe {
        PAK_TEXTURES = textures;
        PAK_SPRITES = sprites;
    }
    fed
}

#[no_mangle]
pub extern "C" fn ui_pak_find(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    out: *mut *const u8,
) -> usize {
    match pocketjs_core::pak::find(unsafe { bytes(ptr, len) }, unsafe {
        text(key_ptr, key_len)
    }) {
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

#[inline]
fn read_u16(blob: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *blob.get(offset)?,
        *blob.get(offset + 1)?,
    ]))
}
