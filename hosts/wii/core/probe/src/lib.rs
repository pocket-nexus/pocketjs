#![no_std]
#![feature(alloc_error_handler)]

extern crate alloc;

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;
use pocketjs_core::Ui;
use pocketjs_core::{package, pak};
use pocketjs_core::{spec, style::StyleTable};

const W06B_MAX_STYLE_PROPS: usize = 32;
const W06B_MAX_COVERAGE_BYTES: usize = 64;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct W06bProbeProp {
    prop: u8,
    value: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct W06bProbeGlyph {
    codepoint: u32,
    gid: u16,
    advance: u8,
    xoff: u8,
}

#[repr(C)]
pub struct W06bProbeSummary {
    style_count: usize,
    variant_counts: [usize; 3],
    variant_props: [[W06bProbeProp; W06B_MAX_STYLE_PROPS]; 3],
    atlas_slot: u8,
    atlas_flags: u8,
    atlas_glyph_count: u16,
    cell_w: u32,
    cell_h: u32,
    baseline: u32,
    line_height: u32,
    coverage_w: u32,
    coverage_h: u32,
    raster_density: u8,
    glyphs: [W06bProbeGlyph; 2],
    coverage_len: usize,
    coverage: [u8; W06B_MAX_COVERAGE_BYTES],
    diagnostics: [u32; 6],
}

#[repr(C)]
pub struct W06cProbeSummary {
    pixels: *const u8,
    pixel_len: usize,
    palette: *const u8,
    palette_len: usize,
    width: u32,
    height: u32,
    psm: u32,
    draw_words: *const u32,
    draw_len: usize,
    owner: *mut c_void,
}

const W06A_TARGET: &str = "wii-dev";
const W06A_HOST_ABI: u32 = 7;
const W06A_FIXTURE: &[u8] = include_bytes!("../w06a.pocket");

struct W06aEntry<'a> {
    name: &'a str,
    length: usize,
}

struct W06aSummary<'a> {
    target: &'a str,
    host_abi: u32,
    pak_length: usize,
    entries: [W06aEntry<'a>; 2],
}

fn w06a_summary() -> Option<W06aSummary<'static>> {
    let parsed = package::Package::parse(W06A_FIXTURE, false).ok()?;
    let variant = parsed.find_variant(W06A_TARGET).ok()??;
    let guest = package::select_guest(W06A_FIXTURE, W06A_TARGET, W06A_HOST_ABI, false).ok()?;
    let mut entries = pak::entries(guest.pak);
    let first = entries.next()?;
    let second = entries.next()?;
    if entries.next().is_some() {
        return None;
    }
    Some(W06aSummary {
        target: variant.target,
        host_abi: variant.host_abi,
        pak_length: guest.pak.len(),
        entries: [
            W06aEntry { name: first.key, length: first.blob.len() },
            W06aEntry { name: second.key, length: second.blob.len() },
        ],
    })
}

#[repr(C)]
pub struct W06aProbeEntry {
    name: *const u8,
    name_length: usize,
    blob_length: usize,
}

#[repr(C)]
pub struct W06aProbeSummary {
    target: *const u8,
    target_length: usize,
    host_abi: u32,
    pak_length: usize,
    entry_count: usize,
    entries: [W06aProbeEntry; 2],
}

unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn memalign(alignment: usize, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn abort() -> !;
}

struct CAllocator;

unsafe impl GlobalAlloc for CAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= 8 {
            malloc(layout.size().max(1)).cast()
        } else {
            memalign(layout.align(), layout.size().max(1)).cast()
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        free(ptr.cast());
    }
}

#[global_allocator]
static ALLOCATOR: CAllocator = CAllocator;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { abort() }
}

#[alloc_error_handler]
fn allocation_error(_layout: Layout) -> ! {
    unsafe { abort() }
}

