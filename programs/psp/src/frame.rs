//! The PSP frame loop every program shares: process start on the QuickJS
//! worker thread, then one guest from boot to the frame its program ends it
//! on. Each frame samples the controller, runs the guest turn, collects on
//! arena pressure and presents; trace, benchmark and capture builds hook the
//! same loop.
//!
//! Frame order: controller facts -> generated guest -> fixed core ticks ->
//! DrawList GE driver -> terminal wait -> paced display swap.
//!
//! `src/main.rs` runs `run` once for the embedded application. A program
//! crate that carries several guests runs it once per guest: its `Program`
//! filters the buttons, registers op providers before boot and ends the guest
//! after a presented frame; the runtime is dropped before `run` returns, so
//! the program may draw on the GE (`host::list_ptr`) before the next guest.

use alloc::boxed::Box;
use alloc::string::String;
use core::ffi::c_void;

#[cfg(feature = "capture")]
use psp::sys::{DisplayPixelFormat, DisplaySetBufSync};
use psp::sys::{self, IoOpenFlags};

use crate::{arena, dbg, host, Options, Runtime};
use pocket_drivers::PackageSource;
#[cfg(feature = "capture")]
use pocketjs_core::spec;

/// Declare the PSP module, then run `$entry` on a 1 MiB QuickJS worker
/// thread after `frame::start` set up the process (clock, graphics,
/// controller). `$name` is the module name; `$entry` is a `fn()`.
///
/// This is `psp::module!` with two additions: the main thread keeps the
/// EBOOT's path (PPSSPP does not pass the current directory to a new
/// thread, so the worker enters the same directory itself), and the binary
/// names the RTC `_gettimeofday` so the linker takes it before libcglue's.
#[macro_export]
macro_rules! module {
    ($name:expr, $entry:path) => {
        #[doc(hidden)]
        mod __pocketjs_psp_module {
            use core::ffi::c_void;
            use $crate::psp::sys;

            #[no_mangle]
            #[link_section = ".rodata.sceModuleInfo"]
            #[used]
            static MODULE_INFO: $crate::psp::Align16<sys::SceModuleInfo> =
                $crate::psp::Align16(sys::SceModuleInfo {
                    mod_attribute: 0,
                    mod_version: [1, 1],
                    mod_name: sys::SceModuleInfo::name($name),
                    terminal: 0,
                    gp_value: unsafe { &_gp },
                    stub_top: unsafe { &__lib_stub_top },
                    stub_end: unsafe { &__lib_stub_bottom },
                    ent_top: unsafe { &__lib_ent_top },
                    ent_end: unsafe { &__lib_ent_bottom },
                });

            extern "C" {
                static _gp: u8;
                static __lib_ent_bottom: u8;
                static __lib_ent_top: u8;
                static __lib_stub_bottom: u8;
                static __lib_stub_top: u8;
            }

            #[no_mangle]
            #[link_section = ".lib.ent"]
            #[used]
            static LIB_ENT: sys::SceLibraryEntry = sys::SceLibraryEntry {
                name: core::ptr::null(),
                version: (1, 1),
                attribute: sys::SceLibAttr::SCE_LIB_IS_SYSLIB,
                entry_len: 4,
                var_count: 1,
                func_count: 1,
                entry_table: &LIB_ENT_TABLE,
            };

            #[no_mangle]
            #[link_section = ".rodata.sceResident"]
            #[used]
            static LIB_ENT_TABLE: sys::SceLibraryEntryTable = sys::SceLibraryEntryTable {
                module_start_nid: 0xd632acdb, // module_start
                module_info_nid: 0xf01d73a7,  // SceModuleInfo
                module_start,
                module_info: &MODULE_INFO.0,
            };

            #[no_mangle]
            extern "C" fn module_start(argc_bytes: usize, argv: *mut c_void) -> isize {
                extern "C" fn main_thread(argc: usize, argv: *mut c_void) -> i32 {
                    if argc > 0 {
                        unsafe { $crate::pack_ops::set_program_path(argv as *const u8, argc) };
                    }
                    $crate::psp::_start!(super::__pocketjs_psp_main, argc, argv)
                }

                unsafe {
                    let id = sys::sceKernelCreateThread(
                        b"main_thread\0".as_ptr(),
                        main_thread,
                        32,
                        256 * 1024,
                        sys::ThreadAttributes::USER | sys::ThreadAttributes::VFPU,
                        core::ptr::null_mut(),
                    );
                    sys::sceKernelStartThread(id, argc_bytes, argv);
                }
                0
            }
        }

        #[doc(hidden)]
        fn __pocketjs_psp_main() {
            unsafe { $crate::frame::start($entry) }
        }

        /// Named from this object so the linker takes the RTC clock
        /// (pocket_psp_system::_gettimeofday) before libcglue's.
        #[used]
        static __POCKETJS_RTC_CLOCK: unsafe extern "C" fn(
            *mut $crate::host::Timeval,
            *mut core::ffi::c_void,
        ) -> i32 = $crate::host::_gettimeofday;
    };
}

