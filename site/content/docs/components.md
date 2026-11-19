# Components

Everything you render in a PocketJS app is built from a tiny set of components,
all imported from a single entry point:

:::framework-code
```tsx solid
import { Show, For, Index, Switch, Match } from "solid-js";
import { View, Text, Image } from "@pocketjs/framework/components";
```

```tsx vue-vapor
import { ref, computed, onMounted } from "vue";
import { View, Text, Image } from "@pocketjs/framework/components";
```

```tsx octane
import { useState, useEffect, useMemo } from "octane";
import { View, Text, Image } from "@pocketjs/framework/components";
```
:::

`View`, `Text`, and `Image` play the roles their React Native namesakes do, and
this page covers those three. `@pocketjs/framework/components` exports one more
host primitive: `Sprite`, which draws an animation from a baked atlas the Rust
core cycles per vblank. Its signature is in the
[API reference](/docs/api/#primitives).

Solid apps import control-flow helpers (`Show`, `For`, `Index`, `Switch`,
`Match`) from `solid-js`; Vue Vapor apps use Vue's own JSX and Composition API
from `vue`; Octane apps use hooks from `octane` with plain JSX ternaries and
keyed `array.map`. Higher-level app-shell primitives (`Screen`, `Focusable`,
`Modal`, and friends) build on `View` and are covered on the
[App shell](/docs/app-shell/) page.

The capitalized names are the public API. Under them the renderer targets **three
lowercase host tags — `view`, `text`, and `image`** (`NODE_TYPE` in
`contracts/spec/spec.ts`): `Sprite` renders on an `image` node. `createElement`
throws `unknown element <tag> - only view/text/image exist` for any other
tag, and the tags are not declared as JSX intrinsics, so `<view>` in app code
fails typecheck. Use the capitalized components.

## View

`View` is the only container primitive. It lays out its children with flexbox
(via [taffy](/docs/architecture/)), carries styling, and can take focus and
input.

```tsx
<View class="flex-row items-center gap-3 p-5 bg-slate-50">
  <Image class="w-10 h-10 rounded-lg" src="logo.png" />
  <View class="flex-col">
    <Text class="text-base text-slate-950 font-bold">PocketJS</Text>
    <Text class="text-xs text-slate-500">RUST + SCEGU</Text>
  </View>
</View>
```

A `View` becomes interactive by adding `focusable` and an `onPress` handler.
`onPress` fires when the node is activated: CIRCLE while it is focused, a tap
on a touch host, or a cursor click (see [App shell](/docs/app-shell/)):

:::framework-code
```tsx solid
<View
  class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500 active:bg-blue-700"
  focusable
  onPress={() => setCount(count() + 1)}
>
  <Text class="text-base text-white font-bold">Press Circle</Text>
</View>
```

```tsx vue-vapor
<View
  class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500 active:bg-blue-700"
  focusable
  onPress={() => {
    count.value++;
  }}
>
  <Text class="text-base text-white font-bold">Press Circle</Text>
</View>
```

```tsx octane
<View
  class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500 active:bg-blue-700"
  focusable
  onPress={() => setCount(count + 1)}
>
  <Text class="text-base text-white font-bold">Press Circle</Text>
</View>
```
:::

A node needs `focusable` to take focus, but not to hold the handler: CIRCLE
fires the focused node's `onPress` and, when the focused node has none, walks up
to **the nearest ancestor with a handler** (`firePressFrom` in
`framework/src/input.ts`). Touch taps and cursor clicks enter through the same
walk. See [Input & focus](/docs/input-focus/) for how focus moves between nodes.

## Text

`Text` renders type. A `<Text>` lays out its string children as **one inline
run** — a single measured line, not N separate flex items — so you can freely
mix static text and reactive expressions:

:::framework-code
```tsx solid
<Text class="text-sm text-slate-600">Count: {count()}</Text>
```

```tsx vue-vapor
<Text class="text-sm text-slate-600">Count: {count.value}</Text>
```

```tsx octane
{/* Octane: mixed static + dynamic text is ONE template literal. */}
<Text class="text-sm text-slate-600">{`Count: ${count}`}</Text>
```
:::

`Count: ` and the reactive value are concatenated and measured together. When
the signal/ref changes, only the text content is updated (via the native
`replaceText` op); no relayout happens unless the measured width actually
changes.

### Text style inheritance

Text nodes inherit their resolved text style — font slot, color, tracking,
alignment — from the nearest ancestor that sets text props. In practice this
means you put text utilities (`text-*`, `font-bold`, `tracking-wide`, …) on the
`<Text>` element itself:

```tsx
<Text class="text-4xl text-slate-950 font-bold">JSX at 60 FPS.</Text>
```

The available text sizes, weights, colors and alignment utilities are baked at
build time — see [Styling](/docs/styling/) for the set. Sizes map to baked font-atlas slots (12 / 14 / 16 / 18 / 20 /
24 / 36 px), so only the sizes you actually use are packed into the app.

### Empty text and layout

An empty text node — for example the placeholder Solid emits for a `<Show>`
that is currently `false` — is excluded from layout entirely. It contributes no
width, no height, and no gap. It re-enters layout the moment it becomes
non-empty. This is why toggling a `<Show>` inside a `gap-N` row does not leave a
phantom gap where the hidden element used to be.

## Image

`Image` draws a baked texture. Its `src` is a **name**, not a path or URL: at
build time the pipeline scans your `src` strings, packs the referenced images
into the app's `.pak`, and the renderer resolves the name to the uploaded
texture at runtime.

```tsx
<Image class="w-10 h-10 rounded-lg shadow" src="logo.png" />
```

Set the drawn size with box utilities (`w-10 h-10` above); the class controls
layout, `src` controls pixels. `src` is reactive — assigning a new name swaps
the texture in place (via `setImage`), which is exactly how sprite animation
works:

:::framework-code
```tsx solid
import { createSpriteAnimation } from "@pocketjs/framework/lifecycle";

const frame = createSpriteAnimation(
  ["spinner-00.svg", "spinner-01.svg", "spinner-02.svg"],
  { frameStep: 3 },
);

<Image class="w-10 h-10" src={frame()} />;
```

```tsx vue-vapor
import { createSpriteAnimation } from "@pocketjs/framework/vue-vapor/lifecycle";

const frame = createSpriteAnimation(
  ["spinner-00.svg", "spinner-01.svg", "spinner-02.svg"],
  { frameStep: 3 },
);

<Image class="w-10 h-10" src={frame.value} />;
```

```tsx octane
import { useSpriteAnimation } from "@pocketjs/framework/octane/lifecycle";

// Inside a component — useSpriteAnimation is a hook:
const frame = useSpriteAnimation(
  ["spinner-00.svg", "spinner-01.svg", "spinner-02.svg"],
  { frameStep: 3 },
);

<Image class="w-10 h-10" src={frame} />;
```
:::

`Image` takes no children. See the [Build pipeline](/docs/build-pipeline/) for
how images become pak textures.

## Props

Each primitive has a small, explicit prop interface. `ViewProps`, `TextProps`,
and `ImageProps` are exported from `@pocketjs/framework/components` for typing your
own wrapper components.

| Prop        | `View` | `Text` | `Image` | Type                                       | Notes |
|-------------|:------:|:------:|:-------:|--------------------------------------------|-------|
| `class`     |   ✓    |   ✓    |   ✓     | `string`                                   | Compiled Tailwind-subset class string. Vue Vapor and Octane also accept `className`. |
| `style`     |   ✓    |   ✓    |   ✓     | `Record<string, number \| string>`         | Dynamic per-key style object (see below). |
| `children`  |   ✓    |   ✓    |         | `JSX.Element`                              | `Image` has none. |
| `focusable` |   ✓    |        |         | `boolean`                                  | Registers the node with the focus manager. |
| `onPress`   |   ✓    |        |         | `() => void`                               | Fires on activation, bubbling to the nearest ancestor handler. |
| `nodeRef`   |   ✓    |   ✓    |   ✓     | `(node) => void \| { current: NodeMirror \| null }` | Handle to the mirror node. All three frameworks; the only ref prop under Vue Vapor and Octane. |
| `ref`       |   ✓    |   ✓    |   ✓     | `(node: NodeMirror) => void \| NodeMirror` | **Solid only** — the target of Solid's `ref={variable}` binding. |
| `src`       |        |        |   ✓     | `string`                                   | Baked texture name. |
| `debugName` |   ✓    |   ✓    |   ✓     | `string`                                   | Semantic name in the [DevTools](/docs/devtools/) component tree; mirror-only, no pixel or native cost. **Solid and Octane** — Vue Vapor's prop types do not declare it. |

### `style` vs `class`

`class` is compiled ahead of time into a fixed style record. `style` is the
escape hatch for values you only know at runtime — it sets individual style
keys directly, prev-diffed per key. Use it for signal-driven values:

:::framework-code
```tsx solid
<View
  class="h-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600"
  style={{ width: (position() / TRACK_FRAMES) * 160 }}
/>
```

```tsx vue-vapor
<View
  class="h-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600"
  style={{ width: (position.value / TRACK_FRAMES) * 160 }}
/>
```

```tsx octane
<View
  class="h-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600"
  style={{ width: (position / TRACK_FRAMES) * 160 }}
/>
```
:::

Prefer transform keys (`translateX`, `translateY`, `scale`, `rotate`) for motion
where you can — they animate without triggering relayout. Full details are on
the [Styling](/docs/styling/) page.

### `ref` and `nodeRef`

Both hand you the underlying `NodeMirror` to pass to imperative APIs like
[`animate()`](/docs/animation/). Solid takes either form — a plain variable it
assigns, or a callback. Vue Vapor and Octane declare `nodeRef` alone:

:::framework-code
```tsx solid
import { animate } from "@pocketjs/framework/animation";
import { onMount } from "solid-js";
import type { NodeMirror } from "@pocketjs/framework/components";

let underline: NodeMirror | undefined;
onMount(() => {
  if (underline) animate(underline, "width", 210, { dur: 700, easing: "out" });
});

<View ref={underline} class="h-1 w-0 rounded-full bg-blue-500" />;
```

```tsx vue-vapor
import { animate } from "@pocketjs/framework/animation";
import { onMounted } from "vue";
import type { NodeMirror } from "@pocketjs/framework/components";

let underline: NodeMirror | undefined;
onMounted(() => {
  if (underline) animate(underline, "width", 210, { dur: 700, easing: "out" });
});

<View
  nodeRef={(node) => {
    underline = node ?? undefined;
  }}
  class="h-1 w-0 rounded-full bg-blue-500"
/>;
```

```tsx octane
import { animate } from "@pocketjs/framework/animation";
import { useLayoutEffect, useRef } from "octane";
import type { NodeMirror } from "@pocketjs/framework/components";

const underline = useRef<NodeMirror | null>(null);
useLayoutEffect(() => {
  if (underline.current) {
    animate(underline.current, "width", 210, { dur: 700, easing: "out" });
  }
}, []);

<View
  nodeRef={(node: NodeMirror | null) => {
    underline.current = node;
  }}
  class="h-1 w-0 rounded-full bg-blue-500"
/>;
```
:::

## Control flow

In Solid apps, render lists and conditionals with Solid's control-flow
components rather than `array.map` + `&&`. Import them directly from `solid-js`;
their semantics are exactly Solid's, and PocketJS's Solid renderer turns their
updates into native tree-mutation ops on the PSP. Vue Vapor apps use Vue's
native JSX control-flow patterns instead. Octane apps use plain JSX — ternaries
for conditionals and `array.map` with a `key` prop for lists — and the Octane
compiler turns those into keyed dynamic slots over the native tree.

### `Show`

Toggles a subtree on a boolean condition, with an optional `fallback`:

:::framework-code
```tsx solid
<Show when={count() > 3} fallback={<Text class="text-sm text-slate-500">Keep going…</Text>}>
  <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
</Show>
```

```tsx vue-vapor
{count.value > 3 ? (
  <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
) : (
  <Text class="text-sm text-slate-500">Keep going...</Text>
)}
```

```tsx octane
{count > 3 ? (
  <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
) : (
  <Text class="text-sm text-slate-500">Keep going...</Text>
)}
```
:::

When `when` flips, the children are inserted or removed from the native tree.
While hidden, `Show` leaves behind only an empty text marker, which — as noted
above — takes up no layout space.

### `For`

`For` renders a list keyed **by reference**. Its callback receives the item and
an index *accessor*:

:::framework-code
```tsx solid
<For each={tracks()}>
  {(track, i) => (
    <View class="flex-row justify-between p-1" focusable onPress={() => select(i())}>
      <Text class="text-xs text-slate-900">{track.title}</Text>
      <Text class="text-xs text-slate-500">{track.artist}</Text>
    </View>
  )}
</For>
```

```tsx vue-vapor
{tracks.value.map((track, i) => (
  <View class="flex-row justify-between p-1" focusable onPress={() => select(i)}>
    <Text class="text-xs text-slate-900">{track.title}</Text>
    <Text class="text-xs text-slate-500">{track.artist}</Text>
  </View>
))}
```

```tsx octane
{tracks.map((track, i) => (
  <View key={track.title} class="flex-row justify-between p-1" focusable onPress={() => select(i)}>
    <Text class="text-xs text-slate-900">{track.title}</Text>
    <Text class="text-xs text-slate-500">{track.artist}</Text>
  </View>
))}
```
:::

When the array is reordered, `For` **moves** existing nodes to their new
positions instead of destroying and recreating them (the native `insertBefore`
op unlinks a node from its old spot before re-inserting it). Focus, animation
state, and any imperative refs survive the move. Reach for `For` whenever list
items have stable identity.

### `Index`

`Index` is the counterpart keyed **by position**. Here the item is an accessor
and the index is a plain number:

:::framework-code
```tsx solid
<Index each={bars()}>
  {(bar, i) => <View class="w-2 rounded-md bg-emerald-500" style={{ height: bar() }} />}
</Index>
```

```tsx vue-vapor
{bars.value.map((bar) => (
  <View class="w-2 rounded-md bg-emerald-500" style={{ height: bar }} />
))}
```

```tsx octane
{bars.map((bar, i) => (
  <View key={i} class="w-2 rounded-md bg-emerald-500" style={{ height: bar }} />
))}
```
:::

Use `Index` when the list length is stable and it's the *values at each slot*
that change (equalizer bars, a fixed set of rows). It never moves nodes — it
just updates the value at each position.

### `Switch` / `Match`

Pick one of several branches — the JSX form of a `switch` statement:

:::framework-code
```tsx solid
<Switch fallback={<Text>Idle</Text>}>
  <Match when={state() === "loading"}><Text>Loading…</Text></Match>
  <Match when={state() === "ready"}><Text>Ready.</Text></Match>
</Switch>
```

```tsx vue-vapor
{state.value === "loading" ? (
  <Text>Loading...</Text>
) : state.value === "ready" ? (
  <Text>Ready.</Text>
) : (
  <Text>Idle</Text>
)}
```

```tsx octane
{state === "loading" ? (
  <Text>Loading...</Text>
) : state === "ready" ? (
  <Text>Ready.</Text>
) : (
  <Text>Idle</Text>
)}
```
:::

The first `Match` whose `when` is truthy renders; if none match, `fallback`
renders.

## Classic controls

The Solid module `@pocketjs/framework/classic` shares a shaded bezel and color
palette across buttons, keyboard faces, panels and selection indicators.

```tsx
import { ClassicButton, ClassicPanel, ClassicSheet } from "@pocketjs/framework/classic";

<ClassicButton label="Save" tone="primary" surface="auxiliary"
  style={{ posType: 1, insetL: 240, insetT: 4, width: 72, height: 24 }}
  disabled={saving()} onPress={save} />
```

**A touch activates a button on release inside its bounds.** Sliding outside,
gesture cancellation, a touch block or becoming disabled cancels the press.
The shared depressed palette provides feedback before release. `selected`
retains the blue state independently of a transient press; `tone` accepts
`neutral`, `primary`, `danger` and `key`. `edge="left"` or `edge="right"`
squares the joining edge of adjacent toolbar actions. Place them with one
shared border pixel. Labels use the small bold font; layout remains the caller's.

`ClassicFace` supplies the same appearance for controls with their own input
model, such as a space key that also recognizes a long press. Bind its
`pressed`, `selected` and `disabled` properties to that model. `classicPalette`
returns matching gradient, border and label colors for other UI elements.

`ClassicPanel` paints its header and body inside a complete rounded rim.
**Rounded background painting does not imply rounded child clipping** on the
small native hosts. Insets preserve its corners without requiring an image
mask. Its `active` property uses the blue header palette, and `headerHeight`
defaults to 27 logical pixels.

`ClassicSheet` accepts `open`, `title`, `message`, up to four `actions`,
`cancelLabel` and `onCancel`. Each action supplies a label, tone and callback.
**The host animates the panel translation and backdrop opacity.** The component
keeps its fixed action subtree mounted and blocks other touch gestures until
the closing transition ends. `onModalChange` includes that closing interval so
applications can also gate hardware buttons. Buttons keep a 4px gap and the final button sits 4px above the panel bottom.
Reopening cancels the old closing
deadline; unmounting cancels animations, the deadline and the touch block.

```tsx
<ClassicSheet open={confirmDiscard()} surface="auxiliary"
  title="Discard unsaved changes?"
  actions={[{ label: "Discard Changes", tone: "danger", onPress: discard }]}
  cancelLabel="Keep Editing" onCancel={() => setConfirmDiscard(false)}
  onModalChange={setInputBlocked} />
```


## App-shell primitives

`@pocketjs/framework/components` also exports a layer of higher-level primitives
that compose `View` with focus and overlay behavior. Their focus semantics and
worked examples are on the [App shell](/docs/app-shell/) and
[Input & focus](/docs/input-focus/) pages; the typed signatures, with defaults,
are in the [API reference](/docs/api/#pocketjsframeworkcomponents).

Two of them reach a second display. `AuxiliarySurface` requires a resolved
`display.auxiliary` capability and a matching `app.surfaces.auxiliary.fixed`
declaration; **its children lay out against the auxiliary display's logical size
and do not affect primary layout**, and state is shared with the primary tree
because both run in one application instance. `AuxiliaryPortal` targets the
auxiliary overlay root; ordinary `Portal` targets the primary overlay.
