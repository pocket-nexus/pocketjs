# Platform contracts

**The `app` section of `pocket.host.config.ts` states what an application
uses. The host contract, `pocket.host.json`, describes the software behavior a
host program provides.** A host config names one or more host contracts and
may carry an application (`app`) and a native build recipe (`build`). The
resolver combines the application with one host contract into a
`ResolvedBuildPlan` and writes it to `.pocket/<target>/plan.json` for
application compilation.

```text
my-app/
  pocket.host.config.ts   # host config: hosts + app
  main.tsx
my-host/
  pocket.host.json        # Host contract
  pocket.host.config.ts   # host config: host + build
.pocket/
  <target>/
    plan.json             # Generated build plan
```

```text
  pocket.host.config.ts
  (app section, hosts)
         │ names
         ▼
  pocket.host.json ──────┐
  (host contract)        │
         │               │
         └── resolve ────┘
                │
                ▼
     .pocket/<target>/plan.json
            (build plan)
                │
                ▼
     compiler → bundle (.pkb)
```

The host program exports the same host contract as a C header or Rust module.
**A device admits a bundle when its exported facts satisfy the bundle's
plan**; `profileHash` records which host contract the bundle was compiled
against. See [Admission](#admission).

## Ownership

| Artifact            | File                               | Owner                | Meaning                                                                   |
| ------------------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| Application         | `app` in `pocket.host.config.ts`   | App                  | Entry, framework, logical viewport, tick rate, features                   |
| Host contract       | `pocket.host.json`                 | Host program         | Display facts, cadences and implemented APIs                              |
| Host config         | `pocket.host.config.ts`            | App or host program  | Host contract selection, the application and an optional native build recipe |
| Build plan          | `.pocket/<target>/plan.json`       | Resolver (generated) | One build's target-specific inputs, a `ResolvedBuildPlan`                 |
| Capability registry | `contracts/spec/capabilities.ts`   | PocketJS             | Ids PocketJS defines; a host contract defines the ids it lists outside it |

## The application

The [Application config](/docs/app-config/) page lists every field. A
PSP-shaped portable application says:

```ts
import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["psp", "vita"],
  app: {
    id: "dev.pocket-nexus.telemetry",
    title: "Pocket Telemetry",
    version: "1.0.0",
    entry: "app/main.tsx",
    output: "main",
    framework: "solid",
    viewport: { logical: [480, 272], presentation: "integer-fit" },
    features: ["text.glyphs.baked", "input.buttons", "input.analog.left"],
  },
});
```

The application contains no physical resolution, scale factor, Vita flag,
native crate path, or binding generation. The host program owns those inputs.
`hosts` lists the host contracts the application is built for: built-in ids,
or `pocket.host.json` paths relative to the config.

`app.tickHz` is the application rate: core ticks per virtual second, **1 through
60, default 60**. Resolution refuses a rate that is not a whole multiple of one
of the target's cadences. `id`, `title`, `version`, `author` and `icon` (a
path to a square PNG) are the identity the device packagers stamp:
`pocket compile` stores the icon as the bundle's icon section, and
`pocket pack` uses it when `--icon` is absent. `app.theme` is animation
content the config imports.

**`features` is compile-time selection.** Each id is a registered capability
or one the selected host contract defines;
the plan records it as `true` when the selected host provides it and `false`
when it does not, and the compiled runtime module reads the same table:

```ts
import { hasFeature } from "@pocketjs/framework/platform";

if (hasFeature("input.analog.left")) {
  installAnalogNavigation();
} else {
  installButtonNavigation();
}
```

Literal `hasFeature()` calls are target-specialized during compilation, so Bun
can remove an unavailable branch from the bundle. `platform.features` remains
the runtime surface for computed feature ids and introspection. Capability ids
are plain strings, not versioned tokens or permissions passed through
application call graphs. A host that lacks a listed feature still builds the
application with that feature off; the config's `hosts` list states which
hosts the application is built for.

### Additional display surfaces

An application that uses a second fixed display lists the feature and states
its logical geometry. This example uses a 320×240 auxiliary surface with
touch:

