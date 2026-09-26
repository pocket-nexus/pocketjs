#![no_std]
#![no_main]
#![feature(alloc_error_handler)]

extern crate alloc;

use core::{
    alloc::{GlobalAlloc, Layout},
    cell::UnsafeCell,
    ptr::{addr_of_mut, read_volatile, write_volatile},
};
use linked_list_allocator::Heap;
use microts::{Input, Ui};
mod scene;
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
            .map_or(core::ptr::null_mut(), |p| p.as_ptr());
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

#[alloc_error_handler]
fn out_of_memory(_: Layout) -> ! {
    fail(5)
}

// Keep construction temporaries out of the rendering loop's stack frame.
#[inline(never)]
fn mount() -> alloc::boxed::Box<generated::AppApp<generated::AppModel>> {
    let mut ui = Ui::new();
    ui.core_mut().set_viewport(240.0, 160.0);
    assert!(ui.core_mut().set_tick_rate(30));
    assert!(ui.load_styles(include_bytes!(concat!(
        env!("GBA_GENERATED"),
        "/styles.bin"
    ))));
    // Font pixels and metrics are consumed by the offline bake, not this presenter.
    alloc::boxed::Box::new(generated::AppApp::new(
        ui,
        generated::AppProps {},
        generated::AppModel::default(),
    ))
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
    let mut app = mount();
    fn named(ui: &Ui, node: i32, name: &str) -> Option<microts::NodeId> {
        let id = microts::NodeId(node);
        if ui.debug_name(id) == Some(name) {
            return Some(id);
        }
        ui.core()
            .node_children(node)
            .iter()
            .find_map(|child| named(ui, *child, name))
    }
    let button = named(app.ui(), microts::NodeId::ROOT.0, "HeroAction").unwrap();
    app.ui_mut().set_focus(button);
    let underline = app.model.underline().get().unwrap();
    let mut scene = alloc::boxed::Box::new(scene::Scene::new());
    diag(2, 2);
    let mut deadline = diagnostic(4) + 2;
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
        app.frame(&Input::buttons(buttons));
        let model_end = cycles();
        diag(10, app.model.count() as u32);
        let style = app.ui().core().resolved_style(underline.0).unwrap();
        let color = app.ui().core().resolved_style(button.0).unwrap().bg_color;
        scene.update(
            app.model.count(),
            app.model.phase(),
            style.width,
            style.translate_x,
            color,
        );
        diag(28, app.model.phase() as u32);
        diag(29, (style.width + 0.5) as u32);
        diag(30, color);
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
        diag(12, 35);
        // Always wait for a future VBlank edge, including an overrun.
        if diagnostic(4).wrapping_sub(deadline) as i32 >= 0 {
            diag(7, diagnostic(7).wrapping_add(1));
            deadline = diagnostic(4).wrapping_add(1);
        }
        while (diagnostic(4).wrapping_sub(deadline) as i32) < 0 {
            core::hint::spin_loop();
        }
        let transfer_begin = cycles();
        let transferred = scene.present() as u32;
        diag(19, cycles().wrapping_sub(transfer_begin));
        diag(26, transferred);
        diag(27, diagnostic(27).max(transferred));
        diag(3, diagnostic(3) + 1);
        diag(2, 3);
        deadline = deadline.wrapping_add(2);
    }
}
