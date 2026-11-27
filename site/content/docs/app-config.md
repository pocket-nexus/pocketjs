# Application config

**An application is the `app` section of its `pocket.host.config.ts`.** The
same file names the host contracts the application is built for and, for a
program, the native build recipe. The section states the entry module, the
framework, the viewport the layout is written for, the host capabilities the
build turns on and the rate it is compiled at. The resolver combines it with
one host contract into a build plan at `.pocket/<target>/plan.json`; see
[Platform contracts](/docs/platform-contracts/) for the host side and
[CLI](/docs/cli/) for the commands.

```ts
// apps/hero/pocket.host.config.ts
import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["psp", "psp-runtime", "vita", "web-app", "macos-widget", "macos-embedded", "pocketbook", "symbian-e7-dev"],
  app: {
    id: "dev.pocket-nexus.hero",
    title: "PocketJS: Hero",
    version: "0.15.0",
    entry: "main.tsx",
    output: "hero-main",
    framework: "solid",
    viewport: {
      fixed: { logical: [480, 272], presentation: "integer-fit" },
      dynamic: { default: [640, 360], min: [360, 360], max: [640, 640] },
    },
    features: ["text.glyphs.baked", "input.buttons", "display.viewport.live"],
    aot: true,
    model: "compiled",
  },
});
```

