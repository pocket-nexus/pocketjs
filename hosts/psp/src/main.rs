#![no_std]
#![no_main]
#![allow(static_mut_refs)]

//! PocketJS PSP host: boots QuickJS on a 1 MB worker thread, evaluates the
//! embedded app bundle, then drives fixed-rate virtual frames while the Rust
//! core ticks animations/layout and the GE backend draws the DrawList.
//!
//! This bin is one composition of the `pocketjs-psp` library (see lib.rs):
//! the mechanism modules (allocator trio, ffi, ge, pak, dbg, host) live
//! there; everything app-flavored — trace, bench, capture, and the 2D frame
//! loop — lives here.
//!
//! Frame order (docs/DESIGN.md): sceCtrlPeek -> sceGuStart -> JS frame(buttons)
//! -> drain jobs (JS_ExecutePendingJob, local extern) -> core.tick(1/60 × N) ->
//! ge::render(core.draw()) -> sceGuFinish/Sync/WaitVblank/Swap -> pool reset.

extern crate alloc;

use core::ffi::c_void;

use libquickjs_sys::*;
#[cfg(feature = "capture")]
use psp::sys::DisplaySetBufSync;
#[cfg(feature = "capture")]
use psp::sys::DisplayPixelFormat;
use psp::sys::{self, CtrlMode, GuContextType, GuSyncBehavior, GuSyncMode, IoOpenFlags, SceCtrlData};

use pocketjs_core::spec;
use pocketjs_psp::{arena, audio_mod, dbg, ffi, ge, host, pak, svc, switch, veil, vid};

psp::module!("pocketjs", 1, 1);

const CORE_TICKS_PER_SECOND: u32 = 60;
// The full launcher originally consumed about 42 ms of CPU work on real PSP
// hardware. Batching cuts that to about 12 ms, but the texture-heavy GE pass
// still completes across the third vblank. A multi-app package therefore
// publishes an honest 20 Hz host policy and advances three fixed core ticks
// per transaction. Standalone apps retain the 60 Hz policy.
const MULTI_APP_SIM_HZ: u32 = 20;

// App bundles live in switch::APPS (build.rs generates the table; entry 0 is
// the app POCKETJS_APP selected, multi-app builds append the registry). Each
// entry's js is NUL-terminated there for JS_Eval (input[len] == '\0').
#[cfg(feature = "bench")]
static POCKETJS_APP_NAME: &str = env!("POCKETJS_APP");
static POCKETJS_TRACE: &str = env!("POCKETJS_TRACE");

// Arena bump high-water at the last host-forced collection (frame loop's
// arena-pressure GC below). Single-threaded QuickJS worker.
static mut LAST_GC_BUMP: usize = 0;

// libquickjs-sys omits JS_RunGC; the linked QuickJS C library provides it
// (local-extern pattern, same as host.rs JS_ExecutePendingJob).
extern "C" {
    fn JS_RunGC(rt: *mut JSRuntime);
}


// Build-time scripted input for deterministic PPSSPPHeadless captures
// (tests/e2e/ppsspp.ts). Baked by build.rs from the POCKETJS_CAPTURE_INPUT env;
// same "frame:mask,frame:mask" format as dreamcart's PSPJS_CAPTURE_INPUT.
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

// libquickjs-sys omits JS_NewArrayBuffer; the linked QuickJS C library
// provides it (same local-extern pattern as dreamcart runtime/src/main.rs).
// size_t stays usize (MIPS o32).
extern "C" {
    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buf: *mut u8,
        len: usize,
        free_func: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        is_shared: i32,
    ) -> JSValue;
}

fn psp_main() {
    unsafe {
        host::reset_fpu_status();
        boot()
    }
}

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

unsafe fn trace(msg: &str) {
    if trace_enabled() {
        trace_write(b"[PocketJS trace] ");
        trace_write(msg.as_bytes());
        trace_write(b"\n");
        psp::dprintln!("[PocketJS trace] {}", msg);
    }
}

unsafe fn trace_pair(prefix: &[u8], msg: &str) {
    if trace_enabled() {
        trace_write(prefix);
        trace_write(msg.as_bytes());
        trace_write(b"\n");
    }
}

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
unsafe fn bench_eval_begin() {
    BENCH.eval_begin_us = bench_now_us();
}

