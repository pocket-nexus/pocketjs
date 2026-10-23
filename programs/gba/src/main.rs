#![no_std]
#![no_main]

extern crate alloc;

use alloc::{boxed::Box, rc::Rc};
use core::cell::Cell;
use core::{
    alloc::{GlobalAlloc, Layout},
    cell::UnsafeCell,
    ptr::{addr_of_mut, read_volatile, write_volatile},
};
use linked_list_allocator::Heap;
use microts::{
    runtime::{AotApp, AotGuest},
    Input, Ui,
};
use pocket_drivers::{InputClasses, InputFrameBuilder, InputSource};
use pocket_runtime::{GuestEnvironment, GuestFrame, Runtime, RuntimeConfig, RuntimeError};
mod presentation;
mod scene;
#[allow(dead_code)] // The export defines every fact; the ROM reads some.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}
include!(concat!(env!("GBA_GENERATED"), "/include.rs"));
core::arch::global_asm!(include_str!("start.s"));
use generated::AppViewModel;

struct GbaCriticalSection;
critical_section::set_impl!(GbaCriticalSection);
unsafe impl critical_section::Impl for GbaCriticalSection {
    unsafe fn acquire() -> bool {
        let enabled = read_volatile(0x04000208 as *const u16) != 0;
        reg(0x04000208, 0);
        core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
        enabled
    }
    unsafe fn release(enabled: bool) {
        core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
        reg(0x04000208, enabled as u16);
    }
}

// Only the main thread allocates. The IRQ handler owns the VBlank counter
// and the producer side of the fixed-capacity input queue.
struct Allocator(UnsafeCell<Heap>);
unsafe impl Sync for Allocator {}
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let heap = &mut *self.0.get();
        let result = heap
            .allocate_first_fit(layout)
            .map_or_else(|_| fail(5), |p| p.as_ptr());
        diag(8, heap.used() as u32);
        diag(9, diagnostic(9).max(heap.used() as u32));
        result
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let heap = &mut *self.0.get();
        heap.deallocate(core::ptr::NonNull::new_unchecked(ptr), layout);
        diag(8, heap.used() as u32);
    }
}
#[global_allocator]
static ALLOCATOR: Allocator = Allocator(UnsafeCell::new(Heap::empty()));

unsafe fn reg(address: usize, value: u16) {
    write_volatile(address as *mut u16, value);
}
unsafe fn diagnostic(index: usize) -> u32 {
    read_volatile((0x02000000 + index * 4) as *const u32)
}
unsafe fn diag(index: usize, value: u32) {
    write_volatile((0x02000000 + index * 4) as *mut u32, value);
}
unsafe fn cycles() -> u32 {
    loop {
        let hi = read_volatile(0x04000104 as *const u16) as u32;
        let lo = read_volatile(0x04000100 as *const u16) as u32;
        if hi == read_volatile(0x04000104 as *const u16) as u32 {
            return (hi << 16) | lo;
        }
    }
}
fn fail(code: u32) -> ! {
    unsafe {
        diag(13, code);
        diag(2, 0xdead);
        reg(0x04000000, 0x0403);
        write_volatile(0x06000000 as *mut u16, 31);
    }
    loop {
        core::hint::spin_loop();
    }
}
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    unsafe {
        diag(16, info.location().map_or(0, |location| location.line()));
    }
    fail(1)
}

