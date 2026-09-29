# Animation

PocketJS has three ways to move things:

- **Baked keyframe timelines** — CSS-grade `keyframes` / `animation` choreography
  authored in `pocket.config.ts` and applied with `animate-<name>` classes. Compiled
  into binary timelines at build time; the richest option.
- **Transition utilities** — Tailwind-subset classes (`transition`, `duration-N`,
  `ease-*`, `delay-N`) that tween a node whenever its style is swapped.
- **The imperative API** — `animate()`, `spring()` and `cancelAnim()` from
  [`@pocketjs/framework/animation`](/docs/api/), for one-off tweens you kick off from code.

All three compile down to the same native machinery. **You declare motion once; the
Rust core owns every frame from there.**

## How native animation works

Tweens and springs tick in the Rust core, one step per `tick()`. The step is
**`dt = 1 / tickHz`**, and `tickHz` is a per-realm declaration, not the constant
60: `engine/core/src/lib.rs` defaults to `DEFAULT_TICK_HZ` 60 and caps at
`MAX_TICK_HZ` 240, `tools/build.ts --hz=N` bakes the rate into the bundle
(1 through 240), and `Ui::set_tick_rate` is refused once the first `tick()` has
run. So `dt` is constant for a whole run, whatever its rate. Durations you write
are milliseconds and convert against `tickHz`, so a `dur: 700` tween lasts 700 ms
at 60 Hz and at 120 Hz. See [Architecture](/docs/architecture/) for the clock.

Two consequences:

- **Zero steady-state JS.** After you call `animate()` (or a style swap starts a
  transition), JavaScript is not involved again until the tween ends. A 20-second
  drift costs one FFI call to start — no per-frame `requestAnimationFrame`,
  no signal churn.
- **Deterministic, byte-exact.** Because `dt` is constant and frame content is a
  pure function of the frame index, the same app produces the same pixels on
  every run. That is what makes PocketJS's byte-exact PNG goldens possible. See
  [Native contract](/docs/native-contract/) and [Build pipeline](/docs/build-pipeline/).

## Imperative: `animate()`

```ts
import { animate } from "@pocketjs/framework/animation";

animate(node, prop, to, { dur, easing, delay }): number
```

