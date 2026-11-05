<video class="w-full rounded-xl border border-line" autoplay muted loop controls playsinline preload="metadata" crossorigin="anonymous" aria-label="Pocket Figma running on a real PSP">
  <source src="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocket-figma-real-psp-ba960367.mp4" type="video/mp4" />
  <a href="https://x.com/pocket_js/status/2075858786271854894?s=46" target="_blank" rel="noreferrer">Watch Pocket Figma running on a real PSP.</a>
</video>

<p class="text-sm text-slate-500 -mt-4">Pocket Figma running on a real PSP. <a href="https://x.com/pocket_js/status/2075858786271854894?s=46" target="_blank" rel="noreferrer">Watch or share it on X →</a></p>

The Sony PSP is twenty-two years old: 333 MHz, 32 MB of RAM, a GPU with no shaders. For the past weeks we have been teaching it modern UI — our runtime, [PocketJS](/blog/introducing-pocketjs/), runs real Solid and Vue JSX components on it at a locked 60 FPS, and it has already [shipped a 3D shooter](/blog/shipping-openstrike/). But every screen so far was *ours*: our components, our layouts, sized to the machine. The honest test of a 2D UI runtime is a document drawn by someone who never once thought about your hardware — and the most demanding documents in the world come out of **Figma**.

