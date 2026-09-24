# Input & focus

PocketJS's portable interaction baseline is a d-pad and a handful of face
buttons. A single **focus manager** tracks one focused node, the d-pad moves
focus between focusable nodes, and **CIRCLE** activates whatever is focused.
Targets that declare the `input.touch` capability expose front-panel contacts
without changing that controller fallback, and apps that want a pointer
instead of a focus walk can opt in to the [virtual cursor](#virtual-cursor).

The same code runs on real PSP hardware, PPSSPP, the browser host, and
headless Bun. The browser and Bun hosts remap keys onto the same
[`BTN`](#buttons) bitmask the console reads from the hardware controller.

## Buttons

Every host reports the controller as one integer per frame: a bitmask of the buttons
currently held. The bit values live in the spec and never change across hosts.

```ts
import { BTN } from "@pocketjs/framework/input";
```

The twelve members and their bit values are in the
[API reference](/docs/api/#btn). `CIRCLE` is the default confirm and press
button; `UP`/`RIGHT`/`DOWN`/`LEFT` are the d-pad and `LTRIGGER`/`RTRIGGER` the
shoulders.

Test a button with a bitwise `&`, and combine buttons with `|`:

```ts
if (buttons & BTN.CROSS) { /* CROSS is down this frame */ }
const confirmOrBack = BTN.CIRCLE | BTN.CROSS;
```

The raw bitmask is a *held* state — it stays set for every frame the button is down.
When you want "the frame a button went down" (edge detection), use the focus manager,
[`onButtonPress`](#button-press-hooks), or edge-detect it yourself.

## Touch snapshots

Targets that provide `input.touch` expose the current front-panel contacts in
logical viewport pixels:

```ts
import { touches, type TouchContact } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";

onFrame(() => {
  for (const contact of touches()) {
    // contact.id stays stable until release; x/y use the app's logical layout.
  }
});
```

The snapshot is immutable and becomes empty after release. It is the raw
contact latch: one frame of positions, with nothing interpreted on top. Tap,
long press, axis-lockable pan and two-contact pinch recognizers ship in
`@pocketjs/framework/gesture`, and **mounting an app installs a tap-to-`onPress`
recognizer**, so a `Focusable` with an `onPress` answers a tap with no extra
wiring. Read `touches()` yourself only for behavior the recognizers do not
cover — see [Touch & gestures](/docs/touch-gestures/). Put
`input.touch` in `enhances` when the same app must still build for PSP.

Targets with a separate touch display expose `input.touch.auxiliary` instead:

```ts
import { auxiliaryTouches } from "@pocketjs/framework/input";

const contact = auxiliaryTouches()[0];
```

**`touches()` contains only primary-surface contacts;
`auxiliaryTouches()` contains only auxiliary-surface contacts.** Each contact's
`surface` field is `"primary"` or `"auxiliary"`, and `x`/`y` stay in that
surface's logical coordinate space. Touch activation and
[gestures](/docs/touch-gestures/) resolve hits only against the matching
surface tree. The two capability ids are independent:
a bottom-screen touch panel does not imply that the primary display is touchable.

## Virtual cursor

Targets that provide `input.cursor` can replace the d-pad focus walk with a
**pointer**: the analog nub steers a cursor sprite, hovering applies the
`focus:` variant, and a press button clicks whatever is under the arrow. It is
opt-in — declare the capability in `pocket.json` (`requires` or `enhances`)
and enable it at runtime:

```ts
import { enableCursor } from "@pocketjs/framework/input";

enableCursor(); // safe at module top — the sprite uploads on the first frame
```

What changes while the cursor is enabled:

- **Hover is focus.** The cursor hit-tests the tree and focuses the nearest
  *focusable* ancestor of the node under the point, so every `focus:` style
  doubles as the hover style with no new machinery. Hit testing follows paint
  order: a node claims the point where it paints in any variant (background,
  border, bevel, image, text — `focus:`-styled hotspots count before they are
  hovered), a subtree faded to zero takes no hits, and transparent layout
  wrappers — including the framework's own overlay layers — pass through.
  The test runs only on frames where the answer can change (cursor movement,
  tree/style mutations, press edges) — a parked cursor costs nothing.
- **The press button clicks.** CIRCLE (configurable) holds the `active:`
  variant while down over the armed node — drag off to pop it back up, drag
  back to re-press — and fires `onPress` on release over it, bubbling the way
  the classic model does.
- **D-pad traversal and the classic CIRCLE press are suppressed.**
  `onButtonPress` hooks and focus scopes keep working; modal backgrounds stay
  inert because hover resolution respects the active scope.

The sprite, hotspot, speed, press button, and start position are
`CursorOptions`, and the disposer `enableCursor` returns restores the d-pad
model — signatures in the
[API reference](/docs/api/#virtual-cursor).

Determinism is unchanged: the cursor is a function of the button and analog
frame inputs the DevTools tape records, and its speed is expressed per
*virtual* second, so a tape replays to the same pixels at every
`simulationHz`.

## The focus model

The focus manager keeps exactly **one** focused node (or none). The default traversal
order is **document order** — a depth-first walk of the live tree, recomputed on each
navigation press, so it is always correct even after a [`<For>`](/docs/components/)
reorders its children.

Each frame, before the render sweep, the manager edge-detects the bitmask and:

- **d-pad moves focus.** Outside a [grid](#focus-grids), `DOWN`/`RIGHT` move to the
  next focusable node and `UP`/`LEFT` move to the previous one. Movement clamps at the
  ends of the list (no wrap). If nothing is focused, the first press enters the order
  from the matching end.
- **CIRCLE fires a press.** It calls `onPress` on the focused node, and if the focused
  node has no handler it **bubbles up** to the nearest ancestor that does.
- **Every focus change is pushed to the native core** (`setFocus`), which applies the
  [`focus:` style variant](#focus-and-active-variants) with zero further JS.

That is the entire default interaction loop. For most screens you never touch the
input API directly — you mark nodes focusable and give them an `onPress`.

## Making things focusable

Any `View` becomes focusable with the `focusable` prop, and gains a CIRCLE handler
with `onPress`. The [`Focusable`](/docs/app-shell/) component is a `View` with
`focusable` preset to `true`.

```tsx
import { Focusable, Text } from "@pocketjs/framework/components";

function PlayButton(props: { onStart: () => void }) {
  return (
    <Focusable
      class="px-4 py-2 rounded-lg bg-slate-200 focus:bg-sky-500"
      onPress={props.onStart}
    >
      <Text class="text-slate-900 focus:text-white">Play</Text>
    </Focusable>
  );
}
```

`focusable` and `onPress` are independent. A plain `View` can carry `onPress` without
being focusable — it then acts as a **bubble target**: a focused descendant with no
handler of its own forwards its CIRCLE press up to the nearest ancestor that has one.

## `focus:` and `active:` variants

Because focus lives in the native core, the visual focus state is a **style variant**,
not a JS re-render. Prefix any utility with `focus:` and the core swaps in that value
the instant the node becomes focused — no effect, no reconciliation, no per-frame work
on the JS side.

```tsx
<Focusable class="bg-slate-200 focus:bg-sky-500 focus:scale-105">…</Focusable>
```

The core also supports an `active:` variant for the pressed state. Both are compiled at
build time from the Tailwind subset — see [Styling](/docs/styling/) for the full list of
variants and how they compile.

## Programmatic focus

Grab a node with `ref` (refs hand you the `NodeMirror`) and move focus imperatively.

```tsx
import { focusNode, getFocused } from "@pocketjs/framework/input";
import { onMount } from "solid-js";
import { Focusable, type NodeMirror } from "@pocketjs/framework/components";

function Menu() {
  let first: NodeMirror | undefined;
  onMount(() => focusNode(first ?? null)); // focus the first item on mount
  return <Focusable ref={(n) => (first = n)}>New game</Focusable>;
}
```

`focusNode(node)` focuses a node and `focusNode(null)` clears focus;
`getFocused()` returns the focused node or `null`. Signatures, and the rest of
the imperative surface — `pressNode`, `setActiveNode`, `pushFocusController`,
`hitFocusable`, `hitNode` — are in the
[API reference](/docs/api/#pocketjsframeworkinput).

Turning off a node's `focusable` while it is focused clears focus.

## Focus scopes

A **focus scope** temporarily restricts d-pad traversal and CIRCLE press to one
subtree — what a dialog or a menu wants, so the background can't be navigated.
The declarative [`FocusScope`](/docs/app-shell/) component (and
[`Modal`](/docs/app-shell/), which is built on it) is the usual way in; the imperative
primitive underneath is `pushFocusScope`.

```ts
import { pushFocusScope } from "@pocketjs/framework/input";
import { onCleanup } from "solid-js";

// `panel` is a NodeMirror captured from a ref.
const dispose = pushFocusScope(panel, { autoFocus: true, restoreFocus: true });
onCleanup(dispose); // always release the scope when it unmounts
```

`FocusScopeOptions` is `autoFocus` and `restoreFocus`, both defaulting to
true ([API reference](/docs/api/#pushfocusscope)).

`pushFocusScope` returns a disposer. While a scope is on the stack, focus traversal only
sees nodes inside it, so navigation cannot leak out. Disposing pops the scope and
(unless `restoreFocus` is `false`) returns focus to wherever it was before.

## Focus grids

By default the d-pad walks a flat list. A **focus grid** overlays true row/column
semantics on a subtree: `LEFT`/`RIGHT` move within a row, `UP`/`DOWN` move between rows.
Use the [`FocusGrid`](/docs/app-shell/) component, or the primitive:

```ts
import { pushFocusGrid } from "@pocketjs/framework/input";
import { onCleanup } from "solid-js";

const dispose = pushFocusGrid(gridRoot, { columns: 4, wrap: true });
onCleanup(dispose);
```

`FocusGridOptions` is a required `columns` (clamped to a minimum of 1) and
`wrap` ([API reference](/docs/api/#pushfocusgrid)).

The focusable descendants of `gridRoot`, in document order, are laid out into rows of
`columns`. With `wrap: false`, movement stops at the grid edges; with `wrap: true`,
`RIGHT` off the end of a row returns to its start, `DOWN` off the bottom returns to the
top of that column, and so on.

## Refocus on removal

When the focused node (or an ancestor of it) is removed — a list item deleted, a panel
closed — the manager repairs focus **before** the node is unlinked, so it can still see
the surrounding tree. It searches, in order:

1. the **next sibling** subtree's first focusable,
2. then the **previous sibling** subtrees, nearest first,
3. then the **nearest focusable ancestor**,
4. and finally clears focus if nothing qualifies.

This keeps a sensible node focused as content churns, without any bookkeeping in your
components.

## Motion state

Apps read device attitude as **fused motion state**, not accelerometer or
gyroscope samples. The host's native driver fuses its sensors and delivers
its newest `MotionState` as the eighth `frame` argument, or queues it between
frames with `feedMotionState(state)` from `@pocketjs/framework/input`.
`contracts/spec/motion.ts` defines the values, units, quality grades and
reference frames; the [MicroTS reference](/docs/microts-reference/#motion-state)
lists them.

`MotionHandler` and `onMotion` fire once per frame whose state carries the
subscribed value at `minQuality` or better, in document order with the other
input handlers:

```tsx
import { MotionHandler } from "@pocketjs/framework/components";
import { onMotion } from "@pocketjs/framework/lifecycle";

<MotionHandler value="screenRotation" onUpdate={(degrees) => setAngle(degrees)} />;

onMotion("rotationRate", (x, y, z) => spin(x, y, z), { minQuality: "high" });
```

The driver also publishes the derived conveniences (`screenRotation`,
`tilt`, `angles`) as members of the state; the runtime does not compute them.
A fed state is validated, its numbers are rounded to f32 and zeros lose
their sign, so a DevTools tape, which is JSON, replays exactly what the
handlers received.

## Per-frame hooks

`onFrame` registers a callback that runs once per frame with the current button
bitmask. It cleans itself up when the owning component unmounts. Use it for held-button
behavior (movement, charging) or anything that must sample input every frame.

```tsx
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createSignal } from "solid-js";

function Player() {
  const [x, setX] = createSignal(0);
  onFrame((buttons) => {
    if (buttons & BTN.LEFT) setX((v) => v - 2);
    if (buttons & BTN.RIGHT) setX((v) => v + 2);
  });
  // …
}
```

## Button-press hooks

`onFrame` gives you the held state; `onButtonPress` gives you **edge-triggered**
presses. It fires your callback on the frame a matching button transitions from up to
down.

```tsx
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// Fires once per press of TRIANGLE.
onButtonPress(BTN.TRIANGLE, () => openMenu());

// Multiple buttons in one handler; `pressed` is the edge mask this frame.
onButtonPress(BTN.CROSS | BTN.CIRCLE, (pressed) => {
  if (pressed & BTN.CROSS) goBack();
  else confirm();
});
```

The callback receives `(pressed, buttons)` — the newly-pressed edge mask and the full
held mask. `ButtonPressOptions` gates it: `active`, `allowWhenBlocked`, and
`latched` ([API reference](/docs/api/#onbuttonpress)).

`active` can be a reactive accessor, so a handler can be enabled only on a given screen:

```tsx
onButtonPress(BTN.SQUARE, () => favorite(), { active: () => tab() === "browse" });
```

Use `latched: true` when a screen or overlay mounts under the same held button
that opened it. The handler stays armed-off until that button is observed up
for a frame, so the held opener cannot become a second press.

The declarative equivalent is the [`ActionHandler`](/docs/app-shell/) component, which
wraps `onButtonPress`:

```tsx
import { ActionHandler } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";

<ActionHandler button={BTN.START} onPress={() => togglePause()} />;
```

## Blocking background input

When a modal or overlay owns input, the buttons behind it should go quiet.
`pushButtonHandlerBlock` increments a global block depth: while it is non-zero, every
`onButtonPress` handler is suppressed **except** those that opted in with
`allowWhenBlocked: true` (system/close handlers). It returns a disposer that decrements
the depth.

```ts
import { pushButtonHandlerBlock } from "@pocketjs/framework/lifecycle";
import { onCleanup } from "solid-js";

const release = pushButtonHandlerBlock();
onCleanup(release);
```

The block only affects `onButtonPress` / `ActionHandler`; the focus manager's own d-pad
navigation and CIRCLE press are unaffected (they are contained by whatever
[focus scope](#focus-scopes) the overlay pushes). [`Modal`](/docs/app-shell/) combines
both: it pushes a focus scope *and* a handler block for you.

## Browser & playground keyboard mapping

The browser host and the [playground](/playground/) map the keyboard onto the same
`BTN` bitmask the console reads from hardware, so the exact same code runs everywhere:

| Key | Button |
| --- | --- |
| Arrow keys | `UP` / `RIGHT` / `DOWN` / `LEFT` (d-pad) |
| Enter or Z | `CIRCLE` |
| X | `CROSS` |
| A | `SQUARE` |
| S | `TRIANGLE` |
| Left/Right Shift | `SELECT` |
| Space | `START` |
| L or Q | `LTRIGGER` (left shoulder) |
| R or E | `RTRIGGER` (right shoulder) |

The shoulder triggers map to the literal `L` / `R` keys (with `Q` / `E` as a
left-hand alternate). Behavior matches hardware: arrows drive
focus, Enter/Z confirms, `L` / `R` page the shoulder-driven UI, and your
`onButtonPress` handlers fire on the mapped presses.

## Related

- [Touch & gestures](/docs/touch-gestures/) — tap, long press, pan, pinch, and the kinetic scroller over these contacts.
- [App shell](/docs/app-shell/) — `Focusable`, `FocusScope`, `FocusGrid`, `Modal`, and `ActionBar` components.
- [Components](/docs/components/) — `View`, `Text`, `Image`, and how Solid control flow maps onto the native tree.
- [Styling](/docs/styling/) — the `focus:` / `active:` variants and the Tailwind subset.
- [Reactivity](/docs/reactivity/) — the three reactive systems side by side, and the PocketJS rules on top.
