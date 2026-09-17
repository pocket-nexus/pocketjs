#![no_std]
#![no_main]
#![allow(static_mut_refs)]

//! Pocket Micro PSP host: mounts a compiled Micro TS app straight into
//! pocketjs-core and drives fixed-rate frames. There is no interpreter in
//! this binary: input edges, focus, press handlers and signal flushes are
//! the generated Rust in `app.rs` plus the pocket-micro runtime.
//!
//! Frame order (same pipeline as hosts/psp/src/main.rs): sceCtrlPeek ->
//! app frame(buttons) -> core.tick(1/60) -> core.draw() -> present the
//! previous list (sceGuSync / vblank / swap) -> kick this list.
//!
//! Receipt: at POCKET_MICRO_RECEIPT_FRAME (and every 600 frames after) one
//! JSON line goes to host0:/pocket-micro-receipt.txt (PSPLINK) and
//! ms0:/pocket-micro-receipt.txt with the build identity, per-stage
//! microsecond averages, arena use and the app's signal state.

extern crate alloc;

use alloc::string::String;
use core::ffi::c_void;
use core::fmt::Write;

use psp::sys::{
    self, CtrlMode, GuContextType, GuSyncBehavior, GuSyncMode, IoOpenFlags, SceCtrlData,
};

use pocket_micro::{pak, tape, App as MicroApp, Runtime};
use pocketjs_core::Ui;
use pocketjs_psp::{arena, ge, host};

psp::module!("pocket-micro", 1, 1);

include!(concat!(env!("OUT_DIR"), "/app.rs"));

use app::App;

static APP_PAK: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app.pak"));
static APP_NAME: &str = env!("POCKET_MICRO_APP");
static APP_TITLE: &str = env!("POCKET_MICRO_TITLE");
static BUILD_ID: &str = env!("POCKET_MICRO_BUILD");
static TAPE: &str = env!("POCKET_MICRO_TAPE");
static RECEIPT_FRAME: &str = env!("POCKET_MICRO_RECEIPT_FRAME");

fn psp_main() {
    unsafe {
        host::reset_fpu_status();
        host::run_on_worker(worker_main, run);
    }
}

unsafe extern "C" fn worker_main(_argc: usize, _argv: *mut c_void) -> i32 {
    host::reset_fpu_status();
    run();
    0
}

#[inline]
unsafe fn now_us() -> u64 {
    sys::sceKernelGetSystemTimeWide() as u64
}

/// Wait for the first vblank at or after the presentation target.
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

#[derive(Default)]
struct Stats {
    frames: u64,
    app_sum: u64,
    app_max: u64,
    tick_sum: u64,
    draw_sum: u64,
    render_sum: u64,
    mount_us: u64,
    boot_to_frame0_us: u64,
}

unsafe fn write_file(path: *const u8, bytes: &[u8]) {
    let fd = sys::sceIoOpen(
        path,
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, bytes.as_ptr() as *const c_void, bytes.len());
        sys::sceIoClose(fd);
    }
}

unsafe fn write_receipt(rt: &Runtime, app: &App, stats: &Stats, frame: u32) {
    let mut state = String::new();
    app.state(&mut state);
    let arena = arena::stats();
    let misses = rt.misses();
    let frames = stats.frames.max(1);
    let mut line = String::new();
    let _ = write!(
        line,
        "{{\"app\":\"{}\",\"title\":\"{}\",\"build\":\"{}\",\"engine\":\"native\",\"frame\":{},\"frames_measured\":{},\"tape\":\"{}\",\
         \"boot_to_frame0_us\":{},\"mount_us\":{},\"avg_app_us\":{},\"max_app_us\":{},\"avg_tick_us\":{},\"avg_draw_us\":{},\"avg_render_us\":{},\
         \"state\":{},\"focused\":{},\"unknown_texture\":{},\"unknown_sprite\":{},\
         \"arena_capacity_bytes\":{},\"arena_bump_bytes\":{},\"arena_tail_free_bytes\":{},\"pak_bytes\":{}}}\n",
        APP_NAME,
        APP_TITLE,
        BUILD_ID,
        frame,
        stats.frames,
        TAPE,
        stats.boot_to_frame0_us,
        stats.mount_us,
        stats.app_sum / frames,
        stats.app_max,
        stats.tick_sum / frames,
        stats.draw_sum / frames,
        stats.render_sum / frames,
        state,
        rt.focused().0,
        misses.unknown_texture,
        misses.unknown_sprite,
        arena.capacity_bytes,
        arena.bump_bytes,
        arena.tail_free_bytes,
        APP_PAK.len(),
    );
    write_file(
        b"host0:/pocket-micro-receipt.txt\0".as_ptr(),
        line.as_bytes(),
    );
    write_file(b"ms0:/pocket-micro-receipt.txt\0".as_ptr(), line.as_bytes());
}

unsafe fn run() {
    let boot_us = now_us();
    psp::enable_home_button();
    // Full clock, like the QuickJS host: PSPLINK launches modules at 222 MHz.
    sys::scePowerSetClockFrequency(333, 333, 166);
    host::init_graphics(host::GfxConfig::default());
    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);

    // The core, fed from the embedded pack; textures written back once for
    // the GE (it samples RAM, not the dcache).
    let mut ui = Ui::new();
    ge::reset_fonts();
    let assets = pak::feed(&mut ui, APP_PAK, |ui, handle| {
        ge::writeback_texture(ui, handle)
    });
    let mut rt = Runtime::new(ui, assets);
    let mut app = App::new();
    let mount_begin = now_us();
    rt.mount(&mut app);
    let mut stats = Stats {
        mount_us: now_us().saturating_sub(mount_begin),
        ..Stats::default()
    };

    let receipt_frame: u32 = RECEIPT_FRAME.parse().unwrap_or(240);
    let mut pad = SceCtrlData::default();
    let mut last_present_vcount = sys::sceDisplayGetVcount();
    let mut frame: u32 = 0;
    loop {
        let t0 = now_us();
        sys::sceCtrlPeekBufferPositive(&mut pad, 1);
        let mut mask = pad.buttons.bits();
        if let Some(scripted) = tape::mask_at(TAPE, frame) {
            mask = scripted;
        }
        rt.frame(&mut app, mask);
        let t1 = now_us();
        rt.ui.tick();
        let t2 = now_us();
        let (words_ptr, words_len) = {
            let dl = rt.ui.draw();
            (dl.words.as_ptr(), dl.words.len())
        };
        let t3 = now_us();

        // Pipelined present: finish + show the previous frame's list, then
        // kick this frame's list while the next frame's CPU work runs.
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        wait_for_present(&mut last_present_vcount, 1);
        sys::sceGuSwapBuffers();
        ge::reset_pool();
        sys::sceGuStart(GuContextType::Direct, host::list_ptr());
        let t4 = now_us();
        ge::render(&rt.ui, core::slice::from_raw_parts(words_ptr, words_len));
        let t5 = now_us();
        sys::sceGuFinish();

        if frame == 0 {
            stats.boot_to_frame0_us = t5.saturating_sub(boot_us);
        }
        let app_us = t1.saturating_sub(t0);
        stats.frames += 1;
        stats.app_sum += app_us;
        stats.app_max = stats.app_max.max(app_us);
        stats.tick_sum += t2.saturating_sub(t1);
        stats.draw_sum += t3.saturating_sub(t2);
        stats.render_sum += t5.saturating_sub(t4);
        if frame == receipt_frame || (frame > receipt_frame && (frame - receipt_frame) % 600 == 0) {
            write_receipt(&rt, &app, &stats, frame);
        }
        frame = frame.wrapping_add(1);
    }
}
