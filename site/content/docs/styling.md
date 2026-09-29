# Styling

PocketJS styling is a **build-time Tailwind subset**. The classes you write are
not CSS: at build time the compiler parses each class literal, turns it into a
binary style record, and packs the whole table into `styles.bin` inside your
app's `.pak`. At runtime the renderer resolves a class attribute to a numeric
`styleId` and hands that to the Rust core through `setStyle`.

There is **zero runtime CSS**: no CSS parser, no cascade, no property strings on
the device. A class is an integer index into a table that was resolved and
frozen at build time.

`animate()` and the timeline format behind `animate-*` are on
[/docs/animation/](/docs/animation/).

## The pipeline

`bun tools/build.ts <app>` is a two-pass build, and the class compiler runs
**between the two passes** (see [/docs/build-pipeline/](/docs/build-pipeline/)):

1. Pass 1 (babel) walks every `.tsx`/`.ts` reachable from the app entry and
   collects **candidate class strings** from the AST — every string literal,
   every template-literal quasi, and every chunk of JSX text.
2. `compileClasses` in `framework/compiler/tailwind.ts` parses each candidate.
   The candidates that parse become style records; records that encode to the
   same bytes collapse to one `styleId`.
3. The table is encoded to `styles.bin` for the `.pak`, and the class-literal →
   `styleId` map (`STYLE_IDS`) plus the font-slot metadata become a generated
   module.
4. Pass 2 (`Bun.build`) bundles the app, with the JSX plugin serving that
   generated module **from memory** — two target builds running at once cannot
   read each other's table. `tools/build.ts` writes
   `framework/src/styles.generated.ts` as a mirror for inspection; the bundle
   does not read that file from disk, and pass 1 skips it.

`styles.bin` ships in the `.pak`. On PSP the native pak walker feeds it to the
core; on the browser and headless Bun hosts it arrives through the `loadStyles`
op ([/docs/native-contract/](/docs/native-contract/)).

## The all-or-nothing rule

The compiler sees every string literal in your source, not only `class`
attributes, so it needs a rule for deciding which strings are styles:

> A class literal compiles to a style record **if and only if every
> whitespace-separated token is a supported utility.** If one token is not a
> utility, the whole literal is text and produces no record.

```tsx
"flex-col items-center gap-4 p-4"   // every token is a utility -> style record
"Ready to play"                     // no token is a utility   -> plain text
"flex the muscles"                  // one bad token ("the")    -> no record
```

