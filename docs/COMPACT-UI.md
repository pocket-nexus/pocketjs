# Pocket Compact UI

`@pocketjs/framework/compact` is the kit for a small panel driven by keys:
the M5Stack CardputerZero's 320×170 screen and 46-key keyboard first, and
any buttons-only console after it. **A screen built with the kit shows one
task, keeps its state readable at a glance, and answers one vocabulary of
keys.** The reference application is Pocket Tools
([pocket-nexus/pocket-zero-tools](https://github.com/pocket-nexus/pocket-zero-tools)),
thirteen tools on the Zero's own sensors, radios, microphone, camera and
infrared port; `programs/cardputer-zero` runs it.

The kit is Solid components and hooks over the ordinary PocketJS tree:
absolute boxes, baked glyphs, the core's tweens. It adds no operation and no
capability; an application reads its hardware through its own worker. An application imports it with
`import { CompactApp, List, Gauge } from "@pocketjs/framework/compact"`.

## The frame

`CompactApp` draws three strips and holds a stack of scenes.

| Strip | Height | Content |
| --- | ---: | --- |
| Status bar | 18 px | The top scene's title at the left; the glance text at the right (battery and clock in Pocket Tools). |
| Body | 136 px | The top scene. Scenes under it stay mounted, hidden, with their state. |
| Hint bar | 16 px | The keys that act on this scene, as the scene names them with `useHints`. |

**The body is wide and short: 308 by 136 px inside the gutters. Height is
the scarce axis, so a screen spends its width first.** A readout sits
beside its instrument, not above it; a list row carries its value at the
right edge; the two things a screen is about share a row, one left and one
right (the time and the date, the tempo and the bar's beats, the count and
its last change); a grid fills each row across the full width. A single
reading centred on the screen with empty flanks is a layout to redo.

A scene is `{ title, hints, render }`. `useScenes().push(scene)` opens one
over the current; **Escape pops it, and at the root asks before leaving the
application** (`exit` on `CompactApp`); Escape held one second pops to the
root from any depth. A dialog (`confirm`) and a toast (`toast`) draw over
every scene. `useSceneActive()` is true while a scene is the top and no
dialog is open; a scene polls its device topic only then.

## Keys

The kit reads the keyboard's text events (`input.text`) in two passes. Raw
key handlers (`useKey`) come first: a `TextField` takes characters and
editing keys while it is active and returns true. What is left is read as
navigation (`useNav`):

| Key | Navigation | Without a keyboard |
| --- | --- | --- |
| Arrows; F, X, Z, C | up, down, left, right | d-pad |
| Enter | ok | ○ or START |
| Escape, Backspace | back (Escape held 1 s: home) | × (SELECT: home) |
| `/` | search | □ |
| Space | pause | START |
| Tab | action | △ |
| Shift + a direction | the same direction, `fine` | L or R + direction |

**F, X, Z and C stand for the arrows because the Zero's arrows sit on its Fn
layer and the vendor launcher reads these four keys the same way.** A held
direction repeats after 500 ms at 15 Hz; the kernel's own repeat events are
ignored. Handlers are scoped to the scene that registered them: the top
scene hears input, the ones under it do not, and an open dialog takes it
all. `KEY_LABEL` spells the keys for hints (`F/X`, `Enter`, `Esc`) and
spells the buttons on a console without a keyboard.

Left and right mean less and more, or previous and next, on every screen.
A list uses up and down; a value row uses left and right in place; a screen
with sections switches them with left and right and keeps up and down for
its list. A screen does not change what a key does while it stays up.

## Controls

| Control | Hook | Use |
| --- | --- | --- |
| `List` | `useListNav` | Find one item: label, optional detail line, right value, state dot. One focused row carries the wash and the accent bar; the list scrolls to keep it in view. 22 px a row, 30 with a detail line. |
| `ValueRows` | `useValueRows` | Settings: label and value, left and right adjust the focused row in place (`adjust(direction, fine)`), ok presses it. Chevrons show on an adjustable focused row. |
| `TextField` | (own `useKey`) | One line from the hardware keyboard: Enter submits, Escape cancels, Backspace deletes, Control+u clears. The caret blinks twice a second. |
| `ActionPad` | `useActionPad` | A grid of verbs: a remote's keys, a camera's shutter. The focused cell is filled with the accent. |
| `Detail` | | One large value with its unit and a few label/value rows. |
| `Progress`, `Panel`, `Chip`, `KeyValue` | | A bar, a box, a short state word in a tag (LIVE, HELD, REC), a dim label with an ink value. |

`createSelection(count)` is the clamped index the list hooks move;
`stepValue` and `cycle` are the arithmetic of value rows.

## Instruments

An instrument keeps the one physical metaphor that explains its value.

| Instrument | Shows | Metaphor kept |
| --- | --- | --- |
| `Digits` | A number in fixed-advance cells so changing digits do not jitter | Tabular numerals |
| `Gauge` | One large reading, its unit, a marker on a thin scale when the range is known | A panel meter |
| `Tuner` | A ruler sliding under a fixed centre pointer, the value above | A radio dial |
| `BubbleLevel` | Two rings, a crosshair, the bubble; cyan inside the inner ring | A spirit level |
| `TapeCompass` | Cardinal points and 15° ticks sliding past a lubber line, the bearing above | A tape compass |
| `SignalMeter` | Segments lit under the value, one held at the peak | A VU meter |
| `Bars` | Columns from the bottom or round the middle: spectrum, waveform, sparkline | A spectrum display |
| `RecorderStrip` | REC dot, elapsed time, level | A tape recorder |
| `StatusMatrix` | A grid of labels with a lamp or a short text each | An indicator panel |

Values arrive as accessors; an instrument redraws the bubble, the pointer or
the digits that moved and nothing else. **No instrument carries state by
colour alone: the chip beside it names the state in text.**

## Motion

Motion is declared by a control and run by the core (`animate` over the
retained tree, `motion.ts`): no JavaScript runs while a thing moves. Every
move is short and local, and finishes what a key press began. **At the
CardputerZero's 30 Hz a move of 150 ms is five frames; shorter moves read
as a jump, so no move is shorter.** The target's animation class picks what
a change may cost: on a repaint target (the Zero's CPU rasterizer) the kit
moves and scales opaque regions and makes large fades cuts; on a composited
target it adds the fades; on a still target every move is a jump.

| Move | Duration | Where |
| --- | ---: | --- |
| The focus cursor (wash and bar) between rows, tiles and cells | 150 ms | `List`, `ValueRows`, `AppGrid`, `ActionPad` |
| A list's rows sliding when the focus passes the view's edge | 160 ms | `List`, `ValueRows` |
| A pressed cell or tile dipping to 88 % and springing back, so the press shows before what it does arrives | 150 ms | `ActionPad`, `AppGrid`, `bump` (`Selection.press()`) |
| The section highlight between tabs; the new section's content sliding in 56 px from its side | 180 ms | `SectionTabs`, `SectionBody` |
| A pushed scene sliding in from the right, a popped one sliding out | 200 ms | `CompactApp` |
| A toast, a dialog or a search field rising into place | 180 ms | `CompactApp`, `arrive` |
| Tiles gliding and scaling to a new layout (a grid size, a filter); a tile that arrives growing into place | 260 ms | `AppGrid`, `flip`, `pop` |
| The bubble, the ruler, the tape following a reading | 120 ms | `BubbleLevel`, `Tuner`, `TapeCompass` |
| A marker or a bar following a value | 160 ms | `Gauge`, `Progress` |

A layout change plays as a move with `flip(node, from, to)`: the node is laid
out at its new rect, starts offset and scaled (about its centre) back onto
the old one, and glides home. A reading that is itself motion (the
spectrum, the waveform, the shake trace, the camera's viewfinder) is drawn
as it arrives; a digit changes as a cut. Nothing animates while nothing
happens.

**The panel must show every frame.** DRM emulates `/dev/fb0` for an SPI
panel (`panel-mipi-dbi`) with deferred I/O: the kernel collects the pages
written through the mapping and sends them 50 ms after the first write.
Measured on the Zero, that is 18 panel updates a second, so the frames of a
150 ms move merge into one or two. `platforms/linux/fbdev` calls `fsync` on
the framebuffer after each frame, which runs the flush at once (186 updates
a second when asked).

## Feedback

A key press shows within one frame: the focus moves, the chip changes, the
digits step. Work that takes longer shows its own state until it lands:
`SCANNING` with the last results still listed, `TAKING` with the shutter
veil, `SENDING` on the infrared pad. A result names what happened and no
more: `Sent` says the port transmitted, not that the television received.
A failure names its reason in the hint bar's tone of pink and keeps the
screen where it was. An irreversible action (delete a recording, a learned
key) confirms through a dialog whose destructive button is pink and not
chosen first.

## Tokens

`tokens.ts` holds every size and colour: the three strips, 6 px gutters,
22 px rows, 18 px buttons, the font slots (10 to 54 px), the plum
background `#171226`, the accent `#ffd23f` for focus and the value under
the hand, cyan `#3fd0e8` for a good state, pink `#ff7fb4` for a warning.
Text that arrives at run time folds to ASCII (`toAscii`) before it reaches
a `<Text>`, since the atlases hold the bundle's literals and printable
ASCII; `wrap` and `ellipsize` fit paragraphs and labels to measured widths.

## The launcher

A Home that must hold many tools keeps the same rules as every other
screen: one vertical direction, one vocabulary, one glance, the width spent
first. **`AppGrid` lays tiles out in fixed columns that share the row, so
every column keeps one x down the grid and only the last row is short; each
tool appears once.** The grid grows downward as tools are added; nothing
pages sideways. A tile is an icon, a name and one glance value (the time on
Clock, the battery on System, the network on Radio, what is missing on a
tool that cannot run, nothing otherwise). Pocket Tools orders its tiles by
group and names no group on screen.

**Tab steps the grid through three sizes (`GRID_SIZES`), and + and - step
it one way; every tile glides and scales from its old place to its new one
over 260 ms, the cursor and the scroll with it.**

| Size | Tiles a row | Tile | Text on a tile |
| --- | ---: | --- | --- |
| Large | 4 | 74 x 59, 32 px icon; two rows fill the 120 px grid | the name in 12 px bold and the glance value |
| Medium | 5 | 59 x 50, 24 px icon | the name in 10 px and the glance value |
| Small | 8 | 36 x 36, 24 px icon; two rows hold all thirteen tools | none; the line under the grid names the focused tool |

**FXZC move (up and down keep the column), Enter opens, and coming back the
cursor is on the tool that was open.** `/` opens a search field that filters
the grid by name, group and summary as the letters arrive: the matches
glide to the front, and Enter opens the first. With dozens of tools the
keyboard is the fast path, not scrolling. The grid keeps a tile in the tree
by identity, so an application passes the same `GridTile` object for the
same app across layouts. A new tool is one row in the registry and one
baked icon.

## Pocket Tools

Pocket Tools lives in its own repository,
[pocket-nexus/pocket-zero-tools](https://github.com/pocket-nexus/pocket-zero-tools):
the tools, their screens, the worker that reads the device API
(`programs/cardputer-zero/src/device/`, `http://zero/dev/<topic>` on the
worker's `http` node), the camera on the video plane, and the CardputerZero
Store package. `programs/cardputer-zero/README.md` has the device facts.
