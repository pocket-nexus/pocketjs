# pocketjs_ui_core

Instance-owned retained UI core and native frame view.

- Public header: `pocketjs/ui_core.h`
- Targets: ESP32-P4 and ESP32-S3
- QuickJS dependency: none
- Renderer dependency: none

The published component contains one target-native Rust archive with both the
UI and RGB565 C interfaces, one allocator, and one panic handler. Normal Registry
consumers do not need Rust. `POCKETJS_RUST_FROM_SOURCE=ON` rebuilds it with the
developer's existing Cargo, compiler target, and linker; PocketJS does not
install or select a Rust toolchain.

For P4, the build removes Rust's bundled soft-float compiler-rt C objects from
the prepared archive. ESP-IDF supplies those runtime symbols through ROM or
libgcc with the target's `ilp32f` ABI.

One caller-selected task owns each core instance. Pointers in frame, texture,
and font views stay valid until the next UI mutation or tick on that core.