A label like `"flex the muscles"` never turns into a layout: one unrecognized
token disqualifies the literal, with no diagnostic. Some literals that do parse
fail the build instead — see [Loud errors](#loud-errors).

## How a class attribute resolves

`framework/src/styles.ts` owns the runtime lookup, and it is not an exact-string
match:

- Every registered key and every query is normalized first: trimmed, with runs
  of whitespace collapsed to single spaces.
- The compiler's literal, after normalization, is registered **verbatim**.
- Each literal also registers a **token-sorted alias**, so `"a b"` resolves the
  id registered for `"b a"` when only one of the two spellings appears in your
  source. Verbatim registrations win over aliases.
- When two literals share a token multiset but compile to different records
  (`"p-2 px-4"` against `"px-4 p-2"`, which differ under last-wins), the alias
  is poisoned with `ALIAS_AMBIGUOUS` and only the verbatim spellings resolve.

A class string the compiler never saw resolves to nothing: a host in strict mode
throws ``unknown class "…"``, every other host counts it in
`missCounters.unknownClass` and leaves the node's style alone. A `class` value
that is not a string throws. `class={null}` and `class=""` clear the node with
`setStyle(id, STYLE_ID_NONE)`.

## Dedup

Within a literal, declarations are deduplicated **last-wins** — a later token
overrides an earlier one for the same property — and then sorted by property id,
so `"p-2 bg-red-500"` and `"bg-red-500 p-2"` encode to identical records and
share one `styleId`. Records are deduplicated across the whole app: one set of
utilities at fifty call sites costs one entry in `styles.bin`.

## Variants: `focus:` and `active:`

`focus:` and `active:` compile into the **same** record as separate blocks. A
state change is one op — `setFocus(id)`, or `setActive(id, 0|1)` from the press
latch in `framework/src/input.ts`, which the CIRCLE edge detector, the virtual
cursor and touch all route through. The core re-resolves that node's style from
the record it holds: no component re-runs, no tree reconciliation, no
per-property writes from JS. `set_active` on a record with no `active:` block
flips the flag without retargeting, so a press cannot restart an in-flight
transition.

```tsx
<View class="p-2 bg-blue-600 focus:bg-blue-500 active:scale-95 transition-colors" focusable onPress={() => {}} />;
```

Under touch the `active:` variant is held from the contact's down edge and
cleared once another recognizer claims that contact, which is why a row's
pressed look drops away when the list starts scrolling
([/docs/touch-gestures/](/docs/touch-gestures/) for the claim model,
[/docs/input-focus/](/docs/input-focus/) for how focus moves).

Any utility below can carry a variant prefix, with one exception: motion and
`animate-*` tokens are recognized on the base variant only, so `focus:transition`
drops **the whole literal** to plain text with no diagnostic. A prefix that is
not `focus:`, `active:` or `hover:` does the same.

## Dynamic styling

Styles are frozen at build time, so a class string cannot be assembled at
runtime. There are three escapes:

**1. Ternaries of full class literals.** Both branches must be complete literals
the compiler can see:

```tsx
import { View } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

const [armed] = createSignal(false);
<View class={armed() ? "p-2 bg-red-500" : "p-2 bg-slate-700"} />;
```

Each branch compiles on its own; the renderer swaps the resolved `styleId` when
the signal changes, which also fires any transition on the new record.

**2. `style={{ … }}` objects.** Keys are spec `PROP` names (`translateX`,
`bgColor`, `radius`), not CSS names, and an unknown key throws. Each key is
compared against the previous frame and changed keys are pushed as one
`setProp`. Dropping a key does not reset the property — write the resting value.

**3. `animate()`.** Declarative motion driven per tick in the core — see
[/docs/animation/](/docs/animation/).

## Loud errors

These parse as class literals and then fail the build, rather than dropping to
text:

| Pattern | Raised by | Do this instead |
|---|---|---|
| `classList={{ … }}` | pass-1 babel | Ternary of full literals |
| ``class={`a ${b}`}`` (template-interpolated) | pass-1 babel | Ternary of full literals |
| `hover:…` | class compiler | `focus:` / `active:` — no pointer on PSP |
| `rounded-full` with no `w-N`/`h-N` in the same literal | class compiler | Pin a build-time size |
| `bevel-*` together with any `rounded*` | class compiler | Drop one — bevels are square-only |
| `animate-loop-[…]` with no `animate-<name>` | class compiler | Name the animation in the same literal |
| `text-lg font-mono` (mono has 12/14/16 only) | class compiler | Use a mono size |

`classList` and template interpolation are caught by the babel pass over the
JSX, which prints a code frame at the attribute. The rest come from the class
compiler once every other token in the literal has parsed, and they quote the
literal — a stray phrase like `"hover over here"` is text and errors nowhere.

## Spacing scale and arbitrary values

Sizing, spacing and offset utilities take Tailwind's spacing scale, where step
**N is `N * 4` pixels**: `p-2` is 8px, `gap-4` is 16px, `w-12` is 48px. Decimals
count (`p-2.5` is 10px).

Every spacing-scale utility also takes a bracketed pixel value, with the `px`
suffix optional: `w-[123]`, `h-[123px]`, `p-[10]`, `gap-[6px]`. **Bracketed
values may be negative** (`top-[-10px]`, `translate-x-[-8]`); scale steps may
not, because a leading `-` fails to parse (`-mt-2` is not a utility, and it
takes the literal down with it).

A second group takes a **plain non-negative number** and no brackets: `z-N`,
`opacity-N` (0–100), `scale-N`, `scale-x-N`, `scale-y-N`, `rotate-N`,
`duration-N`, `delay-N`.

## Colors

Colors come from the Tailwind v3 default palette: `{family}-{shade}`, plus
`white`, `black` and `transparent`.

**Families:** `slate`, `gray`, `zinc`, `red`, `orange`, `amber`, `yellow`,
`green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`,
`fuchsia`, `pink`, `rose`. **Shades:** `50`–`950` in Tailwind's eleven steps.

The prefixes that take a color are `bg-`, `text-`, `border-` (which also sets a
1px width), and the gradient stops `from-`, `via-`, `to-`. Each of them also
takes an **arbitrary hex** value in brackets — 3, 6 or 8 digits, the last pair
being alpha: `bg-[#888]`, `text-[#8899aa]`, `border-[#00000080]`.

An unrecognized family or shade (`bg-slate-999`, `text-brand-500`) does not
parse, so the literal is text.

## Layout and box

| Utility | Effect |
|---|---|
| `flex` | `display: flex` |
| `flex-row` \| `flex-col` | main axis |
| `flex-wrap` | allow wrapping |
| `flex-1` | grow 1, shrink 1, basis 0 |
| `grow` \| `grow-0` \| `shrink-0` | grow/shrink factors |
| `basis-N`, `gap-N` | flex basis, gap (spacing scale) |
| `justify-start` \| `-center` \| `-end` \| `-between` \| `-around` | main-axis distribution |
| `items-start` \| `-center` \| `-end` \| `-stretch` | cross-axis alignment |

| `w-N` \| `w-full` \| `w-[px]` | width |
| `h-N` \| `h-full` \| `h-[px]` | height |
| `min-w-N`, `min-h-N`, `max-w-N`, `max-h-N` | min/max size (no `-full` form) |
| `p-N`, `px-N`, `py-N`, `pt-N`, `pr-N`, `pb-N`, `pl-N` | padding |
| `m-N`, `mx-N`, `my-N`, `mt-N`, `mr-N`, `mb-N`, `ml-N` | margin |
| `absolute` \| `relative` | position type |
| `inset-N`, `top-N`, `right-N`, `bottom-N`, `left-N` | position offsets |
| `hidden` | `display: none` |
| `overflow-hidden` | clip children (native scissor) |
| `z-N` | z-index |

Those five `justify-*` and four `items-*` values are the whole set — no
`justify-evenly`, no `items-baseline`. `w-full` / `h-full` are the only
percentage-style sizes; `p-N` and `m-N` fan out to four sides, `px`/`py` and
`mx`/`my` to the two axes.

## Visual

| Utility | Effect |
|---|---|
| `bg-{color}` | background color |
| `bg-gradient-to-t` \| `-b` \| `-l` \| `-r` | gradient direction (cardinal only) |
| `from-*`, `via-*`, `to-*` | gradient stops; `via-*` sits at 50% |
| `rounded` | 4px radius |
| `rounded-sm` \| `-md` \| `-lg` \| `-xl` | 2 / 6 / 8 / 12px |
| `rounded-[N]` | arbitrary radius in px |
| `rounded-full` | pill/circle — build-time size required |
| `opacity-N` | opacity, `N/100` |
| `shadow` \| `shadow-md` \| `shadow-lg` | the three shadow steps |
| `border` | 1px border |
| `border-2` \| `border-4` \| `border-8` \| `border-[N]` | border width in px |
| `bevel-[#light,#dark]` | classic-chrome outer bevel ring |
| `bevel-[#a,#b,#c,#d]` | outer light/dark then inner light/dark |
| `bevel-w-[N]` | per-ring bevel width, default 1px |

`transition-colors` interpolates the background, text, border, `from-*` and
`to-*` colors; the `via-*` stop is not animatable.

**`rounded-full`** bakes an exact radius at build time, so the **same literal**
must pin both `w-N` and `h-N` (or their bracketed forms); the radius becomes
`min(w, h) / 2`. `w-full` is not a build-time pixel size, so
`w-full h-12 rounded-full` is a compile error.

```tsx
<View class="w-12 h-12 rounded-full bg-slate-700" />   // radius baked to 24px
```

**Bevels are square-only.** `bevel-*` in a literal that also has any `rounded*`
token is a compile error.

## Text

| Utility | Effect |
|---|---|
| `text-{color}` | text color |
| `text-xs` \| `-sm` \| `-base` \| `-lg` \| `-xl` \| `-2xl` \| `-4xl` \| `-5xl` | 12 / 14 / 16 / 18 / 20 / 24 / 36 / 54 px |
| `font-bold` | bold weight of the same size |
| `font-mono` | JetBrains Mono at slots 16–18: sizes 12/14/16 only, regular weight only |
| `text-left` \| `text-center` \| `text-right` | horizontal alignment |
| `leading-N` | line height (spacing scale or arbitrary px) |
| `tracking-wide` | letter spacing = `0.025 × font-size` |

A text-size utility selects a **baked font-atlas slot**, not a free number:
slots 0–6 are the regular sizes, 7–13 their bold pairs, 14/15 the 54px pair,
16–18 monospace. There is no arbitrary font size. Text with no size or weight
utility uses **16px regular**.

`font-mono` overrides weight — `font-mono font-bold` lands on the mono slot for
its size — and a mono size with no slot throws at build time: `text-lg font-mono`
gives ``no monospace font slot for 18px``.

The default faces are Inter regular/bold and JetBrains Mono
(`framework/compiler/bake-font.ts`); `--font-regular` / `--font-bold` on the
build override them, and `assets/fonts/` also ships InterDisplay and W95FA.

## Transform

Transforms are animatable and do not trigger relayout — prefer them for motion.

| Utility | Effect |
|---|---|
| `translate-x-N`, `translate-y-N` | translate (spacing scale or arbitrary px) |
| `scale-N`, `scale-x-N`, `scale-y-N` | scale, `N/100` (`scale-105` → 1.05) |
| `rotate-N` | 2D rotation in degrees |
| `origin-center` \| `-top` \| `-bottom` \| `-left` \| `-right` \| `-top-left` \| `-top-right` \| `-bottom-left` \| `-bottom-right` | transform origin, as a fraction from the node center |
| `rotate-x-[N]`, `rotate-y-[N]` | 3D rotation, degrees (bracket-only) |
| `skew-x-[N]` | horizontal shear about the transform origin, degrees (bracket-only) |
| `translate-z-[N]` | 3D depth, px (bracket-only) |
| `perspective-[N]` | 3D context root; distance in px (bracket-only, > 0) |

A `perspective-[N]` root projects its subtree through that distance and
painter-sorts the result ([3D transforms](/docs/animation/#3d-transforms)).

## Arc

`arc-*` strokes a round-capped annular sector from the node's background color.
All three are animatable through timelines and `animate()`.

| Utility | Effect |
|---|---|
| `arc-start-[N]` | start angle, degrees |
| `arc-sweep-[N]` | sweep angle, degrees |
| `arc-width-[N]` | stroke width, px |

## Motion

A motion token attaches a transition block to that style. Transitions fire when
the style is swapped — a `focus:` / `active:` variant swap included — and
interpolate the animatable properties in the mask.

| Utility | Effect |
|---|---|
| `transition` | colors, opacity and 2D transforms |
| `transition-all` | every animatable property |
| `transition-colors` | bg / text / border / gradient colors |
| `transition-opacity` | opacity |
| `transition-transform` | translate / scale / rotate (2D; 3D and arc props have no transition-mask bit — use timelines or `animate()`) |
| `duration-N`, `delay-N` | milliseconds, 0–65535 |
| `ease-linear` \| `-in` \| `-out` \| `-in-out` \| `-spring` \| `-out-back` | easing curve |
| `animate-<name>` | a baked keyframe timeline from `theme.animation` (built-ins: `spin`, `ping`, `pulse`, `bounce`) |
| `animate-loop-[Nms]` \| `[Ns]` | whole-choreography loop period; needs `animate-<name>` in the same literal |

**Defaults.** With any motion token present, unspecified fields fall back to
duration **150ms**, delay **0ms**, easing **in-out**. The mask defaults to every
animatable property; the bare `transition` shorthand is the one that narrows it
to colors, opacity and 2D transforms, so `duration-200 ease-out` on its own
animates everything animatable.

`duration-N` and `delay-N` stay in milliseconds and convert at runtime.
`animate-*` timelines are baked in **frames** against the bundle's declared tick
rate (`--hz=N`, 1–240, default 60).

## Native text layout

Baked atlases are the portable path. An app that lists `text.layout.native` in
the `enhances` block of its `pocket.json` gets host measurement and shaping
instead, on any target whose profile registers that capability in
`contracts/spec/platforms.ts` — read the registry, not a list of hosts. The host
installs a core text measurer before the guest mounts (`Ui::set_text_measure`),
and one provider then feeds taffy leaf sizes, the `measureText` op and the
painted glyphs. What changes for your classes:

- Text-size, `font-bold` and `font-mono` still pick the slot; the host resolves
  the family and the metrics for it (Inter and JetBrains Mono from
  `assets/fonts/` by default, with the OS fallback chain behind them).
- Coverage is the OS fallback chain — CJK, emoji, everything — with no runtime
  atlas baking and no tofu.
- A literal with no `leading-N` takes its line height from the host font, not
  from the baked cell.
- Tracked (`tracking-wide`), scaled and rotated runs keep the baked glyph pair,
  so measurement and glyphs come from one provider per node.

Pixels stay deterministic per host but are not byte-comparable across hosts in
this mode: rasterization, metrics and fallback fonts belong to the OS. That is
why the id is separate from `text.glyphs.baked` — see `docs/BACKENDS.md`.

## See also

- [/docs/animation/](/docs/animation/) — baked timelines and `animate()`
- [/docs/build-pipeline/](/docs/build-pipeline/) — how `styles.bin` is built
- [/docs/native-contract/](/docs/native-contract/) — `setStyle`, `setProp`, `setFocus`, `setActive`
- Try classes live in the [playground](/playground/)
