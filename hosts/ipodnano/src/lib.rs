//! MicroTS Hero for the iPod nano 2G under Rockbox.
//!
//! The generated app, the retained core and the RGB565 rasterizer run inside
//! one Rockbox plugin. The plugin owns a persistent 176 × 132 framebuffer;
//! each frame the damage tracker returns the rectangles whose DrawList
//! operations changed, and the C side copies only those to the LCD.
//! The host preview links this crate with `std` and the layout oracle.

#![cfg_attr(target_os = "none", no_std)]

extern crate alloc;

use alloc::{boxed::Box, vec, vec::Vec};
use microts::{
    pocketjs_core::{
        damage::{DamagePolicy, DamageRect, DamageTracker},
        raster,
    },
    Input, Ui,
};

include!(concat!(env!("IPODNANO_GENERATED"), "/include.rs"));
use generated::AppViewModel;

pub const WIDTH: usize = 176;
pub const HEIGHT: usize = 132;
pub const TICK_HZ: u32 = 30;
pub const MAX_REGIONS: usize = 8;

/// Rockbox `button-target.h` bits for the nano 2G. The plugin passes
/// `button_status()` plus the wheel events it drained this frame.
pub mod button {
    pub const SELECT: u32 = 0x01;
    pub const MENU: u32 = 0x02;
    pub const LEFT: u32 = 0x04;
    pub const RIGHT: u32 = 0x08;
    pub const SCROLL_FWD: u32 = 0x10;
    pub const SCROLL_BACK: u32 = 0x20;
    pub const PLAY: u32 = 0x40;
}

pub type App = generated::AppApp<generated::AppModel>;

/// The iPod nano mapping shared with the Pocket Stage profile and the MicroTS
/// playground: center CIRCLE, wheel UP/DOWN, previous/next LEFT/RIGHT,
/// Play/Pause START. MENU leaves the plugin and never reaches the app.
pub fn buttons(rockbox: u32) -> u32 {
    use microts::spec::btn;
    let mut out = 0;
    if rockbox & button::SELECT != 0 {
        out |= btn::CIRCLE;
    }
    if rockbox & button::PLAY != 0 {
        out |= btn::START;
    }
    if rockbox & button::LEFT != 0 {
        out |= btn::LEFT;
    }
    if rockbox & button::RIGHT != 0 {
        out |= btn::RIGHT;
    }
    if rockbox & button::SCROLL_BACK != 0 {
        out |= btn::UP;
    }
    if rockbox & button::SCROLL_FWD != 0 {
        out |= btn::DOWN;
    }
    out
}

// Keep construction temporaries out of the frame loop's stack frame.
#[inline(never)]
fn mount() -> Box<App> {
    let mut ui = Ui::new();
    ui.core_mut().set_viewport(WIDTH as f32, HEIGHT as f32);
    assert!(ui.core_mut().set_tick_rate(TICK_HZ));
    assert!(ui.load_styles(include_bytes!(concat!(
        env!("IPODNANO_GENERATED"),
        "/styles.bin"
    ))));
    load_fonts(&mut ui);
    load_images(&mut ui);
    let mut app = Box::new(App::new(ui, generated::AppProps {}, generated::AppModel::default()));
    let first = app.ui().initial_focus();
    app.ui_mut().set_focus(first);
    app
}

pub struct Hero {
    pub app: Box<App>,
    pixels: Vec<u16>,
    tracker: DamageTracker<MAX_REGIONS>,
    damage: [DamageRect; MAX_REGIONS],
    damage_len: usize,
}

impl Hero {
    pub fn new() -> Self {
        Self {
            app: mount(),
            pixels: vec![0; WIDTH * HEIGHT],
            tracker: DamageTracker::new(),
            damage: [DamageRect::empty(); MAX_REGIONS],
            damage_len: 0,
        }
    }

    /// One 30 Hz tick: model, layout, DrawList, then the changed pixels.
    pub fn frame(&mut self, rockbox_buttons: u32) -> &[DamageRect] {
        self.app.frame(&Input::buttons(buttons(rockbox_buttons)));
        let core = self.app.ui_mut().core_mut();
        core.draw();
        let plan = raster::render_scaled_rgb565_incremental(
            core,
            &core.current_draw_list().words,
            &mut self.pixels,
            1,
            &mut self.tracker,
            DamagePolicy::default(),
        )
        .expect("DrawList damage plan");
        self.damage_len = plan.region_count();
        self.damage[..self.damage_len].copy_from_slice(plan.regions());
        &self.damage[..self.damage_len]
    }

