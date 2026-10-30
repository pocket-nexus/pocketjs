# App contract

**`pocket.app.json` is the app contract, the one file that describes an
application.** It names the entry module, the framework, the viewport the
layout is written for, the APIs the application calls and the rate it is
compiled at. The format is **2**, the schema is `contracts/schema/pocket-2.json`
(published at `https://pocketjs.dev/schema/pocket-2.json`), and **the schema
rejects any property it does not list**. The resolver combines the app
contract with a host contract into a build plan at `.pocket/<target>/plan.json`;
see [Platform contracts](/docs/platform-contracts/) for the host side and
[CLI](/docs/cli/) for the commands.

`pocket create <name>` writes an app contract with `id`, `title`, `version`,
`engine.capabilities.requires`, `app.entry`, `app.output`, `app.framework` and
`app.viewport`. `pocket check --manifest pocket.app.json --target <id>` validates
one by hand.

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-2.json",
  "pocket": 2,
  "id": "dev.example.notes",
  "title": "Notes",
  "version": "1.2.0",
  "author": "Example Studio",
  "icon": "./icon.png",
  "engine": {
    "capabilities": {
      "requires": ["text.glyphs.baked", "input.buttons"],
      "enhances": ["input.touch", "input.analog.left"]
    }
  },
  "app": {
    "entry": "src/main.tsx",
    "output": "notes-main",
    "framework": "solid",
    "tickHz": 60,
    "theme": "./theme.ts",
    "viewport": {
      "fixed": { "logical": [[480, 272], [320, 240]], "presentation": "integer-fit" },
      "dynamic": { "default": [720, 480] }
    }
  }
}
```

The app contract carries no physical resolution, raster density, refresh rate,
binding generation or native crate path. **Those facts belong to the host
program's host contract**, and the resolver refuses an app contract that the
selected host contract cannot satisfy.

## Top-level fields

| Field | Required | Value |
| --- | --- | --- |
| `$schema` | yes | `https://pocketjs.dev/schema/pocket-2.json` |
| `pocket` | yes | `2` |
| `id` | yes | Reverse-domain name, lowercase, at least two dot-separated labels: `dev.example.notes`. The package identity; the Vita backend derives the installed Title ID from it. |
| `title` | yes | Display name, 1 to 128 characters. Written into the plan and the package identity. |
| `version` | yes | Semantic version string. |
| `author` | no | Who publishes the application, 1 to 128 characters. `pocket pack` records it when `--author` is absent. |
| `icon` | no | Path to a square PNG, relative to the app contract, inside the project. `pocket compile` stores it as each variant's cover section; `pocket pack` uses it when `--icon` is absent. The loader checks the PNG signature and that width equals height. |
| `engine` | yes | The capability declaration, below. |
| `app` | yes | The application section, below. |
| `domains` | no | Execution domains beside the UI realm; today `worker`. |
| `applet` | no | Declares a Pocket Applet, below. |

## engine.capabilities

```json
"engine": {
  "capabilities": {
    "requires": ["text.glyphs.baked", "input.buttons"],
    "enhances": ["input.touch"]
  }
}
```

**`requires` is the compatibility floor.** Resolution fails with
`capability.unavailable` when the selected host contract does not provide one
of its ids, and the device refuses a package whose required ids are not all in
its capability list. `requires` has at least one entry.

**`enhances` declares an optional API the application has a fallback for.**
Its availability on the selected target becomes a boolean in
`plan.features` and in the compiled bundle, where `hasFeature("input.touch")`
is specialized at compile time. An id in both lists is an error
(`capability.duplicate`); an id outside the registry is an error
(`capability.unknown`).

A worker declaration adds `runtime.worker` and the capability of every node
kind it owns to `requires`. A presentation may add its own `requires` and
`enhances`; a presentation `requires` entry promotes an application-level
`enhances` entry.

Some ids depend on others:

| Declaration | Needs |
| --- | --- |
| `text.glyphs.streamed`, `text.layout.offload` | `io.offload` in the same list or in `requires` |
| `input.touch.auxiliary` | `display.auxiliary`; a required `input.touch.auxiliary` needs a required `display.auxiliary` |
| `display.auxiliary` | `app.surfaces.auxiliary`, and the reverse: the two are declared together |
| `runtime.worker` | `domains.worker` |

### Capability ids

The registry is `POCKET_CAPABILITIES` in `contracts/spec/platform-types.ts`.
An id names behavior the application can observe; hosts with the same
observable behavior share an id, and a different guarantee gets a new id.

| Id | Meaning |
| --- | --- |
| `input.buttons` | A d-pad and face buttons. |
| `input.analog.left`, `input.analog.right` | Analog sticks the host reports. |
| `input.cursor` | A pointer the framework synthesizes from the analog nub: hover applies `focus:`, the press button applies `active:` and clicks on release. Opt-in per app with `enableCursor`. |
| `input.pointer` | A real absolute pointer (mouse or trackpad) with press, drag and release edges. |
| `input.touch` | Touch contacts on the primary viewport. |
| `input.touch.auxiliary` | Touch contacts reported in the auxiliary surface's logical pixels. Does not imply `input.touch`. |
| `input.text` | A hardware text stream: characters plus named editing keys with key repeat. |
| `input.ime` | OS text composition: inline preedit, commits as text insertions, a candidate window docked at the caret. |
| `text.glyphs.baked` | The glyph atlases the package bakes. |
| `text.glyphs.runtime` | Codepoints outside the baked charset still render; the host extends the atlases at run time. Required by an app that accepts arbitrary text input. |
| `text.glyphs.streamed` | A bounded external glyph cache fed through `io.offload` (ops 47 to 50). |
| `text.layout.native` | Measurement and shaping come from the host text system with full Unicode coverage; pixels are deterministic per host, not byte-exact across hosts. |
| `text.layout.offload` | Layout from an asynchronous worker or paired companion service; availability is session scoped. |
| `io.offload` | The host's offload channel to a worker or a paired companion; `text.glyphs.streamed` and `text.layout.offload` run on it. |
| `runtime.worker` | A second QuickJS runtime for `domains.worker`. |
| `io.i2c`, `io.uart` | Worker node kinds. |
| `net.http` | HTTP as a worker resource (`io.http`), under the limits of `contracts/spec/net.ts`. No UI realm has a network namespace. |
| `display.viewport.live` | The logical viewport changes at run time; the app relayouts through `resizeViewport`. Console targets never provide it. |
| `display.auxiliary` | One fixed-size auxiliary UI output presented beside the primary viewport by the same instance. |
| `ui.physics` | 2D bodies stepped by the UI core: worlds, jelly bodies, colliders, zones and particle emitters (`contracts/spec/physics.ts`). |
| `ui.compositor-surfaces` | A System UI can place installed applications into native compositor surfaces. |
| `audio.pcm` | Credit-based s16 PCM streaming through `globalThis.audio`. |
| `media.playback` | Native encoded-media playback with audio clock, pause, volume and texture output. |
| `data.fs` | A per-app file tree behind `globalThis.fs`; paths are confined to the app's own root. |
| `host.clipboard` | Copy, cut and paste with the OS clipboard. |
| `camera.qr` | Outer-camera preview texture and an on-device QR decoder. |
| `camera.photo` | Stills kept as JPEG under the storage's DCIM folder: list, decode, delete. |
| `link.companion` | The console's link to a paired companion computer: pairing, status, catalog, installs. |
| `system.wifi` | The console's radio and saved connections; reads and selects, never writes. |
| `system.agent` | The system mascot on the top screen and the agent channel to the companion. |

## app