type App = generated::AppApp<generated::AppModel>;
impl AotApp for Box<App> {
    #[inline(never)]
    fn mount(mut ui: Ui, environment: &GuestEnvironment<'_>) -> Result<Self, RuntimeError> {
        assert_eq!(environment.viewport, [240, 160]);
        assert_eq!(environment.tick_hz, 30);
        assert!(ui.load_styles(include_bytes!(concat!(
            env!("GBA_GENERATED"),
            "/styles.bin"
        ))));
        // Pixels are consumed by the offline BG/OBJ bake.
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

#[no_mangle]
pub unsafe extern "C" fn gba_main() -> ! {
    extern "C" {
        static mut __heap_start: u8;
        static mut __heap_end: u8;
        fn gba_irq();
    }
    for i in 0..64 {
        diag(i, 0);
    }
    diag(0, 0x50474241);
    diag(1, 2);
    diag(2, 1);
    reg(0x04000000, 0x0080); // Forced blank until first complete frame.
    reg(0x04000204, 0x4317); // ROM waitstates + instruction prefetch.
    let start = addr_of_mut!(__heap_start);
    let length = addr_of_mut!(__heap_end) as usize - start as usize;
    diag(21, length as u32);
    (*ALLOCATOR.0.get()).init(start, length);
    write_volatile(0x03007ffc as *mut usize, gba_irq as *const () as usize);
    reg(0x04000004, 8);
    reg(0x04000200, 1);
    reg(0x04000208, 1);
    reg(0x04000100, 0);
    reg(0x04000104, 0);
    reg(0x04000106, 0x84);
    reg(0x04000102, 0x80);
    let mut runtime = Runtime::new(RuntimeConfig {
        profile_hash: profile::PROFILE_HASH,
        host_abi: profile::HOST_ABI,
        heap_limit: length,
        frame_buffer_budget: 0,
        profile: profile::profile().unwrap(),
    })
    .unwrap();
    let (guest, app) = AotGuest::<Box<App>>::new();
    runtime.set_guest(Box::new(guest)).unwrap();
    let input = Rc::new(Cell::new(0));
    runtime
        .add_input_source(Box::new(Buttons(input.clone())))
        .unwrap();
    let frame = presentation::PreparedFrame::new();
    let renderer = runtime
        .add_renderer(presentation::CompiledRenderer(frame.clone()))
        .unwrap();
    runtime
        .add_display(presentation::Lcd(frame.clone()), renderer)
        .unwrap();
    runtime
        .boot_aot_deferred(profile::PROFILE_HASH, [240, 160], false)
        .unwrap();
    runtime.skip_presentation().unwrap();
    let mut scene = Box::new(scene::Scene::new(
        app.borrow().as_ref().unwrap().ui(),
        frame.clone(),
    ));
    frame.borrow_mut().deadline = diagnostic(4).wrapping_add(2);
    diag(2, 2);
    let mut keys = 0;
    loop {
        let begin = cycles();
        let consumed = diagnostic(23);
        if consumed != diagnostic(22) {
            keys = diagnostic(32 + (consumed & 15) as usize);
            diag(23, consumed.wrapping_add(1));
        }
        diag(11, keys);
        let mut buttons = 0;
        if keys & 1 != 0 {
            buttons |= microts::spec::btn::CIRCLE;
        }
        if keys & 2 != 0 {
            buttons |= microts::spec::btn::CROSS;
        }
        if keys & 0x40 != 0 {
            buttons |= microts::spec::btn::UP;
        }
        if keys & 0x80 != 0 {
            buttons |= microts::spec::btn::DOWN;
        }
        input.set(buttons);
        runtime.advance().unwrap();
        let model_end = cycles();
        {
            let mut state = app.borrow_mut();
            let app = state.as_mut().unwrap();
            diag(10, app.model.count() as u32);
            app.ui_mut().core_mut().draw();
            scene.update(app.ui());
        }
        scene.prepare();
        // Words 28.. publish each layer's state in plan order (branch index,
        // visibility, size value, color bits, glyph count).
        for (index, value) in scene.state.iter().enumerate().take(16) {
            diag(28 + index, *value);
        }
        diag(31, scene.faults);
        // Scan from the bottom so unused gaps inside stack frames cannot
        // hide deeper writes. The watermark survives returns from functions.
        if diagnostic(3) & 31 == 0 {
            let mut low = 0x03000000usize;
            while low < 0x03007f00 && read_volatile(low as *const u32) == 0xdeadbeef {
                low += 4;
            }
            diag(20, (0x03007f00 - low) as u32);
        }
        if diagnostic(20) > 0x7e00 || read_volatile(0x03000000 as *const u32) != 0xdeadbeef {
            fail(4);
        }
        let end = cycles();
        diag(14, model_end.wrapping_sub(begin));
        diag(15, end.wrapping_sub(model_end));
        diag(17, model_end.wrapping_sub(begin));
        diag(18, 0);
        diag(5, end.wrapping_sub(begin));
        diag(6, diagnostic(6).max(end.wrapping_sub(begin)));
        diag(12, scene::art::OAM_SLOTS_USED as u32);
        runtime.present().unwrap();
        diag(3, diagnostic(3) + 1);
        diag(2, 3);
    }
}
