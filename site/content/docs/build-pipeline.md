# Build pipeline

This page describes the low-level JS/style/font/pak compiler. Product builds
should first resolve `pocket.json` through `bun pocket check`, `compile`, or
`build`; see [Platform contracts](/docs/platform-contracts/) for how one small,
checksummed target plan becomes the authoritative input to this pipeline and
native packaging.

The manifest-first compiler resolves the target before producing its bundle:

```sh
bun pocket check --target psp
bun pocket compile --target psp
bun pocket build --target psp -- --release

bun pocket check --target vita
bun pocket build --target vita -- --release
```

`check` validates the schema, capabilities, viewport, and reachable TypeScript.
`compile` also writes `.pocket/<target>/plan.json` plus the target-specific JS
and pak. `build` dispatches that same plan to the matching native backend —
`tools/pocket.ts` registers one for `psp`, `vita`, and `pocketbook`.

The lower-level compiler can still turn one entry into two files directly:

```sh
bun tools/build.ts hero
```

produces `dist/hero.js` (the bundle) and `dist/hero.pak` (styles, font
atlases, and images packed into a single binary container). This direct command
uses the default density-1 development contract. A manifest build is
target-specific: PSP and Vita compile from the same source and logical layout,
but Vita receives density-2 atlases/assets plus an embedded target/HostOps-ABI
handshake. Do not copy one target's pair into another target's native package.

Solid is the default framework. Vue Vapor and Octane build beside the Solid
artifacts by adding a suffix:

```sh
bun tools/build.ts hero-vue-vapor-main --framework=vue-vapor
# -> dist/hero-vue-vapor-main.vue-vapor.js + dist/hero-vue-vapor-main.vue-vapor.pak
bun tools/build.ts hero-main --framework=octane
# -> dist/hero-main.octane.js + dist/hero-main.octane.pak
```

The build is **two passes over the same module graph**. Pass 1 transforms every
reachable source file and, in the same traversal, collects class strings and
literal text codepoints. Font compilation combines those codepoints with the
numeric floor and the app's declared runtime text. Pass 2 bundles, reusing the
cached pass‑1 output. This page walks through both.

## Invoking the low-level compiler

The one required argument is the app to build. It can be a path or a bare name:

```sh
bun tools/build.ts apps/hero/app.tsx     # explicit path
bun tools/build.ts hero                    # bare name -> apps/hero/app.tsx
bun tools/build.ts hero-main               # the mounted entry (apps/hero/main.tsx)
```

A bare name resolves against `apps/`: `hero` finds `apps/hero/app.tsx`, and a
name ending in `-main` finds `apps/hero/main.tsx`.

An external ESP-IDF product supplies its host profile instead of selecting a
stock target:

```sh
pocket build --manifest app/pocket.json \
  --host-profile firmware/pocket.host.json \
  --project-root app --output dist/app.pocket
```

