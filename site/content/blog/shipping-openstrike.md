Today we are releasing **OpenStrike** — a single-player, Counter-Strike-shaped FPS that plays the classic GoldSrc-era maps: bots, tracers, recoil, round flow, and a JSX HUD. The round rules are TypeScript. The HUD is a [Solid](https://www.solidjs.com/) app. And the whole thing holds a locked 60 FPS on a **2004 Sony PSP**, shipped as one file you can drop on a Memory Stick.

<img class="w-full rounded-xl border border-line" src="/assets/blog/openstrike-psp-dust2.png" alt="OpenStrike on a PSP: the sunlit dust2 courtyard at 480×272 — cliffs, green ammo crates, the rifle viewmodel, and the JSX HUD showing HP 100, ammo 30/90, HOSTILES 3/3" />

<p class="text-sm text-slate-500 -mt-4">Native 480×272 output of the shipping build, shown at 2× — this frame and every other screenshot in this post is the PSP executable's own framebuffer, captured in the emulator our byte-exact tests run on.</p>

OpenStrike is open source at [pocket-nexus/open-strike](https://github.com/pocket-nexus/open-strike). It is the first game built on the Pocket runtime family — the architecture underneath [PocketJS](/blog/introducing-pocketjs/) — and it exists to prove a claim: that "the web stack's ergonomics, without the web stack's machinery" scales past UI, to a real-time 3D game, on hardware that predates the iPhone.

This post is written for people who ship JavaScript for browsers and have never touched a games console. No embedded or graphics background is assumed. It is the full story: what the machine actually is, how TypeScript ends up inside it, what a 1999 map format has to do with your bundler, how you draw anything without shaders, and where the milliseconds went.

## The machine in question

The PSP-1000 has a single MIPS CPU core at 333 MHz. In-order execution, no speculative anything, and — this matters most for us — **no JIT for JavaScript**, so every closure runs interpreted, every frame. It has **32 MB of RAM**, of which user programs see 24 MB. The browser tab you are reading this in has a larger JavaScript heap than this machine has memory, total.

The GPU — Sony calls it the *Graphics Engine* — predates programmable shaders. You cannot upload a vertex shader or a fragment shader; there is nothing to upload to. It is a fixed-function pipeline: it can transform triangles by a matrix, interpolate a color across each one, sample a texture with bilinear filtering, depth-test, blend — a fixed menu, configured by registers, feeding a 480×272 screen out of **2 MB of video memory**.

And there is no operating system in the sense you mean. No processes, no virtual memory, no dynamic linker, and nowhere for `console.log` to go. The whole game — Rust engine, JavaScript interpreter, the JS bundle, the *map* — links into a single executable (an `EBOOT.PBP`, the PSP's `.exe`), and when it runs, it is handed the machine. When it crashes, the machine crashes.

That is the deploy target. Here is what we deployed.

## One product, two machines

OpenStrike is split along a line web developers will recognize instantly — it is the native-app split, transplanted: **the engine is Rust, the product is JavaScript.**

The Rust side (`openstrike-core` plus the [Pocket3D](https://github.com/pocket-nexus/pocketjs/blob/main/RUNTIMES.md) renderer) owns everything that must never miss a frame: player movement and collision, bot AI, bullets, and drawing the world. The JavaScript side owns everything that makes it *this game rather than some game*: `rules.ts` is the round flow, scoring, and the weapon and bot tuning tables; `hud.tsx` is the entire HUD — health, ammo, crosshair, score — an ordinary Solid component tree styled with Tailwind classes, running on PocketJS. The base game grants itself no privileges a mod wouldn't have: change `rules.ts` and you have made a mod.

The JS engine embedded in the executable is **QuickJS** — Fabrice Bellard's full ES2023 engine that compiles to a few hundred kilobytes. QuickJS is to this PSP what V8 is to Node: the host hands it a `strike` API surface and a `ui` API surface, and the same `openstrike.js` bundle boots against them on every target.

Every target — plural, and that is the release's real headline:

<svg viewBox="0 0 760 442" width="100%" role="img" aria-label="Architecture diagram: one product bundle fans out to two machine stacks — a desktop stack (QuickJS via rquickjs, strike and ui surfaces, openstrike-core, pocket3d on wgpu) and a PSP stack (QuickJS compiled to MIPS, the same surfaces, the same core crate, pocket3d-gu on sceGu). The openstrike-core rows are highlighted as the same crate on both sides." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="180" y="8" width="400" height="86" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="32" fill="#f1f5f9" font-size="14" font-weight="700" text-anchor="middle">openstrike.js + openstrike.pak</text>
  <text x="380" y="52" fill="#38bdf8" font-size="11.5" text-anchor="middle">the product — TypeScript, one bundle, byte-identical on both machines</text>
  <text x="380" y="70" fill="#94a3b8" font-size="11.5" text-anchor="middle">rules.ts · round flow, scoring, weapon + bot tables</text>
  <text x="380" y="85" fill="#94a3b8" font-size="11.5" text-anchor="middle">hud.tsx · the HUD — a Solid app, Tailwind classes</text>
  <path d="M310 94 L182 136" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M450 94 L578 136" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M182 136 l9 -7 M182 136 l11 1" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M578 136 l-9 -7 M578 136 l-11 1" stroke="#475569" stroke-width="1.5" fill="none"/>
  <g>
    <rect x="30" y="142" width="310" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="44" y="161" fill="#e2e8f0" font-size="12.5">QuickJS guest</text>
    <text x="44" y="178" fill="#64748b" font-size="11">embedded via rquickjs</text>
    <rect x="30" y="196" width="310" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="44" y="215" fill="#e2e8f0" font-size="12.5">strike + ui surfaces</text>
    <text x="44" y="232" fill="#64748b" font-size="11">state snapshots ↓ · commands ↑</text>
    <rect x="30" y="250" width="310" height="46" rx="8" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
    <text x="44" y="269" fill="#e2e8f0" font-size="12.5">openstrike-core — the simulation</text>
    <text x="44" y="286" fill="#22d3ee" font-size="11">no_std Rust, shared verbatim</text>
    <rect x="30" y="304" width="310" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="44" y="323" fill="#e2e8f0" font-size="12.5">pocket3d · wgpu renderer</text>
    <text x="44" y="340" fill="#64748b" font-size="11">Metal / Vulkan / DX12, any resolution</text>
    <text x="185" y="380" fill="#94a3b8" font-size="12" text-anchor="middle">your laptop</text>
    <text x="185" y="397" fill="#64748b" font-size="11" text-anchor="middle">cargo run -p openstrike</text>
  </g>
  <g>
    <rect x="420" y="142" width="310" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="434" y="161" fill="#e2e8f0" font-size="12.5">QuickJS, compiled to MIPS</text>
    <text x="434" y="178" fill="#64748b" font-size="11">interpreter only — no JIT on this CPU</text>
    <rect x="420" y="196" width="310" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="434" y="215" fill="#e2e8f0" font-size="12.5">strike + ui surfaces</text>
    <text x="434" y="232" fill="#64748b" font-size="11">same vocabulary, mirrored field for field</text>
    <rect x="420" y="250" width="310" height="46" rx="8" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
    <text x="434" y="269" fill="#e2e8f0" font-size="12.5">openstrike-core — the simulation</text>
    <text x="434" y="286" fill="#22d3ee" font-size="11">the same crate, recompiled for MIPS</text>
    <rect x="420" y="304" width="310" height="46" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="434" y="323" fill="#e2e8f0" font-size="12.5">pocket3d-gu · sceGu renderer</text>
    <text x="434" y="340" fill="#64748b" font-size="11">fixed-function GE, 480×272, 2 MB VRAM</text>
    <text x="575" y="380" fill="#94a3b8" font-size="12" text-anchor="middle">a 2004 Sony PSP</text>
    <text x="575" y="397" fill="#64748b" font-size="11" text-anchor="middle">one EBOOT.PBP — engine, JS, and map inside</text>
  </g>
  <text x="380" y="430" fill="#475569" font-size="11" text-anchor="middle">facts flow down (state snapshots + events) · intent flows up (commands) · the guest never blocks the simulation</text>
</svg>

The tick order is fixed and worth internalizing, because everything later hangs off it. Sixty times a second:

```text
every 16.7 ms                       (one vertical blank)
  pad → SimInput                    buttons + analog stick
  sim.tick(dt)                      movement, bots, bullets      Rust
  strike.__dispatch(state, events)  one call into QuickJS        JS
    ├─ rules.ts reacts              queues commands
    └─ hud.tsx re-renders           only the bindings that changed
  drain commands → core             setPhase, configureWeapon…   Rust
  draw                              PVS → batches → GE
```

Facts flow down as a plain state snapshot (`hp`, `ammo`, `phase`, `aliveBots`, …) plus an event batch (`hit`, `playerDied`, `roundReset`). Intent flows up as queued commands. JavaScript is consulted exactly once per frame and can never stall the simulation — the same one-crossing-per-frame discipline PocketJS already enforced for UI, now owning a game's rules.

## A bundler for 1999's geometry

Now the 3D part, from zero.

A GoldSrc-era map — the format behind Half-Life and the original Counter-Strike — is not a soup of triangles. It is a **BSP** file: the level's polygons stored pre-organized into a *binary space partitioning tree*, a 1990s data structure that recursively slices the world with planes until every position falls into a convex cell called a *leaf*. The format's killer feature is the **PVS — the Potentially Visible Set**. For every leaf, the file stores a precomputed, compressed bitset of every other leaf that could *ever* be visible from inside it, through any door, over any crate, at any angle. Computing it took the level designer's machine minutes, once, in 1999. Consuming it takes microseconds, forever.

If you want this in web terms: the PVS is occlusion culling as a lockfile. All the expensive thinking happened offline, and the runtime just looks up the answer. Standing in the dust2 courtyard, the renderer never even considers the tunnels' geometry — not "draws it fast," but *never touches it*.

We kept that 1999 spirit and extended it with a modern move: **treat the console like a deploy target and put a compiler in front of it.** The PSP cannot afford to parse a BSP file, decode textures, or reshape data at load time — that costs RAM for intermediate copies and CPU we would rather spend on bots. So OpenStrike's build step runs `pocket3d-cook` on your laptop, which reads the map plus its `.wad` texture archives and emits a `.p3d`: a file whose bytes are *exactly* what the PSP's GPU wants to read, in the exact layout, alignment, and byte order.

<svg viewBox="0 0 760 336" width="100%" role="img" aria-label="Pipeline diagram: de_dust2.bsp plus WAD textures flow into pocket3d-cook (which dices faces on a 32-unit grid, bakes lightmaps into vertex colors, quantizes positions to 16-bit integers, resamples textures to power-of-two, palettizes and swizzles them with mip chains, and packs PVS plus collision hulls), producing de_dust2.p3d, 3.8 MB, with sections for vertices, indices, batches, textures, visibility, collision, and entities. The output is linked into the EBOOT and read by the GPU in place." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="90" width="196" height="118" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="114" y="118" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">de_dust2.bsp</text>
  <text x="114" y="137" fill="#94a3b8" font-size="11" text-anchor="middle">BSP v30 — GoldSrc, 1999</text>
  <text x="114" y="158" fill="#94a3b8" font-size="11" text-anchor="middle">+ .wad texture archives</text>
  <text x="114" y="177" fill="#64748b" font-size="10.5" text-anchor="middle">(from your own copy of the game —</text>
  <text x="114" y="191" fill="#64748b" font-size="10.5" text-anchor="middle">map data is not redistributed)</text>
  <path d="M212 149 L246 149" stroke="#475569" stroke-width="1.5"/>
  <path d="M246 149 l-8 -5 M246 149 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="252" y="26" width="252" height="246" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="378" y="52" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">pocket3d-cook</text>
  <text x="378" y="70" fill="#38bdf8" font-size="11" text-anchor="middle">build time, on your laptop</text>
  <text x="270" y="98" fill="#94a3b8" font-size="11.5">· dice faces on a 32-unit grid</text>
  <text x="270" y="120" fill="#94a3b8" font-size="11.5">· lightmaps → vertex colors</text>
  <text x="270" y="142" fill="#94a3b8" font-size="11.5">· quantize positions to i16</text>
  <text x="270" y="164" fill="#94a3b8" font-size="11.5">· resample to pow², bilinear</text>
  <text x="270" y="186" fill="#94a3b8" font-size="11.5">· CLUT8 + swizzle + mips</text>
  <text x="270" y="208" fill="#94a3b8" font-size="11.5">· pack PVS + collision hulls</text>
  <text x="270" y="238" fill="#64748b" font-size="10.5">every byte laid out exactly as the</text>
  <text x="270" y="252" fill="#64748b" font-size="10.5">GE's DMA engine will read it</text>
  <path d="M504 149 L538 149" stroke="#475569" stroke-width="1.5"/>
  <path d="M538 149 l-8 -5 M538 149 l-8 5" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="544" y="26" width="200" height="246" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="644" y="52" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">de_dust2.p3d — 3.8 MB</text>
  <text x="560" y="80" fill="#e2e8f0" font-size="11">WVTX  <tspan fill="#64748b">58k verts × 20 B</tspan></text>
  <text x="560" y="102" fill="#e2e8f0" font-size="11">WIDX  <tspan fill="#64748b">u16 indices</tspan></text>
  <text x="560" y="124" fill="#e2e8f0" font-size="11">WBAT  <tspan fill="#64748b">draw batches</tspan></text>
  <text x="560" y="146" fill="#e2e8f0" font-size="11">WTEX  <tspan fill="#64748b">swizzled CLUT8 + mips</tspan></text>
  <text x="560" y="168" fill="#e2e8f0" font-size="11">WVIS  <tspan fill="#64748b">the PVS</tspan></text>
  <text x="560" y="190" fill="#e2e8f0" font-size="11">WCLP  <tspan fill="#64748b">collision hulls</tspan></text>
  <text x="560" y="212" fill="#e2e8f0" font-size="11">WENT  <tspan fill="#64748b">spawns, sun, bounds</tspan></text>
  <text x="560" y="244" fill="#64748b" font-size="10.5">zero parsing, zero copies</text>
  <text x="560" y="258" fill="#64748b" font-size="10.5">at load time</text>
  <path d="M380 288 L380 306" stroke="#475569" stroke-width="1.5"/>
  <text x="380" y="326" fill="#94a3b8" font-size="11.5" text-anchor="middle">linked into the EBOOT — the GPU reads these bytes in place; “loading a level” is one cache-writeback call</text>
</svg>

"Baking" is the word for moving runtime cost to build time, and the cooker bakes aggressively:

- **Lighting is baked into vertex colors.** GoldSrc maps ship *lightmaps* — little per-surface shadow textures. The GE could multitexture them, but every texture unit costs bandwidth we would rather not spend. So the cooker dices each polygon into a grid and *samples the lightmap into the vertices' color channel*. The GE interpolates colors across triangles for free, so sunlight, shadow edges, and that orange dust2 glow cost literally nothing per frame. It is inlining, for light.
- **Positions are quantized to 16-bit integers.** Half the memory and half the GPU-read bandwidth of floats. (This unlocked the port's favorite piece of hardware archaeology: in 3D mode the GE silently *normalizes* integer vertices — divides them by 32768 — a behavior documented nowhere. The counter-move is to scale the world back up by 32768 in the model matrix. We confirmed it by reading the emulator's source code, which on this platform is what developer documentation looks like.)
- **Textures become CLUT8**: 8-bit indices into a 256-color palette — 4× smaller than RGBA, which is how a whole map's texture set fits alongside everything else. They are resampled to power-of-two sizes (a hard GE requirement), *swizzled* — reordered into the tile pattern the GPU's texture cache wants, roughly "structure-of-arrays, for texels" — and given full mip chains (pre-shrunk versions for distant surfaces).

The payoff for all this build-time obsession is the load screen we don't have: the `.p3d` is linked into the executable's read-only data, and the GE renders **directly from those bytes, in place**. No file I/O, no decompression, no upload step. The one concession to hardware reality is a single cache-writeback call at boot, because the GPU reads memory behind the CPU cache's back. Level loads are instant because nothing loads.

If you have used PocketJS, this is the same ideology that compiles Tailwind classes to a binary style table and bakes fonts to atlases — *the device never parses, it only consumes* — applied to an entire 3D world.

## The texture glow-up, or: the machine hides nothing

Midway through the port we noticed the textures looked muddier than 1999 deserved, and the investigation is a nice showcase of how unforgiving — and how *legible* — this hardware is. Three independent causes, all in the pipeline above:

<img class="w-full rounded-xl border border-line" src="/assets/blog/openstrike-psp-crates.png" alt="Before/after crop of the same crate on PSP: left, the coarse bake — muddy planks and smeared bricks; right, the refined bake — distinct planks, the X-brace reads clearly, brick courses resolve" />

<p class="text-sm text-slate-500 -mt-4">The same crate, before and after, 3× crop of the PSP framebuffer. Left: nearest-neighbor resampling, round-down sizing, default mip selection. Right: bilinear palette-aware resampling, round-up sizing, −1.0 mip bias, and a 2× denser light grid.</p>

First, non-power-of-two textures (a 96×96 crate face, say) were being stretched to GPU-legal sizes with nearest-neighbor sampling, which duplicates texel columns in a visibly irregular rhythm. The fix is a bilinear resample — but through a *palette*: sample in RGB, then re-quantize each result to the texture's own 256 colors. Second, sizing policy rounded to the *nearest* power of two, so a 320-wide texture dropped to 256 and threw away native detail; it now always rounds up (the GE's ceiling is 512). Third, the GE has no anisotropic filtering, and its automatic mip selection goes blurry on floors at glancing angles long before texel density demands it — a −1.0 LOD bias holds the sharp mip one distance ring longer, a trade every PSP-era shipped game quietly made. And while we were in there, the light-bake grid tightened from 96 world units to 32 — every other lightmap sample — so baked shadow edges snap back into place. Dust2 went from 26k to 58k vertices and the map grew 0.9 MB, which the budget absorbed without a flinch, as the next section shows.

## The 16.7-millisecond war

At 60 FPS a frame is 16.7 ms — everything above must happen inside it, on one interpreted-JavaScript-running, 333 MHz core. Here is where the port stood after the dust settled, measured on the physical handheld over a scripted tour of dust2:

<svg viewBox="0 0 760 168" width="100%" role="img" aria-label="Frame budget bar: of the 16.7 millisecond frame, CPU work occupies 6.8 to 8.4 milliseconds, of which JavaScript (rules plus HUD) is about 2.2 milliseconds; roughly half the frame is headroom. Worst observed frame: 9.7 milliseconds. GE command time is under 0.03 milliseconds." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="40" y="24" fill="#94a3b8" font-size="12">one frame at 60 fps</text>
  <text x="720" y="24" fill="#94a3b8" font-size="12" text-anchor="end">16.67 ms</text>
  <rect x="40" y="36" width="680" height="40" rx="6" fill="#0b0f1a" stroke="#2b3a55"/>
  <rect x="40" y="36" width="342" height="40" rx="6" fill="#123146"/>
  <rect x="40" y="36" width="90" height="40" rx="6" fill="#0e5068"/>
  <line x1="382" y1="32" x2="382" y2="80" stroke="#38bdf8" stroke-width="1.5"/>
  <line x1="395" y1="32" x2="395" y2="80" stroke="#e6a94b" stroke-dasharray="4 3" stroke-width="1.2"/>
  <text x="52" y="61" fill="#22d3ee" font-size="11.5">JS ~2.2 ms</text>
  <text x="145" y="61" fill="#e2e8f0" font-size="11.5">sim + bots + draw recording</text>
  <text x="560" y="61" fill="#475569" font-size="11.5" text-anchor="middle">headroom — roughly half the frame</text>
  <text x="382" y="100" fill="#38bdf8" font-size="11.5" text-anchor="middle">avg work: 6.8–8.4 ms</text>
  <text x="430" y="120" fill="#e6a94b" font-size="11">worst frame observed: 9.7 ms</text>
  <text x="40" y="150" fill="#64748b" font-size="11">GE (GPU) command time: &lt;0.03 ms — PVS means it is only ever handed what the camera can see, preformatted.</text>
</svg>

A comfortable margin — but only after two wars, and the second one is the single most useful thing this project has to say to JavaScript developers.

**War one was not ours to win.** The first hardware run came in at 25 FPS, and no amount of profiling explained it, because the code was innocent: the development harness boots the console at 222 MHz, and retail speed — 333 MHz — is one syscall away. The lesson generalizes: *before optimizing a slow embedded target, confirm what clock it is actually running at.*

**War two: fine-grained means fine-grained.** The HUD originally mirrored the per-tick state snapshot into Solid through one signal:

```tsx
// before: one signal carries the whole snapshot —
// a fresh object every tick, so *every* binding re-runs, every frame
const [st, setSt] = createSignal(snapshot());
onState((s) => setSt({ ...s }));

// after: one signal per field, equality-gated —
// an unchanged hp/ammo/phase costs nothing
const [hp, setHp] = createSignal(100);
const [ammo, setAmmo] = createSignal(30);
onState((s) => { setHp(s.hp); setAmmo(s.ammo); /* … */ });
```

On a desktop you would never notice the difference; the JIT absorbs it. On a 333 MHz interpreter the whole-snapshot version cost **20.6 ms of JavaScript per frame** — over budget before a single triangle drew — because a new object identity re-fires every binding whether its field changed or not. Splitting per field with equality gating dropped the identical HUD to **2.2 ms**. Solid's reactivity model isn't a preference at this scale; it is the reason a JSX HUD is *possible* here at all. The renderer's draw output was byte-identical before and after, which is also how we could make that change fearlessly — more on that below.

Memory tells the same story of contracts rather than aspirations, with the JS engine's heap living inside the same audited budget:

```text
PSP user RAM                                24.0 MB
├─ executable (engine + QuickJS + JS bundle
│    + the entire cooked map)                 6.2 MB
├─ arena high-water (QuickJS heap, engine
│    state, per-frame vertex pool)           ~4.4 MB
└─ free                                     ~13 MB
VRAM: framebuffers + depth                    1.4 / 2 MB
```

## Determinism is the debugger

How do you debug a machine with no console, no debugger UI, and no screen-sharing? You make the program a **pure function** and put the leverage at build time — the same bet as the cooker, applied to behavior.

OpenStrike inherits PocketJS's closed-world rules: a fixed 1/60 s timestep, no wall clocks, seeded randomness, and per-frame input that is just a button bitmask plus two analog bytes. Frame N is a pure function of the input script — so a scripted run produces *byte-identical framebuffers*, every time, on any faithful executor. Our CI boots the actual shipping EBOOT in the PPSSPP emulator's deterministic software renderer, drives scripted input, and compares dumped frames **byte-for-byte** against golden PNGs. When the texture fixes above landed, the goldens named exactly which pixels changed and why; re-baselining was one command. The 60 FPS number comes from the same harness pointed at the real handheld over a USB cable, streaming per-frame timings back to the desk.

<img class="w-full rounded-xl border border-line" src="/assets/blog/openstrike-psp-fire.png" alt="Firing on PSP: the muzzle flash blooms over a crate, ammo reads 28/90 on the HUD, sunlit cliffs through the archway to the left" />

<p class="text-sm text-slate-500 -mt-4">Frame 507 of a scripted input tape — reproducible to the byte, which is what makes it CI evidence and a blog illustration at the same time.</p>

And because the HUD is a PocketJS app, the whole [DevTools story](/blog/time-travel-devtools/) carries over unchanged: the component inspector highlights nodes on the handheld's physical screen, `console.log` streams off the device with frame numbers attached, and pause/step freezes bots mid-stride — all over the same cable.

## What this actually proves

The Pocket runtime family's thesis is that a *product* — gameplay rules, UI, tuning — should be a portable JavaScript artifact, while engines stay native, small, and swappable underneath. OpenStrike is the first full-size test of that thesis across a hardware gulf: the same `openstrike.js`, byte for byte, runs against wgpu on a many-core laptop and against a fixed-function GPU on a 32 MB handheld, and the *game* cannot tell.

<img class="w-full rounded-xl border border-line" src="/assets/os-dust2.jpg" alt="The desktop build of OpenStrike on de_dust2 at high resolution — two bots advancing past green ammo crates, the same HUD in the corners" />

<p class="text-sm text-slate-500 -mt-4">The desktop build: same rules.ts, same hud.tsx, same crates — eleven times the pixels and per-pixel lightmaps, because that engine can.</p>

Nothing about the pattern is PSP-specific. The console is, as we said when introducing PocketJS, an honest referee: a machine that will not quietly absorb a lazy architecture. An FPS with its brains in TypeScript holding 60 FPS *there* is the existence proof; everything roomier is downhill.

## Play it

- **[pocket-nexus/open-strike](https://github.com/pocket-nexus/open-strike)** — MIT. Desktop build runs with `cargo run -p openstrike`; the [README](https://github.com/pocket-nexus/open-strike#readme) covers the PSP EBOOT, the hardware bench, and the emulator goldens.
- Map data is Valve's and is **not** in the repo — point the build at your own copy of the game's `.bsp`/`.wad` files. Any GoldSrc-era map works; the eight CS classics are the tested set.
- No PSP? PPSSPP runs the EBOOT beautifully. Real hardware needs custom firmware and [PSPLINK](https://github.com/pspdev/psplinkusb) — the same cable our DevTools ride.
- **[docs/RUNTIMES.md](https://github.com/pocket-nexus/pocketjs/blob/main/RUNTIMES.md)** — the runtime-family architecture OpenStrike instantiates, if you want the ontology behind the diagram.

Follow [@pocket_js](https://x.com/pocket_js) for what's next. The pocket keeps getting deeper.
