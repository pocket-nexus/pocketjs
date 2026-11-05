# Buildroot external tree

`pocketjs` uses Buildroot's **`cargo-package` infrastructure** to build a Rust program. The default crate is `pocket-linux-kms`. `pocketjs-app` installs a precompiled application at `/usr/share/pocketjs/app.pocket`. Neither package invokes an application compiler or requires Bun on the target.

Use Buildroot 2026.08 or a product tree with Rust ≥1.93. Buildroot 2026.08 supplies Rust 1.97.1. The external tree supports little-endian ARM/AArch64 and x86 products with threads and an MMU.

## Prepare release sources

Download the source asset and `pocket-release.json` from the same release, then run on Linux:

```sh
python3 tools/packaging/buildroot/prepare.py /releases/pocket-release.json /src/buildroot /product/pocketjs-external
```

The tool verifies the source archive's byte count and SHA-256 against the release index, records its exact Git revision, checks archive paths, and invokes that Buildroot tree's `cargo-post-process`. That process vendors the locked Cargo dependency graph. The generated external tree contains the vendored source archive, `source.mk`, a `.hash` file and `source-receipt.json`.

**The original release hash and the vendored archive hash are different identities.** The receipt records both. Buildroot sees the `VENDOR` directory and uses the prepared archive without a second transformation. The preparation requires the release's full workspace dependency closure, including pinned Git dependencies. No fixture hash is a release hash, and this repository does not supply an invented hash for an unpublished archive.

## Configure a product

Before the firmware build, product CI exports the host contract and compiles the application:

```sh
pocket host export --config /product/pocket.host.config.ts --out /product/generated
pocket compile --manifest /product/app/pocket.app.json --host-config /product/pocket.host.config.ts --output /product/generated/app.pocket
make -C /src/buildroot BR2_EXTERNAL=/product/pocketjs-external menuconfig
```

Select `BR2_PACKAGE_POCKETJS`, set `BR2_PACKAGE_POCKETJS_PROFILE` to the export directory (`/product/generated` above), and select `BR2_PACKAGE_POCKETJS_APP` with `BR2_PACKAGE_POCKETJS_APP_FILE` pointing to the compiled package. Before native compilation, `validate_profile.py` checks `pocket.host.json` against the release's binding generation and checks that `pocket_profile.rs` carries the same hash; the cargo build then compiles `pocket_profile.rs` into the program through `POCKETJS_PROFILE_RS`, and the runtime admits `app.pocket` against those compiled-in facts. **No host contract file is installed on the target.** `S90pocketjs` starts the program only when the application file exists.

`BR2_PACKAGE_POCKETJS_ALSA` adds the ALSA dependency and the program's `alsa` Cargo feature. It does not choose a renderer, change the product's host contract or promise a guest audio namespace. A product source archive may set `BR2_PACKAGE_POCKETJS_PROGRAM` to another workspace binary crate; its name must match its package name, its `build.rs` must call `pocket_profile_build::emit`, and its command line must accept the installed package path, or the product must replace the init script.

For development, Buildroot's `POCKETJS_OVERRIDE_SRCDIR` may point to a working source tree with the same layout. This bypasses release download/hash validation and must be identified as a development override in build evidence.

## Verification scope

`tests/buildroot.test.ts` checks release preparation, corrupted input rejection, host contract identity and package wiring. `tests/recipe.mk` executes the actual Buildroot `cargo-package` build macro and this external tree's install/init macros against a source tree. It then runs the installed binary with a file package and the ALSA null plugin. Set `BUILDROOT_SOURCE`, `SOURCE`, `TARGET_DIR`, `BR2_EXTERNAL_POCKETJS_PATH`, `BR_CARGO_HOME`, the export directory and the package path when invoking it. This integration harness uses a native AArch64 Linux compiler; it does not build or boot a firmware image and does not validate a board's cross toolchain, display, input or audio devices.
