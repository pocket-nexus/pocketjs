//! MicroTS Hero for the iPod nano 2G under Rockbox.
//!
//! The generated app, the retained core and the RGB565 rasterizer run inside
//! one Rockbox plugin. The plugin owns a persistent 176 × 132 framebuffer;
//! Runtime presents through its software renderer and LCD DisplayOutput;
//! the C side copies the resulting damage rectangles to the LCD.
//! The host preview links this crate with `std` and the layout oracle.

#![cfg_attr(target_os = "none", no_std)]

extern crate alloc;

use alloc::{boxed::Box, rc::Rc, vec, vec::Vec};
use core::cell::{Cell, RefCell, UnsafeCell};
use microts::{
    pocketjs_core::damage::DamageRect,
    runtime::{AotApp, AotGuest, AppState},
    Input, Ui,
};
use pocket_drivers::*;
use pocket_runtime::{
    GuestEnvironment, GuestFrame, RendererId, Runtime, RuntimeConfig, RuntimeError,
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

impl AotApp for Box<App> {
    #[inline(never)]
    fn mount(mut ui: Ui, environment: &GuestEnvironment<'_>) -> Result<Self, RuntimeError> {
        assert_eq!(environment.viewport, [WIDTH as u32, HEIGHT as u32]);
        assert_eq!(environment.tick_hz, TICK_HZ);
        assert!(ui.load_styles(include_bytes!(concat!(
            env!("IPODNANO_GENERATED"),
            "/styles.bin"
        ))));
        load_fonts(&mut ui);
        load_images(&mut ui);
        let mut app = Box::new(App::new(
            ui,
            generated::AppProps {},
            generated::AppModel::default(),
        ));
        let first = app.ui().initial_focus();
        app.ui_mut().set_focus(first);
        Ok(app)
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        App::frame(self, &Input::buttons(frame.buttons));
        Ok(())
    }
}
struct Buttons(Rc<Cell<u32>>);
impl InputSource for Buttons {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS
    }
    fn poll(&mut self, frame: &mut InputFrameBuilder) {
        frame.buttons |= self.0.get();
    }
}

// The allocation is fixed for Hero's lifetime. Its only writer is the private
// display, called by Runtime during &mut Hero::frame. Hero::pixels borrows
// &Hero, which excludes that call. Neither storage nor display escapes Hero.
struct Pixels(UnsafeCell<Vec<u16>>);
struct Lcd {
    pixels: Rc<Pixels>,
    damage: Rc<RefCell<Vec<DamageRect>>>,
}
impl DisplayOutput for Lcd {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            WIDTH as u32,
            HEIGHT as u32,
            PixelFormat::Rgb565,
            WIDTH * 2,
            TargetOwnership::CpuVisible,
        );
        descriptor.partial_refresh = true;
        descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: 0,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if region.width == 0
            || region.height == 0
            || region
                .x
                .checked_add(region.width)
                .is_none_or(|end| end > WIDTH as u32)
            || region
                .y
                .checked_add(region.height)
                .is_none_or(|end| end > HEIGHT as u32)
        {
            return Err(DisplayError::InvalidTarget);
        }
        let offset = region.y as usize * WIDTH + region.x as usize;
        let pixels = unsafe { &mut *self.pixels.0.get() };
        let bytes = unsafe {
            core::slice::from_raw_parts_mut(
                pixels.as_mut_ptr().add(offset).cast(),
                (pixels.len() - offset) * 2,
            )
        };
        Ok(Target::CpuVisible(Surface::new(
            bytes,
            region,
            WIDTH * 2,
            PixelFormat::Rgb565,
        )?))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<(), DisplayError> {
        self.damage
            .borrow_mut()
            .extend(regions.iter().map(|r| DamageRect {
                x0: r.x as i32,
                y0: r.y as i32,
                x1: (r.x + r.width) as i32,
                y1: (r.y + r.height) as i32,
            }));
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}

