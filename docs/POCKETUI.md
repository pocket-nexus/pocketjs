# PocketUI: `@pocketjs/framework/ui`

PocketUI is a UI layer for Solid applications on PocketJS. An application states what it is made of (panes, a feed, commands, a place to compose text, things that can be moved onto other things) and names parts (a bar, a selected row, the default button, a field) without a colour, an edge or a font. Two things decide what the user sees:

- **The surface** decides the idiom of each semantic: columns or one pane at a time, a button legend or bar controls, a drag or a pick-up with a button. An idiom is chosen only when every step of it has an input on that surface.
- **The theme** paints the parts and arranges the ones whose place is a matter of tradition. Four ship: Pocket, Classic 98, XP and Aqua. `ui.setTheme` changes the theme under a running application; a draft, a caret, a scroll position and the focus stay where they were.

`apps/pocketui` is the gallery: every part on one page, built for the PSP (buttons, no touch), the 3DS runtime (the touch screen as the auxiliary surface), an iPhone, a macOS widget and the web. `bun tools/pocketui-sim.ts --target <host>` runs it on the simulation host.

## Why it lays out its own tree

PocketJS gives an application `View`, `Text` and `Image` under a flexbox whose rectangles do not reach JavaScript. A transcript, an editor and a multi-pane tool need four things that base does not have:

| Needed | PocketJS core | PocketUI |
| --- | --- | --- |
| The size text takes | A text run breaks at `\n` only | Breaks lines over `measureText` (`core/text.ts`, `core/rich.ts`): **a paragraph's height is known before it paints** |
| Rows of unknown height, in thousands | `VirtualList` takes one `rowHeight` | `Feed`: rows measured as they mount, the reader's place kept by an anchor (`core/feed.ts`) |
| A text field | `TextField` is one line with a caret index | `TextEditor`: caret, selection, IME preedit, atomic tokens, undo (`core/editor.ts`) |
| Where things are | Focus moves in document order | Every element's rectangle is known: focus moves by direction, a pan finds the scroll view under it, a menu opens beside its control |

PocketUI owns one native view the size of its surface and positions every node under it. The kinetic scroller, the gesture recognizer, the animation tracks and the renderer are PocketJS's.

## Mounting

```tsx
import { mountPocketUI, useUI } from "@pocketjs/framework/ui";

mountPocketUI({ children: () => <App /> });
```