/// What a program decides around each frame of one guest.
pub trait Program {
    /// What `run` returns when the program ends the guest.
    type Exit;
    /// After `Runtime::new`, before the guest boots: register the op
    /// providers this guest answers with (`Runtime::add_provider`).
    ///
    /// # Safety
    /// Worker thread; no core guard is held.
    unsafe fn configure(&mut self, runtime: &mut Runtime) -> Result<(), String> {
        let _ = runtime;
        Ok(())
    }
    /// The controller buttons the guest receives this frame.
    fn buttons(&mut self, buttons: u32) -> u32 {
        buttons
    }
    /// After this frame's list is kicked (and, in capture builds, dumped).
    /// `Some` ends the guest: `run` drops the runtime and returns the exit.
    /// `runtime.complete()` makes the display show this frame with the GE
    /// idle, before the program reads it back (`host::read_display_rows_rgba`).
    ///
    /// # Safety
    /// Worker thread; no core guard is held.
    unsafe fn end_frame(&mut self, runtime: &mut Runtime) -> Option<Self::Exit> {
        let _ = runtime;
        None
    }
}

static POCKETJS_TRACE: &str = env!("POCKETJS_TRACE");
#[cfg(feature = "bench")]
static POCKETJS_APP_NAME: &str = env!("POCKETJS_APP");
// Build-time scripted input for deterministic PPSSPPHeadless captures
// (tests/e2e/ppsspp.ts), baked by build.rs from POCKETJS_CAPTURE_INPUT; same
// "frame:mask,frame:mask" format as dreamcart's PSPJS_CAPTURE_INPUT.
#[cfg(feature = "capture")]
static POCKETJS_CAPTURE_INPUT: &str = env!("POCKETJS_CAPTURE_INPUT");
// Per-demo capture window, also baked by build.rs (each e2e spec builds its
// own EBOOT, so the window travels with its input script). Empty -> defaults
// (CAP_START=16, CAP_N=32). Duplicated per-spec in tests/e2e/ppsspp.ts.
#[cfg(feature = "capture")]
static POCKETJS_CAP_START: &str = env!("POCKETJS_CAP_START");
#[cfg(feature = "capture")]
static POCKETJS_CAP_N: &str = env!("POCKETJS_CAP_N");
#[cfg(feature = "bench")]
static POCKETJS_BENCH_DUMP_FRAMES: &str = env!("POCKETJS_BENCH_DUMP_FRAMES");