```ts
app: {
  // ...
  features: ["display.auxiliary", "input.touch.auxiliary"],
  surfaces: {
    auxiliary: { fixed: { logical: [320, 240], presentation: "native" } },
  },
}
```

**`display.auxiliary` creates a second layout, draw, hit-test, and overlay
domain inside the same application instance.** The primary and auxiliary trees
share application state and resources, but neither tree participates in the
other tree's layout or hit testing. Applications render auxiliary content with
`<AuxiliarySurface>`.

**`input.touch.auxiliary` reports contacts in auxiliary logical pixels and does
not provide `input.touch`.** The resolver refuses `input.touch.auxiliary`
without `display.auxiliary`, and `display.auxiliary` without
`surfaces.auxiliary`. An auxiliary surface the selected host cannot present
turns both features off in the plan. A host contract must publish the
auxiliary physical/logical display facts together with `display.auxiliary`;
mismatched facts are rejected before an application is resolved. The bundle
format uses one raster asset density for both surfaces, so both
display facts must declare the same `rasterDensity`.

## Modality

A **modality** is the interaction structure of a target read off its host
contract: the screens, which screen takes contacts, whether a d-pad and sticks
exist, where text comes from, and how large the primary screen is.
`deriveModality` in `contracts/spec/modality.ts` is a pure function of the
display facts and capability ids the host contract already declares. **Nothing
registers a modality.**

| Field | Values |
| --- | --- |
| `screens[]` | per screen: `role`, `logical` size, `orientation`, `touch`, `resizable` |
| `touch` | `none`, `primary`, `auxiliary` |
| `pointer` | `none`, `cursor` (synthesized from the nub), `pointer` (a real pointer) |
| `buttons`, `analog`, `text` | boolean; 0 to 2 sticks; `osk` or `keyboard` |
| `glyphs` | `playstation` (○ × △ □) or `letters` (A B X Y) |

A PSP derives to one 480×272 landscape screen with no touch, one stick and
PlayStation glyphs. A New 3DS derives to a 400×240 top screen and a 320×240
bottom screen with touch, two sticks and letter glyphs.

The plan records the derived `modality` and `presentation: { id: "default",
entry }`. Inside an entry, folded `hasFeature()` calls and the runtime
`modality` object from `@pocketjs/framework/modality` carry the differences
between hosts. **An application whose layout differs by device is one config
per layout**: `apps/nexus-touch/pocket.host.config.ts` builds the iPod touch 4
application and `apps/nexus-touch/e7/pocket.host.config.ts` the Nokia E7
portrait application from the same scene module.

## Animation classes

An **animation class** is what a changed frame costs a target. **The host
contract states it as `display.animation`**; no platform table derives it, and
admission requires the bundle's class to equal the host's.

| Class | Frame cost | Built-in host contracts |
| --- | --- | --- |
| `composited` | A GPU composes every frame from retained geometry; a prop change on any subtree costs the same at the tick rate. | `psp`, `vita`, `3ds-runtime`, iOS, macOS widgets and web host contracts |
| `repaint` | A CPU repaints the pixels a change touched, so a frame costs in proportion to that area; the host moves the pixels of a translated opaque region instead of repainting them. | `gba`, `ipodnano`, `symbian-e7-dev` |
| `still` | The display shows one change per refresh. `animate()` and `spring()` set the end value and return no animation. | `pocketbook` |

The plan records `animation`, `tools/build.ts` folds it into the bundle,
and `animationClass` from `@pocketjs/framework/animation` reads it. An
application keeps two sets of transitions where the costs differ. On a
repaint target, translations of opaque regions and changes inside a small
area run at the tick rate; a `scale`, `opacity` or `rotate` tween over a
large subtree repaints the whole area every frame, so the application
replaces it with a cut; an animation that runs while nothing happens (a
wiggle, a pulse) repaints its area every frame for no input.

On the M5Stack Tab5 (ESP32-P4 at 360 MHz), measured on the 592×360 logical
surface it had before the 640×360 one, a full-surface repaint takes **25 to
60 ms per core** by content, a translated opaque page moves through DMA in
**under 20 ms**, and an icon-sized region repaints in **under 10 ms**; the
cadence is 30 Hz, 33 ms per frame.

