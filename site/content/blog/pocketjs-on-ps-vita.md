<video class="w-full rounded-xl border border-line" width="1920" height="1080" autoplay muted loop controls playsinline preload="metadata" crossorigin="anonymous" aria-label="PocketJS demos and OpenStrike running on a real PS Vita">
  <source src="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocketjs-real-ps-vita-bee7681c.mp4" type="video/mp4" />
  <a href="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocketjs-real-ps-vita-bee7681c.mp4">Watch PocketJS running on a real PS Vita.</a>
</video>

<p class="text-sm text-slate-500 -mt-4">PocketJS demos and OpenStrike running natively on a real PS Vita — release VPKs, installed through VitaShell and rendered through vita2d/GXM.</p>

The PocketJS Vita port is now verified on real PS Vita hardware. The release VPKs were installed as named LiveArea bubbles, then several framework demos and OpenStrike were launched and exercised using the production renderer. The deterministic Vita3K suite remains our repeatable pixel oracle; the real-device pass closes the deployment and on-hardware presentation gap.

The emulator development loop remains one command:

```sh
bun play vita gallery --fullscreen
```

That builds a native VPK, installs it into the [Vita3K](https://vita3k.org/) emulator, and launches the same Gallery demo we ship on PSP. The same build pipeline emits the release VPK installed on hardware. There is no Vita entry file, no Vita component tree, and no `if (vita)` anywhere in the application. If you are new here: [PocketJS](/blog/introducing-pocketjs/) runs real Solid and Vue Vapor components on a 2004 Sony PSP — 333 MHz, 32 MB of RAM — at a locked 60 FPS. The Vita is the second PlayStation the runtime targets, and the first whose screen has more pixels than the apps were drawn for.

<img class="w-full rounded-xl border border-line" src="/assets/blog/vita-gallery-960.png" alt="The PocketJS Gallery demo running at 960 by 544 for PS Vita: an EVERGREEN page of six procedural texture tiles named FERN, MOSS, PINE, JADE, TIDE and GROVE, with crisp labels and a controller-hint status bar" />

<p class="text-sm text-slate-500 -mt-4">A committed 960×544 Vita golden of the Gallery demo — frame 132 of a deterministic input tape. Like every Vita screenshot in this post, it is produced by the capture build's CPU renderer inside the guest, consuming the same DrawList the production vita2d/GXM pass draws; GPU texture residency is asserted separately.</p>

The interesting part is not that we taught a second Sony handheld to draw a rectangle. It is that the port refused to become a fork — and this post is about the two decisions that kept it one codebase. First, the **2× screen is a rendering contract, not a scale factor**: the Vita renders the same 480×272 logical world at a native 960×544, so text and vectors gain real detail instead of stretched pixels. Second, **platform differences live in one build-time contract** — a manifest, a profile, and a resolver — so an ad hoc `if (vita)` has nowhere to hide. Everything here lands in PocketJS 0.4.0.

## The port that refused to become a fork

PocketJS applications do not render pixels themselves. Solid or Vue Vapor updates a native tree through HostOps; `pocketjs-core` lays that tree out and emits a DrawList; one last host-specific layer submits those drawing commands to the machine.

<svg viewBox="0 0 760 420" width="100%" role="img" aria-label="PocketJS architecture: one application bundle flows through a QuickJS guest and HostOps into pocketjs-core, which fans out to the PSP sceGu backend at 480 by 272 density 1 ABI 1 and the Vita vita2d GXM backend at 960 by 544 density 2 ABI 2. Caption: the fork is one native submission layer, not the application" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="150" y="12" width="460" height="60" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="37" fill="#f1f5f9" font-size="14" font-weight="700" text-anchor="middle">app.tsx + app.pak</text>
  <text x="380" y="57" fill="#94a3b8" font-size="11.5" text-anchor="middle">one product bundle · Solid or Vue Vapor · one manifest</text>
  <path d="M380 72 L380 100" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 100 l-5 -8 M380 100 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="205" y="104" width="350" height="54" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="127" fill="#e2e8f0" font-size="13" text-anchor="middle">QuickJS guest → HostOps</text>
  <text x="380" y="146" fill="#64748b" font-size="11" text-anchor="middle">buttons · analog nub · touch snapshots · baked glyphs</text>
  <path d="M380 158 L380 186" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 186 l-5 -8 M380 186 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="205" y="190" width="350" height="62" rx="9" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="215" fill="#e2e8f0" font-size="13" font-weight="700" text-anchor="middle">pocketjs-core</text>
  <text x="380" y="235" fill="#22d3ee" font-size="11" text-anchor="middle">layout · clip · paint transforms · DrawList</text>
  <path d="M315 252 L186 300" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M186 300 l2 -9 M186 300 l8 -5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M445 252 L574 300" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M574 300 l-8 -5 M574 300 l-2 -9" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="40" y="304" width="292" height="80" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="186" y="330" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PSP host</text>
  <text x="186" y="351" fill="#94a3b8" font-size="11.5" text-anchor="middle">sceGu · fixed-function GE</text>
  <text x="186" y="370" fill="#64748b" font-size="11" text-anchor="middle">480×272 · density 1 · HostOps ABI 1</text>
  <rect x="428" y="304" width="292" height="80" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="574" y="330" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PS Vita host</text>
  <text x="574" y="351" fill="#c4b5fd" font-size="11.5" text-anchor="middle">vita2d · GXM · front touch</text>
  <text x="574" y="370" fill="#64748b" font-size="11" text-anchor="middle">960×544 · density 2 · HostOps ABI 2</text>
  <text x="380" y="410" fill="#475569" font-size="11" text-anchor="middle">the fork is one native submission layer, not the application</text>
</svg>

On PSP that last layer translates the DrawList to `sceGu`, Sony's fixed-function Graphics Engine API. On Vita, a Rust host embeds QuickJS, feeds the same pak into the same core, and translates the same DrawList through vita2d to GXM. The VPK contains the native host, compiled JavaScript, styles, font atlases, and images as one installable bubble.

This boundary is the whole ballgame. A rounded corner is not a Vita feature; clipping, masks, and paint-only transforms are PocketJS semantics implemented above either GPU. The backend is allowed to be completely different — the visible contract is not.

## Twice the pixels, not twice the app

The PSP screen is 480×272. The Vita screen is 960×544 — exactly twice the width and twice the height. The first cut of the port used that relationship the obvious way: draw the 480×272 frame, stretch it ×2. Layout survived perfectly. So did every jagged edge, now four times the area.

Here is that difference on real committed goldens — the same frame of the same input tape, once as the stretched density-1 frame, once as the Vita actually renders it:

<img class="w-full rounded-xl border border-line" src="/assets/blog/vita-density-compare.png" alt="Side by side comparison of the same Gallery frame: on the left the 480 by 272 frame stretched two times with visibly blocky text edges on the words deep forest floor and EVERGREEN and a chunky FERN tile; on the right the same frame rendered at raster density 2 with smooth crisp glyphs and a clean rounded tile" />

<p class="text-sm text-slate-500 -mt-4">The same logical crop of Gallery frame 132, magnified so one logical pixel is 4 image pixels. Left: the 480×272 density-1 golden every earlier target renders, upscaled the way a plain integer-fit port would show it. Right: the committed 960×544 Vita golden. Same layout, same wrapping, same focus ring — the glyphs, the rounded-corner mask, and even the procedural tile art are sampled at twice the resolution.</p>

The finished contract separates two facts the first cut had fused. The **logical viewport** is the world the app is written against: 480×272, the truth for layout, text wrapping, focus, hit targets, and animation. The **raster density** is how many physical samples each logical pixel deserves: 1 on PSP, 2 on Vita. Layout stays portable; pixels stop being nostalgic.

<svg viewBox="0 0 760 342" width="100%" role="img" aria-label="Three column contract diagram. Left: the logical world at 480 by 272 owns layout, text wrapping, focus, hit targets and animation — what the app is written against. Middle: rasterDensity equals 2 drives five rasterization rules: font atlas v3 keeps metrics logical while coverage doubles, SVGs and rounded corner masks bake at 2x, images prefer an at-2x sibling checked at build time, dynamic textures read platform.pixelRatio, and geometry plus gradients are sampled directly on the 960 by 544 target. Right: the physical raster at 960 by 544. Caption: no relayout, no crop, no letterbox, no target branch" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="40" width="200" height="240" rx="10" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="116" y="26" fill="#e2e8f0" font-size="12.5" font-weight="700" text-anchor="middle">logical world · 480×272</text>
  <text x="116" y="76" fill="#94a3b8" font-size="11.5" text-anchor="middle">layout</text>
  <text x="116" y="102" fill="#94a3b8" font-size="11.5" text-anchor="middle">text wrapping</text>
  <text x="116" y="128" fill="#94a3b8" font-size="11.5" text-anchor="middle">focus + hit targets</text>
  <text x="116" y="154" fill="#94a3b8" font-size="11.5" text-anchor="middle">animation</text>
  <text x="116" y="190" fill="#38bdf8" font-size="11" text-anchor="middle">what the app</text>
  <text x="116" y="206" fill="#38bdf8" font-size="11" text-anchor="middle">is written against</text>
  <text x="116" y="252" fill="#64748b" font-size="10.5" text-anchor="middle">identical on PSP + Vita</text>
  <path d="M216 160 L248 160" stroke="#475569" stroke-width="1.5"/>
  <path d="M248 160 l-8 -5 M248 160 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="252" y="40" width="292" height="240" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="398" y="26" fill="#22d3ee" font-size="12.5" font-weight="700" text-anchor="middle">rasterDensity = 2</text>
  <text x="268" y="76" fill="#e2e8f0" font-size="11">font atlas v3 — metrics logical,</text>
  <text x="268" y="93" fill="#64748b" font-size="11">glyph coverage stored ×2</text>
  <text x="268" y="120" fill="#e2e8f0" font-size="11">SVGs + rounded-corner masks ×2</text>
  <text x="268" y="147" fill="#e2e8f0" font-size="11">images prefer an @2x sibling,</text>
  <text x="268" y="164" fill="#64748b" font-size="11">dimensions checked at build time</text>
  <text x="268" y="191" fill="#e2e8f0" font-size="11">dynamic textures read</text>
  <text x="268" y="208" fill="#64748b" font-size="11">platform.pixelRatio</text>
  <text x="268" y="235" fill="#e2e8f0" font-size="11">geometry + gradients sampled</text>
  <text x="268" y="252" fill="#64748b" font-size="11">directly on the 960×544 target</text>
  <path d="M544 160 L576 160" stroke="#475569" stroke-width="1.5"/>
  <path d="M576 160 l-8 -5 M576 160 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="580" y="40" width="164" height="240" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="662" y="26" fill="#e2e8f0" font-size="12.5" font-weight="700" text-anchor="middle">physical raster</text>
  <text x="662" y="130" fill="#c4b5fd" font-size="16" font-weight="700" text-anchor="middle">960×544</text>
  <text x="662" y="158" fill="#94a3b8" font-size="11" text-anchor="middle">every pixel earned</text>
  <text x="662" y="175" fill="#94a3b8" font-size="11" text-anchor="middle">none stretched</text>
  <text x="662" y="252" fill="#64748b" font-size="10.5" text-anchor="middle">integer-fit · exact ×2</text>
  <text x="380" y="322" fill="#475569" font-size="11" text-anchor="middle">no relayout · no crop · no letterbox · no target branch</text>
</svg>

The rules in the middle column are the whole implementation, and none of them lives in application code. Font atlas v3 keeps advances, baselines, and line heights in logical pixels while storing density-scaled glyph coverage — so text lays out byte-identically on both machines and only *looks* better on one. SVGs and PocketJS's own rounded-corner masks bake at the same density. PNG and sprite assets prefer an `@2x` sibling, with the build failing loudly if its dimensions lie. Anything that generates pixels at runtime reads `platform.pixelRatio` from `@pocketjs/framework/platform`. And geometry, gradients, and triangles are rasterized directly on the 960×544 target rather than rendered small and copied large.

Just as important is who consumes the answer. The resolved target profile owns physical size, presentation, and raster density — and the PSP GE backend, the Vita GXM backend, the WASM test renderer, the capture build, and even the low-level demo builds all read those same resolved values. We did not hide a `scale = 2` in the JavaScript compiler, and no component ever rediscovers a scale factor. When one late bug turned out to be a demo build constructing its own density-unaware raster path, the fix was to delete the private assumption, not to add a Vita case.

## An app asks; a host answers

The 2× contract begged a larger question: what should an application *say* about platforms when it may run on more than one handheld?

Not this:

```json
{ "psp": true, "vita": true, "scale": 2 }
```

Those are host facts, and the moment an app states them, every future host inherits an archaeology project. In `pocket.json` — the manifest every PocketJS app ships — the app writes only the public APIs it needs and the logical world it was designed for:

```json
{
  "engine": {
    "capabilities": {
      "requires": ["text.glyphs.baked", "input.buttons"],
      "enhances": ["input.analog.left", "input.touch"]
    }
  },
  "app": {
    "entry": "app/main.tsx",
    "framework": "solid",
    "viewport": {
      "logical": [480, 272],
      "presentation": "integer-fit"
    }
  }
}
```

PocketJS owns the other half. Each stock target registers a small profile stating what its host has actually implemented and tested — the real Vita entry, verbatim from `contracts/spec/platforms.ts`:

```ts
vita: {
  hostAbi: 2,
  display: {
    physicalViewport: [960, 544],
    logicalViewports: [[480, 272]],
    presentations: ["integer-fit"],
    rasterDensity: 2,
  },
  capabilities: [
    "input.analog.left",
    "input.buttons",
    "input.touch",
    "text.glyphs.baked",
  ],
},
```

A resolver combines manifest and profile exactly once, and everything downstream consumes the resolved answer:

<svg viewBox="0 0 760 452" width="100%" role="img" aria-label="Resolver flow. Two inputs at the top: pocket.json holding app intent — requires, enhances, logical viewport, presentation — and the target profile holding host facts — HostOps ABI, physical display, raster density, tested capabilities. Both feed a resolve step that runs exactly once per build. An unmet requires exits sideways as a failed build. The output is a small checksummed ResolvedBuildPlan consumed by three stages: the JS compiler which folds hasFeature literals and drops dead branches, the native backend which pins target and ABI, and the packager which emits an EBOOT or VPK. Caption: no later stage asks if target equals vita — compatibility is a build result, not an allowlist" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="30" y="14" width="330" height="92" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="195" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">pocket.json — app intent</text>
  <text x="195" y="62" fill="#94a3b8" font-size="11" text-anchor="middle">requires · enhances</text>
  <text x="195" y="80" fill="#94a3b8" font-size="11" text-anchor="middle">logical viewport · presentation</text>
  <rect x="400" y="14" width="330" height="92" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="565" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">target profile — host facts</text>
  <text x="565" y="62" fill="#c4b5fd" font-size="11" text-anchor="middle">HostOps ABI · physical display</text>
  <text x="565" y="80" fill="#c4b5fd" font-size="11" text-anchor="middle">raster density · tested capabilities</text>
  <path d="M195 106 L195 140 L340 140" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M565 106 L565 140 L420 140" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="340" y="122" width="80" height="36" rx="18" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="145" fill="#22d3ee" font-size="12" font-weight="700" text-anchor="middle">resolve</text>
  <text x="380" y="176" fill="#64748b" font-size="10.5" text-anchor="middle">runs exactly once per build</text>
  <path d="M420 140 L560 140 L560 196" stroke="#854d0e" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>
  <path d="M560 196 l-5 -8 M560 196 l5 -8" stroke="#854d0e" stroke-width="1.5" fill="none"/>
  <rect x="452" y="200" width="216" height="40" rx="8" fill="#0b0f1a" stroke="#854d0e" stroke-width="1.5"/>
  <text x="560" y="217" fill="#eab308" font-size="11.5" text-anchor="middle">unmet requires → build fails here,</text>
  <text x="560" y="233" fill="#94a3b8" font-size="10.5" text-anchor="middle">not on a player's screen</text>
  <path d="M380 158 L380 196" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 196 l-5 -8 M380 196 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="180" y="200" width="252" height="62" rx="9" fill="#0e1626" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="306" y="225" fill="#f1f5f9" font-size="12.5" font-weight="700" text-anchor="middle">ResolvedBuildPlan</text>
  <text x="306" y="246" fill="#22d3ee" font-size="10.5" text-anchor="middle">plan.json · small · checksummed</text>
  <path d="M240 262 L120 306" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M120 306 l3 -9 M120 306 l9 -4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M306 262 L306 306" stroke="#475569" stroke-width="1.5"/>
  <path d="M306 306 l-5 -8 M306 306 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M372 262 L492 306" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M492 306 l-9 -4 M492 306 l-3 -9" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="310" width="228" height="84" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="130" y="334" fill="#e2e8f0" font-size="12" font-weight="700" text-anchor="middle">JS compiler</text>
  <text x="130" y="355" fill="#94a3b8" font-size="10.5" text-anchor="middle">hasFeature("…") → true/false</text>
  <text x="130" y="372" fill="#64748b" font-size="10.5" text-anchor="middle">dead branches removed</text>
  <rect x="264" y="310" width="212" height="84" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="370" y="334" fill="#e2e8f0" font-size="12" font-weight="700" text-anchor="middle">native backend</text>
  <text x="370" y="355" fill="#94a3b8" font-size="10.5" text-anchor="middle">Cargo build · target + ABI</text>
  <text x="370" y="372" fill="#64748b" font-size="10.5" text-anchor="middle">verified again at runtime</text>
  <rect x="496" y="310" width="248" height="84" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="620" y="334" fill="#e2e8f0" font-size="12" font-weight="700" text-anchor="middle">packager</text>
  <text x="620" y="355" fill="#94a3b8" font-size="10.5" text-anchor="middle">EBOOT.PBP for PSP · .vpk for Vita</text>
  <text x="620" y="372" fill="#64748b" font-size="10.5" text-anchor="middle">exact app.output artifact names</text>
  <text x="380" y="432" fill="#475569" font-size="11" text-anchor="middle">no later stage asks if (target === "vita") — compatibility is a build result, not an allowlist</text>
</svg>

A PSP-shaped application therefore resolves for Vita **unchanged** when the Vita profile satisfies its requirements and accepts its 480×272 logical viewport — which is exactly how every stock demo, Pocket Figma, and OpenStrike became Vita apps without editing a component. And an app that *requires* `input.touch` fails to resolve for PSP at build time, with a named capability in the error instead of a black screen on a Memory Stick.

What keeps this honest over time is an admission rule, written at the top of the capability registry: a capability id names **stable public behavior an application can observe** — never hardware, never a permission, never an internal wire format. The registry today is four strings: `input.buttons`, `input.analog.left`, `input.touch`, `text.glyphs.baked`. During review we deleted a fifth, `ui.drawlist`, because DrawList is how the core talks to its own renderers — no app can observe it, so no app may request it. And if a future host offers the same API at a meaningfully different execution level, it gets a **new id** rather than a footnote; a capability that silently means "but slow here" is how cross-platform frameworks rot.

Optional capabilities stay honest the same way. `hasFeature` is an ordinary import:

```ts
import { hasFeature } from "@pocketjs/framework/platform";

if (hasFeature("input.analog.left")) {
  installAnalogNavigation();
} else {
  installButtonNavigation();
}
```

For manifest builds the compiler proves the binding is the framework import and the argument is a string literal, then folds the call to `true` or `false` — and Bun removes the dead branch even with minification off. A PSP package carries no Vita-only code merely because the source contains a fallback pair. The transform cache keys include the sorted feature map, so a PSP build can never reuse a Vita bundle's specialization. Alias imports fold; dynamic feature names and shadowed locals named `hasFeature` deliberately stay runtime lookups. It is a small build contract, not a capability-token language — TypeScript still checks the app like any other code.

## The touchscreen kept the promise

The first Vita runtime shipped with the touch panel dark — deliberately. The hardware was sitting right there, but PocketJS had no public touch API, no HostOps delivery, and no tests, so the profile did not advertise `input.touch`. Profiles may not claim what the stock host has not implemented and tested; the port's own docs promised touch would arrive "as framework behavior with manifests, types, native delivery, fallback rules, and tests together — not as `if (vita)` patches."

That is the promise this release keeps. Touch landed as one vertical slice: a public `touches()` snapshot in `@pocketjs/framework/input`, native delivery from the Vita front panel, a HostOps ABI bump from 1 to 2, the `input.touch` registry entry, the profile advertisement, and the tests — in the same change.

```ts
import { touches } from "@pocketjs/framework/input";
import { hasFeature } from "@pocketjs/framework/platform";

if (hasFeature("input.touch")) {
  // Vita: real contacts. PSP builds drop this whole branch.
  for (const contact of touches()) {
    inkAt(contact.x, contact.y); // logical 480×272 coordinates
  }
}
```

The shape of the API is where the density contract pays off twice:

<svg viewBox="0 0 760 332" width="100%" role="img" aria-label="Touch pipeline. Left: the Vita front panel samples a finger on the physical 960 by 544 grid. An arrow labeled divide by rasterDensity leads to the middle: an immutable per-frame snapshot in the logical 480 by 272 space, each contact packed into one u32 as x 9 bits, y 9 bits, id 8 bits, up to 8 contacts. An arrow labeled touches() leads right to application code, where DeepZoom consumes anchored pan and pinch gestures. Below, the PSP row: its profile does not advertise input.touch, hasFeature folds to false, and the controller fallback is what remains in the bundle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="34" width="220" height="150" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="126" y="22" fill="#e2e8f0" font-size="12.5" font-weight="700" text-anchor="middle">front panel · physical</text>
  <rect x="36" y="52" width="180" height="102" rx="6" fill="#111c2e" stroke="#334155"/>
  <circle cx="149" cy="108" r="10" fill="#a78bfa" opacity="0.35"/>
  <circle cx="149" cy="108" r="4" fill="#c4b5fd"/>
  <text x="149" y="132" fill="#c4b5fd" font-size="10" text-anchor="middle">(600, 300)</text>
  <text x="126" y="172" fill="#64748b" font-size="10.5" text-anchor="middle">960×544 sampling grid</text>
  <path d="M236 108 L318 108" stroke="#475569" stroke-width="1.5"/>
  <path d="M318 108 l-8 -5 M318 108 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="277" y="96" fill="#22d3ee" font-size="10.5" text-anchor="middle">÷ density</text>
  <rect x="322" y="34" width="228" height="150" rx="10" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="436" y="22" fill="#e2e8f0" font-size="12.5" font-weight="700" text-anchor="middle">logical snapshot · 480×272</text>
  <text x="436" y="66" fill="#e2e8f0" font-size="12" text-anchor="middle">{ id: 3, x: 300, y: 150 }</text>
  <text x="436" y="94" fill="#22d3ee" font-size="10.5" text-anchor="middle">one u32 per contact:</text>
  <text x="436" y="111" fill="#22d3ee" font-size="10.5" text-anchor="middle">x:9 bits · y:9 bits · id:8 bits</text>
  <text x="436" y="140" fill="#94a3b8" font-size="10.5" text-anchor="middle">≤ 8 contacts · immutable</text>
  <text x="436" y="157" fill="#94a3b8" font-size="10.5" text-anchor="middle">delivered at frame start</text>
  <path d="M550 108 L632 108" stroke="#475569" stroke-width="1.5"/>
  <path d="M632 108 l-8 -5 M632 108 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="591" y="96" fill="#94a3b8" font-size="10.5" text-anchor="middle">touches()</text>
  <rect x="636" y="34" width="108" height="150" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="690" y="22" fill="#e2e8f0" font-size="12.5" font-weight="700" text-anchor="middle">app code</text>
  <text x="690" y="80" fill="#e2e8f0" font-size="11" text-anchor="middle">DeepZoom</text>
  <text x="690" y="100" fill="#94a3b8" font-size="10.5" text-anchor="middle">anchored</text>
  <text x="690" y="116" fill="#94a3b8" font-size="10.5" text-anchor="middle">pan + pinch</text>
  <text x="690" y="150" fill="#64748b" font-size="10.5" text-anchor="middle">no ÷2 in sight</text>
  <rect x="16" y="222" width="728" height="66" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="36" y="246" fill="#f1f5f9" font-size="12" font-weight="700">the PSP row</text>
  <text x="36" y="266" fill="#94a3b8" font-size="11">profile has no input.touch → hasFeature("input.touch") folds to false</text>
  <text x="36" y="282" fill="#94a3b8" font-size="11">→ the controller fallback is the only code left in the EBOOT</text>
  <text x="380" y="318" fill="#475569" font-size="11" text-anchor="middle">applications never see the panel's grid, the density, or the target name — only logical contacts</text>
</svg>

Contacts arrive as an immutable snapshot at the start of each host frame, in **logical viewport pixels** — the host divides by the raster density before the app ever looks, so application code never compensates for the Vita's panel grid. (A 480-wide logical space also happens to fit in 9 bits, which is why a whole contact — position and id — travels as one u32.) Because the snapshot is frame-aligned data rather than an event stream, it obeys [the determinism rules](/blog/ui-runtime-that-cant-flake/) like every other input: tapes record it, replays reproduce it, and a run with no fingers down costs zero bytes.

The first consumer is [`<DeepZoom>`](/blog/pocket-figma/), which now takes anchored gestures: one-finger pan continues with measured inertia after release, and a two-finger pinch zooms around the midpoint of the contacts instead of the screen center. Pocket Figma's Vita test spreads two synthetic fingers to twice their starting distance and asserts the document scale is *exactly* 2.0 around a fixed document center — while the PSP build of the same component keeps its trigger-and-nub controls, minus the touch branch it never shipped.

## Proof beats vibes

"It boots" is not an acceptance criterion for a renderer port. The Vita suite installs a capture VPK into an isolated VitaFS, starts Vita3K, drives the real QuickJS/input/layout loop with deterministic controller tracks, and waits for completion markers written by the guest. Then it checks 44 frames across eleven demos:

- every capture is exactly 960×544 RGBA;
- every frame passes a **native-detail assertion** — physical detail inside logical pixel blocks, proving the render is genuinely density 2 and did not regress to duplicated pixels;
- every texture and font atlas referenced by the production GXM pass is resident;
- all 44 frames match their committed goldens byte-exactly.

One caveat stays visible on purpose: Vita3K's macOS Vulkan path does not give back a coherent GXM framebuffer after presentation, so the pixel oracle is a deterministic CPU renderer inside the capture guest, rasterizing the same DrawList at 960×544. The production vita2d/GXM pass still runs and its resource residency is asserted — but these goldens are not GPU framebuffer dumps, and we will not caption them as if they were. Hardware is no longer unobserved: the release VPKs have now been installed through VitaShell and exercised as named LiveArea bubbles on a physical Vita, including the stock demos and OpenStrike. That run validates packaging, on-device launch, controller input, the exercised flows, and the actual vita2d/GXM presentation path; the capture guest remains the byte-exact pixel oracle. They are complementary proofs, not interchangeable captions.

Real applications shook out what framework demos could not. Pocket Figma contributes seven Vita3K journeys — from fit and zoom through touch pan, pinch, and page switching — and page switching found a genuine landmine: destroying live vita2d textures mid-session could fault inside Vita3K's GXM emulation. The durable fix separates the two lifetimes that a naive port fuses — a *logical texture handle* retires immediately (stale DrawList references keep failing loudly), while its *physical GXM allocation* drops into a same-size recycler for the next upload to overwrite. Handle generations stay correct, GPU churn stays bounded, and neither layer lies about ownership. OpenStrike adds five golden moments plus live Pocket3D scene counters, proving the 3D world submission is not an empty HUD over a black frame — and its right-stick capture test moves yaw while asserting a centered stick drifts by exactly zero.

<img class="w-full rounded-xl border border-line" src="/assets/blog/vita-pocket-talk-960.png" alt="Pocket Talk, the PocketJS IM demo, on PS Vita at 960 by 544: a chat with Maya Chen showing message bubbles with timestamps and read ticks, a text field reading q 1 of 140, and a full on-screen keyboard with controller hints" />

<p class="text-sm text-slate-500 -mt-4">Pocket Talk — the IM demo with an on-screen keyboard and virtual message list — mid-journey on Vita, from the same 44-frame golden suite. Every app in this post installs as its own bubble: Title IDs derive from each manifest's app id, so the demos, Pocket Figma (<code>PFIG00001</code>), and OpenStrike (<code>OPSK00001</code>) coexist on one home screen instead of overwriting a shared test slot.</p>

## One pipeline, two acceptance loops

With [VitaSDK](https://vitasdk.org/) and [Vita3K](https://vita3k.org/) installed, any bundled demo is a one-liner:

```sh
bun play vita hero
bun play vita gallery --fullscreen
bun play --help
```

The runner resolves the Vita plan, compiles the app, builds and validates the VPK, replaces the installed title, restarts a running Vita3K safely, and launches the new build — the same short loop as a browser preview, except the output is a native console package.

The exact same pipeline emits the artifact used for hardware acceptance:

```sh
bun run vita hero --release
# dist/vita/hero-main.vpk — install with VitaShell
```

The remaining gaps are named, because that is the point of the whole system. Dynamic host-shaped text layout is future work; text remains the deterministic baked-glyph contract both profiles advertise. The vita2d/GXM path has residency checks but no automated framebuffer pixel oracle of its own yet. A physical Vita run is no longer on that list: real hardware now covers install, LiveArea identity, boot, production GXM presentation, controller input, and the exercised interactive flows, while Vita3K capture covers deterministic byte-exact frames. Future capabilities will land the way touch did — contract first, capability id if one is owed, tests in the same change — because the architecture has made the ad hoc version *more* work than the honest one. That is the property worth porting.

The build contracts landed in [#98](https://github.com/pocket-nexus/pocketjs/pull/98), the Vita runtime in [#92](https://github.com/pocket-nexus/pocketjs/pull/92), and native density plus touch in [#99](https://github.com/pocket-nexus/pocketjs/pull/99), with downstream proofs in [Pocket Figma](https://github.com/pocket-nexus/pocket-figma/pull/1) and [OpenStrike](https://github.com/pocket-nexus/open-strike/pull/9). If you want the contract rather than the port story, start at [Platform contracts](/docs/platform-contracts/). All of it ships in PocketJS 0.4.0.

One app, two PlayStations, one compatibility answer — and the second screen finally spends its own pixels.

Follow [@pocket_js](https://x.com/pocket_js) for what's next. The pocket keeps getting deeper.
