# pocket3d-title

The Pocket3D title card: the mark and the name "Pocket3D" in white on the plum
ground, set as the bar of 3d.pocket.nexus sets them, shown when a game built on
Pocket3D starts. It fades in from black over 20 ticks,
holds, and fades back to black over 28: **144 ticks at 60 Hz, 2.4 seconds**.

The card needs no GPU. Each drawer writes a tick's frame into a CPU-visible
frame buffer, so a game plays the card **before it starts its renderer**, and
the card costs the renderer no texture, program or draw afterwards.

| Console | Drawer | Art |
| --- | --- | --- |
| PS Vita | `pocket3d_title::vita::play()` | 624 x 192 on 960 x 544 |
| PSP | `pocket3d_title::play(surface, present)` | 312 x 96 on 480 x 272 |
| Nintendo 3DS | `pocket3d_title_play()` in `include/pocket3d_title.h` | 312 x 96 on the upper screen, the ground on the lower |
| Browser reference | `playTitle()` in `web/pocket3d-title.js` | 624 x 192, at most 65% of the viewport's width |

The three drawers produce the same frames. `cargo test` records the hashes of
a PS Vita frame, a PSP frame and five Nintendo 3DS frames;
`tests/pocket3d-title.test.ts` compiles the C header on the host and decodes
the art in the browser module, and holds both to those hashes.

## PS Vita

```toml
pocket3d-title = { path = "../vendor/pocketjs/engine/pocket3d/crates/pocket3d-title" }
```

```rust
fn main() {
    pocket3d_title::vita::play();   // before sceGxmInitialize
    // ... start the renderer
}
```

`vita::play` allocates a 960 x 544 `A8B8G8R8` frame buffer in video memory,
shows it with `sceDisplaySetFrameBuf` for 144 vertical blanks, sets the
display's buffer back to null and frees the memory. It returns `false` and
shows nothing when the allocation fails.

## PSP

The crate has no dependency on a PSP SDK crate, so the game supplies the two
display calls:

```rust
use pocket3d_title::{Layout, Surface};

unsafe {
    let vram = sceGeEdramGetAddr();
    sceDisplaySetMode(DisplayMode::Lcd, 480, 272);
    let mut surface = Surface {
        pixels: core::slice::from_raw_parts_mut(vram, 512 * 272 * 4),
        width: 480, height: 272, stride: 512, layout: Layout::Rgba8,
    };
    pocket3d_title::play(&mut surface, |_| {
        sceDisplaySetFrameBuf(vram, 512, DisplayPixelFormat::Psm8888, DisplaySetBufSync::NextFrame);
        sceDisplayWaitVblankStart();
    });
}
// ... sceGuInit sets the game's own display mode and frame buffer
```

`play` leaves the surface as zero bytes. A game that next shows the same video
memory as a 16-bit 5650 frame buffer starts from black: the card's own black
is `0, 0, 0, 255` in 8888, which a 16-bit mode would show as columns.

## Nintendo 3DS

```make
INCLUDES += $(POCKETJS)/engine/pocket3d/crates/pocket3d-title/include
```

```c
#include <pocket3d_title.h>

gfxInitDefault();
pocket3d_title_play();   // before C3D_Init
```

`pocket3d_title_play` draws into the BGR8 frame buffers `gfxInitDefault`
selects, on both screens, and waits one vertical blank per tick.

## Browser reference

```js
import { playTitle } from "../vendor/pocketjs/engine/pocket3d/crates/pocket3d-title/web/pocket3d-title.js";

const title = playTitle();   // covers the page at once
await loadTheGame();
await title;                 // the card has ended and removed itself
```

## Rules for a game

The [Pocket3D License](../../../../pocket3d/LICENSE) makes the first rule a
condition of using Pocket3D in a distributed product.

- The card plays **first, at every launch**, before the game's own titles and
  before input is read. It is not skipped, shortened, cropped, recoloured or
  drawn over.
- The game does not redraw the art with its own renderer. The mark and the
  wordmark come from this crate, so every game shows the same card.
- A development build may skip the card behind a flag of its own. A build
  that leaves the developer's machine plays it.

## Re-baking the art

`site/pocket3d/title-card.html` is the drawing. After it or
`site/pocket3d/mark.svg` changes:

```sh
bun tools/pocket3d-title.ts --preview   # art/*.bin, include/pocket3d_title_art.h, web/art.js
cargo test --manifest-path engine/pocket3d/crates/pocket3d-title/Cargo.toml
```

The bake needs a network (the page loads Fredoka from Google Fonts) and
changes the recorded hashes: copy the new values the failing test prints into
`src/lib.rs`. `--preview` also writes the decoded art as PNGs under
`.pocket-build/pocket3d-title/`.

Art layout, little-endian: `"P3T1"`, `u16` width, `u16` height, `u16` colours,
`u16` zero; `colours` x (r, g, b); `height` x `u32` row offsets; rows of
(run - 1, palette index) pairs. Entry 0 is the ground.