## Viewport policy and companion adapters

A host contract carries a `form` (`takeover`, `window`, `widget`, `kiosk`,
`embedded`). **`window` and `widget` are the dynamic forms: their logical
viewport is a runtime variable, and their host contract must carry
`display.dynamicViewport` with a `min`/`max` range; every other form must not.**
An application states viewport intent per policy rather than per target:

```ts
app: {
  // ...
  viewport: {
    fixed: { logical: [480, 272], presentation: "integer-fit" },
    dynamic: { default: [720, 480] },
  },
  companions: ["note"],
}
```

The bare `{logical, presentation}` spelling is shorthand for `fixed`.
`fixed.logical` is one size, a list of sizes in preference order, or a
`{min, max}` range. **The resolver takes the first listed size the target's
`logicalViewports` contains**; for a range it takes the first target size
inside the range. `apps/clear/pocket.host.config.ts` lists 320×480, 360×800
and 360×640 and states a 360×640 dynamic viewport, which resolves on the iPod
touch 4 and the Nokia E7 from one config. `resolveViewport` in
`framework/compiler/app-plan.ts` then picks one variant:

- On a dynamic-form target it takes `dynamic.default`, which must fall inside
  the host contract's range; presentation resolves to `native` and physical
  size to logical × `rasterDensity`. The resolver does not read the
  application's `dynamic.min`/`dynamic.max`: the admitted range belongs to the
  target.
- A fixed-only application resolves on a dynamic-form target when its host
  contract sets `dynamicViewport.acceptsFixed` (`web-app` does;
  `macos-widget` does not), and runs size-locked in the window.
- A fixed-screen target refuses a dynamic-only application, and a
  dynamic-form target without `acceptsFixed` refuses a fixed-only application,
  both before compilation.

The plan records which one won as `viewport.policy` (`"fixed"` or `"dynamic"`),
so a host derives size-locking from the plan. An application that must
relayout on resize lists `display.viewport.live` and takes new sizes through
the framework's `resizeViewport` hook.

`app.companions` lists the exact strings the application passes to
`svcOpen`: the service names its adapters speak. The resolver copies the list
into `plan.companions` unchanged, and a host builds its svc allowlist from that
copy instead of an app-name convention. `UiSurface::set_svc_allowlist`
installs this list, and `svcOpen` denies everything else.
**A host with no adapter for those services rejects a plan whose `companions`
list is non-empty** rather than starting an app whose services answer false.

## What a capability means

A registered capability means:

> This stock host implements and tests this PocketJS framework API.

It does not mean that hardware contains a component. Vita advertises touch
because the stock host samples the front panel, maps contacts to logical
viewport coordinates, and delivers the public `touches()` API.

It also does not model mobile permissions or live device state. Those are
different questions:

- **Host API support** is a build-time capability.
- **Permission or entitlement** needs its own declaration and runtime result.
- **Runtime availability** such as window size, fold state, or an attached
  controller must be queried at runtime.

`input.touch` means that the API and delivery path exist. It does not mean a
finger is down: `touches()` returns an empty snapshot in that state. An
application lists `input.touch` and keeps a button path behind
`hasFeature("input.touch")` to build for the PSP too, or lists only the hosts
that provide touch when touch is fundamental to the product.

