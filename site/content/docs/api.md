# API reference

The primary app-facing exports of `@pocketjs/framework`, grouped by import
path. Signatures are TypeScript-style; defaults are noted in parentheses.
Framework-internal and tests/debug helpers are not exhaustive here. For conceptual walkthroughs see [Components](/docs/components/),
[Reactivity](/docs/reactivity/), [Animation](/docs/animation/), and
[Input & focus](/docs/input-focus/).

| Import path | Exports |
| --- | --- |
| `@pocketjs/framework` | `mount`, `render`, host/runtime helpers, types |
| `@pocketjs/framework/components` | `View`, `Text`, `Image`, `Sprite`, `CompositorSurface`, `Screen`, `Focusable`, `FocusScope`, `FocusGrid`, `ActionHandler`, `Portal`, `AuxiliarySurface`, `AuxiliaryPortal`, `Modal`, `ActionBar`, `Named`, `Grid`, `Lazy`, `Gallery`, `DeepZoom` (Solid) |
| `solid-js` | `createSignal`, `createEffect`, `createMemo`, `onMount`, `onCleanup`, `batch`, `untrack`, `Show`, `For`, `Index`, `Switch`, `Match` |
| `vue` | `defineComponent`, `ref`, `computed`, `watchEffect`, `onMounted`, `onScopeDispose` |
| `octane` | `useState`, `useEffect`, `useMemo`, `useRef`, `useLayoutEffect`, `useEffectEvent` |
| `@pocketjs/framework/animation` | `animate`, `spring`, `jump`, `cancelAnim` |
| `@pocketjs/framework/lifecycle` | `onFrame`, `onButtonPress`, `analogX`, `analogY`, `analogRaw`, `createSpriteAnimation`, `pushButtonHandlerBlock` (Octane builds: `useFrame`, `useButtonPress`, `useSpriteAnimation`) |
| `@pocketjs/framework/input` | `BTN`, `touches`, `auxiliaryTouches`, `focusNode`, `getFocused`, `pressNode`, `setActiveNode`, `pushFocusScope`, `pushFocusGrid`, `pushFocusController`, `hitFocusable`, `hitNode`, `enableCursor`, `cursorX`, `cursorY` |
| `@pocketjs/framework/gesture` | `createGesture`, `attachGesture`, `pushTouchBlock`, gesture types (Solid and Vue Vapor) |
| `@pocketjs/framework/kinetics` | `createScroller`, `bindDpadScroll`, `Scroller` / `ScrollerOptions` / `ScrollerState` types (Solid and Vue Vapor) |
| `@pocketjs/framework/osk` | `Osk`, `TextField`, `createOsk`, `OSK_H`, `OSK_LAYERS`, `OSK_LAYOUTS`, `oskPanelHeight`, `resetPanelMemory` (Solid) |
| `@pocketjs/framework/virtual-list` | `VirtualList`, `VirtualListProps`, `VirtualListHandle` (Solid) |
| `@pocketjs/framework/display` | `auxiliaryViewport`, `hasAuxiliarySurface` |
| `@pocketjs/framework/platform` | `platform`, `hasFeature` |
| `@pocketjs/framework/modality` | `modality`, `presentation`, `screen`, `surfaceHasTouch`, `supports`, `glyph` |
| `@pocketjs/framework/actions` | `useActions`, `ACTION_BUTTONS`, `ACTION_INTENTS`, `HOLD_SECONDS` (Solid) |
| `@pocketjs/framework/system` | `installSystemLayer`, `SYSTEM_HOLD_SECONDS` (Solid) |
| `@pocketjs/framework/classic` | `ClassicBar`, `ClassicFooter`, `ClassicList`, `ClassicSelection`, `ClassicSpinner`, `ClassicSkeleton`, `ClassicButton`, `ClassicFace`, `ClassicPanel`, `ClassicSheet`, `CLASSIC` (Solid) |
| `@pocketjs/framework/clock` | `simulationHz`, `ticksPerFrame`, `virtualFrame`, `virtualNow`, `after` |
| `@pocketjs/framework/effects` | `installEffectDriver`, `runEffect`, effect types |
| `@pocketjs/framework/net` | `fetch`, `NetError`, `PocketResponse`, `FetchOptions` |
| `@pocketjs/framework/db` | `Database`, `Statement`, `SqlValue`, `SqlParams`, `RunResult` |
| `@pocketjs/framework/fs` | `file`, `write`, `usage`, and the `node:fs` sync subset (`readFileSync`, `writeFileSync`, `appendFileSync`, `mkdirSync`, `readdirSync`, `rmSync`, `renameSync`, `statSync`, `existsSync`) |
| `@pocketjs/framework/audio` | `decodeWav`, `createWavPlayer`, `WavPcm` / `WavPlayer` types |
| `@pocketjs/framework/launcher` | `launcherActive`, `appTable`, `launchApp`, `frozenShot` |
| `@pocketjs/framework/devtools` | `initDevtools`, `wrapFrameHandler`, tape expanders — see [DevTools](/docs/devtools/) |
| `@pocketjs/framework/hot` | `text`, `prop` |
| `@pocketjs/framework/manifest` | app and Pocket System schema/types/resolvers, `extractHostBuildInputs`, `hostBuildEnvironment`, `vitaTitleId` |

`framework/compiler/subpaths.ts` is the registry these paths are declared in —
one row per module, and a build resolves nothing that has no row. The rows it
carries beyond this table (`/config`, `/host`, `/package`, `/prelude`,
`/renderer`, `/idf-host`, `/vita-package`) are build and host-author surface
rather than app API.

---

## `@pocketjs/framework`

The runtime entry point: mount an app, tear it down, and reach the lower-level host, sweep, style, and pack utilities.

### `mount`

```ts
function mount(code: () => unknown, opts?: MountOptions): () => void
```

App-level entry point for demo/application bundles. Resolves ops from `opts.ops` or `globalThis.ui`, loads `opts.pak` (when given), uploads the pack's images on injected hosts, feeds the default generated style table (`opts.styles` ?? `STYLE_IDS`), and mounts `code`. Returns a disposer that unmounts and destroys the app subtree. Throws if neither `opts.ops` nor `globalThis.ui` is present.

Solid entries pass a closure (`mount(() => <App />)`); Vue Vapor and Octane
entries pass the component itself (`mount(App)`). In Octane, JSX inside a
call-argument arrow is a compile error, so `mount(App)` is the only valid
entry shape.

### `render`

```ts
function render(code: () => unknown, opts?: RenderOptions): () => void
```

Lower-level mount: detects and installs the host, wires the style resolver, registers `opts.styles`, feeds styles/atlases from the pack on injected hosts, builds the app + overlay layers, installs the per-frame handler, and mounts `code`. Returns a disposer. `mount` calls `render`; call `render` directly when you supply your own `ops`/`styles`.

### `RenderOptions` / `MountOptions`

`MountOptions` is an alias of `RenderOptions`.

| Field | Type | Description |
| --- | --- | --- |
| `ops` | `HostOps` | web/wasm/test hosts inject their op surface here; omit on native QuickJS hosts (`globalThis.ui`). |
| `styles` | `Record<string, number>` | class-literal → styleId table (`styles.generated.ts`). |
| `pak` | `ArrayBuffer` | app pack; defaults to `globalThis.__pak` when present. |

### Host helpers

```ts
function detectHost(injected?: HostOps): Host
function installHost(host: Host): void
function getOps(): HostOps
```

`detectHost` resolves the active host — injected ops win, otherwise
`globalThis.ui` (PSP/Vita QuickJS); throws when neither exists. `installHost`
sets the active host (called by `render`). `getOps` returns the installed op
surface. Manifest-built native bundles validate `ui.__host` and
`ui.__hostAbi` before mounting. See [Native contract](/docs/native-contract/)
for the full `HostOps` surface.

### `HostOps`

The synchronous `ui.*` op surface a host installs. Node ids are
generation-tagged positive i32 values and reserve `0` for "none"; texture
handles have separate 0-based or generation-tagged contracts. Its TypeScript
declaration is `HostOps` in `framework/src/host.ts`, and the
[Native contract](/docs/native-contract/) page owns the wire: every op number,
signature, and which ops a host may omit.

### `Host`

```ts
interface Host {
  ops: HostOps;
  kind: "native" | "injected";
  target: string;
  strict: boolean;
}
```

