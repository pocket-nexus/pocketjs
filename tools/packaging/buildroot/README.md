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

Before the firmware build, product CI exports the profile and compiles the application:

```sh
pocket profile export --config /product/pocket.runtime-config.ts --out /product/generated
pocket compile --manifest /product/app/pocket.json --runtime-config /product/pocket.runtime-config.ts --output /product/generated/app.pocket
make -C /src/buildroot BR2_EXTERNAL=/product/pocketjs-external menuconfig
```

Select `BR2_PACKAGE_POCKETJS`, set `BR2_PACKAGE_POCKETJS_PROFILE` to the exported JSON file, and select `BR2_PACKAGE_POCKETJS_APP` with `BR2_PACKAGE_POCKETJS_APP_FILE` pointing to the compiled package. The profile is checked before native compilation and again by the runtime. `S90pocketjs` starts the program only when the application file exists.

`BR2_PACKAGE_POCKETJS_ALSA` adds the ALSA dependency and the program's `alsa` Cargo feature. It does not choose a renderer, change the product profile or promise a guest audio namespace. A product source archive may set `BR2_PACKAGE_POCKETJS_PROGRAM` to another workspace binary crate; its name must match its package name and its command line must accept the installed profile/package paths, or the product must replace the init script.

For development, Buildroot's `POCKETJS_OVERRIDE_SRCDIR` may point to a working source tree with the same layout. This bypasses release download/hash validation and must be identified as a development override in build evidence.

## Verification scope

`tests/buildroot.test.ts` checks release preparation, corrupted input rejection, profile identity and package wiring. `tests/recipe.mk` executes the actual Buildroot `cargo-package` build macro and this external tree's install/init macros against a source tree. It then runs the installed binary with a file package and the ALSA null plugin. Set `BUILDROOT_SOURCE`, `SOURCE`, `TARGET_DIR`, `BR2_EXTERNAL_POCKETJS_PATH`, `BR_CARGO_HOME` and the two product input paths when invoking it. This integration harness uses a native AArch64 Linux compiler; it does not build or boot a firmware image and does not validate a board's cross toolchain, display, input or audio devices.
