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

## Host composition

`pocket_qjs_program_create_host` takes a `pocket_qjs_program_host` record
that replaces parts of the default composition:

| Member | Default | Host value |
| --- | --- | --- |
| `profile`, `profile_hash` | `pocket_host_profile.h` | Profile facts and hash from the host build; a build without the header defines `POCKET_QJS_HOST_PROFILE` |
| `guest`, `guest_context`, `guest_error` | The facade's QuickJS realm and `guest_table` | A `pocket_guest_v1` table with its own context; the host owns its `JSRuntime` and `JSContext` |
| `compose` | None | Registers renderers, displays, input sources and op providers on the program's runtime and starts host services, after the guest is attached and before admission |
| `release` | None | Stops what `compose` started, once, before the facade destroys that program |

**Three boot forms select the package.** `pocket_qjs_program_boot` copies raw
JavaScript and PAK bytes, `pocket_qjs_program_boot_package` copies a complete
`.pocket` with its catalog identity, and `pocket_qjs_program_boot_source`
passes a host `pocket_package_source_v1` that Runtime reads at boot. The first
two keep native asset loading off; the source form keeps it on, so the guest
receives the pak's named textures and sprites. An admission failure returns
before the guest initializes. Outputs come from the program archive: the CPU
buffer, the GLES 1.1 or 2 renderer, or none under `host-backend`, where
`compose` registers them. `pocket_qjs_program_runtime` returns the booted
runtime for host presentation and op calls. App actions, native extensions and
POSIX offload belong to the facade's own realm. `products/3ds` uses the host
guest, `compose` and the source form.

`POCKET_RUNTIME_STAGE_HOOKS` enables `pocket_bench_stage(int stage)` callbacks
for evaluation, guest frames, jobs and native ticks. Shutdown requested inside
a guest callback waits for that call to return. Destruction runs outside
callbacks on the owning thread.

## Validation

`bun test tests/quickjs-c-harness.test.ts` exercises production, native
extension, stage hook, physics and service builds with real QuickJS and the
Rust archive. It checks package lifetime, input cancellation, failure paths,
shutdown reentry and independent interleaved instances, for the facade's own
guest and for host guests with host package sources, input sources and
release hooks.

`bun test tests/native-program.test.ts` links the generated guest with the
no_std GPU composition and a mock GL device. It checks viewport changes,
collection, context resets and completion before resource release.
