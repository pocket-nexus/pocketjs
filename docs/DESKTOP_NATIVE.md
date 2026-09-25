# Desktop native application modules

A macOS/Linux System application can carry a `desktop-native` version 1 host
extension. `desktopNativeExtension({ library, sha256, config })` creates the
extension; `SystemPackageInput.hostExtension` passes it through resolution and
includes it in the package and System hashes. The library path is relative to
the installed System plan's directory. Its parent directory contains that
application's resources. Configuration is limited to 16 KiB; a System can
install at most 64 applications.

The desktop host opens the library when its registered `CompositorSurface`
first becomes bound. Guest messages cannot request arbitrary libraries. The
host checks containment, the extension hash, the library SHA-256, the package
identity, the C table version and size, the SDK/compiler/profile fingerprint,
and the resolved wgpu dependency versions and features before creating state.
Browser targets and the System UI role reject native extensions.

## Module implementation

Depend on `engine/crates/pocket-desktop-native`, build a Rust `cdylib`, and
implement `Application::{create,event,tick,render}`. Export the table with
`export_application!(MyApplication, "dev.example.application", flags)`.
The module's build script includes the SDK's `build_support.rs` and calls
`emit_gpu_graph()` (build dependencies: `sha2 = "0.10"`, `serde_json = "1"`).
The host and application must use the same pinned SDK, compiler, build profile,
and wgpu dependency graph. Cargo metadata checks use the locked registry
sources. Rebuild both when these change.

The function table uses a versioned C layout and caller-owned error buffers.
GPU objects are borrowed Rust objects under the matching build contract;
**this is not a stable cross-version GPU ABI or a sandbox**. Native code is
trusted installation code with the host process's permissions. Hashes detect
artifact mismatches, not publisher authenticity. Panics become application
failures when Rust can unwind; aborts or invalid memory access can stop the
process. An untrusted plugin system requires process isolation.

The host owns the GPU, destination texture, compositor order, window geometry,
visibility, focus and scheduling. Each create call owns separate application
state, QuickJS realms and GPU resources. The application renders into an
RGBA8Unorm texture; `Render::linear_target` is an sRGB view of the same image
for linear-light 3D output (pipeline format `LINEAR_FORMAT`). The compositor
samples the encoded image without a CPU readback. Modules
may add commands to the borrowed encoder or submit earlier work to the shared
queue. They must not retain borrowed objects after callbacks return.

Raw key transitions, pointer buttons, scroll, relative motion and resize events
reach the focused native application. `POINTER_LOCK` requests mouse capture
on a content click claimed by the System UI. The Shell routes pointer events
through `{t:"native-pointer", package, x, y, d, b}` after chrome/menu hit testing;
the host consumes these intents before companion delivery and checks focused
package identity. During capture, raw mouse events bypass Shell hit testing.
The Shell marks the surface unfocused while a menu owns input. Escape, loss of focus, minimization and closing
release capture and held inputs; command shortcuts remain with the Shell.
Hidden applications follow the System's suspend/continue policy. Closing the
surface destroys application state. A callback failure stops subsequent ticks,
input and rendering and emits `app-error` to the System UI; closing and opening
creates a fresh instance. Library images remain mapped until process exit
because GPU driver callbacks can outlive an application instance. The loaded
image budget is 64. Replacing a loaded module requires a host restart.

## Validation

The fixture contains no application-specific host integration. It renders to
real GPU textures, responds to key input, journals lifetime events, and checks
two independent instances plus close/reopen, wrong package and changed hashes.

```sh
cargo build --release --locked --manifest-path hosts/desktop/Cargo.toml --example native-fixture
POCKET_NATIVE_FIXTURE="$PWD/hosts/desktop/target/release/examples/libnative_fixture.dylib" \
  cargo test --release --locked --manifest-path hosts/desktop/Cargo.toml dynamic_module -- --ignored
bun test tests/pocket-system.test.ts
```

On Linux use `libnative_fixture.so`. Native host acceptance scripts can use
`--native-key w,d@60 --native-key w,u@120`, `--motion 20,0@90`, and
`--snapshot .pocket-build/validation/frame.png@120`. Snapshots read the retained
GPU target only when requested; normal presentation stays on the GPU.
