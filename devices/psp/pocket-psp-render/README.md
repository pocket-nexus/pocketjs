# PSP GE renderer

`GeRenderer` consumes `pocket_drivers::FrameInput` and `RenderResources` without a `Ui`, package loader, or guest engine. It uses `pocket-draw-ops` to validate the complete word stream and decode clipping, `pocket-glyph-pages` for ABGR4444 font pages, and `pocket-psp-ge` for aligned retained geometry storage. The PSP host initializes GU and owns its framebuffer pair and 1 MiB command list.

Composition registers a `SharedRenderer<NativeDevice>` and a `GeDisplay` sharing that renderer. The device target contains an instance identity and a full 480 × 272 region. Other instances' targets and stale submissions are rejected. One submission may be pending. Display flush swaps buffers after renderer completion; VBlank pacing belongs to the host clock.

**Ordinary render copies texture and palette bytes before returning.** The explicit `render_zero_copy` method borrows aligned bytes until `wait` returns; unaligned input is copied. The presentation coordinator must finish its transaction before the next guest tick can mutate those bytes. A bounded publication index uses handle, resource revision, and address to avoid repeating CPU cache writeback for immutable textures. Every GE texture bind flushes the GE texture cache. Font pages retain all referenced revisions until submission retirement; when all 16 pages are pinned, glyphs use colored coverage runs.

**Both wait success and failure are terminal.** Early retirement waits before storage reuse, and destruction stops native work before freeing storage. Dropping an active shared handle also stops work when the host retains another handle. Native synchronization uses `sceGuSync(Finish, Wait)` from the pinned rust-psp implementation; if firmware does not report `GeListState::Done`, the device waits with all referenced allocations retained. It never converts a still-running list into a terminal error. Device implementations must not reenter their renderer or display.

`Encoder` also supports an external GU list. `programs/psp/src/scene.rs` is the compatibility adapter for native game overlays: it passes `Ui` through the resource trait and delegates all DrawList rendering. An external caller keeps sources and encoder alive until GU sync, then calls `retire`. It owns list opening, completion, frame timing, and framebuffer selection.

The maintained host tests use a delayed mock device that rereads vertex and image pointers at completion. They cover owned copies, explicit borrowed storage, changed revisions, retained font versions, cache pressure, clipping, target identity, terminal errors, early retirement, and shared-handle destruction:

```sh
bun test tests/ge-driver.test.ts
cargo +stable clippy --locked --offline --manifest-path devices/psp/pocket-psp-render/Cargo.toml --all-targets -- -D warnings
```

Install the pinned PSP SDK with `bun tools/pocket.ts target add psp`. Native compilation uses the project's custom target and toolchain:

```sh
RUSTFLAGS='-C panic=abort' cargo +nightly-2026-05-28 build --release --locked --offline \
  --manifest-path devices/psp/pocket-psp-render/Cargo.toml \
  --target "$PWD/programs/psp/targets/mipsel-sony-psp.json" \
  -Zjson-target-spec -Zbuild-std=core,compiler_builtins,alloc,panic_abort
```

Host tests and native compilation do not establish visual or frame-time equivalence on PSP. Those checks remain part of final device validation.
