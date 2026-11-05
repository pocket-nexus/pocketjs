# Browser runtime

`tools/wasm.ts` builds this standalone Wasm embedding. Each `WasmHost` owns its Runtime, operation context, display buffers, input facts and capture buffers. No process-wide `Ui` exists. `platforms/web/wasm-ops.js` transports canonical argument records to `OpContext::dispatch`; `engine/guest-web` implements the guest functions over generated operation descriptors; `platforms/web/generated-ui.js` re-exports that implementation. Web staging includes both directories.

**Product hosts boot the Runtime.** The browser supplies a Guest, input source, memory package source and CPU-visible display. Public service and launcher functions register as `OpProvider` implementations. The generated binding exposes only registered operations; callbacks return owned result bytes and cannot reenter a borrowed core.

The compatibility entry converts an existing JavaScript/PAK pair with `pocket-package::embedded` before admission. `advance` samples device facts and runs one guest turn; Runtime owns touch capture, hit facts and core ticks. `present` runs the shared presentation coordinator through terminal renderer/display waits. Fast-forward discards an unsubmitted frame with `Runtime::skip_presentation`.

The existing browser scheduler runs the core at 60 Hz. A host that calls the guest at 30 Hz requests two core ticks per guest turn. `__simHz` carries that guest cadence; raster density remains independent of display scale. Embedded resize updates the registered primary descriptor and calls `Runtime::resize_embedded`; failure restores the descriptor and logical viewport.

**Asynchronous module evaluation retains the Runtime behind a promise gate.** Guest evaluation starts the import. Until its promise settles, the wrapper rejects frame advancement, pixel capture and lifecycle changes other than destruction. Successful completion requires an installed `frame` function and runs presentation to resolve initial layout. Failure destroys the Runtime; completion after destruction cannot reactivate it. Browser promise jobs run at the browser's task boundaries; this embedding does not claim a synchronous JavaScript job-drain API.

`createWasmUiSync` without `boot` supplies the compiler and pixel tests with an instance-owned `OpContext`. Direct `tick` is rejected after boot. Full, incremental, premultiplied, auxiliary and compositor captures use the same retained core. Captures own separate buffers; they do not overwrite the Runtime display's damage history. Runtime-owned display pointers and capture pointers remain valid until their next update or instance destruction. JavaScript copies borrowed operation results before freeing argument scratch memory or making another native call.

Validation:

```sh
bun tools/wasm.ts
cargo +stable clippy --locked --manifest-path programs/web/wasm/Cargo.toml --target wasm32-unknown-unknown -- -D warnings
bun test tests/wasm-runtime.test.ts tests/wasm-auxiliary.test.ts tests/wasm-premultiplied.test.ts tests/guest-web-bindings.test.ts
```