/// The program entry `module!` names; `start` runs it on the worker.
static mut ENTRY: Option<fn()> = None;
/// Presented frames across every guest of the process: the capture identity
/// (baked input script index + dump file name) does not restart when a
/// program boots another guest.
static mut GLOBAL_FRAME: u32 = 0;
// Arena bump high-water at the last host-forced collection (arena-pressure GC
// below). Single-threaded QuickJS worker.
static mut LAST_GC_BUMP: usize = 0;
static mut DBG_PROBED: bool = false;
#[cfg(feature = "bench")]
static mut BENCH_SIM_HZ: u32 = 0;

#[inline]
fn trace_enabled() -> bool {
    POCKETJS_TRACE == "1"
}

unsafe fn trace_write(bytes: &[u8]) {
    let fd = sys::sceIoOpen(
        b"host0:/PocketJS-trace.txt\0".as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::APPEND,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, bytes.as_ptr() as *const c_void, bytes.len());
        sys::sceIoClose(fd);
    }
}

unsafe fn trace_reset() {
    if !trace_enabled() {
        return;
    }
    let fd = sys::sceIoOpen(
        b"host0:/PocketJS-trace.txt\0".as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoClose(fd);
    }
}

/// Append a line to host0:/PocketJS-trace.txt and the debug screen in trace
/// builds (`POCKETJS_TRACE=1`); nothing otherwise.
pub fn trace(message: &str) {
    if trace_enabled() {
        unsafe {
            trace_write(b"[PocketJS trace] ");
            trace_write(message.as_bytes());
            trace_write(b"\n");
        }
        psp::dprintln!("[PocketJS trace] {}", message);
    }
}

unsafe fn trace_pair(prefix: &[u8], message: &str) {
    if trace_enabled() {
        trace_write(prefix);
        trace_write(message.as_bytes());
        trace_write(b"\n");
    }
}

/// Fatal error: the message on the debug screen (and in the trace), then
/// park on vblank; HOME still exits.
///
/// # Safety
/// PSP thread context.
pub unsafe fn halt(message: &str) -> ! {
    trace_pair(b"[PocketJS halt] ", message);
    host::halt(message)
}

/// The process start `module!` calls on the main thread: run `entry` on the
/// QuickJS worker after the process setup.
///
/// # Safety
/// Called once, from the PSP main thread.
pub unsafe fn start(entry: fn()) {
    host::reset_fpu_status();
    ENTRY = Some(entry);
    trace_reset();
    trace("boot: creating worker thread");
    host::run_on_worker(worker_main, enter);
}

unsafe extern "C" fn worker_main(_argc: usize, _argv: *mut c_void) -> i32 {
    host::reset_fpu_status();
    crate::pack_ops::enter_program_dir();
    trace("worker: entered");
    enter();
    0
}

unsafe fn enter() {
    #[cfg(feature = "bench")]
    bench_init();
    trace("run: entered");
    psp::enable_home_button();
    trace("run: home button enabled");
    // Full clock. PSPLINK launches modules at its own 222 MHz default, and a
    // QuickJS guest feels every missing cycle.
    sys::scePowerSetClockFrequency(333, 333, 166);
    trace("run: clock 333/166");
    host::init_graphics(host::GfxConfig::default());
    trace("run: graphics initialized");
    pocket_psp_input::initialize();
    trace("run: controller initialized");
    if let Some(entry) = ENTRY {
        entry();
    }
}

