#![no_std]
#![no_main]

//! Interactive PSP acceptance for permanent arena storage and QuickJS counters.
//! Build together with the normal host: bun tools/psp.ts hero --release --example allocator-check
use core::ffi::c_void;
use libquickjs_sys::*;
use pocketjs_psp::{arena, host, qjs_alloc};
use psp::sys::{self, CtrlButtons, SceCtrlData};

psp::module!("allocator_check", 1, 1);
const PERMANENT_BYTES: usize = 18_200_001;
extern "C" {
    fn JS_RunGC(rt: *mut JSRuntime);
}

fn psp_main() {
    unsafe {
        host::reset_fpu_status();
        host::run_on_worker(worker, run);
    }
}
unsafe extern "C" fn worker(_: usize, _: *mut c_void) -> i32 {
    host::reset_fpu_status();
    run();
    0
}
unsafe fn check(ok: bool, label: &str) {
    if !ok {
        psp::dprintln!("FAIL: {}", label);
        host::halt("allocator acceptance failed");
    }
}

unsafe fn quickjs_round() {
    let baseline = qjs_alloc::stats().live_requested;
    let rt = qjs_alloc::new_runtime();
    check(!rt.is_null(), "QuickJS runtime allocation");
    let ctx = JS_NewContext(rt);
    check(!ctx.is_null(), "QuickJS context allocation");
    let script = b"(() => { const a=[]; for(let i=0;i<500;i++) a.push({n:i,s:'x'.repeat(64)}); const cycle={}; cycle.self=cycle; return a.length; })()\0";
    for _ in 0..20 {
        let value = JS_Eval(
            ctx,
            script.as_ptr().cast(),
            script.len() - 1,
            b"allocator-check.js\0".as_ptr().cast(),
            JS_EVAL_TYPE_GLOBAL as i32,
        );
        check(
            JS_ValueGetTag(value) != JS_TAG_EXCEPTION,
            "QuickJS allocation workload",
        );
        JS_FreeValue(ctx, value);
        JS_RunGC(rt);
    }
    check(
        qjs_alloc::stats().live_requested > baseline,
        "live QuickJS bytes",
    );
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    check(
        qjs_alloc::stats().live_requested == baseline,
        "QuickJS teardown returns live bytes",
    );
}

unsafe fn run() {
    psp::enable_home_button();
    sys::sceCtrlSetSamplingCycle(0);
    psp::dprintln!("PocketJS allocator acceptance (#423 + #422)");
    psp::dprintln!(
        "{}",
        option_env!("POCKETJS_ALLOCATOR_REVISION").unwrap_or("local build")
    );
    let initial = arena::stats();
    psp::dprintln!(
        "Arena: {} KiB; tail: {} KiB",
        initial.capacity_bytes / 1024,
        initial.tail_free_bytes / 1024
    );
    let before = arena::stats().bump_bytes;
    check(
        arena::alloc_permanent(0, 16).is_null(),
        "zero-size rejection",
    );
    check(
        arena::alloc_permanent(32, 3).is_null(),
        "alignment rejection",
    );
    check(
        arena::alloc_permanent(usize::MAX, 16).is_null(),
        "overflow rejection",
    );
    check(
        arena::stats().bump_bytes == before,
        "failed requests preserve tail",
    );
    psp::dprintln!("PASS invalid requests preserve capacity");

    // Reserve once. Every rerun reuses this storage; permanent blocks cannot be freed.
    let before = arena::stats().bump_bytes;
    let permanent = arena::alloc_permanent(PERMANENT_BYTES, 16);
    check(
        !permanent.is_null(),
        "18.2 MB permanent buffer (check available partition)",
    );
    check(permanent as usize % 16 == 0, "permanent alignment");
    let cost = arena::stats().bump_bytes - before;
    check(
        cost >= PERMANENT_BYTES && cost <= PERMANENT_BYTES + 15,
        "exact size plus alignment only",
    );
    permanent.write_bytes(0x5a, PERMANENT_BYTES);
    check(
        core::slice::from_raw_parts(permanent, PERMANENT_BYTES)
            .iter()
            .all(|b| *b == 0x5a),
        "permanent storage readback",
    );
    psp::dprintln!(
        "PASS permanent {} bytes; arena cost {}",
        PERMANENT_BYTES,
        cost
    );

    let free_before = arena::debug_free().0;
    let small = arena::alloc(100, 16);
    check(
        !small.is_null(),
        "ordinary allocation after odd permanent size",
    );
    check(small as usize % 16 == 0, "ordinary alignment");
    small.write_bytes(7, 100);
    arena::dealloc(small, 100, 16);
    let free_after = arena::debug_free().0;
    check(
        free_after <= free_before && free_before - free_after < 16,
        "free totals account for alignment padding",
    );
    let again = arena::alloc(100, 16);
    check(again == small, "free-list reuse");
    arena::dealloc(again, 100, 16);
    psp::dprintln!("PASS recycling and free-space accounting");

    let mut rounds = 0u32;
    let mut previous = CtrlButtons::empty();
    let mut first = true;
    loop {
        let mut pad = SceCtrlData::default();
        sys::sceCtrlPeekBufferPositive(&mut pad, 1);
        let rerun =
            pad.buttons.contains(CtrlButtons::CROSS) && !previous.contains(CtrlButtons::CROSS);
        previous = pad.buttons;
        if first || rerun {
            first = false;
            psp::dprintln!("Running QuickJS allocation / GC / teardown...");
            quickjs_round();
            check(
                *permanent == 0x5a && *permanent.add(PERMANENT_BYTES - 1) == 0x5a,
                "permanent data survives QuickJS churn",
            );
            rounds += 1;
            let stats = qjs_alloc::stats();
            let (free, largest) = arena::debug_free();
            psp::dprintln!(
                "PASS round {}; live {} B; peak {} KiB",
                rounds,
                stats.live_requested,
                stats.peak_requested / 1024
            );
            psp::dprintln!(
                "Free {} KiB; largest {} KiB; calls {}",
                free / 1024,
                largest / 1024,
                stats.alloc_calls
            );
            psp::dprintln!("READY - CROSS reruns; HOME exits");
        }
        sys::sceDisplayWaitVblankStart();
    }
}