`animate` tweens one prop from its **current** value to `to`, and returns an `animId`
you can later pass to `cancelAnim()`. `node` is a node ref (see below) or a raw node id.
`dur` defaults to 200 ms, `easing` to `"out"`, `delay` to 0; the two spring
easings (`"spring"`, `"spring-bouncy"`) run on physics and ignore `dur`. The
full `AnimateOptions` and `EasingName` sets are in the
[API reference](/docs/api/#animate).

Only **animatable** props are accepted; passing an unknown or non-animatable prop
throws at the call site.

### Getting a node ref

`animate` needs the node's `NodeMirror`, which `ref` (Solid) or `nodeRef` (all
three frameworks) hands you — see
[Components → ref and nodeRef](/docs/components/#ref-and-noderef) for the three
forms. Start the tween in `onMount`/`onMounted`/`useLayoutEffect`, once the node
exists:

```tsx
onMount(() => {
  if (el) animate(el, "width", 210, { dur: 700, easing: "out", delay: 150 });
});
```

That is the `hero` demo's title underline: it starts at `w-0` and the core
animates `width` up to `210` px. `width` is a **layout** prop, so it runs a Taffy pass on
each tweened frame. Transform props (`translateX/Y`, `scale`, `rotate`), colors
and `opacity` are paint-only: reserve layout-prop tweens for one-shot flourishes
and animate a transform for anything that runs continuously or on interaction.

### Animating colors

Color props tween per ABGR channel natively. Pass a packed `u32` ABGR value or a
`'#rrggbb'` / `'#rrggbbaa'` string as `to`:

```ts
animate(card, "bgColor", "#3b82f6", { dur: 150 });
```

### Value units

For non-color props you pass the raw native value:

| Prop family                                                        | Units                   |
| ------------------------------------------------------------------ | ----------------------- |
| `translateX`, `translateY`, `width`, `height`, padding/margin/inset | pixels                 |
| `scale`, `scaleX`, `scaleY`                                        | multiplier (`1` = 100%) |
| `rotate`, `rotateX`, `rotateY`, `skewX`                            | degrees                 |
| `translateZ`                                                       | pixels                  |
| `arcStart`, `arcSweep`                                             | degrees                 |
| `arcWidth`                                                         | pixels                  |
| `opacity`                                                          | `0`–`1`                 |
| `bgColor`, `gradFrom`, `gradTo`, `borderColor`, `textColor`        | `u32` ABGR or hex string|

## Imperative: `spring()`

```ts
import { spring } from "@pocketjs/framework/animation";

spring(node, prop, to, preset): number
```

`spring` tweens to `to` with a physics spring — the duration comes from the physics,
not a timer, so there is no `dur`. `preset` is `"default"` or `"bouncy"` (bouncier,
more overshoot). It returns an `animId` like `animate`.

This is the `cards` demo's detail panel: it renders offscreen through a `style`
object, then springs into place on mount. Because the panel is a keyed `<Show>`
child it remounts per card, so the spring replays on every open:

```tsx
onMount(() => {
  if (el) spring(el, "translateY", 0); // springs up from +22px
});

<View ref={el} style={{ translateY: 22 }} class="p-3 rounded-xl bg-white">…</View>;
```

Setting the start value with a `style={{…}}` object and animating to the end value on
mount is the "enter" pattern throughout the demos.

## `cancelAnim()`

Stop a running tween with the id `animate()` / `spring()` returned:

```ts
import { animate, cancelAnim } from "@pocketjs/framework/animation";

const id = animate(streak, "translateX", 300, { dur: 20000, easing: "linear" });
// …later:
cancelAnim(id);
```

You rarely need this for one-shots — destroying a node frees its animation tracks
automatically.

## Declarative motion utilities

Add motion utilities to a `class` and the node tweens **whenever its style record is
swapped** — which happens on `focus:` / `active:` variant changes (switched natively,
zero JS) and when a dynamic `class` ternary swaps one full literal for another. The
core tweens only the animatable props that actually changed between the old and new
style.

Each `transition-*` utility compiles to a **u32 mask of anim bits** on the style
record: `transition` covers transforms, colors and opacity; `transition-colors`,
`transition-opacity` and `transition-transform` cover their own group;
`transition-all` sets every bit (`0xffffffff`), which includes the layout props,
so a `transition-all` across a `width` change relayouts on each tweened frame.
No mask reaches the 3D or arc props — see
[which props animate where](#which-props-animate-where). [Styling](/docs/styling/#motion) lists the tokens.

Tune the tween with:

- `duration-N` — duration in ms (`duration-150` = 150 ms). Default **150**.
- `delay-N` — delay in ms. Default **0**.
- `ease-*` — `ease-linear`, `ease-in`, `ease-out`, `ease-in-out`, `ease-spring`,
  `ease-out-back`. Default **ease-in-out**. (`spring-bouncy` is imperative-only.)

A literal with `duration`/`ease`/`delay` but no `transition-*` property utility
behaves like CSS's `transition-property: all`.

This `hero` button fades its background natively on focus and press — no JS runs on
the focus change at all:

```tsx
<View
  class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
  focusable
  onPress={() => setCount(count() + 1)}
>
  <Text class="text-base text-white font-bold">Press Circle</Text>
</View>
```

See [Styling](/docs/styling/) for the full utility set and [Input & focus](/docs/input-focus/)
for how focus moves between nodes.

## Baked keyframe timelines

For anything richer than a single tween — multi-stop choreography, staggered
sequences, loops — author `keyframes` and `animation` in `pocket.config.ts`, in the
exact shape of a `tailwind.config.js` theme:

```ts
// apps/<app>/pocket.config.ts
import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  theme: {
    keyframes: {
      "menu-open":  { from: { width: 38 }, "60%": { width: 144 }, to: { width: 141 } },
      "menu-close": { from: { width: 141 }, "60%": { width: 31 }, to: { width: 38 } },
    },
    animation: {
      "menu-pill": {
        value: "menu-open 0.6s ease-in-out 0.2s both, menu-close 0.6s ease-in-out 1.2s forwards",
        loop: "4000ms",
      },
    },
  },
});
```

An app directory's own `pocket.config.ts` wins over the repo-root one. Keep the
theme in it and nothing else: a `framework` key makes a manifest build throw
`framework belongs to pocket.json in manifest builds`, because the app's
`pocket.json` owns that choice.

```tsx
<View class="w-[38] h-[38] rounded-[19px] bg-white overflow-hidden animate-menu-pill" />
```

The compiler bakes every referenced animation into frame-precise, per-property
segment timelines inside `styles.bin`. At runtime the core never parses a string —
a timeline is pure data, sampled once per tick. Zero per-frame JS, byte-exact
across every host.

### CSS shorthand semantics

The `animation` value is the standard CSS shorthand, and its semantics survive the
bake:

- **Comma lists** with independent durations and delays.
- **Fill modes** — `forwards`, `backwards`, `both`; list precedence works the CSS
  way (the last animation currently *applying* a property wins, so an intro that
  fills forwards hands off to a later outro with no JS sequencing).
- **`reverse`** (baked as flipped segments) and **`infinite`**.
- **`cubic-bezier(x1, y1, x2, y2)`** plus the named easings (`linear`, `ease`,
  `ease-in`, `ease-out`, `ease-in-out`), which bake to their canonical browser
  curves.

### Keyframe properties

Keyframe declarations are CSS-in-JS (camelCase or kebab-case). Bakeable
properties: `opacity`, `width`/`height`, `top`/`right`/`bottom`/`left`/`inset`,
`padding`, `margin`, `gap`, `borderRadius`, `borderWidth`, `backgroundColor`,
`color`, `borderColor`, `letterSpacing`, `lineHeight`, the arc props
(`arcStart`/`arcSweep`/`arcWidth`) — and `transform` strings, which decompose
into per-property tracks:

```ts
"card-flip": {
  from: { transform: "rotateY(0deg) translateZ(0px)" },
  to:   { transform: "rotateY(180deg) translateZ(24px)" },
},
```

Supported transform functions: `translate()`, `translateX/Y/Z()`, `rotate()`,
`rotateX/Y()`, `skewX()`, `scale()`, `scaleX/Y()`. Mixed `scale()`/`scaleX()` keyframes
share one prop space (uniform scale decomposes to X + Y).

**Values must be build-time absolute.** A `translateX(-50%)`, `calc()` or
`var()` is a compile error, not a silent guess — the core has no reference box
at runtime. Write the resolved pixel value.

### The loop CSS cannot write: `animate-loop-[N]`

Plain CSS cannot say *replay this whole comma list — delays included — every
N milliseconds*. PocketJS adds a style-level loop period, either as the `loop`
key in the config (above) or inline:

```tsx
<View class="… animate-dpad-up animate-loop-[4000ms]" />
```

Every node's animation clock wraps modulo the period, so a whole page of tiles
restarts in sync — no remounts, no timers, no drift. `animate-loop-[…]` accepts
`ms` or `s` and must appear in the same literal as an `animate-<name>` (compile
error otherwise).

### Tailwind built-ins

`animate-spin`, `animate-ping`, `animate-pulse` and `animate-bounce` ship with
their standard Tailwind definitions (bounce's `-25%` translate is pinned to the
default `-6px`, since percentages don't bake).

## 3D transforms

A node with `perspective-[N]` becomes a **3D context root**: its subtree composes
3D transforms, projects through the root's perspective distance about the root
center, and painter-sorts into clipped triangles the GPU rasterizes.

| Utility | Effect |
|---|---|
| `perspective-[800]` | 3D context root; perspective distance in px |
| `rotate-x-[deg]` | rotation about the X axis |
| `rotate-y-[deg]` | rotation about the Y axis |
| `translate-z-[px]` | depth translation (positive = toward the viewer) |

```tsx
<View class="perspective-[800]">
  <View class="w-24 h-24 bg-blue-600 rotate-y-[35] translate-z-[-40]" />
</View>
```

All four take bracketed arbitrary values (negatives allowed). `rotate-N` without
an axis stays the 2D Z rotation. Transforms compose in a fixed canonical order —
scale, then skewX, rotate Y, rotate X, rotate Z, then translate — the common CSS idiom,
though not an arbitrary `transform:` function list: there is no `matrix3d()`,
`rotate3d()`, `scaleZ()`, or custom function ordering. `perspective` itself is a
static context property, not animatable.

`rotateX`, `rotateY` and `translateZ` animate through **baked timelines** and
**`animate()`** — the card-flip example above is the canonical use. See
[which props animate where](#which-props-animate-where) for why `transition-*`
can't drive them.

## Arcs

`arc-start-[deg]`, `arc-sweep-[deg]` and `arc-width-[px]` turn a node's
background into a round-capped annular sector — a stroke arc as a native
primitive, no SVG path renderer required:

```tsx
{/* a reload spinner: 315° of stroke, drawn from the background color */}
<View class="w-10 h-10 bg-blue-600 arc-start-[45] arc-sweep-[315] arc-width-[5]" />
```

All three are animatable (timelines and `animate()`), which is how the Motion
Lab reload study reproduces SVG `stroke-dasharray` drawing: the compiler samples
the dash motion into `arcStart`/`arcSweep` keyframe stops.

## Which props animate where

Every animation path gates on the same native animatable-prop set, with one
boundary worth knowing:

| Props | `animate()` / `spring()` | Baked timelines | `transition-*` classes |
|---|---|---|---|
| 2D transforms, colors, opacity, layout props | ✓ | ✓ | ✓ |
| `rotateX`, `rotateY`, `translateZ` | ✓ | ✓ | — |
| `arcStart`, `arcSweep`, `arcWidth` | ✓ | ✓ | — |
| `skewX` | ✓ | ✓ | — |

`ANIMATABLE` in `contracts/spec/spec.ts` is an ordered list whose index is a
prop's anim bit, and the transition mask is a u32. `rotateX`, `rotateY`,
`translateZ`, `arcStart`, `arcSweep`, `arcWidth` and `skewX` sit at **bits 32
through 38, past the end of that mask**, and the core's transition spawn loop skips every
bit ≥ 32 — so even `transition-all`, which sets the mask to `0xffffffff`, leaves
them alone. A `focus:rotate-y-[…]` swap snaps. Drive 3D and arc motion with a
baked timeline or `animate()`.

## Text caret

`createCaretBlink` from `@pocketjs/framework/animation` controls visibility
independently of caret geometry and the UI library. **Focus and input restart
the visible phase; a held drag keeps it visible.** Each phase defaults to
500 virtual milliseconds, so input replay controls blinking on every host.

```tsx
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createCaretBlink } from "@pocketjs/framework/animation";

const [caretVisible, setCaretVisible] = createSignal(false);
const blink = createCaretBlink({ onChange: setCaretVisible });
createEffect(() => blink.setActive(editorFocused()));
createEffect(() => blink.setHeld(draggingCaret()));
createEffect(() => { caretOffset(); draftText(); blink.reset(); });
onCleanup(blink.dispose);
// Bind caretVisible() to the caret node's opacity.
```

The controller starts inactive. It owns **one cancellable clock deadline**
while blinking and none while inactive or held; `onChange` runs only when
visibility changes. `intervalMs` sets the duration of each phase. Call
`dispose()` when the editor unmounts to cancel its deadline and hide the caret.
It performs no file access, network requests or wall-clock reads.

Try any of this live in the [playground](/playground/).