/// Boot the guest `source` holds and run its frames until `program` ends it.
/// `Err` is a guest that failed to start (refused package, throwing
/// evaluation, no `frame` function); the runtime is dropped either way.
///
/// # Safety
/// The worker thread `start` runs the entry on; no other Runtime is alive.
pub unsafe fn run<P: Program>(
    source: Box<dyn PackageSource>,
    options: Options,
    program: &mut P,
) -> Result<P::Exit, String> {
    trace("run: runtime create begin");
    let mut runtime = Runtime::new(source, options)?;
    program.configure(&mut runtime)?;
    if !DBG_PROBED {
        DBG_PROBED = true;
        if (!crate::offload::enabled() || cfg!(feature = "devtools-offload")) && dbg::init() {
            trace("run: devtools mailbox active");
        }
    }
    trace("run: package admission and generated guest boot");
    runtime.boot()?;
    let ticks_per_virtual_frame = runtime.core_ticks();
    #[cfg(feature = "bench")]
    {
        BENCH_SIM_HZ = runtime.sim_hz();
        let (begin, end) = runtime.eval_times();
        BENCH.eval_begin_us = begin;
        BENCH.eval_end_us = end;
    }
    let mut guest_frame = 0u32;
    loop {
        #[cfg(feature = "bench")]
        let bench_frame_start = bench_now_us();
        let pad = pocket_psp_input::sample();
        let mask = pad.buttons.bits();
        #[cfg(feature = "capture")]
        let mask = capture_input_mask(GLOBAL_FRAME, mask as i32) as u32;
        let mask = program.buttons(mask);
        #[cfg(not(feature = "capture"))]
        let analog = ((pad.lx as u32) << 8) | pad.ly as u32;
        #[cfg(feature = "capture")]
        let analog = spec::ANALOG_CENTER;
        crate::offload::frame(mask, analog);
        crate::offload_local::frame();
        if let Err(error) = runtime.advance(mask, analog, ticks_per_virtual_frame) {
            trace_pair(b"[PocketJS guest frame] ", &error);
        }
        #[cfg(feature = "bench")]
        let (bench_after_js, bench_after_jobs) = runtime.phase_times();
        {
            const GC_BUMP_STEP: usize = 256 * 1024;
            if arena::stats().bump_bytes > LAST_GC_BUMP.saturating_add(GC_BUMP_STEP) {
                if let Err(error) = runtime.collect() {
                    trace_pair(b"[PocketJS collect] ", &error);
                }
                LAST_GC_BUMP = arena::stats().bump_bytes;
            }
        }
        #[cfg(feature = "bench")]
        let bench_after_tick = bench_now_us();
        // Present syncs the previous list, paces and swaps it against the
        // process clock, then kicks this frame's list. The GE draws it while
        // the next guest turn runs; no core borrow survives the call.
        if let Err(error) = runtime.present() {
            trace_pair(b"[PocketJS present] ", &error);
        }
        #[cfg(feature = "bench")]
        {
            // gpu_us is the residual wait for the previous list; it and the
            // paced swap are excluded from render and work time.
            let timing = runtime.frame_timing();
            bench_record_gpu(guest_frame, timing.gpu_us);
            bench_record_frame(
                guest_frame,
                bench_frame_start,
                bench_after_js,
                bench_after_jobs,
                bench_after_tick,
                timing.after_draw,
                timing.after_render,
                timing.gpu_us.saturating_add(timing.present_us),
            );
            if guest_frame == 0 {
                bench_record_frame0_complete();
            }
            bench_maybe_flush(guest_frame, runtime.source_lengths());
        }
        // The last capture exits the process, so record and flush benchmark
        // results before allowing it to terminate the run. A dumped frame is
        // completed first, so the display buffer holds frame GLOBAL_FRAME;
        // other frames keep the GE overlapped with the next guest turn.
        #[cfg(feature = "capture")]
        {
            if capture_dumps(GLOBAL_FRAME) {
                if let Err(error) = runtime.complete() {
                    trace_pair(b"[PocketJS present] ", &error);
                }
            }
            cap_dump_frame(GLOBAL_FRAME);
        }
        if let Some(exit) = program.end_frame(&mut runtime) {
            trace("run: guest ends; canonical runtime shutdown");
            drop(runtime);
            GLOBAL_FRAME = GLOBAL_FRAME.wrapping_add(1);
            return Ok(exit);
        }
        if trace_enabled() && guest_frame % 25 == 0 {
            let stats = arena::stats();
            trace_pair(
                b"[PocketJS arena] ",
                &alloc::format!(
                    "frame {} bump {} tail {}",
                    guest_frame,
                    stats.bump_bytes,
                    stats.tail_free_bytes
                ),
            );
        }
        if guest_frame == 0 {
            // The list is kicked; the next present completes it.
            trace("frame 0: complete");
        }
        guest_frame = guest_frame.wrapping_add(1);
        GLOBAL_FRAME = GLOBAL_FRAME.wrapping_add(1);
    }
}

