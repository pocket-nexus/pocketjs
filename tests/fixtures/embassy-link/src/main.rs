#![no_std]
#![no_main]
extern crate alloc;

use core::{
    alloc::{GlobalAlloc, Layout},
    future::Future,
    sync::atomic::{AtomicUsize, Ordering},
    task::{Context, Waker},
};
#[path = "../../embassy-host/src/fixture.rs"]
mod program;
use pocket_embassy::display::{Frame, Transport};

// Link-only fixture: this arena and inert clock are not a board support package.
struct Bump;
#[repr(align(64))]
struct Storage([u8; 512 * 1024]);
static mut STORAGE: Storage = Storage([0; 512 * 1024]);
static NEXT: AtomicUsize = AtomicUsize::new(0);
#[global_allocator]
static ALLOCATOR: Bump = Bump;
unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let base = unsafe { (&raw mut STORAGE.0).cast::<u8>() as usize };
        let result = NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |offset| {
            let start = (base + offset + layout.align() - 1) & !(layout.align() - 1);
            let end = start.checked_add(layout.size())?.checked_sub(base)?;
            (end <= 512 * 1024).then_some(end)
        });
        result.map_or(core::ptr::null_mut(), |offset| {
            ((base + offset + layout.align() - 1) & !(layout.align() - 1)) as *mut u8
        })
    }
    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}
struct Clock;
embassy_time_driver::time_driver_impl!(static CLOCK: Clock = Clock);
impl embassy_time_driver::Driver for Clock {
    fn now(&self) -> u64 {
        0
    }
    fn schedule_wake(&self, _: u64, _: &Waker) {}
}
struct Critical;
critical_section::set_impl!(Critical);
unsafe impl critical_section::Impl for Critical {
    unsafe fn acquire() -> critical_section::RawRestoreState {}
    unsafe fn release(_: critical_section::RawRestoreState) {}
}
struct Screen;
impl Transport for Screen {
    type Error = ();
    async fn write(&mut self, frame: Frame<'_>) -> Result<(), ()> {
        core::hint::black_box(frame.pixels);
        Ok(())
    }
}
#[unsafe(no_mangle)]
extern "C" fn _start() -> ! {
    let (mut runtime, mut presenter) =
        program::program(program::SCRIPT, pocket_drivers::spec::BINDING_GENERATION);
    runtime.boot().unwrap();
    let timing = runtime.timing().unwrap();
    let mut ticker = pocket_embassy::runner::Ticker::new(timing, 100_000).unwrap();
    {
        let mut next = core::pin::pin!(ticker.next());
        let _ = core::hint::black_box(next.as_mut().poll(&mut Context::from_waker(Waker::noop())));
    }
    let mut screen = Screen;
    let mut future = core::pin::pin!(presenter.present(&mut screen));
    let _ = core::hint::black_box(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
    );
    loop {
        core::hint::spin_loop();
    }
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {
        core::hint::spin_loop();
    }
}
