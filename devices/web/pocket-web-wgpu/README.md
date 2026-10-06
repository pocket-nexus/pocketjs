# Browser device mechanisms (wgpu)

This crate and the modules under `web/` are what a Pocket3D game drawn with
[wgpu](https://wgpu.rs) takes for a browser tab: **the WebGPU device and the
screens a frame goes to, a pass that lays the game's PocketJS interface over
its scene, ranged reads of a pack over HTTP, and the page around the canvas**
(the title card, the frame loop, and the player: a handheld's shell with the
game's screens in it and its keys as the controls). It holds no scene format,
no pipeline of a game and no flow. The Rust crate has two
targets, wasm32 for the tab and the machine that builds the game (Metal), so
one renderer draws in a tab and writes a frame to a file.

The browser is a device of its own. A game writes a renderer for it as it does
for GE, PICA200 and GXM; this kernel does not turn a console's renderer into a
browser's.

| Part | Mechanism |
| --- | --- |
| `src/gpu.rs` | `Gpu`: the device and its queue with WebGPU's default limits, and **the optional features a game wanted that the adapter has** (`for_canvas_wanting`, `Gpu::features`). `Screen`: a canvas, or a texture that is read back; **`width × height` pixels with `samples` samples each and a depth buffer**, resized while the game runs. `Frame`: one frame's views and its scene pass. |
| `src/overlay.rs` | `Overlay`: a premultiplied RGBA picture laid over a frame in a pass of its own, after the scene's samples are resolved: `dst × (1 − a) + src`. |
| `src/picture.rs` | Pictures of `r5 g6 b5` texels as `rgba8unorm` textures, with the levels below the stored ones made by halving in the 16-bit colours. |
| `src/source.rs` | `Source::range(offset, size)`: an HTTP `Range` request on a pack's file, or whole pieces of a pack cut into files of one size with a manifest (`pocket-pack-pieces/1`). A file read outside a tab. `Source::length()` is the pack's size (the manifest's `bytes`, or the total a server names in `Content-Range`) and `Source::all()` the whole of a file a runtime holds in one piece. |
| `src/task.rs` | `spawn`: work that waits, started from a frame. `now`: a clock. |
| `web/pocket3d-shell.js` | `titleCard`: the Pocket3D title card before any other picture. `hasWebGPU`. `frames`: the frame loop, **a whole number of display refreshes a frame**. |
| `web/pocket3d-interface.js` | `openInterface`: the interface's guest in PocketJS's realm (`hosts/web/app-instance.html`, started with `text: false`), its turns, the lines of its service, its picture when the draw hash has changed. **`simHz` is the turns a second the game gives the guest**, published as `globalThis.__simHz` before the bundle runs, as a device's host does. |
| `web/pocket3d-player.js` | `createPlayer`: **the page of every game**. The bar (the game's name, the devices as text, the mark that says the picture is simulated, the keys and the notices as panels), the stage, and the dock that leads to the game in Pocket Studio. |
| `web/pocket3d-stage.js` | A device's shell on the page with the game's canvas where the shell's screen is, a second screen for a device that has one, and the shell's keys, d-pad and sticks as elements. **A screen's pixel is a whole number of the display's own where the shell then keeps three quarters of the size that fits.** |
| `web/pocket3d-controls.js` | A handheld's controls: PocketJS button bits and two sticks from the keyboard and from the shell's own keys under a pointer or a finger, and contacts of pointers on a surface that takes touch. **The shell shows what is held, whatever holds it.** |
| `web/shells/` | The shells: `psp`, `vita`, `3ds`, `ipod` and `android`, each **a WebP of the case with its moving parts taken out and, for a device with keys, a WebP sheet of those parts** (20 to 71 kB a file), and `profiles.js`: where the screens, the controls and the parts are in the picture. |
| `web/fonts/` | Gabarito at weight 800, a Latin subset of 15 kB, with its licence (`OFL.txt`). It sets the game's name and the dock's heading; the system's face sets the rest, and the whole page until the file has come (`font-display: swap`). |
| `web/pocket3d-stage.css`, `web/pocket3d-player.css` | The layout of the stage and the shell, and the look of the bar, the panels and the dock, by the `data-pocket-*` attributes the modules set. A page links both. Seven custom properties change the colours (`pocket3d-player.css`). |

`bun tools/pocket3d-web.ts stage <directory>` writes the files a page loads:
the modules, stylesheets and directories above, the title card
(`pocket3d-title.js`, `art.js`), the realm (`app-instance.html`,
`app-instance.js`, `wasm-ops.js`, `offload-worker.js`, `pocketjs.wasm`) and
`pocketjs-host.js`, one module bundled from the framework's sources
(`__packTouch`, `createTouchHitFacts`, `BTN`).
`bun tools/pocket3d-web.ts cut <pack> <directory>` cuts a pack into pieces and
writes the manifest `Source` reads. A game's build tool imports
`stagePocket3dWeb` and `cutPack` from `tools/pocket3d-web.ts`.

## What a game implements

| The game owns | Against |
| --- | --- |
| **Its pipelines and its draws.** WGSL programs, vertex layouts, bind groups, what a frame draws. | `Screen::frame` gives the views; `Frame::pass` begins the scene's pass. The game ends the pass, calls `Overlay::draw`, submits and presents. |
| **Its pack reader.** Which sections are the head, which records are read when the eye comes near. | `Source::range`, started with `task::spawn`; the game hands what arrived to the GPU on a later frame. |
| **Its pad mapping.** What a device's buttons and sticks mean in its simulation. | `player.controls.read()` gives PocketJS button bits and two sticks in −1…1; the same bits go to the guest. |
| **The interface channel.** The state lines it sends, the commands it parses, its flow (`pocket.overlay`, [`skills/pocket3d-interface`](../../../skills/pocket3d-interface/SKILL.md)). | `openInterface` returns `send`, `turn`, `drain`: the page carries each line between the guest and the game's module. |
| **What it says of itself.** Its name and one sentence, the devices it offers, the targets it has packages for, and one sentence a device on how its picture there differs from the tab's. | `createPlayer({ title, tagline, devices, runsOn, withoutPackages, about, pick })`. The page's body is empty: the player builds it. The build plan PocketJS wrote for each device's bundle (`plan.json`) says the screens, the raster density and the surface that takes touch, which the game hands to `player.show`. |

A frame of the page, in a device's order:

1. The game's step: it takes the commands the guest sent on its last turn and
   advances its simulation.
2. The guest's turn, when the game says one is due: `send` the state line,
   `turn(buttons, contacts, ticks)`, then `drain`. `ticks` is the sixtieths of a
   second since its last turn; a guest opened with `simHz: 30` is turned 30
   times a second with 2 ticks.
3. `changed()`: when it is true, `picture()` and `Overlay::write`. The UI core
   rasterizes the picture once with its alpha
   (`ui_render_premultiplied_scaled`). `lowerChanged()` and `lower()` do the
   same for a second screen, whose pixels are opaque.
4. The game's draw: its scene, then `Overlay::draw`.

**The interface is drawn again when its draw hash changes**, not every frame.
Measured in Chrome 154 on an M3 Max with one game's interface, 16 redraws a
second in play: **1.6 ms a redraw at 960 × 544 with two samples a logical
pixel** (0.85 ms the UI core's drawing, the rest the copy into the module and
the upload), 0.44 ms at 480 × 272. A guest's turn takes 0.04 ms.

## The player

`createPlayer` builds one page for every game, so two games differ in what
they say and not in where a visitor finds it.

| Part | Mechanism |
| --- | --- |
| The bar | The game's name and its sentence at the left, from the game and then from the host (`/app.json`). The devices in the middle as text, the chosen one underlined. The player's own controls at the right. |
| The mark | The word **Simulated** beside the devices. A pointer that rests on it, the keys' focus or a finger opens its sentences: the browser draws the picture and the device draws the game with its own hardware, then the game's sentence for that device (`note`). |
| The shell | A picture of the device with the game's canvas where its screen is (`player.show(id, { width, height, lower, sticks, glyphs, touch, viewport })`). Its keys, its d-pad and its sticks take a pointer or a finger; the d-pad reads eight ways from where a thumb rests. A held key is drawn down in its socket and a stick's cap slides, also when the keyboard holds them. **A shell with no key stands for a screen taller than wide**: the iPod touch's picture is turned a quarter clockwise, its screen's rectangle with it, for a screen of 320 × 480 (`shellFor`); for 480 × 320 it lies. The Android phone's stands for 720 × 1280 and lies for 1280 × 720. A shell with keys is not turned. A device without a profile is shown as its screens alone. |
| Controls | The keys of the device as a list. A browser whose only pointer is a finger is told to press the picture. |
| About | What the player is (`about`, by default "This is the Pocket3D web player."), that the handheld is a picture, **that the devices' names are trademarks of their owners and Pocket Nexus is not affiliated with them**, and the PSP model's author and licence. A device names the trademark in its label when the label is more than that (`mark: "Android"` beside `label: "Android phone"`). |
| The dock | Under the stage, in the page's flow: it never lies over a screen. **With packages a visitor may get**: what the game is built for (`runsOn`), what Pocket Studio holds of it, a door to the game's card (`<studio>/studio/?app=<id>`, "Get it in Pocket Studio") and one to the Studio's front ("Make a game of your own"). **With none**: what the page is (`withoutPackages.heading` and `.sentence`; by default "Made for real handhelds" and that the game has no packages to download yet) and the one door "Make a game of your own". The dock's first door is drawn as its action. |

**The player reads `/app.json` from the page's own host**: `id`, `title`,
`tagline`, `packages` (`target`, `size`), `allowNative`, `slug`, `opened`.
**A visitor may get packages when the host lists at least one and does not
say `allowNative: false`.** A host that answers nothing leaves the game's own
word: packages are taken to exist when `runsOn` names a target. A host of Pocket Studio
answers it for a PocketJS game. Where the host has no such file the page's
own words stand: `<meta name="pocket-app" content="<id>">` and
`<meta name="pocket-studio" content="<origin>">`, written by the game's
build; with neither, both doors lead to `https://studio.pocket.nexus/`.

**A host counts the players that open by naming an address**: `opened` in
`/app.json`, or `<meta name="pocket-opened" content="<address>">`. The player
sends one `GET <address>?app=<id>&layout=<device id>` a page, with the device
the page opened as; a device picked later sends nothing. The request carries
the visitor's session (`credentials: "include"`, `mode: "no-cors"`), has low
priority, and its answer is not waited for or read, so it needs no CORS
header and a request that fails changes nothing on the page. **A host that
names no address is told nothing.** Both doors of the dock carry
`from=player` beside the parameters they have.

`player.ready()` tells the player the game's first frame is drawn. It then
reads the other devices' shells, so a change of device shows its case at
once. **Before the first frame a page reads one shell: 33 kB for the iPod
touch, 30 kB for the Android phone, 75 to 132 kB for a device with keys**,
with the font's 15 kB.

**The page asks no other host for anything it draws with.** The font is a
file of the kernel: Gabarito's variable font from
`github.com/google/fonts` (`ofl/gabarito`), cut to one weight and to Latin
with fontTools:

```sh
fonttools varLib.instancer "Gabarito[wght].ttf" wght=800 -o Gabarito-800.ttf
pyftsubset Gabarito-800.ttf --flavor=woff2 --layout-features=kern,liga \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2013,U+2018,U+2019,U+201C,U+201D,U+2026" \
  --output-file=gabarito-800-latin.woff2
```

A window narrower than 760 CSS pixels has the devices on a line of their own
and the dock's words above its doors. A window lower than 560 CSS pixels (a
phone on its side) has the dock on one line: its heading and **its first
door**, the one to the packages when there is one and "Make a game of your
own" when there is not. The other door is hidden there.

## The shells

`bun tools/pocket3d-shells.ts` renders the five shells with Blender
(`tools/handheld-models/shells.py`) and encodes them with `cwebp`. Each is the
device seen from the front by an orthographic camera at 14 pixels a
millimetre (20 for the iPod touch, 16 for the Android phone), on a
transparent film.

| Shell | Made from |
| --- | --- |
| `vita`, `3ds` | This repository's own models (`engine/pocket3d/examples/handheld/assets`), authored in Blender from photographs as references. The 3DS lies open flat, both screens toward the camera. |
| `psp` | [Dibad's PSP model](../../../engine/pocket3d/examples/handheld/assets/dibad-psp/ATTRIBUTION.md), **CC BY 4.0**. The script splits its one mesh into the case and its keys. |
| `ipod` | Drawn in `shells.py`: a slab of glass in a steel back. No file of anyone else's is read. |
| `android` | Drawn in `shells.py`: **a phone of 137.0 × 69.0 mm with a 16:9 panel of 104.0 × 58.5 mm**, one sheet of black glass in a graphite shell, lying with its three keys at the right. The keys are drawn on the glass and take no pointer. It is no maker's phone. No file of anyone else's is read. |

**No shell carries a wordmark or a logo.** The script leaves out the objects
that are one (the maker's name, the product's name, the PlayStation and
Memory Stick marks). Legends a player needs stay: the face buttons' symbols
and letters, START, SELECT, the d-pad's arrows. `web/shells/ATTRIBUTION.md`
travels with the pictures.

## What it does not do

- It has no fallback renderer: a browser without WebGPU gets the page's own
  sentence (`hasWebGPU`).
- `Gpu` asks for WebGPU's default limits, and for no feature unless the game
  names some. A feature the adapter lacks is left out, not refused: a
  renderer reads `Gpu::features` and loads what the device can sample (BC
  blocks on a desktop GPU, ETC2 or ASTC on a phone's).
- The realm hands the guest a centred stick (`hosts/web/app-instance.js`
  passes `0x8080`): an interface that reads `input.analog` sees none. The
  game reads the page's sticks itself (`pocket3d-controls.js`).
- A canvas that loses its device is not restored; the page is loaded again.
- The player draws no device that has no profile under `web/shells/`: an
  Android phone's screens stand alone until a shell is rendered for one.
- The shells are pictures from the front. They do not turn, and the 3DS's
  lid does not close.
- `Source` does not retry. A read that fails returns its error to the game.

## Check

```sh
cargo test --locked --manifest-path devices/web/pocket-web-wgpu/Cargo.toml
bun test tests/pocket3d-web.test.ts tests/wasm-premultiplied.test.ts
```

The Rust tests cover the overlay pass on this machine's GPU (skipped where
wgpu's Metal backend finds none), a device opened with optional features,
the 16-bit pictures, and a pack in pieces read beside its file, with its
length and its whole. The Bun tests stage the page's files, run a guest
written by hand in the realm through `pocket3d-interface.js`, cut a pack, and
read every shell's profile against its pictures and its device's screens.
Neither needs a game. A browser run belongs to the game that owns the page:
Pocket Tokyo's `bun tools/wgpu.ts check` drives Chrome through every device
in its shell at three window sizes, with a pointer and with a finger.

## License

This directory is part of Pocket3D and is under the
[Pocket3D License](../../../pocket3d/LICENSE). A distributed product that
draws 3D scenes with this kernel shows the Pocket3D title card each time it
starts; `titleCard` in `web/pocket3d-shell.js` plays it before the page shows
anything else. `hosts/web/` and `tools/pocket3d-web.ts` are PocketJS's and
stay under the MIT License.

Two things under `web/` are other people's: **the PSP's shell is a render of
Dibad's model, under CC BY 4.0** (`web/shells/ATTRIBUTION.md`), and
**Gabarito is under the SIL Open Font License 1.1** (`web/fonts/OFL.txt`).