// ---------------------------------------------------------------------------
// Benchmark support (tools/bench-ppsspp.ts): PSP-side microsecond timing
// summary appended to PocketJS-bench.jsonl on host0: and ms0:.
// ---------------------------------------------------------------------------

#[cfg(feature = "bench")]
#[derive(Clone, Copy)]
struct BenchState {
    run_start_us: u64,
    eval_begin_us: u64,
    eval_end_us: u64,
    frame0_complete_us: u64,
    frames: u32,
    js_sum_us: u64,
    jobs_sum_us: u64,
    tick_sum_us: u64,
    draw_sum_us: u64,
    render_sum_us: u64,
    work_sum_us: u64,
    max_work_us: u64,
    gpu_sum_us: u64,
    max_gpu_us: u64,
    previous_frame_start_us: u64,
    frame_interval_sum_us: u64,
    max_frame_interval_us: u64,
}

#[cfg(feature = "bench")]
impl BenchState {
    const fn new() -> Self {
        Self {
            run_start_us: 0,
            eval_begin_us: 0,
            eval_end_us: 0,
            frame0_complete_us: 0,
            frames: 0,
            js_sum_us: 0,
            jobs_sum_us: 0,
            tick_sum_us: 0,
            draw_sum_us: 0,
            render_sum_us: 0,
            work_sum_us: 0,
            max_work_us: 0,
            gpu_sum_us: 0,
            max_gpu_us: 0,
            previous_frame_start_us: 0,
            frame_interval_sum_us: 0,
            max_frame_interval_us: 0,
        }
    }
}

#[cfg(feature = "bench")]
static mut BENCH: BenchState = BenchState::new();

#[cfg(feature = "bench")]
#[inline]
unsafe fn bench_now_us() -> u64 {
    sys::sceKernelGetSystemTimeWide() as u64
}

#[cfg(feature = "bench")]
unsafe fn bench_write(bytes: &[u8]) {
    for path in [
        b"host0:/PocketJS-bench.jsonl\0".as_ptr(),
        b"ms0:/PocketJS-bench.jsonl\0".as_ptr(),
    ] {
        let fd = sys::sceIoOpen(
            path,
            IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::APPEND,
            0o777,
        );
        if fd.0 >= 0 {
            sys::sceIoWrite(fd, bytes.as_ptr() as *const c_void, bytes.len());
            sys::sceIoClose(fd);
        }
    }
}

#[cfg(feature = "bench")]
unsafe fn bench_reset_file() {
    for path in [
        b"host0:/PocketJS-bench.jsonl\0".as_ptr(),
        b"ms0:/PocketJS-bench.jsonl\0".as_ptr(),
    ] {
        let fd = sys::sceIoOpen(
            path,
            IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
            0o777,
        );
        if fd.0 >= 0 {
            sys::sceIoClose(fd);
        }
    }
}

#[cfg(feature = "bench")]
unsafe fn bench_init() {
    bench_reset_file();
    BENCH = BenchState::new();
    BENCH.run_start_us = bench_now_us();
}

#[cfg(feature = "bench")]
unsafe fn bench_window() -> (u32, u32) {
    #[cfg(feature = "capture")]
    {
        (
            capture_env_u32(POCKETJS_CAP_START, 16),
            capture_env_u32(POCKETJS_CAP_N, 32),
        )
    }
    #[cfg(not(feature = "capture"))]
    {
        (0, 120)
    }
}

