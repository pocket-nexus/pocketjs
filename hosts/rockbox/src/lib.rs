//! Rockbox plugin host: a staticlib that runs a MicroTS app and rasterizes it
//! into the plugin's RGB565 framebuffer. plugin/pocketjs.c owns the loop.

#![no_std]

extern crate alloc;

use alloc::{boxed::Box, string::String, vec::Vec};
use core::{
    alloc::{GlobalAlloc, Layout},
    cell::UnsafeCell,
    fmt::Write,
    ptr::{addr_of, addr_of_mut, NonNull},
    slice,
};
use linked_list_allocator::Heap;
use microts::{
    pocketjs_core::{
        damage::{DamagePolicy, DamageTracker},
        raster,
        spec::psm,
    },
    spec::btn,
    HasButton, HasRelativeAxis, Host, Input, Ui,
};

include!(concat!(env!("POCKETJS_GEN"), "/include.rs"));

/// ARMv4 rotates unaligned word loads instead of faulting.
#[repr(C, align(4))]
struct Aligned<B: ?Sized>(B);
static STYLES: &Aligned<[u8]> = &Aligned(*include_bytes!(concat!(env!("POCKETJS_GEN"), "/styles.bin")));

// Rockbox threads are cooperative and no interrupt handler touches Rust state.
struct RockboxCriticalSection;
critical_section::set_impl!(RockboxCriticalSection);
unsafe impl critical_section::Impl for RockboxCriticalSection {
    unsafe fn acquire() -> critical_section::RawRestoreState {}
    unsafe fn release(_: critical_section::RawRestoreState) {}
}

struct Allocator(UnsafeCell<Heap>);
unsafe impl Sync for Allocator {}
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        (*self.0.get())
            .allocate_first_fit(layout)
            .map_or(core::ptr::null_mut(), |p| p.as_ptr())
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        (*self.0.get()).deallocate(NonNull::new_unchecked(ptr), layout);
    }
}
#[global_allocator]
static ALLOCATOR: Allocator = Allocator(UnsafeCell::new(Heap::empty()));

extern "C" {
    fn pocketjs_host_panic(message: *const u8) -> !;
    fn pocketjs_host_usec() -> u32;
    /// Reads `path` under the plugin data directory; a null `buf` returns the file size.
    fn pocketjs_host_read(path: *const u8, buf: *mut u8, max: i32) -> i32;
}

struct PanicMessage {
    buf: [u8; 192],
    len: usize,
}
impl Write for PanicMessage {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        for &b in s.as_bytes() {
            if self.len + 1 < self.buf.len() {
                self.buf[self.len] = b;
                self.len += 1;
            }
        }
        Ok(())
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    let mut out = PanicMessage { buf: [0; 192], len: 0 };
    if let Some(location) = info.location() {
        let _ = write!(out, "{}:{} ", location.file(), location.line());
    }
    let _ = write!(out, "{}", info.message());
    unsafe { pocketjs_host_panic(out.buf.as_ptr()) }
}

// The host prebuilt `core` used by the simulator references the unwinding
// personality; panic = "abort" never calls it.
#[cfg(not(target_os = "none"))]
#[no_mangle]
extern "C" fn rust_eh_personality() {}

/// Every button, plus the click wheel as relative axis 0.
struct RockboxHost(Ui);
impl Host for RockboxHost {
    fn ui(&self) -> &Ui {
        &self.0
    }
    fn ui_mut(&mut self) -> &mut Ui {
        &mut self.0
    }
    fn into_ui(self) -> Ui {
        self.0
    }
}
impl<const MASK: u32> HasButton<MASK> for RockboxHost {}
impl HasRelativeAxis<0> for RockboxHost {}

static mut APP: Option<Box<App>> = None;
static mut DAMAGE: DamageTracker<8> = DamageTracker::new();
static mut TIMINGS: [u32; 3] = [0; 3];
/// Wheel steps not yet delivered as focus moves.
static mut FOCUS_STEPS: i32 = 0;

/// A Rockbox scroll event is 4 of the wheel's 96 positions.
const WHEEL_STEP_MILLIDEGREES: i32 = 15_000;

// Button bits from pocketjs.c, mapped to the docs/HIG.md intents.
const PJ_UP: u32 = 1;
const PJ_DOWN: u32 = 2;
const PJ_SELECT: u32 = 4;
const PJ_MENU: u32 = 8;
const PJ_LEFT: u32 = 16;
const PJ_RIGHT: u32 = 32;
const PJ_PLAY: u32 = 64;

fn to_btn(bits: u32) -> u32 {
    [
        (PJ_UP, btn::UP),
        (PJ_DOWN, btn::DOWN),
        (PJ_SELECT, btn::CIRCLE),
        (PJ_MENU, btn::CROSS),
        (PJ_LEFT, btn::LEFT),
        (PJ_RIGHT, btn::RIGHT),
        (PJ_PLAY, btn::START),
    ]
    .iter()
    .filter(|(pj, _)| bits & pj != 0)
    .fold(0, |acc, (_, b)| acc | b)
}