#[cfg(feature = "bench")]
unsafe fn bench_eval_end() {
    BENCH.eval_end_us = bench_now_us();
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
    let render_us = after_render.saturating_sub(after_draw).saturating_sub(present_us);
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
unsafe fn bench_maybe_flush(frame_count: u32) {
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
        if switch::multi() { MULTI_APP_SIM_HZ } else { CORE_TICKS_PER_SECOND },
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
        switch::guest_bytes(0).map(|g| g.js.len().saturating_sub(1)).unwrap_or(0),
        switch::guest_bytes(0).map(|g| g.pak.len()).unwrap_or(0),
        arena_stats.capacity_bytes,
        arena_stats.bump_bytes,
        arena_stats.tail_free_bytes,
        arena_stats.init_free_bytes,
        arena_stats.configured_bytes,
    );
    bench_write(line.as_bytes());
}

unsafe fn boot() {
    trace_reset();
    trace("boot: creating worker thread");
    host::run_on_worker(worker_main, run);
}

unsafe extern "C" fn worker_main(_argc: usize, _argv: *mut c_void) -> i32 {
    host::reset_fpu_status();
    trace("worker: entered");
    run();
    0
}

/// Print the pending JS exception via the debug screen (+ trace file).
unsafe fn log_exception(ctx: *mut JSContext) {
    host::log_exception_with(ctx, |msg| trace_pair(b"[PocketJS js error] ", msg));
}

unsafe fn halt(msg: &str) -> ! {
    trace_pair(b"[PocketJS halt] ", msg);
    host::halt(msg)
}

unsafe fn run() {
    #[cfg(feature = "bench")]
    bench_init();
    trace("run: entered");
    psp::enable_home_button();
    trace("run: home button enabled");
    // Full clock. PSPLINK launches modules at its own 222 MHz default, and a
    // QuickJS guest feels every missing cycle — this was measured as part of
    // the perf-wall work but never landed in this host.
    sys::scePowerSetClockFrequency(333, 333, 166);
    trace("run: clock 333/166");
    host::init_graphics(host::GfxConfig::default());
    trace("run: graphics initialized");

    // ---- Controller ----
    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    trace("run: controller initialized");

    // A single rate spans the whole process. In particular, switching guests
    // never changes the meaning of GLOBAL_FRAME or of a captured input tape.
    let sim_hz = if switch::multi() {
        MULTI_APP_SIM_HZ
    } else {
        CORE_TICKS_PER_SECOND
    };
    let ticks_per_virtual_frame = CORE_TICKS_PER_SECOND / sim_hz;
    let mut last_present_vcount = sys::sceDisplayGetVcount();

    // ---- Guest lifecycle (docs/LAUNCHER.md): one guest alive at a time; a
    // switch tears the whole guest down and boots the next table entry.
    // Single-app builds have a table of one and never leave the first call.
    let mut boot_index: usize = 0;
    loop {
        boot_index = run_guest(
            boot_index,
            sim_hz,
            ticks_per_virtual_frame,
            &mut last_present_vcount,
        );
        trace("run: guest swap");
        // The system transition (docs/PLATFORM.md): host-drawn shot-dim + mark
        // sweep, then the next guest's eval holds on its settled last frame.
        veil::play();
    }
}

/// Wait for the first vblank at or after the fixed-rate presentation target.
///
/// Counting from the previous *actual* swap lets CPU and GE work overlap the
/// 3-vblank budget at 20 Hz. Blindly waiting three more vblanks after the work
/// would turn a 42 ms frame into 80+ ms instead of the intended 50 ms.
unsafe fn wait_for_present(last_vcount: &mut u32, vblanks_per_frame: u32) {
    loop {
        let elapsed = sys::sceDisplayGetVcount().wrapping_sub(*last_vcount);
        if elapsed >= vblanks_per_frame && sys::sceDisplayIsVblank() != 0 {
            break;
        }
        sys::sceDisplayWaitVblankStart();
    }
    *last_vcount = sys::sceDisplayGetVcount();
}