The package carries the JSON plan and a fixed-width binary `hostInputs`
section. Device admission reads the binary section and does not run a JSON
parser in QuickJS. See [ESP-IDF](/docs/esp-idf/#build-an-application-package).

| Flag | Effect |
|---|---|
| `--framework=solid\|vue-vapor\|octane` | Select the framework for this low-level build, overriding `pocket.config.ts`. Manifest builds take it from `pocket.json`. |
| `--config=<path>` | Load a different Pocket config file. |
| `--no-config` | Ignore `pocket.config.ts`; defaults to Solid unless `--framework` is set. |
| `--extra-chars=<string>` | Add these codepoints to **every** baked atlas for a low-level build. |
| `--density=N` | Raster samples per logical pixel for this build — an integer 1 through 255, default 1. A resolved plan owns the density, so passing both is an error. |
| `--hz=N` | Bake this virtual tick rate into the bundle — an integer 1 through 240, default 60. The host must drive the surface at the same rate; a bundle whose baked rate differs from the host's `ui.__tickHz` throws before it mounts. |
| `--font-regular=<path>` | Use this TTF instead of Inter Regular for the regular slots. |
| `--font-bold=<path>` | Use this TTF instead of Inter Bold for the bold slots. |

```sh
bun tools/build.ts settings --extra-chars="←→↑↓✓✕"
```

Product builds declare text that can arrive or be formed at runtime in
`pocket.json`. Use the printable ASCII range for unrestricted keyboard,
clipboard, file, or host-service text:

```json
"runtimeText": { "charset": "ascii" }
```

For a bounded protocol, list its complete supplement instead:

```json
"runtimeText": { "charset": "custom", "extraChars": "€←→" }
```

The build detects reachable `svcPoll` member access and destructuring, including
renamed, nested, and default-value patterns. A string-literal bracket such as
`ops["svcPoll"]` is the same explicit access. **Every non-literal computed key
used to access or destructure `getOps()` or a same-file local variable initialized
from it is treated as runtime text**, without resolving identifiers that happen
to hold a constant key. The compiler otherwise cannot determine which host
operation the key selects. Other literal keys do not trigger that rule. The
build also detects the `input.text`,
`input.ime`, `host.clipboard`, and `text.glyphs.runtime` capabilities. **A
detected runtime text source without `app.runtimeText` fails the build.**

### Output naming

The output name is derived from the entry path, and both artifacts share it:

| Entry | `dist/` outputs | Notes |
|---|---|---|
| `apps/hero/app.tsx` | `hero.js`, `hero.pak` | the app component |
| `apps/hero/main.tsx` | `hero-main.js`, `hero-main.pak` | the mounted entry — calls `mount()` |
| `foo/bar.tsx` | `bar.js`, `bar.pak` | non‑demo path: basename |
| `--framework=vue-vapor` | `<name>.vue-vapor.js`, `<name>.vue-vapor.pak` | Vue Vapor artifacts coexist with Solid artifacts |
| `--framework=octane` | `<name>.octane.js`, `<name>.octane.pak` | Octane artifacts coexist with the other two |

A demo has `app.tsx` (the exported UI) and `main.tsx` (a tiny file that
imports the app and mounts it). You build `hero-main` when you want a
runnable, self‑mounting bundle; you build `hero` to bundle the component on its
own. See [Components](/docs/components/) and [App shell](/docs/app-shell/) for
what those entries contain.

## Pass 1 — transform & collect

Pass 1 starts at the entry file and walks its import graph. For each `.tsx`/`.ts`
module it calls `transformFile(path, src)`, which runs Babel and, in the *same*
AST traversal, harvests two things the later stages need.

### The JSX transform

The selected framework owns the JSX transform:

```ts
// Solid
[solidPreset, { generate: "universal", moduleName: RENDERER_SOLID_PATH }]

// Vue Vapor
transformVueJsxVapor(source, path)

// Octane
octaneCompile(source, path, { mode: "client", renderer: OCTANE_RENDERER_DESCRIPTOR })
```

Solid compiles JSX into calls against `framework/src/renderer-solid.ts`. Vue Vapor
compiles JSX with `vue-jsx-vapor` and bundles against `framework/src/renderer-vue-vapor.ts`
plus the small DOM facade needed by Vue's Vapor helpers. Octane runs the
collector pass over the pristine source first, then hands the same source to
the Octane universal compiler, which lowers JSX and hooks to static host plans
plus dynamic slots against the "pocket" renderer descriptor — the compiled
output's runtime imports retarget to `@pocketjs/framework/octane/renderer`
(`framework/src/renderer-octane.ts`), whose driver maps host command batches
onto the native `ui.*` tree with no DOM shim. `@babel/preset-typescript`
still strips types in every case, and the same collector/lints run before JSX is
lowered.

Package imports are framework-aware during both pass 1 and pass 2. For example,
`@pocketjs/framework/components` resolves to `framework/src/components.ts` for Solid,
`framework/src/components-vue-vapor.ts` for Vue Vapor, and
`framework/src/components-octane.tsx` for Octane. **One row per public subpath in
`framework/compiler/subpaths.ts` owns that mapping**, and both the compiler's import
resolution and the npm `exports` map in `package.json` are derived from it
(`bun run gen` regenerates the latter). `jsx-plugin.ts` reads the derived table; it
does not hold its own. A row's per-framework availability also fixes what pass 1
walks, so widening one changes class collection and therefore `styles.bin` bytes.
See [Frameworks](/docs/frameworks/) for the public contract.

### What it collects

While the pristine AST is still in the author's shape (before the framework JSX
lowerer rewrites subtrees), a collector visitor records:

- **Candidate class strings** — every `StringLiteral` value, every
  `TemplateLiteral` quasi (the static chunks), and every `JSXText` run. It never
  regexes over quotes; it reads real AST nodes. It does *not* decide what is a
  class here — `tailwind.ts` does that later. A string like `"Loading…"` is
  collected as a candidate, fails to parse as a utility, and is dropped.