| Field | Required | Value |
| --- | --- | --- |
| `entry` | yes | The entry module, `.ts` or `.tsx`, relative to the project root (the app contract's directory unless `--project-root` says otherwise). No leading slash, no `..` segment. |
| `output` | no | The artifact name: lowercase, digits and single hyphens, at most 64 characters. Absent, the entry's basename without its extension; `src/Main.tsx` then fails with `app.outputUnderivable`, so set `output`. |
| `framework` | yes | `solid`, `vue-vapor` or `octane`. See [Frameworks](/docs/frameworks/). |
| `tickHz` | no | Core ticks per virtual second the package is compiled at, **1 through 60, default 60**. Resolution fails with `app.tickHz` when no cadence of the target divides it. A host presents at the largest cadence the rate is a multiple of and advances the core `tickHz ÷ cadence` ticks per frame. |
| `theme` | no | Path to a `.ts` module or `.json` file whose default export holds the animation theme, below. |
| `aot` | no | `true` admits the Solid component graph to the AOT view subset; `pocket compile --aot` requires it. See [MicroTS](/docs/microts/). |
| `model` | no | `rust` (default) or `compiled`: with `aot`, compile the `.ts` model beside the entry. |
| `recursionLimit` | no | Default 256. Development AOT builds enforce it; release builds omit the guard. |
| `viewport` | yes | The primary viewport, below. |
| `surfaces` | no | An auxiliary surface, below. |
| `companions` | no | Companion service names, below. |
| `presentations` | no | Alternative entries per device modality, below. |
| `modality` | no | The modality the baseline entry serves, below. |

### app.viewport

An application declares viewport intent per policy, not per target. `fixed`
serves fixed-screen forms (`takeover`, `kiosk`, `embedded`); `dynamic` serves
window forms (`window`, `widget`). Declaring both makes one app contract run
on both kinds of target.

```json
"viewport": {
  "fixed": { "logical": [[320, 480], [360, 800]], "presentation": "integer-fit" },
  "dynamic": { "default": [720, 480] }
}
```

The bare form `{ "logical": [480, 272], "presentation": "integer-fit" }` is
the same as `fixed` alone.

**`fixed.logical` is one size, a list of sizes in preference order, or a
`{ "min", "max" }` range.** The resolver takes the first listed size the
target's `logicalViewports` contains; for a range it takes the first target
size inside the range. The plan records one size, and the layout is written
for that size.

`fixed.presentation` names how the panel shows the logical viewport. The
target lists the modes it presents; the resolver checks two of them:

| Mode | Rule |
| --- | --- |
| `native` | One logical pixel is `rasterDensity` physical pixels and the logical viewport fills the panel, in either orientation of the panel. |
| `integer-fit` | The panel is one positive integer multiple of the logical viewport, the same multiple on both axes. |
| `fill`, `fit`, `stretch` | Accepted when the target lists them; the program owns the scaling. |

`dynamic.default` is the size a plan bakes assets for and must fall inside
the target's dynamic range. `dynamic.min` and `dynamic.max` are schema-valid
and unread: **the admitted range belongs to the target.**

What resolves on which target:

| Target form | `fixed` only | `dynamic` only | both |
| --- | --- | --- | --- |
| fixed screen | the matching size | `viewport.fixedRequired` | the fixed variant |
| window or widget with `acceptsFixed` | size-locked window at the matching size, presented `native` | `dynamic.default` | the dynamic variant |
| window or widget without `acceptsFixed` | `viewport.fixedUnhosted` | `dynamic.default` | the dynamic variant |

The plan records the winner as `viewport.policy`. An application that must
relayout on resize declares `display.viewport.live`.

### app.surfaces.auxiliary

A second UI output the same instance presents beside the primary viewport,
on targets that advertise `display.auxiliary`. Exactly one of `fixed` and
`adaptive`:

```json
"surfaces": {
  "auxiliary": { "fixed": { "logical": [320, 240], "presentation": "native" } }
}
```

```json
"surfaces": {
  "auxiliary": { "adaptive": { "min": [320, 240], "max": [480, 640] } }
}
```

`fixed` requires the target's auxiliary size and presentation, with the same
`native` and `integer-fit` rules as the primary viewport. `adaptive` takes the
target's auxiliary size when it lies in the range, at native presentation,
and the application reads the size with `auxiliaryViewport()`. The auxiliary
surface's raster density equals the primary display's. Declare
`display.auxiliary` in `requires` or `enhances` together with this field;
with `enhances`, a target without the surface drops the feature instead of
failing resolution.

### app.presentations and app.modality

A presentation is an alternative entry module addressed to a device
modality. **The resolver tests them in declaration order against the target's
modality and compiles the first match**; none matching means `app.entry` with
the application-level viewport, surfaces and capabilities.

```json
"presentations": [
  {
    "id": "touch",
    "entry": "src/touch.tsx",
    "modality": { "touch": "primary", "minScreen": [320, 240] },
    "viewport": { "logical": [320, 480], "presentation": "native" },
    "capabilities": { "requires": ["input.touch"] }
  }
],
"modality": { "buttons": true }
```

| Presentation field | Value |
| --- | --- |
| `id` | Unique within the app contract; the plan records it. |
| `entry`, `output` | As for `app.entry` and `app.output`. |
| `modality` | The requirement, below. |
| `viewport`, `surfaces` | Replace the application-level declarations for this presentation. |
| `capabilities` | `requires` and `enhances` added to `engine.capabilities`. |

A modality requirement lists what the device must have. Every field is
optional and an absent field matches every device:

| Field | Values |
| --- | --- |
| `screens` | Exact screen count, 1 or 2. |
| `touch` | `none`, `primary`, `auxiliary` or `any`. |
| `pointer` | `none`, `cursor` (the synthesized nub pointer), `pointer` (a real one) or `any`. |
| `buttons` | `true` or `false`. |
| `analog` | Minimum number of analog sticks, 0 to 2. |
| `text` | `osk` or `keyboard`. |
| `orientation` | `landscape`, `portrait` or `square`, of the primary screen. |
| `minScreen`, `maxScreen` | Inclusive bounds on the primary screen's logical size, both axes. |
| `form` | A list of target forms. |

`app.modality` is the requirement the baseline entry serves. A target that
matches no presentation and misses it is refused with `modality.unsupported`:
a touch-only application states `{ "touch": "primary" }` and never compiles
for a button-only device. Absent, the baseline serves every device.

### app.theme

`theme` names a `.ts` module or a `.json` file, relative to the app contract,
whose default export is the animation theme: `keyframes` and `animation` in
the Tailwind shape, applied with `animate-<name>` classes.

```json
{
  "keyframes": {
    "caret": { "0%,49.99%": { "opacity": 1 }, "50%,100%": { "opacity": 0 } }
  },
  "animation": {
    "caret": "caret 1s linear infinite",
    "menu-pill": { "value": "menu-open 0.6s ease-in-out 0.2s both", "loop": "4000ms" }
  }
}
```

**`pocket compile` loads the module before resolution, embeds the loaded
object in the package's copy of the app contract, and bakes every referenced
animation at `app.tickHz`.** The authored app contract carries the path only;
a theme object written inline is a schema error. See [Animation](/docs/animation/).

### app.companions

The exact service names the application passes to `svcOpen`. The resolver
copies the list into `plan.companions`, and a host builds its svc allowlist
from that copy; `svcOpen` denies every other name. **A host with no adapter
for the listed services refuses the plan.** Absent, the application runs
standalone everywhere and `svcOpen` answers false.

## domains.worker

A worker runs its entry in a second QuickJS runtime owned by the host, with
the resources its nodes name. See `docs/WORKER.md` for the runtime model.

```json
"domains": {
  "worker": {
    "entry": "src/worker.ts",
    "nodes": [{ "name": "i2c0", "kind": "i2c" }, { "name": "http", "kind": "http" }],
    "channels": [
      { "name": "rtc", "kind": "snapshot", "direction": "worker-to-ui", "recordBytes": 7, "capacity": 1 },
      { "name": "request", "kind": "ring", "direction": "ui-to-worker", "recordBytes": 1024, "capacity": 4 }
    ]
  }
}
```

| Field | Value |
| --- | --- |
| `entry` | A `.ts` module relative to the project root. |
| `nodes[].name` | Unique within the worker, 1 to 63 characters, starting with a letter. |
| `nodes[].kind` | `i2c`, `uart` or `http`. Each kind requires its capability: `io.i2c`, `io.uart`, `net.http`. |
| `channels[].kind` | `snapshot` retains the newest record; `ring` queues records and rejects a publish when full. |
| `channels[].direction` | `ui-to-worker` or `worker-to-ui`. |
| `channels[].recordBytes` | 1 to 1024. |
| `channels[].capacity` | 1 to 8 records. |

**A worker declaration adds `runtime.worker` and each node kind's capability
to `requires`.** A worker owns at most 8 nodes and 8 channels; the target's
host contract bounds the count of each node kind, and resolution fails with
`worker.nodeLimit` above it. A worker and `app.aot` do not combine
(`worker.execution`). Channel ids follow app contract order.

## applet

A Pocket Applet is an application a launcher runs on behalf of the system.
The section opts the package into the applet rules of `contracts/spec/applet.ts`,
checked at resolution and at build; `docs/APPLETS.md` lists them.

```json
"applet": {
  "version": 1,
  "summary": "Read and post on X.",
  "services": ["x", "glyphs"],
  "store": { "maxBytes": 65536 }
}
```

| Field | Value |
| --- | --- |
| `version` | `1`. |
| `summary` | One sentence, at most 120 characters, shown where the applet is offered. |
| `services` | Companion services the worker fetches at `https://companion.pocket/<name>/…` through `io.http`; at most 8; needs `net.http`. |
| `store` | Persistent state; required for `data.fs`; `maxBytes` at most 4 MiB. |

## Checking an app contract

```sh
pocket check --manifest pocket.app.json --target psp
pocket check --manifest pocket.app.json --target ./vendor/pocket.host.json
```

`check` validates the file against the schema, loads the theme, resolves the
plan against the target and type-checks the application modules. Resolution
reports every diagnostic with a JSON pointer into the app contract:

| Code | Cause |
| --- | --- |
| `capability.unknown` | An id outside the registry. |
| `capability.unavailable` | A required id the target does not provide. |
| `capability.duplicate` | An id declared twice. |
| `capability.dependency`, `capability.offloadDependency` | A dependency from the table above is missing. |
| `viewport.fixedRequired`, `viewport.dynamicRequired` | The target's form needs the other policy. |
| `viewport.fixedUnhosted` | A fixed-only app on a window target without `acceptsFixed`. |
| `viewport.logicalUnsupported` | No declared size is one the target lists, or `dynamic.default` is outside its range. |
| `viewport.presentationUnsupported` | The target does not present the mode. |
| `viewport.nativeMismatch`, `viewport.integerFitMismatch` | The mode's rule fails on the target's panel. |
| `surface.auxiliaryDeclarationMismatch`, `surface.auxiliaryPolicy` | `surfaces.auxiliary` and `display.auxiliary` disagree, or both or neither of `fixed` and `adaptive` are set. |
| `presentation.duplicateId`, `modality.unsupported` | Presentation ids repeat, or the target serves no presentation and misses `app.modality`. |
| `app.outputUnderivable` | The entry's basename is not a valid artifact name. |
| `app.themeUnresolved` | The theme path was not loaded before resolution; use `readPocketManifest`. |
| `app.tickHz` | No target cadence divides the rate. |
| `execution.aotDisabled` | `--aot` without `app.aot`. |
| `worker.entry`, `worker.execution`, `worker.duplicate`, `worker.nodeLimit`, `worker.channelLimit` | Worker rules above. |
| `target.unknown` | `--target` names no built-in host id and no host contract. |
