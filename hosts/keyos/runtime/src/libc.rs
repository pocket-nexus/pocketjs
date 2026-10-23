//! The Rust half of the KeyOS libc shim (../libc/libc.c holds the C half).
//!
//! QuickJS allocates through malloc/realloc/free; each block carries an
//! 8-byte header with its size so free and realloc can rebuild the Rust
//! layout. Clocks read std's Instant and SystemTime. Output written to stdout
//! and stderr reaches the `log` crate.

use core::ffi::{c_char, c_int, c_long, c_void};
use std::alloc::{Layout, alloc, dealloc, realloc as rust_realloc};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::sync::OnceLock;

const HEADER: usize = 8;
const ALIGN: usize = 8;

fn layout(size: usize) -> Option<Layout> {
    Layout::from_size_align(size.checked_add(HEADER)?, ALIGN).ok()
}

unsafe fn base_of(ptr: *mut c_void) -> (*mut u8, usize) {
    let base = (ptr as *mut u8).sub(HEADER);
    (base, (base as *const usize).read())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn malloc(size: usize) -> *mut c_void {
    let Some(layout) = layout(size) else { return core::ptr::null_mut() };
    let base = alloc(layout);
    if base.is_null() {
        return core::ptr::null_mut();
    }
    (base as *mut usize).write(size);
    base.add(HEADER) as *mut c_void
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn calloc(count: usize, size: usize) -> *mut c_void {
    let Some(total) = count.checked_mul(size) else { return core::ptr::null_mut() };
    let ptr = malloc(total);
    if !ptr.is_null() {
        core::ptr::write_bytes(ptr as *mut u8, 0, total);
    }
    ptr
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void {
    if ptr.is_null() {
        return malloc(size);
    }
    let (base, old) = base_of(ptr);
    let (Some(old_layout), Some(_)) = (layout(old), layout(size)) else {
        return core::ptr::null_mut();
    };
    let grown = rust_realloc(base, old_layout, size + HEADER);
    if grown.is_null() {
        return core::ptr::null_mut();
    }
    (grown as *mut usize).write(size);
    grown.add(HEADER) as *mut c_void
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let (base, size) = base_of(ptr);
    dealloc(base, layout(size).unwrap());
}

#[repr(C)]
pub struct Timespec {
    tv_sec: i64,
    tv_nsec: c_long,
}

#[repr(C)]
pub struct Timeval {
    tv_sec: i64,
    tv_usec: c_long,
}

#[repr(C)]
pub struct Tm {
    tm_sec: c_int,
    tm_min: c_int,
    tm_hour: c_int,
    tm_mday: c_int,
    tm_mon: c_int,
    tm_year: c_int,
    tm_wday: c_int,
    tm_yday: c_int,
    tm_isdst: c_int,
    tm_gmtoff: c_long,
    tm_zone: *const c_char,
}

fn boot() -> Instant {
    static BOOT: OnceLock<Instant> = OnceLock::new();
    *BOOT.get_or_init(Instant::now)
}

fn wall_clock() -> (i64, u32) {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (since.as_secs() as i64, since.subsec_nanos())
}

/// CLOCK_MONOTONIC counts from the first clock read; any other id reads the
/// wall clock.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn clock_gettime(clock: c_int, ts: *mut Timespec) -> c_int {
    let (sec, nsec) = if clock == 1 {
        let elapsed = boot().elapsed();
        (elapsed.as_secs() as i64, elapsed.subsec_nanos())
    } else {
        wall_clock()
    };
    ts.write(Timespec { tv_sec: sec, tv_nsec: nsec as c_long });
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn gettimeofday(tv: *mut Timeval, _tz: *mut c_void) -> c_int {
    let (sec, nsec) = wall_clock();
    tv.write(Timeval { tv_sec: sec, tv_usec: (nsec / 1000) as c_long });
    0
}

/// KeyOS has no time zone database here: local time is UTC.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn localtime_r(t: *const i64, out: *mut Tm) -> *mut Tm {
    let secs = t.read();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as c_int;
    // Civil-from-days (Howard Hinnant), proleptic Gregorian.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let jan1 = {
        let y = year - 1;
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + 306 - 719_468
    };
    out.write(Tm {
        tm_sec: rem % 60,
        tm_min: rem / 60 % 60,
        tm_hour: rem / 3600,
        tm_mday: day as c_int,
        tm_mon: month as c_int - 1,
        tm_year: (year - 1900) as c_int,
        tm_wday: (days + 4).rem_euclid(7) as c_int,
        tm_yday: (days - jan1) as c_int,
        tm_isdst: 0,
        tm_gmtoff: 0,
        tm_zone: c"UTC".as_ptr(),
    });
    out
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pocket_keyos_libc_write(stream: c_int, bytes: *const c_char, len: usize) {
    let text = core::slice::from_raw_parts(bytes as *const u8, len);
    let text = String::from_utf8_lossy(text);
    let text = text.trim_end_matches('\n');
    if text.is_empty() {
        return;
    }
    if stream == 2 {
        log::error!(target: "quickjs", "{text}");
    } else {
        log::info!(target: "quickjs", "{text}");
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pocket_keyos_libc_abort(message: *const c_char, len: usize) -> ! {
    let text = core::slice::from_raw_parts(message as *const u8, len);
    log::error!(target: "quickjs", "{}", String::from_utf8_lossy(text));
    std::process::abort()
}
