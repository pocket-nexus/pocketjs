//! The `pocket_tick_schedule_*` bodies over [`crate::timing::TickSchedule`].
use crate::timing::TickSchedule;
use alloc::boxed::Box;
use core::ptr;
use pocket_drivers::abi::{
    PocketTickSchedule, PocketTickTiming, POCKET_STATUS_FAILED, POCKET_STATUS_INVALID,
    POCKET_STATUS_OK,
};

/// A null result is a rejected rate or lag budget.
pub fn pocket_tick_schedule_create(
    tick_hz: u32,
    started: u64,
    max_lag_us: u64,
) -> *mut PocketTickSchedule {
    match TickSchedule::new(tick_hz, started, max_lag_us) {
        Ok(schedule) => Box::into_raw(Box::new(schedule)).cast(),
        Err(_) => ptr::null_mut(),
    }
}
/// # Safety
/// Schedule is live on this thread and out points to writable u64 storage.
pub unsafe fn pocket_tick_schedule_deadline(
    schedule: *const PocketTickSchedule,
    out: *mut u64,
) -> i32 {
    let Some(schedule) = (unsafe { schedule.cast::<TickSchedule>().as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    if out.is_null() {
        return POCKET_STATUS_INVALID;
    }
    match schedule.deadline() {
        Ok(deadline) => {
            unsafe {
                out.write_unaligned(deadline);
            }
            POCKET_STATUS_OK
        }
        Err(_) => POCKET_STATUS_FAILED,
    }
}
/// # Safety
/// Schedule is live on this thread. out provides its declared writable prefix;
/// ready provides writable u32 storage. Output buffers do not overlap each other
/// or the schedule allocation.
pub unsafe fn pocket_tick_schedule_poll(
    schedule: *mut PocketTickSchedule,
    now: u64,
    out: *mut PocketTickTiming,
    ready: *mut u32,
) -> i32 {
    let Some(schedule) = (unsafe { schedule.cast::<TickSchedule>().as_mut() }) else {
        return POCKET_STATUS_INVALID;
    };
    if ready.is_null() {
        return POCKET_STATUS_INVALID;
    }
    unsafe {
        ready.write_unaligned(0);
    }
    if !unsafe { PocketTickTiming::empty().write_prefix(out) } {
        return POCKET_STATUS_INVALID;
    }
    match schedule.poll(now) {
        Ok(Some(tick)) => {
            let result = PocketTickTiming {
                index: tick.index,
                deadline: tick.deadline,
                skipped: tick.skipped,
                ..PocketTickTiming::empty()
            };
            unsafe {
                result.write_prefix(out);
                ready.write_unaligned(1);
            }
            POCKET_STATUS_OK
        }
        Ok(None) => POCKET_STATUS_OK,
        Err(_) => POCKET_STATUS_FAILED,
    }
}
/// # Safety
/// Schedule was returned by create, has not been destroyed and is not in use.
pub unsafe fn pocket_tick_schedule_destroy(schedule: *mut PocketTickSchedule) {
    if !schedule.is_null() {
        unsafe {
            drop(Box::from_raw(schedule.cast::<TickSchedule>()));
        }
    }
}
