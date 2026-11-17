# 2D games: `@pocketjs/framework/game2d`

A 2D game layer on PocketJS: maps, sprite characters, dialogue, menus, turn-based or action scenes. It runs the same bundle on the PSP (32 MB, 333 MHz), in the browser and on Linux handhelds with a GPU. Everything is built from public PocketJS primitives; the native surfaces it adds are `globalThis.pack` (see [PACKS.md](./PACKS.md)) and the optional `setDrawItems` op.

## Structure

A game is a set of **scenes** driven by a **fixed-step loop**. What a scene shows is **layers**, some of them inside a **camera**. Script work per frame follows what changes, not what is on screen:

| Content | Where it goes | Script work per frame |
| --- | --- | --- |
| A map larger than the screen | a tile layer in a camera | none; it draws again when the view crosses a chunk edge |
| A background that holds still | a static layer | none; it draws again after `invalidate()` |
| Scrolling | `camera.move(x, y)` | one or two `setProp` calls per parallax group |
| Characters, effects, anything that moves | a dynamic layer | one draw call per item; one native call per run of items |
| Dialogue, menus, panels | story UI components | none while idle |

## Modules

| Module | What it gives you | Why it is shaped this way |
| --- | --- | --- |
| `createDirector` | Scenes as hooks: `enter`, `leave`, `reset`, `step`, `draw`; follows a scene name kept in game state with `follow` | A scene loads what it draws on `enter` and lets go of it on `leave`; a chapter jump is one `reset` instead of a list of fields to clear |
| `createLoop` | Fixed steps: a frame runs as many as **max(wall-clock interval, virtual frame interval)** covers, at most `maxSteps` | A host at 30 fps keeps full speed, a 120 Hz display does not run fast, and a driver that steps faster than real time gets one step per frame, so a run is a function of its input tape |
| `createLayer` → `Gfx` | A dynamic layer: `begin`, `cell`/`sprite`/`texture`/`rect`/`text`, `end` every frame | On a host with `setDrawItems` an image or rect is a 16-byte integer record, and `end()` sends each run of records between two texts to a view in **one native call**; text stays on pooled text nodes. On other hosts the i-th call reuses the i-th node: boxes are 1×1 and sized with `scaleX/Y`, so drawing never relayouts, and a negative scale mirrors. `drawItems: false` keeps the node pool |
| `createStaticLayer` | A layer whose `draw(gfx)` runs on the first frame, after `invalidate()`, after the texture pool released its textures, and while an image it wants is loading | The list it submitted stays on screen, and the images it shows are **pinned** in the texture pool, so it costs no script work until its content changes |
| `createTileLayer` | A static layer holding the chunks of a map that intersect the view | A map larger than the texture budget cannot be one static picture. Chunks out of view are unpinned for the pool to evict |
| `createCamera` | `move(x, y)` and a `View` per parallax factor; layers inside draw in world space with `clip: false` | Scrolling moves one container view, whatever is on screen |
| `createTexturePool` | `get(image)` loads on first use, LRU eviction against a byte budget, `pin`/`unpin`, an `epoch` that changes on `release` | A handheld that runs out of arena hangs with no message. Nothing loads without accounting |
| `createPackStore` | `mount(name, path)`: a file with a manifest and many images, read on demand | Content can exceed RAM. Only the image table and the data and live textures occupy memory |
| `createLightMask` | Darkness with several moving lights, as a low-resolution CLUT8 texture | Bands of concentric ellipses painted with `TypedArray.fill`: hundreds of native fills instead of a per-pixel interpreter loop |
| `createInput` | Named actions bound to button masks, `pressed`/`held`/`repeat`, the stick as direction, a focus stack of menus (`nav`) | A press is latched until a step ends (`endStep`), so a frame that runs no step loses no press. Every screen works from buttons alone; there is no pointer on a PSP. No allocation per frame |
| `createStoryUI` | Dialogue with paging and typewriter, choices, veil transitions, cards, banners, toasts, objective, tracker, an info panel | Panels are components on signals (free while idle); transient overlays draw into a dynamic layer and draw nothing while none shows. Everything waits on the frame clock. Genre widgets, a battle's unit plates or a command grid, belong to the game |
| `createClock` | `sleep`, `uiSleep`, pause, `reset` | Scripts are long `async` functions. `reset` abandons them, so a chapter jump does not need a reload |
| `createSave` | JSON slot over `data.fs` | Stages a sibling file first, because PSP cannot replace a file atomically |
| `createMemoryGuard` | Collects JS cycles at moments you mark as safe, and anyway past a hard limit. It samples `pack.mem()` every 90 frames, so a host's `mem` must read a counter, not walk the heap: `JS_ComputeMemoryUsage` on a 23 MB heap costs 27 ms on a Cortex-A53 | Reactive graphs are cycles; on a PSP a battle made 1.5 KB of them per frame with nothing collecting. One pass of a 4 MB heap takes about 140 ms, so it has to happen behind a transition |
| `createMusicPlayer`, `createSfxBank` | Streaming PCM with gapless loops; overlapping short effects | Music never enters memory whole |

## Shape of a game