`kind` describes who owns the transport, not the target. Native PSP and Vita
hosts are non-strict and count an unknown class or texture; injected
web/wasm/test hosts throw. `target` normally carries `"psp"`, `"vita"`, or
`"injected"`; a pre-contract native host reports `"unknown"`, and a custom
injected host may supply another identifier.

### End-of-frame sweep

```ts
function retain(node: NodeMirror): void
function release(node: NodeMirror): void
function runSweep(): void
```

`retain` keeps a detached subtree alive across frames (skips the sweep); `release` undoes it so a still-detached node re-enters the next sweep. `runSweep` destroys every subtree removed during the frame and still detached — the runtime calls it once per frame after user code and input, so remove-then-reinsert (Solid moves) never destroys live nodes. Reach for these only when hand-managing detached subtrees.

### `registerTexture`

```ts
function registerTexture(key: string, handle: number): void
```

Bind an image key (the `src` string) to an `uploadTexture` handle so `<Image src="key">` resolves through the renderer's texture registry.

### `missCounters`

```ts
const missCounters: { unknownClass: number; unknownTexture: number; unknownSurface: number }
```

On a non-strict native host, an unknown class or texture increments a counter
instead of throwing. Read it to diagnose missing styles/images without
crashing hardware.

### Styles

```ts
function registerStyles(table: Record<string, number>): void
function resolveStyle(cls: string): number | undefined
```