/// Global presented-frame counter across every guest — the capture identity
/// (baked input script index + dump file name) must not restart at a guest
/// swap or two apps' frames would collide in one e2e run.
static mut GLOBAL_FRAME: u32 = 0;

/// A guest that cannot boot (eval throw / no frame fn): a multi-app host
/// returns to the launcher instead of bricking the device; a single-app
/// EBOOT keeps the original halt-with-error-screen behavior.
unsafe fn guest_fail(app_index: usize, msg: &str) -> usize {
    if switch::multi() && app_index != 0 {
        trace_pair(b"[PocketJS guest error] ", msg);
        0
    } else {
        halt(msg)
    }
}

/// Boot embedded app `app_index`, drive it until a switch request, tear the
/// guest down, and return the next app index to boot.
unsafe fn run_guest(
    app_index: usize,
    sim_hz: u32,
    ticks_per_virtual_frame: u32,
    last_present_vcount: &mut u32,
) -> usize {
    switch::set_current(app_index);
    // Package mode extracts js/pak zero-copy from the entry's embedded
    // `.pocket`; single-app mode reads the classic inline embed. A package
    // that fails to parse routes through the broken-guest rule.
    let Some(guest) = switch::guest_bytes(app_index) else {
        return guest_fail(app_index, "embedded package unreadable for this target");
    };
    let app_js = guest.js;
    let app_pak = guest.pak;

    // ---- Rust UI core (first allocation initializes the arena). Replacing
    // the instance drops the previous guest's tree/styles/atlases/textures
    // back into the arena's free lists.
    trace("run: init ui begin");
    let ui = ffi::init_ui();
    trace("run: init ui ok");
    // The GE is idle here (cold boot, or a switch point that never kicked
    // its last list) — safe to drop font textures keyed on the old atlases.
    ge::reset_fonts();
    // Feed styles.bin + font atlases + images straight from .rodata to the
    // core BEFORE any JS runs (zero QuickJS-heap transit) [R].
    trace("run: pak feed begin");
    let (textures, sprites) = pak::feed(ui, app_pak);
    trace("run: pak feed ok");
    // Keep the pak reachable at runtime for the streaming ops registered
    // below (loadTileTexture pulls tile blobs straight from .rodata).
    pak::install(app_pak);
    // A summoned launcher gets the frozen frame as a texture in ITS core.
    switch::upload_shot(ffi::ui());

    // ---- QuickJS (fresh runtime + realm per guest) ----
    trace("run: JS_NewRuntime begin");
    let rt = pocketjs_psp::qjs_alloc::new_runtime();
    if rt.is_null() {
        halt("JS_NewRuntime returned null");
    }
    trace("run: JS_NewRuntime ok");
    trace("run: JS_NewContext begin");
    let ctx = JS_NewContext(rt);
    if ctx.is_null() {
        halt("JS_NewContext returned null");
    }
    trace("run: JS_NewContext ok");
    let global = JS_GetGlobalObject(ctx);
    trace("run: global object ok");

    // DevTools mailbox (docs/DEVTOOLS.md): active only if pocketjs-dbg/enable
    // exists on host0: (PSPLINK) or ms0: (PPSSPP GUI) — else two failed
    // opens at first boot and never again. Once per process: the mailbox is
    // host state, guests come and go under it.
    static mut DBG_PROBED: bool = false;
    if !DBG_PROBED {
        DBG_PROBED = true;
        if !pocketjs_psp::offload::enabled() && dbg::init() {
            trace("run: devtools mailbox active");
        }
    }

    // globalThis.ui — the full HostOps surface + the __textures table.
    trace("run: register ui begin");
    ffi::register(ctx, global, &textures, &sprites);
    trace("run: register ui ok");

    // The bundle mounts synchronously during JS_Eval, and resetClock() latches
    // this value at mount. Install it for every fresh guest realm beforehand.
    JS_SetPropertyStr(
        ctx,
        global,
        b"__simHz\0".as_ptr() as *const _,
        JS_NewInt32(ctx, sim_hz as i32),
    );
    trace("run: simulation rate installed");

    // Expose the asset pack read-only as globalThis.__pak (zero-copy over
    // .rodata; free_func = None). Web/test hosts feed core through loadStyles/
    // loadFontAtlas ops instead — on PSP pak.rs already did it natively.
    if !app_pak.is_empty() {
        let ab = JS_NewArrayBuffer(
            ctx,
            app_pak.as_ptr() as *mut u8,
            app_pak.len(),
            None,
            core::ptr::null_mut(),
            0,
        );
        JS_SetPropertyStr(ctx, global, b"__pak\0".as_ptr() as *const _, ab);
        trace("run: __pak installed");
    }

    trace("run: JS_Eval begin");
    #[cfg(feature = "bench")]
    bench_eval_begin();
    let res = JS_Eval(
        ctx,
        app_js.as_ptr() as *const _,
        app_js.len() - 1, // exclude the trailing NUL
        b"app.js\0".as_ptr() as *const _,
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
        log_exception(ctx);
        JS_FreeValue(ctx, res);
        JS_FreeValue(ctx, global);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return guest_fail(app_index, "JS_Eval threw");
    }
    JS_FreeValue(ctx, res);
    #[cfg(feature = "bench")]
    bench_eval_end();
    trace("run: JS_Eval ok");

    let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);
    if JS_IsUndefined(frame_fn) {
        JS_FreeValue(ctx, frame_fn);
        JS_FreeValue(ctx, global);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return guest_fail(app_index, "globalThis.frame is undefined");
    }
    trace("run: frame lookup ok");
    let mut pad = SceCtrlData::default();
    // The summon chord edge-detector. Starts LATCHED: when a guest boots
    // with SELECT already held (the launcher was dismissed via SELECT), the
    // held button must release before it can summon again — the host-side
    // twin of the framework's `latched` option.
    let mut prev_select = true;

    // ---- Fixed-timestep virtual-frame loop (60 or 20 Hz host policy) ----
    // GLOBAL_FRAME is the capture identity (origin/main contract): it
    // indexes the baked input script AND names the dumped frame files, so
    // input at frame N and file fN-CAP_START refer to the same presented
    // frame — and it spans guest swaps (see its doc). `guest_frame` is only
    // this guest's boot-trace / bench / present-skip counter.
    let mut guest_frame: u32 = 0;
    loop {
        #[cfg(feature = "bench")]
        let bench_frame_start = bench_now_us();
        if guest_frame == 0 {
            trace("frame 0: begin");
        }
        // Still sample sceCtrl even in capture builds so loop timing is
        // identical; the mask is then overridden by the baked script.
        // The frame loop is already paced at present by vblank. Peek the
        // latest controller sample here: Read may wait for the next sampling
        // cycle after consuming the current sample, accidentally adding a
        // second pacing point before JS/tick/draw on real hardware.
        sys::sceCtrlPeekBufferPositive(&mut pad, 1);
        if guest_frame == 0 {
            trace("frame 0: ctrl peek ok");
        }
        let mask = pad.buttons.bits() as i32;
        #[cfg(feature = "capture")]
        let mask = capture_input_mask(GLOBAL_FRAME, mask);

        // The summon chord (docs/LAUNCHER.md): on a multi-app host, guests other
        // than the launcher never see SELECT; a host-tracked press-edge
        // schedules the summon for this frame's bottom.
        #[cfg_attr(not(feature = "capture"), allow(unused_mut))]
        let mut mask = mask;
        if switch::multi() && app_index != 0 {
            let select_now = mask & (spec::btn::SELECT as i32) != 0;
            if select_now && !prev_select {
                switch::request_summon();
            }
            prev_select = select_now;
            mask &= !(spec::btn::SELECT as i32);
        }
        // Analog nub packed (x << 8) | y, each axis 0..255 with 128 = center
        // (spec.ts "frame(buttons, analog)"; SceCtrlData names the axes lx/ly).
        #[cfg(not(feature = "capture"))]
        let analog = (((pad.lx as u32) << 8) | pad.ly as u32) as i32;
        // The baked input script has no analog track: pin the nub to center
        // so scripted PPSSPPHeadless captures stay deterministic.
        #[cfg(feature = "capture")]
        let analog = pocketjs_core::spec::ANALOG_CENTER as i32;

        let mut args = [JS_NewInt32(ctx, mask), JS_NewInt32(ctx, analog)];
        pocketjs_psp::offload::frame(mask as u32, analog as u32);
        let r = JS_Call(ctx, frame_fn, global, 2, args.as_mut_ptr());
        #[cfg(feature = "bench")]
        let bench_after_js = bench_now_us();
        if guest_frame == 0 {
            trace("frame 0: JS_Call returned");
        }
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            log_exception(ctx);
        }
        JS_FreeValue(ctx, r); // leak guard: free the return value every frame
        if guest_frame == 0 {
            trace("frame 0: JS return freed");
        }

        host::drain_jobs(rt);
        // Arena-pressure GC (post-profiler-stub this WORKS: the guest's
        // per-frame cycles are collectable once no WeakMap pins them, and the
        // engine's lazy live*1.5 threshold otherwise lets its slab chunks pin
        // the fixed arena). Collect when a frame leaves the bump >256 KiB
        // past the last collection; steady-state guests never trigger it.
        {
            const GC_BUMP_STEP: usize = 256 * 1024;
            let bump = arena::stats().bump_bytes;
            if bump > LAST_GC_BUMP.saturating_add(GC_BUMP_STEP) {
                JS_RunGC(rt);
                LAST_GC_BUMP = arena::stats().bump_bytes;
            }
        }
        if trace_enabled() && guest_frame % 25 == 0 {
            let s = arena::stats();
            trace_pair(
                b"[PocketJS arena] ",
                &alloc::format!(
                    "frame {} bump {} tail {}",
                    guest_frame, s.bump_bytes, s.tail_free_bytes
                ),
            );
        }
        #[cfg(feature = "bench")]
        let bench_after_jobs = bench_now_us();
        if guest_frame == 0 {
            trace("frame 0: pending jobs drained");
        }

        // Core frame: animations always advance at fixed dt = 1/60. A lower
        // virtual-frame policy runs multiple ticks before drawing so seconds-
        // based transitions retain their duration and exact 60 Hz trajectory.
        // the DrawList into the open display list. The raw-slice dance keeps
        // borrowck happy about the single static-mut Ui (one thread; render
        // only reads atlases/textures, never the DrawList's owner mutably).
        let ui = ffi::ui();
        for _ in 0..ticks_per_virtual_frame {
            ui.tick();
        }
        #[cfg(feature = "bench")]
        let bench_after_tick = bench_now_us();
        if guest_frame == 0 {
            trace("frame 0: ui tick ok");
        }
        let (words_ptr, words_len) = {
            let dl = ui.draw();
            (dl.words.as_ptr(), dl.words.len())
        };
        #[cfg(feature = "bench")]
        let bench_after_draw = bench_now_us();
        if guest_frame == 0 {
            trace("frame 0: ui draw ok");
        }

        // ---- PIPELINED PRESENT: the GE has been executing frame N-1's list
        // while the JS/tick/draw above ran. Only NOW wait for it, present it,
        // then kick frame N's list and loop straight into frame N+1's CPU
        // work. Wall time ~= max(CPU, GE) instead of CPU + GE; one frame of
        // latency, the standard PSP double-buffered-list pattern. The vertex
        // pool and the display-list buffer are reused only after the sync, so
        // single instances of both stay sufficient.
        //
        // Guest frame 0 after a swap has nothing kicked and nothing to show:
        // skip the present so the last app frame HOLDS through the new
        // guest's eval instead of flashing the two-frames-stale draw buffer.
        // Cold boot (GLOBAL_FRAME == 0) keeps the original present-first
        // behavior so single-app builds are bit-identical to before.
        let present = GLOBAL_FRAME == 0 || guest_frame > 0;
        #[cfg(feature = "bench")]
        let bench_before_sync = bench_now_us();
        if present {
            sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
            #[cfg(feature = "bench")]
            bench_record_gpu(guest_frame, bench_now_us().saturating_sub(bench_before_sync));
            if guest_frame == 0 {
                trace("frame 0: gu sync (previous list) ok");
            }
            wait_for_present(last_present_vcount, ticks_per_virtual_frame);
            if guest_frame == 0 {
                trace("frame 0: vblank ok");
            }
            sys::sceGuSwapBuffers();
            if guest_frame == 0 {
                trace("frame 0: swap ok");
            }
            // Capture build only (tests/e2e/ppsspp.ts): the buffer just
            // presented holds frame N-1 (the pipeline is one frame deep), so
            // dump under that index — file fN keeps meaning "simulated frame
            // N", and the baked input identity (input at frame N -> file fN)
            // is preserved. The frame a switch discards never presents, so
            // its index simply has no file.
            #[cfg(feature = "capture")]
            if GLOBAL_FRAME > 0 {
                cap_dump_frame(GLOBAL_FRAME.wrapping_sub(1));
            }
        }
        #[cfg(feature = "bench")]
        let bench_after_present = bench_now_us();

        // ---- Guest swap (docs/LAUNCHER.md): a switch requested this frame (op
        // appLaunch, or the SELECT chord) lands here — the display holds the
        // last presented frame, the GE is idle, list N was never kicked.
        if let Some((next, summon)) = switch::take_pending() {
            if summon {
                // The frozen frame reads the just-presented framebuffer.
                switch::capture_shot();
            }
            trace("switch: teardown begin");
            vid::close(ffi::ui()); // stops audio, frees the plane (Ui alive)
            audio_mod::reset(); // guest-scoped streams die with their guest
            svc::reset();
            pocketjs_psp::offload::reset();
            JS_FreeValue(ctx, frame_fn);
            JS_FreeValue(ctx, global);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            trace("switch: teardown ok");
            GLOBAL_FRAME = GLOBAL_FRAME.wrapping_add(1);
            return next;
        }

        // GE idle (sceGuSync above): rewind the per-frame bump vertex
        // arena [R] and open frame N's list. The video plane commits its
        // staged frame here too — the ONLY window where the GE is not
        // sampling the texture it overwrites in place (vid.rs).
        ge::reset_pool();
        vid::present(ffi::ui());
        if guest_frame == 0 {
            trace("frame 0: pool reset ok");
        }
        sys::sceGuStart(GuContextType::Direct, host::list_ptr());
        if guest_frame == 0 {
            trace("frame 0: gu start ok");
        }
        ge::render(ffi::ui(), core::slice::from_raw_parts(words_ptr, words_len));
        #[cfg(feature = "bench")]
        let bench_after_render = bench_now_us();
        #[cfg(feature = "bench")]
        bench_record_frame(
            guest_frame,
            bench_frame_start,
            bench_after_js,
            bench_after_jobs,
            bench_after_tick,
            bench_after_draw,
            bench_after_render,
            bench_after_present.saturating_sub(bench_before_sync),
        );
        if guest_frame == 0 {
            trace("frame 0: rendered");
        }
        sys::sceGuFinish(); // kick list N — the GE draws while frame N+1's CPU runs
        if guest_frame == 0 {
            trace("frame 0: gu finish (kicked) ok");
        }
        if guest_frame == 0 {
            #[cfg(feature = "bench")]
            bench_record_frame0_complete();
        }
        #[cfg(feature = "bench")]
        bench_maybe_flush(guest_frame);
        if guest_frame == 0 {
            trace("frame 0: complete");
        }

        guest_frame = guest_frame.wrapping_add(1);
        GLOBAL_FRAME = GLOBAL_FRAME.wrapping_add(1);
    }
}

// ---------------------------------------------------------------------------
// Capture support (PPSSPPHeadless E2E, tests/e2e/ppsspp.ts). Ported verbatim
// from origin/main:runtime/src/main.rs (parse_capture_u32, capture_input_mask,
// cap_dump_frame) with the capture window made per-build (POCKETJS_CAP_START /
// POCKETJS_CAP_N env, baked like the input script): PocketJS's frame 0 lands after
// the slow QuickJS bundle eval, but mount transitions and mount-started tweens
// (e.g. hero's 850 ms underline sweep) play out over the first frames, and
// each demo needs a different settle horizon.
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
        out = out.saturating_mul(if hex { 16 } else { 10 }).saturating_add(d as u32);
        any = true;
        i += 1;
    }
    if any { Some(out) } else { None }
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
