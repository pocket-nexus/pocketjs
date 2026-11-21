# 2D games: `@pocketjs/framework/game2d`

A shared layer for story-driven 2D games on PocketJS: isometric or side-on maps, sprite characters,
dialogue, menus, turn-based or action scenes. It runs the same bundle on the PSP (32 MB, 333 MHz), in the browser and on Linux
handhelds with a GPU. Everything is built from public PocketJS primitives; the only new native surface is
`globalThis.pack` (see [PACKS.md](./PACKS.md)).

## Modules

| Module | What it gives you | Why it is shaped this way |
| --- | --- | --- |
| `createStage` → `Gfx` | Immediate-mode drawing: `begin`, `cell`/`sprite`/`texture`/`rect`/`text`, `end`, on a retained node pool | Game code stays a draw loop. The i-th call reuses the i-th node, so an unchanged scene issues no native calls. Boxes are 1×1 and sized with `scaleX/Y`, so drawing never relayouts; a negative scale mirrors |
| `createTexturePool` | `get(image)` loads on first use, LRU eviction against a byte budget | A handheld that runs out of arena hangs with no message. Nothing loads without accounting |
| `createPackStore` | `mount(name, path)`: a file with a manifest and many images, read on demand | Content can exceed RAM. Only the image table and the data and live textures occupy memory |
| `createLightMask` | Darkness with several moving lights, as a low-resolution CLUT8 texture | Bands of concentric ellipses painted with `TypedArray.fill`: hundreds of native fills instead of a per-pixel interpreter loop |
| `createInput` | `pressed`/`held`/`repeat`, stick as direction, a focus stack of menus (`nav`) | Every screen works from buttons alone; there is no pointer on a PSP |
| `createHud` | Dialogue with paging and typewriter, choices, veil transitions, cards, banners, toasts, objective, tracker, command menu, unit plates, timeline, panels | Panels are components on signals (free while idle); transient overlays are immediate. Everything waits on the frame clock |
| `createClock` | `sleep`, `uiSleep`, pause, `reset` | Scripts are long `async` functions. `reset` abandons them, so a chapter jump does not need a reload |
| `createSave` | JSON slot over `data.fs` | Stages a sibling file first, because PSP cannot replace a file atomically |
| `createMemoryGuard` | Collects JS cycles at moments you mark as safe, and anyway past a hard limit. It samples `pack.mem()` every 90 frames, so a host's `mem` must read a counter, not walk the heap: `JS_ComputeMemoryUsage` on a 23 MB heap costs 27 ms on a Cortex-A53 | Reactive graphs are cycles; on a PSP a battle made 1.5 KB of them per frame with nothing collecting. One pass of a 4 MB heap takes about 140 ms, so it has to happen behind a transition |
| `createMusicPlayer`, `createSfxBank` | Streaming PCM with gapless loops; overlapping short effects | Music never enters memory whole |

## Shape of a game

```tsx
const clock = createClock(), input = createInput(), store = createPackStore();
const tex = createTexturePool(store, 5 * 1024 * 1024);
const stage = createStage({ width: 480, height: 272, tex }), over = createStage({ width: 480, height: 272, images: 12, tex });
const hud = createHud({ width: 480, height: 272, clock, input, over: over.gfx, confirm: BTN.CIRCLE, back: BTN.CROSS });

function App() {
  onFrame((buttons) => {
    input.update(buttons); clock.tick(1000 / 60);
    stage.gfx.begin(); over.gfx.begin();
    drawMyScene(stage.gfx);
    hud.frame(1000 / 60);
    stage.gfx.end(); over.gfx.end();
  });
  return <View class="w-full h-full bg-black"><stage.View /><hud.View /><over.View /></View>;
}
```

Call `onFrame` from inside a component: registering it at module level does nothing.

## When the arena runs out

The PSP arena has power-of-two size classes and no per-block headers. **Script heap grows up from the bottom and blocks of 4 KB and more grow down from the top**, so freed textures can rejoin. `pack.gc()` also compacts: neighbouring free blocks merge across classes, with free script heap kept in script-heap classes. An allocation that would otherwise fail joins everything first.

A texture that still cannot load is -1 to the guest, not an abort: `uploadImgEntry` and `pack.loadImg` return -1 when the arena has no room. The texture pool then evicts everything not drawn this frame, at most once a second, and tries that image again after 1, 2, 4... frames, up to 240. Each try reads the whole entry from storage, so a corrupt image must not retry every frame.

Call `store.trim()` between chapters to forget image objects with no live texture. `MemoryGuard.collect()` is for a host out of room, behind a transition.

## Pack format

`"GPK2"`, u32 image count `n`, u32 data length `d`, `n` rows of 12 i32 `[off, len, tw, th, w, h, ox, oy, fw, fh, ax, ay]`
sorted by name hash, `n` u32 name hashes (`packNameHash`, ascending and unique), `d` bytes of free-form ASCII JSON `data`,
then self-contained IMG entries (the same layout as `uploadImgEntry`: T8 with an optional RLE). All integers are little-endian
and `off` counts from the end of the data. `tw/th` is the power-of-two texture, `w/h` the used pixels, `ox/oy` the trim offset
inside the original `fw×fh` cell, and `ax/ay` the anchor. The table costs 52 bytes per image in memory and needs no parsing.

A bake tool writes this with `PackWriter` (`framework/src/game2d/pack-writer.ts`). **A store finds an image by its 32-bit hash alone, across every mounted pack, and never reads a name back**, so two names with one hash would draw the wrong image with no error. Give every `PackWriter` in a build the same `PackNames`, which throws on a collision.

Give each image its own exact palette. A CLUT8 texture costs `w×h + 1 KB`, so trimming to the smallest power-of-two
box matters far more than the palette.

## Costs on a real PSP

PPSSPP's CPU timing is **5 to 6 times optimistic**. Measure on hardware. At 333 MHz: raw `ops.setProp` 35 µs, `hot.prop` on a changed value 139 µs, `setImage` 30 µs, `Math.sin` 34 µs, `Math.round` 6 µs (doubles are soft-float), a `Map` lookup 8 µs, a property read 2 µs. Array destructuring and `for…of` go through the iterator protocol and are expensive on a per-frame path. Use integers, indexed loops and lookup tables there.

## Things that bite

- Baked glyphs exist per size. `Gfx.text` has one fixed-cell pool per size; do not scale text.
- `style` takes spec names: `insetL`, not `left`.
- Containers default to `flex-row`.
- On the web a tight loop of `advance()` starves the microtask queue, so `await` between frames in test drivers. Real hosts drain it every frame.
- `--bench` exits the program when its window ends. Returning to PSPLINK then is not a crash.
- When QuickJS runs out of memory it can throw `null`, which Solid reports as `Unknown error`. Catch rejections of your long-running script, or it stops while the screen keeps animating.
- Keep one draw order between frames where you can: a reorder means a `setImage` per moved node.
