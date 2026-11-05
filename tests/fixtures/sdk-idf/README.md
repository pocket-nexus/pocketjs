# External ESP32-P4 SDK consumer

This maintained C project consumes **one exported PocketJS archive, exported
headers, and exported QuickJS guest source**. It supplies the six host hooks,
display, input, package source, and optional PPA renderer. The test runner
copies the project, SDK, and consumer-supplied QuickJS source into a temporary
directory outside the checkout. CMake does not invoke Cargo or read engine
sources from the checkout.

Build host and ESP32-P4 SDK candidates before running the fixture:

```sh
bun tools/pocket.ts sdk build --triple aarch64-apple-darwin \
  --out /tmp/pocket-sdk-host
bun tools/pocket.ts sdk build --triple riscv32imafc-unknown-none-elf \
  --toolchain 1.98.1 --prepare esp32p4 --archiver /path/to/llvm-ar \
  --out /tmp/pocket-sdk-p4
bun tools/test-sdk-idf.ts --host-sdk /tmp/pocket-sdk-host \
  --sdk /tmp/pocket-sdk-p4 --quickjs /path/to/quickjs-ng \
  --idf /path/to/esp-idf
```

Use the host machine's Rust triple for the first build. Pass `--host-only`
instead of `--sdk` and `--idf` to run the host checks without IDF. Pass
`--artifacts DIR` to select an ignored receipt and log directory. The runner
records SDK manifest hashes, QuickJS source hash, commands, process signals,
IDF version, and firmware hash. A failed command or signal fails the run.

The package contains a gradient and an opaque rectangle. One input poll changes
the rectangle color. The range-only package source returns at most 31 bytes
per call. The host executable checks:

- Software full-frame and four-row GRAM strips produce the same boot and tick
  hashes. The display streams its strip into a hash; it has no full-frame copy.
- **The strip allocation is 256 bytes; a full frame is 1,536 bytes.** A display
  without frame storage rejects the 256-byte budget before acquire.
- An external renderer uses `pocket_draw_list_visit` and accelerates opaque
  rectangles. It sends other operations to `pocket_raster_draw_op` in order.
  Host fill code is a PPA mock and must match the software hashes.
- Injected renderer-wait and display-wait errors are terminal. Render failure
  does not flush that strip, all returned render submissions retire once, and
  the next tick redraws and matches the reference hash.
- Guard bytes around the display allocation survive all cases. A strip cannot
  be acquired again before the prior display wait becomes terminal.

The ESP32-P4 build compiles the same consumer against the **real IDF PPA API**.
PPA fill uses blocking transactions before the next software operation. The
display remains a memory-backed streaming test sink; it does not select board
pins or drive a panel. Host execution and IDF compilation do not prove hardware
execution, DMA/cache behavior, or physical panel output. Those checks belong
to the final device acceptance run.

The consumer owns its QuickJS source. It does not import the legacy ESP-IDF
component or run that component's immutable-buffer source preparer. The
legacy source-pin gate remains a separate check; this fixture does not change
its pin or count as evidence that it passes.