`registerStyles` loads a class-literal → styleId table (the compiler's `STYLE_IDS`); it also registers a token-sorted alias so `"a b"` resolves the id for `"b a"`. `resolveStyle` returns the styleId for a class string, or `undefined` if the compiler never saw it (or the token reordering is ambiguous). See [Styling](/docs/styling/).

### Data pack (pak)

```ts
function pakEntries(prefix?: string): string[]
function pakGet(key: string): Uint8Array
function loadPack(ab: ArrayBuffer): void
function resetPack(): void
```

`pakEntries` lists entry keys starting with `prefix` (default: all keys), sorted. `pakGet` returns a fresh copy of a blob's bytes, throwing on a missing key. `loadPack` explicitly loads a pack (web host after fetch, or tests), replacing any prior. `resetPack` drops the cached parsed pack. See [Build pipeline](/docs/build-pipeline/).

### `NodeMirror`

```ts
interface NodeMirror {
  id: number;                         // native generation-tagged node id
  type: number;                       // spec NODE_TYPE ordinal
  parent: NodeMirror | null;
  children: NodeMirror[];
  text?: string;                      // text nodes only
  focusable?: boolean;                // focus traversal membership
  onPress?: (() => void) | undefined; // activation: CIRCLE, tap, or cursor click
}
```

The JS mirror of a native node. A `ref` receives one; `animate`, `spring`, `focusNode`, `pushFocusScope`, and `pushFocusGrid` all accept one.

---

## `@pocketjs/framework/components`

Platform primitives and higher-level components. Solid control-flow components
(`Show`, `For`, `Index`, `Switch`, `Match`) are not exported here; import them
directly from `solid-js`.

### Primitives

```ts
function View(props: ViewProps): JSX.Element
function Text(props: TextProps): JSX.Element
function Image(props: ImageProps): JSX.Element
function Sprite(props: SpriteProps): JSX.Element
function CompositorSurface(props: CompositorSurfaceProps): JSX.Element
```

The host primitives, wrapped React Native-style. `View` is the flex container/box, `Text` renders baked-font text, `Image` draws an uploaded texture by `src` key, and `Sprite` draws an auto-playing animation from a baked sprite atlas by `sprite` key. `CompositorSurface` is reserved for System UI shells and places an installed package AppInstance into shell layout and painter order.

**`ViewProps`**

| Prop | Type | Description |
| --- | --- | --- |
| `class` | `string` | Tailwind-subset class literal. |
| `style` | `Record<string, number \| string>` | Inline spec props (escape hatch). |
| `onPress` | `() => void` | Fired when the node is activated: CIRCLE while focused, a touch tap on the node, or a cursor click. See [App shell](/docs/app-shell/). |
| `focusable` | `boolean` | Joins d-pad focus traversal. |
| `ref` | `(node: NodeMirror) => void \| NodeMirror` | Node handle. |
| `children` | `JSX.Element` | Child nodes. |
| `debugName` | `string` | Semantic name in the [DevTools](/docs/devtools/) tree (mirror-only, zero native cost). |

**`TextProps`** — `class`, `style`, `ref`, `children`, `debugName`.
**`ImageProps`** — `class`, `src` (`string`), `style`, `ref`, `debugName`.
**`SpriteProps`** — `class`, `sprite` (`string` — a `ui:sprite.<name>` atlas key), `style`, `ref`, `debugName`.
**`CompositorSurfaceProps`** — `class`, `style`, `package` (installed reverse-DNS package id), `focused`, `ref`, `debugName`.

`Sprite` is a native animated primitive: its atlas (a pow2 texture holding a grid of frames) is baked into the pak, and the Rust core advances the frame cell from its own tick counter — deterministic and with **zero per-frame JS**. It auto-plays from the first frame the moment it is displayed, so a sprite revealed by paging or a `Show`/`Lazy` starts animating on its own. Bake atlases by listing them in a demo's `sprites.json` (`{ "<atlas>.png": { cols, rows, frames, step } }`); `step` is core ticks per frame, so the sprite runs at `tick rate / step` fps (`step: 2` is 30 fps on a 60 Hz bundle). See `apps/gallery` (its covers are shader-baked animated sprites).

### `Screen`

```ts
function Screen(props: ScreenProps): JSX.Element  // ScreenProps extends ViewProps
```

A full-screen root `View`. Defaults `class` to `"relative flex-col w-full h-full bg-slate-50 overflow-hidden"` when none is given.

### `Focusable`

```ts
interface FocusableProps extends ViewProps { onPress?: () => void }
function Focusable(props: FocusableProps): JSX.Element
```

A `View` with `focusable: true`. `onPress` is the activation handler: CIRCLE
while the node is focused, a touch tap on the node, or a cursor click all
enter it through the same path. See [App shell](/docs/app-shell/).

### `FocusScope`

```ts
interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}
function FocusScope(props: FocusScopeProps): JSX.Element
```

Restricts d-pad traversal and CIRCLE to its subtree while `active` (default `true`). Adds `autoFocus` / `restoreFocus` from `FocusScopeOptions`. Internally pushes/pops via `pushFocusScope`.

### `FocusGrid`

```ts
interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}
function FocusGrid(props: FocusGridProps): JSX.Element
```

Gives its subtree row/column d-pad semantics while `active`. Requires `columns`; `wrap` (default `false`) wraps at row ends. Internally pushes/pops via `pushFocusGrid`.

### `ActionHandler`

```ts
interface ActionHandlerProps extends ButtonPressOptions {
  button: number;                                    // BTN mask
  onPress: (pressed: number, buttons: number) => void;
  children?: JSX.Element;
}
function ActionHandler(props: ActionHandlerProps): JSX.Element
```

Declarative wrapper over `onButtonPress`: fires `onPress` on the button edge.
Inherits `allowWhenBlocked`, `active`, and `latched` from
`ButtonPressOptions`. Renders `children` (or nothing).

### `Portal`

```ts
interface PortalProps { children?: JSX.Element | (() => JSX.Element) }
function Portal(props: PortalProps): JSX.Element
```

Renders `children` into the full-screen overlay root (above the app layer, `zIndex 1000`) instead of the local tree. Cleans up its host node on unmount.

### `AuxiliarySurface`

```ts
interface AuxiliarySurfaceProps { children?: JSX.Element | (() => JSX.Element) }
function AuxiliarySurface(props: AuxiliarySurfaceProps): JSX.Element
```

Renders `children` into the independent application layer of the resolved
auxiliary display. The component requires `display.auxiliary`; mounting it
without that capability throws. The application state and resource pool remain
shared with the primary tree.

### `AuxiliaryPortal`

```ts
function AuxiliaryPortal(props: AuxiliarySurfaceProps): JSX.Element
```

Renders children into the auxiliary display's overlay layer. Use it for
content that must paint above the rest of `<AuxiliarySurface>`; ordinary
`Portal` always targets the primary display.

### `Modal`

```ts
interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: JSX.Element;
}
function Modal(props: ModalProps): JSX.Element
```

A portalled backdrop + focus-scoped panel. While `open`, it blocks background button handlers (`pushButtonHandlerBlock`) and fades/scales the panel in. `class` styles the centering frame; `panelClass` styles the panel.

### `Named`

```ts
function Named(props: { name: string; children?: JSX.Element }): JSX.Element
```

Tags the host nodes it renders with a semantic name for the
[DevTools](/docs/devtools/) component tree (`<Named name="MessageCard"><Card/></Named>`).
Renders no node of its own; a child's explicit `debugName` prop wins.

### `ActionBar`

```ts
function ActionBar(props: ActionBarProps): JSX.Element  // ActionBarProps extends ViewProps
```

A portalled bottom bar. Defaults to a pinned `left-3 right-3 bottom-3` row when no `class` is given.

### `Grid`

```ts
interface GridProps extends ViewProps, Partial<FocusGridOptions> {
  gap?: number;                            // cross-axis gap px (via style)
  active?: boolean | (() => boolean);      // enable FocusGrid traversal (needs columns)
}
function Grid(props: GridProps): JSX.Element
```

A wrapping tile layout (`flex-row flex-wrap`). With `columns` + `active` it delegates row/column d-pad traversal to [`FocusGrid`](#focusgrid); `columns` drives traversal only — layout stays flexbox. `gap` is a number so `class` can stay a single compiled literal.

### `Lazy`

```ts
interface LazyProps {
  when: boolean | (() => boolean);         // mount while truthy; destroy when false
  reveal?: number;                         // host frames to show fallback first (0)
  fallback?: JSX.Element | (() => JSX.Element);
  children: () => JSX.Element;             // deferred content factory
}
function Lazy(props: LazyProps): JSX.Element
```

On-demand mount: builds `children` only while `when` is truthy (the sweep destroys the subtree when it goes false). `reveal` shows `fallback` for N frames the first time it activates, then latches revealed for its lifetime (no replay). Models on-demand *content build* — textures are still uploaded eagerly at pak load.

### `Gallery`

```ts
interface GalleryProps {
  count: number;                           // total pages
  page: () => number;                      // controlled current-page accessor
  onPageChange?: (next: number) => void;
  renderPage: (index: number) => JSX.Element;  // called only for in-window pages
  window?: number;                         // pages kept mounted each side (1)
  duration?: number;                       // slide ms (300)
  easing?: EasingName;                     // slide easing ("out")
  bindTriggers?: boolean;                  // bind LTRIGGER/RTRIGGER (true)
  wrap?: boolean;                          // wrap past the ends (false)
  class?: string;                          // outer viewport class
}
function Gallery(props: GalleryProps): JSX.Element
```

A full-screen L/R-paged strip: `LTRIGGER`/`RTRIGGER` slide one whole screen at a time. Controlled (`page` + `onPageChange`); the slide is one native `translateX` tween per press (paint-only), and pages outside `window` are not built, keeping many-page galleries inside the draw budget. See `apps/gallery`.

### `DeepZoom` (Solid)

```ts
function DeepZoom(props: DeepZoomProps): JSX.Element
```

A streamed tiled-canvas viewer. It selects from a baked `TileDoc` pyramid,
keeps an overview beneath the active level, loads a bounded number of tiles per
frame, and releases generation-tagged texture handles outside the viewport.
D-pad/left-analog panning and trigger zoom are built in; `gestureSource` can
supply logical-coordinate pan/pinch gestures with an anchored zoom point.

| Prop | Type | Description |
| --- | --- | --- |
| `doc` | `TileDoc` | Baked document dimensions, background, tile edge, and resolution levels. |
| `width` / `height` | `number` | Logical viewport size (defaults to 480×272). |
| `loadBudget` | `number` | Maximum textured-tile uploads per frame (default `2`). |
| `prefetch` | `number` | Extra mounted tile ring (default `1`). |
| `bindInput` | `boolean` | Bind controller pan/zoom internally (default `true`). |
| `gestureSource` | `() => DeepZoomGesture \| null` | Optional direct-manipulation input for touch hosts. |
| `onView` | `(view: DeepZoomView) => void` | Observe deterministic center, zoom, and selected level. |

`DeepZoom` is currently exported by the Solid components adapter. The tile
wire format and texture-streaming HostOps remain framework-neutral.

## `solid-js`

Import Solid's reactive primitives and control-flow components directly from
`solid-js`. PocketJS relies on the real Solid runtime rather than wrapping or
curating these exports. Full docs live at
[solidjs.com](https://www.solidjs.com/docs/latest/api); summary below.

### Reactivity

| Export | Signature | Purpose |
| --- | --- | --- |
| `createSignal` | `createSignal<T>(value?, opts?) => [get: () => T, set: (v) => T]` | Reactive atom. |
| `createEffect` | `createEffect(fn: (prev) => T, value?) => void` | Run on dependency change. |
| `createMemo` | `createMemo(fn: (prev) => T, value?) => () => T` | Cached derived value. |
| `onMount` | `onMount(fn: () => void) => void` | Run once after first render. |
| `onCleanup` | `onCleanup(fn: () => void) => void` | Run on owner disposal. |
| `batch` | `batch(fn: () => T) => T` | Coalesce updates. |
| `untrack` | `untrack(fn: () => T) => T` | Read without tracking. |

See [Reactivity](/docs/reactivity/).

### Control flow

| Component | Usage | Purpose |
| --- | --- | --- |
| `Show` | `<Show when={cond} fallback={…}>…</Show>` | Conditional render. |
| `For` | `<For each={list}>{(item, i) => …}</For>` | List keyed by reference. |
| `Index` | `<Index each={list}>{(item, i) => …}</Index>` | List keyed by index. |
| `Switch` / `Match` | `<Switch fallback={…}><Match when={c}>…</Match></Switch>` | Multi-branch. |

PocketJS's renderer maps these updates onto the native tree, but the component
APIs and semantics are Solid's.

## `vue`

Vue Vapor apps import Vue's Composition API directly from `vue`; PocketJS does
not wrap refs, computed values, effects, or component definitions. Use
`@pocketjs/framework/vue-vapor/components` explicitly, or set
`framework: "vue-vapor"` and import generic `@pocketjs/framework/components`.

## `octane`

Octane apps import React-model hooks directly from `octane` (`useState`,
`useEffect`, `useMemo`, `useRef`, `useLayoutEffect`, `useEffectEvent`, …);
PocketJS does not wrap them. Dependency arrays may be omitted — the Octane
compiler infers them from captures — and hooks are tracked by call site
(conditional hooks in `if` blocks are fine, hooks in loops are not). Use
`@pocketjs/framework/octane/components` explicitly, or set
`framework: "octane"` and import generic `@pocketjs/framework/components`.

PocketJS's per-frame lifecycle hooks are use-prefixed in Octane builds —
`useFrame`, `useButtonPress`, and `useSpriteAnimation` from
`@pocketjs/framework/octane/lifecycle` — because the Octane compiler slot-keys
custom hooks by the `use[A-Z]` naming convention. Their signatures match
`onFrame` / `onButtonPress` / `createSpriteAnimation` below, except
`useSpriteAnimation` returns the current frame key as a plain `string`.
`pushButtonHandlerBlock` is not a hook and keeps its name.

---

## `@pocketjs/framework/animation`

Typed motion over `ops.animate`. JS declares the tween once; the Rust core
advances it one fixed tick at a time, `dt = 1 / tick rate` for the rate the
bundle bakes (see [`clock`](#pocketjsframeworkclock)). `prop` is a spec `PROP` name and must
be animatable (e.g. `opacity`, `translateY`, `scale`, and color props) —
non-animatable props throw. See [Animation](/docs/animation/).

### `animate`

```ts
function animate(
  node: NodeMirror | number,
  prop: PropName,
  to: number | string,
  opts?: AnimateOptions,
): number   // returns animId
```

Tweens `prop` from its current value to `to`. For color props, `to` is a packed u32 ABGR or a `'#rrggbb'` / `'#rrggbbaa'` string. Returns an animId for `cancelAnim`.

**`AnimateOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `dur` | `number` | `200` | Duration in ms (ignored by spring easings). |
| `easing` | `EasingName \| number` | `"out"` | Named easing or raw `ENUMS.Easing` ordinal. |
| `delay` | `number` | `0` | Delay in ms before the tween starts. |

**`EasingName`** — `"linear" | "in" | "out" | "in-out" | "out-back" | "spring" | "spring-bouncy"`.

### `jump`

```ts
function jump(node: NodeMirror | number, prop: PropName, value: number | string): void
```

Sets an animatable prop for this frame with no tween. A `jump` on a transform
prop is paint-only — one `setProp`, no relayout — which is what a finger-follow
drag writes on every move frame.

### `spring`

```ts
function spring(
  node: NodeMirror | number,
  prop: PropName,
  to: number | string,
  preset?: "default" | "bouncy",
): number
```

Springs `prop` to `to`; duration comes from the physics, not a timer. `preset` (default `"default"`) selects the base or bouncy spring. Returns an animId.

### `cancelAnim`

```ts
function cancelAnim(animId: number): void
```

Stops a running animation by the id `animate`/`spring` returned.

---

## `@pocketjs/framework/lifecycle`

Component-scoped per-frame hooks. Registrations clean up with the selected
framework owner (`onCleanup` in Solid, `onScopeDispose` in Vue Vapor, effect
cleanup in Octane). In Octane builds these exports are the use-prefixed hooks
`useFrame`, `useButtonPress`, and `useSpriteAnimation` (see
[`octane`](#octane) above); the signatures below are otherwise identical. See
[Reactivity](/docs/reactivity/) and [Input & focus](/docs/input-focus/).

### `onFrame`

```ts
function onFrame(callback: (buttons: number) => void): void
```

Registers `callback` to run once per host frame with the current spec `BTN` bitmask.

### Analog input

```ts
function analogX(): number
function analogY(): number
function analogRaw(): number
```

`analogX` and `analogY` return the current left stick/nub axis in `-1..1`
after PocketJS's shared deadzone (`right` and `down` are positive).
`analogRaw` returns the host word `(x << 8) | y`, with each byte in `0..255`
and `128` at center. Stickless hosts stay centered, so controller fallbacks do
not need target checks. Solid, Vue Vapor, and Octane expose the same functions
from their lifecycle subpaths.

### `onButtonPress`

```ts
function onButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  opts?: ButtonPressOptions,
): void
```

Edge-detects a button: fires `callback` on the frame a button in `mask` transitions from up to down. `pressed` is the just-pressed bitmask; `buttons` is the full held mask.

**`ButtonPressOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `allowWhenBlocked` | `boolean` | `false` | Keep firing while a modal/system block owns input. |
| `active` | `boolean \| (() => boolean)` | `true` | Gate the handler on/off. |
| `latched` | `boolean` | `false` | Require the button to be observed released before the next edge can fire; prevents a held opener from re-triggering a newly mounted screen. |

### `createSpriteAnimation`

```ts
function createSpriteAnimation(
  frames: readonly string[],
  opts?: SpriteAnimationOptions,
): Accessor<string> | ComputedRef<string>
```

Cycles through `frames` (image `src` keys), returning a Solid `Accessor` or a
Vue Vapor `ComputedRef` for the current frame (the Octane hook,
`useSpriteAnimation`, returns the current frame key as a plain `string`).
Throws if `frames` is empty.
`opts.frameStep` (default `1`, min `1`) holds each sprite frame for that many
host frames.

### `pushButtonHandlerBlock`

```ts
function pushButtonHandlerBlock(): () => void
```

Pushes a global block so background `onButtonPress` handlers (those without `allowWhenBlocked`) stop firing; the returned disposer pops it. `Modal` uses this internally.

---

## `@pocketjs/framework/input`

Programmatic focus, the button bitmask, the touch snapshots, the virtual
cursor, and the imperative focus-scope/grid/controller stack. Prefer the
`FocusScope` / `FocusGrid` components in app code. The behavior these
signatures produce — the traversal order, the press and bubble model, refocus
on removal — is on [Input & focus](/docs/input-focus/).

### `BTN`

PSP button bitmask (identical on every host; web/Bun hosts remap keys).

| Member | Value | Member | Value |
| --- | --- | --- | --- |
| `SELECT` | `0x0001` | `LTRIGGER` | `0x0100` |
| `START` | `0x0008` | `RTRIGGER` | `0x0200` |
| `UP` | `0x0010` | `TRIANGLE` | `0x1000` |
| `RIGHT` | `0x0020` | `CIRCLE` | `0x2000` |
| `DOWN` | `0x0040` | `CROSS` | `0x4000` |
| `LEFT` | `0x0080` | `SQUARE` | `0x8000` |

### `touches` and `auxiliaryTouches`

```ts
interface TouchContact {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly surface: "primary" | "auxiliary";
  readonly hit?: number;
}
function touches(): readonly TouchContact[]
function auxiliaryTouches(): readonly TouchContact[]
```

Each function returns an immutable snapshot for one surface. Coordinates are
logical pixels in that surface, independent of the target raster density; at
most eight contacts are delivered across both snapshots. No active touch is an
empty snapshot, not an unavailable API. Declare `input.touch` for `touches()`
or `input.touch.auxiliary` plus `display.auxiliary` for
`auxiliaryTouches()`. Guard optional enhancements with `hasFeature()`.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `number` | Stable while the contact stays down; ids are reused after a release. |
| `x` / `y` | `number` | Logical viewport position in this surface. |
| `surface` | `"primary" \| "auxiliary"` | Which output's coordinate space the contact belongs to. |
| `hit` | `number \| undefined` | Down-edge hit fact: the node id the host bounds-resolved under the contact when it landed, carried unchanged until the contact lifts. |

`hit` is `0` when the host resolved the position and no node claimed it (a
contact on bare background, or off-screen edge cases), and `undefined` when
the host has no hit-fact channel at all — an older host, or a DevTools replay.
Hosts derive the fact from the bounds hit test; see
[Native contract](/docs/native-contract/) for the ops and the `frame()`
argument that carries them.

### `focusNode`

```ts
function focusNode(node: NodeMirror | null): void
```

Programmatically focus a node (or clear focus with `null`). Applies the native `focus:` style variant.

### `getFocused`

```ts
function getFocused(): NodeMirror | null
```

Returns the currently focused node, or `null`.

### `pushFocusScope`

```ts
function pushFocusScope(node: NodeMirror, opts?: FocusScopeOptions): () => void
```

Restricts d-pad traversal and CIRCLE to `node`'s subtree; returns a disposer that pops the scope and restores prior focus. Backs the `FocusScope` component.

**`FocusScopeOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `autoFocus` | `boolean` | `true` | Focus the first focusable on push. |
| `restoreFocus` | `boolean` | `true` | Restore the previously focused node on pop. |

### `pushFocusGrid`

```ts
function pushFocusGrid(node: NodeMirror, opts: FocusGridOptions): () => void
```

Gives `node`'s subtree row/column d-pad semantics; returns a disposer that pops the grid. Backs the `FocusGrid` component.

**`FocusGridOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `number` | — | Grid column count (min `1`). Required. |
| `wrap` | `boolean` | `false` | Wrap focus at row ends. |

### Virtual cursor

```ts
function enableCursor(opts?: CursorOptions): () => void
function cursorX(): number
function cursorY(): number
```

`enableCursor` replaces the d-pad focus walk with a pointer the analog nub
steers, and returns a disposer that restores the d-pad model. Calling it again
while enabled updates the options in place, and an unchanged `image` keeps the
texture it uploaded. A host predating the cursor ops keeps the d-pad model.
`cursorX` / `cursorY` read the position in logical px, `NaN` while the cursor
is disabled or before its first frame. Declare `input.cursor` in `requires` or
`enhances`. What changes on screen while it runs — hover as focus, the
press-and-drag-off model, the suppressed d-pad traversal — is on
[Input & focus](/docs/input-focus/#virtual-cursor).

**`CursorOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `image` | `string \| Uint8Array` | built-in 16×16 arrow | A pak IMG entry key, or a raw IMG entry blob. |
| `hotspot` | `[number, number]` | `[0, 0]` | The sprite pixel the position points at. |
| `size` | `[number, number]` | the texture's own size | Logical draw size. |
| `speed` | `number` | `240` | Travel in px per **virtual** second at full nub deflection, so a tape replays the same path at every rate: 240 is 4 px per frame on a 60 Hz bundle. |
| `dpadSpeed` | `number` | `0` | Steer with the d-pad at this px per virtual second while the nub is centered; `0` leaves the d-pad to the app. |
| `button` | `number` | `BTN.CIRCLE` | Mask that presses the hovered node. |
| `start` | `[number, number]` | viewport center | Initial position. |

### Hit testing and programmatic activation

```ts
function pressNode(node: NodeMirror): void
function setActiveNode(node: NodeMirror | null): void
function pushFocusController(
  node: NodeMirror,
  move: (direction: FocusDirection) => boolean,
): () => void
function hitFocusable(x: number, y: number): NodeMirror | null
function hitNode(x: number, y: number, surface?: "primary" | "auxiliary"): NodeMirror | null
```

`pressNode` focuses a node and fires its `onPress`, bubbling to the nearest
ancestor handler — the path a touch tap and a cursor click both take.
`setActiveNode` holds or clears the native `active:` variant through the one
latch every input mode writes, so a pressed look cannot strand when the mode
changes. `pushFocusController` gives a subtree custom d-pad traversal: while
focus is inside `node`, each navigation press calls `move` instead of grid or
linear traversal and a `false` return falls through to the default; the system
keyboard drives its variable-width key rows this way. `hitFocusable` resolves
a point to the nearest focusable inside the active focus scope — the filter
cursor hover and touch activation share. `hitNode` returns the topmost painted
node under a point with no focusable or scope filter, which is how the gesture
layer resolves region ownership. Both return `null` where the host mounts no
`hitTest` op.

---

## `@pocketjs/framework/gesture`

Recognizers over the per-frame touch snapshot: tap, long press, axis-lockable
pan, and two-contact pinch, plus the ownership model that decides which
recognizer keeps a contact when several want it. The recognizer machinery is
framework-neutral; Solid and Vue Vapor resolve their own `createGesture`
shim over it, and Octane builds do not resolve this subpath. The pump runs
once per frame from the framework entry, after effect delivery and before app
frame hooks, so app code always reads this frame's completed output. On a host
that delivers no contacts the recognizers never fire and cost nothing. See
[Touch & gestures](/docs/touch-gestures/).

### `createGesture` and `attachGesture`

```ts
function createGesture(opts: GestureOptions): GestureHandle
function attachGesture(opts: GestureOptions): GestureHandle
```

`attachGesture` registers a recognizer and returns its handle; it stays
registered until the caller calls `handle.dispose()`. `createGesture` makes the
same registration and hands disposal to the surrounding component scope —
`onCleanup` in Solid, `onScopeDispose` in Vue Vapor — so the recognizer
unregisters with the component that created it. Use `createGesture` inside
components and `attachGesture` when there is no component scope to own it.

**`GestureOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `surface` | `"primary" \| "auxiliary"` | `"primary"` | Output to observe. A recognizer only sees contacts on this surface. |
| `region` | `GestureRegion` | — | Where the recognizer takes ownership. Omit for a whole-screen recognizer. |
| `axis` | `"x" \| "y" \| "any"` | `"any"` | Pan axis lock, and the axis a pinch measures its span on. |
| `tapSlop` | `number` | `8` | Max total travel per axis, logical px, for the contact to count as a tap. |
| `panSlop` | `number` | `6` | Total travel, logical px, that starts a pan. |
| `pinchSlop` | `number` | `10` | Span change, logical px, that starts a pinch. |
| `longPressSeconds` | `number` | `0.5` | Hold duration in virtual seconds. The deadline is `max(1, round(longPressSeconds × simulationHz()))` virtual frames, so it holds the same wall time at every rate. |
| `allowWhenBlocked` | `boolean` | `false` | Keep observing while a `pushTouchBlock` is held. |
| `onDown` | `(c: GestureContact) => void` | — | Contact landed inside the region. |
| `onMove` | `(c: GestureContact) => void` | — | Contact moved this frame, panning or not. |
| `onUp` | `(c: GestureContact) => void` | — | Contact released. |
| `onCancel` | `(c: GestureContact) => void` | — | Another owner claimed the contact, a touch block was pushed, or the handle was disposed or cancelled. |
| `onTap` | `(c: GestureContact) => void` | — | Released within `tapSlop` with nothing claimed and no long press fired. |
| `onLongPress` | `(c: GestureContact) => void` | — | Held past the deadline within `tapSlop`. Fires once, then claims. |
| `onPanStart` | `(c: GestureContact) => void` | — | Travel crossed `panSlop` on the locked axis. Claims the contact. |
| `onPanMove` | `(c: GestureContact) => void` | — | Every frame while panning, including hold frames where `fdx`/`fdy` are `0`. |
| `onPanEnd` | `(c: GestureContact) => void` | — | Released while panning; `c.vx`/`c.vy` is the fling velocity. |
| `onPinchStart` | `(p: GesturePinch) => void` | — | Span change beat `pinchSlop` and dominated the centroid's travel. Claims both members. |
| `onPinchMove` | `(p: GesturePinch) => void` | — | Every frame while pinching, including hold frames where `fdspan` is `0`. |
| `onPinchEnd` | `(p: GesturePinch) => void` | — | A member released, was cancelled, or the handle was disposed; `p` carries the final geometry. |

An `axis` lock rejects cross-axis movement rather than killing the contact:
while the recognizer is unclaimed the axis test is re-evaluated every frame, so
a thumb that lands with wobble still pans once its intended axis dominates, and
a drag whose dominant axis never matches never pans on that recognizer.

A pan and a pinch on the same recognizer both need handlers to run: the pan
pass skips a recognizer with no `onPanStart`/`onPanMove`/`onPanEnd`, and the
pinch pass skips one with no `onPinchStart`/`onPinchMove`/`onPinchEnd`.

**`GestureContact`**

| Field | Type | Description |
| --- | --- | --- |
| `surface` | `"primary" \| "auxiliary"` | Output whose coordinate space holds this contact. |
| `id` | `number` | Stable while the contact is down; ids are reused after a release. |
| `x` / `y` | `number` | Current position, logical viewport px. |
| `startX` / `startY` | `number` | Position at the down edge. |
| `dx` / `dy` | `number` | Total travel since the down edge. |
| `fdx` / `fdy` | `number` | Travel this frame — what a finger-follow drag consumes. |
| `vx` / `vy` | `number` | Velocity in logical px per **virtual** second, estimated over a 3-frame window; on the release frame this is the fling velocity. |
| `downFrame` | `number` | `virtualFrame()` at the down edge. |
| `frames` | `number` | Frames since the down edge (`0` on the down frame). |
| `hit` | `number \| undefined` | The down edge's [`TouchContact.hit`](#touches-and-auxiliarytouches) fact, carried for the contact's lifetime. |

Velocity is an integer position delta over `k` fixed-length frames with one
IEEE division per axis, so the same contact path produces the same number on
every host.

**`GesturePinch`**

| Field | Type | Description |
| --- | --- | --- |
| `ax` / `ay` | `number` | First member's current position, logical viewport px. |
| `bx` / `by` | `number` | Second member's current position. |
| `cx` / `cy` | `number` | Centroid of the two members. |
| `span` | `number` | Distance between the members, projected onto the recognizer's locked axis; Euclidean when `axis` is `"any"`. |
| `startSpan` | `number` | The span when the pair formed, before the slop was crossed. |
| `dspan` | `number` | `span - startSpan`; positive when the members moved apart. |
| `fdspan` | `number` | Span change this frame — what an opening gap consumes. |

**`GestureRegion`**

| Field | Type | Description |
| --- | --- | --- |
| `node` | `() => NodeMirror \| null \| undefined` | Own contacts whose down-edge hit lands inside this node's subtree. |
| `rect` | `() => { x, y, w, h } \| null \| undefined` | Logical-px geometry: the fallback when the hit misses, and the whole test when no `node` is given. |

Both are getters, read at the down edge. Returning `null` from the getter (or
supplying neither) means the recognizer owns nothing that frame, which is how
a recognizer is switched off without disposing it.

The down edge is resolved once and shared across every recognizer: the host's
`hit` fact is used when the frame carried one, otherwise a single query through
`hitTestBounds` when the host has it and `hitTest` otherwise. A resolution that
lands **outside** the subtree fails the match and never falls through
to `rect` — ink painted above the region occludes it. A resolution that hits
nothing falls through to `rect`, so gaps between rows still reach a list's pan
recognizer.

**`GestureHandle`**

| Member | Type | Description |
| --- | --- | --- |
| `dispose()` | `() => void` | Cancel in-flight contacts, end an in-flight pinch, and unregister. |
| `cancel()` | `() => void` | Force-cancel this recognizer's in-flight contacts (fires `onCancel`) without unregistering. |
| `panning` | `boolean` | True while any contact is mid-pan under this recognizer. |
| `pinching` | `boolean` | True while a pinch is in flight under this recognizer. |

### `pushTouchBlock`

```ts
function pushTouchBlock(): () => void
```

The touch mirror of [`pushButtonHandlerBlock`](#pushbuttonhandlerblock).
Pushing cancels the in-flight contacts of every recognizer without
`allowWhenBlocked` inside the call, so those owners see `onCancel` on this
frame rather than a release later, and suppresses new downs for them while
the block is held; the returned disposer pops it. Recognizers with
`allowWhenBlocked` keep observing. Blocks nest, and the depth only reaches zero when every
disposer has run. The system keyboard pushes one for its own panel; `Modal`
pushes the button block only.

### Ownership

These rules decide which recognizer keeps a contact when several observe it.

- **Owners are resolved at the down edge.** Every non-disposed recognizer whose
  `surface` and `region` match the contact becomes an owner and observes
  `onDown`, `onMove` and `onUp`.
- **Priority is registration order, last registered first.** Mount order is
  deterministic, so priority is too. A component registering a richer touch
  model after mount outranks anything registered before it.
- **A claim cancels every other owner.** A pan crossing `panSlop`, a long press firing,
  or a pinch forming claims the contact for that recognizer, and every other
  owner of that contact receives `onCancel`. A pinch claims both its members at
  once.
- **Cancellation is terminal for that contact.** A cancelled recognizer
  observes nothing further from it — no `onMove`, no `onUp`, no `onTap` — until
  the contact lifts and a new one lands.
- **Tap and long press single-fire.** Each resolves on the highest-priority
  owner that carries the handler, and no lower-priority owner sees it. Tap
  death is per-owner: each recognizer applies its own `tapSlop`.
- **The pinch pass runs before the pan pass.** Two diverging contacts become a
  pinch even when each alone would satisfy a pan. Two contacts travelling
  together, with the span steady and the centroid moving, stay available to the
  pan recognizers. The pair a recognizer measures is the first two unclaimed
  contacts it still observes.
- **Contact and pinch objects are pooled and mutable.** They are valid only for
  the duration of the callback. Never retain one across frames or store it in
  state; copy the numbers you need.

---

## `@pocketjs/framework/kinetics`

A one-axis kinetic scroller: finger-follow tracking with a rubber-banded
overscroll, an exponential-decay fling, an edge spring that carries the
incoming velocity, a per-frame chase for d-pad and stick-to-bottom scrolling,
and a programmatic tween. The state machine is framework-neutral; the Solid
shim binds the offset to a signal and the Vue Vapor shim to a `shallowRef`, and
Octane builds do not resolve this subpath. See
[Touch & gestures](/docs/touch-gestures/).

The physics are fixed platform literals, not app knobs: the decay rates
(`0.998/ms` and `0.99/ms`, pre-baked per tick), the `0.55` rubber-band
coefficient, the `K = 170` / `C = 26` edge spring, and the chase pump's `0.3`
rate all live in the module. Fling and spring integrate per **core tick**, so a
30 Hz host follows the 60 Hz trajectory subsampled; chase advances once per
frame by design. Every formula is `+ − * /` over literals, so trajectories are
bit-identical on every host.

### `createScroller`

```ts
function createScroller(opts: ScrollerOptions): Scroller
```

Creates a scroller whose `offset` is a reactive cell of the active framework.
Bind `translateY: -s.offset()` on the content canvas — a translate is
paint-only, one `setProp` per moving frame with no relayout — and call
`s.step()` once per frame from `onFrame`. Nothing advances without that pump.

**`ScrollerOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max` | `() => number` | — | Range end; for a list that scrolls its content, `max(0, contentH - viewH)`. Read on every step, so a growing list needs no re-registration. Required. |
| `extent` | `() => number` | screen height | Viewport extent, which is the rubber band's asymptote. |
| `initial` | `number` | `0` | Starting offset. |
| `overscroll` | `number` | `48` | Cap on rubber-band travel in px; `0` hard-clamps at the edges. |
| `decay` | `"normal" \| "fast"` | `"normal"` | Fling decay preset: `"normal"` is the iOS `0.998/ms` rate, `"fast"` the `0.99/ms` paging rate. |
| `snap` | `((projectedRest: number, velocity: number) => number) \| null` | `null` | Applied at `endDrag` instead of a fling: receives the projected rest position and the release velocity, returns the position to tween to. This is how paging and row alignment are built. |
| `onSettle` | `(offset: number) => void` | — | A moving state reached rest. The settled offset is rounded to 1/64 px so settled framebuffers hash to the same value. |

**`ScrollerState`**

```ts
type ScrollerState = "idle" | "tracking" | "fling" | "spring" | "chase" | "tween"
```

`tracking` is finger-follow, `fling` the decay from a release velocity,
`spring` the edge bounce-back (entered mid-fling when a fling crosses an edge,
carrying its momentum), `chase` the per-frame ease toward a target, `tween` a
programmatic `scrollTo`, and `idle` at rest.

**`Scroller`**

| Member | Signature | Description |
| --- | --- | --- |
| `offset` | `() => number` | Current offset in logical px. Reactive. |
| `velocity` | `() => number` | Instantaneous velocity in px per virtual second; meaningful in `fling` and `spring`. |
| `state` | `() => ScrollerState` | The current state. |
| `beginDrag` | `() => void` | Enter finger-follow. Wire to a pan start. |
| `drag` | `(deltaPx: number) => void` | Content-space delta for **this** frame; a vertical list passes `-c.fdy`. |
| `endDrag` | `(releaseVelocity: number) => void` | Release; a vertical list passes `-c.vy`. Decides between fling, edge spring, `snap`, and settling in place. |
| `scrollTo` | `(to: number, opts?: { durMs?: number } \| { immediate: true }) => void` | Programmatic scroll, tweening over 200 ms by default. |
| `scrollBy` | `(delta: number, opts?: { durMs?: number } \| { immediate: true }) => void` | Same, relative to the in-flight target when one exists. |
| `stop` | `() => void` | Freeze in place. No settle callback. |
| `nudge` | `(delta: number) => void` | Move the chase target by a delta — the d-pad and analog primitive. |
| `chaseTo` | `(to: number) => void` | Chase an absolute target (focus-follow, stick-to-bottom). |
| `rebase` | `(delta: number) => void` | Shift the offset **and** every in-flight anchor by `delta`. |
| `intent` | `() => number` | Where the scroller is heading: the chase or tween target when one is in flight, the current offset otherwise. |
| `isAtEnd` | `(slackPx?: number) => boolean` | Whether the range end is reached, judged on `intent()` rather than the current position. `slackPx` defaults to `1`. |
| `projectFling` | `(v: number) => number` | Rest position a fling from `v` would reach. Use it inside a `snap` function. |
| `step` | `() => void` | Advance one frame. Call once per frame from `onFrame`. |

`rebase` exists for prepends. Shifting only the offset would leave a drag
position, a chase target, a spring bound, or a tween's endpoints pointing at
pre-prepend coordinates; `rebase` moves all of them together, so backfilling
content above the viewport never moves what the reader is looking at, even
mid-fling.

### `bindDpadScroll`

```ts
function bindDpadScroll(s: Scroller, opts?: DpadScrollOptions): void
```

Registers an `onFrame` hook that turns held UP/DOWN and the analog stick into
`nudge` calls against the scroller's chase target. The caller still owns
`step()`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `stepPx` | `number` | `6` | Px per held frame of UP/DOWN. |
| `nubPx` | `number` | `10` | Px per frame at full analog deflection. |
| `active` | `() => boolean` | always on | Gate the hook, for example `() => !osk.isOpen()`. Raw button reads are not muted by a touch or button block. |

---

## `@pocketjs/framework/platform`

```ts
const platform: {
  readonly target: string;
  readonly pixelRatio: number;
  readonly features: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;
};
function hasFeature(feature: PocketCapabilityId): boolean
```

The manifest compiler defines the target-specific constants consumed by this
module. `pixelRatio` is
physical raster samples per logical pixel (`1` on PSP, `2` on Vita), useful for
runtime-created textures; it never changes layout coordinates. Literal
`hasFeature("…")` calls are folded to booleans during the PocketJS compile, so
an unavailable enhancement branch can leave the bundle. Computed ids use the
frozen runtime map.

## `@pocketjs/framework/modality`

```ts
const modality: Modality;
const presentation: string;
function screen(role?: "primary" | "auxiliary"): ScreenModality | undefined
function surfaceHasTouch(surface?: "primary" | "auxiliary"): boolean
function supports(requirement: ModalityRequirement): boolean
function glyph(button: "circle" | "cross" | "triangle" | "square" | "start" | "select" | "ltrigger" | "rtrigger"): string
```

`modality` is the target's interaction structure the plan resolved
(`screens`, `touch`, `pointer`, `buttons`, `analog`, `text`, `glyphs`,
`form`; see [Platform contracts](/docs/platform-contracts/#presentations-and-modality)),
frozen. `presentation` is the manifest presentation id this bundle compiles,
`"default"` for the baseline entry. `screen("auxiliary")` is `undefined` on a
single-screen target. `supports()` evaluates a manifest-shaped requirement
against `modality`. `glyph("circle")` is `"○"` on a PSP or Vita and `"A"` on a
3DS, so hint text names the button the shell prints. A bundle built without a
plan reads the portable PSP modality.

## `@pocketjs/framework/actions`

```ts
function useActions(actions: ActionMap | (() => ActionMap), options?: { allowWhenBlocked?: boolean }): {
  legend: () => string;
  entries: () => readonly ActionEntry[];
  run(intent: ActionIntent): void;
}
```

`ActionMap` maps intents (`confirm`, `back`, `action`, `option`,
`sectionPrev`, `sectionNext`, `media`) to `{ label?, run?, hold?, when? }`.
On a device with buttons each intent is bound to one face button
(`ACTION_BUTTONS`: ○ × △ □ L R START) for the component's lifetime, and
`legend()` spells the labelled intents with the device's glyphs, so one
declaration renders `○ play · △ search` on a PSP and `A play · X search` on a
3DS. An intent with a label and no `run` appears in the legend while the
focus system delivers the press. `hold` fires after `HOLD_SECONDS` of holding
the button and silences the tap. Bindings respect the button-handler block a
keyboard or sheet pushes. On a device without buttons `legend()` is empty and
nothing binds; `entries()` still lists the intents for touch controls.

## `@pocketjs/framework/system`

```ts
function installSystemLayer(options: {
  title: string; version?: string;
  status?: () => string;
  items?: () => readonly { label: string; run: () => void; disabled?: boolean }[];
  surface?: "primary" | "auxiliary";
}): { open(): void; close(): void; isOpen: () => boolean }
```

The system layer of `docs/HIG.md` §4 in its guest-side form. **Holding SELECT
for `SYSTEM_HOLD_SECONDS` opens the system sheet** over the chosen surface:
the application's title and version, the live `status` line, the `items` the
application registers for the moment (a playing screen adds "Stop
playback"), "Return to launcher" where the host switches guests, and Close.
The sheet is modal: it pushes the button-handler block and the touch block,
its rows are Focusables (d-pad and tap), and × or SELECT closes it. No
application binds SELECT itself.

## `@pocketjs/framework/classic`

The bezelled light chrome every classic presentation shares (`docs/HIG.md`):
`ClassicBar` (36 px title bar with title, trailing text and absolute
children), `ClassicFooter` (24 px legend strip), `ClassicList` (a
`VirtualList` with flush rows, the `ClassicSelection` wash on the focused
row, a trailing loading row that requests the next page for the d-pad and
for a scrolling finger, and a per-frame `onWindow(first, visible, velocity)`
report for row prefetching), `ClassicSelection`, `ClassicSpinner` (eight bars,
no textures), `ClassicSkeleton`, `ClassicButton`, `ClassicFace`,
`ClassicPanel`, `ClassicSheet`, and the `CLASSIC` color tokens.

## `@pocketjs/framework/clock`

| Export | Purpose |
| --- | --- |
| `simulationHz()` | Active virtual-frame rate selected by the host. |
| `ticksPerFrame()` | Exact core ticks advanced per virtual frame. |
| `virtualFrame()` | Deterministic frame index. |
| `virtualNow()` | Virtual seconds since boot. |
| `after(seconds, callback)` | Schedule on the virtual clock; returns a disposer. |

Use these instead of wall-clock timers for deterministic app behavior: the
same elapsed virtual time produces the same trajectory at every rate.

**The tick rate is declared per realm and baked per bundle, not fixed at 60.**
`tools/build.ts` writes it in from `--hz=N` — an integer from 1 through 240,
default 60 — and the core takes it through `set_tick_rate` before the first
tick (`MAX_TICK_HZ` is 240 in `engine/core/src/lib.rs`). `simulationHz()` is
the host-selected virtual-frame rate and is a divisor of the baked rate, which
is what makes `ticksPerFrame()` a whole number. A native mount whose
`ui.__tickHz` disagrees with the baked rate throws before anything renders
(`assertNativeHostContract`, `framework/src/host.ts`): a bundle runs at the
rate it was built for and no other.

## `@pocketjs/framework/effects`

```ts
type EffectDriver = (command: EffectCommand, deliver: (result: unknown) => void) => void;
function installEffectDriver(driver: EffectDriver): void
function runEffect<T>(kind: string, payload: unknown, onResult: (result: T) => void): number
```

`runEffect` emits an outside-world command; its driver can complete at any
time, but PocketJS delivers the result only at the next frame boundary. This
callback surface keeps promise and microtask timing out of deterministic
journeys. A host-injected `globalThis.__pocketEffectDriver` overrides the app
driver for replay and simulation.

## `@pocketjs/framework/net`

A bounded HTTP client over the host's `net` namespace. Declare `net.http` in
the manifest's `requires`; where no host mounts the module every call rejects
with code `unavailable`.

```ts
import { fetch } from "@pocketjs/framework/net";

const response = await fetch("https://api.example.com/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Pocket" }),
  timeoutMs: 5_000,
  maxBytes: 64 * 1024,
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = await response.json();
```

```ts
function fetch(url: string, options?: FetchOptions): Promise<PocketResponse>
```

`url` must be an absolute `http://` or `https://` URL. `options.method` is one
of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` (default `GET`;
`GET` and `HEAD` reject a body), `options.body` a string, `Uint8Array`, or
`ArrayBuffer`, and header names are lower-cased and rejected when malformed.
`PocketResponse` carries `status`, `ok`, `url`, `headers`, `byteLength`, and
the buffered reads `text()`, `json()`, `bytes()`, `arrayBuffer()`.

The response is whole-body — the promise resolves once the body is complete
and holds it — so the omitted surface is streams, cookies, cache, `Request`,
`Headers`, `AbortSignal`, WebSocket, servers, and raw sockets.

| Resource | Limit |
| --- | ---: |
| Concurrent requests | 2 |
| Request body | 64 KiB |
| Response body | 128 KiB default, 256 KiB maximum |
| Headers | 32 fields / 8 KiB |
| Timeout | 30 s default, 120 s maximum |
| Redirects | 3 |

A fetch settles at a tick boundary and never inside a native callback: the
first pending request registers a service pump that makes one `net.poll()`
call per tick and settles the whole batch that call returns, and the last
completion removes the pump. An HTTP status never rejects — a 404 resolves
with `ok === false`. A transport failure rejects with a `NetError` whose
`code` is one of `unavailable`, `invalid_request`, `busy`, `dns`, `connect`,
`tls`, `timeout`, `redirect`, `response_too_large`, `protocol`, `cancelled`,
`other`.

---

The two data modules mount their own namespaces beside `ui` (`globalThis.db`,
`globalThis.fs`). Every op is synchronous and completes inside the guest's
turn: no events, no clock, no promises. Names and paths resolve under the
app's own data root, and the vocabulary cannot spell another app's tree or an
absolute path. Absence is not a no-op — every entry point throws where the
namespace is unmounted, so declare `data.sqlite` or `data.fs` in the
manifest's `requires` and let admission catch a missing module before the app
runs.

## `@pocketjs/framework/db`

SQLite in the `bun:sqlite` shape, so code written against Bun's built-in
driver runs against the mounted module unchanged.

```ts
import { Database } from "@pocketjs/framework/db";

const db = new Database("notes.sqlite");
db.exec("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT)");

const insert = db.query("INSERT INTO note (body) VALUES (?)");
db.transaction(() => {
  insert.run("first");
  insert.run("second");
})();

for (const row of db.query("SELECT id, body FROM note").all()) {
  console.log(row.id, row.body);
}
```

| Member | Signature | Description |
| --- | --- | --- |
| `new Database` | `(name?: string)` | Open or create a database under the app's data root; the default is `":memory:"` (`DB_MEMORY`). Throws where `globalThis.db` is unmounted or the host refuses the name. |
| `query` | `(sql: string) => Statement` | A `Statement` cached on this `Database` by SQL text. The prepared handle is host-side and keyed by the same string, so there is nothing to finalize and no handle to leak. |
| `prepare` | `(sql: string) => Statement` | The uncached spelling. |
| `run` | `(sql: string, params?: SqlParams) => RunResult` | One statement for effect, through the cache. |
| `exec` | `(sql: string) => void` | One or more statements with no parameters and no result rows — the schema and migration path. |
| `transaction` | `(fn: (...args) => R) => (...args) => R` | Wraps `fn` in `BEGIN`/`COMMIT`, `ROLLBACK` on throw; a nested call becomes a `SAVEPOINT`. Returns the wrapped function — call it. |
| `close` | `() => void` | Drop the cached statements and close the handle. |

A `Statement` takes positional values (`stmt.all(1, "x")`), one array, or one
named-parameter object, and reads back through `get()` (first row as a
column-keyed object, or `null`), `all()` (every row as objects), `values()`
(every row as an array in column order), or `run()`
(`{ changes, lastInsertRowid }`). `columnNames` holds the last execution's
columns and is empty before the first run.

A cell or a bound value is `null`, a number, a string, a boolean, or a
`Uint8Array` for a `BLOB`. **An integer whose magnitude exceeds
`DB_MAX_SAFE_INTEGER` (2^53 − 1) throws instead of losing precision**, and a
non-finite number throws the same way — store money in cents.

## `@pocketjs/framework/fs`

Files in the Bun shape — `file(path)` plus the `node:fs` sync subset Bun
implements — over the nine-op `fs` spec (`read`, `write`, `remove`, `list`,
`stat`, `mkdir`, `rename`, `usage`, `lastError`). Every call is synchronous,
and `await` on a plain value unwraps it, so `await file(p).text()` and
`await write(p, data)` both run here.

```ts
import { file, write, readdirSync } from "@pocketjs/framework/fs";

write("saves/slot1.json", JSON.stringify(state));
if (file("saves/slot1.json").exists()) restore(file("saves/slot1.json").json());
for (const name of readdirSync("saves")) console.log(name);
```

| Export | Signature | Description |
| --- | --- | --- |
| `file` | `(path: string) => PocketFile` | A lazy handle; nothing is read until a method runs. |
| `PocketFile` | `.size`, `.exists()`, `.bytes()`, `.text()`, `.json()`, `.delete()` | `size` is `0` for a missing file (Bun's behavior); `exists()` is true only for a file. |
| `write` | `(path, data: string \| Uint8Array) => number` | Replace the file, creating parent directories. Returns bytes written. |
| `usage` | `() => { usedBytes: number; quotaBytes: number }` | The app's storage footprint and budget; `quotaBytes: 0` is unmetered. |
| `readFileSync` | `(path, encoding?: "utf8") => Uint8Array \| string` | Bytes, or a string with `"utf8"`. |
| `writeFileSync` / `appendFileSync` | `(path, data) => void` | Truncating and appending writes. |
| `mkdirSync` | `(path) => void` | Recursive and idempotent: every missing ancestor is created. |
| `readdirSync` | `(path, options?: { withFileTypes: true }) => string[] \| DirEntry[]` | Names, or `{ name, kind, size, isFile(), isDirectory() }` entries. |
| `rmSync` | `(path, options?: { recursive?: boolean; force?: boolean }) => void` | `recursive` removes a tree; `force` swallows "not found". |
| `renameSync` | `(from, to) => void` | Move within the data root. |
| `statSync` | `(path) => { size, isFile(), isDirectory() }` | Throws where the path does not exist. |
| `existsSync` | `(path) => boolean` | True for a file or a directory. |

A path carries at most `FS_MAX_DEPTH` (8) segments, 64 bytes per segment and
160 bytes in total. The SDK chunks reads and writes at `FS_MAX_IO_BYTES`
(64 KiB), so a file's size is bounded by storage and any host quota rather
than by the marshaling ceiling.

## `@pocketjs/framework/audio`

Streams s16 PCM to the host's `audio` namespace on a credit budget. Declare
`audio.pcm` in the manifest. Where no host mounts the module every player call
is a no-op and the app's tick-driven UI stays byte-identical, so an audio
enhancement needs no branch around it.

```ts
import { createWavPlayer } from "@pocketjs/framework/audio";
import { onFrame } from "@pocketjs/framework/lifecycle";

const player = createWavPlayer();
player.load("theme"); // the pak entry audio:wav.theme
player.play();
onFrame(() => player.pump());
```

**`pump()` must be called once per frame from the app's `onFrame`.** It drains
the tick's event batch — the host's credit, underrun, and ended events — then
refills the ring with at most one `writePcm` inside the credit the host
granted, which is what keeps a frame's hot path free of host queries. Nothing
plays without it: a track played before its first feed opens the tap inside
the first `pump()` that pours into it.

| Export | Signature | Description |
| --- | --- | --- |
| `decodeWav` | `(bytes: Uint8Array) => WavPcm` | Parse RIFF/WAVE into `{ sampleRate, channels, frames, data }`. Throws on anything but 16-bit PCM, mono or stereo, at a rate in `AUDIO_RATES`. |
| `createWavPlayer` | `() => WavPlayer` | A player holding one track at a time. |

`WavPlayer` is `load(name)` (a pak `audio:wav.<name>` entry) or
`loadPcm(pcm)`, `play()`, `pause()`, `toggle()`, `stop()` (flush the ring and
rewind to frame 0), `setVolume(0..1)`, `pump()`, `playing()`,
`positionFrames()`, `durationFrames()`, `stats()` (`{ underruns }`), and
`dispose()`.

## `@pocketjs/framework/launcher`

The guest side of whole-app switching on hosts that embed several bundles,
over spec ops 39–41 (`appTable`, `appLaunch`, `appShot`). A single-app host
omits the ops and each function degrades, so a launcher bundle stays
admissible anywhere and renders its empty state.

| Export | Signature | Description |
| --- | --- | --- |
| `launcherActive` | `() => boolean` | Whether the active host can switch apps. |
| `appTable` | `() => AppTable \| null` | `{ apps: { output, id, title }[], current, resume }` in registry order; `null` without the op. `current` is the running bundle's output name; `resume` is the app the last SELECT summon interrupted, `null` after a cold boot or an explicit launch. |
| `launchApp` | `(output: string) => boolean` | Request a whole-guest switch; the host swaps after the current frame presents. `false` for an unknown output or a host without switching. |
| `frozenShot` | `() => number` | Texture handle of the frame the summon froze (256×128 PSM_8888), `-1` when none was captured. Bind it with `registerTexture(key, handle)` and draw it as `<Image src={key}>`. |

Resuming is `launchApp(resume)`, a fresh relaunch — this protocol has no
suspend.

## `@pocketjs/framework/hot`

```ts
function text(node: NodeMirror | undefined, value: string | number): void
function prop(node: NodeMirror | undefined, name: PropName, value: number): void
```

An imperative, last-value-gated escape hatch for high-frequency HUD updates.
Do not bind the same value reactively as well. Prefer paint-only transforms to
layout properties and keep hot text inside a fixed-size cell.

## `@pocketjs/framework/manifest`

This is the stable build/custom-host boundary:

| Export | Purpose |
| --- | --- |
| `POCKET_MANIFEST_SCHEMA_ID` / `POCKET_MANIFEST_VERSION` | Canonical format-2 identity. |
| `pocketManifestV2Schema` / `validatePocketManifest` | Strict schema and structured diagnostics. |
| `extractHostBuildInputs(plan, options?)` | Verify a plan checksum and project it onto stable native-host inputs. |
| `hostBuildEnvironment(inputs, options)` | Produce the target-neutral Cargo environment for a custom host. |
| `vitaTitleId(applicationId)` | Deterministically derive a stable Vita Title ID. |

The complete `ResolvedBuildPlan` is internal build IR. Custom hosts should
consume `HostBuildInputs` rather than retaining or reinterpreting the plan.
See [Platform contracts](/docs/platform-contracts/).

---

Try any of these live in the [playground](/playground/), or start from [Getting started](/docs/getting-started/).