- **Text codepoints** — every codepoint of those same literals. This is the
  charset input for the font baker: if a character appears anywhere in a string,
  template chunk, or JSX text, its glyph gets baked.

### Build‑time lints

Some patterns can't work on the PSP or don't fit the build‑time styling model,
so the transform **throws with a code frame** rather than miscompiling:

| Lint | Why |
|---|---|
| `classList={…}` attribute | Not supported (v1). Use ternaries of full class literals. |
| `class={`a ${b}`}` (interpolated class) | Styles compile at build time; an interpolated fragment can't be resolved to a styleId. |
| `import { createResource, useTransition, startTransition } from "solid-js"` | The PSP QuickJS host has no scheduler — these can't run there. Use signals + `createEffect`, or [`animate()`](/docs/animation/). |
| HTML entities in JSX text (`&eacute;`) | The universal codegen emits raw text, so the entity would render literally. Write the actual character or a string expression. |

### The transform cache

Each transform result is cached in `.cache/transforms/`, keyed by a SHA‑256 of
the file contents **plus** the toolchain identity — the selected framework, the
versions of the JSX/compiler packages, the renderer path, and an internal cache
version. Bumping any dependency invalidates
the cache automatically. Because pass 2 loads through the *same* `transformFile`,
the expensive Babel work runs once per file per build and pass 2 gets it for
free.

The walker skips one path: the one ending in `/styles.generated.ts`. Its
literals **are** the compiled class names, so collecting them would feed the
compiler its own output. Every other generated module — a launcher's asset
registry, say — is ordinary app source whose literals pass 1 must see.

A pass‑1 summary line looks like:

```
PocketJS build: hero (/…/apps/hero/app.tsx, framework=solid)
  pass 1: 33 module(s), 415 candidate literal(s), 88 codepoint(s)
```

## Compile styles

The collected class strings go to `compileClasses()`. Each candidate literal
compiles to a **style record** if and only if *every* whitespace‑separated token
parses as a supported utility; otherwise the literal is ignored (it was
ordinary text). See [Styling](/docs/styling/) for the utility set.

Two literals that produce byte‑identical records share a single styleId, so
`class="p-2 bg-slate-700"` and `class="bg-slate-700 p-2"` cost one record. The
compiler emits:

