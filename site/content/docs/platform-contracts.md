# Platform contracts

PocketJS keeps application intent separate from host facts. An app writes
`pocket.json`; PocketJS owns a profile for each stock target. The resolver
combines them once, writes a small target-specific `ResolvedBuildPlan`, and all
later build stages consume that answer.

```text
  pocket.json           target profile
  (app intent)          (host facts)
       └──────── resolve ────────┘
                    │
                    ▼
       .pocket/<target>/plan.json
          small ResolvedBuildPlan
             ┌──────┴──────┐
             ▼             ▼
        JS compiler    native backend
```

This is a build-contract boundary, not a general-purpose platform type system.
It prevents platform decisions from being rediscovered in the compiler,
Cargo, packagers, and custom hosts.

## Ownership

| Data                 | Owner                     | Meaning                                                           |
| -------------------- | ------------------------- | ----------------------------------------------------------------- |
| `pocket.json`        | App                       | Entry, framework, logical viewport, required and optional APIs    |
| Capability registry  | PocketJS                  | Names of framework APIs that can be requested                     |
| Target profile       | Stock host                | Host ABI, display facts, and APIs implemented and tested          |
| `ResolvedBuildPlan`  | Resolver                  | One build's target-specific inputs                                |
| Backend              | PocketJS or custom host   | How those inputs become an EBOOT, VPK, or another package         |

## Application manifest

Format 2 is strict JSON data. A PSP-shaped portable app can say:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-2.json",
  "pocket": 2,
  "id": "dev.pocket-stack.telemetry",
  "name": "pocket-telemetry",
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
crate path, or host ABI. Those are framework-owned facts.

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
`fixed`. `resolveViewport` in `framework/src/manifest/resolve.ts` then picks
one variant:

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
instead of an app-name convention: `hosts/desktop` calls
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

`POCKET_TARGETS` in `contracts/spec/platforms.ts` registers the stock targets —
an inventory of hosts whose profile is golden-tested, not a row for every
directory in `hosts/`:

| Target         | hostAbi | platform / form   | Logical viewport                         | Density | Capabilities |
| -------------- | ------- | ----------------- | ---------------------------------------- | ------- | ------------ |
| `psp`          | 1       | psp / takeover    | 480×272 (`native`, `integer-fit`)        | 1       | `input.analog.left`, `input.buttons`, `input.cursor`, `audio.pcm`, `text.glyphs.baked` |
| `vita`         | 2       | vita / takeover   | 480×272 (`integer-fit`)                  | 2       | `input.analog.left`, `input.buttons`, `input.cursor`, `input.touch`, `text.glyphs.baked` |
| `pocketbook`   | 5       | pocketbook / takeover | 480×272 (`integer-fit`)              | 2       | `input.buttons`, `input.touch`, `text.glyphs.baked` |
| `macos-widget` | 3       | macos / widget    | 420×560 default, 240×180…4096×4096       | 2       | `input.buttons`, `input.ime`, `input.pointer`, `input.text`, `host.clipboard`, `display.viewport.live`, `text.glyphs.baked`, `text.glyphs.runtime` |
| `macos-app`    | 4       | macos / window    | 720×480 default, 240×180…4096×4096, accepts fixed | 2 | `input.buttons`, `display.viewport.live`, `text.glyphs.baked`, `text.layout.native`; systemUI role adds `ui.compositor-surfaces` |
| `linux-app`    | 4       | linux / window    | 800×600 default, 240×180…4096×4096, accepts fixed | 1 | same as `macos-app` |
| `web-app`      | 4       | web / window      | 800×600 default, 320×240…4096×4096, accepts fixed | 1 | `input.buttons`, `display.viewport.live`, `text.glyphs.baked`; systemUI role adds `ui.compositor-surfaces` |

`roleCapabilities.systemUI` is the one conditional column: those APIs reach a
package only when it resolves in the System-UI role. `ui.compositor-surfaces`
is the API a shell uses to place other installed packages into native
compositor surfaces, so an ordinary application requiring it against the same
target fails resolution.

Read those facts from the registry rather than from a copy of this table: a
target id is a label, and `platform`, `form`, and the display facts are the
queryable fields no tooling may reconstruct by parsing an id. One profile is a
small record:

```ts
pocketbook: {
  hostAbi: 5,
  platform: "pocketbook",
  form: "takeover",
  display: {
    physicalViewport: [960, 544],
    logicalViewports: [[480, 272]],
    presentations: ["integer-fit"],
    rasterDensity: 2,
  },
  capabilities: ["input.buttons", "input.touch", "text.glyphs.baked"],
}
```

