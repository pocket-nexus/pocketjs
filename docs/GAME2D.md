# 2D games: `@pocketjs/framework/game2d`

A shared layer for story-driven 2D games on PocketJS: isometric or side-on maps, sprite characters,
dialogue, menus, turn-based or action scenes. It runs the same bundle on the PSP (32 MB, 333 MHz) and in the
browser. Everything is built from public PocketJS primitives; the only new native surface is
`globalThis.pack` (see [PACKS.md](./PACKS.md)).

## Modules

| Module | What it gives you | Why it is shaped this way |
| --- | --- | --- |
| `createStage` → `Gfx` | Immediate-mode drawing: `begin`, `cell`/`sprite`/`texture`/`rect`/`text`, `end`, on a retained node pool | Game code stays a draw loop. The i-th call reuses the i-th node, so an unchanged scene issues no native calls. Boxes are 1×1 and sized with `scaleX/Y`, so drawing never relayouts; a negative scale mirrors |
| `createTexturePool` | `get(image)` loads on first use, LRU eviction against a byte budget | A handheld that runs out of arena hangs silently. Nothing loads without accounting |
| `createPackStore` | `mount(name, path)`: a file with a manifest and many images, read on demand | Content can exceed RAM. Only the manifest and live textures occupy memory |
| `createLightMask` | Darkness with several moving lights, as a low-resolution CLUT8 texture | Bands of concentric ellipses painted with `TypedArray.fill`: hundreds of native fills instead of a per-pixel interpreter loop |
| `createInput` | `pressed`/`held`/`repeat`, stick as direction, a focus stack of menus (`nav`) | Every screen works from buttons alone; there is no pointer on a PSP |
| `createHud` | Dialogue with paging and typewriter, choices, veil transitions, cards, banners, toasts, objective, tracker, command menu, unit plates, timeline, panels | Panels are components on signals (free while idle); transient overlays are immediate. Everything waits on the frame clock |
| `createClock` | `sleep`, `uiSleep`, pause, `reset` | Scripts are long `async` functions. `reset` abandons them, so a chapter jump does not need a reload |
| `createSave` | JSON slot over `data.fs` | Stages a sibling file first, because PSP cannot replace a file atomically |
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

## Pack format

`"GPK1"`, a u32 manifest length, the manifest as ASCII JSON, then self-contained IMG entries (the same layout as
`uploadImgEntry`: T8 with an optional RLE). Manifest: `images: { name: [off, len, tw, th, w, h, ox, oy, fw, fh, ax, ay] }`
with offsets counted from the end of the manifest, plus free-form `data`. `tw/th` is the power-of-two texture, `w/h` the
used pixels, `ox/oy` the trim offset inside the original `fw×fh` cell, and `ax/ay` the anchor.

Give each image its own exact palette. A CLUT8 texture costs `w×h + 1 KB`, so trimming to the smallest power-of-two
box matters far more than the palette.

## Things that bite

- Baked glyphs exist per size. `Gfx.text` has one fixed-cell pool per size; do not scale text.
- `style` takes spec names: `insetL`, not `left`.
- Containers default to `flex-row`.
- On the web a tight loop of `advance()` starves the microtask queue, so `await` between frames in test drivers. Real hosts drain it every frame.
- Keep one draw order between frames where you can: a reorder means a `setImage` per moved node.