- **`styles.bin`** — the encoded style table, packed into the pak as
  `ui:styles`. Any `theme.keyframes` / `theme.animation` entries referenced by
  an `animate-<name>` class are baked into it too, as frame-precise
  per-property segment timelines (the ANIM TABLE) — see
  [Animation → baked keyframe timelines](/docs/animation/#baked-keyframe-timelines).
- **`framework/src/styles.generated.ts`** — a TypeScript module the renderer imports,
  mapping each source class literal to its styleId, plus the font‑slot metadata
  and record count:

```ts
// AUTO-GENERATED by PocketJS framework/compiler/tailwind.ts — DO NOT EDIT.
export const STYLE_IDS: Record<string, number> = {
  "flex flex-col gap-2 p-4 bg-slate-800": 0,
  "text-lg font-bold text-slate-100": 1,
  // …
};
export const STYLE_COUNT = 18;
export const FONT_SLOTS: Record<number, { px: number; bold: boolean }> = {
  2: { px: 16, bold: false },
  9: { px: 16, bold: true },
  // …
};
export const DEFAULT_FONT_SLOT = 2;
```

Two class literals produce a **hard compile error** instead of being dropped, even
though they otherwise parse: `rounded-full` on a literal that doesn't also pin
both `w-N` and `h-N` (the radius must be build‑time bakeable), and any `hover:`
variant (the PSP has no pointer — use `focus:`/`active:`).

```
  tailwind: 48 style record(s), 0 baked timeline(s), 48 literal(s) -> framework/src/styles.generated.ts
```

## Bake fonts

`bakeAtlases()` bakes one atlas per font slot referenced by the compiled styles
(`styles.usedFontSlots`, which always includes the 16px‑regular default slot).
A slot is a pinned (size, weight, family) triple chosen by the `text-*`,
`font-bold`, and `font-mono` utilities. The table lives in
`framework/compiler/tailwind.ts` and holds up to `MAX_FONT_SLOTS` = 24 entries.
The assigned slots:

| Slots | Face | Sizes |
|---|---|---|
| 0–6 | Inter Regular | 12/14/16/18/20/24/36 px |
| 7–13 | Inter Bold | the same seven sizes |
| 14, 15 | Inter Regular / Bold | 54 px |
| 16–18 | JetBrains Mono Regular | 12/14/16 px |

A bold request under `font-mono` still lands on the mono slot for its size —
there is no bold mono face. `--font-regular` and `--font-bold` swap the Inter
faces for one build; the mono face has no flag.

The charset baked into every slot is the union of:

- **decimal digits `0`–`9`, always** — runtime number formatting does not
  depend on source literals;
- the **codepoints collected in pass 1** (printable, excluding DEL);
- the `app.runtimeText` declaration: printable ASCII for `charset: "ascii"`,
  or `extraChars` for `charset: "custom"`;
- anything passed via the low-level **`--extra-chars`** option.

Codepoints the font does not map are left out of the atlas. **On a target whose
profile carries only `text.glyphs.baked`, a codepoint missing from the atlas
resolves to glyph 0 — a drawn hollow "tofu" box, also mapped from U+FFFD so it
has an advance.** A target that also advertises `text.glyphs.runtime`
(`macos-widget` today) rasterizes the missing glyph from a system font and
reloads the atlas through `loadFontAtlas`, so tofu is what an app that accepts
arbitrary text gets on a baked-only target. Each atlas is horizontally
supersampled 8‑bit coverage cells plus proportional advances and a cmap, and is
packed into the pak as `ui:font.<slot>`.

The resolved target owns raster density. PSP bakes one coverage sample per
logical pixel; Vita bakes two while preserving the same logical font metrics,
so layout remains 480×272 and glyph edges use the full 960×544 framebuffer.

```
  font: slot 2 (16px) 99 glyphs, cell 16x20, coverage 16x20 @1x, 32488 bytes
  font: slot 9 (16px bold) 99 glyphs, cell 17x20, coverage 17x20 @1x, 34468 bytes
```

## Gather images

Any collected literal that looks like a filename ending in `.png` or `.svg` is
treated as an image reference (this is how `<Image src="logo.png" />` pulls its
asset in). For each name the build looks, in order, next to the app entry, then
in `assets/images/`, then in `assets/`:

- a **PNG** is decoded (8‑bit RGB/RGBA/grayscale, non‑interlaced — palette,
  16‑bit, and interlaced PNGs are rejected with a clear error);
- an **SVG** is rasterized;
- if nothing is found, a **32×32 checkerboard placeholder** is baked so the
  build still succeeds (with a warning).

Each image is packed as `ui:img.<name>`, encoded `PSM_8888` (RGBA) unless the
app overrides it. An optional `images.json` next to the entry maps an asset name
to `{ linear, psm }`: **`psm: 2` selects `PSM_4444` and halves that texture's
memory**, `linear` sets `IMG_FLAG_LINEAR` so the core samples it bilinearly
(rotated or scaled art). A name listed in the app's `sprites.json` becomes a
`ui:sprite.<name>` atlas entry instead, with the same `psm` override. Texture
dimensions must be power-of-two and within the hardware limit.

For density-2 targets the compiler prefers a sibling `@2x` PNG and otherwise
falls back to the base bitmap. SVGs and rounded masks rasterize directly at the
resolved density; their logical dimensions do not change. Runtime texture
producers use `platform.pixelRatio` instead of branching on a target name.

```
  image: logo.png <- /…/assets/images/logo.png (64x64)
```

## Pack the pak

All the binary output is written to one container, `dist/<app>.pak`. It uses
the stable PocketJS pak layout (compatible with earlier DreamCart-era tooling).
PocketJS uses these entry families:

| Key | Contents |
|---|---|
| `ui:styles` | `styles.bin` — the compiled style table |
| `ui:font.<slot>` | one baked font atlas per used slot |
| `ui:img.<name>` | one texture per referenced image |
| `ui:sprite.<name>` | one native-ticked sprite atlas plus frame metadata |
| `ui:tile.<name>` | a prebaked TILESET pyramid entry supplied through the app's `pak.json` |

`pak.json` may append other explicitly named prebaked `u8` blobs as well; the
compiler copies those entries verbatim and prefers an `@<density>x` sibling
when the selected target provides one.

Entries are sorted by key and 16‑byte aligned. How a host reads these blobs —
and how the PSP feeds them straight into the Rust core from `include_bytes!`
without touching the JS heap — is covered in the [Native contract](/docs/native-contract/).

```
  pak: 20 entries, 986400 bytes -> /…/dist/hero.pak
```

## Pass 2 — bundle

With the style table compiled, `Bun.build` bundles the app:

```ts
Bun.build({
  entrypoints: [entry],
  root: process.cwd(),
  outdir: DIST,
  naming: `${outName}.js`,
  format: "iife",
  target: "browser",
  conditions: ["browser"],
  define: {
    "process.env.NODE_ENV": '"production"',
    __POCKET_TARGET__: JSON.stringify(buildPlan?.target.id ?? ""),
    __POCKET_HOST_ABI__: String(buildPlan?.target.hostAbi ?? 0),
    __POCKET_FEATURES__: JSON.stringify(buildPlan?.features ?? {}),
    __POCKET_PIXEL_RATIO__: String(rasterDensity),
    __POCKET_TICK_HZ__: String(tickHz),
    ...(framework === "vue-vapor" ? { document: "globalThis.__pocketDocument" } : {}),
  },
  minify: { whitespace: true, identifiers: false, syntax: false },
  metafile: true,
  sourcemap: "none",
  plugins: [jsxPlugin(framework, { entry, features: buildPlan?.features, generatedStyles })],
});
```

The plugin's `onLoad` hook intercepts every project `.ts`/`.tsx` file and serves
the **cached pass‑1 transform** (`node_modules` and `.d.ts` fall through to
Bun). It also serves this build's generated style module directly from memory;
the ignored `framework/src/styles.generated.ts` file is only a human-readable
mirror. Parallel target builds therefore cannot consume one another's transient
style table. The bundle is built from *exactly* the code the class/charset scan
saw — the two passes agree on the module graph by construction, so a style can
never be shipped that the bundle doesn't use, or vice versa.

With a resolved plan, pass 1 also replaces literal
`hasFeature("capability.id")` calls with `true` or `false`; normal tree shaking
can then remove an unavailable enhancement branch. Pass 2 bakes five constants
the runtime contract reads: `__POCKET_TARGET__` and `__POCKET_HOST_ABI__` (empty
and 0 without a plan, which is how a plan-less bundle skips the target/ABI
check), `__POCKET_FEATURES__`, `__POCKET_PIXEL_RATIO__` (the resolved raster
density), and `__POCKET_TICK_HZ__` (the `--hz` rate, 60 by default). A Vue Vapor
build adds a sixth define, rewriting the bare `document` identifier to
`globalThis.__pocketDocument`.

A few settings are deliberate:

- **`format: "iife"`** — a single self‑contained script, the shape QuickJS
  evaluates on the PSP.
- **`conditions: ["browser"]`** — forces browser runtime exports for framework
  packages. For Solid, the `node` condition would pull the SSR build (where
  reactive updates no‑op); Bun's default `development` condition can also pull
  dev builds and duplicate runtimes.
- **Whitespace minification is enabled; identifier and syntax minification are
  disabled.** Bun removes comments and layout whitespace and may omit optional
  semicolons. It does not rename identifiers or apply syntax transforms. An
  ESP32-P4 bundle built with `minify: true` overflowed QuickJS's 8 KB parse
  stack. A second syntax-minified variant spent four minutes in the parser and
  crossed the five-second watchdog limit. The device used whitespace-only
  output and a 64 KB task stack. Binary assets remain in the pak instead of
  entering the QuickJS heap as base64 text.

```
  pass 2: /…/dist/hero.js (73814 bytes)
PocketJS build: done
```

## The same pipeline in the browser — the Playground

The [Playground](/playground/) runs the same compiler stages **live in the
browser**: it transforms and collects, compiles the Tailwind subset, bakes
atlases, packs a pak, and bundles — then loads the result into the WebAssembly
core and renders to a canvas. It exercises the same logical UI and pak formats,
but its density-1 browser development pair is not interchangeable with a
manifest-built PSP or Vita artifact carrying target-specific density and ABI
constants.

## Related

- [Styling](/docs/styling/) — what the class compiler accepts.
- [Native contract](/docs/native-contract/) — how a host consumes the pak and drives the core.
- [Architecture](/docs/architecture/) — where the renderer, core, and hosts fit together.
- [Getting started](/docs/getting-started/) — install, scaffold, and run your first build.