The section carries no physical resolution, raster density, refresh rate,
binding generation or native crate path. **Those facts belong to the host
contract**, and the resolver refuses an application the selected host
contract cannot present. An installable-application manifest, with its
launcher and installation rules, belongs to
[pocket-shell](https://github.com/pocket-nexus/pocket-shell); this repository
builds one application per program.

## defineHostConfig

```ts
defineHostConfig({ host | hosts, app?, build? })
```

`defineHostConfig` from `@pocketjs/framework/host-config` returns its argument
after checking it, and the config module exports the result as its default.
The config is a module: it imports the theme and any value it shares with
other files.

| Field | Value |
| --- | --- |
| `host` / `hosts` | Exactly one of the two. Each entry is the path of a `pocket.host.json`, relative to the config file, or the id of a built-in host contract (`hosts/<id>/pocket.host.json`). Entries are unique, and so are the ids of the contracts they name. |
| `app` | The application this config builds, below. |
| `build` | A program's native recipe ([Platform contracts](/docs/platform-contracts/)). |

The built-in host ids are `psp`, `psp-runtime`, `3ds-runtime`, `vita`,
`web-app`, `macos-widget`, `macos-embedded`, `gba`, `ipodnano`, `pocketbook`,
`symbian-e7-dev`, `ios-dev`, `ipodtouch-dev` and `ipodtouch4-dev`, so an
application outside a PocketJS checkout writes `host: "psp"`. **An
application is built for the hosts its config lists**: `pocket compile
--target <id>` refuses a host the config does not list, and a config that
lists one host needs no `--target`.

`defineHostConfig` throws a `TypeError` when `app` breaks its schema; the
message lists each broken rule with its JSON Pointer under `/app`
(`/app/viewport/fixed/logical: value does not match any allowed schema`).

## app

| Field | Required | Value |
| --- | --- | --- |
| `entry` | yes | The mounted module, `.ts` or `.tsx`, **relative to the config file**. No leading slash, no `..` segment, no backslash. |
| `framework` | yes | `solid`, `vue-vapor` or `octane`. See [Frameworks](/docs/frameworks/). |
| `viewport` | yes | The primary viewport, below. |
| `output` | no | The artifact name: lowercase letters, digits and single hyphens, at most 64 characters, starting with a letter. Absent, the entry's file name without its extension; `src/Main.tsx` then fails with `app.outputUnderivable`, so set `output`. |
| `id` | no | Reverse-domain name, lowercase, at least two dot-separated labels. The device packagers stamp it: the PSP title, the Vita title id (`vitaTitleId`), the bundle id, the SMDH. **Absent, `local.<output>`.** |
| `title` | no | Display name, 1 to 128 characters. **Absent, the output name.** |
| `version` | no | `major.minor.patch` with an optional pre-release and build suffix. **Absent, `0.1.0`.** |
| `author` | no | Who publishes the application, 1 to 128 characters. `pocket pack` run from the application's directory records it when `--author` is absent. |
| `icon` | no | A square PNG, relative to the config file, without a `..` segment. `pocket compile` checks the PNG signature and that width equals height, and stores the file as the bundle's icon section. |
| `features` | no | Host capabilities this build turns on, below. Unique registered ids. |
| `surfaces` | no | An auxiliary surface, below. |
| `theme` | no | Animation content, below. |
| `fonts` | no | The faces the glyph atlases are baked from, below. |
| `aot` | no | `true` admits the Solid component graph to the AOT view subset; `pocket compile --aot` requires it. See [MicroTS](/docs/microts/). |
| `model` | no | `rust` (default) or `compiled`: with `aot`, compile the `.ts` model beside the entry. `compiled` without `aot` is refused. |
| `recursionLimit` | no | Positive integer, default 256. Development AOT builds enforce it; release builds omit the guard. |
| `tickHz` | no | Core ticks per virtual second the application is compiled at, **1 through 60, default 60**. |
| `worker` | no | A second QuickJS runtime beside the UI realm, below. |
| `companions` | no | Companion service names, below. |

The section is JSON data: the resolver copies it with `JSON.stringify`, so a
function or `undefined` in it is dropped.

### app.features

**`features` is compile-time selection.** Each id is in the capability
registry or in the selected host contract's `capabilities`
(`capability.unknown` otherwise). For the selected host, the plan
records `features[id]`: **`true` when the host contract provides the
capability and `false` when it does not**. The compiled bundle reads the table
(`__POCKET_FEATURES__`), and `hasFeature("input.touch")` is specialized at
compile time. A host that lacks a listed capability does not refuse the application; the
application is built for the hosts its config lists, and each of them gets the
table its contract implies.

A feature has native cost on some hosts. On the PSP the offload service and
the DevTools mailbox share the USB transport, and the frame loop
(`programs/psp/src/frame.rs`) starts DevTools only when offload is off; an
application that does not list `io.offload` keeps DevTools on that program.

Some ids depend on others:

| Feature | Needs |
| --- | --- |
| `text.glyphs.streamed`, `text.layout.offload` | `io.offload` in `features` (`capability.offloadDependency`) |
| `input.touch.auxiliary` | `display.auxiliary` in `features` (`capability.dependency`) |
| `input.scroll` | `input.pointer` in `features` (`capability.dependency`) |
| `display.auxiliary` | `surfaces.auxiliary`, and the reverse: the two are stated together (`surface.auxiliaryDeclarationMismatch`) |
| `runtime.worker` | `worker` (`worker.entry`) |

A `worker` adds `runtime.worker` and the capability of each node kind it owns
to the plan's table as `true`; the selected host must provide them
(`capability.unavailable` at `/app/worker` otherwise).

### Capability ids

**A capability id is defined by PocketJS or by a host.** The registry,
`POCKET_CAPABILITIES` in `contracts/spec/capabilities.ts`, lists the ids
PocketJS defines: a host contract in `hosts/` provides the id, or the
compiler, framework or engine of this repository acts on it. An id names
behavior the application can observe; hosts with the same observable behavior
share an id, and a different guarantee gets a new id.

| Id | Meaning |
| --- | --- |
| `input.buttons` | A d-pad and face buttons. |
| `input.analog.left`, `input.analog.right` | Analog sticks the host reports. |
| `input.cursor` | A pointer the framework synthesizes from the analog nub: hover applies `focus:`, the press button applies `active:` and clicks on release. Opt-in per app with `enableCursor`. |
| `input.pointer` | A real absolute pointer (mouse or trackpad) with press, drag and release edges. `pointer()` reads its position with no button down as well. |
| `input.scroll` | Wheel and trackpad scrolling at the pointer reaches `onScroll`, in logical pixels of the pointer's surface. Without it `onScroll` keeps no handler. Requires `input.pointer`. |
| `input.touch` | Touch contacts on the primary viewport. |
| `input.touch.auxiliary` | Touch contacts reported in the auxiliary surface's logical pixels. Does not imply `input.touch`. |
| `input.text` | A hardware text stream: characters plus named editing keys with key repeat. |
| `input.ime` | OS text composition: inline preedit, commits as text insertions, a candidate window docked at the caret. |
| `text.glyphs.baked` | The glyph atlases the bundle bakes. |
| `text.glyphs.runtime` | Codepoints outside the baked charset still render; the host extends the atlases at run time. Needed by an app that accepts arbitrary text input. |
| `text.glyphs.streamed` | A bounded external glyph cache fed through `io.offload` (ops 47 to 50). |
| `text.layout.native` | Measurement and shaping come from the host text system with full Unicode coverage; pixels are deterministic per host, not byte-exact across hosts. |
| `text.layout.offload` | Layout from an asynchronous worker or paired companion service; availability is session scoped. |
| `io.offload` | The host's offload channel to a worker or a paired companion; `text.glyphs.streamed` and `text.layout.offload` run on it. |
| `runtime.worker` | A second QuickJS runtime for `app.worker`. |
| `io.i2c`, `io.uart` | Worker node kinds. |
| `net.http` | HTTP as a worker resource (`io.http`), under the limits of `contracts/spec/net.ts`. No UI realm has a network namespace. |
| `display.viewport.live` | The logical viewport changes at run time. The host calls `resizeViewport`, which resizes the root layers; app code reads the size with `useViewport` (Solid) or `onViewport`. Console targets never provide it. |
| `display.auxiliary` | One fixed-size auxiliary UI output presented beside the primary viewport by the same instance. |
| `ui.physics` | 2D bodies stepped by the UI core: worlds, jelly bodies, colliders, zones and particle emitters (`contracts/spec/physics.ts`). |
| `audio.pcm` | Credit-based s16 PCM streaming through `globalThis.audio`. |
| `audio.capture` | Microphone input on the same namespace (`openInput`, `readInput`, `closeInput`): the host records an input into a ring the guest drains each tick. |
| `net.mqtt` | MQTT 3.1.1 and 5.0 sessions as a worker resource (`io.mqtt`), under the limits of `contracts/spec/mqtt.ts`. |
| `data.fs` | A per-app file tree behind `globalThis.fs`; paths are confined to the app's own root. |
| `data.pack` | Read-only files under the game data root behind `globalThis.pack`: chapter textures and streamed PCM kept outside the program image (`docs/PACKS.md`). |
| `host.clipboard` | Copy, cut and paste with the OS clipboard. |

**A host contract may list ids the registry does not know; the host defines
them.** An application resolved against that host lists them in `features`
like registered ids: the plan records `true` for an id in the host's
`capabilities`. Against a host that does not list the id, the entry is
`capability.unknown`. PocketJS attaches no meaning to a host-defined id;
[Host-defined capabilities](/docs/platform-contracts/#host-defined-capabilities)
states the rules. The hosts of [pocket-shell](https://github.com/pocket-nexus/pocket-shell)
define their camera, companion link, media playback, Wi-Fi, board control and
system agent ids this way.

### app.viewport

An application states its viewport per policy, not per target. `fixed`
serves fixed-screen forms (`takeover`, `kiosk`, `embedded`); `dynamic` serves
window forms (`window`, `widget`). Stating both makes one application run on
both kinds of host.

```ts
viewport: {
  fixed: { logical: [[320, 480], [360, 800]], presentation: "integer-fit" },
  dynamic: { default: [720, 480] },
}
```

The bare form `{ logical: [480, 272], presentation: "integer-fit" }` is the
same as `fixed` alone.

**`fixed.logical` is one size, a list of sizes in preference order, or a
`{ min, max }` range.** The resolver takes the first listed size the host's
`logicalViewports` contains; for a range it takes the first host size inside
the range. The plan records one size, and the layout is written for that
size.

`fixed.presentation` names how the panel shows the logical viewport. The host
lists the modes it presents; the resolver checks two of them:

| Mode | Rule |
| --- | --- |
| `native` | One logical pixel is `rasterDensity` physical pixels and the logical viewport fills the panel, in either orientation of the panel. |
| `integer-fit` | The panel is one positive integer multiple of the logical viewport, the same multiple on both axes. |
| `fill`, `fit`, `stretch` | Accepted when the host lists them; the program owns the scaling. |

`dynamic.default` is the size a plan bakes assets for and must fall inside
the host's dynamic range. The resolver does not read `dynamic.min` and
`dynamic.max`; **the admitted range belongs to the host.** The Nokia E7
recipe reads them to choose its orientation lock when `pocket build` compiles
the application from its config: a range of portrait sizes only holds the
application in portrait.

What resolves on which host:

| Host form | `fixed` only | `dynamic` only | both |
| --- | --- | --- | --- |
| fixed screen | the matching size | `viewport.fixedRequired` | the fixed variant |
| window or widget with `acceptsFixed` | size-locked window at the matching size, presented `native` | `dynamic.default` | the dynamic variant |
| window or widget without `acceptsFixed` | `viewport.fixedUnhosted` | `dynamic.default` | the dynamic variant |

The plan records the winner as `viewport.policy`. An application that must
relayout on resize lists `display.viewport.live` and derives its layout from
[`useViewport`](/docs/api/#useviewport-solid).

### app.surfaces.auxiliary

A second UI output the same instance presents beside the primary viewport,
on hosts that provide `display.auxiliary`. Exactly one of `fixed` and
`adaptive` (`surface.auxiliaryPolicy` otherwise):

```ts
// apps/3ds-demo/pocket.host.config.ts
export default defineHostConfig({
  host: "3ds-runtime",
  app: {
    entry: "main.tsx",
    output: "pocket3ds-demo-main",
    framework: "solid",
    viewport: { fixed: { logical: [400, 240], presentation: "native" } },
    surfaces: { auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } },
    features: ["text.glyphs.baked", "input.buttons", "display.auxiliary", "input.touch.auxiliary", "input.analog.left"],
  },
});
```

```ts
surfaces: { auxiliary: { adaptive: { min: [320, 240], max: [480, 640] } } }
```

`fixed` needs the host's auxiliary size and presentation, with the same
`native` and `integer-fit` rules as the primary viewport. `adaptive` takes the
host's auxiliary size when it lies in the range, at native presentation,
and the application reads the size with `auxiliaryViewport()`. The auxiliary
surface's raster density equals the primary display's. **An auxiliary surface
the host cannot present turns `display.auxiliary` and `input.touch.auxiliary`
off in the plan** and leaves `surfaces` out of it; resolution does not fail.

### app.theme

`theme` is the animation content: `keyframes` and `animation` in the
Tailwind shape, applied with `animate-<name>` classes. **The config imports
it**, from a `.ts` module or a `.json` file:

```ts
// apps/motions/pocket.host.config.ts
import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.ts";

export default defineHostConfig({
  hosts: ["psp", "psp-runtime", "vita", "web-app", "macos-embedded", "pocketbook"],
  app: {
    entry: "main.tsx",
    output: "motions-main",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["text.glyphs.baked", "input.buttons"],
    theme,
  },
});
```

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

The theme type is `AnimationTheme` from `@pocketjs/framework/host-config`.
**The plan carries the theme content, and the compiler bakes every referenced
animation at `app.tickHz`.** A `.json` theme is imported with
`with { type: "json" }`. See [Animation](/docs/animation/).

### app.fonts

`fonts` names the face each kind of font slot is baked from: `regular` for
the regular-weight slots, `bold` for the `font-bold` slots and `mono` for the
`font-mono` slots. Each value is a `.ttf` or `.otf` file **relative to the
config file**, with no leading slash, `..` segment or backslash. An absent
field keeps the default face: Inter Regular, Inter Bold or JetBrains Mono.

```ts
app: {
  entry: "main.tsx",
  framework: "solid",
  viewport: { logical: [240, 240], presentation: "native" },
  features: ["text.glyphs.baked"],
  fonts: { regular: "fonts/Montserrat-Regular.ttf", bold: "fonts/Montserrat-Bold.ttf" },
},
```

**`pocket compile` and `pocket compile --aot` bake the atlases from the same
faces**, and the AOT layout oracle measures `layout-baked` text with those
atlases. The plan carries the paths relative to the project root, so a changed
declaration changes `planHash`. **Each named file is a build input whether or
not a slot of its kind is used:** the depfile and the AOT `dependencies.json`
and `dependencies.d` list it, so a changed file rebuilds the bundle or the
generated sources. A named file that is missing or unreadable fails the build
with an error naming its path; a file that does not parse as TrueType or
OpenType fails when a used slot loads it. The sizes and the mono slots come
from the slot table ([Styling](/docs/styling/#text)). A `fallback` face in
`fonts.json` supplies the code points the selected face does not map.

**`faces` and `slots` extend the slot table.** `faces` names further faces,
each a `.ttf` or `.otf` file under a lower-case name other than `regular`,
`bold`, `mono` and `normal`. `slots` binds slot indices **24 to 63** to a size
in logical px and a face (`regular`, `bold`, `mono` or a name in `faces`), with
an optional default line height in px:

```ts
fonts: {
  regular: "fonts/Nunito-SemiBold.ttf",
  bold: "fonts/Nunito-ExtraBold.ttf",
  faces: { display: "fonts/ZCOOLKuaiLe-Regular.ttf" },
  slots: [
    { slot: 24, px: 13, face: "regular" },
    { slot: 25, px: 13, face: "bold" },
    { slot: 26, px: 18, face: "display", lineHeight: 24 },
  ],
},
```

`text-[13px]` selects the 13 px regular slot, `text-[13px] font-bold` the bold
one and `text-lg font-display` the display slot. A bound (px, face) pair wins
over the built-in slot of the same pair; a size or face with no slot fails the
build with the pair in the message. Each slot index and each (px, face) pair
is bound once. The generated style module lists every used slot's size, face
and line height (`FONT_SLOTS`), which a host whose capabilities include
`text.layout.native` maps to its own fonts. In a browser,
`programs/web/app-instance.js` takes `slotFonts` (slot → CSS families, weight
and style) for the characters `text.glyphs.runtime` draws at run time.

### app.tickHz

A host presents the application at the largest cadence the rate is a whole
multiple of and advances the core `tickHz ÷ cadence` ticks per frame.
Resolution fails with `app.tickHz` when the rate is not a whole multiple of
any cadence the host contract lists.

### app.companions

The exact service names the application passes to `svcOpen`. The resolver
copies the list into `plan.companions`, and a host builds its svc allowlist
from that copy; `svcOpen` denies every other name. **A host with no adapter
for the listed services refuses the plan.** Absent, the application runs
standalone and `svcOpen` answers false.

### app.worker

A worker runs its entry in a second QuickJS runtime owned by the host, with
the resources its nodes name. See `docs/WORKER.md` for the runtime model.

```ts
worker: {
  entry: "src/worker.ts",
  nodes: [{ name: "i2c0", kind: "i2c" }, { name: "http", kind: "http" }],
  channels: [
    { name: "rtc", kind: "snapshot", direction: "worker-to-ui", recordBytes: 7, capacity: 1 },
    { name: "request", kind: "ring", direction: "ui-to-worker", recordBytes: 1024, capacity: 4 },
  ],
}
```

| Field | Value |
| --- | --- |
| `entry` | A `.ts` module relative to the config file. |
| `nodes[].name` | Unique within the worker, 1 to 63 characters, starting with a letter. |
| `nodes[].kind` | `i2c`, `uart` or `http`. Each kind needs its capability: `io.i2c`, `io.uart`, `net.http`. |
| `channels[].kind` | `snapshot` retains the newest record; `ring` queues records and rejects a publish when full. |
| `channels[].direction` | `ui-to-worker` or `worker-to-ui`. |
| `channels[].recordBytes` | 1 to 65536 bytes, or `"host"`. |
| `channels[].capacity` | 1 to 256 records, or `"host"`. |

**The selected host must provide `runtime.worker` and each node kind's
capability.** A worker owns at most 8 nodes and 8 channels; the host
contract bounds the count of each node kind, and resolution fails with
`worker.nodeLimit` above it. **Channel sizes are host facts too**: every host
holds records of 1024 bytes in rings of 8, a host contract's
`worker.channels` states a larger channel, and a size above the host's
fails with `worker.channelSize`. `"host"` takes the host's size; the plan
records the number, and `channel.recordBytes` and `channel.capacity` read it
at run time in both realms. A worker and `app.aot` do not combine
(`worker.execution`). Channel ids follow declaration order.

## A second build of the same sources

A config builds one application. **A second build of the same sources is a
second config** in the directory of its entry. `apps/nexus-touch` builds the
iPod touch 4 application from `apps/nexus-touch/pocket.host.config.ts` and the
Nokia E7 portrait application from `apps/nexus-touch/e7/pocket.host.config.ts`,
whose entry `e7/main.tsx` mounts the shared `app.tsx` with its own art and
theme:

```ts
// apps/nexus-touch/e7/pocket.host.config.ts
import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.json" with { type: "json" };

export default defineHostConfig({
  host: "symbian-e7-dev",
  app: {
    id: "dev.pocket-nexus.nexus-touch",
    title: "Pocket Nexus",
    entry: "main.tsx",
    output: "nexus-touch-e7",
    framework: "solid",
    viewport: { dynamic: { default: [360, 640], min: [360, 640], max: [360, 640] } },
    features: ["input.touch", "ui.physics"],
    theme,
  },
});
```

The commands find the nearest config above the working directory, so
`pocket compile` run from `apps/nexus-touch/e7` builds the E7 application;
`--config` names either file from anywhere.

## Resolution and the build plan

`resolveAppPlan(app, { target, executionClass, configDirectory, projectRoot },
registry)` (`framework/compiler/app-plan.ts`, exported from
`@pocketjs/framework/plan`) checks the section against its schema and resolves
it for one host into a `ResolvedBuildPlan`:

- **Entries move from the config's directory to the project root.**
  `app.entry`, `app.worker.entry` and the `app.fonts` paths are relative to
  the config file; the plan's are relative to the project root the compiler
  runs in (`--project-root`, default the config's directory). An entry outside
  the project root fails with `app.entryOutsideProject`.
- The plan records the identity (`app.id`, `app.title`, `app.version`), the
  output name, the framework, the theme content, the font faces, the AOT
  settings, the resolved viewport and auxiliary surface, the host's derived
  `modality` and `animation` class, `features`, `companions`, the worker with
  host channel sizes, and `presentation: { id: "default", entry }`.
- The plan records the host contract with the application rate (`profile`,
  `profile.tickHz`) and its hash (`profileHash`), and a checksum of its own
  content (`planHash`).

**The build plan is the compiler's input.** `pocket compile` writes it and
runs `tools/build.ts --plan=<plan.json> --project-root=<dir> --outdir=<dir>
--config=<pocket.host.config.ts>`. With `--config`, the compiler registers
the config's AOT settings and refuses a plan whose `aot`, `model`,
`recursionLimit` or compiled-model framework differ from them. Another product
writes plans with its own resolver and runs the same command without
`--config`: the plan's field names and its hash rule (`canonicalJson`,
`planHash`, `profileHash`) are the contract, and a plan may carry fields this
repository does not read.

**`pocket compile` writes one bundle (`.pkb`) for the selected host.** Its
identity section (output, id, title) comes from the plan and its icon section
from `app.icon`. Native builds and repacking read the bundle's plan, identity
section and header. See [Bundle format](/docs/native-contract/#bundle-format).

## Diagnostics

`pocket check` resolves the plan for the selected host and type-checks the
application modules. Resolution reports every diagnostic with a JSON Pointer
under `/app`:

| Code | Cause |
| --- | --- |
| `schema.*` | The section breaks its schema: a missing required field (`schema.required`), an unknown field (`schema.additionalProperty`), a value of the wrong type, pattern or range. |
| `capability.unknown` | A feature that neither the registry nor the selected host contract defines. |
| `capability.unavailable` | The host lacks the worker runtime or a node kind's capability. |
| `capability.dependency`, `capability.offloadDependency` | A dependency from the features table is missing. |
| `viewport.fixedRequired`, `viewport.dynamicRequired` | The host's form needs the other policy. |
| `viewport.fixedUnhosted` | A fixed-only application on a window host without `acceptsFixed`. |
| `viewport.logicalUnsupported` | No stated size is one the host lists, or `dynamic.default` is outside its range. |
| `viewport.presentationUnsupported` | The host does not present the mode. |
| `viewport.nativeMismatch`, `viewport.integerFitMismatch` | The mode's rule fails on the host's panel. |
| `surface.auxiliaryDeclarationMismatch`, `surface.auxiliaryPolicy` | `surfaces.auxiliary` and the `display.auxiliary` feature disagree, or both or neither of `fixed` and `adaptive` are set. |
| `app.outputUnderivable` | The entry's file name is not a valid artifact name. |
| `app.entryOutsideProject` | An entry lies outside the project root. |
| `app.tickHz` | The rate is not a whole multiple of a host cadence. |
| `execution.aotDisabled` | `--aot` without `app.aot`. |
| `worker.entry`, `worker.execution`, `worker.duplicate`, `worker.nodeLimit`, `worker.channelLimit`, `worker.channelSize` | Worker rules above. |
| `target.unknown` | The resolver's registry has no such host. |

```sh
pocket check --target psp
pocket check --config apps/hero/pocket.host.config.ts --target ./vendor/pocket.host.json
```

`--target` names a host the config lists, by id or by the path of a host
contract whose id the config lists.
