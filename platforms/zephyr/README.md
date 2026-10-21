# Zephyr module

The repository is a west module through `zephyr/module.yml`. **The application
links one Rust archive and registers its own runtime instances and drivers.**
Kconfig adds the hooks, display, input or generated QuickJS unit. The application
owns devicetree, `prj.conf`, scheduling and hardware setup.

Export the program profile before Zephyr configuration:

```sh
pocket profile export --config pocket.runtime-config.ts --out build/profile
pocket sdk export --triple thumbv7em-none-eabihf --out build/pocket-sdk
west build -b <board> -- -DPOCKET_SDK=$PWD/build/pocket-sdk \
  -DPOCKET_PROFILE_EXPORT_DIR=$PWD/build/profile
```

`sdk export` obtains a release archive. `pocket sdk build` compiles that archive
from a source checkout. `POCKET_RUNTIME_ARCHIVE` selects a program-owned archive;
`POCKET_RUST_TARGET` overrides the architecture mapping. With
`CONFIG_POCKETJS_RUST_FROM_SOURCE=y`, set `POCKET_PROGRAM_MANIFEST` and
`POCKET_PROGRAM_ARCHIVE` to the program's staticlib crate and output name.
`POCKET_RUST_BUILD_STD=core,alloc` adds the tier-3 Cargo flag. The program selects
the Cargo toolchain and must supply a locked dependency graph.

```conf
CONFIG_POCKETJS=y
CONFIG_POCKETJS_HEAP_SIZE=1048576
CONFIG_DISPLAY=y
CONFIG_POCKETJS_DISPLAY=y
CONFIG_INPUT=y
CONFIG_POCKETJS_INPUT=y
```

The hooks allocate from a dedicated `k_heap`, panic through `k_panic`, and expose
a microsecond clock backed by `k_uptime_ticks`. The hook unit checks exported
profile dimensions against the chosen display node's width and height.

`pocket_zephyr_display_create` accepts RGB565 or ARGB8888 from the display's
`current_pixel_format`. The product sets format and orientation before creation.
The adapter holds one full-width strip under the supplied byte budget and
converts native pixel words to the display subsystem's big-endian byte order.
`display_write` return ends access to the strip. A failed write invalidates
frame history. Displays reporting alternating framebuffers require a full-frame
allocation and full redraws because their API exposes no persistent buffer id.
The display device remains alive through adapter destruction.

`pocket_zephyr_input_create` copies key-to-button mappings and listens to one
input device. ABS_X, ABS_Y and BTN_TOUCH form one contact, with product-supplied
coordinate scaling. **Input state is published at the subsystem sync event.**
`pocket_zephyr_input_cancel` releases buttons and emits contact cancellation;
a rejected builder append preserves that cancellation for the next poll.
Callback state is protected by a spinlock; runtime polling and destruction must
be serialized by the product.

`CONFIG_POCKETJS_GUEST_QUICKJS=y` adds the generated C guest. Another module or the
application must define `POCKET_QUICKJS_TARGET` and
`POCKET_QUICKJS_INCLUDE_DIR` before this module configures. The engine's libc and
allocation configuration belong to that module. The product registers the guest
through the canonical runtime API.

The maintained contract project under `tests/fixtures/zephyr/native_sim` uses
the real Zephyr kernel, display/input subsystems and Rust rasterizer. Its display
device records bytes in memory; it does not stand in for panel timing or DMA.
`tools/packaging/zephyr/test-native.ts` runs the project on Linux and checks that a
profile/devicetree mismatch fails compilation. CI pins Zephyr 4.4.0, including
its ARM64 native simulator support. Fast C boundary tests run through
`tests/zephyr-contract.test.ts`.
