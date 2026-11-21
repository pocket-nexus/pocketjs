# Touch & gestures

`@pocketjs/framework/gesture` turns the per-frame touch snapshot into contact
lifecycles and runs recognizers over them: tap, long press, axis-lockable pan,
and two-contact pinch. `@pocketjs/framework/kinetics` takes the velocity a pan
ends with and carries it — fling decay, edge rubber band, snap points, and a
d-pad chase over the same offset. The recognizer options object is identical in
Solid and Vue Vapor, so every recipe below is written once; only the disposal
hook differs, and `createGesture` picks it. Field tables, defaults, and the ownership rules
live in the [API reference](/docs/api/#pocketjsframeworkgesture); the raw
per-frame snapshot is in [Input & focus](/docs/input-focus/#touch-snapshots);
declaring `input.touch` is in [Platform contracts](/docs/platform-contracts/).

:::demo clear

Pocket Clear's seed list doubles as the legend: **swipe right to complete, swipe left to
delete, tap to edit, long tap to reorder, pull down to create a new item, pull
down further to go back, pull up to clear, and pinch two rows apart to
insert**. Everything except the pinch works with a mouse; a pinch needs a
touchscreen, because a desktop pointer only ever gives the page one contact.

## Check whether you need a recognizer

Three interactions need no recognizer of your own.

- **A tap on `<Focusable onPress>` fires on every touch host.** The runtime
  installs a lowest-priority whole-screen recognizer at mount that routes taps
  into the press path CIRCLE uses ([App shell](/docs/app-shell/)).
- **`VirtualList` gives a long list its pan.** Fling, edge rubber band, a row
  press-highlight on the down edge, and a d-pad chase that keeps the focused
  row in view.
- **`TextField` opens the system keyboard**, mutes app gestures while the
  panel is up, and hands back the committed string.

`VirtualList` and `TextField` are Solid-only today; both have a row in the
[import-path table](/docs/api/). Write a recognizer only past these three.

## Recognize a tap

A tap is a down and an up inside `tapSlop` with nothing else claiming the
contact. Pocket Clear uses one to open the row under the finger
(`apps/clear/app.tsx:468`):

```ts
import { createGesture } from "@pocketjs/framework/gesture";

createGesture({
  region: { rect: inTodoList },
  onTap: (c) => {
    const index = rowIndexAt(c.y);
    if (index >= 0 && !order[index].done) {
      editor.open(order[index], false);
      return;
    }
    createAt(pendingCount(list()));
  },
});
```

A tap resolves on one recognizer only, so this handler never double-fires with
the list's ([Ownership](/docs/api/#ownership)).

## Follow a finger along one axis

Set `axis` to lock the pan, then position from the contact's travel:

```ts
import { createGesture } from "@pocketjs/framework/gesture";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";

let sheet: NodeMirror | null = null;

createGesture({
  axis: "y",
  region: { node: () => sheet },
  onPanMove: (c) => {
    if (sheet) jump(sheet, "translateY", c.dy);
  },
});
```

A drag that positions something at an absolute offset reads the totals
`c.dx`/`c.dy` — Pocket Clear's row swipe places the slider from `c.dx`
(`apps/clear/swipe.ts:85-87`) — while anything that feeds a delta forward reads
`c.fdx`/`c.fdy`, which is what a scroller consumes (`apps/clear/app.tsx:337`).
Both are in [`GestureContact`](/docs/api/#creategesture-and-attachgesture).

## Give a scroll momentum

A scroller is four calls from the pan plus a per-frame pump. Create it, feed it
this frame's delta, release it with the fling velocity, and step it once per
frame:

```ts
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump } from "@pocketjs/framework/animation";

const scroller = createScroller({
  max: () => Math.max(0, contentH - VIEW_H),
  extent: () => VIEW_H,
  overscroll: OVERSCROLL,
});

createGesture({
  axis: "y",
  region: { rect: inTodoList },
  onPanStart: () => scroller.beginDrag(),
  onPanMove: (c) => scroller.drag(-c.fdy),
  onPanEnd: (c) => scroller.endDrag(-c.vy),
  onCancel: () => scroller.endDrag(0),
});

onFrame(() => {
  scroller.step();
  const off = scroller.offset();
  if (off !== paintedOffset && canvas) {
    paintedOffset = off;
    jump(canvas, "translateY", -off);
  }
});
```

The signs come from direction: content moves up as the finger moves down, so a
vertical list passes `-c.fdy` and `-c.vy`. `step()` is the only thing that
advances a fling, a spring, a chase, or a tween, so a scroller with no
per-frame pump freezes the moment the finger lifts. Pocket Clear's version is
at `apps/clear/app.tsx:90-94` (the scroller), `:333-337` and `:366` (the
wiring), and `:597-604` (the pump).

## Share one area between two recognizers

Two recognizers can cover the same rectangle; locking them to different axes
leaves both unclaimed until the thumb's dominant axis picks one. The row swipe locks
to `x` (`apps/clear/swipe.ts:73-82`):

```ts
createGesture({
  axis: "x",
  region: { rect: () => host.region() },
  onPanStart: (c) => {
    index = host.rowIndexAt(c.startY);
    const row = index >= 0 ? host.rowAt(index) : null;
    todo = row?.todo ?? null;
    slot = row?.slot ?? null;
    armed = false;
  },
  // …
});
```

and the list scroll locks to `y` over the identical rect
(`apps/clear/app.tsx:333-337`). Whichever axis the thumb commits to first
claims the contact, and the other recognizer is cancelled that frame
([Ownership](/docs/api/#ownership)). So every recognizer
that paints something needs an `onCancel` that returns its visuals to rest, the
way the swipe animates its slider home (`apps/clear/swipe.ts:130-139`):

```ts
import { animate } from "@pocketjs/framework/animation";

onCancel: () => {
  const current = slot;
  const target = todo;
  slot = null;
  todo = null;
  if (!current?.front || !target) return;
  if (current.check) animate(current.check, "opacity", 0, { dur: 160, easing: "out" });
  if (current.cross) animate(current.cross, "opacity", 0, { dur: 160, easing: "out" });
  settle(current, target);
},
```

Damping the travel past the commit distance marks the threshold in the motion
itself, with no extra affordance to draw (`apps/clear/swipe.ts:27-32`):

```ts
/** 1:1 up to the commit bound, then damped to a third — the reference feel. */
function swipeDisplay(dx: number): number {
  if (dx > SWIPE_COMMIT) return SWIPE_COMMIT + (dx - SWIPE_COMMIT) / 3;
  if (dx < -SWIPE_COMMIT) return -SWIPE_COMMIT + (dx + SWIPE_COMMIT) / 3;
  return dx;
}
```

## Turn a recognizer off

The region getter is the switch: return `null` and the recognizer owns nothing
that frame ([`GestureRegion`](/docs/api/#creategesture-and-attachgesture)) — no
disposing and re-registering, and no priority churn. Pocket Clear gates every todo-screen
recognizer through one function (`apps/clear/app.tsx:325-330`):

```ts
const inTodoList = () =>
  screenName === "todos" && !editor.editing()
    ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }
    : null;
const inLists = () =>
  screenName === "lists" ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H } : null;
```

Switching off this way only stops new contacts from being owned; a contact in
flight keeps its owners until it lifts.

## Reorder on a long press

`onLongPress` fires once at the deadline and claims the contact, so the drag
that follows is yours ([Ownership](/docs/api/#ownership))
(`apps/clear/app.tsx:414-439`):

```ts
createGesture({
  region: { rect: inTodoList },
  longPressSeconds: 0.45,
  onLongPress: (c) => {
    const index = rowIndexAt(c.startY);
    if (index < 0 || index >= pendingCount(list())) return;
    dragFrom = index;
    dragTo = index;
    dragBaseDy = c.dy;
    dragSlot = slotByTodo.get(order[index].id) ?? null;
    // … lift the row
  },
  onMove: (c) => {
    if (!dragSlot?.node) return;
    const y = dragFrom * ROW_H + (c.dy - dragBaseDy);
    jump(dragSlot.node, "translateY", y);
    // … shift the rows it passes
  },
});
```

Drive the carry from `onMove`, not `onPanMove`: a long-press claim never sets
the panning flag, so `onPanMove` would never fire.

## Insert on a pinch

A pinch pairs two contacts and reports their span. With `axis: "y"` the span is
the vertical projection, which is the gap between two rows
(`apps/clear/app.tsx:496-509`):

```ts
createGesture({
  axis: "y",
  region: { rect: inTodoList },
  onPinchStart: (p) => {
    pinchGap = Math.max(
      0,
      Math.min(pendingCount(list()), Math.round((p.cy + scroller.offset()) / ROW_H)),
    );
    pinchRows(0);
  },
  onPinchMove: (p) => {
    if (pinchGap < 0) return;
    pinchRows(Math.max(0, Math.min(ROW_H, p.dspan)));
  },
  // onPinchEnd commits the insert past a threshold, or lays the rows back down
});
```

The gap under the fingers is `p.dspan`; a per-frame consumer reads `p.fdspan`
([`GesturePinch`](/docs/api/#creategesture-and-attachgesture)). Two fingers
opening a gap here never also scroll the list
([Ownership](/docs/api/#ownership)).

## Mute gestures under a modal

`pushTouchBlock()` cancels the in-flight contacts of every recognizer that did
not opt out and suppresses new downs while it is held; the returned disposer
pops it. A recognizer that must keep working under the block sets
`allowWhenBlocked: true`. The system keyboard does both — it pushes the block
at `framework/src/osk.tsx:138` and exempts its own key recognizer at `:249`:

```ts
import { pushTouchBlock } from "@pocketjs/framework/gesture";
import { onCleanup } from "solid-js";

onCleanup(pushTouchBlock());
```

The touch block and the button block are separate pushes. `Modal` pushes only
the button block, so an overlay that also needs to silence gestures pushes this
one itself. The button twin is in
[Input & focus](/docs/input-focus/#blocking-background-input).

## Keep it usable without a touchscreen

The same screen has to work on a d-pad, and the two paths converge. A tap and
CIRCLE both arrive at the node's `onPress`, so a `<Focusable onPress>` needs
nothing extra. For a scroll, hand the scroller to `bindDpadScroll`, which
registers an `onFrame` hook that turns held UP/DOWN and the analog stick into
chase-target nudges:

```ts
import { bindDpadScroll, createScroller } from "@pocketjs/framework/kinetics";

const scroller = createScroller({ max: () => Math.max(0, contentH - VIEW_H) });
bindDpadScroll(scroller, { active: () => !osk.isOpen() });
```

`bindDpadScroll` does not pump the scroller; `step()` still belongs to your own
`onFrame`. On a host with no touch the recognizers never see a contact and the
per-frame pump costs two comparisons.

## Test the feel

Gestures are deterministic input, so they test like any other input: script
contacts on the virtual clock and assert on the tree. The sim's
`touchGlide(x0, y0, x1, y1, t0, t1)` emits one contact per frame between two
virtual times and releases at the end; a `GoldenSpec`'s `touch(frame)` does the
same for pixel goldens on hosts that deliver touch.

Two numbers decide whether a scripted gesture fires: the frame count and the
travel. A long press needs frames past its deadline — Pocket Clear sets
`longPressSeconds: 0.45`, which at 60 Hz is 27 virtual frames, and the test
holds 32 before it starts carrying the row (`tests/clear.test.ts:121-122`):

```ts
for (let i = 0; i < 32; i++) await step([__packTouch(0, 160, rowCenterY(0))]);
await glide(160, rowCenterY(0), 160, rowCenterY(2), 10);
```

A pinch needs span change past `pinchSlop` that also dominates the centroid's
travel ([`createGesture`](/docs/api/#creategesture-and-attachgesture)). Moving each
contact 4 px per frame in opposite directions opens the span 8 px per frame and
leaves the centroid still, so the pinch starts on the second frame after the
pair forms (`tests/clear.test.ts:152-158`):

```ts
for (let f = 0; f <= 14; f++) {
  const spread = f * 4;
  await step([
    __packTouch(0, 160, rowCenterY(1) - Math.min(spread, 26)),
    __packTouch(1, 160, rowCenterY(2) + spread),
  ]);
}
```

To watch a recorded gesture frame by frame instead of asserting on it, use the
tape tool in [DevTools](/docs/devtools/).

## Related

- [API reference](/docs/api/#pocketjsframeworkgesture) — every gesture and
  kinetics field, signature, default, and the ownership rules.
- [Input & focus](/docs/input-focus/) — the raw `touches()` snapshot, the
  button model, and the virtual cursor.
- [App shell](/docs/app-shell/) — `Focusable`, `Modal`, and the components a
  tap activates.
- [Platform contracts](/docs/platform-contracts/) — declaring `input.touch` and
  guarding optional enhancements.
- [DevTools](/docs/devtools/) — recording and replaying input tapes.