#[cfg(feature = "bench")]
#[allow(clippy::too_many_arguments)]
unsafe fn bench_record_frame(
    frame_count: u32,
    t0: u64,
    after_js: u64,
    after_jobs: u64,
    after_tick: u64,
    after_draw: u64,
    after_render: u64,
    present_us: u64,
) {
    let (start, n) = bench_window();
    if frame_count < start || frame_count >= start + n {
        return;
    }
    let js_us = after_js.saturating_sub(t0);
    let jobs_us = after_jobs.saturating_sub(after_js);
    let tick_us = after_tick.saturating_sub(after_jobs);
    let draw_us = after_draw.saturating_sub(after_tick);
    let render_us = after_render
        .saturating_sub(after_draw)
        .saturating_sub(present_us);
    let work_us = after_render.saturating_sub(t0).saturating_sub(present_us);
    if BENCH.frames > 0 {
        let interval_us = t0.saturating_sub(BENCH.previous_frame_start_us);
        BENCH.frame_interval_sum_us = BENCH.frame_interval_sum_us.saturating_add(interval_us);
        if interval_us > BENCH.max_frame_interval_us {
            BENCH.max_frame_interval_us = interval_us;
        }
    }
    BENCH.previous_frame_start_us = t0;
    BENCH.frames = BENCH.frames.saturating_add(1);
    BENCH.js_sum_us = BENCH.js_sum_us.saturating_add(js_us);
    BENCH.jobs_sum_us = BENCH.jobs_sum_us.saturating_add(jobs_us);
    BENCH.tick_sum_us = BENCH.tick_sum_us.saturating_add(tick_us);
    BENCH.draw_sum_us = BENCH.draw_sum_us.saturating_add(draw_us);
    BENCH.render_sum_us = BENCH.render_sum_us.saturating_add(render_us);
    BENCH.work_sum_us = BENCH.work_sum_us.saturating_add(work_us);
    if work_us > BENCH.max_work_us {
        BENCH.max_work_us = work_us;
    }
}

#[cfg(feature = "bench")]
unsafe fn bench_record_gpu(frame_count: u32, gpu_us: u64) {
    let (start, n) = bench_window();
    if frame_count < start || frame_count >= start + n {
        return;
    }
    BENCH.gpu_sum_us = BENCH.gpu_sum_us.saturating_add(gpu_us);
    if gpu_us > BENCH.max_gpu_us {
        BENCH.max_gpu_us = gpu_us;
    }
}

#[cfg(feature = "bench")]
unsafe fn bench_record_frame0_complete() {
    BENCH.frame0_complete_us = bench_now_us();
}

#[cfg(feature = "bench")]
unsafe fn bench_maybe_flush(frame_count: u32, source_lengths: (usize, usize)) {
    let (start, n) = bench_window();
    if n == 0 || frame_count != start + n - 1 || BENCH.frames == 0 {
        return;
    }
    let frames = BENCH.frames as u64;
    let intervals = frames.saturating_sub(1);
    let arena_stats = arena::stats();
    let stack_free_bytes =
        sys::sceKernelGetThreadStackFreeSize(sys::SceUid(sys::sceKernelGetThreadId())).max(0);
    let line = alloc::format!(
        "{{\"app\":\"{}\",\"sim_hz\":{},\"frames\":{},\"window_start\":{},\"window_n\":{},\"eval_us\":{},\"boot_to_eval_begin_us\":{},\"boot_to_frame0_us\":{},\"avg_frame_interval_us\":{},\"max_frame_interval_us\":{},\"avg_js_us\":{},\"avg_jobs_us\":{},\"avg_tick_us\":{},\"avg_draw_us\":{},\"avg_render_us\":{},\"avg_work_us\":{},\"max_work_us\":{},\"avg_gpu_us\":{},\"max_gpu_us\":{},\"stack_free_bytes\":{},\"bundle_bytes\":{},\"pak_bytes\":{},\"arena_capacity_bytes\":{},\"arena_bump_bytes\":{},\"arena_tail_free_bytes\":{},\"arena_init_free_bytes\":{},\"arena_configured_bytes\":{}}}\n",
        POCKETJS_APP_NAME,
        BENCH_SIM_HZ,
        BENCH.frames,
        start,
        n,
        BENCH.eval_end_us.saturating_sub(BENCH.eval_begin_us),
        BENCH.eval_begin_us.saturating_sub(BENCH.run_start_us),
        BENCH.frame0_complete_us.saturating_sub(BENCH.run_start_us),
        if intervals > 0 { BENCH.frame_interval_sum_us / intervals } else { 0 },
        BENCH.max_frame_interval_us,
        BENCH.js_sum_us / frames,
        BENCH.jobs_sum_us / frames,
        BENCH.tick_sum_us / frames,
        BENCH.draw_sum_us / frames,
        BENCH.render_sum_us / frames,
        BENCH.work_sum_us / frames,
        BENCH.max_work_us,
        BENCH.gpu_sum_us / frames,
        BENCH.max_gpu_us,
        stack_free_bytes,
        source_lengths.0,
        source_lengths.1,
        arena_stats.capacity_bytes,
        arena_stats.bump_bytes,
        arena_stats.tail_free_bytes,
        arena_stats.init_free_bytes,
        arena_stats.configured_bytes,
    );
    bench_write(line.as_bytes());
}

