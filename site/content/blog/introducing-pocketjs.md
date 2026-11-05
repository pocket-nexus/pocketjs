PocketJS is a UI stack that runs modern JSX — real [Solid](https://www.solidjs.com/) and Vue Vapor components, styled with Tailwind classes, animated at 60 FPS — on a 2004 Sony PSP, inside an 8 MB memory budget. The same app, unchanged, also runs in the PPSSPP emulator, in the browser through WebAssembly, and headless under Bun.

<video class="w-full rounded-xl border border-line" src="/assets/pocketjs-hardware-demo.mp4" autoplay muted loop playsinline></video>

PocketJS is open source under MIT, and the [playground](/playground/) is live. The engine running in that page is not a web mockup of PocketJS — it is the same Rust core that ships inside the PSP executable, compiled to WebAssembly.

Getting JavaScript to run on retro hardware is not new. What we believe *is* new is the combination PocketJS ships: unmodified mainstream frameworks, a design system that compiles away, animation that runs natively, and a UI engine you can regression-test byte-for-byte — all inside a memory budget smaller than a single browser tab's baseline heap. This post walks through the pieces.

## The premise

Modern frontend ergonomics are not intrinsically expensive. Components, fine-grained reactivity, utility-class styling, declarative springs — nothing about them requires a browser. What requires a browser is the machinery we normally implement them with: a DOM, a CSS cascade, a JIT, and hundreds of megabytes of headroom.

PocketJS splits the ergonomics from the machinery. You write ordinary Solid or Vue Vapor components against React Native-style `<View>`, `<Text>`, and `<Image>` primitives. Everything below the framework — flexbox layout, styling, text, animation, rendering — lives in a single `#![no_std]` Rust crate driven through a tiny mutation-only protocol:

```text
        app.tsx  (Solid or Vue Vapor + Tailwind classes)
           │  framework JSX transform  (two-pass build)
           ▼
        bundle.js      styles.bin + font atlases + images ──► app.pak
           │
   ┌── QuickJS (PSP) ──────────┐   ┌── browser / Bun ─────────┐
   │ framework runtime         │   │ framework runtime        │
   │   │ createNode/setStyle…  │   │   │ same ui.* ops        │
   │   ▼                       │   │   ▼                      │
   │ pocketjs-core (Rust)      │   │ pocketjs-core (same      │
   │  tree·flexbox·anim·text   │   │   Rust, → wasm32)        │
   │   │ DrawList              │   │   │ DrawList             │
   │   ▼                       │   │   ▼                      │
   │ sceGu backend (PSP GPU)   │   │ software rasterizer      │
   └───────────────────────────┘   └──────────────────────────┘
```

Eight consequences of that split are worth calling out.

## 1. Real frameworks, not lookalikes

The `solid-js` you import in a PocketJS app is the one from npm. So is `vue`. PocketJS forks neither and imitates neither: Solid drives the native tree through its official universal renderer, and Vue Vapor drives it through a Vapor renderer adapter plus a small DOM-shaped facade for Vue's helpers.

```tsx
import { createSignal } from "solid-js"; // real Solid, from npm
import { Text, View } from "@pocketjs/framework/components";

export default function Counter() {
  const [count, setCount] = createSignal(0);

  return (
    <View class="flex-col items-center gap-4 p-4 bg-slate-50">
      <Text class="text-xl text-slate-950">Count: {count()}</Text>
      <View
        class="p-2 rounded-md bg-blue-600 focus:bg-blue-500 transition-colors duration-150"
        focusable
        onPress={() => setCount(count() + 1)}
      />
    </View>
  );
}
```

The ownership line is explicit: the framework owns state, lifecycle, and control flow (`<Show>`, `<For>`, computeds — the semantics you already know), while PocketJS owns the host — components, input, focus, animation, assets. Both supported frameworks share the property that makes this viable on a 2004-era MIPS CPU running an interpreter: no virtual DOM. When a signal changes, only the effect closures that read it re-run, and each one becomes a handful of mutations on the native tree. There is no diff pass to pay for.

## 2. One `no_std` Rust core, compiled twice

`pocketjs-core` owns the retained node tree, flexbox layout (via taffy), style resolution, text layout, and animation, and its output is a `DrawList` — a flat list of quads. The crate is `#![no_std]` and platform-blind, and it is compiled twice: to MIPS, wrapped by QuickJS and the PSP's GPU backend; and to `wasm32`, wrapped by a deterministic software rasterizer that serves both the browser host and headless tests.

That is the trick behind "runs everywhere": there is exactly one layout engine, one styling engine, one animation system. The playground, the emulator, CI, and the handheld in your hands compute the same frames because they run the same code.

## 3. A native contract sized for one FFI crossing per frame

JS drives the core through a mutation-only op set — `createNode`, `insertBefore`, `setStyle`, `setText`, `animate`, and friends. The renderer keeps a JS-side mirror of the tree, so framework *reads* never cross the language boundary. Node handles are generation-tagged integers, so a stale reference is a harmless no-op instead of a use-after-free.

The result is a steady-state frame that crosses the FFI once, and a draw budget that fits the hardware: on the PSP, a frame targets ≤ ~40 GPU draw calls and ~2,000 quads.

## 4. Tailwind as a compiler, not a stylesheet

There is no CSS engine at runtime, because there is no CSS at runtime. During the build, PocketJS collects every class string in your app straight from the AST, validates each literal all-or-nothing against a pinned [Tailwind subset](/docs/styling/) (unsupported tokens are loud compile errors, not silent no-ops), and compiles the survivors into a binary style table shipped next to your bundle. At runtime, styling a node is `setStyle(node, styleId)` — an integer.

Interaction states come along for free: `focus:` and `active:` variants are part of the compiled style record and are switched *inside the native core*. When focus moves in a PocketJS app, zero JavaScript styling code runs.

## 5. Frames are pure functions — so UI is testable byte-for-byte

Animation is declared in JS (`animate()`, springs, `transition-*` utilities) but executed in Rust, ticked once per vblank at a fixed dt of 1/60 s. Nothing about a frame depends on wall-clock time: frame N is a pure function of the op history and the frame index.

That property turns UI testing from screenshot-fuzz-matching into compiler-style verification. CI drives scripted input through the wasm build's deterministic rasterizer and asserts *byte-exact* PNG goldens — animated transitions included — and an end-to-end suite boots the real PSP executable in headless PPSSPP and compares dumped frames the same way.

## 6. Fonts baked to exactly what your app renders

The same AST pass that harvests class strings also harvests text codepoints. The font baker then rasterizes atlas slots — supersampled 8-bit coverage, proportional metrics — for exactly the characters your app can display, at exactly the sizes your styles use. No font parsing, no shaping engine, no glyph rasterization on device: text drawing decodes coverage runs into batched GPU sprites.

## 7. An allocator story for 8 MB

The whole app — QuickJS heap, Rust-core allocations, uploaded textures — lives in a single arena claimed from the OS once at boot. Per-frame vertex memory comes from a bump pool that resets after the GPU finishes each frame, at around 48 KB per frame. Budgets in PocketJS are contracts rather than aspirations; the demos hold 60 FPS on hardware inside 8 MB, transitions and all.

## 8. The toolchain runs in the browser too

The [playground](/playground/) does not talk to a build server. Babel with the framework JSX transforms, the Tailwind-subset compiler, and the font baker are all bundled to run client-side, feeding the same wasm core you see everywhere else. Edit a component and you are re-running the actual PocketJS toolchain — in a tab.

## Why a PSP?

Because it is an honest referee. A 480×272 screen, an 8 MB budget, an interpreter with no JIT, a GPU that wants aligned vertex buffers and power-of-two textures: nothing on that machine will quietly absorb a lazy architecture. If component-driven, utility-styled, spring-animated UI holds 60 FPS *there*, the architecture is what's carrying it — and everything roomier is downhill.

And the PSP is the proof, not the point. The core is platform-blind; a new device is a backend to write, not a rewrite. Two additional hosts — browser WASM and headless Bun — already share it.

## What v1 leaves out — on purpose

PocketJS v1 has a pinned scope and loud errors at its edges: no `hover:` (there is no pointer), no `classList` or interpolated class strings (they defeat the compiler), no kinetic scroll views yet, no runtime-sized `rounded-full`. We would rather ship a small surface that is exactly right on hardware than a large one that is approximately right.

## Try it

- **[Playground](/playground/)** — the full toolchain and core, in your browser.
- **[Getting started](/docs/getting-started/)** — build and run your first app.
- **[Architecture](/docs/architecture/)** — the deep dive this post summarizes.
- **[GitHub](https://github.com/pocket-nexus/pocketjs)** — MIT, contributions welcome.

Follow [@pocket_js](https://x.com/pocket_js) for what's next — there is more in the pocket than a framework.
