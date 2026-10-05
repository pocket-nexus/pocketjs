# Browser device mechanisms (wgpu)

This crate and the modules under `web/` are what a Pocket3D game drawn with
[wgpu](https://wgpu.rs) takes for a browser tab: **the WebGPU device and the
screens a frame goes to, a pass that lays the game's PocketJS interface over
its scene, ranged reads of a pack over HTTP, and the page around the canvas**
(the title card, the frame loop, a handheld's buttons and screens). It holds no
scene format, no pipeline of a game and no flow. The Rust crate also builds
for the machine that builds the game (Metal), so one renderer draws in a tab
and writes a frame to a file.

The browser is a device of its own. A game writes a renderer for it as it does
for GE, PICA200 and GXM; this kernel does not turn a console's renderer into a
browser's.

| Part | Mechanism |
| --- | --- |
| `src/gpu.rs` | `Gpu`: the device and its queue with WebGPU's default limits. `Screen`: a canvas, or a texture that is read back; **`width × height` pixels with `samples` samples each and a depth buffer**, resized while the game runs. `Frame`: one frame's views and its scene pass. |
| `src/overlay.rs` | `Overlay`: a premultiplied RGBA picture laid over a frame in a pass of its own, after the scene's samples are resolved: `dst × (1 − a) + src`. |
| `src/picture.rs` | Pictures of `r5 g6 b5` texels as `rgba8unorm` textures, with the levels below the stored ones made by halving in the 16-bit colours. |
| `src/source.rs` | `Source::range(offset, size)`: an HTTP `Range` request on a pack's file, or whole pieces of a pack cut into files of one size with a manifest (`pocket-pack-pieces/1`). A file read outside a tab. |
| `src/task.rs` | `spawn`: work that waits, started from a frame. `now`: a clock. |
| `web/pocket3d-shell.js` | `titleCard`: the Pocket3D title card before any other picture. `hasWebGPU`. `frames`: the frame loop, **a whole number of display refreshes a frame**. |
| `web/pocket3d-interface.js` | `openInterface`: the interface's guest in PocketJS's realm (`hosts/web/app-instance.html`, started with `text: false`), its turns, the lines of its service, its picture when the draw hash has changed. |
| `web/pocket3d-controls.js` | A handheld's controls: PocketJS button bits and two sticks from the keyboard and from buttons drawn on the page, and contacts of pointers on a surface that takes touch. |
| `web/pocket3d-stage.js` | A device's screens on the page at a whole number of display pixels, a second screen under the first, the choice of device as text. |

`bun tools/pocket3d-web.ts stage <directory>` writes the modules a page loads:
the four above, the title card (`pocket3d-title.js`, `art.js`), the realm
(`app-instance.html`, `app-instance.js`, `wasm-ops.js`, `offload-worker.js`,
`pocketjs.wasm`) and `pocketjs-host.js`, one module bundled from the
framework's sources (`__packTouch`, `createTouchHitFacts`, `BTN`).
`bun tools/pocket3d-web.ts cut <pack> <directory>` cuts a pack into pieces and
writes the manifest `Source` reads. A game's build tool imports
`stagePocket3dWeb` and `cutPack` from `tools/pocket3d-web.ts`.

## What a game implements

| The game owns | Against |
| --- | --- |
| **Its pipelines and its draws.** WGSL programs, vertex layouts, bind groups, what a frame draws. | `Screen::frame` gives the views; `Frame::pass` begins the scene's pass. The game ends the pass, calls `Overlay::draw`, submits and presents. |
| **Its pack reader.** Which sections are the head, which records are read when the eye comes near. | `Source::range`, started with `task::spawn`; the game hands what arrived to the GPU on a later frame. |
| **Its pad mapping.** What a device's buttons and sticks mean in its simulation. | `pocket3d-controls.js` gives PocketJS button bits and two sticks in −1…1; the same bits go to the guest. |
| **The interface channel.** The state lines it sends, the commands it parses, its flow (`pocket.overlay`, [`skills/pocket3d-interface`](../../../skills/pocket3d-interface/SKILL.md)). | `openInterface` returns `send`, `turn`, `drain`: the page carries each line between the guest and the game's module. |
| **Its page.** The wasm-bindgen module, which devices it offers, its copy. | The modules of `web/`; the build plan PocketJS wrote for each device's bundle (`plan.json`) says the screens, the raster density and the surface that takes touch. |

A frame of the page, in a device's order:

1. The game's step: it takes the commands the guest sent on its last turn and
   advances its simulation.
2. The guest's turn, when the game says one is due: `send` the state line,
   `turn(buttons, contacts, ticks)`, then `drain`.
3. `changed()`: when it is true, `picture()` and `Overlay::write`. The UI core
   rasterizes the picture once with its alpha
   (`ui_render_premultiplied_scaled`). `lowerChanged()` and `lower()` do the
   same for a second screen, whose pixels are opaque.
4. The game's draw: its scene, then `Overlay::draw`.

**The interface is drawn again when its draw hash changes**, not every frame.
At 960 × 544 with two samples a logical pixel a redraw takes about 1.5 ms of
an M3 Max in Chrome 154.

## What it does not do

- It has no fallback renderer: a browser without WebGPU gets the page's own
  sentence (`hasWebGPU`).
- `Gpu` asks for WebGPU's default limits and no feature, so a renderer that
  fits them runs wherever WebGPU does.
- A canvas that loses its device is not restored; the page is loaded again.
- `Source` does not retry. A read that fails returns its error to the game.

## Check

```sh
cargo test --locked --manifest-path devices/web/pocket-web-wgpu/Cargo.toml
bun test tests/pocket3d-web.test.ts tests/wasm-premultiplied.test.ts
```

The Rust tests cover the overlay pass on this machine's GPU (skipped where
wgpu's Metal backend finds none), the 16-bit pictures and a pack in pieces
read beside its file. The Bun tests stage the page's modules, run a guest
written by hand in the realm through `pocket3d-interface.js`, and cut a pack.
Neither needs a game. A browser run belongs to the game that owns the page:
Pocket Tokyo's `bun tools/wgpu.ts check` drives Chrome through every device.

## License

This directory is part of Pocket3D and is under the
[Pocket3D License](../../../pocket3d/LICENSE). A distributed product that
draws 3D scenes with this kernel shows the Pocket3D title card each time it
starts; `titleCard` in `web/pocket3d-shell.js` plays it before the page shows
anything else. `hosts/web/` and `tools/pocket3d-web.ts` are PocketJS's and
stay under the MIT License.