// ---------------------------------------------------------------------------
// Capture support (PPSSPPHeadless E2E, tests/e2e/ppsspp.ts). The capture
// window is per build (POCKETJS_CAP_START / POCKETJS_CAP_N, baked like the
// input script): PocketJS's frame 0 lands after the slow QuickJS bundle eval,
// but mount transitions and mount-started tweens (e.g. hero's 850 ms
// underline sweep) play out over the first frames, and each demo needs a
// different settle horizon.
// ---------------------------------------------------------------------------

#[cfg(feature = "capture")]
fn parse_capture_u32(s: &[u8], mut i: usize, end: usize) -> Option<u32> {
    while i < end && (s[i] == b' ' || s[i] == b'\t') {
        i += 1;
    }
    if i >= end {
        return None;
    }
    let hex = i + 1 < end && s[i] == b'0' && (s[i + 1] == b'x' || s[i + 1] == b'X');
    if hex {
        i += 2;
    }
    let mut out = 0u32;
    let mut any = false;
    while i < end {
        let c = s[i];
        let d = if c >= b'0' && c <= b'9' {
            c - b'0'
        } else if hex && c >= b'a' && c <= b'f' {
            c - b'a' + 10
        } else if hex && c >= b'A' && c <= b'F' {
            c - b'A' + 10
        } else if c == b' ' || c == b'\t' {
            break;
        } else {
            return None;
        };
        out = out
            .saturating_mul(if hex { 16 } else { 10 })
            .saturating_add(d as u32);
        any = true;
        i += 1;
    }
    if any {
        Some(out)
    } else {
        None
    }
}

/// Parse a baked decimal/hex env value (POCKETJS_CAP_START / POCKETJS_CAP_N),
/// falling back when the env was empty or malformed.
#[cfg(feature = "capture")]
fn capture_env_u32(s: &str, default: u32) -> u32 {
    let b = s.as_bytes();
    parse_capture_u32(b, 0, b.len()).unwrap_or(default)
}

