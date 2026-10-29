# Platform contracts

**A profile document describes the software behavior a program provides.** An
application declares requirements in `pocket.json`; a program describes its
host in a `pocket-profile/2` JSON document and names it from
`pocket.runtime-config.ts`. The resolver combines the manifest and profile into
a `ResolvedBuildPlan` for application compilation.

```text
  pocket.json           pocket-profile.json
  (application)         (program facts)
       └──────── resolve ────────┘
                    │
                    ▼
       .pocket/<profile-id>/plan.json
                    │
                    ▼
          compiler → .pocket package
```

The program exports the same profile as a C header or Rust module. **A device
admits a package when its exported facts satisfy the package's plan**; the
profile hash records which document the package was compiled against. See
[Admission](#admission).

## Ownership

| Data                 | Owner                     | Meaning                                                           |
| -------------------- | ------------------------- | ----------------------------------------------------------------- |
| `pocket.json`        | App                       | Entry, framework, logical viewport, tick rate, required and optional APIs |
| Capability registry  | PocketJS                  | Names of framework APIs that can be requested                     |
| Profile document     | Program                   | Display facts, cadences and implemented APIs                       |
| `ResolvedBuildPlan`  | Resolver                  | One build's target-specific inputs                                |
| Runtime config       | Program                   | Profile selection and an optional native build recipe              |

## Application manifest

Format 2 is strict JSON data; the [application manifest](/docs/manifest/)
page lists every field. A PSP-shaped portable app can say:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-2.json",
  "pocket": 2,
  "id": "dev.pocket-nexus.telemetry",
  "title": "Pocket Telemetry",
  "version": "1.0.0",
  "engine": {
    "capabilities": {
      "requires": ["text.glyphs.baked", "input.buttons"],
      "enhances": ["input.analog.left"]
    }
  },
  "app": {
    "entry": "app/main.tsx",
    "output": "main",
    "framework": "solid",
    "viewport": { "logical": [480, 272], "presentation": "integer-fit" }
  }
}
```

The manifest contains no physical resolution, scale factor, Vita flag, native
crate path, or binding generation. The program owns those inputs.

`app.tickHz` is the package rate: core ticks per virtual second, **1 through
60, default 60**. Resolution refuses a rate that is not a whole multiple of one
of the target's cadences. `author` and `icon` (a path to a square PNG) are the
identity a repacked program records: `pocket compile` stores the icon as each
variant's cover section, and `pocket pack` uses both when `--author` and
`--icon` are absent. `app.theme` names a module or JSON file; an authored
manifest does not carry theme content.

`requires` is the compatibility floor. Resolution fails before compilation if
the selected host does not provide one of those APIs. `enhances` declares an
optional API for which the app has a fallback. Its availability becomes a
boolean in the plan and in the compiled runtime module:

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
application call graphs.

### Additional display surfaces

An application that uses a second fixed display declares both the API and its
logical geometry. This example requires a 320×240 auxiliary surface with touch:

```json
{
  "engine": {
    "capabilities": {
      "requires": ["display.auxiliary", "input.touch.auxiliary"]
    }
  },
  "app": {
    "surfaces": {
      "auxiliary": {
        "fixed": { "logical": [320, 240], "presentation": "native" }
      }
    }
  }
}
```

**`display.auxiliary` creates a second layout, draw, hit-test, and overlay
domain inside the same application instance.** The primary and auxiliary trees
share application state and resources, but neither tree participates in the
other tree's layout or hit testing. Applications render auxiliary content with
`<AuxiliarySurface>`.

**`input.touch.auxiliary` reports contacts in auxiliary logical pixels and does
not provide `input.touch`.** The resolver requires `display.auxiliary` whenever
auxiliary touch is requested. A target profile must publish the auxiliary
physical/logical display facts together with `display.auxiliary`; mismatched
facts are rejected before an application is resolved. The current package
format uses one raster asset density for both surfaces, so both display facts
must declare the same `rasterDensity`.

## Presentations and modality

A **modality** is the interaction structure of a target read off its profile:
the screens, which screen takes contacts, whether a d-pad and sticks exist,
where text comes from, and how large the primary screen is.
`deriveModality` in `contracts/spec/modality.ts` is a pure function of the
display facts and capability ids the profile already declares. **Nothing
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

A **presentation** is an entry module written for one modality. The manifest
lists them in order under `app.presentations`; each carries a `modality`
requirement and may carry its own `viewport`, `surfaces`, `output` and
`capabilities`:

```json
{
  "app": {
    "entry": "app/main.tsx",
    "viewport": { "logical": [480, 272], "presentation": "integer-fit" },
    "presentations": [
      {
        "id": "dual-screen",
        "entry": "app/main-dual.tsx",
        "modality": { "screens": 2, "touch": "auxiliary" },
        "viewport": { "fixed": { "logical": [400, 240], "presentation": "native" } },
        "surfaces": { "auxiliary": { "fixed": { "logical": [320, 240], "presentation": "native" } } },
        "capabilities": { "requires": ["display.auxiliary", "input.touch.auxiliary"] }
      }
    ]
  }
}
```

**The resolver takes the first presentation whose requirement the target's
modality meets; when none matches, `app.entry` is the baseline presentation
under the id `default`.** `screens` is an exact count, `analog` a minimum,
`minScreen` and `maxScreen` inclusive bounds on the primary screen, `touch`
and `pointer` exact values or `"any"`; an absent field matches every device.
The chosen presentation's capabilities join `engine.capabilities` for
admission, a presentation `requires` may promote an app-level `enhances`, and
any other repeated id is a `capability.duplicate` diagnostic. **A
presentation that matches a device and fails admission there is an error at
that presentation's JSON Pointer**, because the author addressed it to that
device.

The plan records `presentation` (`id` and `entry`) and `modality`, and sets
`app.entry` to the chosen module. The compiler walks the module graph from
that entry, so **a presentation's modules, class literals, glyphs and image
assets enter a bundle only when it is the chosen entry**. Inside an entry,
folded `hasFeature()` calls and the runtime `modality` object from
`@pocketjs/framework/modality` carry the smaller differences.

## Animation classes

An **animation class** is what a changed frame costs a target. **The profile
document states it as `display.animation`**; no platform table derives it, and
admission requires the package's class to equal the host's.

| Class | Frame cost | Built-in profiles |
| --- | --- | --- |
| `composited` | A GPU composes every frame from retained geometry; a prop change on any subtree costs the same at the tick rate. | `psp`, `vita`, `3ds-dev`, the iOS, macOS, web, Android, Linux and BlackBerry profiles |
| `repaint` | A CPU repaints the pixels a change touched, so a frame costs in proportion to that area; the host moves the pixels of a translated opaque region instead of repainting them. | `gba`, `ipodnano`, `meizu-m8-dev`, `symbian-e7-dev` |
| `still` | The display shows one change per refresh. `animate()` and `spring()` set the end value and return no animation. | `pocketbook` |

The plan records `animation`, `tools/build.ts` folds it into the bundle,
and `animationClass` from `@pocketjs/framework/animation` reads it. An
application keeps two sets of transitions where the costs differ. On a
repaint target, translations of opaque regions and changes inside a small
area run at the tick rate; a `scale`, `opacity` or `rotate` tween over a
large subtree repaints the whole area every frame, so the application
replaces it with a cut; an animation that runs while nothing happens (a
wiggle, a pulse) repaints its area every frame for no input.

On the M5Stack Tab5 (ESP32-P4 at 360 MHz, 592×360 logical pixels), a
full-surface repaint takes **25 to 60 ms per core** by content, a
translated opaque page moves through DMA in **under 20 ms**, and an
icon-sized region repaints in **under 10 ms**; the cadence is 30 Hz, 33 ms per
frame.

## Viewport policy and companion adapters

A target profile carries a `form` (`takeover`, `window`, `widget`, `kiosk`,
`embedded`). **`window` and `widget` are the dynamic forms: their logical
viewport is a runtime variable, and their profile must carry
`display.dynamicViewport` with a `min`/`max` range; every other form must not.**
An app declares viewport intent per policy rather than per target:

```json
{
  "app": {
    "viewport": {
      "fixed": { "logical": [480, 272], "presentation": "integer-fit" },
      "dynamic": { "default": [720, 480] }
    },
    "companions": ["note"]
  }
}
```

The bare `{logical, presentation}` spelling remains valid as shorthand for
`fixed`. `fixed.logical` is one size, a list of sizes in preference order, or a
`{min, max}` range. **The resolver takes the first listed size the target's
`logicalViewports` contains**; for a range it takes the first target size
inside the range. `apps/clear/pocket.json` lists 320×480, 360×800 and 360×640
and declares a 360×640 dynamic range, which resolves on iPod touch 4, Moto G
Play, Redmi 1S and Nokia E7 from one manifest. `resolveViewport` in
`framework/src/manifest/resolve.ts` then picks one variant:

- On a dynamic-form target it takes `dynamic.default`, which must fall inside
  the profile's range; presentation resolves to `native` and physical size to
  logical × `rasterDensity`. The app's own `dynamic.min`/`dynamic.max` are
  schema-valid and unread — the admitted range belongs to the target.
- A fixed-only app resolves on a dynamic-form target when that profile sets
  `dynamicViewport.acceptsFixed` (`macos-app`, `linux-app`, `web-app` do;
  `macos-widget` does not), and runs size-locked in the window.
- A fixed-screen target rejects a dynamic-only app, and a dynamic-form target
  without `acceptsFixed` rejects a fixed-only app, both before compilation.

The plan records which one won as `viewport.policy` (`"fixed"` or `"dynamic"`),
so a host derives size-locking from the plan and never re-reads the manifest.
An app that must relayout on resize declares `display.viewport.live` and takes
new sizes through the framework's `resizeViewport` hook.

`app.companions` lists the exact strings the app passes to `svcOpen` — the
service names its adapters speak. The resolver copies the list into
`plan.companions` unchanged, and a host builds its svc allowlist from that copy
instead of an app-name convention: `programs/desktop` calls
`set_svc_allowlist(plan.companions)`, and `svcOpen` denies everything else.
**A host with no adapter for those services rejects a plan whose `companions`
list is non-empty** rather than starting an app whose services answer false.

## What a capability means

A capability means:

> This stock host implements and tests this PocketJS framework API.

It does not mean that hardware merely contains a component. Vita advertises
touch because the stock host samples the front panel, maps contacts to
logical viewport coordinates, and delivers the public `touches()` API.

It also does not model mobile permissions or live device state. Those are
different questions:

- **Host API support** is a build-time capability.
- **Permission or entitlement** needs its own declaration and runtime result.
- **Runtime availability** such as window size, fold state, or an attached
  controller must be queried at runtime.

`input.touch` means that the API and delivery path exist. It does not mean a
finger is currently down: `touches()` returns an empty snapshot in that state.
An application can put touch in `enhances` and keep its button fallback for
PSP, or put it in `requires` when touch is fundamental to the product.

`input.cursor` follows the same rule for the [virtual
cursor](/docs/input-focus/#virtual-cursor): the host implements hit testing
and the cursor sprite (spec ops 27–29), and the framework synthesizes a
pointer from the analog nub. It is opt-in twice over — declared in the
manifest AND enabled at runtime with `enableCursor()`; apps that never call it
keep the d-pad focus walk unchanged.

## Target profiles

Built-in profile documents live in `profiles/<id>.json`, and
`profiles/index.ts` loads them. **A document holds facts: no code, no hash
and no field derived from a label.** `contracts/schema/pocket-profile-2.json`
validates it; `validatePocketProfile` in `framework/src/profile.ts` adds the
checks a schema cannot state (dynamic forms, auxiliary surfaces, worker kinds,
contact coordinate limits). **Every profile uses the same binding generation,
12.**

| Field | Meaning |
| --- | --- |
| `format` | `"pocket-profile/2"` |
| `id`, `platform`, `form` | Labels and the window or takeover form |
| `cadences` | Presented frames per second the host drives |
| `display` | `logicalViewports`, `presentations`, `rasterDensity`, `animation`, and optional `dynamicViewport` and `auxiliary` |
| `panel` | Physical panel sizes in pixels; the compiler reads them, admission does not |
| `capabilities` | Capability names, compared as a set |
| `roleCapabilities.systemUI` | Names a package in the System UI role also receives |
| `worker.nodes` | The most worker nodes of each kind one package may declare |
| `limits`, `input` | Package and heap bytes; touch contacts and coordinate bits |
| `hostAbi` | The binding generation a release stamps; another value is rejected |

| Target         | platform / form   | Logical viewport                         | Density | Capabilities |
| -------------- | ----------------- | ---------------------------------------- | ------- | ------------ |
| `psp`          | psp / takeover    | 480×272 (`native`, `integer-fit`)        | 1       | `input.analog.left`, `input.buttons`, `input.cursor`, `audio.pcm`, `text.glyphs.baked` |
| `vita`         | vita / takeover   | 480×272 (`integer-fit`)                  | 2       | `input.analog.left`, `input.buttons`, `input.cursor`, `input.touch`, `text.glyphs.baked` |
| `pocketbook`   | pocketbook / takeover | 480×272 (`integer-fit`)              | 2       | `input.buttons`, `input.touch`, `text.glyphs.baked` |
| `macos-widget` | macos / widget    | 420×560 default, 240×180…4096×4096       | 2       | `input.buttons`, `input.ime`, `input.pointer`, `input.text`, `host.clipboard`, `display.viewport.live`, `text.glyphs.baked`, `text.glyphs.runtime` |
| `macos-app`    | macos / window    | 720×480 default, 240×180…4096×4096, accepts fixed | 2 | `input.buttons`, `display.viewport.live`, `text.glyphs.baked`, `text.layout.native`; systemUI role adds `ui.compositor-surfaces` |
| `linux-app`    | linux / window    | 800×600 default, 240×180…4096×4096, accepts fixed | 1 | same as `macos-app` |
| `web-app`      | web / window      | 800×600 default, 320×240…4096×4096, accepts fixed | 1 | `input.buttons`, `display.viewport.live`, `text.glyphs.baked`, `text.glyphs.runtime`; systemUI role adds `ui.compositor-surfaces` |

`roleCapabilities.systemUI` is the one conditional column: those APIs reach a
package only when it resolves in the System-UI role. `ui.compositor-surfaces`
is the API a shell uses to place other installed packages into native
compositor surfaces, so an ordinary application requiring it against the same
target fails resolution.

A product writes its own document:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-profile-2.json",
  "format": "pocket-profile/2",
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
`platform`, `form`, `cadences`, `display`, `capabilities` and
`roleCapabilities`.** Capabilities, cadences and role capabilities hash as
sorted sets. The hash names the document a package was compiled against.
Admission tries hash-equal variants first and does not require a match.

`pocket.runtime-config.ts` names the document by a path relative to the
configuration:

```ts
import { defineRuntimeConfig } from "@pocketjs/framework/runtime-config";

