# Native QuickJS program

`pocket_qjs_program.c` composes `PocketNativeProgram` with a generated QuickJS
guest. **Each `PocketQjsProgram` owns its runtime, retained tree and JS realm.**
The host creates the program, boots copied JavaScript and PAK bytes, advances
canonical `pocket_input_frame` samples, presents and destroys the instance.
Runtime computes contact hits and dispatches numbered UI operations.

C hosts link `programs/native/runtime`, this source and
`engine/guest-quickjs/src/guest.c` against their pinned QuickJS. Native
extensions, POSIX offload and service callbacks are selected by the host build.
Offload texture uploads use the program's runtime operation table.

`POCKET_RUNTIME_STAGE_HOOKS` enables `pocket_bench_stage(int stage)` callbacks
for evaluation, guest frames, jobs and native ticks. Shutdown requested inside
a guest callback waits for that call to return. Destruction runs outside
callbacks on the owning thread.

## Validation

`bun test tests/quickjs-c-harness.test.ts` exercises production, native
extension, stage hook, physics and service builds with real QuickJS and the
Rust archive. It checks package lifetime, input cancellation, failure paths,
shutdown reentry and independent interleaved instances.

`bun test tests/native-program.test.ts` links the generated guest with the
no_std GPU composition and a mock GL device. It checks viewport changes,
collection, context resets and completion before resource release.
