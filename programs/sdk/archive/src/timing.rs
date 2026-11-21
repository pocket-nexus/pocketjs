//! The exported `pocket_tick_schedule_*` symbols over `pocket_runtime::abi`.
use pocket_drivers::abi::*;
use pocket_runtime::abi;

#[no_mangle]
pub extern "C" fn pocket_tick_schedule_create(
    tick_hz: u32,
    started: u64,
    max_lag_us: u64,
) -> *mut PocketTickSchedule {
    abi::pocket_tick_schedule_create(tick_hz, started, max_lag_us)
}
/// # Safety
/// Schedule is live on this thread and out points to writable u64 storage.
#[no_mangle]
pub unsafe extern "C" fn pocket_tick_schedule_deadline(
    schedule: *const PocketTickSchedule,
    out: *mut u64,
) -> i32 {
    unsafe { abi::pocket_tick_schedule_deadline(schedule, out) }
}
/// # Safety
/// Schedule is live on this thread. out provides its declared writable prefix;
/// ready provides writable u32 storage. Output buffers do not overlap each other
/// or the schedule allocation.
#[no_mangle]
pub unsafe extern "C" fn pocket_tick_schedule_poll(
    schedule: *mut PocketTickSchedule,
    now: u64,
    out: *mut PocketTickTiming,
    ready: *mut u32,
) -> i32 {
    unsafe { abi::pocket_tick_schedule_poll(schedule, now, out, ready) }
}
/// # Safety
/// Schedule was returned by create, has not been destroyed and is not in use.
#[no_mangle]
pub unsafe extern "C" fn pocket_tick_schedule_destroy(schedule: *mut PocketTickSchedule) {
    unsafe { abi::pocket_tick_schedule_destroy(schedule) }
}
