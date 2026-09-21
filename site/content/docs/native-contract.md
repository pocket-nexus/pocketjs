# Native contract

The guest build compiles TypeScript application sources into an engine bundle.
Its framework adapters, styling, animation and input drive a native retained
UI tree through the synchronous op surface `ui.*`. This page documents that
guest-to-host surface and the host runtime around it. **TypeScript is the
application source contract; JavaScript is an emitted execution format.**

The [TypeScript support reference](/docs/typescript-support/) defines which
source forms the build admits. This page describes the runtime boundary.

If you only write app code you never call these ops directly — you write [`View` / `Text` / `Image`](/docs/components/) and the renderer emits ops for you. This page is for understanding *why* the surface looks the way it does, and for anyone writing a new host.

## Native AOT and the guest op surface

**Native AOT views call `microts::Ui` from generated Rust.** Their model
boundary is the generated Rust view-model trait, implemented by a compiled
TypeScript model or by application-owned Rust. This path has no guest mirror
tree and does not call back into a TypeScript interpreter for model methods.
The core's nodes, styles, layout and animation are reused.

Compiled model tasks communicate through `Host::model_ready` and
`Host::model_command`: the host supplies a frame-boundary `Ready` snapshot and
executes queued `Cmd` values after the view and lifecycle updates. Service
completion is deferred to a boundary even though individual UI ops are
synchronous. A native service adapter must implement the request, cancellation
and delivery contract; the `HostOps` UI table does not supply that adapter.

See [TypeScript and native code](/docs/microts-boundaries/) for model
selection, ownership and host responsibilities. The FFI, mirror and engine
job-queue descriptions below concern guest execution.

## The shape of the contract

Three rules constrain the surface:

1. **Mutation-oriented.** Tree operations are immediate commands; returned node,
   texture, and animation handles are synchronous results. The few read-shaped
   diagnostics and `measureText` never expose or walk native tree structure.
2. **Synchronous.** Each op is one blocking FFI call that returns on the same
   stack. The one batching path is `setPropBatch(records)`, an optional
   `HostOps` method outside the numbered op table: `records` is a little-endian
   `Float64Array` of `[nodeId, propId, value]` triples with the semantics of
   repeated `setProp` calls. `framework/src/anim.ts` commits jump batches
   through it and falls back to a `setProp` loop on hosts without it.
3. **The reconciler never reads tree structure across FFI.** The renderer keeps
   a **JS mirror tree**. Parent/child/sibling and node-kind reads are plain JS
   object walks; structural writes update both mirrors.

The op codes are pinned once, in `contracts/spec/spec.ts` (the `OP` table), and shared by every host and the Rust core. Codes are append-only: never renumbered, never reused. `0` is reserved as invalid/nop.

## The op table

Signatures are authoritative from `framework/src/host.ts` (`HostOps`) and `contracts/spec/spec.ts`.
Node ids are generation-tagged positive `i32` values and reserve `0` for
"none"; texture handles use their own 0-based or generation-tagged contracts.

Codes 1–46 are shipped. A host installs the required core first; every other
family is optional, gated on a capability, and feature-detected by the
framework (`ops.hitTest?.(…)`) rather than assumed. `contracts/spec/spec.ts`
carries a comment per op and is the only authority on argument order and edge
cases.

### Required core

| codes | ops | contract |
|---|---|---|
| 1–4 | `createNode`, `destroyNode`, `insertBefore`, `removeChild` | `createNode(type)` takes a `NODE_TYPE`: `0` view, `1` text, `2` image, `3` surface. `destroyNode` takes the whole subtree, frees its anim tracks, and clears focus if the focused node was inside. `insertBefore` has DOM move semantics (an attached child is unlinked first; anchor `0` appends) and no-ops past `MAX_TREE_DEPTH` (64). `removeChild` detaches but **keeps the node alive** for the end-of-frame sweep. |
| 5–8 | `setStyle`, `setProp`, `setText`, `replaceText` | `styleId` indexes the compiled style table and `STYLE_ID_NONE` (`-1`) clears to default; a swap diffs old against new to start transitions. `setProp` writes one `PROP` id as an `f64`. The two text ops are UTF-8, text nodes only; Solid universal calls `replaceText` on reactive text updates. |
| 9–10 | `uploadTexture`, `setImage` | Dimensions power-of-two and `≤ 512`, `psm` a `PSM` code, bytes copied 16-byte aligned. Texture handles are **0-based**, so `setImage` clears on `texHandle < 0`. |
| 11–13 | `animate`, `cancelAnim`, `setFocus` | `animate(id, propId, to, durMs, easing, delayMs)` tweens from the current value and returns an anim id; `easing` is an `ENUMS.Easing` ordinal. `setFocus(0)` clears focus, a live id applies the `focus:` variant natively. |
| 16–17 | `measureText`, `setSprite` | `measureText(str, fontSlot)` is the JS-side width query — layout measures natively. `setSprite` binds a native-ticked sprite atlas to an image node; non-positive `frames` clears it. |

