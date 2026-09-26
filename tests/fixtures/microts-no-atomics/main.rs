#![no_std]
#![no_main]

use core::{
    alloc::{GlobalAlloc, Layout},
    hint::black_box,
};
use microts::model::{heapless::spsc::Queue, next_region};

// This binary never allocates. The linked no_std runtime requires an allocator.
struct NoAllocation;
unsafe impl GlobalAlloc for NoAllocation {
    unsafe fn alloc(&self, _: Layout) -> *mut u8 {
        core::ptr::null_mut()
    }
    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}
#[global_allocator]
static ALLOCATOR: NoAllocation = NoAllocation;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {
        core::hint::spin_loop();
    }
}

// ARMv4T single-core, privileged host policy. Saving the prior masks makes
// nested critical sections restore the interrupt state of their caller.
#[cfg(feature = "critical-section-impl")]
mod host {
    struct ArmCriticalSection;
    critical_section::set_impl!(ArmCriticalSection);

    unsafe impl critical_section::Impl for ArmCriticalSection {
        #[instruction_set(arm::a32)]
        unsafe fn acquire() -> critical_section::RawRestoreState {
            let previous;
            unsafe {
                core::arch::asm!(
                    "mrs {previous}, cpsr",
                    "orr {masked}, {previous}, #0xc0",
                    "msr cpsr_c, {masked}",
                    previous = out(reg) previous,
                    masked = out(reg) _,
                    // Memory clobbers prevent accesses crossing the boundary.
                    options(nostack, preserves_flags),
                );
            }
            previous
        }

        #[instruction_set(arm::a32)]
        unsafe fn release(previous: critical_section::RawRestoreState) {
            unsafe {
                core::arch::asm!(
                    "msr cpsr_c, {previous}",
                    previous = in(reg) previous,
                    options(nostack, preserves_flags),
                );
            }
        }
    }
}

// Link entry only: this fixture has no vector table, stack setup, or boot ROM.
#[unsafe(no_mangle)]
pub extern "C" fn _start() -> ! {
    let first = next_region();
    let second = next_region();
    assert_ne!(first, second);
    let mut queue = Queue::<u32, 4>::new();
    let (mut producer, mut consumer) = black_box(&mut queue).split();
    producer.enqueue(first).unwrap();
    assert_eq!(consumer.dequeue(), Some(first));
    black_box(second);
    loop {
        core::hint::spin_loop();
    }
}
