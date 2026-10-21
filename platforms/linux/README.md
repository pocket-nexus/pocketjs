# Linux components

These crates implement mechanisms against `pocket-drivers`; none owns a `Ui`, guest or application package parser.

- `hooks`: a monotonic clock, aligned allocation helpers and a range-based `FileSource`. It does not export the six host C symbols; the final archive owns those symbols.
- `drm`: DRM/KMS output through `drm-rs`. Two CPU staging buffers have separate retained identities. A flush copies damage to the corresponding private dumb buffer before queueing a page flip. The page-flip event completes the token. Native scanout never borrows a renderer's CPU slice. Teardown restores or disables the CRTC; kernel references retain a scanout allocation if a disconnected device prevents restoration.
- `fbdev`: validated packed true-color mappings, including line padding and viewport offsets. Rendering uses an ARGB8888 staging buffer; flush converts damaged pixels to the device's 16/24/32-bit channel layout. Pacing comes from the program clock; this backend does not claim hardware vsync.
- `evdev`: nonblocking reads bounded per tick, fragmented event decoding, state publication at `SYN_REPORT`, keyboard/gamepad buttons, relative-pointer motion, single touch and type-B multitouch. `SYN_DROPPED` and disconnect cancel published contacts once. Each device receives a disjoint range of contact IDs in 0–255. Text/IME, motion sensors, analog sticks and scrolling are not advertised.
- `alsa`: borrowed signed 16-bit PCM at the rates/channels in `pocket-spec`. Partial writes, underrun recovery and bounded waits use libasound. A failed write stops the device; destruction drops queued audio before closing it. The component does not define a guest namespace.

The native display/PCM implementations support little-endian Linux. DRM requires a connected mode whose dimensions match the independently exported product profile. Opening a device does not claim that its permissions, connector or mode are available on every product.

Run `bun tools/linux-platforms-test.ts` for portable state-machine tests and file-package boot/tick/teardown checks. On Linux this also exercises the ALSA `null` plugin. `tests/fixtures/linux-platforms/kernel-layout.c` checks the kernel header layouts used by the framebuffer and event adapters. These tests do not replace physical DRM, framebuffer, input or audible-output validation.
