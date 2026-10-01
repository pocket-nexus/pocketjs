# Pocket Widget — desktop widgets as a runtime-family capability

*How the Pocket runtime family puts small, always-on, guest-programmable
presences on the desktop — and the first runtime built on it: Pocket Stage,
which mounts real Pocket apps into authored 3D devices and rooms.*

This document names and generalizes what
[pocket-character](https://github.com/pocket-nexus/pocket-character) proved,
and specifies the next runtime that needs the generalization. It follows the
[RUNTIMES.md](RUNTIMES.md) ontology: a widget runtime is still
⟨Cores, Surfaces, Guest⟩; **pocket-widget** is the mechanism layer that makes
the desktop-widget *form factor* a reusable capability instead of a per-app
reinvention.

## 1. The capability

A desktop widget is the smallest unit of ambient software: one always-on-top,
transparent, undecorated window that lives on the desktop for hours. The form
factor puts two hard constraints on the architecture:

1. **Idle must cost almost nothing.** A widget is judged by what it burns at
   rest, not at peak. pocket-character measured the gap: the same character
   stage costs 8 processes / 2184 MB / 44% CPU on Electron and
   1 process / 118 MB / 3.9% CPU on PocketJS — *while rendering 60
   fps of skinned, spring-boned 3D continuously*. A widget whose content is
   mostly static should land far below even that.
2. **Behavior must be a bundle, not a build.** Which app the widget hosts,
   how it reacts, what its personality is — guest program, hot-swappable,
   sandboxed by construction (capability = surface).

pocket-character satisfied both, but its host is product-specific code. The
generic halves it left upstream (`AppConfig` widget-window mode, transparent
clear, `max_fps` pacing, morph/pose machinery — pocketjs #125) are window
plumbing, not the full capability. **pocket-widget** is the missing middle: a
`pocket3d`-workspace mechanism crate, sitting beside `pocket-mod` and
`pocket-ui-wgpu` in the RUNTIMES.md table:

| Piece | Role |
| --- | --- |
| `shell` | The window contract and its event loop: transparent / undecorated / always-on-top (from #125) plus occlusion suspend, per-press drag-to-move / resize-grip policy hooks, optional live resizing, and the governor of §4 — fixed-rate guest ticks, demand-driven GPU frames, with a frames-vs-ticks receipt logged on exit. One governor, two widget shapes: `WidgetGame` (3D — scene, camera, embedded screens) and `FlatWidget` (2D — the window IS the `ui` surface, one `render_words_scaled` pass, no scene). |
| `embed` | A full PocketJS `ui` surface rendered off-window: `pocket-ui-wgpu` draws the core's DrawList into a persistent `OffscreenTarget`. A semantic glTF material override binds that texture view directly to the authored screen primitive. A screen inside a widget is a *real app*, not a video or a second overlay window. The per-tick DrawList content hash is the dirty signal. |
| `parts` + `pick` | The interaction vocabulary: named part shapes (`btn_cross`, `dpad_up`, `nub`, `screen`) → spec BTN bits, analog packing (raw extremes 255/1, never 0), the shared uihost keyboard map, and cursor-ray picking against oriented part bounds (event-driven, CPU, cold path). Procedural shells can register parts directly; authored shells declare cheap proxies in package data, so visual topology never enters the picking hot path. |

What stays out of pocket-widget: any specific model, part map, or behavior —
those are the product. (pocket-character retrofits onto `shell` naturally;
that refactor is desirable but not a blocker.)

## 2. The first runtime: pocket-stage

**Pocket Stage** is the model-neutral process contract that combines an
authored 3D asset, camera policy, interactions, and one or more live Pocket app
surfaces inside a low-power widget window. The checked-in PSP and iPod nano
packages prove that `EmbeddedUi` + `PartMap` carry real weight:

- Borderless, transparent, always-on-top window framing a 3D PSP.
- The PSP's screen is a live 480×272 PocketJS `ui` surface — the same
  DrawList renderer that drives PSP hardware, **not** an emulator. PPSSPP
  renders a machine; we render the *app*, because the app was never
  PSP-binary-shaped to begin with.
- The PSP's buttons are pickable meshes. Click CROSS and the guest's next
  `frame(buttons, analog)` carries `BTN_CROSS` — the identical bit the real
  hardware's pad register produces. Drag the analog nub and the guest sees
  the same packed axes a real nub produces.
- Therefore: **any PocketJS app whose fixed viewport variant passes the
  Stage surface admission boots unmodified.** The outer macOS window has
  `form: "widget"`, but the guest is mounted on a screen mesh and therefore
  resolves against `form: "embedded"`. A fixed 480×272 PSP/Vita app fits;
  a dynamic-only desktop app such as Pocket Note is correctly rejected until
  it declares a compatible fixed variant.
- The iPod package selects a different 176×132 surface and tall camera/window
  framing through the same profile loader. Its click wheel is the first
  `rotary-wheel@1` adapter: circular drag or trackpad scroll over the ring is
  quantized to ordinary UP/DOWN BTN edges, while tap sectors deliver MENU,
  previous, next, and play/pause. No iPod-only guest ABI or native process
  exists.
- Its music demo uses the existing svc queue as a companion boundary. The
  guest owns navigation and displays metadata; the macOS host owns local WAV
  paths and playback. Paused audio and a settled DrawList produce no periodic
  GPU work. Launch the complete package with `bun run widget:ipod`.

The source remains in the historical `engine/pocket3d/examples/handheld` directory
but the Cargo package, binary, process, and window title are `pocket-stage`.
Asset type is data, not a process fork:
an iPod, phone, laptop, TV, or room-with-monitor should change the package and
typed manifest extension, not introduce another native runtime.
The checked-in host is still transitional: these consumed fields still live in
`profile.json` until the strict package manifest migration in §6.1 lands.

In RUNTIMES.md notation:

```
pocket-stage (Rust bin, macOS)
  = widget shell        (pocket-widget: window, picking, part input, power)
  + stage package       (glTF LODs, views, interactions, provenance)
  + mounts `ui` slots   (pocket-ui-wgpu → OffscreenTarget → display material)
  + mounts `widget`     (optional, §7: hover/led/framing facts and intents)
  + pocket-mod guest    (one unmodified PocketJS app bundle + pak)
```

There is no new domain vocabulary to invent for v1: the guest-facing surface
is the existing `ui` surface, byte-for-byte. The runtime's novelty is
entirely host-side composition.

## 2b. The second runtime: pocket-note (the flat form)

The other half of the capability, proven by `examples/note-widget` +
`apps/note`: a **markdown sticky note** whose borderless, resizable,
always-on-top window is nothing but a `ui` surface — no scene, no camera,
one `render_words_scaled` pass on dirty frames. It exercises everything the
3D form doesn't:

- **The window is the app.** `FlatWidget` + `run_flat` share the governor;
  a settled note renders zero GPU frames (measured: 481 ticks, 2 frames,
  ~0.7% CPU / 86 MB RSS idle over a windowed run — one process, debug
  build).
- **Live resize is a relayout, not a reboot.** The host tracks the window,
  calls `Ui::set_viewport` (runtime-legal since #125's plumbing; clamped to
  the DrawList i16 range) and tells the app, which re-wraps text against
  the new width via the framework's new `resizeViewport()`. Borderless
  windows keep macOS edge-resize; the shell also tracks an explicit
  grip-corner drag (`resize_at`, `WidgetConfig::resizable`/`min_size`).
- **The svc channel is the desktop companion contract.** The spec mailbox
  (ops 30..32) needs no new ops for a host that lives in-process: real
  keyboard/mouse/wheel/resize go to the guest as JSON lines
  (`{t:"ch"|"key"|"mouse"|"scroll"|"resize"|"load"}`), save/quit intents
  come back (`{t:"save"|"quit"}`). The app source retains a svc-less
  read-only fallback, but the current Note manifest is dynamic-only; it must
  add a fixed viewport variant before a PSP or embedded host can admit that
  fallback. The §7 `widget` surface stays unbuilt.
- **The desktop surface is first-class in the platform contracts.** Six
  registered capability ids name it (`input.text`, `input.pointer`,
  `input.ime`, `host.clipboard`, `display.viewport.live`,
  `text.glyphs.runtime` — each a distinct observable guarantee; a real
  pointer is NOT `input.cursor`), and a `macos-widget` target
  profile (hostAbi 3, density 2, `dynamicViewport` range) provides them.
  Target semantics live in queryable profile FIELDS (`platform`,
  `form` — takeover/window/widget/kiosk/embedded); ids are labels
  (convention `<platform>-<form>`, future: `macos-app`, `linux-kiosk`),
  and apps declare viewport intent per policy (`fixed`/`dynamic`
  variants), not per target. Pocket Note currently declares only a dynamic
  variant and is therefore intentionally admitted by `macos-widget`, not by
  PSP/Vita or an embedded Stage screen. Its desktop-only APIs sit in
  `enhances`; if the app later adds a fixed variant, the same source can
  degrade to a read-only note on hosts without those features. Native hosts
  assert identity (`__host`/`__hostAbi` vs the plan's target), and
  `bun run note` builds through the manifest — density and features come from
  the profile, not flags.
- **Clicks are CIRCLE.** The host synthesizes the spec press button while
  the mouse is down; the app resolves hover → focus (`hitFocusable` +
  `focusNode`) from svc mouse moves, and the framework's stock onPress
  pipeline dispatches — including into Portal overlays (the hit-test root
  now spans the overlay layer, fixing menus for every cursor-mode app).
- **Text editing without an OSK.** The `pocket3d` `Input` grew a per-frame
  edit-keystroke stream (chars with layout applied, named keys, repeats)
  and a wheel accumulator; the guest's editor (measured soft wrap, caret
  math, click-to-caret, drag selection, a coalescing undo/redo stack
  driven by ⌘Z/⇧⌘Z) is pure JS over `measureText`, unit-tested in bun.
  Preview mode gets browser-style drag selection over the rendered rows
  (select.ts — (row, char) space, boundary rows clipped, code blocks
  atomic) and clicks are inert, exactly like a real markdown preview —
  edit mode is entered through the eye/pencil toggle. ⌘C/⌘X/⌘V complete
  the clipboard both ways (the host pipes copy intents to the system
  clipboard and reads it back for paste).
- **IME input without a charset.** The shell enables OS composition
  (`WidgetConfig::ime`); preedit/commit ride the Input's `ime_events`
  stream into svc lines, the guest splices the preedit at the caret with
  an underline, and reports its caret rect back so candidate windows dock
  next to the text. Coverage is solved at RUNTIME: the host rasterizes
  unseen codepoints from a system CJK font (mmapped), appends them to the
  pak's FONT ATLAS v3 blobs (cmap stays sorted, coverage is gid-linear —
  appending is cheap) and reloads the slot through the spec
  `loadFontAtlas` op; the wgpu renderer re-uploads any slot whose glyph
  count moved. No charset guessing, no megabyte paks — a note types 你好
  and two glyphs are baked on the spot.
  Mouse lines carry the primary-button state so the guest sees press/
  drag/release, and the guest tells the host while its menu is up so
  header clicks reach the menu backdrop instead of starting a window
  drag.

## 3. Input: from meshes to BTN bits

The bridge is deliberately dumb — a static table, no gameplay logic:

- **Buttons.** `btn_cross/circle/square/triangle`, `dpad_up/down/left/right`,
  `btn_start/select`, `trig_l/r` map 1:1 to the spec BTN bits. Mouse-down on
  a profile proxy sets the bit until mouse-up; keyboard chords compose into
  the same word (the OSK needs them). The visual model stays a single scene
  instance; input does not traverse or mutate its 80k–132k triangles.
- **Analog nub.** Drag within the nub's radius maps to the packed axes
  (`(x << 8) | y`, 0–255, 128 center); release springs back to center.
  Extremes are raw 255/1 — never 0 — matching the input-tape convention.
- **Rotary wheel.** A package-declared canonical XY annulus uses ray/plane
  intersection plus `atan2`, unwraps the ±π seam, accumulates 12° detents,
  and inserts a neutral guest tick between UP/DOWN pulses. A tap that never
  crosses a detent resolves to the nearest named angular sector. Trackpad
  scroll is consumed by the wheel only while the pointer is over the ring;
  elsewhere the same gesture continues to orbit the stage.
- **Keyboard, always.** The uihost key map (arrows, Z/Enter = CROSS, …) is
  mounted unconditionally. Mouse-on-model is the magic; keys are the daily
  driver. Both funnel into one `buttons` word per tick — Law 3 is untouched.
- **Picking is event-shaped.** A cursor ray against profile-authored oriented
  boxes runs only on mouse events, never per frame. Mesh triangle count is
  therefore irrelevant to picking cost. Profiles can be generated or hand
  tuned once per shell without adding model-specific runtime code.
- **Click-through.** Clicks on fully transparent pixels should reach the
  desktop behind. v1 ships without it (the window hugs the model, so dead
  margin is small); the candidate mechanism — toggle the window's cursor
  hit-test off when the cursor leaves the model silhouette — hangs on the
  re-entry question in §9. Dragging anything inert moves the window (the
  shell's per-press `drag_at` policy).

## 4. Power: two rates, one clock

The determinism laws stay intact — and they are what make low power *cheap*
to implement:

- **The guest ticks at a fixed 60 Hz, always.** One guest turn per host tick
  (Law 3); tapes, goldens, and replays hold inside the widget. An idle
  QuickJS tick over a settled app is microseconds — the PSP does it at
  333 MHz.
- **GPU frames are demand-driven.** A frame renders only when something is
  dirty: the `ui` core produced a different DrawList (cheap content hash per
  tick — DrawLists are small), a pose/morph changed (button press), the
  camera or window moved, or hover state changed. No dirt → no render pass,
  no present; the compositor retains the last frame. A PSP showing a settled
  menu costs **zero GPU frames**.
- Native baked animations (the styles.bin timelines) run in the core, so
  "app is animating" is a core-side fact, not a guess.
- `max_fps` pacing (sleep, not spin) bounds the active case; macOS occlusion
  events suspend rendering entirely while ticks continue, so the app stays
  live behind other windows.
- The windowed shell explicitly requests wgpu's `LowPower` adapter. On Apple
  Silicon that remains Metal on the integrated Apple GPU; headless tooling and
  full-screen game hosts keep the existing `HighPerformance` default.
- **Measured receipt (M3 Max, 10 s, release build).** The static settings app
  ran 601 guest ticks but presented only 2 GPU frames (0.3%); the hero app,
  whose spinner keeps changing, presented 224 (37.3%). Total process CPU time
  was 0.21 s and 0.40 s respectively over about 10.2 s wall time, nowhere near
  one saturated core. A longer static run sampled at 0.7–1.0% CPU and about
  161 MB RSS after startup. `/usr/bin/time` peak RSS was 218–221 MB because it
  includes GLB decode/upload; this is not a direct GPU power measurement.
  These are local samples, not cross-machine guarantees; the exit receipt is
  the repeatable check.

## 5. Screen fidelity

A 480×272 texture sampled in perspective shimmers. Levers, in order:

- **Render the surface at density 2** (960×544) — the Vita host already
  proved the same logical layout renders at density 2 with density-2 paks;
  the widget can reuse that asset path. The handheld's v1 renders density 1
  (480×272, the byte-exact golden flavor) and leans on the framing instead.
  The flat form (§2b) ships the lever: `UiRenderer::render_words_scaled`
  multiplies DrawList coordinates into the physical target while density-2
  atlases land 1:1 — the Vita presentation model on wgpu, built with
  `bun tools/build.ts <app> --density=2`.
- Mipmaps + anisotropic filtering on the screen material; default framing
  keeps the screen near-parallel to the view.
- **Two framings**: "desk" (whole device, ambient) and "focus" (screen fills
  the window, near-flat — effectively uihost with a bezel). Double-click the
  screen to toggle; framing and orbit animate to exact front together. The
  second double-click restores the exact pre-focus desk orbit, including across
  repeated or mid-animation reversals. Focus mode is how you actually *use* the
  app for minutes at a time. Two-finger trackpad scrolling is reserved for
  orbiting the model and pauses during focus transitions, so framing and
  rotation cannot conflict.

## 6. The stage package convention

The model is data. The current PSP `profile.json` is the working schema-1
prototype; the cross-device contract graduates it to a package entry named
`pocket-stage.json` plus one or more semantic display materials:

- The bundled PSP shell is Dibad's CC BY 4.0 community model, cooked into a
  131,680-triangle settled LOD and an 80,879-triangle orbit LOD. Attribution
  and trademark caveats ship beside both GLBs. Runtime loading downsizes any
  overlarge embedded texture to 1024 px.
- The screen material exports `extras.pocket3d_role = "dynamic_screen"` (a
  `P3D_dynamic_screen__` name prefix is the compatibility fallback) and valid
  normalized `TEXCOORD_0` UVs. The loader requires exactly the primitive count
  declared by the profile, replaces its base-color view with the persistent
  480×272 `EmbeddedUi` target, and forces that material white, unlit, and
  opaque. Nothing deletes or edits mesh geometry at runtime.
- The transitional `profile.json` declares the two relative LOD paths,
  attribution file, model width and orientation, screen semantic, and named
  CPU pick boxes. LOD bounds
  must agree after canonical scaling. Two-axis `MouseWheel` input is the
  primary orbit control (precise macOS pixel deltas make this a natural
  two-finger gesture); right-drag remains the ordinary-mouse fallback. Either
  path swaps only the model asset, then restores the quality LOD after the
  gesture settles, renders once, and lets the compositor retain that
  framebuffer. A small exact-front magnetic dead zone plus a wider release
  threshold makes `(0, 0)` easy to land on without jitter; raw gesture input
  keeps accumulating inside the dead zone so a deliberate movement can always
  pull the camera away. An optional `suppressed_materials` list binds a
  transparent 1×1 texture to cosmetic layers such as an overly dark LCD glass
  sheet; geometry remains untouched and the policy stays model data.
- Independently cooked LODs share a content-addressed `ModelTextureCache`.
  This PSP uploads 19 unique material textures and records 19 reuse hits for
  LOD3, instead of retaining duplicate GPU texture sets; only the two geometry
  buffers remain separate.
- A future PSP, iPod, phone, laptop, TV, or room uses the same binary and
  render mechanism: cook one or more GLBs, tag every live display material,
  and provide a stage manifest. Different geometry, material count, triangle
  count, screen count, camera layout, and controls do not require a new
  runtime. A single visual artifact can serve every LOD role when
  simplification is unnecessary.

### 6.1 Naming and manifest v1 direction

Terms are deliberately separate:

| Term | Meaning |
| --- | --- |
| `pocket-widget` | Reusable OS-window, fixed-tick, dirty-frame, and embedding capability. |
| `pocket-stage` | The model-neutral runtime/binary/process that loads one stage package. |
| stage package | Versioned distributable directory rooted at `pocket-stage.json`. |
| artifact | One immutable package file: a GLB LOD, interaction sidecar, IBL, or notice. |
| surface slot | Stable injection point such as `display.main`; never a material index. |
| instance | Runtime state such as current LOD, orbit, focus, and app bindings. |
| scene | Internal `pocket3d::scene::Scene`; not a second product or process name. |

The stage manifest follows `pocket.json` conventions: JSON Schema 2020-12, a
`$schema` URI, one integer major discriminator (`pocketStage`), reverse-DNS
IDs, SemVer, `additionalProperties: false`, and package-relative paths that
cannot escape the package root. It does **not** replace the app manifest. The
authority boundary introduced by the platform contracts remains intact:

| Input | Owns |
| --- | --- |
| app `pocket.json` | App intent: entry, framework, capabilities, fixed/dynamic viewport variants. |
| `pocket-stage.json` | Package facts: visual artifacts, semantic screen slots, display facts, views, interaction adapters, notices. |
| Stage host profile | Runtime facts: actual platform, `form: "embedded"`, host ABI, implemented capabilities. |
| `ResolvedBuildPlan` | The one admitted app variant and its resolved viewport/features. |
| `ResolvedStageLaunchPlan` | The verified app plan + package digest + chosen LOD/surface binding used by the binary. |

The outer desktop process still uses the `pocket-widget` window mechanism;
that does not make the guest a `macos-widget` target. A guest drawn into a
screen mesh resolves against an `embedded` profile derived from the selected
surface. Target ids are labels and must never be parsed to recover these
facts.

The current PSP package would describe its fixed display like this. Density 2
later changes `physicalViewport` to `[960, 544]` and `rasterDensity` to `2`
without changing the app's logical coordinates:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-stage-1.json",
  "pocketStage": 1,
  "id": "dev.pocket-nexus.stage.psp-eg02",
  "name": "psp-eg02",
  "title": "PSP EG02",
  "version": "1.0.0",
  "artifacts": {
    "visual.settled": {
      "path": "models/settled.glb",
      "mediaType": "model/gltf-binary"
    },
    "notice.attribution": {
      "path": "ATTRIBUTION.md",
      "mediaType": "text/markdown"
    }
  },
  "visual": {
    "canonical": { "units": "meters", "up": "+Y", "front": "+Z" },
    "lods": [{ "id": "settled", "artifact": "visual.settled" }]
  },
  "surfaces": [{
    "id": "display.main",
    "required": true,
    "binding": {
      "materialRole": "dynamic_screen",
      "texcoord": 0,
      "expectedPrimitives": 1
    },
    "display": {
      "physicalViewport": [480, 272],
      "logicalViewports": [[480, 272]],
      "presentations": ["native", "integer-fit"],
      "rasterDensity": 1
    },
    "uvContract": "normalized-full-span"
  }],
  "views": {
    "default": "desk",
    "focus": { "surface": "display.main", "restoreOrbit": true },
    "orbit": { "snapEnterDegrees": 2, "snapExitDegrees": 4 }
  },
  "provenance": {
    "noticeArtifact": "notice.attribution"
  }
}
```

The mounted app separately declares its policy, for example:

```json
"viewport": {
  "fixed": { "logical": [480, 272], "presentation": "integer-fit" }
}
```

An app intended for both a resizable flat widget and an embedded screen may
declare both `fixed` and `dynamic` variants. Resolution selects exactly one;
the stage package never copies or overrides app intent.

Core v1 should accept only fields with a real consumer. Identity, canonical
coordinates, visual artifacts/LOD roles, one verified surface slot, display
facts, view presets, material exclusions, and an attribution notice already
map to the transitional loader. Content hashes, byte counts, multiple live
surfaces, generic `kind`, and typed device/room extensions land only together
with their verifier or adapter; until then they remain draft rather than
silently accepted metadata. Device controls (buttons, nub, rotary wheel) and
room controls (cameras, lighting, entities) belong behind named, versioned
adapters—not branches in the render governor.

The schema itself should have one TypeScript source
(`contracts/spec/pocket-stage.ts`), a generated byte-exact
`contracts/schema/pocket-stage-1.json`, JSON-Pointer diagnostics, strict unknown-field
rejection, and contract fixtures. Unsupported adapters, missing or multiply
matched surfaces, invalid full-span UVs, cross-LOD bound drift, package path
escape, and every declared-but-unconsumed field fail before GPU startup.

The bundled PSP launcher is now manifest-first on the **app** side: it resolves
the selected demo's `pocket.json` against a transitional
`macos-embedded` profile, writes a `ResolvedBuildPlan`, compiles from that
plan, and publishes the same target id/ABI through `UiSurface`. Full package
launch should extend that path rather than add a second resolver:

```text
pocket.json + pocket-stage.json + actual Stage host facts
                    │ resolve once
                    ▼
       ResolvedBuildPlan + ResolvedStageLaunchPlan
                    │
                    ▼
          compiler + one pocket-stage binary
```

The generalized launcher should accept `--manifest`, `--stage`, `--surface`,
`--project-root`, and `--outdir`; runtime-only flags follow `--`. The binary
then receives the two verified plans instead of guessing
`dist/<app>-main.{js,pak}` from `--app`. The scheduler (`tick_hz`, dirty-frame
latch, fps cap, occlusion policy) stays a `pocket-widget` invariant and is not
author-controlled stage metadata.

## 7. The `widget` surface (v2, optional)

v1 mounts only `ui` — an unmodified app must be the base case (RUNTIMES.md
rule 5). For bundles that *want* to know they're in a widget, a tiny
string-keyed surface in the `character`/`strike` style:

- **events**: `hover(part|null)`, `pressed(parts)`, `framing(desk|focus)`,
  `occluded(bool)`.
- **ops**: `widget.led(rgb)` (notifications on the power LED),
  `widget.focus(bool)`, `widget.quit()`.

Kept to one page of spec, append-only, or it doesn't ship.

## 8. Verification

- **Screen path is byte-exact.** Same core, same DrawList renderer, same
  paks as every other `ui` host; wiring the shared golden-specs suite
  against the widget's offscreen surface at density 1 is the standing next
  step. If a golden drifts here, the bug is real.
- **Picking is unit-tested**: ray/OBB slab tests incl. rotation, ties, and
  behind-origin cases; nearest-hit part resolution; the analog packing's
  255/1-never-0 extremes.
- **End-to-end is a script, today**: `--click x,y` presses a window pixel
  through pick → part → BTN → guest; `--tap circle@30` sequences abstract
  buttons. The proof run drives the unmodified hero demo — a D-pad tap focuses
  it, then a cursor ray hits the bundled model's CIRCLE proxy — and the screen
  reads `Count: 1`. The binary fails unless both that named hit and the final
  deterministic DrawList hash match. Captures are composite PNGs whose alpha
  is the real window transparency.
- **Power is a receipt, then a gate**: the shell logs ticks vs. frames
  rendered on every exit, now with arm sources (dirt / resize / occlusion /
  scale) so a hot widget explains itself — in steady state the only healthy
  source is dirt, and an idle app has none. OS-initiated redraws with
  nothing pending are skipped and counted; the product repo's measurement
  harness turns the thresholds into a failing check.

## 9. Delivery plan and open questions

Landed in this repo:

1. `pocket3d`: semantic `load_glb*_with_overrides` APIs for external texture
   views; glTF base-color factors, alpha modes, and double-sided materials;
   plus public `Camera::screen_ray`, `Input::inject_cursor`, and
   `pick_alpha_mode` for alternative shells.
2. `pocket-ui-wgpu`: `UiRenderer::render_words` — render a DrawList the
   host already built, so the per-tick dirty hash costs one tree walk, not
   two.
3. `pocket-widget`: the crate — `shell` (demand-render loop), `embed`,
   `parts`, `pick` — with the RUNTIMES.md table row.
4. `examples/handheld`: the first `pocket-stage` package and transitional
   host — profile-driven authored glTF shells for PSP and iPod nano, semantic
   live screens, quality/orbit LOD switching, mouse/keyboard input, desk/focus/orbit
   framings, per-package viewport/camera facts, click-wheel detents, optional
   host-side audio playlists, embedded-target app admission/build plans, and
   headless scripting (`--screenshot/--click/--drag/--tap/--hold/--focus/--orbit/--auto-quit`).
5. The flat form (§2b): `shell::run_flat` + `FlatWidget` + resizable
   windows; `UiRenderer::render_words_scaled` (density-N presentation);
   `UiSurface::new_with_density` + in-process svc queues; `Input` edit
   stream; `resizeViewport()` + overlay-aware hit testing framework-side;
   `--density=N` builds; and the second runtime — `examples/note-widget`
   over `apps/note` (markdown view/edit/menu, autosave, tested in
   `tests/note.test.ts`).

Still ahead: the golden-specs wiring (§8), density-2 screens for the 3D
form (§5 — the flat form ships them), the `widget` surface (§7),
click-through, per-camera sorting for shells with overlapping transparent
layers, bold-weight CJK fallback faces + line-start kinsoku for CJK wrap,
and extraction into `pocket-nexus/pocket-stage` / `pocket-nexus/pocket-note`
with the steady-state measurement harness and strict package schema in §6.1.
pocket-character retrofits onto pocket-widget when convenient.

Open questions:

- **Click-through re-entry**: with the window's hit-test off, mouse-move
  events stop; re-enabling needs either a low-rate (~10 Hz) cursor poll only
  while in pass-through, or raw device events if winit delivers them
  unfocused on macOS. Decide by experiment.
- **Manifest migration**: the checked-in PSP still loads transitional
  `profile.json`; migrate it mechanically to `pocket-stage.json`, then remove
  the legacy reader rather than maintaining two permanent contracts.

Resolved: dirty detection is an FNV-1a hash of the DrawList words — texture
generations ride along in the handles, so re-uploaded pixels change the
hash too.
