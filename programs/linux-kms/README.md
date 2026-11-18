# Linux KMS program

This program composes `pocket-runtime`, the canonical rquickjs guest, the CPU renderer, Linux display/input drivers and an open-file package source. **The original bundle (`.pkb`) passes through admission.** The program does not extract JavaScript and reconstruct another bundle.

The example host contract, `pocket.host.json`, describes an 800×600 product with buttons and baked glyphs. Products own their host contract and choose their physical mode, logical viewport and capabilities. This program accepts buttons, pointer, touch and baked glyphs on one fixed display. `pocket.host.config.ts` rejects a host contract promising other services, role capabilities or a dynamic/auxiliary display when the config loads; at startup the program rejects dynamic/auxiliary displays and input classes other than buttons, pointer and touch. **The host contract is compiled into the binary:** `pocket build` exports it as `pocket_profile.rs`, `build.rs` copies the file named by `POCKETJS_PROFILE_RS` and fails without it, and the program reads no `pocket.host.json` at runtime. Admission rejects a bundle whose plan the compiled host contract's facts do not satisfy, or whose binding generation differs.

On Linux:

```sh
bun tools/pocket.ts build --config programs/linux-kms/pocket.host.config.ts --out dist/linux-kms
# Compile the product's application. Its pocket.host.config.ts lists this
# program's host contract (programs/linux-kms/pocket.host.json) and holds the app.
bun tools/pocket.ts compile --config /product/pocket.host.config.ts --output dist/app.pkb
dist/linux-kms/runtime/pocket-linux-kms --package dist/app.pkb
```

A Cargo build outside `pocket build` sets `POCKETJS_PROFILE_RS` to the `pocket_profile.rs` that `bun tools/pocket.ts host export --config programs/linux-kms/pocket.host.config.ts --out DIR` writes.

DRM/KMS is attempted first; failure opens fbdev. Both drivers must match the host contract's physical size. `--card`, `--fb` and repeated `--input` arguments select device paths. Without input arguments, the program discovers `/dev/input/event*`; required input classes still have to be present. Product deployment owns device permissions and display-session access.

`--check` performs bundle and host contract admission without opening devices. `--headless --frames 3` selects an explicit diagnostic framebuffer and empty input source. It is not an automatic hardware fallback. The logical clock executes one guest turn per due wake; delayed wakes do not run extra guest turns.

`--features alsa` adds the optional PCM component. `--pcm-test null` writes and drains 512 stereo frames through libasound's null plugin. **The example host contract does not promise `audio.pcm` and the program does not mount `globalThis.audio`.** A product that promises guest audio must compose its stream service with the ALSA component and export that capability.

The Buildroot adapter compiles the exported host contract into `/usr/bin/pocket-linux-kms` and installs the application bundle at `/usr/share/pocketjs/app.pkb`.