/// Build-time scripted input for deterministic PPSSPPHeadless captures.
///
/// Format: `frame:mask,frame:mask` where mask may be decimal or hex. The
/// active mask is the last threshold at or before `frame_count`, so
/// `0:0,20:0x40,24:0` means idle, press DOWN at frame 20, release at 24.
#[cfg(feature = "capture")]
fn capture_input_mask(frame_count: u32, fallback: i32) -> i32 {
    let s = POCKETJS_CAPTURE_INPUT.as_bytes();
    if s.is_empty() {
        return fallback;
    }
    let mut i = 0usize;
    let mut best_frame: Option<u32> = None;
    let mut best_mask = fallback as u32;
    while i < s.len() {
        while i < s.len() && (s[i] == b',' || s[i] == b';' || s[i] == b' ' || s[i] == b'\t') {
            i += 1;
        }
        let frame_start = i;
        while i < s.len() && s[i] != b':' && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        if i >= s.len() || s[i] != b':' {
            break;
        }
        let frame_end = i;
        i += 1;
        let mask_start = i;
        while i < s.len() && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        let mask_end = i;
        if let (Some(frame), Some(mask)) = (
            parse_capture_u32(s, frame_start, frame_end),
            parse_capture_u32(s, mask_start, mask_end),
        ) {
            if frame <= frame_count && best_frame.map_or(true, |best| frame >= best) {
                best_frame = Some(frame);
                best_mask = mask;
            }
        }
    }
    best_mask as i32
}

/// Whether `cap_dump_frame` writes this frame's display buffer.
#[cfg(feature = "capture")]
fn capture_dumps(frame_count: u32) -> bool {
    let cap_start = capture_env_u32(POCKETJS_CAP_START, 16);
    let cap_n = capture_env_u32(POCKETJS_CAP_N, 32);
    #[cfg(feature = "bench")]
    let dumping = POCKETJS_BENCH_DUMP_FRAMES == "1";
    #[cfg(not(feature = "bench"))]
    let dumping = true;
    dumping && frame_count >= cap_start && frame_count < cap_start + cap_n
}

/// Dump the just-presented display framebuffer to `ms0:/dc_cap/fNNNN.raw`
/// (512-stride RGBA top-down, as the GE wrote it) for the frames in the
/// capture window. One headless run thus yields a deterministic frame-per-
/// index sequence of the scripted input path. NNNN = frame_count - cap_start.
/// The window (POCKETJS_CAP_START/POCKETJS_CAP_N, baked per build) must match the
/// spec's capStart/capN in tests/e2e/ppsspp.ts — the driver bakes both.
#[cfg(feature = "capture")]
unsafe fn cap_dump_frame(frame_count: u32) {
    // Defaults: skip boot transients + 150 ms mount transitions; 32 frames.
    let cap_start = capture_env_u32(POCKETJS_CAP_START, 16);
    let cap_n = capture_env_u32(POCKETJS_CAP_N, 32);
    if frame_count < cap_start || frame_count >= cap_start + cap_n {
        return;
    }
    let idx = frame_count - cap_start;
    #[cfg(feature = "bench")]
    if POCKETJS_BENCH_DUMP_FRAMES != "1" {
        if idx + 1 == cap_n {
            sys::sceKernelExitGame();
        }
        return;
    }
    if idx == 0 {
        sys::sceIoMkdir(b"ms0:/dc_cap\0".as_ptr(), 0o777);
    }
    // "ms0:/dc_cap/fNNNN.raw\0" with the 4 digits (offsets 13..=16) patched from idx.
    let mut name: [u8; 22] = *b"ms0:/dc_cap/f0000.raw\0";
    let mut v = idx;
    let mut i = 16usize;
    loop {
        name[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if i == 13 {
            break;
        }
        i -= 1;
    }
    // Resolve the current display buffer and read it straight from VRAM
    // (uncached mirror, so we see the GE's fresh output, not stale cache).
    let mut top: *mut c_void = core::ptr::null_mut();
    let mut bw: usize = 0;
    let mut fmt = DisplayPixelFormat::Psm8888;
    sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
    let mut addr = top as u32;
    if addr < 0x0400_0000 {
        addr += 0x0400_0000;
    }
    addr |= 0x4000_0000;
    let fd = sys::sceIoOpen(
        name.as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, addr as *const c_void, 512 * 272 * 4);
        sys::sceIoClose(fd);
    }
    if idx + 1 == cap_n {
        sys::sceKernelExitGame();
    }
}
