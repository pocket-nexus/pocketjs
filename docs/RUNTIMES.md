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

QuickJS frees most garbage by reference count. Its cycle collector
(`JS_RunGC`) runs when an **object allocation** finds `malloc_size` above
`malloc_gc_threshold`, so the pause lands inside whichever guest turn crosses
the threshold — and only an object allocation checks the threshold: one turn
can grow the heap past it with a single large backing-store allocation. A
realm created with `Guest::new_with_idle_gc` moves that collection to the
tick boundary: the host calls `Guest::idle_gc` after the turn and its job
drain, passing the time left before the next tick. The collector runs once
heap growth since the last collection exceeds **max(256 KiB, half the
surviving heap)** (the engine's own 1.5× rule) and waits up to **30
boundaries** for a tick with room for the last measured pause.

The policy writes two limits into QuickJS. The **GC threshold** is **2× the
surviving heap** (`malloc_gc_threshold`): a turn that allocates past it
through object allocations collects inside the turn, as an unmodified
QuickJS runtime would. The **memory limit** is **GC threshold + max(8 MiB,
the surviving heap)** (`JS_SetMemoryLimit`), armed by `Guest::arm_idle_gc`
after the product bundle is evaluated and before the first product frame:
a turn whose growth is one large backing store — which never checks the GC
threshold — fails the allocation with a JS out-of-memory exception instead
of growing the heap without bound. Bundle evaluation itself is unbounded,
like a plain QuickJS runtime; a host that never arms gets the cap at the
first `idle_gc` boundary, with its first frame unbounded. The heap size is
read from a counting allocator that mirrors the engine's `malloc_state`
(one header per block, `usable_size + MALLOC_OVERHEAD`), so the policy reads
it in constant time through the public allocator trait.

The desktop host uses this path for the top-level guest and for
`AppSupervisor` child realms: both call `arm_idle_gc` after the bundle is
evaluated, before the first frame, and the supervisor calls `idle_gc` after
each child turn, with no per-app deadline. The PSP host keeps its
arena-pressure collection after `drain_jobs` (`hosts/psp/src/main.rs`).

**Weak-reference timing.** QuickJS frees most garbage by reference count and
runs `JS_RunGC` only for cycles, so when a `WeakRef` clears depends on how
its target became unreachable:

- **Reference-counted release.** A target not in a cycle is freed the moment
  its last strong reference drops, inside the turn: `deref()` returns
  `undefined` at once, and the `FinalizationRegistry` cleanup callback is
  queued as a job then, running at that turn's job drain (before `frame`
  returns).
- **Hard-threshold collection.** A turn that allocates past the GC threshold
  through object allocations runs `JS_RunGC` inside the turn. A cyclic
  target unreachable in that turn is reclaimed mid-turn: `deref()` may
  return `undefined` before the turn ends, and the cleanup job runs at the
  turn's own job drain.
- **Boundary collection (the idle-GC path).** A cyclic target that stays
  below the hard threshold until the tick boundary stays live through its
  turn; the first boundary `JS_RunGC` clears it (`deref()` returns
  `undefined`), and the cleanup callback is queued as a job by that
  collection and runs at the next job drain — `idle_gc` does not drain jobs.

Guests that observe this timing can see collection move between frames; the
PocketJS framework, the RPG Kit and Tuxemon bundles do not use `WeakRef` or
`FinalizationRegistry`.

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
| `pocket3d-bsp` | The portable half of the 3D substrate (no_std + alloc): GoldSrc maps, hull collision, the character controller, PVS visibility, and the cooked `.p3d` world format. Runs identically under wgpu and on the PSP. |
| `pocket3d-gu` | The 3D substrate, PSP edition: renders cooked worlds through the GE (sceGu) with PVS culling, CLUT8 textures, and dynamic meshes. |
| `pocketjs-psp` (lib) | Guest hosting + `ui` surface, PSP edition: the arena allocator, the QuickJS embedding, the DrawList GE backend (with an overlay mode for 3D compositing), pak feeding, and the DevTools mailbox — everything the 2D EBOOT proved, linkable by game EBOOTs. |
| `pocket3d-vita` | The 3D substrate, Vita edition: CPU projection and six-plane clipping into vita2d/GXM at 960x544, painter-sorted so a PocketJS HUD can share the same scene. |
| `pocketjs-vita` (lib) | Guest hosting + `ui` surface, Vita edition: QuickJS, density-2 pak/font resources, controller/dual-analog input, logical-coordinate front-panel contacts and a native-density 960x544 vita2d backend over the portable 480x272 logical layout. |

A specialized runtime is then a thin composition. OpenStrike is:

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
