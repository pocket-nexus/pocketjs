# PocketJS × inkview: PocketBook E-Ink Backend Integration Guide

> **Goal:** Create a new PocketJS host that renders the PocketJS UI engine on PocketBook
> e-readers via the inkview SDK, enabling native-speed applications built with
> Solid/Vue Vapor/Octane + Tailwind on e-ink hardware.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Project Setup](#3-project-setup)
4. [Component 1 — QuickJS Hosting & HostOps](#4-component-1--quickjs-hosting--hostops)
5. [Component 2 — Framebuffer Pipeline](#5-component-2--framebuffer-pipeline)
6. [Component 3 — E-Ink Refresh Manager](#6-component-3--e-ink-refresh-manager)
7. [Component 4 — Input Mapping](#7-component-4--input-mapping)
8. [Component 5 — Main Loop](#8-component-5--main-loop)
9. [Target Profile Registration](#9-target-profile-registration)
10. [Pak Loading & Build Integration](#10-pak-loading--build-integration)
11. [Cross-Compilation & Deployment](#11-cross-compilation--deployment)
12. [Testing Strategy](#12-testing-strategy)
13. [Optimization & Polish](#13-optimization--polish)
14. [Key References](#14-key-references)

---

## 1. Architecture Overview

### The Full Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│  app.tsx  (Solid, Vue Vapor or Octane + Tailwind classes)       │
│  Compiled by @pocketjs/framework compiler (jsx-plugin, pak)     │
└──────────────────────────┬──────────────────────────────────────┘
                           │  bundle.js + styles.bin + font atlases + images
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  QuickJS  (single realm, ~ES2023)                               │
│  framework/src/renderer-{solid,vue-vapor,octane}.ts             │
│  Emits ui.* ops via globalThis.ui (HostOps interface)           │
└──────────────────────────┬──────────────────────────────────────┘
                           │  ~17 numeric FFI calls (createNode, setProp, setText…)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  pocketjs-core  (Rust, no_std)                                  │
│  UI tree · taffy flexbox layout · style resolve · animation     │
│  Ui::tick(dt=1/60) → Ui::draw() → DrawList (Vec<u32>)          │
└──────────────────────────┬──────────────────────────────────────┘
                           │  DrawList: 8 opcodes (rect, gradRect, glyphRun,
                           │  texQuad, scissor, scissorPop, tri, texTri)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Software Rasterizer  (engine/core/src/raster.rs)               │
│  render(ui, words, fb) → RGBA8 framebuffer                      │
│  Already exists — used by wasm/web/sim hosts                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │  RGBA8 pixels (logical viewport resolution)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  NEW: hosts/pocketbook                                          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ Gray8 Convert │  │ Damage Tracker   │  │ Refresh Manager   │  │
│  │ + Dithering   │  │ (dirty regions)  │  │ (partial/dynamic/ │  │
│  │               │  │                  │  │  full selection)  │  │
│  └──────┬───────┘  └────────┬─────────┘  └─────────┬─────────┘  │
│         └───────────────────┼──────────────────────┘            │
│                             ▼                                   │
│                    inkview Screen blit                           │
│                    + PartialUpdate / DynamicUpdate / FullUpdate  │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  libinkview.so → PocketBook e-ink display                       │
│  (8-bit grayscale, 1024×758 to 1872×1404 depending on model)    │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Works

PocketJS's rendering is split into three strictly separated layers:

1. **Core** (Rust, `no_std`): owns the UI tree, runs layout/animation, emits a DrawList.
2. **DrawList**: a flat `Vec<u32>` command stream — the core→backend IR. 8 opcodes,
   format pinned in `contracts/spec/spec.ts`, codegen'd to `engine/core/src/spec.rs`.
   All coordinates are pre-clipped to the viewport by the core's Sutherland–Hodgman
   stage; backends do **zero** clipping.
3. **Backend**: walks the DrawList and renders it. Existing backends target sceGu (PSP),
   vita2d/GXM (Vita), wgpu (desktop), and a software rasterizer (wasm/web/sim).

The **software rasterizer** already produces an RGBA8 framebuffer from any DrawList.
For an e-ink device with no GPU, we reuse it directly and add only the
RGBA8→Gray8 conversion + e-ink refresh management on top.

### What Changes Where

| Project | Changes |
| --------- | --------- |
| **inkview-rs** | **None.** Used as a dependency as-is. |
| **pocketjs-core** | **None.** DrawList + software rasterizer used unchanged. |
| **pocketjs framework** | **None.** Solid/Vue Vapor/Octane renderers are host-agnostic. |
| **pocketjs contracts** | **Additive.** New target profile in `platforms.ts`, new build backend entry. |
| **NEW `hosts/pocketbook/`** | **All the new code.** ~1000–2000 lines of Rust. |

---

## 2. Prerequisites

### Knowledge

- Basic Rust (structs, traits, closures — you don't need to be an expert)
- Familiarity with PocketJS app development (you'll write apps in Solid/Vue Vapor/Octane)
- Understanding of e-ink display characteristics (ghosting, refresh modes)

### Tools

| Tool | Purpose |
| ------ | --------- |
| Rust toolchain (stable) | Compile the host |
| `cargo-zigbuild` | Cross-compile for PocketBook's ARM Linux (glibc 2.23) |
| Zig | Required by cargo-zigbuild for cross-linking |
| Node.js + pnpm | Build the JS framework/bundles |
| A PocketBook device | On-device testing (any model running SDK 6.5+ firmware) |

### Key Dependencies (Rust)

```toml
[dependencies]
pocketjs-core = { path = "../../engine/core" }   # UI engine + software rasterizer
inkview = "0.3"                                    # PocketBook SDK bindings
pocket-mod = { path = "../../engine/crates/pocket-mod" }  # QuickJS hosting (optional, see §4)
```

---

## 3. Project Setup

### Directory Structure

Following PocketJS's placement rules (`docs/STRUCTURE.md`), the new host lives at:

```
pocketjs/
└── hosts/
    └── pocketbook/
        ├── Cargo.toml
        ├── build.rs              # Optional: embed pak at compile time
        └── src/
            ├── main.rs           # Entry point, event loop glue
            ├── host_ops.rs       # HostOps → pocketjs_core::Ui forwarders
            ├── framebuffer.rs    # RGBA8 → Gray8 conversion + dithering
            ├── refresh.rs        # E-ink refresh manager (damage tracking)
            ├── input.rs          # inkview events → PocketJS input state
            └── ffi.rs            # QuickJS globalThis.ui installation
```

### Cargo.toml

```toml
[package]
name = "pocketbook-host"
version = "0.1.0"
edition = "2021"

[dependencies]
pocketjs-core = { path = "../../engine/core" }
inkview = "0.3"
# Option A: use pocket-mod for QuickJS hosting (simpler)
pocket-mod = { path = "../../engine/crates/pocket-mod" }
# Option B: embed QuickJS directly like the PSP host (tighter control)
# libquickjs-sys = { path = "../../engine/crates/libquickjs-sys" }

[profile.release]
opt-level = "s"       # Size-optimized (e-ink devices have limited storage)
lto = true
strip = true
panic = "abort"
```

### Cross-Compilation Target

PocketBook devices run ARM Linux with glibc 2.23:

```bash
# Install once
rustup target add armv7-unknown-linux-gnueabi
cargo install cargo-zigbuild

# Build
cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23

# The binary dynamically loads libinkview.so at runtime — no SDK needed at build time
```

This is the same approach inkview-rs uses. The resulting binary is a standalone
ELF that you copy to the PocketBook's `applications/` directory.

---

## 4. Component 1 — QuickJS Hosting & HostOps

### What This Does

Installs the `globalThis.ui` namespace inside QuickJS so the JS framework can
call `ui.createNode()`, `ui.setProp()`, etc. Each call forwards 1:1 to a
`pocketjs_core::Ui` method.

### Approach A: Using `pocket-mod` (Recommended for Starting)

The `pocket-mod` crate handles QuickJS realm lifecycle, surface mounting, and
per-tick pumping. The desktop wgpu host (`pocket-ui-wgpu/src/surface.rs`) uses it.

```rust
// src/ffi.rs — sketch
use pocket_mod::Guest;
use pocketjs_core::Ui;

pub fn install_ui_namespace(guest: &mut Guest, ui: &mut Ui) {
    guest.mount("ui", |ctx, ns| {
        // Identity markers — the framework checks these to know it's a native host
        ns.set("__host", "pocketbook");
        ns.set("__hostAbi", 2);  // Match current ABI version from contracts/spec/spec.ts

        // The 17 required HostOps — each is a thin forwarder:
        ns.func("createNode", |ctx, args| {
            let node_type = args[0].as_i32();
            let id = ui.create_node(node_type);
            Ok(id.into())
        });

        ns.func("destroyNode", |ctx, args| {
            ui.destroy_node(args[0].as_i32());
            Ok(().into())
        });

        ns.func("insertBefore", |ctx, args| {
            ui.insert_before(args[0].as_i32(), args[1].as_i32(), args[2].as_i32());
            Ok(().into())
        });

        ns.func("removeChild", |ctx, args| {
            ui.remove_child(args[0].as_i32(), args[1].as_i32());
            Ok(().into())
        });

        ns.func("setStyle", |ctx, args| {
            ui.set_style(args[0].as_i32(), args[1].as_i32());
            Ok(().into())
        });

        ns.func("setProp", |ctx, args| {
            ui.set_prop(args[0].as_i32(), args[1].as_i32(), args[2].as_f64());
            Ok(().into())
        });

        ns.func("setText", |ctx, args| {
            let text = args[1].as_str();
            ui.set_text(args[0].as_i32(), text);
            Ok(().into())
        });

        ns.func("replaceText", |ctx, args| {
            let text = args[1].as_str();
            ui.replace_text(args[0].as_i32(), text);
            Ok(().into())
        });

        ns.func("uploadTexture", |ctx, args| {
            let buf = args[0].as_bytes();
            let (w, h, psm) = (args[1].as_i32(), args[2].as_i32(), args[3].as_i32());
            let handle = ui.upload_texture(buf, w, h, psm);
            Ok(handle.into())
        });

        ns.func("setImage", |ctx, args| {
            ui.set_image(args[0].as_i32(), args[1].as_i32());
            Ok(().into())
        });

        ns.func("setSprite", |ctx, args| {
            ui.set_sprite(args[0].as_i32(), args[1].as_i32(),
                          args[2].as_i32(), args[3].as_i32(), args[4].as_f64());
            Ok(().into())
        });

        ns.func("animate", |ctx, args| {
            let id = ui.animate(
                args[0].as_i32(), args[1].as_i32(), args[2].as_f64(),
                args[3].as_f64(), args[4].as_i32(), args[5].as_f64(),
            );
            Ok(id.into())
        });

        ns.func("cancelAnim", |ctx, args| {
            ui.cancel_anim(args[0].as_i32());
            Ok(().into())
        });

        ns.func("setFocus", |ctx, args| {
            ui.set_focus(args[0].as_i32());
            Ok(().into())
        });

        ns.func("measureText", |ctx, args| {
            let text = args[0].as_str();
            let font_slot = args[1].as_i32();
            let width = ui.measure_text(text, font_slot);
            Ok(width.into())
        });

        // Optional: fast batch path
        ns.func("setPropBatch", |ctx, args| {
            let records = args[0].as_bytes();
            ui.set_prop_batch(records);
            Ok(().into())
        });
    });
}
```

> **Note:** The exact `pocket-mod` API (`mount`, `ns.func`, argument accessors)
> is sketched from the patterns in `engine/crates/pocket-ui-wgpu/src/surface.rs`
> and `hosts/psp/src/ffi.rs`. Consult those files for the precise signatures.

### Approach B: Direct QuickJS (Like the PSP Host)

The PSP host (`hosts/psp/src/ffi.rs:821–946`) embeds QuickJS directly via
`libquickjs-sys`, using `JS_NewCFunction2` + `JS_SetPropertyStr` for each op.
This gives tighter control (arena allocator, VFPU worker thread on PSP) but is
more boilerplate. For PocketBook, Approach A is sufficient — the device has
ample CPU/RAM compared to a PSP.

### Pak Feeding

Before JS eval, feed the pak (styles, font atlases, images) to the core natively
and expose name→handle tables:

```rust
// In main.rs, before guest.eval(bundle_js):
let pak = load_pak_from_disk("app.pak");  // or embed at compile time

// Feed styles + font atlases to the core
ui.load_styles(&pak.styles_bin);
for atlas in &pak.font_atlases {
    ui.load_font_atlas(atlas);
}

// Feed images and build the __textures table
let mut textures = HashMap::new();
for (name, img) in &pak.images {
    let handle = ui.upload_texture(&img.pixels, img.w, img.h, img.psm);
    textures.insert(name.clone(), handle);
}

// Expose as ui.__textures so the framework can resolve <Image src="icon.png">
guest.mount("ui", |ctx, ns| {
    ns.set("__textures", textures_to_js_object(ctx, &textures));
});
```

---

## 5. Component 2 — Framebuffer Pipeline

### What This Does

Takes the DrawList from `Ui::draw()`, rasterizes it to RGBA8 using the existing
software rasterizer, then converts to 8-bit grayscale with dithering for the
e-ink display.

### Step 1: Software Raster (Already Exists)

```rust
// src/framebuffer.rs — sketch
use pocketjs_core::{Ui, raster};

pub struct FramebufferPipeline {
    rgba: Vec<u8>,       // RGBA8 scratch buffer (logical viewport size)
    gray: Vec<u8>,       // Gray8 output buffer
    prev_gray: Vec<u8>,  // Previous frame (for damage detection)
    width: usize,
    height: usize,
}

impl FramebufferPipeline {
    pub fn new(width: usize, height: usize) -> Self {
        let size = width * height;
        Self {
            rgba: vec![0u8; size * 4],
            gray: vec![255u8; size],       // Start white
            prev_gray: vec![255u8; size],  // Start white
            width,
            height,
        }
    }

    /// Rasterize the current DrawList into the RGBA8 buffer.
    pub fn rasterize(&mut self, ui: &Ui, words: &[u32]) {
        // The core's software rasterizer — same one used by wasm/sim hosts.
        // Signature: render(ui, words, fb) where fb is &mut [u8] of size w*h*4.
        // Clears to transparent, then draws all ops.
        raster::render(ui, words, &mut self.rgba);
    }
```

### Step 2: RGBA8 → Gray8 Conversion with Dithering

```rust
    /// Convert RGBA8 → Gray8 with Floyd–Steinberg dithering.
    /// Returns a list of dirty (x, y, w, h) regions that changed.
    pub fn convert_and_diff(&mut self) -> Vec<DirtyRect> {
        let (w, h) = (self.width, self.height);

        // --- RGBA8 → Gray8 (luminance) ---
        // Use the same coefficients as inkview-rs: 0.2125R + 0.7154G + 0.0721B
        // Also apply alpha compositing over white background.
        for i in 0..w * h {
            let r = self.rgba[i * 4 + 0] as f32;
            let g = self.rgba[i * 4 + 1] as f32;
            let b = self.rgba[i * 4 + 2] as f32;
            let a = self.rgba[i * 4 + 3] as f32 / 255.0;

            let lum = 0.2125 * r + 0.7154 * g + 0.0721 * b;
            // Composite over white (e-ink default background)
            let composited = lum * a + 255.0 * (1.0 - a);
            self.gray[i] = composited.clamp(0.0, 255.0) as u8;
        }

        // --- Floyd–Steinberg dithering (optional, for gradients) ---
        // Only apply if the UI uses gradients (gradRect ops).
        // For flat-color UIs (most Tailwind-style apps), skip this —
        // the 256 gray levels are more than enough.
        //
        // If needed, apply in-place on self.gray:
        // self.floyd_steinberg_dither();

        // --- Damage detection ---
        let dirty = self.compute_dirty_regions();

        // Swap for next frame
        std::mem::swap(&mut self.gray, &mut self.prev_gray);

        dirty
    }

    /// Find bounding boxes of changed pixel regions.
    /// Uses a simple tile-based approach: divide the screen into NxN tiles,
    /// mark tiles that have any changed pixel, merge adjacent dirty tiles.
    fn compute_dirty_regions(&self) -> Vec<DirtyRect> {
        const TILE: usize = 16;  // 16×16 pixel tiles
        let (w, h) = (self.width, self.height);
        let tiles_x = (w + TILE - 1) / TILE;
        let tiles_y = (h + TILE - 1) / TILE;
        let mut dirty_tiles = vec![false; tiles_x * tiles_y];

        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if self.gray[i] != self.prev_gray[i] {
                    dirty_tiles[(y / TILE) * tiles_x + (x / TILE)] = true;
                }
            }
        }

        // Merge adjacent dirty tiles into rectangles
        // (simple approach: one DirtyRect per dirty tile; optimize later)
        dirty_tiles.iter().enumerate()
            .filter(|(_, &dirty)| dirty)
            .map(|(i, _)| {
                let tx = (i % tiles_x) * TILE;
                let ty = (i / tiles_x) * TILE;
                DirtyRect {
                    x: tx,
                    y: ty,
                    w: TILE.min(w - tx),
                    h: TILE.min(h - ty),
                }
            })
            .collect()
    }

    /// Blit the Gray8 buffer to the inkview screen.
    pub fn blit_to_screen(&self, screen: &mut inkview::screen::Screen) {
        let (w, h) = (self.width, self.height);
        for y in 0..h {
            for x in 0..w {
                let gray = self.gray[y * w + x];
                screen.draw(x, y, inkview::screen::BB8(gray));
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DirtyRect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}
```

### Optimization: Only Blit Dirty Regions

Instead of blitting the entire framebuffer every frame, only write changed tiles:

```rust
    pub fn blit_dirty(&self, screen: &mut inkview::screen::Screen, dirty: &[DirtyRect]) {
        for rect in dirty {
            for y in rect.y..(rect.y + rect.h) {
                for x in rect.x..(rect.x + rect.w) {
                    let gray = self.gray[y * self.width + x];
                    screen.draw(x, y, inkview::screen::BB8(gray));
                }
            }
        }
    }
```

### Optimization: Direct Gray8 Rasterization

The software rasterizer currently outputs RGBA8. For a future optimization, you
could add a `render_gray8()` variant to `engine/core/src/raster.rs` that outputs
Gray8 directly, skipping the conversion pass. This is optional — the conversion
is cheap compared to the rasterization itself.

---

## 6. Component 3 — E-Ink Refresh Manager

### The Core Problem

PocketJS ticks at 60fps. E-ink displays can't refresh that fast:

| Update Mode | Latency | Quality | Flash? |
| ------------- | --------- | --------- | -------- |
| `FullUpdate` | 500ms–1s | Perfect | Yes (visible) |
| `PartialUpdate` | 100–300ms | High | No |
| `DynamicUpdate` | 50–100ms | Low (ghosting) | No |
| `SoftUpdate` | ~100ms | Medium | No |

### Strategy: Decouple Logical Ticks from Physical Refreshes

The UI core keeps ticking at 60fps (animations, input responsiveness). The
display only updates when content actually changes, using the fastest
acceptable refresh mode.

```rust
// src/refresh.rs — sketch
use std::time::Instant;
use crate::framebuffer::DirtyRect;

pub struct RefreshManager {
    /// Accumulated damage since last full/partial update
    accumulated_damage: Option<DirtyRect>,
    /// Time of last screen update
    last_update: Instant,
    /// Time of last full (flashing) update
    last_full_update: Instant,
    /// Count of fast updates since last full update
    fast_update_count: u32,
    /// Whether a screen update is currently in progress
    update_in_progress: bool,
    /// Threshold: do a full update after this many fast updates
    full_update_interval: u32,
    /// Quiet period before final cleanup update (ms)
    quiet_period_ms: u128,
    /// Minimum interval between dynamic updates (ms)
    min_dynamic_interval_ms: u128,
}

impl RefreshManager {
    pub fn new() -> Self {
        Self {
            accumulated_damage: None,
            last_update: Instant::now(),
            last_full_update: Instant::now(),
            fast_update_count: 0,
            update_in_progress: false,
            full_update_interval: 20,     // Full flash every 20 fast updates
            quiet_period_ms: 200,         // 200ms quiet → cleanup update
            min_dynamic_interval_ms: 20,  // Max ~50fps dynamic updates
        }
    }

    /// Called every tick with the dirty regions from the framebuffer pipeline.
    /// Decides whether and how to update the physical display.
    pub fn on_frame(
        &mut self,
        screen: &mut inkview::screen::Screen,
        dirty: &[DirtyRect],
        is_transition: bool,  // true on screen/page changes
    ) {
        if dirty.is_empty() && !is_transition {
            // No visual change — check if we need a delayed cleanup update
            self.maybe_cleanup_update(screen);
            return;
        }

        // Merge all dirty rects into one bounding box
        let merged = merge_rects(dirty);
        self.accumulated_damage = Some(match self.accumulated_damage {
            Some(existing) => union_rect(existing, merged),
            None => merged,
        });

        let now = Instant::now();
        let elapsed = now.duration_since(self.last_update).as_millis();

        if is_transition {
            // Screen/page transition → full update (clean, no ghosting)
            self.do_full_update(screen);
            return;
        }

        if self.update_in_progress {
            // Previous update still running → use dynamic (fast/ugly) if enough time passed
            if elapsed >= self.min_dynamic_interval_ms {
                self.do_dynamic_update(screen, merged);
            }
            // Otherwise skip this frame's display update entirely
            return;
        }

        // Normal case: partial update on the damage region
        self.do_partial_update(screen, merged);
    }

    fn do_full_update(&mut self, screen: &mut inkview::screen::Screen) {
        screen.full_update();
        self.last_full_update = Instant::now();
        self.last_update = Instant::now();
        self.fast_update_count = 0;
        self.accumulated_damage = None;
        self.update_in_progress = false;
    }

    fn do_partial_update(&mut self, screen: &mut inkview::screen::Screen, rect: DirtyRect) {
        screen.partial_update(rect.x, rect.y, rect.w, rect.h);
        self.last_update = Instant::now();
        self.fast_update_count += 1;
        self.accumulated_damage = None;
        self.update_in_progress = true;  // Will be cleared when is_updating() returns false

        // After N fast updates, schedule a full update to clear ghosting
        if self.fast_update_count >= self.full_update_interval {
            // Don't do it now (would flash during interaction) —
            // it will trigger on the next quiet period
        }
    }

    fn do_dynamic_update(&mut self, screen: &mut inkview::screen::Screen, rect: DirtyRect) {
        screen.dynamic_update(rect.x, rect.y, rect.w, rect.h);
        self.last_update = Instant::now();
        self.fast_update_count += 1;
    }

    /// After a quiet period, do a final high-quality update on accumulated damage.
    /// Also triggers periodic full updates to prevent ghosting buildup.
    fn maybe_cleanup_update(&mut self, screen: &mut inkview::screen::Screen) {
        let now = Instant::now();
        let quiet_ms = now.duration_since(self.last_update).as_millis();

        if quiet_ms < self.quiet_period_ms {
            return;  // Still in active interaction
        }

        if let Some(damage) = self.accumulated_damage.take() {
            // Final cleanup: high-quality partial update on accumulated region
            screen.partial_update(damage.x, damage.y, damage.w, damage.h);
            self.last_update = now;
            self.update_in_progress = false;
        }

        // Periodic full update to eliminate ghosting
        let since_full = now.duration_since(self.last_full_update).as_millis();
        if self.fast_update_count >= self.full_update_interval && since_full > 2000 {
            self.do_full_update(screen);
        }
    }

    /// Poll inkview's update status to clear the in_progress flag.
    pub fn poll_update_status(&mut self, screen: &mut inkview::screen::Screen) {
        if self.update_in_progress && !screen.is_updating() {
            self.update_in_progress = false;
        }
    }
}

fn merge_rects(rects: &[DirtyRect]) -> DirtyRect {
    let mut x0 = usize::MAX;
    let mut y0 = usize::MAX;
    let mut x1 = 0usize;
    let mut y1 = 0usize;
    for r in rects {
        x0 = x0.min(r.x);
        y0 = y0.min(r.y);
        x1 = x1.max(r.x + r.w);
        y1 = y1.max(r.y + r.h);
    }
    DirtyRect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

fn union_rect(a: DirtyRect, b: DirtyRect) -> DirtyRect {
    let x0 = a.x.min(b.x);
    let y0 = a.y.min(b.y);
    let x1 = (a.x + a.w).max(b.x + b.w);
    let y1 = (a.y + a.h).max(b.y + b.h);
    DirtyRect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
```

### Tuning Guidelines

| Scenario | Recommended Mode | Why |
| ---------- | ----------------- | ----- |
| Button press highlight | `PartialUpdate` on button rect | Small region, no flash |
| Text input / cursor blink | `PartialUpdate` on cursor area | Tiny region, frequent |
| List scrolling | `DynamicUpdate` during drag, `PartialUpdate` on release | Fast during motion, clean up after |
| Page/screen transition | `FullUpdate` | Complete redraw, eliminates ghosting from previous screen |
| Animation (e.g., progress bar) | `DynamicUpdate` at 20ms intervals, `PartialUpdate` when done | Smooth-ish motion, cleanup after |
| Idle / no changes | No update | Save power, e-ink holds image without refresh |

---

## 7. Component 4 — Input Mapping

### What This Does

Translates inkview's touch and key events into PocketJS's `frame(buttons, analog?, touches?)`
call signature.

### PocketJS Input Contract

The host calls `globalThis.frame(buttons, analog?, touches?)` exactly once per tick:

- `buttons`: a bitmask of currently-held buttons (spec-defined bit positions)
- `analog`: optional `{x, y}` for analog sticks (not applicable on PocketBook)
- `touches`: optional array of `{id, x, y, phase}` for touch points

### Implementation

```rust
// src/input.rs — sketch
use inkview::event::{Event, Key};

pub struct InputState {
    /// Currently held buttons (bitmask)
    pub buttons: u32,
    /// Current touch point (PocketBook is single-touch)
    pub touch: Option<TouchPoint>,
    /// Events queued during this tick (processed at frame boundary)
    pending_events: Vec<Event>,
}

#[derive(Clone, Copy)]
pub struct TouchPoint {
    pub x: i32,
    pub y: i32,
    pub phase: TouchPhase,
}

#[derive(Clone, Copy, PartialEq)]
pub enum TouchPhase {
    Down,
    Move,
    Up,
}

impl InputState {
    pub fn new() -> Self {
        Self { buttons: 0, touch: None, pending_events: Vec::new() }
    }

    /// Called from the inkview event handler (may fire multiple times per tick)
    pub fn push_event(&mut self, event: Event) {
        self.pending_events.push(event);
    }

    /// Called once per tick, before frame(). Processes all pending events.
    pub fn drain(&mut self) {
        for event in self.pending_events.drain(..) {
            match event {
                // --- Touch ---
                Event::PointerDown { x, y } => {
                    self.touch = Some(TouchPoint { x, y, phase: TouchPhase::Down });
                }
                Event::PointerMove { x, y } => {
                    self.touch = Some(TouchPoint { x, y, phase: TouchPhase::Move });
                }
                Event::PointerUp { x, y } => {
                    self.touch = Some(TouchPoint { x, y, phase: TouchPhase::Up });
                }

                // --- Hardware keys → button bitmask ---
                // Bit positions must match contracts/spec/spec.ts BUTTON enum.
                Event::KeyDown { key } => self.buttons |= key_to_button_bit(key),
                Event::KeyUp { key } => self.buttons &= !key_to_button_bit(key),

                _ => {}  // Ignore Init, Show, Repaint, etc.
            }
        }
    }
}

/// Map PocketBook hardware keys to PocketJS button bits.
/// Consult contracts/spec/spec.ts for the canonical BUTTON bitmask values.
fn key_to_button_bit(key: Key) -> u32 {
    match key {
        Key::Up     => 1 << 0,   // BUTTON_UP
        Key::Down   => 1 << 1,   // BUTTON_DOWN
        Key::Left   => 1 << 2,   // BUTTON_LEFT
        Key::Right  => 1 << 3,   // BUTTON_RIGHT
        Key::Ok     => 1 << 4,   // BUTTON_CROSS / confirm
        Key::Back   => 1 << 5,   // BUTTON_CIRCLE / back
        Key::Menu   => 1 << 6,   // BUTTON_START / menu
        Key::Prev   => 1 << 7,   // BUTTON_LTRIGGER / page prev
        Key::Next   => 1 << 8,   // BUTTON_RTRIGGER / page next
        Key::Prev2  => 1 << 7,   // Alternate page-turn buttons → same as Prev
        Key::Next2  => 1 << 8,   // Alternate page-turn buttons → same as Next
        Key::Home   => 1 << 9,   // BUTTON_SELECT / home
        _ => 0,
    }
}
```

### Coordinate Mapping

Touch coordinates from inkview are in physical screen pixels. If the logical
viewport differs from the physical resolution (e.g., logical 480×272 on a
1024×758 screen with rasterDensity 2), scale accordingly:

```rust
fn scale_touch(x: i32, y: i32, physical_w: usize, logical_w: usize) -> (i32, i32) {
    let scale = logical_w as f32 / physical_w as f32;
    ((x as f32 * scale) as i32, (y as f32 * scale) as i32)
}
```

---

## 8. Component 5 — Main Loop

### The Event Loop Challenge

inkview uses a **blocking callback-based** event loop (`iv_main`). PocketJS hosts
typically own their own tick loop. We need to reconcile these.

### Solution: Timer-Driven Ticks Inside the inkview Event Loop

Use inkview's `SetHardTimer` to drive ticks at 60fps (or a lower rate like 30fps
to save CPU — e-ink doesn't need 60fps display updates, but the core benefits
from consistent tick timing for animations).

```rust
// src/main.rs — sketch
use std::sync::{Arc, Mutex};
use inkview::{load, iv_main, screen::Screen};
use pocketjs_core::Ui;

// Shared state accessible from both the event handler and the timer callback.
// inkview's event handler and timer callbacks run on the same thread,
// so a simple Rc<RefCell<>> would also work. Using Arc<Mutex> for safety.
struct AppState {
    ui: Ui,
    pipeline: FramebufferPipeline,
    refresh: RefreshManager,
    input: InputState,
    screen: Screen<'static>,  // 'static lifetime via unsafe; inkview is single-threaded
    guest: Guest,             // QuickJS realm
    running: bool,
}

fn main() {
    // 1. Load inkview bindings
    let iv = load().expect("Failed to load libinkview.so");

    // 2. Query display properties
    let phys_w = iv.ScreenWidth() as usize;
    let phys_h = iv.ScreenHeight() as usize;
    let dpi = iv.get_screen_dpi();
    let scale = iv.get_screen_scale_factor();

    // 3. Choose logical viewport
    //    Option A: logical = physical (1:1, simplest)
    //    Option B: logical = physical/2 with rasterDensity 2 (like Vita's 480×272 on 960×544)
    //    For e-ink, 1:1 is usually best — you want all the pixels.
    let logical_w = phys_w;
    let logical_h = phys_h;

    // 4. Initialize the UI core
    let mut ui = Ui::new();
    ui.set_viewport(logical_w as f32, logical_h as f32);

    // 5. Initialize QuickJS and install HostOps
    let mut guest = Guest::new();
    install_ui_namespace(&mut guest, &mut ui);

    // 6. Load the pak and feed it natively
    let pak = load_pak("app.pak");
    ui.load_styles(&pak.styles);
    for atlas in &pak.font_atlases {
        ui.load_font_atlas(atlas);
    }
    // ... upload textures, set __textures/__sprites ...

    // 7. Evaluate the JS bundle
    guest.eval(&pak.bundle_js);

    // 8. Initialize framebuffer pipeline and refresh manager
    let pipeline = FramebufferPipeline::new(logical_w, logical_h);
    let refresh = RefreshManager::new();
    let input = InputState::new();
    let screen = Screen::new(&iv);

    // 9. Pack into shared state
    let state = Arc::new(Mutex::new(AppState {
        ui, pipeline, refresh, input, screen, guest, running: true,
    }));

    // 10. Set up the tick timer (~60fps = every 16ms, or 30fps = every 33ms)
    let tick_state = Arc::clone(&state);
    iv.SetHardTimer(1, 16, move || {
        tick(tick_state.clone());
    });

    // 11. Enter the inkview event loop (blocks until app exit)
    let event_state = Arc::clone(&state);
    iv_main(&iv, move |event| {
        let mut state = event_state.lock().unwrap();
        match event {
            Event::Init => {
                // App initialization complete
                Some(())
            }
            Event::Exit => {
                state.running = false;
                None  // Let inkview handle exit
            }
            Event::Hide => {
                // App moved to background — could pause the timer
                Some(())
            }
            Event::Show => {
                // App returned to foreground — resume, do a full update
                state.refresh.do_full_update(&mut state.screen);
                Some(())
            }
            // Forward input events to the input state
            Event::KeyDown { .. } | Event::KeyUp { .. }
            | Event::PointerDown { .. } | Event::PointerMove { .. }
            | Event::PointerUp { .. } => {
                state.input.push_event(event);
                Some(())
            }
            _ => None,
        }
    });
}

/// One tick of the PocketJS frame loop.
/// Called by the hardware timer at ~60fps.
fn tick(state: Arc<Mutex<AppState>>) {
    let mut s = state.lock().unwrap();
    if !s.running { return; }

    // 1. Process input events accumulated since last tick
    s.input.drain();

    // 2. Call the JS frame handler: globalThis.frame(buttons, analog, touches)
    //    This is Law 3: one guest turn per host tick.
    let buttons = s.input.buttons;
    let touches = s.input.touch.map(|t| (t.x, t.y, t.phase));
    s.guest.call_frame(buttons, None, touches);

    // 3. Drain QuickJS microtask jobs
    s.guest.drain_jobs();

    // 4. Tick the UI core (fixed dt = 1/60)
    s.ui.tick(1.0 / 60.0);

    // 5. Draw → DrawList
    let words = s.ui.draw();

    // 6. Rasterize DrawList → RGBA8
    s.pipeline.rasterize(&s.ui, &words);

    // 7. Convert RGBA8 → Gray8 + detect damage
    let dirty = s.pipeline.convert_and_diff();

    // 8. Blit dirty regions to the inkview framebuffer
    if !dirty.is_empty() {
        s.pipeline.blit_dirty(&mut s.screen, &dirty);
    }

    // 9. Let the refresh manager decide how to update the physical display
    s.refresh.poll_update_status(&mut s.screen);
    s.refresh.on_frame(&mut s.screen, &dirty, false);
}
```

### Alternative: Lower Tick Rate for Battery

E-ink doesn't need 60fps. You could tick at 30fps or even 20fps and still feel
responsive, while significantly reducing CPU usage and battery drain:

```rust
// 30fps tick (33ms interval) — good balance for e-ink
iv.SetHardTimer(1, 33, move || { tick(state.clone()); });

// Or even adaptive: 60fps during touch interaction, 10fps when idle
```

---

## 9. Target Profile Registration

Add a `pocketbook` target to `contracts/spec/platforms.ts`:

```typescript
// contracts/spec/platforms.ts — add to the target registry

pocketbook: {
    hostAbi: 2,                    // Match current ABI version
    platform: "pocketbook",
    form: "takeover",              // Fullscreen app (no windowing on PocketBook)

    display: {
        // Physical resolution varies by device; these are common values.
        // The host queries ScreenWidth()/ScreenHeight() at runtime.
        physicalViewport: [1024, 758],   // Touch Lux 3 (most common)
        // physicalViewport: [1872, 1404],  // InkPad 3 Pro
        logicalViewports: [[1024, 758]],  // 1:1 mapping (no scaling)
        presentations: ["integer-fit"],
        rasterDensity: 1,                 // 1:1 logical→physical
    },

    capabilities: [
        "input.buttons",          // D-pad + OK/Back/Menu/Home + page-turn keys
        "input.touch",            // Capacitive touchscreen (single-touch)
        "text.glyphs.baked",      // Font atlases baked at build time
        // NOT included:
        // "input.analog.left"   — no analog stick
        // "input.cursor"       — no mouse cursor
        // "input.ime"          — no hardware keyboard (could add via OpenKeyboard)
        // "display.viewport.live" — orientation changes require app restart
    ],
},
```

And add a build backend entry in the dispatch registry:

```typescript
// In the build system's target backend registry:
const targetBackends = {
    psp: pspBackend,
    vita: vitaBackend,
    pocketbook: pocketbookBackend,  // NEW
} satisfies Record<PocketTargetId, …>;
```

---

## 10. Pak Loading & Build Integration

### Build Flow

PocketJS apps are compiled into a **pak** — a bundle containing:

| File | Contents |
| ------ | ---------- |
| `bundle.js` | Compiled app (Solid/Vue Vapor/Octane → universal renderer) |
| `styles.bin` | Tailwind classes → style table records |
| `font-atlas-*.bin` | Baked Inter glyph atlases (exactly the app's codepoints) |
| `images/` | PNG/JPEG textures referenced by the app |
| `sprites/` | Sprite sheet definitions |
| `pocket.json` | App manifest (name, entry, target, framework) |

### On the Host Side

The PocketBook host loads the pak at startup:

```rust
/// Load a pak directory from the PocketBook's filesystem.
/// Apps are typically stored in /mnt/ext1/applications/<appname>/
fn load_pak(path: &str) -> Pak {
    let bundle_js = std::fs::read_to_string(format!("{}/bundle.js", path)).unwrap();
    let styles = std::fs::read(format!("{}/styles.bin", path)).unwrap();

    let mut font_atlases = Vec::new();
    for entry in std::fs::read_dir(path).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        if name.starts_with("font-atlas-") && name.ends_with(".bin") {
            font_atlases.push(std::fs::read(entry.unwrap().path()).unwrap());
        }
    }

    let mut images = HashMap::new();
    let img_dir = format!("{}/images", path);
    if std::path::Path::new(&img_dir).exists() {
        for entry in std::fs::read_dir(&img_dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().to_string();
            let data = std::fs::read(entry.path()).unwrap();
            // Decode PNG/JPEG → raw RGBA pixels
            let img = decode_image(&data);
            images.insert(name, img);
        }
    }

    Pak { bundle_js, styles, font_atlases, images }
}
```

### Using the Framework's Build API

Custom hosts consume build plans through the stable boundary:

```typescript
// In the build script (TypeScript side)
import { extractHostBuildInputs, hostBuildEnvironment } from "@pocketjs/framework/manifest";

const inputs = extractHostBuildInputs(planJson, { expectedTarget: "pocketbook" });
const env = hostBuildEnvironment(inputs, {
    outputDirectory: "dist/pocket/pocketbook",
    embedApp: false,  // Load from filesystem at runtime
});
```

---

## 11. Cross-Compilation & Deployment

### Build Commands

```bash
# One-time setup
rustup target add armv7-unknown-linux-gnueabi
cargo install cargo-zigbuild

# Build the host binary
cd hosts/pocketbook
cargo zigbuild --release --target armv7-unknown-linux-gnueabi.2.23

# Build the app bundle (from the app directory)
cd ../../apps/my-app
npx pocketjs build --target pocketbook
```

### Deployment to Device

```bash
# Connect PocketBook via USB (appears as mass storage)
# Copy the binary:
cp target/armv7-unknown-linux-gnueabi.2.23/release/pocketbook-host \
   /mnt/ext1/applications/myapp/myapp

# Copy the pak:
cp -r dist/pocket/pocketbook/* /mnt/ext1/applications/myapp/

# The binary must be executable:
chmod +x /mnt/ext1/applications/myapp/myapp
```

### PocketBook App Registration

PocketBook discovers apps in `/mnt/ext1/applications/`. Each app directory
needs the binary and optionally an icon:

```
/mnt/ext1/applications/myapp/
├── myapp              # The ELF binary (renamed to app name)
├── bundle.js          # JS bundle
├── styles.bin         # Compiled styles
├── font-atlas-0.bin   # Font atlases
├── images/            # Textures
└── icon.bmp           # App icon (optional, shown in launcher)
```

### inkview's Dynamic Loading

The `inkview` crate loads `libinkview.so` at runtime via `libloading`. This
means:

- **No SDK installation needed** on the build machine
- **No static linking** to PocketBook's C libraries
- The binary works across firmware versions (SDK 5.19–6.10, selectable via
  cargo features)
- If `libinkview.so` is missing, the app fails gracefully with an error message

---

## 12. Testing Strategy

### Layer 1: Headless Simulation (No Device Needed)

PocketJS has a deterministic sim host (`hosts/sim/`) that runs the same wasm core
with scripted inputs and produces per-frame framebuffer hashes. Use it to verify
your app's logic is correct before touching the device:

```bash
# Run the sim host against your app
cd hosts/sim
node sim.ts --app ../../apps/my-app --frames 300 --input scripted-input.json
# Produces golden hashes — byte-identical across runs
```

### Layer 2: Software Raster Golden Tests

The software rasterizer produces byte-exact RGBA8 output. You can render your
app's frames on your dev machine and visually inspect them:

```rust
// In a test or example:
let mut fb = vec![0u8; 1024 * 758 * 4];
raster::render(&ui, &words, &mut fb);
// Write fb as a PNG for inspection
write_png("frame_001.png", 1024, 758, &fb);
```

### Layer 3: Desktop Preview with wgpu Host

Run your app on the desktop wgpu host for fast iteration:

```bash
cd engine/crates/pocket-ui-wgpu
cargo run --example uihost -- --app ../../../apps/my-app
```

This uses the same core + framework, just with a GPU backend instead of e-ink.

### Layer 4: On-Device Testing

For final validation, deploy to the PocketBook and test:

- Touch responsiveness and accuracy
- Refresh behavior (ghosting, flashing, update latency)
- Battery impact of tick rate
- Different screen sizes/orientations
- Edge cases: low battery, incoming notifications, app switching

### Layer 5: Deterministic Replay

Because PocketJS's frame model is deterministic (`frame(tick, inputs) → pixels`),
you can record input sequences on-device and replay them in the sim host for
debugging:

```json
// recorded-input.json
{
  "frames": [
    { "tick": 0, "buttons": 0, "touches": [] },
    { "tick": 60, "buttons": 0, "touches": [{"x": 512, "y": 400, "phase": "down"}] },
    { "tick": 65, "buttons": 0, "touches": [{"x": 512, "y": 400, "phase": "up"}] }
  ]
}
```

---

## 13. Optimization & Polish

### Performance

| Optimization | Impact | Effort |
| ------------- | -------- | -------- |
| **Dirty-region rasterization** — only re-rasterize tiles that changed | High (avoids full-frame raster on small changes) | Medium |
| **Adaptive tick rate** — 60fps during touch, 10fps idle | High (battery life) | Low |
| **Direct Gray8 rasterizer** — skip RGBA8 intermediate | Medium (saves one full-frame pass) | Medium |
| **ARM NEON for RGBA→Gray conversion** | Low (conversion is already fast) | Low |
| **Pre-quantized color palette** — restrict UI to 16 grays at design time | Medium (faster dithering, cleaner e-ink output) | Low (design constraint) |

### E-Ink Quality

- **Ghosting management:** The refresh manager's periodic full-update is critical.
  Tune `full_update_interval` based on your app's UI density. Text-heavy apps
  (readers) can go longer; graphically dynamic apps need more frequent full updates.

- **Dithering strategy:** For flat-color Tailwind UIs, no dithering is needed —
  256 gray levels handle it. Enable Floyd–Steinberg only for `gradRect` ops
  (gradients). Ordered (Bayer) dithering is faster and produces less visual noise
  for UI elements.

- **Dark mode:** E-ink displays look best with dark-on-light. If supporting dark
  mode, invert the Gray8 buffer before blitting (`gray = 255 - gray`) and use
  `FullUpdate` on mode switch.

- **Text rendering:** PocketJS bakes font atlases at build time. Ensure the
  rasterDensity matches the device DPI for crisp text. At 1:1 density on a
  212 DPI screen, baked Inter at the right size will look sharp.

### PocketBook-Specific Features (Future)

These are inkview capabilities not in the base PocketJS contract that could be
exposed as optional host ops:

| Feature | inkview API | PocketJS Integration |
| --------- | ------------ | --------------------- |
| Hardware keyboard | `OpenKeyboard()` | Optional `input.ime` capability |
| Battery status | `BatteryPower()`, `IsCharging()` | Expose as `ui.battery()` |
| WiFi | `ConnectNet()`, `QueryNetwork()` | Expose as `ui.network()` |
| File browser | `OpenDirectorySelector()` | Expose as `ui.pickFile()` |
| Front light | (device-specific ioctl) | Expose as `ui.setBrightness()` |
| Orientation | `SetOrientation()`, g-sensor | Expose as `ui.setOrientation()` |
| Config/INI | `OpenConfig()`, `SaveConfig()` | Expose as `ui.settings()` |

These would be **optional capability-gated ops** — the framework already
feature-detects optional HostOps methods.

---

## 14. Key References

### PocketJS Source Files

| File | What It Tells You |
| ------ | ------------------- |
| `docs/DESIGN.md` | Overall architecture philosophy |
| `docs/RUNTIMES.md` | The three laws, Runtime = ⟨Cores, Surfaces, Guest⟩ |
| `docs/STRUCTURE.md` | Where new code goes, placement rules |
| `docs/PLATFORM.md` | Platform contracts, capability registry |
| `contracts/spec/spec.ts` | THE spec: op codes, prop IDs, DrawList format, enums |
| `contracts/spec/platforms.ts` | Target profiles (add `pocketbook` here) |
| `engine/core/src/lib.rs` | `Ui` struct, `tick()`, `draw()`, `set_viewport()` |
| `engine/core/src/draw.rs` | DrawList format, DRAW_OP enum |
| `engine/core/src/raster.rs` | Software rasterizer (`render`, `render_scaled`) |
| `framework/src/host.ts` | `HostOps` interface (the 17 required + optional ops) |
| `framework/src/native-tree.ts` | NodeMirror arena (JS-side tree mirror) |
| `framework/src/renderer-solid.ts` | Solid universal renderer over HostOps |
| `framework/src/renderer-vue-vapor.ts` | Vue Vapor renderer over HostOps |
| `framework/src/renderer-octane.ts` | Octane universal driver over HostOps |
| `hosts/psp/src/ffi.rs` | PSP's HostOps installation (reference implementation) |
| `hosts/psp/src/ge.rs` | PSP's DrawList walker (reference for a GPU backend) |
| `hosts/psp/src/main.rs` | PSP's frame loop ordering |
| `engine/crates/pocket-mod/src/lib.rs` | QuickJS hosting library |
| `engine/crates/pocket-ui-wgpu/src/surface.rs` | Desktop host using pocket-mod |
| `site/content/docs/platform-contracts.md` | Custom host build API |

### inkview-rs Source Files

| File | What It Tells You |
| ------ | ------------------- |
| `inkview/src/lib.rs` | `load()`, `iv_main()`, dynamic loading |
| `inkview/src/screen.rs` | `Screen` struct, draw/update methods, pixel formats |
| `inkview/src/event.rs` | `Event` enum, `Key` enum |
| `inkview/src/bindings.rs` | Raw C API (generated by bindgen) |
| `inkview-eg/src/lib.rs` | embedded-graphics DrawTarget (flush strategy reference) |
| `inkview-slint/src/lib.rs` | Slint backend (refresh strategy reference!) |

### External References

| Resource | URL |
| ---------- | ----- |
| inkview-rs | <https://github.com/simmsb/inkview-rs> |
| pocketjs | <https://github.com/pocket-nexus/pocketjs> |
| PocketBook SDK header | <https://github.com/blchinezu/pocketbook-sdk/blob/master/PBSDK/include/inkview.h> |
| pb-cheatsheet (real-world inkview usage) | <https://blog.flxzt.net/posts/pb-cheatsheet/> |
| inkview Go SDK (additional API docs) | <https://pkg.go.dev/github.com/dennwc/inkview> |

---

## Appendix: Implementation Checklist

- [ ] **Phase 1 — Skeleton** (MVP: static screen renders on device)
  - [ ] Create `hosts/pocketbook/` crate with Cargo.toml
  - [ ] Implement `main.rs`: load inkview, create Screen, enter event loop
  - [ ] Implement `host_ops.rs`: 17 HostOps forwarders to `Ui`
  - [ ] Implement `ffi.rs`: install `globalThis.ui` in QuickJS via pocket-mod
  - [ ] Implement `framebuffer.rs`: software raster → Gray8 (no dithering yet)
  - [ ] Blit full framebuffer on every tick with `SoftUpdate`
  - [ ] Load a simple test app pak, verify it renders on device

- [ ] **Phase 2 — Input** (touch + keys work)
  - [ ] Implement `input.rs`: event → button/touch mapping
  - [ ] Wire into `frame(buttons, touches)` call
  - [ ] Test with a button-press demo app

- [ ] **Phase 3 — Refresh Management** (usable e-ink experience)
  - [ ] Implement `refresh.rs`: damage tracking + update mode selection
  - [ ] Partial updates for small changes
  - [ ] Dynamic updates during scroll/drag
  - [ ] Full updates on transitions + periodic ghosting cleanup
  - [ ] Tune thresholds on device

- [ ] **Phase 4 — Polish**
  - [ ] Floyd–Steinberg / ordered dithering for gradients
  - [ ] Adaptive tick rate (60fps active, 10fps idle)
  - [ ] Dirty-region-only blitting
  - [ ] Multiple device resolution support
  - [ ] Orientation handling

- [ ] **Phase 5 — Upstream**
  - [ ] Target profile in `contracts/spec/platforms.ts`
  - [ ] Build backend in dispatch registry
  - [ ] Golden tests via sim host
  - [ ] Documentation in `docs/`
  - [ ] PR to pocket-nexus/pocketjs