So that became the challenge: open a real Figma Community file, as published. Not a cooked-up demo document — the [Paper Wireframe Kit](https://www.figma.com/community/file/1075811850250564922): 14,430 nodes, 2,293 component instances, a canvas 26,000 pixels wide, hand-drawn Patrick Hand lettering, photos, masks, the works. If the runtime can hold *that*, there is not much 2D left to be afraid of. It worked out better than we expected: you pan with the analog nub and zoom with the shoulder triggers, at 60 FPS, and it ships as one `EBOOT.PBP` you drop on a Memory Stick. We call it **Pocket Figma**.

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-psp-components-zoom.png" alt="Pocket Figma on a PSP at 24% zoom on the kit's Components page: the Tag, Badge, Pagination and Tabs artboards with their dashed component-instance outlines, dot-grid canvas behind them, and the viewer HUD along the bottom" />

<p class="text-sm text-slate-500 -mt-4">Native 480×272 output of the shipping build at 24% zoom, walking the nub up the kit's component artboards. This frame — like every PSP screenshot in this post — is the executable's own framebuffer, captured in the deterministic emulator our byte-exact tests run on.</p>

Pocket Figma is open source at [pocket-nexus/pocket-figma](https://github.com/pocket-nexus/pocket-figma). And like OpenStrike before it, it exists to make a point about architecture: **the device never parses, it only consumes.** A design file is just the most literal possible test of that law, because a design file is nothing *but* things to parse.

This post is the full story: what is actually inside a `.fig` file — down to individual bytes — how you turn a 26,000-pixel-wide canvas into something a fixed-function GPU can stream, and why the whole thing is a pure function of the button mask.

## A .fig file is a database, not a picture

Export any Figma document and you get a `.fig` — a ZIP with a thumbnail, the referenced images, and one opaque blob called `canvas.fig`. That blob opens with the magic bytes `fig-kiwi`, and the name is the first delight of this project: **kiwi** is [Evan Wallace's schema format](https://github.com/evanw/kiwi) — Figma's co-founder wrote the serialization layer, published it as open source, and the file format carries his name in its header. More on him at the end.

The blob is a sequence of length-prefixed compressed chunks — and the compression is sniffed per chunk, not per file: in our kit, chunk 0 is raw deflate while chunk 1 opens with the zstd frame magic. Chunk 0 is a **kiwi binary schema**; chunk 1 is the document, encoded in that schema. Read that again: *the file tells you how to read itself.* You do not chase a version-specific spec — you decode the embedded schema with the kiwi library and get back a typed tree of everything Figma knows about the document. Here is the whole layout, from the ZIP down to a single shape's bytes — every value below is read from the real file:

<svg viewBox="0 0 760 716" width="100%" role="img" aria-label="Byte-level layout of the .fig file: the 22 MB ZIP holds canvas.fig, 44 images, a thumbnail and meta.json. canvas.fig starts with the 8-byte magic fig-kiwi, a u32 version of 101, then length-prefixed chunks: chunk 0 is 28,464 bytes of raw deflate inflating to a 69 KB kiwi schema, chunk 1 is 3,063,219 bytes of zstd inflating to the 9.8 MB document. The decoded document has fields type, sessionID, ackID, nodeChangeOrder, 14,430 nodeChanges and 4,066 blobs. One 46-byte blob is shown byte by byte: command bytes and float32 little-endian coordinates spelling out a 100 by 100 square path" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="16" y="30" fill="#f1f5f9" font-size="13" font-weight="700">Paper Wireframe Kit (Community).fig — a 22 MB ZIP</text>
  <rect x="16" y="44" width="180" height="56" rx="8" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="106" y="68" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">canvas.fig</text>
  <text x="106" y="86" fill="#38bdf8" font-size="10.5" text-anchor="middle">3.1 MB · fig-kiwi</text>
  <rect x="196" y="44" width="330" height="56" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="361" y="68" fill="#e2e8f0" font-size="12" text-anchor="middle">images/ ×44</text>
  <text x="361" y="86" fill="#64748b" font-size="10.5" text-anchor="middle">19.6 MB — the kit's photos</text>
  <rect x="526" y="44" width="130" height="56" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="591" y="68" fill="#e2e8f0" font-size="11" text-anchor="middle">thumbnail.png</text>
  <text x="591" y="86" fill="#64748b" font-size="10.5" text-anchor="middle">14 KB</text>
  <rect x="656" y="44" width="88" height="56" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="700" y="68" fill="#e2e8f0" font-size="11" text-anchor="middle">meta.json</text>
  <text x="700" y="86" fill="#64748b" font-size="10.5" text-anchor="middle">244 B</text>
  <path d="M106 100 L106 124" stroke="#475569" stroke-width="1.5"/>
  <path d="M106 124 l-5 -8 M106 124 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="128" width="728" height="172" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="36" y="152" fill="#f1f5f9" font-size="12.5" font-weight="700">canvas.fig — 8-byte magic · u32 version · length-prefixed chunks</text>
  <rect x="36" y="166" width="220" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="146" y="183" fill="#e2e8f0" font-size="11.5" text-anchor="middle">66 69 67 2d 6b 69 77 69</text>
  <text x="266" y="183" fill="#94a3b8" font-size="11.5">= "fig-kiwi"</text>
  <rect x="390" y="166" width="112" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="446" y="183" fill="#e2e8f0" font-size="11.5" text-anchor="middle">65 00 00 00</text>
  <text x="512" y="183" fill="#94a3b8" font-size="11.5">u32 version = 101</text>
  <rect x="36" y="202" width="112" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="92" y="219" fill="#e2e8f0" font-size="11.5" text-anchor="middle">30 6f 00 00</text>
  <text x="158" y="219" fill="#94a3b8" font-size="11">= 28,464 bytes →</text>
  <rect x="300" y="202" width="190" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="395" y="219" fill="#e2e8f0" font-size="11.5" text-anchor="middle">chunk 0 · raw deflate</text>
  <text x="500" y="219" fill="#22d3ee" font-size="11">→ 69 KB kiwi schema, the decoder ring</text>
  <rect x="36" y="238" width="112" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="92" y="255" fill="#e2e8f0" font-size="11.5" text-anchor="middle">b3 be 2e 00</text>
  <text x="158" y="255" fill="#94a3b8" font-size="11">= 3,063,219 bytes →</text>
  <rect x="300" y="238" width="190" height="26" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="395" y="255" fill="#e2e8f0" font-size="11.5" text-anchor="middle">chunk 1 · zstd 28 b5 2f fd</text>
  <text x="500" y="255" fill="#22d3ee" font-size="11">→ the 9.8 MB document</text>
  <text x="36" y="288" fill="#64748b" font-size="10.5">compression is sniffed per chunk, not per file — this very file mixes raw deflate (chunk 0) and zstd (chunk 1)</text>
  <path d="M380 300 L380 324" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 324 l-5 -8 M380 324 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="328" width="728" height="150" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="36" y="352" fill="#f1f5f9" font-size="12.5" font-weight="700">chunk 1, decoded with the schema from chunk 0</text>
  <text x="36" y="378" fill="#e2e8f0" font-size="11.5">{ type, sessionID, ackID, nodeChangeOrder,</text>
  <text x="36" y="400" fill="#e2e8f0" font-size="11.5">&#160;&#160;nodeChanges: [ ×14,430 ],</text>
  <text x="270" y="400" fill="#94a3b8" font-size="10.5">ELLIPSE 3537 · VECTOR 2410 · INSTANCE 2293 · SYMBOL 1937 · TEXT 1522 …</text>
  <text x="36" y="422" fill="#e2e8f0" font-size="11.5">&#160;&#160;blobs: [ ×4,066 ] }</text>
  <text x="270" y="422" fill="#94a3b8" font-size="10.5">binary geometry + glyph outlines, referenced by index</text>
  <text x="36" y="454" fill="#22d3ee" font-size="11">type · sessionID · ackID — the shape of a live multiplayer update, saved to disk</text>
  <path d="M150 478 L150 502" stroke="#475569" stroke-width="1.5"/>
  <path d="M150 502 l-5 -8 M150 502 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="506" width="728" height="196" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="36" y="530" fill="#f1f5f9" font-size="12.5" font-weight="700">blobs[1] — one shape's fill geometry, all 46 bytes</text>
  <text x="36" y="556" fill="#22d3ee" font-size="11.5" font-weight="700">01</text>
  <text x="70" y="556" fill="#94a3b8" font-size="11.5">00 00 00 00&#160;&#160;00 00 00 00</text>
  <text x="330" y="556" fill="#e2e8f0" font-size="11.5">moveTo 0, 0</text>
  <text x="36" y="576" fill="#22d3ee" font-size="11.5" font-weight="700">02</text>
  <text x="70" y="576" fill="#94a3b8" font-size="11.5">00 00 c8 42&#160;&#160;00 00 00 00</text>
  <text x="330" y="576" fill="#e2e8f0" font-size="11.5">lineTo 100, 0</text>
  <text x="36" y="596" fill="#22d3ee" font-size="11.5" font-weight="700">02</text>
  <text x="70" y="596" fill="#94a3b8" font-size="11.5">00 00 c8 42&#160;&#160;00 00 c8 42</text>
  <text x="330" y="596" fill="#e2e8f0" font-size="11.5">lineTo 100, 100</text>
  <text x="36" y="616" fill="#22d3ee" font-size="11.5" font-weight="700">02</text>
  <text x="70" y="616" fill="#94a3b8" font-size="11.5">00 00 00 00&#160;&#160;00 00 c8 42</text>
  <text x="330" y="616" fill="#e2e8f0" font-size="11.5">lineTo 0, 100</text>
  <text x="36" y="636" fill="#22d3ee" font-size="11.5" font-weight="700">02</text>
  <text x="70" y="636" fill="#94a3b8" font-size="11.5">00 00 00 00&#160;&#160;00 00 00 00</text>
  <text x="330" y="636" fill="#e2e8f0" font-size="11.5">lineTo 0, 0</text>
  <text x="36" y="656" fill="#22d3ee" font-size="11.5" font-weight="700">00</text>
  <text x="330" y="656" fill="#e2e8f0" font-size="11.5">closePath</text>
  <rect x="560" y="556" width="84" height="84" fill="none" stroke="#38bdf8" stroke-width="1.5"/>
  <circle cx="560" cy="556" r="2.5" fill="#22d3ee"/>
  <circle cx="644" cy="556" r="2.5" fill="#22d3ee"/>
  <circle cx="644" cy="640" r="2.5" fill="#22d3ee"/>
  <circle cx="560" cy="640" r="2.5" fill="#22d3ee"/>
  <text x="602" y="658" fill="#64748b" font-size="10.5" text-anchor="middle">100 × 100</text>
  <text x="36" y="686" fill="#64748b" font-size="10.5">u8 command (0 Z · 1 M · 2 L · 3 Q · 4 C) followed by f32 LE coordinates — 00 00 c8 42 is 100.0</text>
</svg>

One field cluster in that middle box deserves a pause. The decoded document's top level is not the shape of a *document format* — `type`, `sessionID`, `ackID` is the shape of a **multiplayer update**. A .fig file reads as a saved sync message: "here is everything that changed," where *everything* happens to be the entire document. The same protocol that lets two designers edit one canvas is what you replay when you open the file.

Here is the discovery that made this project feasible in a weekend rather than a quarter: **Figma bakes its own render into the file.** Every shape node carries `fillGeometry` and `strokeGeometry` — flattened path blobs where strokes have already been outlined into fills, boolean operations already evaluated, dashes already cut. Every text node carries `derivedTextData`: the full text layout, glyph by glyph, each with a *vector outline blob* in em units. We never wrote a stroker, never evaluated a boolean, never loaded a font — the hand-drawn Patrick Hand lettering renders from outlines the file itself provides. The path encoding is almost quaint: one command byte (move/line/quad/cubic/close), then float32 coordinates.

If you build on the web this pattern should feel familiar from the other direction: it is a *lockfile for rendering*. Figma's editor spent real CPU deciding exactly what those shapes look like; the file pins the result; any consumer — including, it turns out, a handheld from 2004 — just replays the answer.

The one thing the file does not hand you is component instances: an `INSTANCE` node is a pointer to its `SYMBOL` plus a list of overrides, and grafting those trees together correctly — a component copied between files keeps its *original* identity in a field called `overrideKey` — was the only real archaeology of the project. With that in place, the whole renderer (decode, expand, rasterize any region at any scale) comes to about 600 lines of TypeScript ([`tools/fig.ts`](https://github.com/pocket-nexus/pocket-figma/blob/main/tools/fig.ts)) plus a canvas library, and it reproduces every page of the kit pixel-close to Figma's own thumbnails. That was the checkpoint where this stopped being archaeology and became a build pipeline.

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-welcome-page.png" alt="The Paper Kit Welcome page rendered by tools/fig.ts: the Wireframe PAPER KIT cover with dozens of wireframe components, and six white document cards with illustrations, text and forms" />

<p class="text-sm text-slate-500 -mt-4">The kit's Welcome page, rendered entirely by our decoder from the file's own derived geometry — instances expanded, masks applied, glyph outlines filled. No Figma runtime, no fonts, no network.</p>

## A bundler for design files

Now the PSP part. The naive plan — ship the vectors, tessellate on device — dies on arithmetic: tens of thousands of antialiased paths per screen against a 333 MHz in-order CPU with no JavaScript JIT. The honest plan is the one every map application converged on: **rasterize offline into a tile pyramid, stream tiles on demand.** Google Maps, for wireframes, on a PSP.

So Pocket Figma's build step is a cooker, exactly parallel to [OpenStrike's](/blog/shipping-openstrike/) `pocket3d-cook`, and it bakes just as aggressively:

<svg viewBox="0 0 760 348" width="100%" role="img" aria-label="Pipeline diagram: the .fig file flows into fig.ts (kiwi-decode the embedded schema, expand 2,293 instances, rasterize pages in strips) then into the tile cooker (one 256-color palette per page, classify tiles as background, solid or textured, PackBits-RLE the indices, dedupe identical tiles), producing four TILESET pyramids totaling 5.9 MB which are linked into the EBOOT" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="96" width="180" height="112" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="106" y="124" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PaperKit.fig</text>
  <text x="106" y="143" fill="#94a3b8" font-size="11" text-anchor="middle">fig-kiwi · 22 MB</text>
  <text x="106" y="164" fill="#94a3b8" font-size="11" text-anchor="middle">14,430 nodes</text>
  <text x="106" y="183" fill="#64748b" font-size="10.5" text-anchor="middle">carries its own schema</text>
  <path d="M196 152 L228 152" stroke="#475569" stroke-width="1.5"/>
  <path d="M228 152 l-8 -5 M228 152 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="234" y="40" width="240" height="224" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="354" y="66" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">tools/fig.ts</text>
  <text x="354" y="84" fill="#38bdf8" font-size="11" text-anchor="middle">build time, on your laptop</text>
  <text x="252" y="112" fill="#94a3b8" font-size="11.5">· decode via the embedded schema</text>
  <text x="252" y="134" fill="#94a3b8" font-size="11.5">· expand 2,293 instances</text>
  <text x="252" y="156" fill="#94a3b8" font-size="11.5">  (overrideKey remap · masks)</text>
  <text x="252" y="178" fill="#94a3b8" font-size="11.5">· fills + strokes + glyphs from</text>
  <text x="252" y="200" fill="#94a3b8" font-size="11.5">  the file's derived geometry</text>
  <text x="252" y="222" fill="#94a3b8" font-size="11.5">· rasterize pages in strips</text>
  <text x="252" y="248" fill="#64748b" font-size="10.5">a ladder of halving scales per page</text>
  <path d="M474 152 L506 152" stroke="#475569" stroke-width="1.5"/>
  <path d="M506 152 l-8 -5 M506 152 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="512" y="40" width="232" height="224" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="628" y="66" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">tile cooker</text>
  <text x="628" y="84" fill="#22d3ee" font-size="11" text-anchor="middle">TILESET pyramids · 'PKTS'</text>
  <text x="530" y="112" fill="#94a3b8" font-size="11.5">· one 256-color CLUT per page</text>
  <text x="530" y="134" fill="#94a3b8" font-size="11.5">· classify: bg / solid / textured</text>
  <text x="530" y="156" fill="#94a3b8" font-size="11.5">· PackBits-RLE the indices</text>
  <text x="530" y="178" fill="#94a3b8" font-size="11.5">· dedupe identical tiles</text>
  <text x="530" y="204" fill="#e2e8f0" font-size="11">Welcome 0.8 MB · Components 1.9</text>
  <text x="530" y="222" fill="#e2e8f0" font-size="11">Stickers 0.2 · Examples 3.1</text>
  <text x="530" y="248" fill="#64748b" font-size="10.5">= 5.9 MB, four pages, committed</text>
  <path d="M628 264 L628 292" stroke="#475569" stroke-width="1.5"/>
  <text x="380" y="316" fill="#94a3b8" font-size="11.5" text-anchor="middle">linked into the EBOOT — tiles decode straight out of read-only memory; nothing is ever “loaded”</text>
  <text x="380" y="338" fill="#475569" font-size="11" text-anchor="middle">same ideology as the Tailwind→binary style table, the font atlases, and OpenStrike's .p3d — moved cost is free cost</text>
</svg>

Three cooker decisions carry most of the weight:

- **CLUT8, one palette per page.** Tiles are 8-bit indices into a 256-color palette — 4× smaller than RGBA before compression, and the format the PSP's GPU natively samples through its hardware color-lookup table. A paper wireframe kit is nearly monochrome; 256 colors per page is generous enough to hold the photos too.
- **Whitespace is a directory entry, not pixels.** A wireframe page is *mostly* nothing — paper background and flat card fills. The cooker classifies every tile: background tiles vanish entirely, uniform-color tiles become a 4-byte "solid" marker in the tile directory, and only tiles with actual ink get a pixel stream (run-length encoded, because flat fills compress brutally).
- **The zoom ladder is capped per page.** Each page bakes at halving scales from a chosen maximum — 100% where small labels justify it (the Components sheet), 50% where they don't (the poster-sized Examples wall) — down to a level that fits one screen.

The classification is worth seeing, because it is the whole memory story in one image:

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-tile-grid.png" alt="The Examples page overlaid with its finest-level tile grid: blue tiles cover the phone wireframes (textured), yellow tiles cover the white section backgrounds (solid), unshaded tiles are page background" />

<p class="text-sm text-slate-500 -mt-4">The Examples page — sixteen sections of phone mockups on a 52×21 tile grid at the finest zoom level. <span style="color:#38bdf8">Blue</span> tiles carry pixels (615). <span style="color:#eab308">Yellow</span> tiles are solid colors — a directory entry, zero texture memory (441). Unshaded is page background (36). 44% of the sharpest level of the busiest page costs nothing to draw.</p>

## Streaming a canvas through 2 MB of VRAM

At runtime the viewer is a new PocketJS component, **`<DeepZoom>`**, and underneath it, the engine grew the plumbing every deep-zoom canvas needs — which was the real agenda all along. Pocket Figma is the first consumer; the machinery is generic.

<svg viewBox="0 0 760 456" width="100%" role="img" aria-label="Exploded view of the DeepZoom component as three stacked layers, painted bottom to top. Bottom: the overview world, the coarsest level pinned underneath, drawn blurry. Middle: the active world, the mip level matching the zoom, where some tiles are resident with blue borders, some are mounted blank with dashed borders, and a bottom row of yellow solid tiles never loads textures. Top: the viewport, a hatched frame that clips and never moves; its window is projected onto the active layer as a thin outline whose top-right corner lands exactly on the blank tile. An arrow labeled clipped composite points to the resulting PSP screen: sharp where tiles have streamed, one corner still soft where a tile is streaming, never a hole. Notes: loadTileTexture decodes RLE to CLUT8 straight from the EBOOT read-only data with no JS-heap transit, the GE samples through its 256-entry palette, and each frame writes only translateX, translateY and scale per world" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <defs>
    <filter id="dzb1" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="dzb2" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.7"/></filter>
    <g id="dzart">
      <rect x="-40" y="-40" width="320" height="124" fill="#ece9e1"/>
      <rect x="-40" y="84" width="320" height="120" fill="#f3ead1"/>
      <rect x="8" y="8" width="56" height="36" rx="3" fill="#fbfaf7" stroke="#a7abb3" stroke-width="1.2"/>
      <circle cx="20" cy="20" r="5" fill="none" stroke="#a7abb3" stroke-width="1.2"/>
      <line x1="30" y1="17" x2="56" y2="17" stroke="#b9bdc4" stroke-width="2.2"/>
      <line x1="30" y1="24" x2="50" y2="24" stroke="#cdd0d5" stroke-width="2.2"/>
      <line x1="13" y1="35" x2="58" y2="35" stroke="#cdd0d5" stroke-width="2.2"/>
      <rect x="74" y="6" width="64" height="42" rx="3" fill="#fbfaf7" stroke="#a7abb3" stroke-width="1.2"/>
      <path d="M79 42 L94 26 L104 36 L112 28 L133 44" stroke="#b9bdc4" stroke-width="1.6" fill="none"/>
      <circle cx="88" cy="17" r="4.5" stroke="#b9bdc4" stroke-width="1.4" fill="none"/>
      <rect x="8" y="54" width="70" height="5" fill="#8b8f97"/>
      <rect x="8" y="65" width="56" height="3.2" fill="#c6cad0"/>
      <rect x="8" y="72" width="62" height="3.2" fill="#c6cad0"/>
      <rect x="86" y="62" width="34" height="13" rx="6.5" fill="none" stroke="#8b8f97" stroke-width="1.4"/>
      <rect x="150" y="50" width="40" height="30" rx="4" fill="#fbfaf7" stroke="#a7abb3" stroke-width="1.2"/>
      <line x1="156" y1="59" x2="184" y2="59" stroke="#b9bdc4" stroke-width="2.2"/>
      <line x1="156" y1="66" x2="178" y2="66" stroke="#cdd0d5" stroke-width="2.2"/>
      <line x1="156" y1="73" x2="181" y2="73" stroke="#cdd0d5" stroke-width="2.2"/>
    </g>
    <pattern id="dzh" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="9" stroke="#f1f5f9" stroke-width="1" opacity="0.07"/></pattern>
    <clipPath id="dzovc"><rect x="0" y="0" width="320" height="124"/></clipPath>
    <clipPath id="dzact"><rect x="64" y="0" width="64" height="64"/><rect x="128" y="0" width="64" height="64"/><rect x="64" y="64" width="64" height="64"/><rect x="128" y="64" width="64" height="64"/><rect x="192" y="64" width="64" height="64"/></clipPath>
    <clipPath id="dzscr"><rect x="0" y="0" width="240" height="120"/></clipPath>
    <clipPath id="dzcor"><rect x="160" y="0" width="80" height="60"/></clipPath>
  </defs>
  <!-- GE paint order -->
  <path d="M24 414 L24 60" stroke="#475569" stroke-width="1.5"/>
  <path d="M24 60 l-5 9 M24 60 l5 9" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="18" y="240" transform="rotate(-90 18 240)" text-anchor="middle" fill="#475569" font-size="10">GE paints bottom → top</text>
  <!-- ============ overview world (bottom layer) ============ -->
  <g transform="translate(52,296) matrix(1,-0.12,0,1,0,0)">
    <g clip-path="url(#dzovc)">
      <g transform="translate(-6,4) scale(1.35)"><use href="#dzart" filter="url(#dzb1)"/></g>
    </g>
    <rect x="0" y="0" width="320" height="124" fill="none" stroke="#2b3a55"/>
  </g>
  <!-- ============ active world (middle layer) ============ -->
  <g transform="translate(36,168) matrix(1,-0.12,0,1,0,0)">
    <g clip-path="url(#dzact)">
      <g transform="translate(-10,-8) scale(1.6)"><use href="#dzart"/></g>
    </g>
    <rect x="0" y="128" width="320" height="22" fill="#f3ead1"/>
    <g fill="none" stroke="#38bdf8" stroke-width="1.5">
      <rect x="65" y="1" width="62" height="62"/><rect x="129" y="1" width="62" height="62"/>
      <rect x="65" y="65" width="62" height="62"/><rect x="129" y="65" width="62" height="62"/><rect x="193" y="65" width="62" height="62"/>
    </g>
    <g fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 3">
      <rect x="1" y="1" width="62" height="62"/><rect x="193" y="1" width="62" height="62"/><rect x="257" y="1" width="62" height="62"/>
      <rect x="1" y="65" width="62" height="62"/><rect x="257" y="65" width="62" height="62"/>
    </g>
    <text x="224" y="29" fill="#64748b" font-size="8.5" text-anchor="middle">blank until</text>
    <text x="224" y="40" fill="#64748b" font-size="8.5" text-anchor="middle">streamed</text>
    <g fill="none" stroke="#eab308" stroke-width="1.5">
      <rect x="1" y="129" width="62" height="20"/><rect x="65" y="129" width="62" height="20"/><rect x="129" y="129" width="62" height="20"/><rect x="193" y="129" width="62" height="20"/><rect x="257" y="129" width="62" height="20"/>
    </g>
    <rect x="0" y="0" width="320" height="150" fill="none" stroke="#2b3a55"/>
    <rect x="64" y="16" width="192" height="96" fill="none" stroke="#f1f5f9" stroke-width="1.2" opacity="0.7"/>
  </g>
  <path d="M88 144 L100 176.3 M280 121 L292 153.3" stroke="#f1f5f9" stroke-width="1" stroke-dasharray="3 3" opacity="0.55" fill="none"/>
  <!-- ============ viewport (top layer) ============ -->
  <g transform="translate(88,48) matrix(1,-0.12,0,1,0,0)">
    <rect x="0" y="0" width="192" height="96" fill="url(#dzh)" stroke="#f1f5f9" stroke-width="1.8"/>
    <path d="M0 14 L0 0 L14 0 M178 0 L192 0 L192 14 M0 82 L0 96 L14 96 M178 96 L192 96 L192 82" stroke="#f1f5f9" stroke-width="3" fill="none" opacity="0.6"/>
  </g>
  <!-- ============ composite arrow ============ -->
  <path d="M392 228 L462 228" stroke="#475569" stroke-width="1.5"/>
  <path d="M462 228 l-9 -5 M462 228 l-9 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="427" y="218" fill="#94a3b8" font-size="10" text-anchor="middle">clipped</text>
  <text x="427" y="244" fill="#94a3b8" font-size="10" text-anchor="middle">composite</text>
  <!-- ============ the screen (result) ============ -->
  <g transform="translate(472,160)">
    <g clip-path="url(#dzscr)">
      <g transform="translate(-92.5,-30) scale(2)"><use href="#dzart"/></g>
      <g clip-path="url(#dzcor)">
        <g transform="translate(-92.5,-30) scale(2)"><use href="#dzart" filter="url(#dzb2)"/></g>
      </g>
    </g>
    <rect x="161" y="1" width="78" height="58" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 3"/>
    <rect x="164" y="36" width="70" height="16" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="199" y="47" fill="#22d3ee" font-size="9" text-anchor="middle">streaming…</text>
    <rect x="0" y="0" width="240" height="120" fill="none" stroke="#475569" stroke-width="1.5"/>
  </g>
  <text x="592" y="304" fill="#94a3b8" font-size="10.5" text-anchor="middle">what the screen shows: sharp where streamed,</text>
  <text x="592" y="319" fill="#94a3b8" font-size="10.5" text-anchor="middle">soft where not — never a hole</text>
  <text x="592" y="346" fill="#64748b" font-size="10" text-anchor="middle">loadTileTexture: RLE → CLUT8 decoded straight</text>
  <text x="592" y="360" fill="#64748b" font-size="10" text-anchor="middle">from the EBOOT's read-only data, no JS-heap transit;</text>
  <text x="592" y="374" fill="#64748b" font-size="10" text-anchor="middle">the GE samples through its 256-entry palette</text>
  <rect x="96" y="54" width="188" height="17" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="104" y="66" fill="#e2e8f0" font-size="10">viewport — clips, never moves</text>
  <rect x="44" y="174" width="196" height="17" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="52" y="186" fill="#22d3ee" font-size="10">active world — tiles stream in</text>
  <rect x="64" y="344" width="200" height="17" rx="7" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="72" y="356" fill="#94a3b8" font-size="10">overview world — pinned, blurry</text>
  <!-- ============ per-frame contract ============ -->
  <text x="380" y="440" fill="#475569" font-size="10.5" text-anchor="middle">per frame: three paint-only writes per world — translateX · translateY · scale — native-ticked, no relayout</text>
</svg>

A few of these layers deserve a sentence. Tile churn is the fastest way to discover why texture handles need **generations**: pan for ten seconds and hundreds of textures are created and freed; a stale handle that silently pointed at a *recycled slot* would paint the wrong tile somewhere on screen, rarely, unreproducibly. Generation-tagged handles (the same trick PocketJS node ids already use) turn that whole bug class into "draws nothing." The **streaming budget** — two tile decodes per frame, nearest-to-center first — keeps the worst frame bounded; the pinned overview underneath means the cost of not-yet-streamed is *blur*, not blankness. And **bilinear filtering** is per-texture opt-in: the rest of PocketJS stays on nearest sampling (its byte-exact goldens depend on it), while tiles get the GE's free smooth minification between mip levels.

The result, on hardware whose entire video memory is 2 MB: a 26,000-pixel-wide artboard you can sweep across with the nub while the mip ladder swaps under your thumb.

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-psp-fit.png" alt="Pocket Figma on PSP showing the whole Welcome page fit to screen at 8% zoom: the cover and six document cards, with the HUD reading Welcome, the controls hint, and 8%" />

<p class="text-sm text-slate-500 -mt-4">Frame 0 on the PSP: the Welcome page fit-to-screen at 8%. Every visible tile streamed from read-only memory during boot; the HUD is ordinary PocketJS text nodes.</p>

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-psp-components-fit.png" alt="Pocket Figma on PSP showing the whole Components page fit to screen at 3% zoom: a long row of wireframe artboards crossing the canvas, with the HUD reading Components and 3%" />

<p class="text-sm text-slate-500 -mt-4">Press TRIANGLE and the Components page fits at 3%, which is what 26,000 pixels of canvas look like on a 480-pixel panel. Every artboard in that row is a tile pyramid the viewer can descend into.</p>

<img class="w-full rounded-xl border border-line" src="/assets/blog/figma-sim-calendar.png" alt="The viewer at 100% zoom on the kit's calendar component: JANUARY 20.., weekday headers M T W Th and handwritten dates, dot-grid background on the left" />

<p class="text-sm text-slate-500 -mt-4">100% zoom on the kit's calendar component — Patrick Hand digits from the file's own glyph outlines, antialiased at bake time, CLUT-sampled at runtime. This capture is from the wasm reference rasterizer; the PSP's GE output of the same frame differs only in its bilinear rounding.</p>

## Anatomy of a zoom

Hold the right trigger and the zoom multiplies by 1.035 every 1/60 s tick — about ×2 per third of a second. Here is the surprise: while that happens, *almost nothing happens*. No tile mounts, no texture loads; the frame writes one `scale` prop per world and the GE redraws the same quads larger. Pan and zoom inside a level are pure transform — the machinery only wakes up at the boundaries.

The baked levels sit at ×2 spacing, and the viewer always shows **the finest level that still downscales on screen**: a tile is drawn somewhere between 50% and 100% of its baked size, the range where bilinear minification looks clean and never has to invent pixels. When the zoom crosses a level boundary the "ideal" level changes — but the switch waits for **eight consecutive frames** of agreement, because a zoom that settles right on a boundary would otherwise thrash a remount every frame. Then it commits, brutally: every tile in the active world unmounts, every texture frees, and the new level mounts its window from scratch. The screen never shows the brutality — the pinned overview world is still underneath, so the worst case is a beat of blur while the new level streams back in, center-out, two tiles a frame.

Here is that gesture as the screen experiences it — the same viewport, four moments apart:

<svg viewBox="0 0 760 224" width="100%" role="img" aria-label="Four snapshots of the same viewport during a zoom across a level boundary. Panel one, cruising: the tile grid of level L with every textured tile resident (blue borders) and a bottom row of solid color tiles (yellow). Panel two, trigger held: the same tiles simply drawn larger by one scale write, zero loads, while the ideal level change is being debounced. Panel three, the level switch: the finer level mounts blank with the blurred overview showing through dashed tiles, numbered badges show the center-out stream order, solid tiles appear instantly, two loads per frame. Panel four, twenty frames later: every tile resident again, a dashed ring outside the viewport marks the prefetch ring, tiles left behind are already freed" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <defs>
    <filter id="zb" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.7"/></filter>
    <filter id="zb0" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.35"/></filter>
    <clipPath id="pv"><rect x="0" y="0" width="168" height="96"/></clipPath>
    <g id="art">
      <rect x="-40" y="-40" width="320" height="124" fill="#ece9e1"/>
      <rect x="-40" y="84" width="320" height="120" fill="#f3ead1"/>
      <rect x="8" y="8" width="56" height="36" rx="3" fill="#fbfaf7" stroke="#a7abb3" stroke-width="1.2"/>
      <circle cx="20" cy="20" r="5" fill="none" stroke="#a7abb3" stroke-width="1.2"/>
      <line x1="30" y1="17" x2="56" y2="17" stroke="#b9bdc4" stroke-width="2.2"/>
      <line x1="30" y1="24" x2="50" y2="24" stroke="#cdd0d5" stroke-width="2.2"/>
      <line x1="13" y1="35" x2="58" y2="35" stroke="#cdd0d5" stroke-width="2.2"/>
      <rect x="74" y="6" width="64" height="42" rx="3" fill="#fbfaf7" stroke="#a7abb3" stroke-width="1.2"/>
      <path d="M79 42 L94 26 L104 36 L112 28 L133 44" stroke="#b9bdc4" stroke-width="1.6" fill="none"/>
      <circle cx="88" cy="17" r="4.5" stroke="#b9bdc4" stroke-width="1.4" fill="none"/>
      <rect x="8" y="54" width="70" height="5" fill="#8b8f97"/>
      <rect x="8" y="65" width="56" height="3.2" fill="#c6cad0"/>
      <rect x="8" y="72" width="62" height="3.2" fill="#c6cad0"/>
      <rect x="86" y="62" width="34" height="13" rx="6.5" fill="none" stroke="#8b8f97" stroke-width="1.4"/>
      <rect x="150" y="50" width="40" height="30" rx="4" fill="#fbfaf7" stroke="#a7abb3" stroke-width="1.2"/>
      <line x1="156" y1="59" x2="184" y2="59" stroke="#b9bdc4" stroke-width="2.2"/>
      <line x1="156" y1="66" x2="178" y2="66" stroke="#cdd0d5" stroke-width="2.2"/>
      <line x1="156" y1="73" x2="181" y2="73" stroke="#cdd0d5" stroke-width="2.2"/>
    </g>
  </defs>
  <!-- panel titles -->
  <text x="100" y="28" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">1 · cruising</text>
  <text x="286" y="28" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">2 · trigger held</text>
  <text x="472" y="28" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">3 · the level switch</text>
  <text x="658" y="28" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">4 · twenty frames later</text>
  <!-- ===================== panel 1: cruising, level L ===================== -->
  <g transform="translate(16,36)" clip-path="url(#pv)">
    <use href="#art"/>
    <g stroke="#00000022" stroke-width="1">
      <line x1="42" y1="0" x2="42" y2="96"/><line x1="84" y1="0" x2="84" y2="96"/><line x1="126" y1="0" x2="126" y2="96"/>
      <line x1="0" y1="42" x2="168" y2="42"/><line x1="0" y1="84" x2="168" y2="84"/>
    </g>
    <g fill="none" stroke="#38bdf8" stroke-width="1.5">
      <rect x="1" y="1" width="40" height="40"/><rect x="43" y="1" width="40" height="40"/><rect x="85" y="1" width="40" height="40"/>
      <rect x="1" y="43" width="40" height="40"/><rect x="43" y="43" width="40" height="40"/><rect x="85" y="43" width="40" height="40"/><rect x="127" y="43" width="40" height="40"/>
    </g>
    <g fill="none" stroke="#eab308" stroke-width="1.5">
      <rect x="1" y="85" width="40" height="10"/><rect x="43" y="85" width="40" height="10"/><rect x="85" y="85" width="40" height="10"/><rect x="127" y="85" width="40" height="10"/>
    </g>
  </g>
  <rect x="16" y="36" width="168" height="96" fill="none" stroke="#475569"/>
  <!-- ===================== panel 2: zoomed 1.9x, same level ===================== -->
  <g transform="translate(202,36)" clip-path="url(#pv)">
    <g transform="translate(-75.6,-85) scale(1.9)"><use href="#art" filter="url(#zb0)"/></g>
    <g stroke="#00000022" stroke-width="1">
      <line x1="4.2" y1="0" x2="4.2" y2="96"/><line x1="84" y1="0" x2="84" y2="96"/><line x1="163.8" y1="0" x2="163.8" y2="96"/>
      <line x1="0" y1="74.6" x2="168" y2="74.6"/>
    </g>
    <g fill="none" stroke="#38bdf8" stroke-width="1.5">
      <rect x="5.2" y="-4.2" width="77.8" height="77.8"/><rect x="85" y="-4.2" width="77.8" height="77.8"/>
    </g>
    <g fill="none" stroke="#eab308" stroke-width="1.5">
      <rect x="5.2" y="75.6" width="77.8" height="19"/><rect x="85" y="75.6" width="77.8" height="19"/>
    </g>
  </g>
  <rect x="202" y="36" width="168" height="96" fill="none" stroke="#475569"/>
  <rect x="300" y="42" width="64" height="16" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="332" y="53" fill="#22d3ee" font-size="9" text-anchor="middle">0 loads</text>
  <!-- ===================== panel 3: switch committed, level L+1 ===================== -->
  <g transform="translate(388,36)" clip-path="url(#pv)">
    <g transform="translate(-75.6,-85) scale(1.9)" opacity="0.9"><use href="#art" filter="url(#zb)"/></g>
    <!-- two resident tiles drawn sharp -->
    <g clip-path="url(#c3a)"><g transform="translate(-75.6,-85) scale(1.9)"><use href="#art"/></g></g>
    <g clip-path="url(#c3b)"><g transform="translate(-75.6,-85) scale(1.9)"><use href="#art"/></g></g>
    <!-- solid row mounts instantly: flat color, sharp -->
    <rect x="0" y="74.6" width="168" height="21.4" fill="#f3ead1"/>
    <g stroke="#00000022" stroke-width="1">
      <line x1="4.2" y1="0" x2="4.2" y2="96"/><line x1="44.1" y1="0" x2="44.1" y2="96"/><line x1="84" y1="0" x2="84" y2="96"/><line x1="123.9" y1="0" x2="123.9" y2="96"/><line x1="163.8" y1="0" x2="163.8" y2="96"/>
      <line x1="0" y1="34.7" x2="168" y2="34.7"/><line x1="0" y1="74.6" x2="168" y2="74.6"/>
    </g>
    <!-- blank mounted tiles: dashed -->
    <g fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 3">
      <rect x="5.2" y="0.8" width="37.9" height="32.9"/><rect x="45.1" y="0.8" width="37.9" height="32.9"/><rect x="85" y="0.8" width="37.9" height="32.9"/><rect x="124.9" y="0.8" width="37.9" height="32.9"/>
      <rect x="5.2" y="35.7" width="37.9" height="37.9"/><rect x="124.9" y="35.7" width="37.9" height="37.9"/>
    </g>
    <!-- resident tiles: solid blue -->
    <g fill="none" stroke="#38bdf8" stroke-width="1.5">
      <rect x="45.1" y="35.7" width="37.9" height="37.9"/><rect x="85" y="35.7" width="37.9" height="37.9"/>
    </g>
    <!-- solid tiles: yellow -->
    <g fill="none" stroke="#eab308" stroke-width="1.5">
      <rect x="5.2" y="75.6" width="37.9" height="19.4"/><rect x="45.1" y="75.6" width="37.9" height="19.4"/><rect x="85" y="75.6" width="37.9" height="19.4"/><rect x="124.9" y="75.6" width="37.9" height="19.4"/>
    </g>
    <!-- queue order badges, center-out -->
    <g font-size="9" font-weight="700" text-anchor="middle">
      <circle cx="64" cy="17.3" r="7" fill="#0b0f1a" stroke="#22d3ee"/><text x="64" y="20.5" fill="#22d3ee">1</text>
      <circle cx="104" cy="17.3" r="7" fill="#0b0f1a" stroke="#22d3ee"/><text x="104" y="20.5" fill="#22d3ee">2</text>
      <circle cx="24.2" cy="54.6" r="7" fill="#0b0f1a" stroke="#22d3ee"/><text x="24.2" y="57.8" fill="#22d3ee">3</text>
      <circle cx="143.9" cy="54.6" r="7" fill="#0b0f1a" stroke="#22d3ee"/><text x="143.9" y="57.8" fill="#22d3ee">4</text>
      <circle cx="24.2" cy="17.3" r="7" fill="#0b0f1a" stroke="#22d3ee"/><text x="24.2" y="20.5" fill="#22d3ee">5</text>
      <circle cx="143.9" cy="17.3" r="7" fill="#0b0f1a" stroke="#22d3ee"/><text x="143.9" y="20.5" fill="#22d3ee">6</text>
    </g>
  </g>
  <rect x="388" y="36" width="168" height="96" fill="none" stroke="#475569"/>
  <rect x="474" y="118" width="76" height="16" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="512" y="129" fill="#22d3ee" font-size="9" text-anchor="middle">2 loads/frame</text>
  <defs>
    <clipPath id="c3a"><rect x="44.1" y="34.7" width="39.9" height="39.9"/></clipPath>
    <clipPath id="c3b"><rect x="84" y="34.7" width="39.9" height="39.9"/></clipPath>
  </defs>
  <!-- ===================== panel 4: settled ===================== -->
  <g transform="translate(574,36)">
    <g clip-path="url(#pv)">
      <g transform="translate(-75.6,-85) scale(1.9)"><use href="#art"/></g>
      <g stroke="#00000022" stroke-width="1">
        <line x1="4.2" y1="0" x2="4.2" y2="96"/><line x1="44.1" y1="0" x2="44.1" y2="96"/><line x1="84" y1="0" x2="84" y2="96"/><line x1="123.9" y1="0" x2="123.9" y2="96"/><line x1="163.8" y1="0" x2="163.8" y2="96"/>
        <line x1="0" y1="34.7" x2="168" y2="34.7"/><line x1="0" y1="74.6" x2="168" y2="74.6"/>
      </g>
      <g fill="none" stroke="#38bdf8" stroke-width="1.5">
        <rect x="5.2" y="0.8" width="37.9" height="32.9"/><rect x="45.1" y="0.8" width="37.9" height="32.9"/><rect x="85" y="0.8" width="37.9" height="32.9"/><rect x="124.9" y="0.8" width="37.9" height="32.9"/>
        <rect x="5.2" y="35.7" width="37.9" height="37.9"/><rect x="45.1" y="35.7" width="37.9" height="37.9"/><rect x="85" y="35.7" width="37.9" height="37.9"/><rect x="124.9" y="35.7" width="37.9" height="37.9"/>
      </g>
      <g fill="none" stroke="#eab308" stroke-width="1.5">
        <rect x="5.2" y="75.6" width="37.9" height="19.4"/><rect x="45.1" y="75.6" width="37.9" height="19.4"/><rect x="85" y="75.6" width="37.9" height="19.4"/><rect x="124.9" y="75.6" width="37.9" height="19.4"/>
      </g>
    </g>
    <rect x="-6" y="-6" width="180" height="108" fill="none" stroke="#475569" stroke-dasharray="4 3"/>
  </g>
  <rect x="574" y="36" width="168" height="96" fill="none" stroke="#475569"/>
  <!-- captions -->
  <g fill="#94a3b8" font-size="9.5" text-anchor="middle">
    <text x="100" y="150">level L drawn at ~80% —</text>
    <text x="100" y="162">every textured tile resident</text>
    <text x="100" y="174">bottom row: solid tiles</text>
    <text x="286" y="150">one scale write per frame:</text>
    <text x="286" y="162">same quads, drawn at 190%</text>
    <text x="286" y="174">ideal changed — debounce 6/8</text>
    <text x="472" y="150">L+1 mounts blank; overview</text>
    <text x="472" y="162">blurs through; solids appear</text>
    <text x="472" y="174">instantly — no texture</text>
    <text x="658" y="150">all resident; dashed ring =</text>
    <text x="658" y="162">prefetch, mounted off-screen</text>
    <text x="658" y="174">tiles left behind: freed</text>
  </g>
  <g stroke="#475569" stroke-width="1.5" fill="none">
    <path d="M187 84 L199 84"/><path d="M199 84 l-6 -4 M199 84 l-6 4"/>
    <path d="M373 84 L385 84"/><path d="M385 84 l-6 -4 M385 84 l-6 4"/>
    <path d="M559 84 L571 84"/><path d="M571 84 l-6 -4 M571 84 l-6 4"/>
  </g>
  <!-- legend -->
  <g font-size="9.5" fill="#94a3b8">
    <rect x="46" y="196" width="11" height="11" fill="none" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="63" y="205">resident texture</text>
    <rect x="186" y="196" width="11" height="11" fill="#f3ead1" stroke="#eab308" stroke-width="1.5"/>
    <text x="203" y="205">solid — never streams</text>
    <rect x="356" y="196" width="11" height="11" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3 2"/>
    <text x="373" y="205">blank — overview shows through</text>
    <circle cx="588" cy="201.5" r="6.5" fill="#0b0f1a" stroke="#22d3ee"/>
    <text x="588" y="204.7" fill="#22d3ee" font-size="8.5" text-anchor="middle" font-weight="700">1</text>
    <text x="600" y="205">stream order</text>
  </g>
</svg>

The bookkeeping behind that picture is deliberately small: a map of mounted tiles keyed by tile index, the stream queue, and the current window rectangle — the visible tile range plus a one-tile prefetch ring. Each frame recomputes the window from the view center and zoom, and only when it *changes* does any mounting work happen: tiles that left are freed on the spot, tiles that entered mount blank, and the queue re-sorts by distance from the view center so the pixels you are looking at arrive first. A blank tile costs a node and nothing else; its 64 KB texture streams in from read-only memory when its turn comes. The resident set is therefore bounded by the window — about two dozen textures at PSP screen size — no matter how far you wander, and a page switch is just the same reset the level switch already rehearses every time you zoom through a boundary.

## Time is still an input

Everything above obeys [the determinism rules](/blog/ui-runtime-that-cant-flake/) — and panning a canvas turned out to be their nicest stress test yet, because it forced a real decision. The analog nub is *new input surface*: the frame contract grew from `frame(buttons)` to `frame(buttons, analog)`, the DevTools flight recorder now tapes the stick alongside the buttons (a centered stick adds zero bytes, so every pre-analog tape replays unchanged), and hosts without a stick just... don't pass one.

The decision was about motion. The obvious pan integrator — "each frame, move by velocity" — quietly breaks the [subsampling theorem](/blog/ui-runtime-that-cant-flake/): a 15 Hz world would pan a quarter the distance per virtual second. `<DeepZoom>` instead integrates **once per 1/60 s tick**, however many ticks the host's clock policy packs into a frame. Our CI drives the same scripted journey — zoom in, nub-pan to the cover, release into the momentum glide — at 60, 15, and 5 Hz, and asserts the settled screens are **byte-identical**. It also re-runs the journey with random sleeps, garbage-collector churn, and allocation pressure injected between frames. Nothing changes. The wall clock is not an input; now the stick is, and it is *recorded*.

The same property is why we could verify the PSP build without owning a fleet of them: the emulator's deterministic software renderer dumps framebuffers, and the byte-exact e2e goldens for every pre-existing PocketJS demo passed unchanged through the entire engine surgery — new texture formats, new ops, a re-keyed GPU cache, a two-argument frame contract. Thirty-five wasm goldens, four PSP demos, zero diffs. That is what let three parallel strands of this work land in one branch without fear.

## What it costs

```text
PSP user RAM                                24.0 MB
├─ executable (engine + QuickJS + bundle
│    + all four tile pyramids)               ~8.9 MB
├─ arena (QuickJS heap, core, resident
│    tile textures ≈ 24 × 65 KB) — budget    ~4 MB
└─ free                                     ~11 MB
frame budget: JS integrator + ≤2 tile decodes + GE ≪ 16.7 ms
```

The shipped `EBOOT.PBP` is 9.1 MB — 6.2 MB of that is the four tile pyramids, and another 150 KB is the XMB art (the backdrop is the kit's own cover, rendered from the .fig). The viewer's per-frame JavaScript is a few hundred microseconds of integrator math plus at most two 64 KB RLE decodes in Rust; the GE draws a screenful of textured quads through its palette and is idle again. This machine has headroom to spare — the interesting ceiling is the Memory Stick's patience for nine-megabyte executables, not the frame.

## Standing in Evan Wallace's world

A closing note, from me personally. Nearly everything this project decoded — the **kiwi** schema language the `.fig` announces itself with, the derived geometry that made a weekend port possible — is Evan Wallace's work. Five years ago, when I was first learning how collaborative apps work, [his write-ups](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) carried me further than anything else I read, and he has been a role model to me ever since: the kind of engineer who answers a hard problem by quietly building the missing piece, then telling everyone exactly how it works. Deeply understanding, and then faithfully reconstructing, a corner of the world he built — with an AI collaborator at my side — has been one of the most beautiful experiences I have had making software.

## Open it

- **[pocket-nexus/pocket-figma](https://github.com/pocket-nexus/pocket-figma)** — MIT. `bun run build` for the bundle, `bun run psp` for the EBOOT (XMB art included — the backdrop is rendered from the .fig itself), `bun run desktop` for a windowed build. The engine layer — TILESET format, streaming ops, `<DeepZoom>` — lives in [PocketJS](https://github.com/pocket-nexus/pocketjs).
- The kit is the [Paper Wireframe Kit by Method](https://www.figma.com/community/file/1075811850250564922) (CC BY 4.0) — the baked tiles are committed; re-baking from the .fig is one command.
- No PSP? PPSSPP runs the EBOOT as-is. Real hardware wants custom firmware and a Memory Stick with 10 MB to spare.

Follow [@pocket_js](https://x.com/pocket_js) for what's next. The pocket keeps getting deeper.