### Optional families

| codes | family | condition |
|---|---|---|
| 14–15 | `loadStyles`, `loadFontAtlas` — feed the compiled `styles.bin` and one baked atlas blob per call | Installed by the QuickJS hosts (`hosts/psp/src/ffi.rs`, `hosts/vita/src/ffi.rs`, `hosts/3ds/src/qjs.c`, `hosts/nokia-e7/runtime/main.cpp`, `engine/quickjs-c/pocket_runtime.c`) and by web/test hosts. `render()` calls them only when the host publishes no native texture table, so a console host that parses the pak natively never receives the call. |
| 18–22 | `debugInspect`, `debugRectXY`, `debugRectWH`, `debugPause`, `debugStep` — inspect one node's world AABB, freeze the world, arm one tick | Debug-only and default-off. See [DevTools](/docs/devtools/). |
| 23–25 | `loadTileTexture`, `freeTexture`, `uploadImgEntry` — decode one TILESET tile host-side, release a generation-tagged texture, upload a self-contained IMG entry with its CLUT8 palette and RLE flags | Native hosts implement these so tile bytes never transit the JS heap; without them `framework/src/tiles.ts` falls back to `__pak` + `uploadTexture`. |
| 26 | `setActive` — apply or clear the native `active:` pressed variant | Hosts that predate the op lack it and pressed visuals degrade. |
| 27–29, 42 | `hitTest`, `setCursor`, `setCursorPos`, `hitTestBounds` — hit testing plus the cursor sprite | `input.cursor` and `input.touch`. `hitTest` claims painted nodes in paint order, so pure layout containers pass through; `hitTestBounds` claims layout boxes, so a finger in a list's row gap hits the list. A host with `input.touch` resolves the bounds hit once per contact at the down edge and delivers it as `frame()` argument 4 — the guest calls the op only when that fact channel is absent. |
| 30–33 | `svcOpen`, `svcPoll`, `svcSend`, `loadImgFile` — the companion channel: JSON lines through a tethered mailbox directory, plus side-file IMG entries read into textures without JS-heap transit | Native hosts with a tethered companion process. Apps feature-detect: a missing `svcOpen`, or one returning false, means "not tethered". |
| 34–37 | `videoOpen`, `videoTick`, `videoTexture`, `videoClose` — a host-decoded `.pkst` pixel + PCM feed presented as one core texture and one audio channel | The same tethered hosts. `videoTick` is a bounded per-frame IO pump returning the presented source frame index. |
| 38 | `debugStats` — one JSON snapshot of the device's diagnostic counters plus build identity: the app output name and the FNV-1a64 hash of the embedded js+pak | Hosts without counters omit it and the DevTools `stats` reply carries `null`. |
| 39–41 | `appTable`, `appLaunch`, `appShot` — the embedded bundle table, a whole-guest switch after the current frame presents, and the texture of the frame the SELECT summon froze | Multi-app hosts only; `@pocketjs/framework/launcher` feature-detects. |
| 43 | `wrapText` — greedy soft-wrap break columns for one line under `maxW`, as ascending UTF-16 code-unit indices | Breaks come from the same provider that measures and paints the slot; a native-text backend may install the host wrapper (gpui's `LineWrapper`) and its positions win. Without the op, apps run matching greedy rules over `measureText`. |
| 44 | `setCompositorSurface` — bind a Pocket System package surface to a `NODE_TYPE.surface` node; the core emits `SURFACE_QUAD` in paint order with both full and clipped bounds | `ui.compositor-surfaces`. No image or texture semantics are involved; `handle < 0` clears. |
| 45–46 | `hitTestAuxiliary`, `hitTestBoundsAuxiliary` — the twins of 27 and 42 in the auxiliary output's logical coordinates, never searching primary | `display.auxiliary`. |

For the meaning of `PROP` ids, `ENUMS`, and how a `class` string becomes a `styleId`, see [Styling](/docs/styling/) and the [API reference](/docs/api/). For `animate`/`easing` semantics see [Animation](/docs/animation/).

### Prop value encoding

`setProp` and `animate` carry every value as one number (`f64` on the wire). `framework/src/host.ts` encodes the JS value per the prop's kind (`PROP_VALUE_KIND` in the spec):

- **f32 props** (dimensions, scalars, degrees) pass through as-is.
- **color props** travel as their `u32` **ABGR** bits (`0xAABBGGRR`, the GE `COLOR_8888` layout). A `'#rgb' / '#rrggbb' / '#rrggbbaa'` string is parsed by `parseHexColor` — full-string hex validation, so `#ff00zz` throws rather than silently painting a prefix.
- **int/enum props** travel as their `u32` ordinal.

`encodePropValue(prop, value)` is the single choke point; a non-numeric string for a non-color prop throws loudly.

## Generation-tagged handles

Node ids are not pointers and not plain indices. Each id packs a slot and a generation:

```ts
id = (generation << ID_SLOT_BITS) | slot; // ID_SLOT_BITS = 20, mask 0xFFFFF
```

- **slot** — index into the core's node arena (`Vec<Node>` + free list).
- **generation** — a counter that increments every time a slot is reused.

When a node is destroyed its slot returns to the free list and its generation bumps. A stale id held by JS — say a handler that fires after its node was swept — decodes to a slot whose live generation no longer matches, so the core recognizes it and the op becomes a **safe no-op** instead of corrupting a reused node.

Fixed invariants:

- Bit 31 stays `0`, so ids are always positive `i32`.
- `0` is "no node" — `insertBefore` anchor `0` = append, `setFocus 0` = clear focus.
- `ROOT_ID` is `1` (slot 1, generation 0): the pre-created full-screen root, a flex column. Your tree mounts under it.
- `MAX_TREE_DEPTH` is `64`. `insertBefore` past the cap is a silent no-op — the same contract as a stale id — which bounds every recursive tree walk (layout build/readback, paint, subtree destroy) so a runaway tree cannot overflow the small PSP thread stacks.

## The JS mirror tree

`framework/src/renderer.ts` re-exports `renderer-solid.ts`, which implements Solid's universal `createRenderer`. The mirror tree itself — the `NodeMirror` shape, the structural mutations, and the sweep set — lives in `framework/src/native-tree.ts` and is shared with the Vue Vapor and Octane renderers:

```ts
interface NodeMirror {
  id: number;                 // native generation-tagged id
  type: number;               // NODE_TYPE ordinal
  parent: NodeMirror | null;
  children: NodeMirror[];
  text?: string;              // text nodes only
  focusable?: boolean;
  onPress?: (() => void) | undefined;
}
```

Vue Vapor's DOM-shaped helpers add `domNodeType` / `domTag` / `domAttrs` /
`domData` to the same object, and DevTools adds `debugName`.

Every reconciler *read* resolves against this object graph:

| reconciler hook | implementation |
|---|---|
| `getParentNode` | `node.parent` |
| `getFirstChild` | `node.children[0]` |
| `getNextSibling` | index-of in `parent.children`, return next |
| `isTextNode` | `node.type === NODE_TYPE.text` |

None of those touch the host. Structural mutations (`insertNode`, `removeNode`, `createElement`, `createTextNode`, `replaceText`, `setProperty`) update the mirror *and* emit the matching op. Because the mirror mirrors the native tree exactly — including DOM move semantics on re-parenting — the two never disagree, and Solid's frequent tree walks stay entirely in JS. This is what keeps steady-state frames near-zero FFI.

`setProperty` is a dispatch table, not a generic setter: `class → styleId` (via the injected style resolver), `onPress`/`on:press` → input registry, `src` → texture registry, `style={{…}}` → per-key `setProp` (prev-diffed, so only changed keys cross FFI). Anything else — `classList`, `on:`/`bool:`/`prop:` namespaces, unknown props — is a loud error. See [Styling](/docs/styling/) for why `classList` is rejected.

## Host identity and strictness

`detectHost()` in `framework/src/host.ts` resolves which `HostOps` object the ops route to, and sets a **strictness** flag that changes behavior on bad input:

| kind | ops source | target | strict? | on unknown class / texture |
|---|---|---|---|---|
| `native` | `globalThis.ui` installed by a QuickJS device runtime | `ui.__host` (`psp`, `vita`, …) | no | bump a miss counter, keep going |
| `injected` | a `HostOps` passed into `render()` (web / wasm / Bun) | `injected` unless supplied | yes | **throw** |

The reasoning is asymmetric on purpose. On real hardware a thrown error is a
black screen; a missing style is a slightly-wrong box. Native hosts count
misses (`missCounters.unknownClass` / `unknownTexture`) and render on. Web,
wasm, and headless-Bun hosts are development and CI surfaces, where a silent
wrong-color pixel is worse than a stack trace.

Resolution order: an injected `HostOps` wins — unless it is the same object as
`globalThis.ui` and that namespace marks itself native, in which case the host
stays native and non-strict. Otherwise `globalThis.ui` is taken; one that
carries neither marker, as the web and wasm adapters publish, resolves as
strict-injected. If neither exists, `render()` throws.

A namespace marks itself native with `__host` plus `__hostAbi`, or, for hosts
built before platform contracts, with `__textures` alone. A manifest-built
bundle embeds its expected target and ABI and refuses to mount on a mismatch;
`assertNativeHostContract` also compares the bundle's baked tick rate against
the host's `ui.__tickHz` on every native mount.

On ESP-IDF the namespace is installed by `pocketjs_ui_qjs` into a caller-owned
guest and forwards each op to a caller-owned core; see
[ESP-IDF](/docs/esp-idf/).

Every host drives frames through
`globalThis.frame(buttons, analog?, touches?, hits?, touchSurfaces?)`. Buttons use the shared PSP
bitmask, analog is `(x << 8) | y` with centered bytes on stickless hosts, and
touch contacts are packed snapshots in logical coordinates. `hits` carries
parallel down-edge hit facts; `touchSurfaces` uses `0` for primary and `1` for
auxiliary, with omitted entries defaulting to primary. The runtime latches
these inputs before app hooks, then performs input edge detection and the
end-of-frame sweep. See [Input & focus](/docs/input-focus/) and
[Platform contracts](/docs/platform-contracts/).

## Frame order

Native hosts run one deterministic sequence per display frame. Web and Bun
hosts perform the same logical steps under a fixed-step
`requestAnimationFrame` / loop so goldens stay byte-exact.

```
read host input                     buttons + optional analog/touch snapshot
  ↓
frame(buttons, analog?, touches?, hits?, touchSurfaces?)
                 ── JS ──►          advance virtual time, latch input, run
                                    service pumps, deliver queued effects,
                                    resolve contact lifecycles (gestures),
                                    run app hooks + focus,
                                    then runSweep() (node reclamation) last
  ↓
drain jobs                          while JS_ExecutePendingJob(rt, &ctx) > 0
                                    (promise microtasks — polyfilled queueMicrotask)
  ↓
core.tick(N × 1/hz)                 advance exact ticks for this virtual frame
  ↓
layout (if dirty)                   taffy re-run + text re-measure, only if a
                                    layout-dirtying prop changed
  ↓
DrawList(s)                         one tree walk per resolved UI output →
                                    flat Vec<u32> ops, CPU-clipped
  ↓
backend acquire/render/present      DrawList → GE, GXM, WGPU, or software
```

The final phase is schematic. PSP pipelines the GE — it presents the previous
list, starts the next, and lets the GPU overlap the following frame's JS/core
work — while Vita and software hosts order acquire and presentation their own
way, without changing the frame transaction above.

Key properties:

- **The sweep runs inside `frame()`**, as the last thing user code does — so a remove-then-reinsert within one frame (a `<For>` reorder, a `<Show>` toggle) never destroys a live node.
- **Virtual time, fixed core ticks.** A realm declares its rate before the
  first tick (`Ui::set_tick_rate`; `DEFAULT_TICK_HZ` is 60, `MAX_TICK_HZ` is
  240) and keeps it for the whole run, so one tick is `1/hz s` and never
  wall-clock time. A bundle bakes the same rate (`--hz=N`, 1 through 240) and
  refuses to mount on a host that declares another. `core.tick` advances an
  exact number of those ticks per virtual frame; commands from the outside
  world are delivered only at frame boundaries.
- **Layout is conditional.** Only a change to a layout-dirtying prop (`LAYOUT_DIRTYING` in the spec — sizes, padding, flex props, `fontSlot`/`tracking`/`lineHeight`) re-runs taffy. Transform and color changes are paint-only. Prefer transforms in animation for this reason.
- **Backends consume DrawLists.** The Rust core produces one DrawList per
  resolved UI output, in that output's logical coordinates. Single-screen hosts
  consume the primary list; a host with an auxiliary display consumes a second
  after both roots have shared the same state update and resource generation.
  The one semantic a backend can change is text: an app that enhances with
  `text.layout.native` gets a host measurer installed before mount, and taffy
  leaf sizes come from it ([Render backends](https://github.com/pocket-stack/pocketjs/blob/main/docs/BACKENDS.md)).

In steady state — no reactive values changed — `frame()` emits **no** mutation
ops, the sweep set is empty, and the only JS boundary crossing is the single
`frame(buttons, analog?, touches?, hits?, touchSurfaces?)` call itself.
Everything downstream (tick, layout, draw) is Rust.

## Node reclamation

Solid's reconciler calls `removeChild` for nodes that might be re-inserted the same frame (rows moving across a `<For>`, arms swapping in a `<Show>`). So `removeChild` does **not** destroy — `removeNode` in `framework/src/native-tree.ts` detaches and remembers the node in a sweep set:

```ts
export function removeNode(parent: NodeMirror, node: NodeMirror): void {
  if (!node) return;
  notifyDetached(node);              // focus repair, before the unlink
  getOps().removeChild(parent.id, node.id);
  unlink(node);                      // drop from the mirror parent
  sweepSet.add(node);                // reclaim at frame end unless re-attached
  treeMutated();                     // DevTools hook + the cursor hover cache
}
```

If the same node is inserted again before the frame ends, `insertNode` removes it from the sweep set (`sweepSet.delete(node)`) and it survives untouched. Whatever is still detached when `runSweep()` runs at the end of `frame()` gets `destroyNode`'d — a single recursive native destroy per orphaned subtree.

### `retain()` / `release()`

Sometimes you want to detach a subtree and keep it alive across frames — cache an offscreen panel, hold a pooled row. That opts out of the sweep:

```ts
import { retain, release } from "@pocketjs/framework/solid";

retain(node);   // detached but preserved; the sweep skips it (and any subtree containing it)
// ... later ...
release(node);  // undo; if still detached, it re-enters the next sweep
```

`runSweep` checks `subtreeHasRetained` before destroying, so a retained node
anywhere inside a detached subtree keeps the whole subtree pending until it is
released or re-attached. Reclamation is explicit and deterministic; it does not
depend on `FinalizationRegistry` or garbage-collector timing.

## PSP memory model

On hardware the whole stack lives in **one arena**, and getting there required fixing a `rust-psp` default that quietly caps out.

`rust-psp` installs a `#[global_allocator]` that makes **one kernel memory object per allocation**. The kernel caps those at roughly 4096, and `pocketjs-core` allocates constantly — taffy slotmaps, `children` Vecs, per-pass `.collect()`s, the DrawList — so the default allocator crashes a real UI. The QuickJS-side arena only covered QuickJS + newlib `malloc`, not core's Rust allocations.

The fix, at a high level:

1. The exact-revision `pocket-stack/rust-psp` dependency exposes an **`external-global-alloc`** feature that cfg-gates out its `#[global_allocator]`.
2. `hosts/psp/src/alloc.rs` installs the PocketJS global allocator, backed by `arena::alloc`/`dealloc` — the **same single kernel block** QuickJS uses. Core, QuickJS, and newlib all draw from one arena.
3. `arena.rs`'s `ensure_init` calls `sceKernelAllocPartitionMemory` / `sceKernelGetBlockHeadAddr` **directly** — no recursion back through `alloc::alloc`, now that the arena *is* the global allocator.
4. Texture uploads and retained core buffers live in that same arena. A **2 MB margin** is reserved for the GE display list and stack safety.

Other inherited hard rules worth knowing when you touch the native side:

- JS runs on a **1 MB `USER | VFPU` worker** created in `hosts/psp/src/host.rs`; the `psp::module!` main thread has only a 256 KB stack, which QuickJS overflows while compiling a bundle. `MAX_TREE_DEPTH = 64` keeps recursive walks inside the worker stack.
- GE buffers are 16-byte aligned with a dcache writeback per batch.
- 2D vertex coords are `i16`; the core's CPU clip stage guarantees in-range values so the GE never wraps a coordinate.
- Textures are power-of-two, `≤ 512` per side, sampled from main RAM.

## Perf budget

The whole design converges on a small steady-state cost:

| budget | target |
|---|---|
| FFI crossings per steady frame | **one** (`frame(buttons, analog?, touches?, hits?, touchSurfaces?)`; no mutation ops when nothing changed) |
| DrawList draw calls | **≤ ~40** `sceGuDrawArray` calls |
| DrawList quads | **≤ ~2000** |
| per-frame vertex bytes | **≈ 48 KB** from a per-frame bump pool (reset after `sceGuSync`) |
| Solid effects | run only on interaction / changed signals |

Two practical corollaries for app authors: animate **transforms and colors** rather than layout props, because layout-prop animations force a taffy relayout that frame (transforms are paint-only); and keep dynamic styling to ternaries of full class literals or `style={{…}}` objects so the compiler can bake every style ahead of time. See the [Build pipeline](/docs/build-pipeline/) for how styles and font atlases are baked, and [Architecture](/docs/architecture/) for how the same Rust core reaches every host family.