An ESP-IDF library cannot enumerate every product board. Its firmware project
therefore supplies a schema-validated `pocket.host.json` containing the same
display and capability fields plus the exact tick rate. The resolver treats
that single record as the selected target and embeds its canonical SHA-256 in
the build plan. **The device rejects a package when the compiled host contract
and package profile hash differ.** See [ESP-IDF](/docs/esp-idf/#host-profile).

DrawList is absent from the registry. It is PocketJS's internal core-to-backend
IR, not behavior an application can observe or request. GE, GXM, WGPU, and
software raster hosts may consume that IR while offering the same public UI
semantics.

`rasterDensity` is also not a capability. It is a target-owned rendering fact:
layout and DrawList coordinates remain logical, while font coverage, SVGs,
core masks, and target-selected image variants use that many raster samples per
logical pixel. Dynamic texture producers receive the same resolved value as
`platform.pixelRatio`; neither compiler nor application needs a Vita branch.

### Transitional dev targets

`hosts/` holds more host directories than the registry holds targets. A host
still working toward its acceptance receipt keeps its profile in its own module
under `tools/`, builds through its own command, and stays out of
`POCKET_TARGETS`:

| Target id                | Command                      | What holds it out |
| ------------------------ | ---------------------------- | ----------------- |
| `3ds-dev`                | `bun run 3ds`                | the host suite leaves the cursor, sprite, streamed-texture and large-atlas paths uncovered |
| `ios-dev`                | `bun run ios`                | the Apple host has no device acceptance suite yet |
| `iphone2g-dev`           | `bun run iphone2g`           | the iPhone OS 3.1.3 host has not passed the hardware suite |
| `iphone4s-dev`           | `bun run iphone4s`           | a private exact-device profile (iOS 6.1.3) |
| `ipodtouch-dev`          | `bun run ipodtouch`          | no repeatable build, deploy, launch, frame and touch receipt yet |
| `ipodtouch4-dev`         | `bun run ipodtouch4`         | a private exact-device profile (iOS 6.1.6; the 4S display tuple and ABI) |
| `symbian-e7-dev`         | `bun run symbian`            | the E7 host has not passed the hardware acceptance suite |
| `meizu-m8-dev`           | `bun run meizu-m8`           | the Windows CE 6 acceptance receipt has not passed |
| `blackberry-qnx-dev`     | `bun run blackberry-qnx`     | a private exact-device profile (Classic SQC100, Core Native) |
| `blackberry-android-dev` | `bun run blackberry-android` | the same Classic profile through the BlackBerry 10 Android Runtime |

Each module builds its own `definePlatformContractRegistry` and passes it to
`validateAndResolveBuildPlan`, so the resolver, compiler, and plan format are
the same as for a stock target. **Nothing generic may assume these ids exist**:
code that walks targets walks `POCKET_TARGETS`.

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

## The small build plan

The generated plan is cross-process build IR, not public app configuration.
This is what the manifest above resolves to for `vita`:

```json
{
  "app": {
    "id": "dev.pocket-stack.telemetry",
    "title": "Pocket Telemetry",
    "version": "1.0.0",
    "entry": "app/main.tsx",
    "output": "main",
    "framework": "solid"
  },
  "target": { "id": "vita", "hostAbi": 2 },
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

Serialization matters because PocketJS crosses Bun, the JS compiler, Cargo,
stock native crates, and downstream custom hosts. `.pocket/<target>/plan.json`
gives each stage the same debuggable input.

`planHash` is only a checksum of this generated build IR. It detects an edited
or partially copied plan and can support build caching. It is not a runtime
compatibility hash, a signature, an attestation, or a trust chain. Application
identity and title are present because package backends consume them; icons,
toolchain provenance, and other fields without a real consumer do not belong
in the plan merely to make its hash look comprehensive. The Vita backend
derives a nine-character title id from the portable reverse-DNS app id instead
of keeping a per-demo target table.

## Consumers and backend dispatch

`bun pocket build` reads the plan and indexes one table of native backends:

```ts
// tools/pocket.ts
const targetBackends = {
  psp: async ({ planPath, projectRoot, outdir, args }) => { /* tools/psp.ts */ },
  vita: async ({ planPath, projectRoot, outdir, args }) => { /* tools/vita.ts */ },
  pocketbook: async ({ outdir }) => { /* bundle only; the host ELF is cross-compiled */ },
};

await targetBackends[target as PocketTargetId](context);
```

**That table holds three of the seven registered targets.** The desktop targets
build through their own tools instead — `macos-app` through `tools/macos.ts`,
`macos-widget` through `tools/note.ts` and `tools/widget.ts` — and `linux-app`
and `web-app` have no `pocket build` path today: the plan resolves and then the
index throws a TypeError on an undefined backend. The table carries a
`satisfies Record<PocketTargetId, TargetBackend>` annotation it does not meet,
and `tools/` sits outside the `tsconfig.json` include list, so no typecheck
reports the gap.

After dispatch, a backend reads resolved fields; it does not recalculate
physical dimensions or output names from the target id. The serialized plan
keeps its cross-process target id as a string rather than pretending arbitrary
custom-host plans share the stock target union.

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

This verifies the plan checksum, exposes only host build inputs, and produces
the shared Cargo environment without downstream code duplicating Plan parsing.

## Runtime and TypeScript checks

At startup, `assertNativeHostContract` compares the baked tick rate against the
rate the host declares in `ui.__tickHz`, then the native target id, then the
HostOps ABI. **The tick-rate check runs for every native mount, plan or no
plan**: a bundle without an explicit `--hz` bakes 60, and a host that declares
no `__tickHz` is read as 60, so a mismatch means the bundle's virtual time and
the host's frame loop disagree. The target and ABI checks run only for a bundle
that embedded a build contract. Stock builds embed the JS and native host
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
