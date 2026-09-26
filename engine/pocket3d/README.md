# Pocket3D

A small, modern, extensible 3D runtime in Rust — the native desktop base of
the Pocket runtime family (see [docs/RUNTIMES.md](../../docs/RUNTIMES.md)). Built on
**wgpu** (Metal/Vulkan/DX12) + **winit**, with GoldSrc **BSP maps as a
first-class world format**.

Pocket3D is deliberately not a general-purpose engine. It is a lean substrate
you can read in an afternoon: a forward renderer, a first-person character
controller driven by collision traces, skeletal animation, and a headless
verification story that makes every feature screenshot- and script-testable
without opening a window. Specialized runtimes compose it with the guest
infrastructure below; the first one is
**[OpenStrike](https://github.com/pocket-stack/open-strike)**, a CS-like FPS
whose gameplay rules are QuickJS mods and whose HUD is a PocketJS app.

![status](https://img.shields.io/badge/status-v0.1_experiment-orange)

## Native handheld consumers

**`pocket3d-anim` shares skeletal sampling and pose interpolation.**
**`pocket3d-mesh` shares skin bindings, palette evaluation and portable mesh data**
between desktop and handheld hosts. The [citro3d backend](backends/citro3d/README.md)
provides resident indexed GPU skinning on Nintendo 3DS, with caller-owned lights,
poses, targets and frame boundaries. Its folding-prop example is independent of
any application runtime.

[**Pocket Island**](https://github.com/pocket-stack/pocket-island) is a separate
application repository. Movement and gait policy, expressions, chat, camera,
scene resources, QuickJS commands and performance scenarios belong to its
specialized runtime. It pins PocketJS as a submodule instead of carrying a copy
of Pocket3D. Reusable fixes enter this repository before the app updates its pin.

## Layout

```
engine/pocket3d/
├── crates/
│   ├── pocket3d/          # desktop wgpu runtime
│   │   ├── gpu            #   device bootstrap, offscreen targets + PNG readback
│   │   ├── renderer       #   forward renderer: world / models / sprites / viewmodel / HUD passes
│   │   ├── geometry       #   static lightmapped GPU geometry; world is a compatibility alias
│   │   ├── model, anim    #   glTF GPU assets and shared animation re-exports
│   │   ├── collide        #   TraceWorld trait + Quake-style character controller
│   │   ├── camera, input, time, hud, scene, texture
│   │   └── app            #   winit loop (fixed-step sim, mouse capture, overlay hook)
│   ├── pocket3d-anim/     # skeletal sampling and local-pose interpolation
│   ├── pocket3d-mesh/     # skin bindings, colored assets, P3M1 and native packing
│   ├── pocket3d-bsp/      # GoldSrc BSP v30 + WAD3: geometry, lightmaps,
│   │                      # entities, clipnode hull tracing (no GPU deps)
│   ├── pocket3d-scene/    # the .p3sn authored-scene container: chunked
│   │                      # geometry with baked light and fog, culling,
│   │                      # and the runtime surfaces (water/sky/particles)
│   ├── pocket3d-world/    # renderer-free fixed-step bodies, structures,
│   │                      # attachments, heat, moisture, and combustion
│   ├── pocket-mod/        # guest hosting: one QuickJS realm, mounted surfaces,
│   │                      # one guest turn per tick (the mod-runtime mechanism)
│   ├── pocket-ui-wgpu/    # the PocketJS `ui` surface on this base: pak feeding,
│   │                      # HostOps for the guest, DrawList → wgpu, Blit compositor
│   └── pocket-widget/     # desktop widgets as a capability: demand-render shell,
│                          # embedded `ui` surfaces on meshes, part picking (docs/WIDGET.md)
└── examples/
    ├── uihost/            # PocketJS UI demos in a native macOS window
    ├── handheld/          # first pocket-stage package + transitional 3D host
    ├── valley/            # River Valley: the procedural .p3sn scene and a
    │                      # CPU reference rasterizer for it
    ├── valley-vita/       # that scene on PS Vita (docs/POCKET3D-SCENE.md)
    └── note-widget/       # a markdown sticky note — the flat pocket-widget form
```

## Ownership and dependencies

| Component | Owns | Does not own |
| --- | --- | --- |
| `pocket3d-scene` | The `.p3sn` container, the bake model, culling, and the water/sky/particle surfaces | Map formats, GPU lifecycle, scene content |
| `pocket3d-anim` | TRS channels, hierarchy evaluation, pose interpolation | Meshes, rendering, movement policy |
| `pocket3d-mesh` | Shared `Skin`, palette evaluation, colored assets and packing | Window/GPU lifecycle, clip selection |
| `pocket3d` | Desktop glTF loading, wgpu resources, rendering and window loop | A second animation or skin-binding implementation |
| `pocket3d-world` | Fixed-turn entities, contacts, locomotion and material reactions | Render geometry, model assets, animation |
| Application | Input mapping, gait/clip choices, camera, scene composition | Copies of shared animation or mesh mechanisms |

`pocket3d` depends on `pocket3d-mesh` and `pocket3d-anim`; `pocket3d-mesh`
depends on `pocket3d-anim`. `pocket3d-world` is independent of all three. An app
can connect its simulation snapshots to a renderer. **`pocket3d::geometry`
contains static render geometry; `pocket3d::world` is an alias for that module.**
Neither is the `pocket3d-world` simulation crate.

Movement models have different contracts. `pocket3d-bsp::collide` owns the
trace-based Quake controller shared by desktop and PSP. `pocket3d-world` owns
contact-constrained sphere/capsule locomotion and material-dependent grip.
Island owns its bounded walk region and obstacle policy. Changes to one model
do not add game-name branches to another solver. Shared solver changes must
preserve their physical invariant across multiple geometries/materials.

Desktop `pocket3d::anim`, `pocket3d::model::Skin` and `pocket3d::world` import
paths remain available through re-exports. The experimental handheld mesh
imports move from `pocket3d_anim::mesh` to
[`pocket3d_mesh::{colored, rigid}`](crates/pocket3d-mesh/README.md).

## uihost — the PSP UI runtime on the desktop

The same app bundle + pak that boots on PSP hardware runs in a native window:
QuickJS guest (`pocket-mod`), the same `pocketjs-core`, rendered through wgpu
(`pocket-ui-wgpu`) with a chunky nearest-neighbor integer upscale.

```sh
# from the repo root: build a demo, then host it
bun tools/build.ts hero-main
cd pocket3d
cargo run -p uihost -- --app hero-main                # window, 2x scale
cargo run -p uihost -- --app hero-main --screenshot out.png --frames 10
```

Arrows = D-pad, Z/Enter = CROSS, X = CIRCLE, A/S = SQUARE/TRIANGLE,
Q/W = triggers, Tab = SELECT, Space = START, Esc quits.

## pocket-stage — Pocket apps inside authored 3D displays

The first pocket-widget runtime (docs/WIDGET.md): a transparent, undecorated,
always-on-top 3D stage with one or more authored display surfaces. The bundled
stage is a PSP, but the process name is deliberately model-neutral. After the
manifest-v1 migration described in docs/WIDGET.md, iPod, phone, laptop, television,
and room packages use the same host. A JSON asset manifest keeps model-specific
scale, LOD paths, display semantics, camera presets, and CPU pick proxies out
of the runtime. The PSP screen is a live `ui` surface (`OffscreenTarget` bound
to the exact semantic glTF material), and its buttons feed real BTN bits — the
same unmodified bundle uihost runs.

```sh
bun run widget                   # from the repo root: build bundle + binary, launch
bun run widget im                # any demo
bun run widget im --auto-quit 5  # app first; flags and values pass to pocket-stage
bun run widget -- --profile psp.json --orbit 35,-12
bun run widget --proof           # ray-picked CIRCLE acceptance → Count: 1
```

The optional app name is recognized only as the first argument; otherwise the
widget defaults to `hero-main`. All following arguments are forwarded to the
`pocket-stage` binary in order, including values for options such as
`--auto-quit`, `--profile`, and `--orbit`. `--proof` is the only
wrapper-specific flag and is consumed by `tools/widget.ts`; a standalone
`--` is accepted as Bun's option separator.

Or by hand:

```sh
bun tools/build.ts hero-main   # from the repo root
cd pocket3d
cargo run -p pocket-stage -- --app hero-main
cargo run -p pocket-stage -- --app hero-main --screenshot out.png --frames 30
```

Click caps to press them, drag the nub, and double-click the screen to animate
both framing and orbit into an exact-front, screen-filling focus view
(`--focus` starts there). Double-click again to animate back to the exact orbit
that was active before focus; repeated focus cycles do not reset the desk view.
Drag inert body areas to move the window. On a Mac trackpad, two-finger scroll
is the primary orbit gesture: horizontal motion changes yaw and vertical motion
changes pitch. Near exact front, a gentle magnetic dead zone snaps both angles
to zero; a wider release threshold keeps trackpad noise from making the camera
jitter, while accumulated input still lets a deliberate gesture pull away.
A mouse wheel follows the same two-axis path, and right-drag remains available
as a mouse-compatible fallback. Orbit input pauses during focus and its framing
transition so the saved desk orbit cannot be changed accidentally. While a
gesture is active, the widget temporarily uses the 80,879-triangle eco LOD;
after about 100 ms of
scroll inactivity (or immediately after right-button release) it restores the
131,680-triangle settled LOD for one retained high-quality frame. Their 19
material textures are content-addressed and uploaded only once. The uihost key
map works throughout.
Headless scripting:
`--click x,y` presses that window pixel mid-run, `--tap circle@30` holds a
button for six ticks, `--hold circle` holds it for the whole run. The guest
ticks at a fixed 60 Hz; GPU frames render only when something changed
(watch the `pocket-widget: … frames rendered` line on exit). `--max-fps 30`
is available when a lower active-power ceiling matters more than 60 Hz camera
motion.

## note-widget — a markdown sticky on your desk

The first *flat* pocket-widget runtime: no scene at all — the borderless,
resizable, always-on-top window IS a live `ui` surface, rendered at Retina
density (density-2 pak + `render_words_scaled`) and demand-driven like every
widget. The guest is `apps/note` (markdown view/edit, popup menu); the host
forwards the real keyboard/mouse/wheel/resize over the spec svc channel and
synthesizes CIRCLE for clicks, so the framework's hover-focus + onPress
pipeline does all dispatch.

```sh
bun tools/build.ts note-main --density=2   # from the repo root
cd pocket3d
cargo run -p note-widget
cargo run -p note-widget -- --file ~/notes/todo.md --width 380 --height 520
```

Click the text to edit (Esc/DONE to finish), drag the header to move, drag
the dotted corner or any edge to resize (relayout is live), scroll to
scroll; the ••• menu has theme/reset/close, edits autosave to `--file`
(default `~/.pocket-note.md`), ⌘Q quits. Headless scripting:
`--screenshot out.png --frames N`, `--click x,y@frame`, `--type text@frame`,
`--key Enter@frame`, `--scroll dy@frame`.

## The substrate, briefly

- **Rendering** — single forward pass per frame into any `TextureView`:
  world batches (albedo × lightmap × 2, alpha-test variant, gradient sky
  from sky-brush rays), then skinned/static models (dynamic-offset instance
  + joint-palette buffers), additive sprites/beams, a depth-cleared
  viewmodel pass, and a bitmap-font debug HUD. A `Game::overlay` hook admits
  composite passes (this is where OpenStrike's JSX HUD draws). sRGB-correct,
  CPU mipgen, anisotropic filtering.
- **BSP as data** — `pocket3d-bsp` parses v30 lumps + WAD3 into plain
  structs: batched geometry with a packed lightmap atlas, entities as
  key/value maps, and the original clipnode hulls. Everything is converted
  to Y-up at parse time (the transform is a proper rotation, so plane
  equations and texture projections survive unchanged).
- **Collision** — a faithful port of the recursive clipnode trace
  (`SV_RecursiveHullCheck`), then a GoldSrc-flavored controller on top:
  friction/accelerate, air control with the 30 u/s cap, 4-plane slide
  moves, 18-unit stair stepping, gravity 800. The map's own collision data
  does the work — no mesh colliders, no physics engine.
- **Animation** — glTF clips sampled onto a node hierarchy, joint palettes
  skinned on the GPU. Multi-skin characters concatenate into one palette;
  skinned bounds are measured in rest pose, so cm-scale or Z-up rigs
  (Mixamo exports) size correctly. Assets load from `.glb` or are built
  procedurally.
- **Determinism** — fixed-step simulation, an explicit xorshift RNG, and
  injectable input make headless runs reproducible.

## Extension points

- New world format → produce a `WorldSource` (+ implement `TraceWorld`).
- New game → implement the `Game` trait; compose a `Scene`; mount surfaces
  with `pocket-mod` (see docs/RUNTIMES.md for the discipline).
- **Systemic simulation stays renderer-independent.** Use `pocket3d-world`
  for deterministic bodies, attachments, structural damage, and reactive
  materials, then translate its state into a `Scene` inside the game adapter.
- More passes (decals, particles-with-physics, shadow maps) slot into
  `Renderer::render` alongside the existing ones, or hang off
  `Game::overlay`.

## Non-goals for v0.1 (a.k.a. the roadmap)

PVS culling, audio, crouch/ladders/water movement, GoldSrc MDL models,
Source BSP, and networking are all explicitly out of scope for this first
cut. The point was to prove the pipeline end to end: **BSP in, playable
round loop out** — which OpenStrike does, in its own repo, through the mod
runtime.
