# PocketJS PSP Benchmark Metrics

Read this reference when explaining `tools/bench-ppsspp.ts` output.

## Timing

- `eval_us`: QuickJS global bundle evaluation time.
- `boot_to_eval_begin_us`: host setup time before JavaScript evaluation begins.
- `boot_to_frame0_us`: elapsed time from native run start to the first completed frame.
- `avg_js_us`: average time spent in `globalThis.frame(buttons)`.
- `avg_jobs_us`: average time spent draining QuickJS pending jobs.
- `avg_tick_us`: average core tick, animation, and layout time.
- `avg_draw_us`: average draw-list construction time.
- `avg_render_us`: average PSP GE backend submission time.
- `avg_work_us`: average frame work from controller read through render submission. Compare this with `16667us` for 60 Hz.
- `max_work_us`: worst frame work in the measured window.
- `host_wall_ms`: wall time of the PPSSPPHeadless process on the host machine; use this for runner cost, not PSP frame budget.

## Size And Memory

- `bundle_bytes`: bundled JavaScript size embedded in the EBOOT.
- `pak_bytes`: asset pack size embedded in the EBOOT.
- `arena_capacity_bytes`: capacity of the single shared arena used by Rust alloc, QuickJS, and newlib malloc.
- `arena_bump_bytes`: high-water bytes carved from the arena. This includes allocator size-class fragmentation and is the relevant pressure number for minimum arena scans.
- `arena_tail_free_bytes`: unused tail capacity in the arena at report time. It does not include blocks held on free lists.
- `arena_init_free_bytes`: PSP user partition max-free value observed when the arena initialized.
- `arena_configured_bytes`: requested `POCKETJS_ARENA_BYTES`; `0` means the production default of max free memory minus margin.
- `drawlist_checksum`: deterministic FNV-1a-style checksum over the `u32` draw-list words returned by `ui.draw()` across the measured window. It uses seed `0xcbf29ce484222325` and prime `0x100000001b3`; use it to report rendered-workload differences, not to claim identical input event sequences.

## Memory Scan Fields

- `uncapped_arena_bump_bytes`: high-water from the normal uncapped benchmark run.
- `min_pass_arena_bytes`: smallest probed arena cap that completed the scripted benchmark window at the configured step size.
- `safety_margin_bytes`: applied margin, usually `max(512 KiB, 20%)`.
- `safe_arena_bytes`: `min_pass_arena_bytes + safety_margin_bytes`, rounded up to the configured step size.
- `suite.safe_arena_bytes`: maximum `safe_arena_bytes` across selected apps; use this as the suite-level minimum with safety margin.

## Caveats

PPSSPP measurements are deterministic and useful for regression tracking, but they are not real PSP hardware proof. The arena high-water is a practical capacity requirement for this allocator, not a precise live-object heap profile, because freed blocks remain reserved in size-class free lists.

The core Rust harness is a deterministic synthetic workload profile. PSP uses the existing `stats` app as a representative workload with corresponding phases. The two journeys are not byte-identical event sequences; reports must state any drawlist checksum difference explicitly.