export default defineRuntimeConfig({ profile: "./profiles/panel.json" });
```

`pocket compile --manifest app/pocket.json --runtime-config
pocket.runtime-config.ts` resolves the application against that document;
`pocket compile --target ./profiles/panel.json` does the same without a
configuration. `pocket profile export --config pocket.runtime-config.ts --out
profile-export` writes `pocket_profile.h` and `pocket_profile.rs` (the hash
and the facts record) and `pocket-profile.json` (the document with its
`hostAbi` stamp). IDF CMake helpers accept `RUNTIME_CONFIG` and default to the
firmware root's config. See [ESP-IDF](/docs/esp-idf/#embed-an-application).

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

Device programs also have profiles under `profiles/`. Existing
`tools/*-profile.ts` exports adapt those records for the target-specific build
wrappers; they do not define another copy of the display or capability data.
`pocket catalog` lists built-in profile ids. A product supplies its own
document without adding a built-in id.

## Resolution and PSP-to-Vita compatibility

The resolver performs the same steps for every registered target:

1. Validate `pocket.json` against the format-2 JSON Schema.
2. Find the selected target profile.
3. Reject unknown, duplicate, or unavailable required capabilities.
4. Resolve declared enhancements to booleans.
5. Validate the target raster density, logical viewport, and presentation mode.
6. Produce and checksum the build plan.

A PSP-oriented app is not a PSP-only app. The manifest above resolves for Vita
unchanged because Vita provides the same required APIs and accepts the same
480×272 logical viewport:

```text
PSP:  logical 480×272 → physical 480×272
      raster density 1
Vita: logical 480×272 → physical 960×544
      raster density 2
```

No `vita` stanza is needed. Compatibility is determined by requirements and
viewport rules, not by a target allowlist. A Vita app that treats touch as an
enhancement retains its button fallback for PSP; if it makes touch a
requirement, the PSP build fails during resolution.

## The build plan

The generated plan is cross-process build IR, not public app configuration.
This excerpt shows the application and viewport fields resolved for `vita`:

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

**`features` carries every declared capability, requirements included** — a
requirement is true by construction, an enhancement reflects target
availability — and the keys are sorted by codepoint so the pretty plan matches
the canonical JSON the hash is taken over.

The full plan also carries `profile` and `profileHash`. **`plan.profile` is the
compiled document plus `tickHz`, the package rate.** The `.pocket` variant
stores `profileHash` as provenance. `.pocket/<profile-id>/plan.json` records
the compiler inputs for inspection and reuse.

`planHash` is only a checksum of this generated build IR. It detects an edited
or partially copied plan and can support build caching. It is not a runtime
compatibility hash, a signature, an attestation, or a trust chain. Application
identity and title are present because package backends consume them; icons,
toolchain provenance, and other fields without a real consumer do not belong
in the plan merely to make its hash look comprehensive. The Vita backend
derives a nine-character title id from the portable reverse-DNS app id instead
of keeping a per-demo target table.

## Admission

**A device admits a package when its exported facts satisfy every item of the
variant's plan.** The rules live in `engine/package/src/admission.rs` for
devices, `contracts/spec/admission.ts` for tools, and the ESP-IDF embed script;
`engine/package/tests/fixtures/admission` is the corpus all three read.

| Item | Package | Host | Relation |
| --- | --- | --- | --- |
| Binding generation | variant `hostAbi` | `POCKET_BINDING_GENERATION` | equal |
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
package compiled for the original profile.**

A device takes the first variant whose profile hash equals its own and that it
admits, then the first other variant it admits. When none qualifies it rejects
the package and names the items the closest variant lacks, for example
`variant 0 (psp) is not admitted: rasterDensity`. The C package-open entry
points return the first failing item as a code: **7** binding generation,
**9** plan, **19** raster density, **20** animation, **21** rate, **22**
viewport, **23** presentation, **24** capability, **25** auxiliary
(`engine/runtime-cabi/src/package_open.rs`). Repack, `pocket pack` and the
companion agent read a runtime's `pocket-profile.json` and apply the same
rules.

### Rate and cadence

**`app.tickHz` is the package rate; the cadences are the host's.** A host
presents a package at the largest cadence its rate is a whole multiple of,
advances the core by rate ÷ cadence ticks per frame and publishes the cadence
as `__simHz`. A desktop with cadences [60, 30] presents a 30 Hz package at
30 Hz and a 60 Hz package at 60 Hz; a panel with cadence 30 presents a 60 Hz
package at 30 Hz with two core ticks per frame. `after(1.5)` fires 1.5 wall
seconds after the first frame in each case. `pocket_runtime_get_timing`
reports the rate, the cadence and the ticks per frame after boot.

## Application and program builds

`pocket compile` consumes the resolved plan and emits a `.pocket` application.
It accepts a built-in profile id or a `pocket-profile.json` path as `--target`;
without that option, it reads the nearest runtime config.

`pocket build` reads `pocket.runtime-config.ts`. Its optional `build` field
contains `cargo`, `cmake`, `make` or `compilerOnly` steps and an optional
`run(context)` hook. Each step receives the selected profile's canonical JSON,
hash and binding generation through `POCKETJS_*` environment variables. Build
tools and drivers are program dependencies; the profile document contains
neither a compiler selection nor a renderer selection.

A config without `build` exports the profile for an external build system.
`pocket profile export --config <file> --out <directory>` performs that export
without running a build recipe. C programs include `pocket_profile.h`; tools
that do not execute TypeScript consume `pocket-profile.json`.

## Distribution

**A firmware release is three things: the program binary, its stamped
`pocket-profile.json` and the binding generation.** A runtime directory lists
`pocket-profile.json` in `runtime.json`, and a PocketJS release publishes each
runtime's document beside its archive. `pocket profile fetch --target <id>
--out <file>` downloads that document and checks it against the release's
file hash, profile hash and binding generation; `pocket compile --target
<file>` then compiles a package the runtime admits.

| Tier | Program | Profile | Checks |
| --- | --- | --- | --- |
| 1 | In-tree catalog | `profiles/<id>.json` | Goldens and release runtimes |
| 2 | Out-of-tree program | A published `pocket-profile.json` and build receipt | The program's own |
| 3 | Any document | A local `pocket-profile.json` | The schema and `validatePocketProfile` |

All three tiers compile with the same `pocket compile`.

The complete `ResolvedBuildPlan` is internal and may evolve. Custom hosts use
the smaller stable boundary instead:

```ts
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "@pocketjs/framework/manifest";

const inputs = extractHostBuildInputs(planJson, { expectedTarget: "vita" });
const env = hostBuildEnvironment(inputs, {
  outputDirectory: "dist/pocket/vita",
  embedApp: false,
});
```

This verifies the plan checksum and the plan's profile hash, extracts host
build inputs, and produces the Cargo environment used by existing program
wrappers.

## Runtime and TypeScript checks

At startup, `assertNativeHostContract` compares the baked tick rate against the
rate the host declares in `ui.__tickHz`, then the HostOps ABI. **The tick-rate
check runs for every native mount, plan or no plan**: a bundle without an
explicit `--hz` bakes 60, and a host that declares no `__tickHz` is read as 60,
so a mismatch means the bundle's virtual time and the host's core disagree. The
ABI check runs for a bundle that embedded a build contract; device admission
decides which hosts run a package, so the host id is not compared. Stock builds embed the JS and native host
together, so repeating the whole build plan as a runtime hash would make
unrelated build metadata part of the wire contract.

`bun pocket check`, `compile`, and `build` type-check the app entry and its
reachable imports with the app's ordinary TypeScript configuration. There is
no generated ambient target module, branded capability token, or special
reachability authorization model. Optional APIs are ordinary guarded feature
checks; the manifest provides the build-time compatibility guarantee.
`platform.pixelRatio` is an ordinary build-defined number for code that must
produce raster data at runtime; it does not change layout units or API
availability.