`input.cursor` follows the same rule for the [virtual
cursor](/docs/input-focus/#virtual-cursor): the host implements hit testing
and the cursor sprite (spec ops 27–29), and the framework synthesizes a
pointer from the analog nub. It takes two steps: the feature in the
application's `features` and `enableCursor()` at run time; apps that never
call it keep the d-pad focus walk unchanged.

### Host-defined capabilities

**A capability id is defined by PocketJS or by a host.** The registry lists
the ids PocketJS defines: a host contract in `hosts/` provides the id, or the
compiler, framework or engine acts on it. A host contract may list ids the
registry does not know; **those ids are the host's**:

- `validatePocketProfile` and `validatePlatformContractRegistry` accept them.
- `resolveAppPlan` accepts an `app.features` entry when the registry or the
  `capabilities` of the selected host contract has it, and records it in
  `plan.features` like a registered id. An entry that neither has is
  `capability.unknown`.
- Admission compares feature names with the host's capability names as
  strings, so a device admits the plan without knowing the id.
- PocketJS attaches nothing else to the id: no dependency rule, no
  compile-time behavior, no engine bit. The host's program and guest modules
  implement it.

`hasFeature` accepts any string; registered ids complete in the editor. Ids
have no namespace: a host-defined id keeps the spelling its product publishes
in manifests and plans, and a future PocketJS id avoids a name a product
already uses **by coordination with that product**.

## Host contracts

Built-in host contracts live in `hosts/<id>/pocket.host.json`, and
`hosts/index.ts` loads them. **A host contract holds facts: no code, no hash
and no field derived from a label.** `contracts/schema/pocket-host-2.json`
validates it; `validatePocketProfile` in `framework/src/profile.ts` adds the
checks a schema cannot state (dynamic forms, auxiliary surfaces, worker kinds,
contact coordinate limits). **Every host contract uses the same binding
generation, 12.**

| Field | Meaning |
| --- | --- |
| `format` | `"pocket-host/2"` |
| `id`, `platform`, `form` | Labels and the window or takeover form |
| `cadences` | Presented frames per second the host drives |
| `display` | `logicalViewports`, `presentations`, `rasterDensity`, `animation`, and optional `dynamicViewport` and `auxiliary` |
| `panel` | Physical panel sizes in pixels; the compiler reads them, admission does not |
| `capabilities` | Capability ids, compared as a set: registered ids and ids the host defines |
| `worker.nodes` | The most worker nodes of each kind one application may declare |
| `worker.channels` | `recordBytes` and `capacity`: the largest worker channel one application may declare, and the size of a channel declared `"host"`. At least **1024 bytes and 8 records** (the value when absent), at most **64 KiB and 256 records** |
| `worker.http` | `responseBytes`: the largest response body one `http` request may ask for. At least **256 KiB** (the value when absent) |
| `limits`, `input` | Bundle and heap bytes; touch contacts and coordinate bits |
| `hostAbi` | The binding generation a release stamps; another value is rejected |

| Target         | platform / form   | Logical viewport                         | Density | Capabilities |
| -------------- | ----------------- | ---------------------------------------- | ------- | ------------ |
| `psp`          | psp / takeover    | 480×272 (`native`, `integer-fit`)        | 1       | `input.analog.left`, `input.buttons`, `input.cursor`, `audio.pcm`, `data.fs`, `data.pack`, `text.glyphs.baked` |
| `vita`         | vita / takeover   | 480×272 (`integer-fit`)                  | 2       | `input.analog.left`, `input.buttons`, `input.cursor`, `input.touch`, `text.glyphs.baked` |
| `pocketbook`   | pocketbook / takeover | 480×272 (`integer-fit`)              | 2       | `input.buttons`, `input.touch`, `text.glyphs.baked` |
| `macos-widget` | macos / widget    | 420×560 default, 240×180…4096×4096       | 2       | `input.buttons`, `input.ime`, `input.pointer`, `input.text`, `host.clipboard`, `display.viewport.live`, `text.glyphs.baked`, `text.glyphs.runtime` |
| `web-app`      | web / window      | 800×600 default, 320×240…4096×4096, accepts fixed | 1 | `input.buttons`, `display.viewport.live`, `text.glyphs.baked`, `text.glyphs.runtime` |

A product writes its own host contract:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-host-2.json",
  "format": "pocket-host/2",
  "id": "reader-panel",
  "platform": "pocketbook",
  "form": "takeover",
  "cadences": [30],
  "display": {
    "logicalViewports": [[480, 272]],
    "presentations": ["integer-fit"],
    "rasterDensity": 2,
    "animation": "still"
  },
  "panel": { "primary": [960, 544] },
  "capabilities": ["input.buttons", "input.touch", "text.glyphs.baked"]
}
```

**`profileHash` is the SHA-256 of the canonical projection of `id`,
`platform`, `form`, `cadences`, `display` and `capabilities`.** Capabilities
and cadences hash as sorted sets. The hash names the host contract a bundle
was compiled against. Admission does not compare it.

The host config, `pocket.host.config.ts`, names the host contract by a path
relative to the config file, or by a built-in host id:

```ts
import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: "./pocket.host.json",
  app: { entry: "app/main.tsx", framework: "solid", viewport: { logical: [320, 240], presentation: "native" } },
});
```

A config with several host contracts lists them under `hosts` instead of
`host`.

`pocket compile` resolves the config's `app` against its host contract; with
several hosts, `--target <id>` or `--target <pocket.host.json>` selects one
the config lists. `pocket host export --config pocket.host.config.ts --out
profile-export` writes `pocket_profile.h` and `pocket_profile.rs` (the hash
and the facts record) and `pocket.host.json` (the host contract with its
`hostAbi` stamp). IDF CMake helpers accept `HOST_CONFIG` and default to the
firmware root's host config. See [ESP-IDF](/docs/esp-idf/#embed-an-application).

DrawList is absent from the registry. It is PocketJS's internal core-to-backend
IR, not behavior an application can observe or request. GE, GXM, WGPU, and
software raster hosts may consume that IR while offering the same public UI
semantics.

`rasterDensity` is also not a capability. It is a target-owned rendering fact:
layout and DrawList coordinates remain logical, while font coverage, SVGs,
core masks, and target-selected image variants use that many raster samples per
logical pixel. Dynamic texture producers receive the same resolved value as
`platform.pixelRatio`; neither compiler nor application needs a Vita branch.

### Program build wrappers

Device programs also have host contracts under `hosts/`. Existing
`tools/*-profile.ts` exports adapt those records for the target-specific build
wrappers; they do not define another copy of the display or capability data.
`pocket catalog` lists built-in host ids. A product supplies its own host
contract without adding a built-in id.

## Resolution and PSP-to-Vita compatibility

`resolveAppPlan` in `framework/compiler/app-plan.ts` performs the same steps
for every host:

1. Validate the `app` section against its schema.
2. Find the selected host contract.
3. Reject features that neither the registry nor the host contract defines,
   and missing feature dependencies.
4. Resolve each feature to a boolean: whether the host provides it.
5. Validate the target raster density, logical viewport, presentation mode,
   auxiliary surface, worker and tick rate.
6. Produce and checksum the build plan.

A PSP-oriented app is not a PSP-only app. The application above resolves for
Vita unchanged because Vita accepts the same 480×272 logical viewport:

```text
PSP:  logical 480×272 → physical 480×272
      raster density 1
Vita: logical 480×272 → physical 960×544
      raster density 2
```

No `vita` stanza is needed: `hosts` lists `vita`, and the viewport rules hold
there. A Vita application that lists `input.touch` builds for the PSP with the
feature off and keeps its button path behind `hasFeature("input.touch")`.

## The build plan

The generated plan is cross-process build IR and the compiler's input
(`tools/build.ts --plan=<plan.json> --project-root=<dir> --outdir=<dir>`).
Its entries are relative to the project root. This excerpt shows the
application and viewport fields resolved for `vita`:

```json
{
  "app": {
    "id": "dev.pocket-nexus.telemetry",
    "title": "Pocket Telemetry",
    "version": "1.0.0",
    "entry": "app/main.tsx",
    "output": "main",
    "framework": "solid"
  },
  "target": { "id": "vita", "hostAbi": 12 },
  "viewport": {
    "logical": [480, 272],
    "physical": [960, 544],
    "presentation": "integer-fit",
    "rasterDensity": 2,
    "policy": "fixed"
  },
  "features": {
    "input.analog.left": true,
    "input.buttons": true,
    "text.glyphs.baked": true
  },
  "companions": [],
  "planHash": "sha256:…"
}
```

**`features` carries every feature the application lists**, each `true` when
the target provides it, plus `runtime.worker` and the node kinds of a worker;
the keys are sorted by codepoint so the pretty plan matches the canonical JSON
the hash is taken over.

The full plan also carries `profile` and `profileHash`. **`plan.profile` is the
compiled host contract plus `tickHz`, the application rate.** The bundle header
stores `profileHash`, the hash of the host contract's canonical projection, as
provenance. `.pocket/<target>/plan.json` records the compiler inputs for
inspection and reuse.

`planHash` is a checksum of this generated build IR. It detects a plan edited
or copied in part and can support build caching. It is not a runtime
compatibility hash, a signature, an attestation, or a trust chain. Application
identity and title are present because device packagers consume them; icons,
toolchain provenance, and other fields without a consumer stay out of the
plan. The Vita backend
derives a nine-character title id from the portable reverse-DNS app id instead
of keeping a per-demo target table.

## Admission

**A device admits a bundle when its exported facts satisfy every item of the
bundle's plan.** The rules live in `engine/package/src/admission.rs` for
devices, `contracts/spec/admission.ts` for tools, and the ESP-IDF embed script;
`engine/package/tests/fixtures/admission` is the corpus all three read.

| Item | Bundle | Host | Relation |
| --- | --- | --- | --- |
| Binding generation | header `hostAbi` | `POCKET_BINDING_GENERATION` | equal |
| Raster density | `plan.viewport.rasterDensity` | `display.rasterDensity` | equal |
| Animation | `plan.animation` | `display.animation` | equal |
| Rate | `plan.profile.tickHz` | `cadences` | a whole multiple of a cadence, at most 60 core ticks per frame |
| Logical viewport | `plan.viewport.logical` | `logicalViewports` or `dynamicViewport` | member |
| Presentation | `plan.viewport.presentation` | `display.presentations` | member |
| Capabilities | names `true` in `plan.features` | `capabilities` | subset |
| Auxiliary | `plan.surfaces.auxiliary` | auxiliary viewports and density | member and equal; skipped when the plan has none |

The id, platform, form, capability order, capabilities the host adds,
`hostExtension` and the panel size take no part. **A host with added
capabilities, added viewports, another id or another capability order admits a
bundle compiled for the original host contract.**

A device that does not admit a bundle names every item the plan fails, for
example `not admitted: rasterDensity`. A host that keeps applications in a
container of its own states the sections of the program it boots through its
package source; the runtime admits that plan by the same rules and checks the
same code sections. **The C package-open entry points,
`pocket_native_package_open` and `pocket_native_package_open_source`, the
ESP-IDF archive's `pocket_idf_package_open` and
`pocket_idf_package_open_source`, and the 3DS product's `pocket_package_open`,
return one table of `POCKET_PACKAGE_OPEN_*` codes**, declared in
`contracts/spec/runtime-abi.ts` and generated into `pocket_runtime.h` and
`pocket_drivers::abi`. The first failing item is its code:
`POCKET_PACKAGE_OPEN_BINDING_GENERATION` (7), `PLAN` (9), `RASTER_DENSITY`
(19), `ANIMATION` (20), `RATE` (21), `VIEWPORT` (22), `PRESENTATION` (23),
`CAPABILITY` (24), `AUXILIARY` (25); `pocket_runtime::abi::open_package` and
`open_source`, the bodies the entry points share, map every other failure. A
plan whose JSON, viewport or auxiliary surface cannot be read after admission
is `PLAN_JSON` (13), `PLAN_VIEWPORT` (14) or `PLAN_AUXILIARY` (15) at every
entry point; a package source that does not supply its length, sections or
bytes is `SOURCE` (27). The `*_open_source` forms read the source as boot
reads it and do not take its storage, so the same source boots the program
afterwards. Repack, `pocket pack` and the companion
agent read a runtime's `pocket.host.json` and apply the same rules.

### Rate and cadence

**`app.tickHz` is the application rate; the cadences are the host's.** A host
presents an application at the largest cadence its rate is a whole multiple of,
advances the core by rate ÷ cadence ticks per frame and publishes the cadence
as `__simHz`. A host offering cadences [60, 30] presents a 30 Hz application at
30 Hz and a 60 Hz application at 60 Hz; a panel with cadence 30 presents a 60 Hz
application at 30 Hz with two core ticks per frame. `after(1.5)` fires 1.5 wall
seconds after the first frame in each case. `pocket_runtime_get_timing`
reports the rate, the cadence and the ticks per frame after boot.

## Application and program builds

`pocket compile` reads the nearest host config above the working directory
(or `--config`), resolves its `app` for the selected host and emits one
bundle (`.pkb`). `--target` names a host the config lists, by built-in id or by
a `pocket.host.json` path; a config with one host needs none. The bundle's
identity section and plan carry the application's identity.

`pocket build` reads the host config, `pocket.host.config.ts`. Its optional
`build` field contains `cargo`, `cmake`, `make` or `compilerOnly` steps and an
optional `run(context)` hook. Each step receives the selected host contract's
canonical JSON, hash and binding generation through `POCKETJS_*` environment
variables. Build tools and drivers are program dependencies; the host contract
contains neither a compiler selection nor a renderer selection. **An
application config without `build` builds with the stock program of the
built-in host it selects** (`PROGRAMS` in `tools/build/programs.ts`), and
`pocket build` compiles the application first unless `--bundle` or `--aot-dir`
supplies it.

A host config without `build` exports the host contract for an external build
system. `pocket host export --config <file> --out <directory>` performs that
export without running a build recipe. C programs include `pocket_profile.h`; tools
that do not execute TypeScript consume `pocket.host.json`.

## Distribution

**A firmware release is three things: the program binary, its stamped
`pocket.host.json` and the binding generation.** A runtime directory lists
`pocket.host.json` in `runtime.json`, and a PocketJS release publishes each
runtime's host contract beside its archive as `pocket-host-<target>.json`.
`pocket host fetch --target <id> --out <file>` downloads that host contract and
checks it against the release's file hash, `profileHash` and binding
generation; `pocket compile --target <file>` then compiles a bundle the
runtime admits.

| Tier | Program | Host contract | Checks |
| --- | --- | --- | --- |
| 1 | In-tree catalog | `hosts/<id>/pocket.host.json` | Goldens and release runtimes |
| 2 | Out-of-tree program | A published `pocket.host.json` and build receipt | The program's own |
| 3 | Any document | A local `pocket.host.json` | The schema and `validatePocketProfile` |

All three tiers compile with the same `pocket compile`.

The plan's field names and hash rule are the contract between resolvers and
the compiler; a plan may carry fields this repository does not read. Custom
hosts use the smaller stable boundary instead of the whole plan:

```ts
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "@pocketjs/framework/plan";

const inputs = extractHostBuildInputs(planJson, { expectedTarget: "vita" });
const env = hostBuildEnvironment(inputs, {
  outputDirectory: "dist/pocket/vita",
  embedApp: false,
});
```

This verifies the plan checksum and the plan's `profileHash`, extracts host
build inputs, and produces the Cargo environment used by existing program
wrappers.

## Runtime and TypeScript checks

At startup, `assertNativeHostContract` compares the baked tick rate against the
rate the host declares in `ui.__tickHz`, then the HostOps ABI. **The tick-rate
check runs for every native mount, plan or no plan**: a bundle without an
explicit `--hz` bakes 60, and a host that declares no `__tickHz` is read as 60,
so a mismatch means the bundle's virtual time and the host's core disagree. The
ABI check runs for a bundle that embedded a build contract; device admission
decides which hosts run a bundle, so the host id is not compared. Stock builds embed the JS and native host
together, so repeating the whole build plan as a runtime hash would make
unrelated build metadata part of the wire contract.

`bun pocket check`, `compile`, and `build` type-check the app entry and its
reachable imports with the app's ordinary TypeScript configuration. There is
no generated ambient target module, branded capability token, or special
reachability authorization model. Optional APIs are ordinary guarded feature
checks; the `hosts` list and the resolved plan provide the build-time
compatibility guarantee.
`platform.pixelRatio` is an ordinary build-defined number for code that must
produce raster data at runtime; it does not change layout units or API
availability.
