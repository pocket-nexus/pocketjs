# PocketJS × inkview — Implementation File

> **Companion to** `INTEGRATION.md` (the feasibility study).
> This file turns that study into a concrete, buildable plan grounded in the
> **actual** APIs of `pocketjs` (this repo) and `inkview-rs`
> (`/var/home/alberto/projects/inkview-rs`).
>
> Every code sketch below was checked against the real source. Where the
> feasibility doc sketched an API from memory, it was frequently wrong —
> **read §0 first**; it lists the corrections that change the shape of the
> implementation.

---

## 0. Ground-Truth Corrections (read this first)

The feasibility doc is directionally right but several of its API sketches do
not match the code. These corrections reshape the implementation:

| # | Feasibility doc says | Reality (verified) | Consequence |
| --- | ---------------------- | -------------------- | ------------- |
| 1 | Hand-write ~17 `HostOps` forwarders in a new `host_ops.rs` / `ffi.rs` using a `pocket-mod` API of `ns.func(...)`, `args[0].as_i32()` | The **full** `ui` surface already exists: `pocket_ui_wgpu::UiSurface` (`engine/crates/pocket-ui-wgpu/src/surface.rs`) implements every op, pak feeding, boot tables, and host identity. `pocket-mod`'s real mount API is rquickjs: `guest.mount("ui", \|ctx, ns\| ns.set("op", Function::new(ctx.clone(), closure)))` with **typed closure params**. | **Do not reimplement the surface.** Reuse `UiSurface`. The entire `host_ops.rs`/`ffi.rs` from the doc is deleted. |
| 2 | Pak is a *directory*: `bundle.js`, `styles.bin`, `font-atlas-*.bin`, `images/` | A pak is a **single binary archive** walked by `walk_pak` (`engine/crates/pocket-ui-wgpu/src/pak.rs`, format pinned in `spec::pak`). The JS bundle is a **separate `.js` file**. `UiSurface::feed_pak(&bytes)` feeds styles/atlases/images/sprites natively. | `load_pak` in the doc is deleted. Load one `.pak` + one `.js`. |
| 3 | `ui.tick(1.0/60.0)` and `let words = ui.draw() -> Vec<u32>` | `Ui::tick(&mut self)` takes **no dt** (fixed step internally). `Ui::draw(&mut self) -> &DrawList`, and `DrawList { pub words: Vec<u32> }`. | Call `surface.tick()`; rasterize from `ui.draw().words`. |
| 4 | `frame(buttons, analog?, touches?)` is called via `guest.call_frame(buttons, analog, touches)` | `pocket-mod::Guest` only exposes `frame(buttons)` and `frame_with_analog(buttons, analog)` — **no touch path**. The framework *does* accept a 3rd `touches: readonly number[]` arg (`framework/src/host.ts:306`, decoded in `framework/src/touch.ts`). | Add a small `Guest::frame_with_touches(buttons, analog, &[u32])` to `pocket-mod` (§6). |
| 5 | Touch is "single-touch `{x,y,phase}`", coords scaled freely | Touch packs each contact as one u32: `(id<<18) \| (y<<9) \| x` — **9 bits per axis ⇒ max coordinate 511** (`framework/src/touch.ts`). There is no `phase`; a contact is simply present (down) or absent (up) per frame. | **The logical viewport must be ≤ 511×511.** A 1024×758 logical viewport (doc's "1:1 is best") silently wraps touch X. This forces the Vita-style scaled model (§9). This is the single biggest architectural correction. |
| 6 | Drive ticks with inkview `SetHardTimer` inside `iv_main`, state in `Arc<Mutex<AppState>>` | `SetHardTimer` is **not** in inkview's safe API. The proven pattern (`inkview-slint`) runs `iv_main` on the **main thread forwarding events into an mpsc channel**, and a **second thread** owns the `Screen` + a pull-based loop (`recv_timeout`/`try_recv`) that ticks and renders. `&'static Inkview` via `Box::leak`. | Use the channel + render-thread model (§4). No `Arc<Mutex<…>>` around the hot path; single-threaded `Rc<RefCell<…>>` inside the render thread. |
| 7 | A bespoke `RefreshManager` with `full_update_interval`, `quiet_period_ms`, etc. | `inkview-slint/src/lib.rs` ships a **battle-tested** strategy: gate on `screen.is_updating()`; `partial_update` on the damage box when idle; `dynamic_update` (throttled to ≥20 ms) on accumulated damage while a update is in flight; a final `partial_update` after ~200 ms quiet to clear ghosting. | Base `refresh.rs` on the slint strategy, not the speculative one (§7). |
| 8 | RGBA8→Gray8 with "alpha compositing over white" | `raster::render`/`render_scaled` output **RGBA8, cleared to opaque black, every pixel alpha=255** (`engine/raster/src/lib.rs` `blend_px`). No compositing needed. `render_scaled(ui, words, fb, scale)` renders at `viewport×scale` physical px (scale 1..4). | Gray conversion is a straight luminance read; background is black unless the app paints white (§5, §11). |
| 9 | `inkview = "0.3"` from crates.io; `load()` returns `Result`; `Screen::draw(x: i32, …)` | `inkview::load() -> bindings::Inkview` (panics on failure, not `Result`). `Screen::new(&Inkview)`. `draw(x: usize, y: usize, BB8)`. `partial_update(x: i32, y: i32, w: u32, h: u32)`, `dynamic_update(…)`, `full_update()`, `fast_update()` (= `SoftUpdate`), `is_updating() -> bool`, `width()/height()/dpi()/scale()`. `Event` has `Init, Show, Repaint, Hide, Exit, Foreground, Background, KeyDown, KeyRepeat, KeyUp, PointerDown/Move/Up`. | Use a git/path dep during development; call the real signatures (§3, §4). |

---

## 1. Revised Architecture

```
app.tsx (Solid / Vue Vapor + Tailwind)
   │  bun tools/build.ts <app> --target pocketbook
   ▼
app.js  +  app.pak            ← single binary pak (styles, atlases, images, sprites)
   │
   ▼  (loaded by the host at startup)
┌───────────────────────────────────────────────────────────────┐
│ QuickJS guest (pocket_mod::Guest)                             │
│   globalThis.ui  ← UiSurface (REUSED from pocket-ui-surface)  │
│   globalThis.frame(buttons, analog, touches)                  │
└───────────────────────────┬───────────────────────────────────┘
                            │ ui.* ops
                            ▼
┌───────────────────────────────────────────────────────────────┐
│ pocketjs_core::Ui  (inside UiSurface)                         │
│   feed_pak → load_styles / load_font_atlas / upload_texture   │
│   tick() → draw() → DrawList { words: Vec<u32> }              │
└───────────────────────────┬───────────────────────────────────┘
                            │ raster::render_scaled(ui, words, fb, density)
                            ▼  RGBA8 @ physical res (logical × density)
┌───────────────────────────────────────────────────────────────┐
│ hosts/pocketbook  (NEW)                                       │
│   framebuffer.rs : RGBA8 → Gray8 + tile damage                │
│   refresh.rs     : is_updating gate → partial/dynamic/full    │
│   input.rs       : inkview Event → BTN bitmask + packed touch │
│   main.rs        : channel event loop + render thread         │
└───────────────────────────┬───────────────────────────────────┘
                            │ screen.draw(x,y,BB8) + partial/dynamic/full_update
                            ▼
                  libinkview.so → PocketBook e-ink panel
```

**The new code is small** because the heavy lifting (UI tree, layout, style,
animation, DrawList, software rasterizer, the entire `ui` HostOps surface, pak
feeding) already exists and is reused unchanged. The host is essentially:
*event loop glue + RGBA8→Gray8 + e-ink refresh policy + input mapping.*

---

## 2. One prerequisite refactor: extract `UiSurface` from `pocket-ui-wgpu`

`UiSurface` currently lives in `pocket-ui-wgpu`, which also pulls in `wgpu`.
Depending on it from the PocketBook host would drag the whole GPU stack into an
ARM cross-build that never uses it. Extract the backend-agnostic surface into
its own crate.

**New crate `engine/crates/pocket-ui-surface/`** containing the three modules
that have no wgpu dependency:

| Move from `pocket-ui-wgpu/src/` | To `pocket-ui-surface/src/` | Notes |
| --- | --- | --- |
| `surface.rs` | `surface.rs` | `UiSurface`; only depends on `pocketjs_core`, `pocket_mod`, `crate::pak`, `crate::dbg` |
| `pak.rs` | `pak.rs` | `walk_pak`, `find_pak`, `PakEntry` |
| `dbg.rs` | `dbg.rs` | `DbgMailbox` (used by the DevTools ops in `surface.rs`) |

Then:

- `pocket-ui-wgpu` keeps `blit.rs` + `render.rs` (`UiRenderer`), re-exports
  `UiSurface`/`walk_pak` from `pocket-ui-surface` so `uihost` and OpenStrike are
  source-compatible (`pub use pocket_ui_surface::{UiSurface, walk_pak, PakEntry};`).
- `hosts/pocketbook` depends on `pocket-ui-surface` (no wgpu).

This is a pure move + re-export; no behavior changes, and it keeps the desktop
host building exactly as before. (A first spike can skip this and depend on
`pocket-ui-wgpu` directly to validate the pipeline, but the extraction should
land before the host is merged so the ARM build stays lean.)

---

## 3. Crate layout & manifest

```
hosts/pocketbook/
├── Cargo.toml
└── src/
    ├── main.rs          # channel event loop, boot, render thread, tick
    ├── input.rs         # inkview Event → BTN bitmask + packed touch contacts
    ├── framebuffer.rs   # render_scaled RGBA8 → Gray8, tile-based damage
    └── refresh.rs       # e-ink update policy (slint-style)
```

```toml
# hosts/pocketbook/Cargo.toml
[package]
name = "pocketbook-host"
version = "0.1.0"
edition = "2021"

[dependencies]
pocketjs-core     = { path = "../../engine/core" }
pocket-mod        = { path = "../../engine/crates/pocket-mod" }
pocket-ui-surface = { path = "../../engine/crates/pocket-ui-surface" }  # §2
anyhow            = "1"
log               = "0.4"
env_logger        = "0.11"

# inkview is not assumed to be on crates.io during development. Use the local
# checkout or the upstream git repo; pick ONE:
inkview = { path = "../../../inkview-rs/inkview" }
# inkview = { git = "https://github.com/simmsb/inkview-rs", package = "inkview" }
# Default feature is sdk-6-10; override with --no-default-features --features sdk-6-5 etc.

[profile.release]
opt-level = "s"
lto = true
strip = true
panic = "abort"
```

Add the crate to the `engine/Cargo.toml` workspace `members` (the host lives
under `hosts/` but shares the engine workspace so path deps resolve).

### Cross-compilation

PocketBook runs ARM Linux, glibc 2.23. Same recipe inkview-rs uses:

```bash
rustup target add armv7-unknown-linux-gnueabi
cargo install cargo-zigbuild

cd hosts/pocketbook
cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23
# libinkview.so is dlopen'd at runtime (inkview::load) — no SDK at build time.
```

---

## 4. `main.rs` — channel event loop + render thread

This mirrors `inkview-rs/examples/inkview-slint-demo/src/main.rs`: `iv_main`
runs on the main thread and forwards every `Event` into an mpsc channel; a
second thread owns the `Screen` and the PocketJS tick/render loop, pulling
events with a timeout so it can tick on a cadence even when idle.

```rust
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use inkview::Event;
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;

mod framebuffer;
mod input;
mod refresh;

// Logical viewport + raster density. See §9 for why logical must be ≤511/axis.
// Vita-shaped default; finalize per-device on hardware.
const LOGICAL_W: u32 = 480;
const LOGICAL_H: u32 = 320; // 480×320 @ density 2 → 960×640, integer-fit on panel
const DENSITY: u32 = 2;
const TICK_MS: u64 = 33; // ~30 fps logical tick; e-ink doesn't need 60

fn main() -> Result<()> {
    env_logger::init();

    // &'static Inkview: leak it so both threads can reference it (single-threaded
    // inkview callbacks only touch it from the main thread; Screen::new reads it
    // once on the render thread at startup — matches the slint demo).
    let iv: &'static inkview::bindings::Inkview = Box::leak(Box::new(inkview::load()));

    let (tx, rx) = mpsc::channel::<Event>();

    // Render thread: owns Screen + guest + core + pipeline.
    let render = std::thread::spawn(move || -> Result<()> {
        // The first event inkview delivers is Init; wait for it before touching
        // the framebuffer (the slint demo asserts the same ordering).
        if rx.recv().context("event channel closed before Init")? != Event::Init {
            anyhow::bail!("expected EVT_INIT first");
        }

        let mut screen = inkview::screen::Screen::new(iv);
        let phys_w = screen.width();
        let phys_h = screen.height();

        // Boot the guest exactly like uihost (engine/pocket3d/examples/uihost):
        let pak = std::fs::read(pak_path()).context("read app.pak")?;
        let bundle = std::fs::read_to_string(js_path()).context("read app.js")?;

        let surface = UiSurface::new_with_density((LOGICAL_W as f32, LOGICAL_H as f32), DENSITY);
        surface.set_identity("pocketbook", HOST_ABI); // §8 — must match platforms.ts
        surface.feed_pak(&pak);

        let guest = Guest::new()?;
        surface.mount(&guest)?;
        guest.eval("app", &bundle)?;
        anyhow::ensure!(guest.has_frame(), "bundle installed no frame()");

        let mut fb = framebuffer::FramebufferPipeline::new(phys_w, phys_h);
        let mut refresh = refresh::Refresh::new();
        let mut input = input::Input::new(LOGICAL_W, LOGICAL_H, phys_w, phys_h);

        let mut last_tick = Instant::now();
        let mut running = true;

        while running {
            // Pull events until the tick deadline; drain everything pending.
            let deadline = last_tick + Duration::from_millis(TICK_MS);
            loop {
                let now = Instant::now();
                if now >= deadline { break; }
                match rx.recv_timeout(deadline - now) {
                    Ok(ev) => {
                        if input.on_event(ev) == input::Outcome::Quit { running = false; }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => { running = false; break; }
                }
            }
            // Drain any burst that arrived (non-blocking).
            while let Ok(ev) = rx.try_recv() {
                if input.on_event(ev) == input::Outcome::Quit { running = false; }
            }
            if !running { break; }

            last_tick = Instant::now();
            tick(&guest, &surface, &mut fb, &mut refresh, &mut input, &mut screen)?;
        }
        Ok(())
    });

    // Main thread: the inkview event loop. Forward everything; return Some(())
    // for events we consume so inkview doesn't also run its default handling.
    inkview::iv_main(iv, move |ev| {
        let _ = tx.send(ev);
        match ev {
            Event::Exit => None,          // let inkview tear down
            _ => Some(()),
        }
    });

    render.join().unwrap()
}

/// One fixed-step frame. Order matches uihost: guest turn → core tick → draw →
/// rasterize → gray → blit → refresh.
fn tick(
    guest: &Guest,
    surface: &UiSurface,
    fb: &mut framebuffer::FramebufferPipeline,
    refresh: &mut refresh::Refresh,
    input: &mut input::Input,
    screen: &mut inkview::screen::Screen,
) -> Result<()> {
    // 1. Guest turn with buttons + analog + packed touches (§6).
    let (buttons, analog, touches) = input.snapshot();
    guest.frame_with_touches(buttons, analog, &touches)?;

    // 2. Core fixed step + DrawList.
    surface.tick();

    // 3. Rasterize at physical resolution (logical × density) → RGBA8.
    let dirty = surface.with_ui(|ui| {
        let words = ui.draw().words.clone(); // borrow ends before fb write
        fb.rasterize(ui, &words);            // render_scaled into fb.rgba
        fb.to_gray_and_diff()                // RGBA8→Gray8 + tile damage
    });

    // 4. Blit changed pixels, then let the refresh policy drive the panel.
    if !dirty.is_empty() {
        fb.blit_dirty(screen, &dirty);
    }
    refresh.present(screen, &dirty);
    Ok(())
}
```

Notes:

- `UiSurface::with_ui(|ui| …)` gives `&mut Ui` for `draw()`; we clone `words`
  out so the immutable borrow ends before `fb` (which needs `&Ui` for
  `render_scaled`) — or restructure to rasterize inside the same closure
  (preferred; `render_scaled(ui, &words, …)` can run while `ui` is borrowed).
- `HOST_ABI`, `pak_path()`, `js_path()` are constants/helpers (§8, §10).

---

## 5. `framebuffer.rs` — RGBA8 → Gray8 + damage

```rust
use inkview::screen::{BB8, Screen};
use pocketjs_core::{Ui, raster};

#[derive(Clone, Copy, Debug)]
pub struct DirtyRect { pub x: usize, pub y: usize, pub w: usize, pub h: usize }

const TILE: usize = 16;

pub struct FramebufferPipeline {
    rgba: Vec<u8>,       // physical W×H×4, RGBA8 (raster::render_scaled output)
    gray: Vec<u8>,       // physical W×H Gray8 (current)
    prev: Vec<u8>,       // physical W×H Gray8 (previous, for damage)
    w: usize,
    h: usize,
}

impl FramebufferPipeline {
    pub fn new(w: usize, h: usize) -> Self {
        let n = w * h;
        Self {
            rgba: vec![0u8; n * 4],
            gray: vec![255u8; n],   // start white (e-ink idle = white)
            prev: vec![255u8; n],
            w, h,
        }
    }

    /// Rasterize the DrawList at physical resolution. `scale` = raster density.
    /// Output is RGBA8, cleared to opaque black, all pixels alpha=255.
    pub fn rasterize(&mut self, ui: &Ui, words: &[u32]) {
        // render_scaled asserts fb.len() == vw*scale × vh*scale × 4.
        raster::render_scaled(ui, words, &mut self.rgba, crate::DENSITY);
    }

    /// Luminance-convert RGBA8→Gray8 and return changed 16×16 tiles.
    pub fn to_gray_and_diff(&mut self) -> Vec<DirtyRect> {
        let n = self.w * self.h;
        for i in 0..n {
            let r = self.rgba[i * 4] as u32;
            let g = self.rgba[i * 4 + 1] as u32;
            let b = self.rgba[i * 4 + 2] as u32;
            // Same coefficients inkview uses (screen.rs RGB24::to_bb8).
            // Integer form of 0.2125R + 0.7154G + 0.0721B:
            self.gray[i] = ((54 * r + 183 * g + 19 * b) >> 8) as u8;
        }
        let dirty = self.diff();
        std::mem::swap(&mut self.gray, &mut self.prev);
        dirty
    }

    fn diff(&self) -> Vec<DirtyRect> {
        let (w, h) = (self.w, self.h);
        let tx = w.div_ceil(TILE);
        let ty = h.div_ceil(TILE);
        let mut flags = vec![false; tx * ty];
        for y in 0..h {
            let row = y * w;
            for x in 0..w {
                let i = row + x;
                if self.gray[i] != self.prev[i] {
                    flags[(y / TILE) * tx + (x / TILE)] = true;
                }
            }
        }
        flags.iter().enumerate()
            .filter(|(_, d)| **d)
            .map(|(i, _)| {
                let px = (i % tx) * TILE;
                let py = (i / tx) * TILE;
                DirtyRect { x: px, y: py, w: TILE.min(w - px), h: TILE.min(h - py) }
            })
            .collect()
    }

    /// Write only changed tiles to the inkview framebuffer (no panel update yet).
    pub fn blit_dirty(&self, screen: &mut Screen, dirty: &[DirtyRect]) {
        for r in dirty {
            for y in r.y..(r.y + r.h) {
                for x in r.x..(r.x + r.w) {
                    screen.draw(x, y, BB8(self.gray[y * self.w + x]));
                }
            }
        }
    }

    /// Full-screen blit (used on Show / orientation change before a full_update).
    pub fn blit_all(&self, screen: &mut Screen) {
        for y in 0..self.h {
            for x in 0..self.w {
                screen.draw(x, y, BB8(self.gray[y * self.w + x]));
            }
        }
    }
}
```

Optimizations (later, §13 of the feasibility doc): merge adjacent dirty tiles
into fewer larger rects; NEON the luminance loop; a direct Gray8 rasterizer in
`raster.rs`. None are needed for a correct MVP — `screen.draw` is a bounds-checked
byte write and the panel update dominates latency by orders of magnitude.

---

## 6. Touch + the `pocket-mod` addition

The framework decodes a 3rd `frame` argument (`framework/src/touch.ts`): each
contact is one u32 `(id<<18) | (y<<9) | x`, **9 bits per axis (max 511)**, up to
8 contacts. A contact present = down/move; absent = released. `pocket-mod`
currently has no 3-arg frame, so add one:

```rust
// engine/crates/pocket-mod/src/lib.rs — add alongside frame_with_analog
/// One guest turn with touch contacts. `touches` packs each contact as
/// (id<<18)|(y<<9)|x (framework/src/touch.ts); coords are logical px, ≤511/axis.
pub fn frame_with_touches(&self, buttons: u32, analog: u32, touches: &[u32]) -> Result<()> {
    self.ctx.with(|ctx| -> Result<()> {
        let frame: Option<Function> = ctx.globals().get("frame").ok();
        if let Some(frame) = frame {
            let arr = rquickjs::Array::new(ctx.clone())
                .map_err(|e| anyhow!("pocket-mod: touch array: {e}"))?;
            for (i, t) in touches.iter().enumerate() {
                arr.set(i, *t)
                    .map_err(|e| anyhow!("pocket-mod: touch set: {e}"))?;
            }
            frame
                .call::<_, ()>((buttons, analog, arr))
                .catch(&ctx)
                .map_err(|e| anyhow!("pocket-mod: frame() threw: {e}"))?;
        }
        Ok(())
    })?;
    self.drain_jobs();
    Ok(())
}
```

This is additive and leaves `frame`/`frame_with_analog` (and every existing
host, tape, and golden) untouched.

---

## 7. `refresh.rs` — e-ink update policy (slint-derived)

Ported from `inkview-slint/src/lib.rs`'s proven loop, expressed as a small state
machine the host calls once per tick with the frame's damage:

```rust
use std::time::{Duration, Instant};
use inkview::screen::Screen;
use crate::framebuffer::DirtyRect;

pub struct Refresh {
    last_draw: Instant,
    /// Damage accumulated while a panel update was in flight (needs a cleanup
    /// partial update once things go quiet).
    pending_cleanup: Option<Rect>,
    cleanup_after: Option<Instant>,
}

#[derive(Clone, Copy)]
struct Rect { x: i32, y: i32, w: u32, h: u32 }

impl Refresh {
    pub fn new() -> Self {
        Self { last_draw: Instant::now(), pending_cleanup: None, cleanup_after: None }
    }

    pub fn present(&mut self, screen: &mut Screen, dirty: &[DirtyRect]) {
        // 1. Quiet-period cleanup: a final high-quality partial update on the
        //    region we hammered with dynamic updates (clears ghosting).
        if let Some(at) = self.cleanup_after {
            if Instant::now() >= at {
                if let Some(r) = self.pending_cleanup.take() {
                    screen.partial_update(r.x, r.y, r.w, r.h);
                    self.last_draw = Instant::now();
                }
                self.cleanup_after = None;
            }
        }

        if dirty.is_empty() { return; }
        let d = merge(dirty);

        if screen.is_updating() {
            // A panel update is still in flight. Don't queue a high-quality
            // partial (it stalls); instead do a fast dynamic update, throttled
            // to ≥20 ms, on the accumulated damage — exactly the slint policy.
            self.pending_cleanup = Some(union(self.pending_cleanup, d));
            if self.last_draw.elapsed() > Duration::from_millis(20) {
                let r = self.pending_cleanup.unwrap();
                screen.dynamic_update(r.x, r.y, r.w, r.h);
                self.last_draw = Instant::now();
            }
            // Schedule a cleanup partial update 200 ms after the last draw.
            self.cleanup_after = Some(Instant::now() + Duration::from_millis(200));
        } else {
            // Idle panel: high-quality non-flashing partial on the damage box.
            screen.partial_update(d.x, d.y, d.w, d.h);
            self.last_draw = Instant::now();
        }
    }

    /// Full flashing redraw — call on Show / orientation change / mode switch.
    pub fn full(&mut self, screen: &mut Screen) {
        screen.full_update();
        self.last_draw = Instant::now();
        self.pending_cleanup = None;
        self.cleanup_after = None;
    }
}

fn merge(rects: &[DirtyRect]) -> Rect {
    let (mut x0, mut y0) = (i32::MAX, i32::MAX);
    let (mut x1, mut y1) = (0i32, 0i32);
    for r in rects {
        x0 = x0.min(r.x as i32); y0 = y0.min(r.y as i32);
        x1 = x1.max((r.x + r.w) as i32); y1 = y1.max((r.y + r.h) as i32);
    }
    Rect { x: x0, y: y0, w: (x1 - x0) as u32, h: (y1 - y0) as u32 }
}

fn union(a: Option<Rect>, b: Rect) -> Rect {
    match a {
        None => b,
        Some(a) => {
            let x0 = a.x.min(b.x); let y0 = a.y.min(b.y);
            let x1 = (a.x + a.w as i32).max(b.x + b.w as i32);
            let y1 = (a.y + a.h as i32).max(b.y + b.h as i32);
            Rect { x: x0, y: y0, w: (x1 - x0) as u32, h: (y1 - y0) as u32 }
        }
    }
}
```

`input::Input::on_event` should also call `refresh.full(screen)` on
`Event::Show` (returning from background) — wire that in `main.rs`.

---

## 8. `input.rs` — keys → BTN bits, pointer → packed touch

Button bits are the spec BTN constants (verified against
`engine/pocket3d/examples/uihost/src/main.rs` and `contracts/spec/spec.ts`):

```rust
use inkview::event::{Event, Key};
use pocketjs_core::spec::ANALOG_CENTER; // 0x8080

// spec BTN bits:
const BTN_SELECT: u32   = 0x0001;
const BTN_START: u32    = 0x0008;
const BTN_UP: u32       = 0x0010;
const BTN_RIGHT: u32    = 0x0020;
const BTN_DOWN: u32     = 0x0040;
const BTN_LEFT: u32     = 0x0080;
const BTN_LTRIGGER: u32 = 0x0100;
const BTN_RTRIGGER: u32 = 0x0200;
const BTN_TRIANGLE: u32 = 0x1000;
const BTN_CIRCLE: u32   = 0x2000;
const BTN_CROSS: u32    = 0x4000;
const BTN_SQUARE: u32   = 0x8000;

pub enum Outcome { Continue, Quit }

pub struct Input {
    buttons: u32,
    /// Current contact in LOGICAL px (None = up). PocketBook is single-touch.
    touch: Option<(u32, u32)>,
    // physical→logical scale (physical px / logical px), per axis.
    sx: f32,
    sy: f32,
}

impl Input {
    pub fn new(lw: u32, lh: u32, pw: usize, ph: usize) -> Self {
        Self {
            buttons: 0,
            touch: None,
            // Integer-fit offset handling belongs here if the logical surface is
            // centered on a larger panel (§9): subtract the letterbox origin
            // before scaling. Shown without offset for clarity.
            sx: pw as f32 / lw as f32,
            sy: ph as f32 / lh as f32,
        }
    }

    pub fn on_event(&mut self, ev: Event) -> Outcome {
        match ev {
            Event::Exit => Outcome::Quit,
            Event::KeyDown { key } | Event::KeyRepeat { key } => {
                if key == Key::Back { /* app may map this; not Quit by default */ }
                self.buttons |= key_bit(key);
                Outcome::Continue
            }
            Event::KeyUp { key } => { self.buttons &= !key_bit(key); Outcome::Continue }
            Event::PointerDown { x, y } | Event::PointerMove { x, y } => {
                self.touch = Some(self.to_logical(x, y));
                Outcome::Continue
            }
            Event::PointerUp { .. } => { self.touch = None; Outcome::Continue }
            _ => Outcome::Continue,
        }
    }

    fn to_logical(&self, x: i32, y: i32) -> (u32, u32) {
        // Clamp to the 9-bit touch range the framework decodes (≤511).
        let lx = ((x as f32 / self.sx) as i32).clamp(0, 511) as u32;
        let ly = ((y as f32 / self.sy) as i32).clamp(0, 511) as u32;
        (lx, ly)
    }

    /// (buttons, analog, packed touches) for Guest::frame_with_touches.
    pub fn snapshot(&self) -> (u32, u32, Vec<u32>) {
        let touches = self.touch.map(|(x, y)| vec![pack_touch(0, x, y)]).unwrap_or_default();
        (self.buttons, ANALOG_CENTER, touches)
    }
}

/// framework/src/touch.ts __packTouch: (id<<18)|(y<<9)|x.
fn pack_touch(id: u32, x: u32, y: u32) -> u32 {
    ((id & 0xff) << 18) | ((y & 0x1ff) << 9) | (x & 0x1ff)
}

fn key_bit(key: Key) -> u32 {
    match key {
        Key::Up => BTN_UP,
        Key::Down => BTN_DOWN,
        Key::Left | Key::Prev | Key::Prev2 => BTN_LEFT,   // page-turn = prev
        Key::Right | Key::Next | Key::Next2 => BTN_RIGHT, // page-turn = next
        Key::Ok => BTN_CROSS,
        Key::Back => BTN_CIRCLE,
        Key::Menu => BTN_START,
        Key::Home => BTN_SELECT,
        Key::Plus => BTN_RTRIGGER,
        Key::Minus => BTN_LTRIGGER,
        _ => 0,
    }
}
```

The exact key→button mapping is app-domain tuning; the above gives a sensible
reader-oriented default (page-turn keys = left/right).

---

## 9. The viewport / touch design decision (FLAGGED)

This is the one genuinely open architectural question, and the feasibility doc
missed it. Two hard constraints collide on a PocketBook:

1. **Touch wire format**: contacts pack into 9 bits per axis ⇒ **logical
   viewport ≤ 511×511** (`framework/src/touch.ts`). The doc's recommended
   "logical = physical, 1:1" (1024×758) would wrap touch X at 512.
2. **Raster scaling**: `raster::render_scaled` takes an **integer** scale 1..4,
   and `UiSurface::new_with_density` pairs a logical viewport with a density so
   baked font atlases/coverage stay crisp.

So the host must use the **Vita model**: a sub-512 logical viewport rendered at
`density` to reach native resolution. The logical size is a per-device tuning
knob; constraints:

- `logical_w ≤ 511`, `logical_h ≤ 511`
- `logical_w * density ≤ phys_w`, `logical_h * density ≤ phys_h`
- integer `density ∈ {1,2,3,4}`
- prefer `logical * density == phys` per axis (no letterbox); otherwise
  integer-fit centered with a letterbox origin that `input.rs` must subtract.

Worked examples:

| Device (phys) | density | logical | logical×density | fit? |
| --- | --- | --- | --- | --- |
| 1024×758 (Touch Lux 3) | 2 | **512×379** | 1024×758 | exact, but 512 > 511 ❌ touch |
| 1024×758 | 2 | **480×355** | 960×710 | letterboxed (32px/24px) ✅ |
| 1024×758 | 2 | **510×379** | 1020×758 | 4px side letterbox ✅ |
| 1872×1404 (InkPad) | 4 | **468×351** | 1872×1404 | exact ✅ |

**Recommendation:** default to a Vita-proportioned logical viewport (e.g.
`480×320` or `510×379`) at density 2, integer-fit centered, and make
`(logical_w, logical_h, density)` runtime-configurable (read from the pak
manifest or a host config) so each device model gets a tuned value. Finalize the
exact numbers **on hardware** — text crispness vs. letterboxing is a visual
trade-off that can't be settled off-device. The touch clamp in `input.rs`
(`.clamp(0, 511)`) is a safety net, not a substitute for choosing a legal
logical size.

---

## 10. Pak loading & build integration

**Loading** is trivial because `UiSurface::feed_pak` does the native feeding
(styles → `load_styles`, `ui:font.*` → `load_font_atlas`, `ui:img.*` →
`upload_texture` + `__textures`, `ui:sprite.*` → `__sprites`). The host only
reads two files:

```rust
fn pak_path() -> String {
    // Apps live under /mnt/ext1/applications/<app>/ on device.
    std::env::var("POCKET_PAK").unwrap_or_else(|_| "app.pak".into())
}
fn js_path() -> String {
    std::env::var("POCKET_JS").unwrap_or_else(|_| "app.js".into())
}
```

**Target profile** — add `pocketbook` to `contracts/spec/platforms.ts`, shaped
exactly like `vita` (the other density-2 touch target):

```typescript
// In POCKET_TARGETS (and add `readonly pocketbook: TargetProfile<…>` to the type):
pocketbook: {
  hostAbi: 5,                       // next free ABI (psp=1, vita=2, macos-widget=3,
                                    // symbian-e7-dev=4)
  platform: "pocketbook",
  form: "takeover",
  display: {
    physicalViewport: [1024, 758],  // Touch Lux 3 reference; host queries the panel
    logicalViewports: [[480, 320]], // §9 — must be ≤511/axis for touch
    presentations: ["integer-fit"],
    rasterDensity: 2,
  },
  capabilities: [
    "input.buttons",      // D-pad/OK/Back/Menu/Home + page-turn keys
    "input.touch",        // capacitive single-touch
    "text.glyphs.baked",  // font atlases baked at build time
    // NOT: input.analog.left (no stick), input.cursor (no synthesized pointer
    // needed — real touch), display.viewport.live (orientation = restart)
  ],
},
```

Then register a `pocketbook` build backend in the build dispatch registry
(wherever `psp`/`vita` backends are selected — locate via the `POCKET_TARGETS`
consumers in `tools/`). The host's `set_identity("pocketbook", 4)` (§4) must
match `hostAbi` here, or plan-built bundles refuse the host
(`framework/src/host.ts::assertNativeHostContract`).

---

## 11. Background color note

`raster::render*` clears to **opaque black**. E-ink idles white, and most
Tailwind UIs are dark-on-light. Two clean options:

- **App-side (preferred):** the app's root style paints a white background —
  no host special-casing, and dark mode is just another style.
- **Host-side invert:** for a reader-style dark-mode toggle, invert in
  `to_gray_and_diff` (`gray = 255 - gray`) and call `refresh.full()` on switch.

---

## 12. Testing strategy

| Layer | What | Command / how |
| --- | --- | --- |
| 1. Logic | App behavior, no device | `programs/sim` scripted-input golden run (unchanged) |
| 2. Raster | Byte-exact RGBA8 of the DrawList | unit test: `raster::render_scaled` → write PNG, inspect |
| 3. Gray + damage | Luminance + tile diff correctness | unit tests in `framebuffer.rs` (synthetic fb → known dirty tiles) |
| 4. Desktop preview | Fast iteration of the same core+framework | `cargo run -p uihost -- --app <app>` (wgpu host) |
| 5. Host loop off-device | Event loop + refresh state machine | feed synthetic `Event`s into `input.rs`; assert `Refresh` picks partial vs dynamic vs full |
| 6. On-device | Touch accuracy, ghosting, latency, battery | deploy (§13), tune §9 + §7 thresholds |
| 7. Replay | Deterministic debug | record `(tick, buttons, touches)` JSON on device, replay in sim |

The `pocket-mod` addition (§6) gets a unit test mirroring the existing
`frame_passes_analog_and_defaults_to_center`: eval a bundle that latches the
3rd arg, call `frame_with_touches`, assert the decoded contacts.

---

## 13. Deployment

```bash
# Build host
cd hosts/pocketbook
cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23

# Build app (from repo root)
bun tools/build.ts <app> --target pocketbook   # emits dist/<app>.js + dist/<app>.pak

# Copy to device (USB mass storage)
D=/mnt/ext1/applications/myapp
cp target/armv7-unknown-linux-gnueabi.2.23/release/pocketbook-host $D/myapp
cp dist/<app>.js  $D/app.js
cp dist/<app>.pak $D/app.pak
chmod +x $D/myapp
# optional: $D/icon.bmp for the launcher
```

---

## 14. Phased checklist (revised against real APIs)

- [ ] **Phase 0 — Refactor**: extract `pocket-ui-surface` (§2); confirm `uihost`
      + OpenStrike still build. *(skip for a throwaway spike; land before merge)*
- [ ] **Phase 1 — Skeleton** (static screen on device)
  - [ ] `hosts/pocketbook` crate + workspace membership + zigbuild target
  - [ ] `main.rs`: channel loop, `Screen::new`, boot guest via `UiSurface`
  - [ ] `framebuffer.rs`: `render_scaled` → Gray8, full blit each tick
  - [ ] `refresh.rs`: `partial_update` only (no policy yet)
  - [ ] Render a test app on device
- [ ] **Phase 2 — Input**
  - [ ] `pocket-mod::frame_with_touches` (+ unit test)
  - [ ] `input.rs`: keys→BTN, pointer→packed touch with §9 scaling/clamp
  - [ ] Button + touch demo app on device
- [ ] **Phase 3 — Refresh policy**
  - [ ] Port slint `is_updating`/dynamic/partial/200ms-cleanup strategy (§7)
  - [ ] Tune 20 ms / 200 ms thresholds on device
- [ ] **Phase 4 — Polish**
  - [ ] Dirty-tile merging; adaptive tick rate (30 fps active / ~5 fps idle)
  - [ ] §9 per-device logical viewport config; orientation handling (`Event::Show` full redraw)
  - [ ] Optional dithering for `gradRect`
- [ ] **Phase 5 — Upstream**
  - [ ] `pocketbook` target profile + build backend (§10)
  - [ ] sim golden + raster/gray/refresh unit tests (§12)
  - [ ] `docs/` page; draft PR per `AGENTS.md` (Conventional Commits:
        `feat(hosts): add PocketBook inkview host`)

---

## 15. Open questions / risks

1. **Logical viewport per device (§9)** — needs on-hardware tuning; the 9-bit
   touch limit is the binding constraint.
2. **`pocket-ui-surface` extraction (§2)** — confirm `dbg.rs` (`DbgMailbox`)
   has no wgpu coupling before moving (it probes a files/mailbox transport;
   should be clean).
3. **inkview dependency source** — crates.io availability of `inkview 0.3`;
   until confirmed, use a git/path dep. SDK feature (`sdk-6-10` default) must
   match the target firmware.
4. **`Screen<'static>` threading** — the slint demo creates `Screen` on the
   render thread after `Init`; confirm `GetTaskFramebuffer` is valid from that
   thread on real firmware (it is on the emulator via the `GetCanvas` fallback
   in `screen.rs`).
5. **`KeyRepeat` as button-held** — treated as "still down" here; verify the
   framework's edge detection is happy with repeat events (it edge-detects on
   the bitmask, so repeats are harmless).
6. **Battery vs tick rate** — 30 fps logical tick is a starting point; measure
   and consider dropping to ~10 fps when `dirty` is empty for N consecutive
   ticks.

---

## Key references (verified paths)

| File | Role |
| --- | --- |
| `engine/crates/pocket-ui-wgpu/src/surface.rs` | `UiSurface` — the `ui` HostOps surface to reuse |
| `engine/crates/pocket-ui-wgpu/src/pak.rs` | `walk_pak`/`find_pak` — pak format |
| `engine/pocket3d/examples/uihost/src/main.rs` | Canonical boot + tick loop + BTN bits |
| `engine/crates/pocket-mod/src/lib.rs` | `Guest` — add `frame_with_touches` here |
| `engine/core/src/lib.rs` | `Ui::tick`/`draw`/`set_viewport`/`new_with_raster_density` |
| `engine/raster/src/lib.rs` | `render_scaled` (RGBA8, integer scale 1..4) |
| `engine/core/src/draw.rs` | `DrawList { pub words: Vec<u32> }` |
| `framework/src/touch.ts` | Touch packing `(id<<18) | (y<<9) | x`, 9-bit limit |
| `framework/src/host.ts` | `frame(buttons, analog?, touches?)`, host-contract assert |
| `contracts/spec/platforms.ts` | `POCKET_TARGETS` — add `pocketbook` (vita-shaped) |
| `inkview/src/{lib,screen,event}.rs` | `load`, `iv_main`, `Screen`, `Event`, `Key` |
| `inkview-slint/src/lib.rs` | Reference refresh policy + channel event loop |
| `inkview-rs/examples/inkview-slint-demo/src/main.rs` | `Box::leak` + channel + render-thread wiring |
