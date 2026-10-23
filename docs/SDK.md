# C SDK and release artifacts

**`pocket sdk export` downloads a release SDK and verifies its file hashes.**
The version defaults to the installed framework version. `--version` selects an
exact release version; `--manifest-url` selects a release index mirror. Archives
use the content-addressed toolchain store. Export requires Bun and an archive
extractor; consuming the SDK requires the product's C compiler.

```sh
pocket sdk export --triple aarch64-apple-darwin --out vendor/pocket
pocket sdk verify --dir vendor/pocket
pocket sdk export --cargo --out native-program
```

**`pocket sdk build` compiles a local candidate SDK.** Run it in a source checkout
with Cargo and the target toolchain installed. SDK commands do not read an
application manifest. `--out` must name a directory that does not exist.

```sh
bun tools/pocket.ts sdk build --triple aarch64-apple-darwin \
  --out .pocket-build/validation/sdk/local
```

The Cargo template depends on a versioned `pocket-runtime-cabi` crate with
`default-features = false`. Add Rust driver dependencies to that program crate;
it produces the program's single Rust static archive. The versioned template
requires those crates to be published to the selected Cargo registry; generating
the template does not publish them. A prerelease consumer can select an exact
Git revision, as in `tests/fixtures/out-of-tree-rust/Cargo.toml.in`. The `std` feature provides
the six host hooks through the standard library. A no_std program provides them.

The export contains:

| Path | Content |
| --- | --- |
| `include/pocket/{runtime,drivers,spec}.h` | Byte copies of the canonical generated headers |
| `include/pocket/pocket_{runtime,drivers,spec}.h` | Include shims for generated nested includes, exported `pocket_profile.h` and existing C guest source |
| `include/pocket/pocket_guest_quickjs.h` | C guest lifecycle API |
| `lib/<triple>/libpocket_runtime.a` | One Rust archive; MSVC exports use `pocket_runtime.lib` |
| `src/guest-quickjs/{guest.c,generated_ops.h}` | C glue and generated operation descriptors |
| `lib/cmake/Pocket/` | Relocatable CMake package |
| `sdk-manifest.json` | Source identity, binding generation (`hostAbi`), build parameters, file sizes and SHA-256 values |
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
**`pocket_runtime_config.profile` points at `pocket_profile.facts`**, the
`pocket_profile_facts` record in the `pocket_profile.h` that `pocket profile
export` writes. That header includes `pocket_runtime.h`, which resolves through
the `include/pocket` directory `Pocket::runtime` publishes.

`--toolchain` selects the Rust toolchain through `RUSTUP_TOOLCHAIN` and defaults
to `STABLE_RUST_TOOLCHAIN` from `tools/build/toolchains/rust.ts`. `--cargo` and `--rustc` select executable paths; `--toolchain none`
leaves toolchain selection to those executables and the environment. Repeat
`--cargo-arg` for `-Z...`, `--offline`, `--frozen`, or inline
`--config=key=value` arguments. Configuration file arguments are rejected.
Repeat `--rustflag` for compiler arguments; the exporter appends `-C panic=abort`.
Ambient `RUSTFLAGS`, `CARGO_PROFILE_*` overrides and compiler wrappers are cleared. A custom target JSON is
accepted by `--triple`; its content hash is included in the manifest.

ESP32-P4 consumers using the IDF `ilp32f` ABI can request archive preparation:

```sh
bun tools/pocket.ts sdk build \
  --triple riscv32imafc-unknown-none-elf --toolchain 1.98.1 \
  --prepare esp32p4 --archiver /path/to/llvm-ar \
  --out .pocket-build/validation/sdk/esp32p4
```

This preparation removes the compiler-rt C object group identified by its
`int_util.o` or `popcountsi2.o` member. Rust `compiler_builtins` members remain.
The manifest records the unprepared archive hash, removed member names,
archiver version, preparation version, and prepared file hash. It is an
explicit IDF choice; the target triple alone does not enable it.

**A local build records candidate status and dirty source state.**
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


`tools/release/matrix.ts` defines targets and feature sets. `tools/release/archive.ts`
builds each default archive; `receipt.ts` verifies its manifest. `publish.ts` takes
an inputs JSON file with `version`, `revision`, SDK directories keyed by triple,
and runtime directories keyed by profile id. It requires clean matching source
identities, writes deterministic archives and `pocket-release.json`, and leaves
uploads to CI. `sourceRoot` adds a Git source archive for Buildroot. Release status
records distribution; `abiFrozen` records the separate ABI acceptance decision.

**`pocket pack` downloads the selected program's release runtime by default.**
It verifies archive hashes, file hashes, binding generation and profile hash
before embedding the compiled application. `--release-version` selects a release;
`--runtime` supplies a local runtime directory or a successful build output.
A missing release fails with its URL and HTTP status. Run `pocket build --generic`
from a source checkout and pass its output with `--runtime` for local development.

The npm package contains the framework, TypeScript compiler and tools, profiles,
contracts, generated headers and browser assets. Rust crates, C glue and platform
components come from their Cargo, SDK and platform distributions.

## Runtime release artifacts

**The release workflow builds PSP, Vita and 3DS generic runtimes from their
program configurations.** `tools/release/inputs.ts` requires every SDK matrix
row and all three runtime artifacts. It checks successful generic build
receipts, the release revision, profile hashes, binding generation, file lists
and hashes before `publish.ts` prepares archives. Vita release builds install
the fixed SDK and four port archives through `tools/build/toolchains/vita.ts`.
The installer retains source archives in the content cache and checks their
hashes and the installed SDK tree on reuse.

## Program inspection

**`pocket doctor` reads the selected program configuration, toolchain records
and optional validation receipts.** It does not install tools or access a device.

```sh
pocket doctor --target psp --generic --json
pocket doctor --target vita --generic \
  --build-receipt .pocket-build/vita/build-receipt.json \
  --runtime .pocket-build/vita/runtime
```

Use `--config` for an external program. A build receipt is checked against the
selected profile and current artifact bytes. A runtime directory is checked
against `runtime.json`. Native tools without a toolchain manifest are reported
as unverified; their program recipe performs the native preflight.

`--evidence FILE --identity FILE` checks a `DeviceEvidence` receipt against an
expected `{device, runtimeBuild, assets}` identity. The product obtains that
identity from its device readback. `--device KEY` probes an existing lease file
with a nonblocking OS lock, then releases it without changing its owner. Evidence without
observations, identity changes and held leases produce failures. **Absent device
evidence remains unverified; matching identity does not assert a product's
measurement budgets.** Products set and evaluate those limits in their tests.
