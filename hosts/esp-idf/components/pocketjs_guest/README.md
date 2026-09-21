# pocketjs_guest

Caller-driven QuickJS guest for ESP-IDF.

- Public headers: `pocketjs/guest.h`, `pocketjs/guest_quickjs.h`
- Targets: ESP32-P4 and ESP32-S3
- Dependency: `espressif/quickjs-ng` 0.14.0
- Ownership: one caller-selected owner task invokes every API except
  `pocketjs_guest_interrupt`, which is safe to call from a stopping task

The component creates no FreeRTOS task and mounts no PocketJS capability by
itself. `pocketjs_guest_frame` calls `globalThis.frame` once and drains the
pending job queue. The QuickJS header is a version-pinned extension surface;
ordinary firmware includes only `guest.h`.

Set `CONFIG_POCKETJS_GUEST_HEAP_LIMIT` in `menuconfig` under
`Component config → PocketJS guest → Default JavaScript heap limit (bytes)`.
**The default is 4194304 bytes (4 MiB) per guest.**
`pocketjs_guest_config_defaults()` copies this value into `config.heap_limit`.
Assign `config.heap_limit` before `pocketjs_guest_create()` to override the
default for that guest.

**The limit is a QuickJS allocation budget.** Reserve memory for native
allocations, display buffers, and allocator overhead. It does not represent
total PSRAM usage or set the garbage collector's trigger threshold.
