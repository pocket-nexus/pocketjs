# Portable QuickJS C runtime

`pocket_runtime.c` owns one QuickJS runtime and context, installs the native
`ui` operations, evaluates an application bundle, and advances its frame
function, pending jobs, and native core ticks in that order. Native C hosts
compile this source directly against `engine/ui-cabi` and their pinned QuickJS.

## Harness integration

Defining `POCKET_RUNTIME_STAGE_HOOKS` makes the embedding program provide
`pocket_bench_stage(int stage)`. The runtime reports the boundaries of bundle
evaluation, the guest frame call, the pending-job drain, and native core ticks.
It returns to `POCKET_BENCH_STAGE_IDLE` before handing control back, including
failure paths entered after a measured stage begins.

Defining the separate `POCKET_RUNTIME_HARNESS` capability exposes
`pocket_legacy_runtime_harness_bind` and `pocket_legacy_runtime_harness_call`. A harness binds
one global dispatcher after boot; subsequent calls pass an integer opcode and
argument directly through `JS_Call`, with an optional integer result. The
runtime caches and releases the dispatcher with the guest realm. It neither
changes the current stage nor drains pending jobs.

The embedding owns attribution: it must enter the intended stage before a call
whose synchronous work belongs to a measurement. Jobs queued by the dispatcher
run in the next guest turn and are attributed to that turn's `JOBS` stage. The
runtime knows nothing about the opcode protocol; the external harness owns the
dispatcher implementation and its command/result meanings.

Rust harness crates that must inspect the matching retained UI singleton enable
the `harness-access` feature on `pocketjs-ui-cabi` and use the unsafe
`with_initialized_ui_unchecked` accessor under its documented no-reentrancy and
lifecycle contract. Production hosts leave all opt-ins disabled and continue
to use only the C ABI.

## Validation

The `Native C harness` pull-request workflow runs on Linux and macOS. It builds
and executes all four stage/dispatcher switch combinations against QuickJS/UI
stubs, runs renderer contracts, and tests `ui-cabi` with `harness-access` enabled.
The stubs cover runtime control flow; they do not replace a real QuickJS
benchmark run.

`bun test tests/ui-cabi-allocator.test.ts` builds the real UI C ABI static library
with `bare-platform,software-only` using the nightly pinned in
`engine/ui-cabi/rust-toolchain.toml`. A C executable uploads textures through
both the C `malloc` path and the `host-allocator` callback path, exercises table
growth, and releases textures through free and shutdown. The host callback
fixture checks 16-byte alignment, allocation/reallocation calls, and cleanup.
This test needs `rustup`, the pinned nightly, and a C compiler. The Rust unit
texture test uses the default allocator and covers upload behavior, not the
`CAllocator` allocation path.