#[no_mangle]
pub extern "C" fn pocket_wii_probe_alloc(size: usize, alignment: usize) -> *mut u8 {
    let Ok(layout) = Layout::from_size_align(size, alignment) else {
        return core::ptr::null_mut();
    };
    unsafe { alloc::alloc::alloc(layout) }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_wii_probe_free(
    ptr: *mut u8,
    size: usize,
    alignment: usize,
) {
    let Ok(layout) = Layout::from_size_align(size, alignment) else {
        return;
    };
    if !ptr.is_null() {
        alloc::alloc::dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn pocket_wii_probe_floats(a: f32, b: f32) -> f32 {
    a * 2.0 + b * 3.0
}

#[no_mangle]
pub extern "C" fn pocket_wii_probe_core_alloc() -> u32 {
    let mut ui = Ui::new();
    ui.set_cursor_pos(11.5, 21.25);
    ui.tick();
    let _ = ui.draw();
    (ui.raster_density() == 1 && ui.tick_rate() == 60) as u32
}

#[no_mangle]
pub unsafe extern "C" fn pocket_wii_probe_w06a(out: *mut W06aProbeSummary) -> u32 {
    if out.is_null() {
        return 0;
    }
    let Some(summary) = w06a_summary() else {
        return 0;
    };
    out.write(W06aProbeSummary {
        target: summary.target.as_ptr(),
        target_length: summary.target.len(),
        host_abi: summary.host_abi,
        pak_length: summary.pak_length,
        entry_count: summary.entries.len(),
        entries: summary.entries.map(|entry| W06aProbeEntry {
            name: entry.name.as_ptr(),
            name_length: entry.name.len(),
            blob_length: entry.length,
        }),
    });
    1
}

#[no_mangle]
pub unsafe extern "C" fn pocket_wii_probe_w06b(
    styles: *const u8,
    styles_len: usize,
    font: *const u8,
    font_len: usize,
    out: *mut W06bProbeSummary,
) -> u32 {
    if styles.is_null() || font.is_null() || out.is_null() {
        return 2;
    }
    let styles = core::slice::from_raw_parts(styles, styles_len);
    let font = core::slice::from_raw_parts(font, font_len);
    let Some(table) = StyleTable::parse(styles) else { return 3 };
    let Some(record) = table.record(0) else { return 4 };
    if record.base.len() > W06B_MAX_STYLE_PROPS
        || record.focus.len() > W06B_MAX_STYLE_PROPS
        || record.active.len() > W06B_MAX_STYLE_PROPS
    {
        return 5;
    }

    let mut ui = Ui::new();
    if !ui.load_styles(styles) {
        return 6;
    }
    if !ui.load_font_atlas(font) {
        return 7;
    }
    let node = ui.create_node(spec::NodeType::View as u8);
    ui.set_style(node, 0);
    ui.set_active(node, true);
    let Some(resolved) = ui.resolved_style(node) else { return 8 };
    let Some(width) = record.base.iter().find(|(prop, _)| *prop == spec::prop::WIDTH).map(|(_, value)| *value) else { return 9 };
    let Some(bg_color) = record.base.iter().find(|(prop, _)| *prop == spec::prop::BG_COLOR).map(|(_, value)| *value) else { return 10 };
    let Some(opacity) = record.active.iter().find(|(prop, _)| *prop == spec::prop::OPACITY).map(|(_, value)| *value) else { return 11 };
    (*out).diagnostics = [
        width,
        resolved.width.to_bits(),
        bg_color,
        resolved.bg_color,
        opacity,
        resolved.opacity.to_bits(),
    ];
    if resolved.width.to_bits() != width || resolved.bg_color != bg_color || resolved.opacity.to_bits() != opacity {
        return 12;
    }

    let Some(atlas) = ui.font_atlas(font[12]) else { return 13 };
    if atlas.glyph_count != 2 || atlas.bitmap.len() > W06B_MAX_COVERAGE_BYTES {
        return 14;
    }
    let mut glyphs = [W06bProbeGlyph::default(); 2];
    for (dst, codepoint) in glyphs.iter_mut().zip([0x41, 0xfffd]) {
        let Some(entry) = atlas.lookup_entry(codepoint) else { return 15 };
        *dst = W06bProbeGlyph {
            codepoint: entry.codepoint,
            gid: entry.gid,
            advance: entry.advance,
            xoff: entry.xoff,
        };
    }

    let mut summary = W06bProbeSummary {
        style_count: table.records.len(),
        variant_counts: [record.base.len(), record.focus.len(), record.active.len()],
        variant_props: [[W06bProbeProp::default(); W06B_MAX_STYLE_PROPS]; 3],
        atlas_slot: atlas.slot,
        atlas_flags: atlas.flags,
        atlas_glyph_count: atlas.glyph_count,
        cell_w: atlas.cell_w,
        cell_h: atlas.cell_h,
        baseline: atlas.baseline,
        line_height: atlas.line_height,
        coverage_w: atlas.coverage_width(),
        coverage_h: atlas.coverage_height(),
        raster_density: atlas.raster_density,
        glyphs,
        coverage_len: atlas.bitmap.len(),
        coverage: [0; W06B_MAX_COVERAGE_BYTES],
        diagnostics: [
            width,
            resolved.width.to_bits(),
            bg_color,
            resolved.bg_color,
            opacity,
            resolved.opacity.to_bits(),
        ],
    };
    for (dst, props) in summary.variant_props.iter_mut().zip([&record.base, &record.focus, &record.active]) {
        for (out, &(prop, value)) in dst.iter_mut().zip(props) {
            *out = W06bProbeProp { prop, value };
        }
    }
    summary.coverage[..atlas.bitmap.len()].copy_from_slice(&atlas.bitmap);
    out.write(summary);
    1
}

#[no_mangle]
pub unsafe extern "C" fn pocket_wii_probe_w06c(
    texture: *const u8,
    texture_len: usize,
    out: *mut W06cProbeSummary,
) -> u32 {
    if texture.is_null() || out.is_null() {
        return 2;
    }
    let mut ui = Ui::new();
    let texture = core::slice::from_raw_parts(texture, texture_len);
    let handle = ui.upload_texture(texture, 4, 2, spec::psm::PSM_T8);
    if handle < 0 {
        return 3;
    }

    let image = ui.create_node(spec::NodeType::Image as u8);
    ui.set_prop(image, spec::prop::WIDTH, 4.0);
    ui.set_prop(image, spec::prop::HEIGHT, 2.0);
    ui.set_prop(image, spec::prop::POS_TYPE, spec::PosType::Absolute as u8 as f64);
    ui.set_prop(image, spec::prop::INSET_L, 3.0);
    ui.set_prop(image, spec::prop::INSET_T, 2.0);
    ui.set_image(image, handle);
    ui.insert_before(spec::ROOT_ID, image, 0);

    ui.set_text_measure(Some(alloc::boxed::Box::new(|text: &str, _, _, line_h| {
        (text.chars().count() as f32 * 4.0, if line_h.is_nan() { 8.0 } else { line_h })
    })));
    let text = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(text, spec::prop::WIDTH, 20.0);
    ui.set_prop(text, spec::prop::HEIGHT, 8.0);
    ui.set_prop(text, spec::prop::LINE_HEIGHT, 8.0);
    ui.set_prop(text, spec::prop::TEXT_COLOR, 0xff12ab34u32 as f64);
    ui.set_prop(text, spec::prop::POS_TYPE, spec::PosType::Absolute as u8 as f64);
    ui.set_prop(text, spec::prop::INSET_L, 11.0);
    ui.set_prop(text, spec::prop::INSET_T, 9.0);
    ui.set_text(text, "Aé");
    ui.insert_before(spec::ROOT_ID, text, 0);

    ui.tick();
    let draw = &ui.draw().words;
    if draw.len() > 64 {
        return 4;
    }
    let draw_words = draw.as_ptr();
    let draw_len = draw.len();
    let (pixels, pixel_len, palette, palette_len, width, height, psm) = {
        let Some(view) = ui.texture(handle) else { return 5 };
        let Some(palette) = view.palette else { return 6 };
        (
            view.pixels.as_ptr(),
            view.pixels.len(),
            palette.as_ptr(),
            palette.len(),
            view.w,
            view.h,
            view.psm,
        )
    };
    if pixel_len != 8 || palette_len != 1024 || width != 4 || height != 2 {
        return 7;
    }

    let owner = alloc::boxed::Box::into_raw(alloc::boxed::Box::new(ui));
    out.write(W06cProbeSummary {
        pixels,
        pixel_len,
        palette,
        palette_len,
        width,
        height,
        psm,
        draw_words,
        draw_len,
        owner: owner.cast(),
    });
    1
}

#[no_mangle]
pub unsafe extern "C" fn pocket_wii_probe_w06c_free(owner: *mut c_void) {
    if !owner.is_null() {
        drop(alloc::boxed::Box::from_raw(owner.cast::<Ui>()));
    }
}