pub struct Hero {
    runtime: Runtime,
    app: AppState<Box<App>>,
    buttons: Rc<Cell<u32>>,
    pixels: Rc<Pixels>,
    flushed: Rc<RefCell<Vec<DamageRect>>>,
    damage: [DamageRect; MAX_REGIONS],
    damage_len: usize,
}
impl Hero {
    pub fn new() -> Self {
        let profile = br#"{"capabilities":[],"display":{"logicalViewports":[[176,132]],"physicalViewport":[176,132],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"ipodnano","platform":"rockbox","tickHz":30}"#;
        let mut runtime = Runtime::new(RuntimeConfig {
            profile_hash: pocket_package::sha256::sha256(profile),
            profile_json: profile.to_vec(),
            host_abi: pocket_spec::BINDING_GENERATION,
            tick_hz: TICK_HZ,
            heap_limit: 4 * 1024 * 1024,
            frame_buffer_budget: WIDTH * HEIGHT * 2,
        })
        .unwrap();
        let (guest, app) = AotGuest::<Box<App>>::new();
        runtime.set_guest(Box::new(guest)).unwrap();
        let buttons = Rc::new(Cell::new(0));
        runtime
            .add_input_source(Box::new(Buttons(buttons.clone())))
            .unwrap();
        let pixels = Rc::new(Pixels(UnsafeCell::new(vec![0; WIDTH * HEIGHT])));
        let flushed = Rc::new(RefCell::new(Vec::new()));
        runtime
            .add_display(
                Lcd {
                    pixels: pixels.clone(),
                    damage: flushed.clone(),
                },
                RendererId::SOFTWARE,
            )
            .unwrap();
        runtime
            .boot_aot_deferred(
                pocket_package::sha256::sha256(profile),
                [WIDTH as u32, HEIGHT as u32],
                false,
            )
            .unwrap();
        runtime.skip_presentation().unwrap();
        Self {
            runtime,
            app,
            buttons,
            pixels,
            flushed,
            damage: [DamageRect::empty(); MAX_REGIONS],
            damage_len: 0,
        }
    }
    /// One 30 Hz guest turn, one core tick and a terminal presentation.
    pub fn frame(&mut self, rockbox_buttons: u32) -> &[DamageRect] {
        self.buttons.set(buttons(rockbox_buttons));
        self.flushed.borrow_mut().clear();
        self.runtime.tick().expect("AOT Runtime frame");
        let damage = self.flushed.borrow();
        if damage.len() > MAX_REGIONS {
            self.damage[0] = DamageRect {
                x0: 0,
                y0: 0,
                x1: WIDTH as i32,
                y1: HEIGHT as i32,
            };
            self.damage_len = 1;
        } else {
            self.damage_len = damage.len();
            self.damage[..self.damage_len].copy_from_slice(&damage);
        }
        &self.damage[..self.damage_len]
    }
    pub fn pixels(&self) -> &[u16] {
        unsafe { &*self.pixels.0.get() }
    }
    pub fn count(&self) -> i32 {
        self.app.borrow().as_ref().unwrap().model.count()
    }
    #[cfg(feature = "counters")]
    pub fn assert_layout(&self) {
        let mut state = self.app.borrow_mut();
        let mismatches = state
            .as_mut()
            .unwrap()
            .ui_mut()
            .core_mut()
            .layout_mismatches();
        assert!(
            mismatches.is_empty(),
            "baked layout differs from full-tree solve: {mismatches:?}"
        );
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
            rects[index * 4..index * 4 + 4].copy_from_slice(&[
                rect.x0,
                rect.y0,
                rect.x1 - rect.x0,
                rect.y1 - rect.y0,
            ]);
        }
        damage.len() as i32
    }

    #[no_mangle]
    pub unsafe extern "C" fn pockethero_pixels() -> *const u16 {
        (*core::ptr::addr_of!(HERO))
            .as_ref()
            .unwrap()
            .pixels()
            .as_ptr()
    }

    #[no_mangle]
    pub unsafe extern "C" fn pockethero_count() -> i32 {
        (*core::ptr::addr_of!(HERO)).as_ref().map_or(0, Hero::count)
    }

    #[no_mangle]
    pub unsafe extern "C" fn pockethero_heap_peak() -> u32 {
        PEAK as u32
    }

    /// Stop the guest and drop Runtime while the audio-buffer heap is valid.
    #[no_mangle]
    pub unsafe extern "C" fn pockethero_stop() {
        drop((*core::ptr::addr_of_mut!(HERO)).take());
    }
}
