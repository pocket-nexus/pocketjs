#![cfg_attr(not(feature = "std"), no_std)]
#![allow(clippy::missing_safety_doc)]
extern crate alloc;
extern crate pocketjs_idf_runtime;
use alloc::boxed::Box;
use core::ffi::c_void;
use core::{ptr, slice, str};
use pocketjs_core::Ui;
use pocketjs_idf_abi::*;

#[repr(C)]
pub struct NativeUiCore {
    ui: Ui,
    epoch: u64,
    frame_words: *const u32,
    frame_word_count: usize,
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_load_assets(
    core: *mut NativeUiCore,
    assets: *const NativeAsset,
    count: usize,
    handles: *mut i32,
) -> i32 {
    use pocketjs_core::assets::{AssetError, AssetInput, AssetKind};
    let Some(core) = core_mut(core) else {
        return -1;
    };
    if count == 0 {
        return 0;
    }
    if assets.is_null() || handles.is_null() || count > 4096 {
        return -1;
    }
    let mut inputs = alloc::vec::Vec::new();
    if inputs.try_reserve(count).is_err() {
        return -2;
    }
    for asset in slice::from_raw_parts(assets, count) {
        if asset.struct_size < core::mem::size_of::<NativeAsset>() {
            return -1;
        }
        let Some(data) = bytes(asset.data, asset.size) else {
            return -1;
        };
        let kind = match asset.kind {
            1 => AssetKind::Styles,
            2 => AssetKind::Font,
            3 => AssetKind::Image,
            4 => AssetKind::Sprite,
            _ => return -1,
        };
        inputs.push(AssetInput { kind, bytes: data });
    }
    match core
        .ui
        .load_assets(&inputs, slice::from_raw_parts_mut(handles, count))
    {
        Ok(()) => {
            mutated(core);
            0
        }
        Err(AssetError::Invalid) => -1,
        Err(AssetError::NoMemory) => -2,
    }
}

#[inline]
unsafe fn core_mut<'a>(core: *mut NativeUiCore) -> Option<&'a mut NativeUiCore> {
    core.as_mut()
}

#[inline]
unsafe fn bytes<'a>(data: *const u8, size: usize) -> Option<&'a [u8]> {
    if size == 0 {
        Some(&[])
    } else if data.is_null() {
        None
    } else {
        Some(slice::from_raw_parts(data, size))
    }
}

#[inline]
unsafe fn text<'a>(data: *const u8, size: usize) -> Option<&'a str> {
    str::from_utf8(bytes(data, size)?).ok()
}

#[inline]
fn mutated(core: &mut NativeUiCore) {
    core.epoch = core.epoch.wrapping_add(1);
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_create(
    config: *const NativeUiConfig,
    out_core: *mut *mut NativeUiCore,
) -> i32 {
    if config.is_null() || out_core.is_null() {
        return -1;
    }
    *out_core = ptr::null_mut();
    let config = &*config;
    if config.struct_size < core::mem::size_of::<NativeUiConfig>()
        || config.logical_width == 0
        || config.logical_height == 0
        || !(1..=255).contains(&config.raster_density)
        || config.tick_hz == 0
        || config.tick_hz > pocketjs_core::MAX_TICK_HZ
    {
        return -1;
    }
    let mut ui = Ui::new_with_raster_density(config.raster_density);
    ui.set_viewport(config.logical_width as f32, config.logical_height as f32);
    if !ui.set_tick_rate(config.tick_hz) {
        return -1;
    }
    *out_core = Box::into_raw(Box::new(NativeUiCore {
        ui,
        epoch: 1,
        frame_words: ptr::null(),
        frame_word_count: 0,
    }));
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_get_config(
    core: *const NativeUiCore,
    output: *mut NativeUiConfig,
) -> i32 {
    let (Some(core), Some(output)) = (core.as_ref(), output.as_mut()) else {
        return -1;
    };
    if output.struct_size < core::mem::size_of::<NativeUiConfig>() {
        return -1;
    }
    let output_size = output.struct_size;
    let (logical_width, logical_height) = core.ui.viewport();
    *output = NativeUiConfig {
        struct_size: output_size,
        logical_width: logical_width as u32,
        logical_height: logical_height as u32,
        raster_density: core.ui.raster_density(),
        tick_hz: core.ui.tick_rate(),
    };
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_destroy(core: *mut NativeUiCore) {
    if !core.is_null() {
        drop(Box::from_raw(core));
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_create_node(core: *mut NativeUiCore, kind: u32) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    let id = core.ui.create_node(kind as u8);
    mutated(core);
    id
}

macro_rules! core_void {
    ($name:ident($($arg:ident: $ty:ty),*) $body:expr) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name(core: *mut NativeUiCore, $($arg: $ty),*) {
            let Some(core) = core_mut(core) else { return };
            $body(core, $($arg),*);
            mutated(core);
        }
    };
}

core_void!(pocketjs_native_ui_destroy_node(id: i32) |core: &mut NativeUiCore, id| core.ui.destroy_node(id));
core_void!(pocketjs_native_ui_insert_before(parent: i32, child: i32, anchor: i32)
    |core: &mut NativeUiCore, parent, child, anchor| core.ui.insert_before(parent, child, anchor));
core_void!(pocketjs_native_ui_remove_child(parent: i32, child: i32)
    |core: &mut NativeUiCore, parent, child| core.ui.remove_child(parent, child));
core_void!(pocketjs_native_ui_set_style(id: i32, style: i32)
    |core: &mut NativeUiCore, id, style| core.ui.set_style(id, style));
core_void!(pocketjs_native_ui_set_prop(id: i32, prop: u32, value: f64)
    |core: &mut NativeUiCore, id, prop, value| core.ui.set_prop(id, prop as u8, value));
core_void!(pocketjs_native_ui_cancel_animation(animation: i32)
    |core: &mut NativeUiCore, animation| core.ui.cancel_anim(animation));
core_void!(pocketjs_native_ui_set_focus(id: i32)
    |core: &mut NativeUiCore, id| core.ui.set_focus(id));
core_void!(pocketjs_native_ui_set_active(id: i32, active: i32)
    |core: &mut NativeUiCore, id, active| core.ui.set_active(id, active != 0));
core_void!(pocketjs_native_ui_set_cursor(texture: i32, hot_x: f32, hot_y: f32, width: f32, height: f32)
    |core: &mut NativeUiCore, texture, hot_x, hot_y, width, height|
        core.ui.set_cursor(texture, hot_x, hot_y, width, height));
core_void!(pocketjs_native_ui_set_cursor_position(x: f32, y: f32)
    |core: &mut NativeUiCore, x, y| core.ui.set_cursor_pos(x, y));
core_void!(pocketjs_native_ui_free_texture(texture: i32)
    |core: &mut NativeUiCore, texture| core.ui.free_texture(texture));
core_void!(pocketjs_native_ui_set_image(id: i32, texture: i32)
    |core: &mut NativeUiCore, id, texture| core.ui.set_image(id, texture));
core_void!(pocketjs_native_ui_set_sprite(id: i32, atlas: i32, frames: u32, columns: u32, step: u32)
    |core: &mut NativeUiCore, id, atlas, frames, columns, step|
        core.ui.set_sprite(id, atlas, frames, columns, step));

unsafe fn set_text_common(
    core: *mut NativeUiCore,
    id: i32,
    data: *const u8,
    size: usize,
    replace: bool,
) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    let Some(value) = text(data, size) else {
        return -1;
    };
    if replace {
        core.ui.replace_text(id, value);
    } else {
        core.ui.set_text(id, value);
    }
    mutated(core);
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_set_text(
    core: *mut NativeUiCore,
    id: i32,
    data: *const u8,
    size: usize,
) -> i32 {
    set_text_common(core, id, data, size, false)
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_replace_text(
    core: *mut NativeUiCore,
    id: i32,
    data: *const u8,
    size: usize,
) -> i32 {
    set_text_common(core, id, data, size, true)
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_animate(
    core: *mut NativeUiCore,
    id: i32,
    prop: u32,
    to: f64,
    duration: u32,
    easing: u32,
    delay: u32,
) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    let animation = core
        .ui
        .animate(id, prop as u8, to, duration, easing as u8, delay);
    mutated(core);
    animation
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_hit_test(
    core: *mut NativeUiCore,
    x: f32,
    y: f32,
) -> i32 {
    core_mut(core).map_or(0, |core| core.ui.hit_test(x, y))
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_hit_test_bounds(
    core: *mut NativeUiCore,
    x: f32,
    y: f32,
) -> i32 {
    core_mut(core).map_or(0, |core| core.ui.hit_test_bounds(x, y))
}

unsafe fn load_bytes(core: *mut NativeUiCore, data: *const u8, size: usize, font: bool) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    let Some(data) = bytes(data, size) else {
        return -1;
    };
    let loaded = if font {
        core.ui.load_font_atlas(data)
    } else {
        core.ui.load_styles(data)
    };
    if loaded {
        mutated(core);
        0
    } else {
        -1
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_load_styles(
    core: *mut NativeUiCore,
    data: *const u8,
    size: usize,
) -> i32 {
    load_bytes(core, data, size, false)
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_load_font(
    core: *mut NativeUiCore,
    data: *const u8,
    size: usize,
) -> i32 {
    load_bytes(core, data, size, true)
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_upload_texture(
    core: *mut NativeUiCore,
    data: *const u8,
    size: usize,
    width: u32,
    height: u32,
    psm: u32,
) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    let Some(data) = bytes(data, size) else {
        return -1;
    };
    let handle = core.ui.upload_texture(data, width, height, psm);
    mutated(core);
    handle
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_upload_img_entry(
    core: *mut NativeUiCore,
    data: *const u8,
    size: usize,
) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    let Some(data) = bytes(data, size) else {
        return -1;
    };
    let handle = core.ui.upload_img_entry(data);
    mutated(core);
    handle
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_measure_text(
    core: *mut NativeUiCore,
    data: *const u8,
    size: usize,
    slot: u32,
) -> f32 {
    let Some(core) = core_mut(core) else {
        return 0.0;
    };
    let Some(value) = text(data, size) else {
        return 0.0;
    };
    core.ui.measure_text(value, slot as u8)
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_wrap_text(
    core: *mut NativeUiCore,
    data: *const u8,
    size: usize,
    slot: u32,
    max_width: f32,
    output: *mut u32,
    capacity: usize,
) -> usize {
    let Some(core) = core_mut(core) else { return 0 };
    let Some(value) = text(data, size) else {
        return 0;
    };
    let breaks = core.ui.wrap_text(value, slot as u8, max_width);
    if !output.is_null() {
        ptr::copy_nonoverlapping(breaks.as_ptr(), output, breaks.len().min(capacity));
    }
    breaks.len()
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_tick(core: *mut NativeUiCore) {
    let Some(core) = core_mut(core) else { return };
    core.ui.tick();
    mutated(core);
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_draw(
    core: *mut NativeUiCore,
    out: *mut NativeFrameView,
) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    if out.is_null() || (*out).struct_size < core::mem::size_of::<NativeFrameView>() {
        return -1;
    }
    let output_size = (*out).struct_size;
    // A frame view is a borrow, not a snapshot. Even another draw of the
    // same logical state invalidates the previous buffer and prepare token.
    mutated(core);
    let raster_density = core.ui.raster_density();
    let (width, height) = core.ui.viewport();
    let words = &core.ui.draw().words;
    let draw_words = words.as_ptr();
    let draw_word_count = words.len();
    let raster_revision = core.ui.raster_revision();
    core.frame_words = draw_words;
    core.frame_word_count = draw_word_count;
    *out = NativeFrameView {
        struct_size: output_size,
        epoch: core.epoch,
        raster_revision,
        logical_width: width as u32,
        logical_height: height as u32,
        raster_density,
        draw_words,
        draw_word_count,
        private_core: core as *mut NativeUiCore as *mut c_void,
    };
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_touch_hits(
    core: *mut NativeUiCore,
    touches: *const u32,
    touch_count: usize,
    output: *mut i32,
    output_capacity: usize,
) -> usize {
    if touch_count > 8
        || touch_count > output_capacity
        || (touch_count != 0 && (touches.is_null() || output.is_null()))
    {
        return 0;
    }
    let Some(core) = core_mut(core) else { return 0 };
    // Empty frames retire captures; the ABI permits null buffers for them.
    let touches = if touch_count == 0 {
        &[]
    } else {
        slice::from_raw_parts(touches, touch_count)
    };
    let mut hits = [0i32; 8];
    let count = core.ui.touch_hits(touches, &mut hits);
    if count != 0 {
        ptr::copy_nonoverlapping(hits.as_ptr(), output, count);
    }
    count
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_texture(
    core: *mut NativeUiCore,
    handle: i32,
    out: *mut NativeTextureView,
) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    if out.is_null() || (*out).struct_size < core::mem::size_of::<NativeTextureView>() {
        return -1;
    }
    let Some(texture) = core.ui.texture(handle) else {
        return -1;
    };
    let output_size = (*out).struct_size;
    let palette = texture.palette.unwrap_or(&[]);
    *out = NativeTextureView {
        struct_size: output_size,
        pixels: texture.pixels.as_ptr(),
        pixel_bytes: texture.pixels.len(),
        width: texture.w,
        height: texture.h,
        psm: texture.psm,
        palette: palette.as_ptr(),
        palette_bytes: palette.len(),
        revision: core.ui.texture_revision(handle).unwrap_or(0),
        linear: texture.linear,
    };
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_font(
    core: *mut NativeUiCore,
    slot: u32,
    out: *mut NativeFontView,
) -> i32 {
    let Some(core) = core_mut(core) else {
        return -1;
    };
    if out.is_null() || (*out).struct_size < core::mem::size_of::<NativeFontView>() {
        return -1;
    }
    let Some(font) = core.ui.font_atlas(slot as u8) else {
        return -1;
    };
    let output_size = (*out).struct_size;
    *out = NativeFontView {
        struct_size: output_size,
        bitmap: font.bitmap.as_ptr(),
        bitmap_bytes: font.bitmap.len(),
        cell_width: font.cell_w,
        cell_height: font.cell_h,
        raster_density: font.raster_density as u32,
        glyph_count: font.glyph_count as u32,
    };
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_native_ui_frame_validate(frame: *const NativeFrameView) -> i32 {
    let Some(frame) = frame.as_ref() else {
        return -1;
    };
    if frame.struct_size < core::mem::size_of::<NativeFrameView>() {
        return -1;
    }
    let Some(core) = (frame.private_core as *const NativeUiCore).as_ref() else {
        return -1;
    };
    if core.frame_words.is_null()
        || frame.epoch != core.epoch
        || frame.draw_words != core.frame_words
        || frame.draw_word_count != core.frame_word_count
    {
        return -1;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn density_validation_and_draw_borrow_generation() {
        unsafe {
            let mut config = NativeUiConfig {
                struct_size: core::mem::size_of::<NativeUiConfig>(),
                logical_width: 32,
                logical_height: 16,
                raster_density: 1,
                tick_hz: 60,
            };
            let mut core = ptr::null_mut();
            for density in [0, 256, u32::MAX] {
                config.raster_density = density;
                assert_eq!(pocketjs_native_ui_create(&config, &mut core), -1);
                assert!(core.is_null());
            }
            config.raster_density = 1;
            assert_eq!(pocketjs_native_ui_create(&config, &mut core), 0);
            let mut frame: NativeFrameView = core::mem::zeroed();
            frame.struct_size = core::mem::size_of::<NativeFrameView>();
            assert_eq!(pocketjs_native_ui_draw(core, &mut frame), 0);
            let old = frame;
            assert_eq!(pocketjs_native_ui_frame_validate(&old), 0);
            assert_eq!(pocketjs_native_ui_draw(core, &mut frame), 0);
            assert_eq!(pocketjs_native_ui_frame_validate(&old), -1);
            assert_eq!(pocketjs_native_ui_frame_validate(&frame), 0);
            pocketjs_native_ui_destroy(core);
        }
    }
}