`mountPocketUI` draws on the auxiliary surface when the build has one (a dual-screen handheld's touch screen) and on the primary display otherwise. `<PocketUI surface="primary">` mounts the tree where an application places it. Components read the surface with `useUI()`: `env()`, `idioms()`, `metric()`, `theme`, `setTheme`, `input`, `commands`, `transfer`, `resize`.

**A resize lays the same tree out again and nothing remounts.** PocketUI follows `onViewport` (host.ts) on the primary surface and `onAuxiliaryViewport` (display.ts) on the auxiliary one; `ui.resize(width, height)` does the same for a host with a channel of its own. A window made narrow goes from `split` to `stack` with each pane's place, draft and focus kept.

## Elements, instances, one layout pass

A component returns an **element** (`{ kind, props }`, the props as Solid's getters). A container makes each child element live as an **instance**: it owns one native node, positions it, and knows its rectangle.

```tsx
import { HStack, Text, VStack } from "@pocketjs/framework/ui";

function Row(props: { title: string; detail: string; age: string }) {
  return (
    <HStack part="row" padding={[7, 10]} spacing={8} onPress={open}>
      <VStack grow={1} spacing={1}>
        <Text role="strong" lines={1}>{props.title}</Text>
        <Text role="caption" lines={1}>{props.detail}</Text>
      </VStack>
      <Text role="caption">{props.age}</Text>
    </HStack>
  );
}
```

- `measure(maxW, maxH)` returns the size wanted, cached per offer; `place(x, y, w, h)` writes the rectangle.
- A prop that changes a size invalidates the path to the root; a prop that only paints sets one native prop and runs no layout.
- **One pass per frame** measures and places what was invalidated. A feed that learns a row's height in a pass may ask for a second pass in the same frame.

Sizes are points. There are no percentages and no classes.

## Environment and idioms

`core/env.ts` separates facts from choices. The **Environment** is what the surface can do: its width class (`compact` under 420 points, `regular`, `expanded` from 560, `wide` from 840), contacts, buttons, a pointer that hovers, keys, where typed text comes from, and what a frame costs. **Idioms** are what each semantic becomes there:

| Semantic | Idioms | Chosen by |
| --- | --- | --- |
| Panes | `stack` · `split` · `triple` | width class |
| Commands | a legend · bar controls · key chords · a menu as a sheet or a popover | buttons · contacts · keys · a pointer |
| Composing text | `inline` · `dock` | where text comes from |
| Moving a thing | `drag` · `carry` | contacts or not |
| A change of pane | `follow` the contact · `animate` · `cut` | contacts · what a frame costs |
| Density | `compact` · `regular` | size class |

`tests/pocketui/env.test.ts` states the result for six surfaces.

## Input

`ui/input.ts` reads PocketJS's input once per frame:

- **Contacts** go through one gesture recognizer for the surface. A tap presses the deepest pressable under it; a pan goes to the deepest scroll view that can move that way; a long press lifts a transferable item.
- **The pointer** (`input.pointer`, pointer.ts `pointer()`) at rest with no button down is hover: the part under it takes its `hovered` look. Its press arrives as a contact.
- **The wheel** (`input.scroll`, `onScroll`) moves the deepest scroll view under the pointer that can still move that way, and consumes the delta.
- **The d-pad** moves one focus to the nearest control in the pressed direction. The focus ring shows after a button was used and hides at the next contact.

## Commands

```ts
useCommands(() => [
  { id: "session.new", title: "New Session", short: "New", button: "action", key: "Control+n", bar: true, run },
  { id: "session.stop", title: "Stop the Agent", short: "Stop", button: "action", bar: true, destructive: true, disabled: !running(), run },
]);
```

A command is declared once and every surface offers it: a free button by intent (`action` is Triangle or X, `option` Square or Y, `menu` START) with the legend naming what each button does now; bar controls where contacts land; a chord on a keyboard. **A button never means two things by how often or how long it is pressed.** The legend prints the device's own marks (`modality.ts glyph()`); the build bakes them into the atlases (`tools/build.ts`).

## Text

`Text` wraps one style; `RichText` wraps several, breaking at spaces, on either side of a CJK character and never before closing punctuation. The type ramp is five baked slots. A character is drawn in the baked face when the pack's atlas for that slot holds it (`font-coverage.ts`).

Everything else is drawn from two **run-time faces** (slots 21 and 22) that an application turns on with `installRuntimeText({ density, transport })`. The transport is the host product's way to a glyph service: it takes `{ px, bold, slot, density, text, ascii: false }` and returns a FONT ATLAS of those characters, which PocketUI loads with `loadFontAtlas`.

- A paragraph is set **by run**: ASCII in the baked face of its role, a CJK character or a word with a letter outside ASCII in the run-time face, on one line.
- **A run-time face only grows.** A text names its characters; those the face lacks are requested, a few hundred per request. A reply holds the new glyphs, and what arrived by a frame loads as one atlas. Scrolling back over text costs no request. Past `capacity` (4096 glyphs) the glyphs no mounted text named for longest are dropped.
- Widths come from the face's table. A character on its way is an empty advance of the face's size, the width a CJK glyph arrives with, so a line does not move when it arrives.

A glyph is a codepoint and text runs left to right: no shaping, no joining, no right-to-left. `core/glyphfont.ts` and `core/runtimefaces.ts` run without a host; `ui/runtimetext.ts` binds them to it.

`Markdown` maps a parsed document (`core/markdown.ts`) to elements. A block that only grew keeps its element, so a streamed answer lays out its last block.

## Themes

An element says what it is with `part` and its state with `selected`, `variant`, `tone` and `disabled`. The theme answers with a `Paint`:

| A theme gives | What it is | Where |
| --- | --- | --- |
| `paint(part, state)` | Fill or gradient, border or bevel rings, radius, shadow, layers under the content, padding, how far content sinks when pressed | `Paint`, 45 parts in `PARTS` (`core/theme.ts`) |
| Ink | Text and mark colour by meaning (`tone`) | `Paint.ink` |
| Faces | The type ramp by role | `Theme.face` |
| Metrics | Bar, title bar and status heights, row padding, a push control's height | `Metrics` |
| Marks | A close box, a check, a chevron, drawn from rectangles | `Theme.glyph`, `core/glyphs.ts` |
| Traits | Title bar and its controls, commands in a menu bar or a pane's bar, scroll bar form, menus as sheets or windows, the default button's place | `Traits` |

**What a tradition arranges differently, the application does not draw.** It states what a dialog does (`actions`), not where its buttons go; what is chosen from what (`Picker`), not a row or a popup; the theme's metrics size every control. Nothing in an application or in the kit asks which theme is active. What holds state (a scroll view, a field, a pane) is made once and stays in the tree; stateless chrome is made again for a theme that arranges it differently.

`defineTheme({ color, face, metric, traits, parts, glyphs })` writes a theme. `tests/pocketui/theme.test.ts` checks every shipped theme: every part in twenty states, colours the core parses, text that reads on its ground, marks inside their boxes, and gloss layers inside a rounded part's rim. The four themes are original drawings in PocketJS primitives and contain no artwork from an operating system.

### The pixel face

Classic draws in a bitmap face where the pack carries it. `tools/pocketui-pixel-font.ts` bakes W95FA (`assets/fonts/W95FA.otf`, SIL OFL 1.1) into atlases for slots 20 and 23 at densities 1 to 4 (`assets/fonts/pocketui/`). An application lists them in a `pak.json` beside its entry and sets the theme in them:

```json
[
  { "key": "ui:font.20", "file": "<pocketjs>/assets/fonts/pocketui/pixel-20.bin" },
  { "key": "ui:font.23", "file": "<pocketjs>/assets/fonts/pocketui/pixel-23.bin" }
]
```

```ts
const classic = withFaces(CLASSIC_THEME, PIXEL_FACES);
```

**At density 3 the two atlases add 536 KiB to a pack.** Without them `CLASSIC_THEME` uses the baked sans.

## Cost

Measured on the gallery (`apps/pocketui`, 112 modules):

| | |
| --- | --- |
| Guest bundle | 465 KB, 213 KB with `POCKETJS_MINIFY=1` |
| Pack at density 1 (five slots, two pixel atlases) | 197 KB |
| Pack at density 3 | 1.7 MB |

On the PSP (the v0.17.0 `psp-runtime` in PPSSPPHeadless, frame intervals read from `Date.now()` in emulated time):

| | |
| --- | --- |
| Idle | 16.7 ms a frame, the same as `apps/stats` on the same runtime |
| A focus move that scrolls the page | about 7 ms of JavaScript; 16.7 ms a frame on average over 50 moves, 65 ms the longest frame |
| A change of theme | one frame of 0.2 to 0.33 s, then 16.7 ms |

**At one pixel to the point PocketUI draws marks and rings from the core's rectangles** (`ui/raster.ts`). Sampling their coverage in JavaScript on the PSP, which has no double-precision unit, made the first change to a theme 8 to 22 s long.

## Files

| Path | Contents |
| --- | --- |
| `framework/src/pocketui/core/` | No host imports: line breaking, the feed model, focus picking, Environment and idioms, commands, the editor model, Markdown, run-time faces, the theme contract |
| `framework/src/pocketui/themes/` | `pocket` `classic` `luna` `aqua`, `THEMES`, `themeById` |
| `framework/src/pocketui/ui/` | The engine (elements, instances, layout, hit testing), input, text views, scroll, feed, panes, editor, presentations, transfer, commands, the kit, mounting |
| `tests/pocketui/` | Unit tests of `core` and the themes |
| `tests/pocketui-sim.test.ts` | The gallery on the simulation host: buttons on the PSP, the 3DS touch screen, a desktop pointer and wheel, a resize |
| `tools/pocketui-sim.ts` | Builds an application for one host and drives it by steps; an application repository imports `buildApp`, `bootSim` and `runSteps` |

## Limits

- **`dock` is resolved but not drawn.** A surface whose text comes from an on-screen keyboard the application must draw gets the idiom and no keyboard; `Osk` is not embedded yet.
- **A theme cannot round one corner.** The core's radius is one number per box, so a title bar's top corners are square.
- **No images.** Controls are text and shape; a theme's gel is a gradient under a gloss layer.
- **Focus crosses a feed's mounted rows only.** Past the last mounted row the d-pad scrolls the feed.
- **A Pocket3D overlay uses `themes/desktop`.** An overlay's pointer arrives over the `pocket.overlay` service (`overlay-host.ts`), which PocketUI's input does not read.
