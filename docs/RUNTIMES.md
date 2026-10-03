# The PocketJS runtime family — an extension architecture

*How PocketJS grows from "a JSX UI engine for the PSP" into a family of small,
specialized engines that are all freely programmable from JavaScript — without
becoming a general-purpose engine.*

This document is normative for every PocketJS runtime: the existing
2D UI runtime (`engine/core/` + PSP/wasm/wgpu hosts), the 3D substrate (`engine/pocket3d/`),
and every game runtime built on them (the first one is
[OpenStrike](https://github.com/pocket-nexus/open-strike)).

## 1. The thesis

Roblox demonstrated that the most valuable property of a game platform is not
engine breadth — it is that **the unit of creation is a script, not an engine
build**. Creators act on a curated world-vocabulary (the DataModel) from a
safe, embedded language, and never touch the native layer.

Roblox pays for this with one universal DataModel: every experience, whatever
its genre, inherits the same giant ontology, and the engine must be
everything to everyone. That is exactly the "Unreal-shaped" cost PocketJS
refuses.

The PocketJS bet is the dual of Roblox's:

> **Don't share a world-ontology. Share the *grammar* for defining
> world-ontologies.**

Each domain gets its own deliberately small engine — a *specialized runtime* —
that declares its own closed vocabulary: the nouns and verbs of that domain
and nothing else. A 2D UI runtime speaks nodes, styles, layout, focus. An FPS
runtime speaks rounds, weapons, hits, bots. A future puzzle or rhythm runtime
would speak boards or beats. What the platform standardizes is not the
vocabulary but the **mechanism** by which any such vocabulary is:

1. implemented natively, once, for performance (Rust),
2. exposed to JavaScript wholesale, for freedom (QuickJS),
3. composed with other vocabularies in one program.

Under this architecture the difference between an "app" and a "game" — or
between a "game" and a "mod" — is not architectural. All of them are the same
kind of artifact: **guest programs customizing native cores through declared
vocabularies**. That is the sense in which the App/Game boundary dissolves.

## 2. The ontology

A **runtime** is a triple:

```
Runtime = ⟨ Cores, Surfaces, Guest ⟩
```

### Core (Rust) — where state and time live

A core is a native simulation that owns its domain state and its clock:
`pocketjs-core` owns the retained UI tree, taffy layout, animation tracks and
the DrawList; an FPS core owns the map, player physics, ballistics, bot
navigation and the 3D scene. Cores are the only place where per-entity,
per-frame work happens. Cores never call into the guest.

Cores may share native substrate — `pocket3d` (wgpu device, render passes,
BSP collision, skeletal animation) is substrate, not a runtime: it has no
guest-facing vocabulary of its own. The 2D UI core renders through the same
substrate on desktop (`pocket-ui-wgpu`), which is what puts 2D and 3D on one
foundation.

### Surface — the declared vocabulary

A surface is the *entire* boundary between a core and the guest, pinned as
data in a spec (the `contracts/spec/spec.ts` pattern):

- **ops** — guest → core intent: commands and queries, synchronous, numeric
  codes, append-only. (`ui.createNode`, `ui.setStyle`, … / `strike.setPhase`,
  `strike.configureWeapon`, …)
- **events** — core → guest facts, delivered in per-tick batches.
  (`hit`, `kill`, `roundEnded`, …)
- **assets** — the binary formats the surface consumes (style tables, font
  atlases, paks; maps, models).
- **frame contract** — when the guest runs relative to the core's clock.

A surface is mounted into the guest as one named namespace (`globalThis.ui`,
`globalThis.strike`). Specs are single-source-of-truth TypeScript data,
code-generated into Rust, with a drift guard that byte-compares the generated
file in CI (`tests/contract.ts`). A surface is versioned by append: codes are
never renumbered, never reused.

**Capability = surface.** A guest can affect exactly what its mounted
surfaces express — nothing else. There is no ambient filesystem, network, or
process access. Sandboxing is not a bolted-on policy; it falls out of the
ontology. This is what makes third-party mods a tractable idea.

### Guest (QuickJS) — where products live

The guest is one QuickJS realm evaluating one bundled program. Apps, games,
and mods are indistinguishable in kind here; they differ only in which
surfaces they were given. QuickJS because it is embeddable everywhere Pocket
targets (it already runs on a 333 MHz PSP), deterministic, small, and fast
enough when the boundary is designed correctly (see the laws below).

### SDK — the idiomatic algebra per domain

Raw surfaces are wire protocols. Each surface ships an SDK that expresses it
in the *algebra natural to its domain*:

- The `ui` surface's natural algebra is a reactive tree → its SDK is **JSX**
  (Solid, Vue Vapor or Octane through the universal renderer, Tailwind
  classes, `animate()`).
- An FPS's natural algebra is rules and policies over events → its SDK is a
  **mod API**: `strike.on("kill", …)`, `strike.rules.roundTime = 90`,
  weapon/bot config tables.
- Other genres choose their own: data tables, state machines, timelines.

Choosing the SDK shape per domain — instead of forcing one paradigm — is the
"many small engines" philosophy applied to the API layer.

## 3. The three laws

Every runtime obeys these; they are what keeps "freely scriptable" compatible
with "high performance". All three are generalizations of mechanisms the PSP
UI runtime already proved on 333 MHz hardware.

**Law 1 — State lives in cores; guests hold mirrors.**
Guest-side reads never cross the boundary in hot paths. The Solid renderer
keeps a JS mirror tree so the reconciler reads JS objects, not FFI; a game
SDK keeps mirrored snapshots updated from event batches. Ops are one-way
writes; queries exist but are for cold paths.

**Law 2 — Intent crosses as ops, facts cross as events, both spec-pinned.**
No shared memory, no callbacks-from-native mid-tick, no stringly-typed side
channels. Everything that crosses is enumerable, versioned, and cheap to
marshal (numbers, strings, buffers). This is what makes surfaces composable
and mods auditable.

**Law 3 — One guest turn per host tick.**
The host calls the guest exactly once per fixed-step tick
(`frame(buttons)` for UI runtimes; game runtimes add their event pump in the
same turn). The guest never owns a timer or a thread. Frame content is a pure
function of tick index + inputs, which is what makes byte-exact goldens,
headless acceptance scripts, and deterministic replays possible — the whole
Pocket verification story rests on this law.

## 4. The mechanism crates

The grammar is implemented once, as infrastructure every runtime reuses:

| Crate | Role |
| --- | --- |
| `pocket-mod` | Guest hosting: QuickJS realm lifecycle, surface mounting (`mount("ui", ops)`), per-tick pump (frame call + job drain + timers), console, hot reload. The "mod runtime" capability, as a library. |
| `pocket-net` | Transport-neutral NET core and `globalThis.net` surface: validates bounded HTTP requests, owns handles/bodies and tick event batches, and accepts a host-owned `HttpTransport` adapter. See [NET.md](./NET.md). |
| `pocket-ui-wgpu` | The `ui` surface, desktop edition: feeds paks to `pocketjs-core`, exposes the 17 `HostOps` ops to the guest, renders the DrawList through wgpu into any render target — a window (standalone app host) or an overlay pass over a 3D scene (game HUD). |
| `pocket-widget` | The desktop-widget capability (WIDGET.md): a widget window shell whose guest ticks at a fixed rate while GPU frames render on demand, embedded `ui` surfaces bound onto meshes, and cursor-ray part picking mapped to declared inputs. `pocket-stage` is the first runtime on it; its bundled PSP stage runs admitted fixed-viewport apps unmodified. |
| `pocketjs-core` | The 2D UI core (unchanged; now viewport-parameterized). |
| `pocket3d` | Native substrate, desktop edition: wgpu bootstrap, forward renderer, glTF models, headless capture. |
| OpenStrike `domain/crates/pocket3d-bsp` | GoldSrc maps, hull collision, character controller, PVS visibility and the `.p3d` format. Owned by OpenStrike; shared between its targets. |
| OpenStrike `domain/crates/pocket3d-gu` | BSP world and mesh rendering through GE, with PVS culling and CLUT8 textures. Uses the PocketJS GE allocation and texture-layout mechanisms. |
| `pocketjs-psp` (lib) | Guest hosting + `ui` surface, PSP edition: the arena allocator, the QuickJS embedding, the DrawList GE backend (with an overlay mode for 3D compositing), pak feeding, and the DevTools mailbox — everything the 2D EBOOT proved, linkable by game EBOOTs. |
| OpenStrike `domain/crates/pocket3d-vita` | BSP rendering through GXM. Owns passes and materials; uses `devices/vita/pocket-vita-gxm` for mapped storage and program registration. |
| `pocketjs-vita` (lib) | Guest hosting + `ui` surface, Vita edition: QuickJS, density-2 pak/font resources, controller/dual-analog input, logical-coordinate front-panel contacts and a native-density 960x544 vita2d backend over the portable 480x272 logical layout. |

The BSP rows belong to [OpenStrike's domain workspace](https://github.com/pocket-nexus/open-strike/tree/main/domain).
PocketJS [device kernels](../devices/README.md) own GE frame storage/cache/layout,
PICA texture storage/publication, and GXM memory/program mechanisms. Atlas and
OpenStrike own their scene formats, compilers, renderers and quality decisions.

A specialized runtime composes these mechanisms. OpenStrike is:

```
openstrike (Rust bin)
  = FPS core (pocket3d substrate + game systems)
  + mounts `strike` surface  (its own spec: ops/events for rules, weapons, bots, rounds)
  + mounts `ui` surface      (pocket-ui-wgpu, composited as the HUD overlay pass)
  + pocket-mod guest         (one realm running the product bundle)

product bundle (JS, built by the PocketJS two-pass pipeline)
  = gameplay mod  (strike SDK: round rules, scoring, weapon/bot tuning, kill feed)
  + HUD app       (ui SDK: Solid JSX, Tailwind, animations)
```

The PSP UI runtime, in the same notation: a QuickJS guest + the `ui` surface
+ the sceGu backend. It was the first instance of the pattern all along; the
architecture names it and makes it repeatable.

[Pocket Voxel](https://github.com/pocket-nexus/pocket-voxel) inverts the
ownership split the other instances share: the GAME STATE lives in the
QuickJS guest (a TypeScript port of a Game Boy RPG engine) and the Rust core
owns only the retained diorama scene — cooked voxel chunks, billboards,
camera rungs, a GB UI tile layer — behind its own `voxel` surface, next to
the mounted `audio` module. It incubated in this repo and now lives in its
own repository, vendoring this engine the way OpenStrike does.

And the composition is now proven portable: **OpenStrike runs on a real PSP**
as `openstrike-core` (the same FPS simulation) + `pocket3d-gu` over a cooked
map + the `pocketjs-psp` host library + the same `strike` surface mounted
through the raw QuickJS API — executing the identical product bundle (rules
mod + JSX HUD) that the desktop runs, at 60 fps on the handheld.

Note what composition buys: the HUD is not "game UI code" — it is a full
PocketJS app, running unmodified on the same framework that drives PSP
hardware, mounted *inside* a game runtime. Any future runtime gets a
production UI layer for free by mounting `ui`.

## 5. Discipline for new runtimes

To add a runtime for a new domain:

1. **Write the vocabulary first.** A `spec.ts` for your surface: ops, events,
   asset formats, enums. Keep it closed and small — if the list of nouns
   doesn't fit in a page, the domain is cut too wide. Codegen the Rust side;
   add the drift guard.
2. **Build the core against the spec**, on whatever substrate fits
   (`pocket3d`, `pocketjs-core`, neither).
3. **Mount surfaces with `pocket-mod`**, obeying the three laws.
4. **Ship the SDK** in the domain's natural algebra, plus a headless
   verification harness (scripted input, deterministic RNG, screenshot/state
   assertions) — a runtime without a headless story is not done.
5. **Let the base game be the first mod.** If the built-in behavior can't be
   expressed through the surface, the surface is too weak — fix the surface,
   not the game. (OpenStrike's round rules, scoring and weapon tables are JS
   for exactly this reason.)

What stays out of scope, permanently: a universal scene graph, a universal
editor, cross-runtime portability of *game* code. Vocabularies are allowed —
encouraged — to be incompatible. The grammar is the platform.