```tsx
const input = createInput({ bindings: { confirm: BTN.CIRCLE, back: BTN.CROSS, jump: BTN.CROSS }, confirm: "confirm", back: "back" });
const clock = createClock(), loop = createLoop(), store = createPackStore();
const tex = createTexturePool(store, 5 * 1024 * 1024);
const camera = createCamera({ width: 480, height: 272 });
const map = createTileLayer({ width: 480, height: 272, tile: 256, images: 12, tex });
const actors = createLayer({ width: 480, height: 272, tex, clip: false });
const over = createLayer({ width: 480, height: 272, images: 12, tex });
const ui = createStoryUI({ width: 480, height: 272, clock, input, over: over.gfx });
const director = createDirector({
  initial: "field",
  scenes: {
    field: {
      enter() { map.setMap({ cols: 20, rows: 12, image: (i) => store.image(`map.${i}`) }); },
      step(dt) { updatePlayer(dt, input); },
      draw() {
        camera.move(player.x - 240, player.y - 136);
        map.frame(camera.x, camera.y);
        drawActors(actors.gfx); // world coordinates
      },
    },
  },
});

function App() {
  onFrame((buttons) => {
    input.update(buttons);
    director.sync();
    loop.frame((dt) => { clock.tick(dt); director.step(dt); input.endStep(); });
    actors.gfx.begin(); over.gfx.begin();
    director.draw();
    ui.frame(loop.stepMs);
    actors.gfx.end(); over.gfx.end();
  });
  return (
    <View class="w-full h-full bg-black">
      <camera.View><map.View /><actors.View /></camera.View>
      <ui.View />
      <over.View />
    </View>
  );
}
```

Call `onFrame` from inside a component: registering it at module level does nothing.

## Measurements

`apps/game2d-sprites` has two scenes, each in two forms that SELECT switches between:

- **sprites:** moving, mirrored, animated sprites with name tags between them; draw items or one node per image.
- **world:** a scrolling 12×8-chunk map with walkers; the layered form (a tile layer and a walker layer in a camera) or the frame-wide form (everything drawn every frame, the camera an offset on every draw call).

On the sim host both forms of each scene produce **identical frames** over 600 frames.

| sim host, 80 sprites, per frame | native calls |
| --- | --- |
| sprites, one node per image | 128 `setProp` + 20 `setImage` |
| sprites, draw items | 3 `setDrawItems` + 5 `setProp` |
| world, frame-wide | 2 `setDrawItems`, the map drawn every frame |
| world, layered | 2 `setDrawItems` + 1.75 `setProp`, the map drawn 23 times in 600 frames |

A full-length game ported to this structure (a 40-chapter isometric RPG: a tile layer and a character layer in a camera for its maps, a static layer for scene backdrops) was run by its own bot on the sim host for 32,000 frames (its first chapter and a later one with three minigames), the old structure and the new on the same input. Both took the same path. With the old stage's rounding made shift-invariant like the layers', frames matched except **±1 in a channel where an item fades** (draw item alpha is 8-bit) and **at most 32 pixels at the screen edge**, where the game rounds negative screen coordinates itself and where a sprite is clipped. The game's own web verification (both endings across all 432 story nodes, a cold start of every node, menus, saves) passes on the new structure.

| sim host, per frame | old structure | layers |
| --- | --- | --- |
| a map with a follower | 30.9 native calls | 6.1 |
| a minigame with 81 moving sprites | 64.5 | 1.3 |
| a scrolling underwater scene | 65.5 | 5.8 |
| a turn-based battle | 10.2 | 6.1 |

Under QuickJS on an Apple M-series machine, script time per frame fell **1% to 3%** on maps, battles and still scenes and **10%** in the 81-sprite minigame; core drawing time fell 7% to 31%. **The game's own logic, not the drawing path, takes most of its frame.** At the measured PSP cost of a call (`setProp` 35 µs, `setImage` 30 µs), the minigame's 63 fewer calls are about 2 ms a frame of a frame that takes about 39 ms of script on a PSP. PSP times for either structure are not measured yet.

## When the arena runs out

The PSP arena has power-of-two size classes and no per-block headers. **Script heap grows up from the bottom and blocks of 4 KB and more grow down from the top**, so freed textures can rejoin. `pack.gc()` also compacts: neighbouring free blocks merge across classes, with free script heap kept in script-heap classes. An allocation that would otherwise fail joins everything first.

A texture that still cannot load is -1 to the guest, not an abort: `uploadImgEntry` and `pack.loadImg` return -1 when the arena has no room. The texture pool then evicts everything not drawn this frame and not pinned, at most once a second, and tries that image again after 1, 2, 4... frames, up to 240. Each try reads the whole entry from storage, so a corrupt image must not retry every frame. A static layer that missed an image tries again every 8 frames.

Call `store.trim()` between chapters to forget image objects with no live texture. `MemoryGuard.collect()` is for a host out of room, behind a transition. `tex.release()` drops pinned textures too and changes the pool's epoch, so every static layer draws again on its next frame.

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
- A layer inside a camera needs `clip: false`: it draws in world space, and its own box sits at the world origin.
- A static layer's content stays until it draws again. A scene that stops showing one clears it (`setMap(null)` then `frame`, or a `draw` that draws nothing).
- `style` takes spec names: `insetL`, not `left`.
- Containers default to `flex-row`.
- On the web a tight loop of `advance()` starves the microtask queue, so `await` between frames in test drivers. Real hosts drain it every frame.
- `--bench` exits the program when its window ends. Returning to PSPLINK then is not a crash.
- When QuickJS runs out of memory it can throw `null`, which Solid reports as `Unknown error`. Catch rejections of your long-running script, or it stops while the screen keeps animating.
- On the node path, keep one draw order between frames where you can: a reorder means a `setImage` per moved node.