fn read_data(file: &str) -> Option<Vec<u8>> {
    let mut path = String::new();
    let _ = write!(path, "{APP_NAME}/{file}\0");
    let size = unsafe { pocketjs_host_read(path.as_ptr(), core::ptr::null_mut(), 0) };
    if size <= 0 {
        return None;
    }
    let mut buf = alloc::vec![0u8; size as usize];
    let read = unsafe { pocketjs_host_read(path.as_ptr(), buf.as_mut_ptr(), size) };
    (read == size).then_some(buf)
}

fn load_assets(ui: &mut Ui) -> bool {
    for &slot in FONT_SLOTS {
        let mut file = String::new();
        let _ = write!(file, "font-{slot}.bin");
        match read_data(&file) {
            Some(atlas) if ui.core_mut().load_font_atlas(&atlas) => {}
            _ => return false,
        }
    }
    for &(src, file, w, h) in IMAGES {
        let Some(rgba) = read_data(file) else {
            return false;
        };
        let id = ui.core_mut().upload_texture(&rgba, w, h, psm::PSM_8888);
        if id < 0 {
            return false;
        }
        ui.register_image(src, id);
    }
    true
}

/// Returns 0, or -1 for invalid styles and -2 for a missing font or image.
#[no_mangle]
pub unsafe extern "C" fn pocketjs_init(heap: *mut u8, heap_len: usize, w: i32, h: i32) -> i32 {
    (*ALLOCATOR.0.get()).init(heap, heap_len);
    let mut ui = Ui::new();
    ui.core_mut().set_viewport(w as f32, h as f32);
    // Busy frames are 3 Rockbox ticks (33.3 Hz).
    ui.core_mut().set_tick_rate(33);
    if !ui.load_styles(&STYLES.0) {
        return -1;
    }
    if !load_assets(&mut ui) {
        return -2;
    }
    APP = Some(Box::new(AppApp::new(RockboxHost(ui), app_props(), AppModel::default())));
    0
}

/// Advances one tick and repaints the damaged parts of `fb`, which must keep
/// its pixels between calls. Writes up to 8 `[x, y, w, h]` rectangles to
/// `rects` and returns their count.
#[no_mangle]
pub unsafe extern "C" fn pocketjs_frame(
    fb: *mut u16,
    w: i32,
    h: i32,
    buttons: u32,
    wheel: i32,
    rects: *mut [i32; 4],
) -> i32 {
    let Some(app) = (*addr_of_mut!(APP)).as_mut() else {
        return 0;
    };
    // The wheel moves focus one step per frame, like the d-pad.
    let steps = &mut *addr_of_mut!(FOCUS_STEPS);
    *steps = steps.saturating_add(wheel);
    let pressed = match steps.signum() {
        1 => btn::DOWN,
        -1 => btn::UP,
        _ => 0,
    };
    *steps -= steps.signum();
    let t0 = pocketjs_host_usec();
    app.frame(&Input {
        buttons: to_btn(buttons),
        pressed,
        axis_deltas: [wheel.saturating_mul(WHEEL_STEP_MILLIDEGREES), 0],
        ..Input::default()
    });
    let t1 = pocketjs_host_usec();
    let core = app.ui_mut().core_mut();
    core.draw();
    let t2 = pocketjs_host_usec();
    let fb = slice::from_raw_parts_mut(fb, (w * h) as usize);
    let tracker = &mut *addr_of_mut!(DAMAGE);
    let words = &core.current_draw_list().words;
    let count = match raster::render_scaled_rgb565_incremental(&*core, words, fb, 1, tracker, DamagePolicy::default()) {
        Ok(plan) => {
            for (i, r) in plan.regions().iter().enumerate() {
                *rects.add(i) = [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
            }
            plan.regions().len() as i32
        }
        Err(_) => {
            raster::render_scaled_rgb565(&*core, words, fb, 1);
            tracker.invalidate();
            *rects = [0, 0, w, h];
            1
        }
    };
    TIMINGS = [t1.wrapping_sub(t0), t2.wrapping_sub(t1), pocketjs_host_usec().wrapping_sub(t2)];
    count
}

/// Repaints the whole framebuffer on the next frame.
#[no_mangle]
pub unsafe extern "C" fn pocketjs_invalidate() {
    (*addr_of_mut!(DAMAGE)).invalidate();
}

/// Copies the last frame's model, draw and raster times in µs to `out[0..3]`.
#[no_mangle]
pub unsafe extern "C" fn pocketjs_timings(out: *mut u32) {
    core::ptr::copy_nonoverlapping(addr_of!(TIMINGS) as *const u32, out, 3);
}