    pub fn pixels(&self) -> &[u16] {
        &self.pixels
    }

    pub fn count(&self) -> i32 {
        self.app.model.count()
    }
}

impl Default for Hero {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "none")]
mod rockbox {
    //! The C ABI the plugin calls, plus the allocator and panic path.
    use super::{Hero, MAX_REGIONS};
    use core::{
        alloc::{GlobalAlloc, Layout},
        cell::UnsafeCell,
    };
    use linked_list_allocator::Heap;

    extern "C" {
        /// Shows the failure and long-jumps back to `plugin_start`.
        fn pockethero_fail(code: u32, line: u32) -> !;
    }

    // Rockbox threads are cooperative and no interrupt handler touches the
    // app, so a critical section has nothing to exclude.
    struct PluginCriticalSection;
    critical_section::set_impl!(PluginCriticalSection);
    unsafe impl critical_section::Impl for PluginCriticalSection {
        unsafe fn acquire() -> bool {
            false
        }
        unsafe fn release(_: bool) {}
    }

    struct Allocator(UnsafeCell<Heap>);
    unsafe impl Sync for Allocator {}
    unsafe impl GlobalAlloc for Allocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let heap = &mut *self.0.get();
            let result = heap
                .allocate_first_fit(layout)
                .map_or(core::ptr::null_mut(), |p| p.as_ptr());
            PEAK = PEAK.max(heap.used());
            result
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            (*self.0.get()).deallocate(core::ptr::NonNull::new_unchecked(ptr), layout);
        }
    }
    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator(UnsafeCell::new(Heap::empty()));
    static mut PEAK: usize = 0;
    static mut HERO: Option<Hero> = None;

    #[panic_handler]
    fn panic(info: &core::panic::PanicInfo) -> ! {
        let line = info.location().map_or(0, |location| location.line());
        unsafe { pockethero_fail(1, line) }
    }

    /// Mounts the app over `heap`. The plugin passes the audio buffer.
    #[no_mangle]
    pub unsafe extern "C" fn pockethero_start(heap: *mut u8, length: usize) {
        PEAK = 0;
        *ALLOCATOR.0.get() = Heap::empty();
        (*ALLOCATOR.0.get()).init(heap, length);
        *core::ptr::addr_of_mut!(HERO) = Some(Hero::new());
    }

    /// Runs one tick and writes up to `MAX_REGIONS` damage rectangles as
    /// `x, y, width, height`. Returns the rectangle count.
    #[no_mangle]
    pub unsafe extern "C" fn pockethero_frame(buttons: u32, rects: *mut i32) -> i32 {
        let hero = (*core::ptr::addr_of_mut!(HERO)).as_mut().unwrap();
        let damage = hero.frame(buttons);
        let rects = core::slice::from_raw_parts_mut(rects, MAX_REGIONS * 4);
        for (index, rect) in damage.iter().enumerate() {
            rects[index * 4..index * 4 + 4]
                .copy_from_slice(&[rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0]);
        }
        damage.len() as i32
    }

    #[no_mangle]
    pub unsafe extern "C" fn pockethero_pixels() -> *const u16 {
        (*core::ptr::addr_of!(HERO)).as_ref().unwrap().pixels().as_ptr()
    }

    #[no_mangle]
    pub unsafe extern "C" fn pockethero_count() -> i32 {
        (*core::ptr::addr_of!(HERO)).as_ref().map_or(0, Hero::count)
    }

    #[no_mangle]
    pub unsafe extern "C" fn pockethero_heap_peak() -> u32 {
        PEAK as u32
    }

    /// Drops the app without running destructors: the heap is the audio
    /// buffer, which Rockbox reclaims when the plugin returns.
    #[no_mangle]
    pub unsafe extern "C" fn pockethero_stop() {
        core::mem::forget((*core::ptr::addr_of_mut!(HERO)).take());
    }
}
