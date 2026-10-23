# Linux KMS program

This program composes `pocket-runtime`, the canonical rquickjs guest, the CPU renderer, Linux display/input drivers and an open-file package source. **The original `.pocket` passes through package admission.** The program does not extract JavaScript and reconstruct another package.

The example `profile.ts` describes an 800×600 product with buttons and baked glyphs. Products own their profile and choose their physical mode, logical viewport and capabilities. This program accepts buttons, pointer, touch and baked glyphs on one fixed display. `pocket.runtime-config.ts` rejects a profile promising other services, role capabilities or a dynamic/auxiliary display when the config loads; at startup the program rejects dynamic/auxiliary displays and input classes other than buttons, pointer and touch. **The profile is compiled into the binary:** `pocket build` exports it as `pocket_profile.rs`, `build.rs` copies the file named by `POCKETJS_PROFILE_RS` and fails without it, and the program reads no profile file at runtime. Package admission rejects a profile hash or binding generation that differs from the compiled profile.

On Linux:

```sh
bun tools/pocket.ts build --config programs/linux-kms/pocket.runtime-config.ts --out dist/linux-kms
# Compile the product's application manifest against the same config.
bun tools/pocket.ts compile --manifest /product/app/pocket.json --runtime-config programs/linux-kms/pocket.runtime-config.ts --output dist/app.pocket
dist/linux-kms/runtime/pocket-linux-kms --package dist/app.pocket
```

A Cargo build outside `pocket build` sets `POCKETJS_PROFILE_RS` to the `pocket_profile.rs` that `bun tools/pocket.ts profile export --config programs/linux-kms/pocket.runtime-config.ts --out DIR` writes.

DRM/KMS is attempted first; failure opens fbdev. Both drivers must match the profile's physical size. `--card`, `--fb` and repeated `--input` arguments select device paths. Without input arguments, the program discovers `/dev/input/event*`; required input classes still have to be present. Product deployment owns device permissions and display-session access.

`--check` performs package/profile admission without opening devices. `--headless --frames 3` selects an explicit diagnostic framebuffer and empty input source. It is not an automatic hardware fallback. The logical clock executes one guest turn per due wake; delayed wakes do not run extra guest turns.

`--features alsa` adds the optional PCM component. `--pcm-test null` writes and drains 512 stereo frames through libasound's null plugin. **The default profile does not promise `audio.pcm` and the program does not mount `globalThis.audio`.** A product that promises guest audio must compose its stream service with the ALSA component and export that capability.

The Buildroot adapter installs `/usr/bin/pocket-linux-kms`, an independent `/usr/share/pocketjs/pocket-profile.json`, and the application package at `/usr/share/pocketjs/app.pocket`.
