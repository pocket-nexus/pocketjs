# Portable QuickJS C runtime

`pocket_runtime.c` composes `PocketNativeProgram` with an attached generated
QuickJS guest. **One canonical Runtime owns package admission, the retained
core, input encoding, core ticks and terminal presentation.** The program
copies the input JavaScript and PAK before boot; generated `ui` functions
coerce arguments and dispatch through the Runtime operation table.

Native C hosts compile this source and `engine/guest-quickjs/src/guest.c`
against `programs/native/cabi` and their pinned QuickJS. `pocket_legacy_runtime.h`
is the compatibility facade; `contracts/generated/pocket_runtime.h` is the
instance API. Host contact samples contain positions, IDs and cancellation;
Runtime computes down-edge hits. Private offload, native extension and
benchmark hooks remain in the program.

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
and executes seven combinations of stage, dispatcher, extension, physics and
service support against the pinned QuickJS and the Rust Runtime archive.
The C fixture covers argument coercion, input cancellation, one guest turn
with bounded core steps, package lifetime and shutdown reentry.

`bun test tests/native-program.test.ts` also links the generated guest with
the no_std GPU composition and a mock GL device. It checks viewport changes,
collect callbacks, context resets and terminal completion before resource
release.

`bun test tests/ui-cabi-allocator.test.ts` builds the real UI C ABI static library
with `bare-platform,software-only` using the nightly pinned in
`tools/build/toolchains/rust.ts`. A C executable uploads textures through
both the C `malloc` path and the `host-allocator` callback path, exercises table
growth, and releases textures through free and shutdown. The host callback
fixture checks 16-byte alignment, allocation/reallocation calls, and cleanup.
This test needs `rustup`, the pinned nightly, and a C compiler. The Rust unit
texture test uses the default allocator and covers upload behavior, not the
`CAllocator` allocation path.
