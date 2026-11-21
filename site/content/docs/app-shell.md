# App shell & overlays

Screens, focus regions, and floating UI (modals, action bars) are the pieces you
assemble a whole app out of. PocketJS ships these as small, unopinionated
primitives from `@pocketjs/framework/components` — thin wrappers over the same
[`View`](/docs/components/), [focus manager](/docs/input-focus/), and frame
hooks you already use. Nothing here is a framework-within-a-framework: there is
no router, no navigation stack, no global store. Screen switching is ordinary
[reactive state](/docs/reactivity/).

```tsx
import {
  Screen,
  Focusable,
  FocusScope,
  FocusGrid,
  ActionHandler,
  Portal,
  Modal,
  ActionBar,
} from "@pocketjs/framework/components";
```

`Screen`, `Focusable`, `FocusScope`, `FocusGrid`, `Grid` and `ActionBar` extend
[`ViewProps`](/docs/components/) and pass the rest through to a `View`;
`ActionHandler`, `Portal`, `Modal`, `Lazy` and `Gallery` declare **their own prop
shapes** and take no `class`/`style`/`focusable`/`onPress` beyond what those
shapes list. All eleven are typed with their defaults in the
[API reference](/docs/api/#pocketjsframeworkcomponents).

## Screen

`Screen` is a `View` with a default class of
`relative flex-col w-full h-full bg-slate-50 overflow-hidden`. Use one as the
root of each page. Pass your own `class` to override the default entirely.

```tsx
function HomeScreen() {
  return (
    <Screen class="relative flex-col w-full h-full bg-slate-950 overflow-hidden">
      {/* page content */}
    </Screen>
  );
}
```

## Focusable

`Focusable` is a `View` with `focusable` pre-set. It exists so intent reads
clearly at the call site; `<Focusable onPress={...}>` and
`<View focusable onPress={...}>` are equivalent.

```tsx
<Focusable
  class="p-2 rounded-md bg-white border-slate-200 focus:border-blue-500"
  onPress={() => select(item)}
>
  <Text class="text-sm text-slate-950">{item.title}</Text>
</Focusable>
```

`onPress` fires on activation: CIRCLE on the focused node, a tap on a touch
host, or a cursor click. Whichever the source, the press bubbles to the
nearest ancestor handler. The `focus:` style variant is applied by the core
with zero extra JS —
see [Input & focus](/docs/input-focus/) for the full model.

## FocusScope

`FocusScope` temporarily restricts d-pad traversal **and** CIRCLE press to its
subtree. This is what keeps a dialog from letting focus wander back into the page
behind it. On top of `ViewProps` it takes `active`, `autoFocus` and
`restoreFocus` — all default `true`, `active` also accepts an accessor
([signature](/docs/api/#focusscope)).

While the scope is active, navigation is confined to its focusables; when it
tears down it restores the previous focus (unless `restoreFocus={false}`). You
rarely reach for this directly — `Modal` wraps its panel in one for you — but it
is the right tool for a side panel or tab region that should own the d-pad while
open.

## FocusGrid

By default, focus traversal is linear over document order: DOWN/RIGHT go to the
next focusable, UP/LEFT to the previous. `FocusGrid` overrides that inside its
subtree with true two-dimensional movement, which is what you want for a grid of
tiles or a picker. It requires `columns` (floored to at least `1`) and takes
`wrap` (`false`) and `active` (`true`) — [signature](/docs/api/#focusgrid).

The grid collects its focusables in document order and treats them as a
`columns`-wide table. From index `i`: RIGHT goes to `i + 1` unless you are at the
right edge, LEFT to `i - 1` unless at the left edge, DOWN to `i + columns`, UP to
`i - columns`. With `wrap`, edge moves loop to the other side of the same
row/column instead of clamping.

:::framework-code
```tsx solid
import { For } from "solid-js";
import { FocusGrid, Focusable, Text } from "@pocketjs/framework/components";

<FocusGrid class="flex-row flex-wrap gap-2 w-[440]" columns={3} wrap>
  <For each={games()}>
    {(game) => (
      <Focusable
        class="w-[140] h-[72] rounded-lg bg-white border-slate-200 focus:border-blue-500"
        onPress={() => launch(game)}
      >
        <Text class="text-sm text-slate-950">{game.title}</Text>
      </Focusable>
    )}
  </For>
</FocusGrid>;
```

```tsx vue-vapor
import { FocusGrid, Focusable, Text } from "@pocketjs/framework/components";

<FocusGrid class="flex-row flex-wrap gap-2 w-[440]" columns={3} wrap>
  {games.value.map((game) => (
    <Focusable
      class="w-[140] h-[72] rounded-lg bg-white border-slate-200 focus:border-blue-500"
      onPress={() => launch(game)}
    >
      <Text class="text-sm text-slate-950">{game.title}</Text>
    </Focusable>
  ))}
</FocusGrid>;
```

```tsx octane
import { FocusGrid, Focusable, Text } from "@pocketjs/framework/components";

<FocusGrid class="flex-row flex-wrap gap-2 w-[440]" columns={3} wrap>
  {games.map((game) => (
    <Focusable
      key={game.title}
      class="w-[140] h-[72] rounded-lg bg-white border-slate-200 focus:border-blue-500"
      onPress={() => launch(game)}
    >
      <Text class="text-sm text-slate-950">{game.title}</Text>
    </Focusable>
  ))}
</FocusGrid>;
```
:::

Because the grid keys off document order, it stays correct after a
[`For`](/docs/components/) reorders or filters its rows. It is a traversal
override only — it does not lay anything out, so use flexbox
([styling](/docs/styling/)) to actually position the tiles.

## ActionHandler

`ActionHandler` binds a raw button bitmask to a callback, independent of focus.
Use it for global shortcuts — open a menu on SELECT, back out on CROSS, cycle a
value on a shoulder button. `button` is a `BTN` value or several OR'd together,
and `onPress(pressed, buttons)` receives the edge bits newly pressed this frame.
It inherits `active` (`true`), `allowWhenBlocked` and `latched` from
`ButtonPressOptions` ([signature](/docs/api/#actionhandler)).

It renders its `children` (or nothing), so drop it anywhere in the tree.

```tsx
import { ActionHandler } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";

<ActionHandler button={BTN.SELECT} onPress={() => setMenuOpen((v) => !v)} />;

// Combine buttons and inspect the edge bitmask:
<ActionHandler
  button={BTN.LTRIGGER | BTN.RTRIGGER}
  onPress={(pressed) => {
    if (pressed & BTN.LTRIGGER) prevTab();
    if (pressed & BTN.RTRIGGER) nextTab();
  }}
/>;
```

`BTN` is imported from [`@pocketjs/framework/input`](/docs/input-focus/) and covers
every PSP button (`SELECT`, `START`, `UP`/`DOWN`/`LEFT`/`RIGHT`, `LTRIGGER`,
`RTRIGGER`, `TRIANGLE`, `CIRCLE`, `CROSS`, `SQUARE`).

## Portal & the overlay root

`Portal` mounts its children into the runtime **overlay root** — a full-screen,
absolutely positioned layer (`z-index: 1000`) that `mount()` installs alongside
your app. Because the overlay lives outside the active screen's flex tree,
portalled UI never pushes your layout around: a modal or action bar floats on
top regardless of what the page underneath is doing.

```tsx
import { Portal, View, Text } from "@pocketjs/framework/components";

<Portal>
  <View class="absolute top-3 right-3 px-2 py-1 rounded-md bg-white border-slate-200">
    <Text class="text-xs text-slate-500">Saved</Text>
  </View>
</Portal>;
```

`Portal` renders nothing in place and cleans up its overlay host on unmount. It
throws `PocketJS: overlay root is not installed` if used outside a mounted app —
which only happens if you render components without `mount()`. `Modal` and
`ActionBar` are both built on `Portal`, so you usually reach for those instead.

## Modal

`Modal` is a portalled panel that centers itself over a dimmed backdrop, owns a
[`FocusScope`](#focusscope) on its panel, and — crucially — **blocks background
button handlers** while open. Any [`ActionHandler`](#actionhandler) /
`onButtonPress` handler in the rest of the app stops firing until the modal
closes, so the page behind can't react to input it can't see.

`ModalProps` is `open` (`true`, accepts an accessor), `class` for the centering
layer, `panelClass` for the panel, and `children` — no `focusable`, `onPress` or
`ref` ([signature and default classes](/docs/api/#modal)).

:::framework-code
```tsx solid
import { Modal, Focusable, Text } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

const [open, setOpen] = createSignal(false);

<Modal open={open}>
  <Text class="text-lg text-slate-950 font-bold">Delete save?</Text>
  <Focusable class="px-3 py-1 rounded-md bg-rose-600 focus:border-rose-300" onPress={confirm}>
    <Text class="text-sm text-white">Delete</Text>
  </Focusable>
</Modal>;
```

```tsx vue-vapor
import { Modal, Focusable, Text } from "@pocketjs/framework/components";
import { ref } from "vue";

const open = ref(false);

<Modal open={() => open.value}>
  <Text class="text-lg text-slate-950 font-bold">Delete save?</Text>
  <Focusable class="px-3 py-1 rounded-md bg-rose-600 focus:border-rose-300" onPress={confirm}>
    <Text class="text-sm text-white">Delete</Text>
  </Focusable>
</Modal>;
```

```tsx octane
import { Modal, Focusable, Text } from "@pocketjs/framework/components";
import { useState } from "octane";

const [open, setOpen] = useState(false);

<Modal open={open}>
  <Text class="text-lg text-slate-950 font-bold">Delete save?</Text>
  <Focusable class="px-3 py-1 rounded-md bg-rose-600 focus:border-rose-300" onPress={confirm}>
    <Text class="text-sm text-white">Delete</Text>
  </Focusable>
</Modal>;
```
:::

Two behaviors to know:

- **The block is on button *handlers*, not on rendering or animation.**
  [`onFrame`](/docs/animation/)-based work — [`animate()`](/docs/animation/),
  `createSpriteAnimation`, per-frame logic — keeps ticking while the modal is up.
  Only edge-triggered press handlers are suppressed. This is why a modal can
  fade and slide in while the page behind it holds still.
- **The block is global**, so even a handler *inside* the modal is suppressed
  unless it opts out with `allowWhenBlocked`. If your dialog drives its own
  cursor with an [`ActionHandler`](#actionhandler), set `allowWhenBlocked` on
  it. D-pad focus navigation is unaffected — the modal's `FocusScope` confines
  it to the panel.

## ActionBar

`ActionBar` is a portalled strip pinned to the bottom of the screen — the
natural home for button-hint captions or a persistent set of actions. Its
default class is
`absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200`;
override `class` for a different look. It takes ordinary `ViewProps` children.

```tsx
import { ActionBar, Text, View } from "@pocketjs/framework/components";

<ActionBar>
  <View class="flex-row gap-3">
    <Text class="text-xs text-slate-500">CIRCLE Select</Text>
    <Text class="text-xs text-slate-500">CROSS Back</Text>
  </View>
  <Text class="text-xs text-slate-500">START Menu</Text>
</ActionBar>;
```

Because it lives in the overlay layer, the bar stays put no matter how the
underlying screen scrolls or reflows.

## Grid

`Grid` lays a wall of fixed-width tiles out as a wrapping row. **Passing
`columns` is what turns it into a [`FocusGrid`](#focusgrid)** — with no
`columns` it renders a plain `View`. Layout stays pure flexbox: the visible
column count emerges from the tile width vs. the container width, and `columns`
drives *traversal only*. `active` (default `true`) gates that traversal on and
off, and `gap` is a number applied through `style` so `class` stays one compiled
literal — [typed signature](/docs/api/#grid).

It otherwise takes ordinary [`ViewProps`](/docs/components/); pass a fixed width
so the tiles wrap where you want them to.

```tsx
import { Grid, Image, Text, View } from "@pocketjs/framework/components";

<Grid columns={3} active gap={10} class="flex-row flex-wrap items-start justify-center w-[264]">
  {tiles.map((t) => (
    <View class="flex-col items-center gap-1 w-[78]">
      <View class="w-[68] h-[68] rounded-xl bg-slate-900 border-slate-700 focus:border-white items-center justify-center" focusable onPress={() => open(t)}>
        <Image class="w-[56] h-[56] rounded-lg" src={t.src} />
      </View>
      <Text class="text-xs text-slate-200 font-bold">{t.name}</Text>
    </View>
  ))}
</Grid>;
```

## Lazy

`Lazy` mounts a subtree **on demand**. While `when` is false nothing is built —
the native subtree is destroyed by the end-of-frame [sweep](/docs/architecture/)
(one recursive `destroyNode`), so an off-screen region costs nothing. When `when`
turns true the content is created, optionally after a short `reveal` delay that
shows a `fallback` (a spinner or skeleton). The reveal is a **one-shot latch**:
it runs the first time the subtree activates and then stays revealed for the
component's lifetime, so re-activating shows the content immediately (no replayed
spinner). With `reveal` at its `0` default `Lazy` is a plain gate with no
per-frame cost. `LazyProps` is `when`, `reveal`, `fallback` and a `children`
*factory* — no `class`, `style` or `ref` ([signature](/docs/api/#lazy)).

> **What "lazy" means here.** Textures upload at pak load and there is no runtime
> texture streaming, so `Lazy` defers content build, layout and draw, not texture
> residency. `reveal` counts host frames; it is not I/O.

```tsx
<Lazy when={isOpen} reveal={16} fallback={() => <Spinner />}>
  {() => <HeavyPanel />}
</Lazy>;
```

## Gallery

`Gallery` is a horizontally paged, full-screen strip: pressing `LTRIGGER` /
`RTRIGGER` slides one whole screen at a time. It is the natural shell for a photo
wall, an app launcher, or any "screen-by-screen" browse. `count`, `page` and
`renderPage` are required; `onPageChange`, `window` (`1`), `duration` (`300` ms),
`easing` (`"out"`), `bindTriggers` (`true`), `wrap` (`false`) and `class` are not
([signature](/docs/api/#gallery)).

`Gallery` is **controlled** — you own the `page` signal, so the rest of the UI (a
page indicator, a title) can read it. It reads L/R itself and calls
`onPageChange`.

:::framework-code
```tsx solid
import { Gallery } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

const [page, setPage] = createSignal(0);

<Gallery count={4} page={page} onPageChange={setPage} renderPage={(i) => <PhotoPage index={i} />} />;
```

```tsx vue-vapor
import { Gallery } from "@pocketjs/framework/components";
import { ref } from "vue";

const page = ref(0);

<Gallery
  count={4}
  page={page.value}
  onPageChange={(next) => { page.value = next; }}
  renderPage={(i) => <PhotoPage index={i} />}
/>;
```

```tsx octane
import { Gallery } from "@pocketjs/framework/components";
import { useState } from "octane";

const [page, setPage] = useState(0);

<Gallery count={4} page={page} onPageChange={setPage} renderPage={(i) => <PhotoPage index={i} />} />;
```
:::

It is a **static `overflow-hidden` viewport** wrapping an **animated strip** of
absolutely-positioned page cells. The split is load-bearing: the scissor comes
from the clip node's own box, so the clipping viewport must not move — only the
inner strip's [`translateX`](/docs/animation/) animates, one paint-only native
tween per press, and pages outside `window` are never built, which keeps a
many-page gallery inside the draw budget. `apps/gallery` is the worked example
(L/R paging, a [`Grid`](#grid) of baked tiles, [`Lazy`](#lazy) first-visit
loading, a page-dot [`ActionBar`](#actionbar)); build it with
`bun tools/build.ts gallery-main` and press **L / R** (or **Q / E**).

See also: [Input & focus](/docs/input-focus/) for the traversal model,
[Animation](/docs/animation/) for the frame hooks modals leave running, and
[Components](/docs/components/) for the underlying `View`/`Text` host
primitives and how Solid control flow maps onto the native tree.
