---
name: pocket3d-interface
description: Build the 2D interface of a Pocket3D game (title, HUD, menus, settings, touch controls, a second screen) as one PocketJS app drawn over the scene, with one presentation per device shape (PSP, PS Vita, Nintendo 3DS, iPod touch). Use when a Pocket3D game draws text, gauges or menus from its renderer, when debug text or a status line is what a player sees, when adding a console target, a menu, a setting or a touch control to a game, or when reviewing a game's HUD.
---

# Pocket3D interface

## Overview

A Pocket3D game has two layers on the screen. The renderer draws the scene.
**Every 2D pixel that is not anchored to a point of the world comes from one
PocketJS app**, compiled per device and drawn over the scene by that device's
PocketJS host library. The renderer draws no text.

| Layer | Owns | Lives in |
| --- | --- | --- |
| Renderer (Rust or C, per console) | simulation, scene, marks anchored to the world (a target's distance, a lock-on ring) | the game's device crates |
| Interface (PocketJS app) | title, HUD readouts, lists, settings, map, touch controls, loading and error screens | `ui/` in the game repository |
| Flow (one Rust type) | which mode the screen is in, what the pad means in each mode, what a command does | one `no_std` crate shared by every device |

A line of text drawn by the renderer for a developer (frame time, triangle
count, key hints) is not an interface. It reaches the screen as a member of
the state the interface is sent, behind a setting the player turns on.

Three documents state the rules this skill applies:
[`docs/MODALITY.md`](../../docs/MODALITY.md) (modality and presentations),
[`docs/HIG.md`](../../docs/HIG.md) (intents, the buttons guideline, the touch
guideline) and
[`docs/POCKET3D-UI-OVERLAY.md`](../../docs/POCKET3D-UI-OVERLAY.md) (the same
overlay on the desktop renderer).

## The parts

| Part | What it is |
| --- | --- |
| `ui/pocket.json` | The app manifest. `app.entry` is the baseline presentation; `app.presentations[]` addresses other entries to a modality. |
| `ui/app/protocol.ts` | The state the renderer sends and the commands the interface sends. |
| `ui/app/host.ts` | `connectOverlay` from `@pocketjs/framework/overlay-host`, the state as one signal per member, the numbers that change every turn as a plain array with listeners. |
| `ui/app/parts.tsx` | Every readout, row, gauge and map once. A presentation places parts; it does not redraw one. |
| `ui/app/presentations/*.tsx` | One file per device shape. |
| `crates/<game>-interface` | The renderer's side: the state struct, the command parser, the channel, and `Session`, the flow. |
| `tools/ui.ts` | Compiles the app for a device, writes every screen as a picture, runs the flow test. |
| `ui/test/` | A mock renderer and the rig that runs a compiled bundle on the wasm UI core. |

## One presentation per device shape

`pocket.json` picks the entry at build time from the target's modality
(screens, touch, buttons). A game that ships on the four handhelds declares
three entries:

```json
"app": {
  "entry": "app/main.tsx",
  "viewport": { "logical": [480, 272], "presentation": "integer-fit" },
  "presentations": [
    { "id": "dual-screen", "entry": "app/main-dual.tsx",
      "modality": { "screens": 2, "touch": "auxiliary" },
      "viewport": { "fixed": { "logical": [400, 240], "presentation": "native" } },
      "surfaces": { "auxiliary": { "fixed": { "logical": [320, 240], "presentation": "native" } } },
      "capabilities": { "requires": ["display.auxiliary", "input.touch.auxiliary"] } },
    { "id": "touch", "entry": "app/main-touch.tsx",
      "modality": { "touch": "primary", "buttons": false },
      "viewport": { "fixed": { "logical": [480, 320], "presentation": "native" } } }
  ]
}
```

| Presentation | Devices | What it must do |
| --- | --- | --- |
| baseline (`single`) | PSP; PS Vita at 2× raster | Readouts at the edges of the scene. Lists walked by the d-pad with one focus bar; a legend strip from `useActions`. On the Vita a list row also takes a tap. |
| `dual-screen` | Nintendo 3DS | The upper screen keeps the scene and the readouts. **The lower screen is a second surface, not a copy**: the map, the controls a stylus works (a slider, a toggle), and every list. |
| `touch` | iPod touch | No buttons exist: every verb is drawn on the panel. A stick and keys at the lower corners, at least 44 logical pixels each, and a drag on the scene for the view. The title and the lists keep the baseline's layout with taller rows; the way back stands in a list's heading. |

A device differs by its presentation. A small difference inside one entry
reads `modality`, `surfaceHasTouch()` and `glyph()` from
`@pocketjs/framework/modality` (a legend says ○ on a PSP and A on a 3DS from
one source line). **Do not fork a part per device, and do not write a second
`pocket.json`.**

### One layout for the screens every device has

The title, a list, the menu over the scene and the strip under a list
**stand in the same place, built from the same parts, in every
presentation**. Two devices side by side then show one game. A presentation
changes what its device's input changes:

| | Buttons (PSP, Vita, 3DS) | Touch panel with no buttons |
| --- | --- | --- |
| A row's height | 26 px or more (the HIG's floor on a 320-wide screen) | 44 px; 36 px where five rows share the title with the name (iOS's own bars are 32 points on a panel held sideways) |
| The list's mark | The focus bar, moved by the d-pad | The same bar, under the finger while a row is pressed |
| The strip under a list | A notice at the left, the buttons' legend at the right | The notice; `useActions().legend()` is empty where no button exists |
| The way back | ✕ in the legend | `‹ Back` in the list's heading |

A control one device alone has (a stick, keys under a thumb, a bar to drag,
the lower screen's map) belongs to that presentation. **A shared screen is
not restyled for a device.** A touch title made of large buttons beside a
PSP title that is a list reads as another game. A list too long for rows a
finger can press stands two abreast in the same rows (six hours as three
rows of two) before it becomes a grid of buttons.

A device outside PocketJS's public registry (the 3DS development target, an
iPod drawable that shares the scene's 480 × 320) resolves through a profile
kept with the game's tool: `resolve3dsBuildPlan` from `tools/3ds-profile.ts`,
or `validateAndResolveBuildPlan` with a registry of one target.

## The protocol

Both sides speak JSON lines over PocketJS's `pocket.overlay` service,
answered inside the process. The renderer sends **the members of its state
that changed since the last line**; the interface sends flat commands
(numbers, booleans, short strings), which the renderer parses with a scanner
of a few dozen lines and no allocator-heavy JSON library.

```ts
// ui/app/host.ts
const overlay = connectOverlay<Partial<HostState>, Command>((state) => { /* write signals */ });
overlay.send({ type: "menu", on: true });
```

The guest calls `ui.svcOpen`, `ui.svcPoll` and `ui.svcSend`. A game answers
them from its channel in one of two ways:

| Host | How the game answers |
| --- | --- |
| Rust hosts (`hosts/psp`, `hosts/vita`) | After the host registered its ops and before the bundle is evaluated, set `svcOpen`, `svcPoll`, `svcSend` on the guest's `ui` object to C functions that read and write the channel (`JS_NewCFunction2`, `JS_SetPropertyStr`). |
| C hosts (`hosts/3ds/src/qjs.c`, `engine/quickjs-c/pocket_runtime.c` with `POCKET_SVC_WIRE`) | Link the six functions of [`hosts/3ds/src/svcwire.h`](../../hosts/3ds/src/svcwire.h) (`svcwire_open`, `svcwire_recv_lines`, `svcwire_send_line`, …) from the game's interface crate in place of the network client. |

Rules for the state:

- **Numbers that change every turn travel as one array** (`t`), and each is
  written to its node with `text()` and `prop()` from
  `@pocketjs/framework/hot`, in a cell of fixed size with the text at its
  left. That is one native call and no layout. A value set through a signal
  costs milliseconds per update on a PSP.
- Everything else is one signal per member, so a statistics line once a
  second does not re-run what reads the settings.
- Settings are a list the renderer sends (`{ key, value, choices? }`); the
  interface renders whatever the device lists. A device that has no bloom
  lists no bloom.
- What is kept between runs is one text the interface hands to the renderer
  (`prefs`), which stores it and hands it back at the start.

## The flow, once

`Session` in the interface crate is the only implementation of the game's
modes (loading, title, play, pause or menu, results). A device hands it the
pad each frame and reads back what to simulate. It also holds the fallback:
with no guest on the screen (its files are missing, memory has no room, the
script threw) the pad keeps the flow through a button of its own. **Do not
build a second native HUD for the fallback.**

While a list is up, the pad is the interface's and the simulation reads no
input. During play the interface listens to the one button that opens the
menu.

## What a turn costs

A turn of the guest runs the whole framework frame: **4 to 6 ms on a PSP
however little changed**, about 0.6 ms on an iPod touch 4. The embedding and
the app share the work of keeping that off the frame:

- The device offers the guest a turn 30 times a second and takes it only
  when it is worth its cost. The interface sends `idle` when nothing is
  scheduled (no hint fading, no toast standing); from then a turn is taken
  when the renderer has news, when a button the interface listens to
  changes, while a finger is down, and for a few turns after any of those.
  Buttons pressed between two turns are latched.
- **The renderer counts a hint's seconds.** A timer of the guest's counts
  its turns, so while one is pending the device has to take every turn it
  offers: a hint that stands for 7 s cost a PSP 30 turns a second for 7 s,
  and frames went late at the start of every flight. The app sends
  `{ type: "wake", id, seconds }` and the renderer says the id back in a
  state member when it is due. A timer of the guest's own runs only for the
  0.4 s of a fade, and `idle` is false for that long.
- **Screens stay built.** The title, the HUD and the menu are built while
  the world loads and then shown or hidden (`display`), because a screen
  takes tenths of a second to build on a PSP.
- A list's focus is one bar that slides (`translateY`); moving the focus
  changes one node.
- On the PSP a turn is two halves on two frames (the script, then layout and
  the draw list), each beside the GE's work on the previous frame.

What each console charged for the overlay, measured on one game (a city
flown over at 30 or 60 frames a second):

| Console | A turn | What else the overlay costs | What the game did |
| --- | --- | --- | --- |
| PSP | script 6.4 ms, layout and draw list 2.9 ms; 10 turns a second in flight | The GE blends every pixel of a list: 0.9 ms for the HUD, 6.7 ms for a menu over the scene. A collection of the guest's heap stops the CPU for 60 to 80 ms | The scene's triangle budget drops while a list is up. The collection waits for a list. Every list stays built once shown |
| Nintendo 3DS (Old) | 12.3 ms, 15 turns a second | Redrawing the lower screen on every turn added 3 ms to the GPU's longest frame | The lower surface is redrawn when its draw list changes |
| PS Vita | 1.05 ms, 30 turns a second; 0.8 ms to draw | vita2d draws a clip as a full-screen stencil pass: one `overflow-hidden` in the HUD made frames late. A collection that starts inside a turn takes 35 ms | No clip in a part that is on the screen during play. The collector runs at the end of loading and when a list closes |
| iPod touch 4 | 1.0 ms a turn, 5.1 ms a redraw, 11 redraws a second | A blended full-screen layer over a 4× multisampled target made 38 % of frames late | The scene's programs read the interface's texture at their own pixel, and the triangle budget pays for the rest |

Compiler facts that shape the parts: a `rounded-full` literal needs `w-[N]`
and `h-[N]` in the same literal; a pak image is a power of two up to 512; the
glyphs a runtime string can show are declared in `fonts.json` beside the
entry.

## Embedding per device

| Device | PocketJS piece | Where the interface is drawn |
| --- | --- | --- |
| PSP | `hosts/psp` as a library: `ffi::init_ui`, `pak::feed`, `ffi::register`, `ge::render_over`; its arena is the program's allocator | The last pass of the frame's GE list |
| PS Vita | `hosts/vita` as a library: `Runtime::new`, `eval`, `frame_with_input`, `tick`, `render_over` | The display scene, after the game's composite |
| Nintendo 3DS | `hosts/3ds/src` (`qjs.c`, `gfx.c`) and the 3DS UI core compiled in: `qjs_boot`, `qjs_frame`, `gfx_prepare_surface`, `gfx_draw_surface` | The upper surface over the scene every frame; the lower surface as its own target |
| iPod touch 4 | `engine/quickjs-c/pocket_runtime.c` with the UI core's OpenGL ES 2 backend | A texture redrawn when the draw hash changes, laid over the scene |

The guest starts before the world loads when memory has room for both, so
the loading steps are the interface's first screen.

## Test without a device

1. `bun tools/ui.ts preview`: each device's compiled bundle runs on the wasm
   UI core (`hosts/web/pocketjs.wasm`, `hosts/web/wasm-ops.js`) against a
   mock renderer, and every screen is written as a picture over a capture of
   the scene. **Look at every picture before a device build**: clipped text,
   a readout over another, a row too short for a finger. Then put the same
   screen from every device in one picture: a title or a list that differs
   by more than its rows' height was restyled for that device.
2. `bun tools/ui.ts test`: the same rig presses buttons and touches the
   panel through a whole session and asserts the commands the interface
   sent, on every device's bundle.
3. `cargo test` in the interface crate: the command parser against the lines
   the rig logs, the state line, the flow, and when a turn is due.

Change `protocol.ts` and the interface crate in one commit.

## Drive it from the host

Every device accepts the same control words, so a bench and a capture need
no hands: `mode=<mode>` sets the flow, `ui=<verb>` asks what the interface
would ask, `press=<mask>` presses PocketJS buttons on the guest, `touch=X,Y`
holds a finger where the device has a panel. The status record carries the
interface's own numbers (turns taken, turn milliseconds, the length of its
draw list). A change to the interface reports the frame bench before and
after, as a renderer change does.

## Checklist

- [ ] The renderer draws no text; the pack carries no HUD font.
- [ ] One `ui/` app; one presentation per device shape; parts defined once.
- [ ] The 3DS's lower screen and the iPod's panel carry controls of their
      own (a map, a bar to drag, a stick), not the PSP's readouts scaled.
- [ ] The title, the lists and the menu have one layout on every device;
      the same screen from each device was looked at side by side.
- [ ] Numbers in flight go through `hot`; nothing else updates every turn.
- [ ] `idle` is reported, and the device paces turns by it.
- [ ] The flow is one `Session`; the no-guest fallback is a button, not a HUD.
- [ ] Previews looked at for every device; the flow test passes on every
      bundle; the frame bench is reported before and after.
- [ ] Developer statistics are a setting inside the interface.

## Common mistakes

- Drawing key hints or a clock with the renderer's own font "until the UI
  exists". That text ships.
- Writing a per-turn value through a signal. The PSP loses several
  milliseconds a turn.
- Mounting a screen when its mode begins. The first frame of a pause then
  stalls on a PSP.
- Centring or right-aligning a text that `hot.text` rewrites. The text keeps
  the position layout gave the last value and drifts.
- Reusing the single-screen layout on the 3DS's upper screen and leaving the
  lower screen for a logo.
- A touch control smaller than 44 logical pixels, or a list on a touch-only
  device with no way back drawn on the screen.
- A title or a list rebuilt from large buttons for the touch panel while the
  other devices show rows. Keep the layout and raise the rows.
- An `overflow-hidden` part in the HUD. It is a scissor on the PSP and a
  full-screen stencil pass on the Vita.
- Leaving the scene's budget where it was while a menu covers the screen.
  The menu's pixels are the GPU's work too.
- A `setTimeout`-style timer for a toast or a hint. It holds `idle` off for
  its whole length.
- Letting each device keep its own title / play / pause switch. Two devices
  then disagree about what START does.
