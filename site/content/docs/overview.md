# Overview

PocketJS is a portable application runtime with **TypeScript application
sources**. You write **Solid**,
**Vue Vapor**, or **Octane** components; the build compiles class strings and
font glyphs into binary tables, and a compact `no_std` Rust core renders
flexbox layout, sub-pixel text, and native animation from them. One application
manifest resolves into one target-specific guest artifact — a PSP EBOOT, a Vita VPK,
a native window, a browser bundle — and each of them drives the same logical UI
through the same HostOps op set.

**MicroTS compiles Solid TSX and Vue SFC views into Rust.** A native build
uses either a compiled TypeScript model or an application-provided Rust model
and calls the UI core without a guest engine. Guest builds transform the
TypeScript sources into JavaScript bundles for their engine. The
[TypeScript and native code guide](/docs/microts-boundaries/) describes
the two paths. [TypeScript support](/docs/typescript-support/) compares their
source-language rules, including the separate view and compiled model
subsets. The framework adapters below belong to the guest path.

If you know Solid, Vue, or React, you know most of PocketJS. The primitives are
`View`, `Text`, and `Image`; state comes from the native framework package
(`solid-js`, `vue`, or `octane`); layout and color come from class strings like
`flex-col items-center gap-4 bg-slate-50`. What is different is what happens
underneath: there is no browser DOM and no runtime CSS.

## One core, every host

Everything renders through one Rust core, `pocketjs-core` — a
platform-agnostic `#![no_std]` library that owns the retained node tree,
[taffy](https://github.com/DioxusLabs/taffy) flexbox layout, the style table,
animation tracks, baked text, and a `DrawList`. Each host compiles that core
for its architecture and pairs it with a backend: sceGu on PSP, vita2d/GXM on
Vita, gpui on macOS and Linux, and one deterministic software rasterizer shared
by the browser host and headless Bun.

Two places in the repo decide what you can build for:

- `hosts/` holds one directory per host implementation, from consoles and
  e-readers through phones, ESP-IDF firmware, and the browser.
- `contracts/spec/platforms.ts` registers the stock targets that
  `pocket build --target <id>` accepts, each with its host ABI, logical
  viewport, raster density, presentations, and capability set. A host outside
  that registry builds through its own host profile or a resolved build plan —
  see [Platform contracts](/docs/platform-contracts/).

Layout runs in one place — the Rust core — so a screen lays out the same
everywhere. The browser and Bun hosts share one rasterizer, which is what makes
byte-exact golden images possible. See
[Architecture](/docs/architecture/) for the full picture and
[Native contract](/docs/native-contract/) for the `ui.*` op set that bridges JS
and Rust.

## Framework adapters over one native tree

Solid is the default adapter and uses `babel-preset-solid` universal mode. Vue
Vapor uses `vue-jsx-vapor`. Octane — React's programming model, compiled — uses
the Octane universal compiler, which lowers JSX to static host plans plus
dynamic slots. All three target the same retained native tree and HostOps
surface, so switching framework changes the JS component and reactivity layer,
not the Rust core, styling pipeline, input model, or asset pack. See
[Frameworks](/docs/frameworks/).

## A build-time Tailwind subset, with no runtime CSS

Class strings are parsed at build time. A literal like `class="p-2 rounded-md
bg-blue-600"` compiles to a numeric style record iff *every* whitespace-
separated token is a supported utility; the compiler writes a binary style
table (`styles.bin`) plus a generated lookup, and at runtime a class is a
`styleId`. There is no CSS engine on the device. Dynamic styling is expressed
as ternaries of whole class literals, `style={{…}}` objects, or `animate()`.
`classList`, `hover:`, and template-interpolated class fragments are compile
errors, not silent no-ops. See [Styling](/docs/styling/).

## Baked font atlases

Text draws from atlases baked at build time. The default faces in
`assets/fonts/` are **Inter** for the regular and bold slots and **JetBrains
Mono** for the mono slots; `bun tools/build.ts --font-regular=` and
`--font-bold=` swap the proportional faces. The build scans your source for the
characters and font sizes you use and rasterizes only those atlas slots —
supersampled 8-bit coverage cells with proportional advances and a cmap.
Drawing text composites pre-baked coverage; the bundle carries no rasterizer.
Hosts that register the `text.glyphs.runtime` capability extend the atlases at
runtime for codepoints outside the baked set, and hosts that register
`text.layout.native` measure and shape through the platform text system. See
[Build pipeline](/docs/build-pipeline/).

## Current boundaries

PocketJS does not include:

- `hover:` variants — a console has no pointer, and `hover:` inside an
  otherwise valid class literal is a compile error
- percentage sizes other than `-full`
- `rounded-full` on runtime-sized nodes — it requires build-time-known `w-N h-N`
  in the same class literal
- a runtime-resizable logical viewport outside the window and widget forms;
  console profiles bake one fixed logical size (PSP and Vita both 480×272)
- render-to-texture opacity groups — opacity multiplies vertex alpha down the
  subtree, which is wrong where siblings overlap
- kerning

These are omissions, not silent failures: unsupported class tokens and
disallowed patterns surface as compile-time or dev errors. See the full list in
[Styling](/docs/styling/).
