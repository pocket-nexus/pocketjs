# Candidate C SDK

**`pocket sdk export` builds a local candidate SDK.** It does not publish a
release, download an archive, or freeze the C ABI. The command requires Bun,
Cargo, and the Rust target used for the archive. A C consumer of the exported
directory does not need Cargo or the PocketJS checkout.

```sh
bun tools/pocket.ts sdk export \
  --triple aarch64-apple-darwin \
  --out .pocket-build/validation/sdk/local
bun tools/pocket.ts sdk verify --dir .pocket-build/validation/sdk/local
```

The installed CLI exposes the same commands as `pocket sdk export` and
`pocket sdk verify`. SDK commands do not read an application manifest or select
an application target. `--out` must name a directory that does not exist.

The export contains:

| Path | Content |
| --- | --- |
| `include/pocket/{runtime,drivers,spec}.h` | Byte copies of the canonical generated headers |
| `include/pocket/pocket_{runtime,drivers,spec}.h` | Include shims for generated nested includes and existing C guest source |
| `include/pocket/pocket_guest_quickjs.h` | C guest lifecycle API |
| `lib/<triple>/libpocket_runtime.a` | One Rust archive; MSVC exports use `pocket_runtime.lib` |
| `src/guest-quickjs/{guest.c,generated_ops.h}` | C glue and generated operation descriptors |
| `lib/cmake/Pocket/` | Relocatable CMake package |
| `sdk-manifest.json` | Source identity, build parameters, file sizes and SHA-256 values |
| `LICENSE` | PocketJS license |

**The archive uses `no_std`, `alloc`, and `panic=abort`; legacy features are
disabled.** The program supplies the six `pocket_host_*` functions declared in
the headers. The archive contains its panic personality support. The program
links one PocketJS Rust archive and compiles its C drivers and guest glue with
its own C compiler. QuickJS is a consumer dependency and is not in the export.
The C guest copies package bytes unless the consumer opts into the verified
immutable-buffer path described in `pocket_guest_quickjs.h`.

For CMake, provide the QuickJS target before loading the package:

```cmake
# consumer_quickjs is defined by this program and publishes quickjs.h.
set(Pocket_QUICKJS_TARGET consumer_quickjs)
find_package(Pocket CONFIG REQUIRED COMPONENTS runtime guest_quickjs)
target_link_libraries(my_program PRIVATE Pocket::guest_quickjs)
```

Pass `-DCMAKE_PREFIX_PATH=/path/to/sdk` at configuration. `Pocket::runtime`
imports the archive and its system link dependencies. `Pocket::guest_quickjs`
adds the exported C source to the consumer target and links the runtime and
the named QuickJS target. A program that implements its own guest links
`Pocket::runtime`. `#include <pocket/runtime.h>` exposes the runtime contract.

`--toolchain` selects the Rust toolchain through `RUSTUP_TOOLCHAIN` and defaults
to `stable`. `--cargo` and `--rustc` select executable paths; `--toolchain none`
leaves toolchain selection to those executables and the environment. Repeat
`--cargo-arg` for `-Z...`, `--offline`, `--frozen`, or `--config=...` arguments.
Repeat `--rustflag` for compiler arguments; the exporter appends `-C panic=abort`.
Ambient `RUSTFLAGS` and compiler wrappers are cleared. A custom target JSON is
accepted by `--triple`; its content hash is included in the manifest.

ESP32-P4 consumers using the IDF `ilp32f` ABI can request archive preparation:

```sh
bun tools/pocket.ts sdk export \
  --triple riscv32imafc-unknown-none-elf --toolchain 1.93.0 \
  --prepare esp32p4 --archiver /path/to/llvm-ar \
  --out .pocket-build/validation/sdk/esp32p4
```

This preparation removes the compiler-rt C object group identified by its
`int_util.o` or `popcountsi2.o` member. Rust `compiler_builtins` members remain.
The manifest records the unprepared archive hash, removed member names,
archiver version, preparation version, and prepared file hash. It is an
explicit IDF choice; the target triple alone does not enable it.

**The manifest identifies a candidate build, including dirty source state.**
It records the Git revision when available, a digest of local build inputs,
the compiler and Cargo versions, target, features, flags, and every exported
file. Source changes during compilation make export fail. Verification rejects
changed, missing, and unlisted files. These hashes check the exported contents;
they are not release signatures. Build logs and Cargo output remain under
`.pocket-build/validation/sdk/` and are excluded from the export.

`bun test tests/sdk.test.ts` builds the archive, copies the SDK to a temporary
directory outside the checkout, hides the original export, and compiles and
runs a CMake program with a consumer-owned QuickJS build. It checks package
loading, JavaScript evaluation, one frame callback, software display transfers,
destruction, and zero outstanding host allocations. It also checks canonical
archive symbols and the absence of legacy entry points. The maintained fixture
is `tests/fixtures/sdk/`.
