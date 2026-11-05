<video class="w-full rounded-xl border border-line" autoplay muted loop controls playsinline preload="metadata" crossorigin="anonymous" width="1280" height="720" aria-label="The pocket-character widget idling: a VRM character blinking and swaying on a transparent always-on-top window, rendered by the Pocket runtime at 60 fps">
  <source src="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocket-character-widget-c6cf80c4.mp4" type="video/mp4" />
  <a href="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocket-character-widget-c6cf80c4.mp4">Watch the widget idle loop</a>
</video>

<p class="text-sm text-slate-500 -mt-4">Every frame above is the renderer's actual output — the exact pixels the transparent widget window presents, alpha and all. The process drawing them uses 118 MB of memory and 4 % of one CPU core.</p>

A desktop companion is a lovely idea: a small animated character that lives on your screen, blinks, breathes, watches your cursor, and — when you wire up an LLM — talks back. [airi](https://github.com/moeru-ai/airi) is one of the most complete open-source takes on that idea, and we mean that as a compliment: it's a whole companion *platform*, with providers, voice, plugins, and a stage that can render Live2D, VRM, even Godot.

But run it and look at Activity Monitor. On our M3 Max, airi's out-of-the-box stage — one idle character in a transparent window — is **8 processes, 1.7 GB of RSS, and 91 % of a CPU core, continuously**. That is not an airi bug. That is what an Electron window with an uncapped rAF loop, a 2× supersampled canvas, and a helper-process tree costs *before the AI does anything*.

We kept asking a narrower question: what does the character itself actually need? A skinned mesh, one looping animation, two schedulers, a physics chain, a transparent window. That is not an app platform's worth of work. That is a *fixed-function player* — and fixed-function players are exactly the shape the Pocket runtime family was built for.

If you are new here: [PocketJS](/blog/introducing-pocketjs/) runs real Solid and Vue Vapor components on a 2004 Sony PSP at a locked 60 FPS, and the same architecture — a native core that owns the frame, a QuickJS guest that owns policy, a spec-pinned surface between them — has since carried [an FPS](/blog/shipping-openstrike/), [a Figma viewer](/blog/pocket-figma/), and [YouTube over a USB cable](/blog/pocket-youtube/). This post is about pointing it at a desktop widget instead of a handheld.

So we rebuilt airi's 3D stage as a Pocket runtime: same character model, same idle animation, same blink and eye behavior, same spring-bone physics, same transparent always-on-top window — as **one native process**. Inside: what a character costs per tick when you only compute what changed, a VRM crate that learned the difference between +Z and −Z the hard way, blinks that upload vertices only while eyelids move, and a measured 10–20× drop on every resource axis, screenshots included.

## The stage, itemized

airi's default character is actually Live2D — Momose Hiyori, the official Cubism sample. We couldn't chase that one even if we wanted to: rendering `.moc3` requires the proprietary Live2D Cubism Core, which an open runtime can't vendor. The 3D digital human everyone pictures is airi's VRM mode: **AvatarSample_A**, the official VRoid sample model, driven by an `idle_loop.vrma` animation. That's the parity target, and it is delightfully concrete:

- One VRM 0.x model: 40,406 vertices, 3 skins, **273 joints**, 14 blend-shape expressions, four 4096² textures.
- One looping clip: `idle_loop.vrma`, 10.375 s, 28 humanoid channels.
- A blink: a 0.2 s sine envelope, fired every 1–6 s, driving one morph target (mesh 0, target 13 — we checked).
- Idle eye saccades: a fixation jitter of ±0.25 m re-aimed on airi's exact interval table, 800–4800 ms.
- Spring bones: 10 groups — Bust, Hood, HoodString, and seven Hair chains — against 22 sphere colliders, all from the model file.
- A 450×600 transparent, undecorated, always-on-top window you can drag.

Nothing in that list wants a DOM. Nothing in it wants eight processes. Here is what it runs on instead:

<svg viewBox="0 0 760 460" width="100%" role="img" aria-label="Two architectures side by side. Left: airi version 0.11.0 on Electron, eight stacked process boxes — main process with embedded WebSocket server and a 60 Hz cursor poll, GPU helper, stage renderer running three.js plus the VRM runtime, hidden beat-sync renderer, onboarding renderer, and three service processes — totaling 2184 megabytes RSS and 44 percent of a core in VRM mode. Right: pocket-character, a single native process box containing the pocket3d renderer with pocket-vrm, the character core simulation, and a QuickJS guest running the policy bundle, connected by the character surface — 118 megabytes RSS and 4 percent of a core." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="190" y="26" fill="#f1f5f9" font-size="14" font-weight="700" text-anchor="middle">airi v0.11.0 — Electron</text>
  <text x="190" y="44" fill="#64748b" font-size="11" text-anchor="middle">8 processes · VRM mode, idle</text>
  <g>
    <rect x="40" y="58" width="300" height="40" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="52" y="75" fill="#e2e8f0" font-size="12" font-weight="700">main process</text>
    <text x="52" y="90" fill="#64748b" font-size="10">ws server · 60 Hz global cursor poll · 307 MB</text>
    <rect x="40" y="104" width="300" height="40" rx="8" fill="#0b0f1a" stroke="#854d0e"/>
    <text x="52" y="121" fill="#e2e8f0" font-size="12" font-weight="700">GPU helper</text>
    <text x="52" y="136" fill="#eab308" font-size="10">421 MB · 23 % of a core</text>
    <rect x="40" y="150" width="300" height="40" rx="8" fill="#0b0f1a" stroke="#854d0e"/>
    <text x="52" y="167" fill="#e2e8f0" font-size="12" font-weight="700">stage renderer</text>
    <text x="52" y="182" fill="#eab308" font-size="10">three.js + @pixiv/three-vrm · 900 MB · 19 %</text>
    <rect x="40" y="196" width="300" height="34" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="52" y="217" fill="#94a3b8" font-size="11">beat-sync renderer (hidden) · 128 MB</text>
    <rect x="40" y="236" width="300" height="34" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="52" y="257" fill="#94a3b8" font-size="11">onboarding renderer · 264 MB</text>
    <rect x="40" y="276" width="300" height="34" rx="8" fill="#0b0f1a" stroke="#2b3a55"/>
    <text x="52" y="297" fill="#94a3b8" font-size="11">network · audio · video-capture services</text>
    <rect x="40" y="322" width="300" height="42" rx="8" fill="#0e1626" stroke="#475569"/>
    <text x="52" y="339" fill="#f1f5f9" font-size="12" font-weight="700">total: 2184 MB RSS · 44.4 % of a core</text>
    <text x="52" y="355" fill="#64748b" font-size="10">Live2D default mode: 1742 MB · 90.7 %</text>
  </g>
  <text x="570" y="26" fill="#f1f5f9" font-size="14" font-weight="700" text-anchor="middle">pocket-character — Pocket runtime</text>
  <text x="570" y="44" fill="#64748b" font-size="11" text-anchor="middle">1 process · same character, same behaviors</text>
  <g>
    <rect x="420" y="58" width="300" height="240" rx="10" fill="#0e1626" stroke="#22d3ee"/>
    <rect x="436" y="74" width="268" height="58" rx="8" fill="#0b0f1a" stroke="#38bdf8"/>
    <text x="448" y="93" fill="#e2e8f0" font-size="12" font-weight="700">pocket3d + pocket-vrm (native core)</text>
    <text x="448" y="108" fill="#64748b" font-size="10">wgpu skinning · morphs · springs · VRMA clip</text>
    <text x="448" y="122" fill="#64748b" font-size="10">transparent widget window · frame-paced loop</text>
    <rect x="436" y="140" width="268" height="44" rx="8" fill="#0b0f1a" stroke="#38bdf8"/>
    <text x="448" y="159" fill="#e2e8f0" font-size="12" font-weight="700">pocket-character-core (sim)</text>
    <text x="448" y="174" fill="#64748b" font-size="10">blink envelope · saccade table · look-at · seeded</text>
    <rect x="436" y="192" width="268" height="44" rx="8" fill="#0c1a22" stroke="#a78bfa"/>
    <text x="448" y="211" fill="#c4b5fd" font-size="12" font-weight="700">QuickJS guest — the personality</text>
    <text x="448" y="226" fill="#64748b" font-size="10">policy bundle over the `character` surface</text>
    <text x="448" y="256" fill="#64748b" font-size="10">facts down per tick · intent ops back up</text>
    <text x="448" y="272" fill="#64748b" font-size="10">one guest turn per tick · ~0.03 ms, all in</text>
    <rect x="420" y="322" width="300" height="42" rx="8" fill="#0e1626" stroke="#22d3ee"/>
    <text x="432" y="339" fill="#f1f5f9" font-size="12" font-weight="700">total: 118 MB RSS · 3.9 % of a core</text>
    <text x="432" y="355" fill="#64748b" font-size="10">30 fps mode: 117 MB · 2.1 %</text>
  </g>
  <text x="380" y="400" fill="#4ade80" font-size="11" text-anchor="middle">same model file · same idle clip · same blink math · same spring data</text>
  <text x="380" y="430" fill="#475569" font-size="11" text-anchor="middle">The scenario is a fixed-function character player. Fixed functions fit in one process.</text>
</svg>

The split is the same one [OpenStrike](/blog/shipping-openstrike/) proved out: the native core owns everything that happens every frame, the QuickJS guest owns *policy* — which clip plays, which expression fires, whether the eyes track your mouse. The guest is the personality, and it stays a hot-swappable JS bundle. The airi-parity personality is deliberately boring: set tracking to `none`, loop `idle_loop`, let the native schedulers breathe. A different character is a different bundle, not a different binary.

## Blinks should cost only while blinking

The engine work that made this possible landed upstream in [#125](https://github.com/pocket-nexus/pocketjs/pull/125), and the piece we care most about is the morph-target design, because it encodes the whole philosophy: **an idle character should cost almost exactly nothing.**

VRM faces animate through blend shapes — per-vertex position deltas layered on the skinned mesh. The obvious GPU implementation binds every morph target and accumulates them in the vertex shader, every vertex, every frame, forever. But look at what a blink actually is: 0.2 seconds of eyelid movement every one to six seconds. On the other ~96 % of frames, every weight is identical to the last frame.

So pocket3d stores morph targets as **sparse CPU deltas** — only the vertices a target actually moves — and each character instance owns a small overlay vertex buffer. When a weight changes, the affected primitives are recomputed on the CPU (a few thousand fused multiply-adds) and re-uploaded; when nothing changed, a dirty mask says so and the render path doesn't touch a byte. The draw call redirects morphing primitives to the overlay with `draw_indexed`'s `base_vertex` offset, so the shared index buffer never needs rebasing and non-morphing instances of the same asset keep reading the original vertices.

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-character-blink-strip.png" alt="Six consecutive engine-rendered face crops of the character mid-blink: eyes half closed, fully closed, then reopening" />
<p class="text-sm text-slate-500 -mt-4">Frames 294–309 of the sequence above, three ticks apart: one blink, as rendered. These are the only frames of the ten-second loop where morph vertices were uploaded at all.</p>

The rest of the per-tick pipeline follows the same rule — compute exactly what the frame needs, in one pass, in one process:

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="The per-tick character pipeline as a left-to-right flow: the character sim's blink and saccade schedulers feed a pose pass that samples the idle clip into local transforms, applies eye look-at rotations, runs the verlet spring-bone solver over 34 joints, multiplies globals down the hierarchy, and packs a 512-entry joint palette for GPU skinning; a dashed branch shows the blink weight writing sparse morph deltas into the overlay buffer only when the weight changed; the result draws in a single pass into the transparent window. Caption: about 0.03 milliseconds of CPU per tick including the QuickJS guest turn." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="24" y="40" width="150" height="64" rx="8" fill="#0b0f1a" stroke="#38bdf8"/>
  <text x="36" y="60" fill="#e2e8f0" font-size="12" font-weight="700">CharacterSim</text>
  <text x="36" y="76" fill="#64748b" font-size="10">blink: sine 0.2 s, 1–6 s</text>
  <text x="36" y="90" fill="#64748b" font-size="10">saccade: 0.8–4.8 s table</text>
  <path d="M174 72 h28" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M196 66 l8 6 l-8 6" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="206" y="24" width="128" height="44" rx="8" fill="#0e1626" stroke="#22d3ee"/>
  <text x="218" y="42" fill="#e2e8f0" font-size="11" font-weight="700">sample clip</text>
  <text x="218" y="58" fill="#64748b" font-size="10">idle_loop @ t</text>
  <path d="M334 46 h24" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M352 40 l8 6 l-8 6" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="362" y="24" width="120" height="44" rx="8" fill="#0e1626" stroke="#22d3ee"/>
  <text x="374" y="42" fill="#e2e8f0" font-size="11" font-weight="700">eye look-at</text>
  <text x="374" y="58" fill="#64748b" font-size="10">yaw/pitch, clamped</text>
  <path d="M482 46 h24" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M500 40 l8 6 l-8 6" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="510" y="24" width="128" height="44" rx="8" fill="#0e1626" stroke="#22d3ee"/>
  <text x="522" y="42" fill="#e2e8f0" font-size="11" font-weight="700">spring bones</text>
  <text x="522" y="58" fill="#64748b" font-size="10">verlet · 34 joints</text>
  <path d="M574 68 v22" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M568 84 l6 8 l6 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="446" y="96" width="256" height="44" rx="8" fill="#0e1626" stroke="#22d3ee"/>
  <text x="458" y="114" fill="#e2e8f0" font-size="11" font-weight="700">globals → joint palette</text>
  <text x="458" y="130" fill="#64748b" font-size="10">273 joints, 512-slot window, GPU skinning</text>
  <path d="M446 118 h-24" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M430 112 l-8 6 l8 6" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="286" y="96" width="136" height="44" rx="8" fill="#0c1a22" stroke="#4ade80"/>
  <text x="298" y="114" fill="#e2e8f0" font-size="11" font-weight="700">draw, one pass</text>
  <text x="298" y="130" fill="#64748b" font-size="10">transparent window</text>
  <path d="M100 104 v60 h106" stroke="#854d0e" stroke-width="1.5" fill="none" stroke-dasharray="4 4"/>
  <path d="M200 158 l8 6 l-8 6" stroke="#854d0e" stroke-width="1.5" fill="none"/>
  <rect x="210" y="146" width="244" height="40" rx="8" fill="#0b0f1a" stroke="#854d0e"/>
  <text x="222" y="163" fill="#eab308" font-size="11" font-weight="700">morph overlay upload</text>
  <text x="222" y="178" fill="#64748b" font-size="10">sparse deltas — only when a weight changed</text>
  <rect x="24" y="210" width="330" height="40" rx="8" fill="#0c1a22" stroke="#a78bfa"/>
  <text x="36" y="227" fill="#c4b5fd" font-size="11" font-weight="700">guest turn: character.__dispatch(state, events)</text>
  <text x="36" y="242" fill="#64748b" font-size="10">facts down, intent ops back — one turn per tick</text>
  <text x="380" y="284" fill="#475569" font-size="11" text-anchor="middle">The whole tick — sim, pose, springs, palette, guest turn — costs ~0.03 ms of CPU.</text>
</svg>

Two more engine details earned their keep. VRoid rigs carry ~270 joints across three skins, so the joint-palette window grew from 128 to 512 matrices — before that, most of the body silently skinned against garbage. And the widget window itself became a first-class `AppConfig` mode: transparent surface alpha, no decorations, always-on-top, drag-anywhere, and a `max_fps` pacing loop that *sleeps* between frames instead of spinning on vsync — on a ProMotion display, "just render on rAF" quietly means 120 Hz, and airi's stage does exactly that.

## The bug worth confessing

The first full-body render came out of the headless harness looking almost right — model loaded, textures resolved, transparent background clean — except the character held both arms straight up like a referee signaling a touchdown.

Every piece of that pose was individually correct. The `.vrma` parsed. All 22 humanoid channels retargeted onto the right bones. The quaternions were bit-faithful. The bug was a *convention*: `VRMC_vrm_animation` poses live in VRM 1.0's humanoid space, where characters face **+Z** — but VRM 0.x models, and AvatarSample_A is one, face **−Z**. three-vrm absorbs that 180° silently inside its normalized-rig indirection, which is exactly the kind of kindness that hides a spec detail until you reimplement it. In a raw channel copy, every rotation is conjugated wrong by half a turn of yaw, and the T-pose-relative arm rotations that should bring the hands down to the hips instead raise them to the sky.

The fix is one line of quaternion algebra — conjugate every rotation by the yaw-π between the spaces, `(x, y, z, w) → (−x, y, −z, w)`, negate the hips' X/Z translation — and it is now a documented, tested behavior of `pocket-vrm`'s retarget, not tribal knowledge. **Specs travel between ecosystems; conventions don't.** Render your output and look at it.

## Measured, same machine, same ruler

Methodology first, because the numbers are the headline and headlines deserve receipts. Both apps, same M3 Max, steady idle, hands off: ≥60 s of `ps` samples at 5 s intervals across the **entire process tree**, medians reported, plus macOS `footprint` for physical memory (it counts the GPU allocations RSS misses). Every CPU number below is the standard per-process convention — percent of one core. airi was measured in both stage modes; the VRM stage is the apples-to-apples row.

<svg viewBox="0 0 760 380" width="100%" role="img" aria-label="Bar chart of measured idle cost. CPU as percent of one core: airi Live2D default 90.7, airi VRM mode 44.4, pocket-character at 60 fps 3.9, pocket-character at 30 fps 2.1. Memory RSS in megabytes: airi Live2D 1742, airi VRM 2184, pocket-character 118 at 60 fps and 117 at 30 fps. pocket-character bars are an order of magnitude shorter on both axes." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="24" y="28" fill="#f1f5f9" font-size="13" font-weight="700">CPU at idle — % of one core (median, ≥60 s)</text>
  <text x="150" y="56" fill="#94a3b8" font-size="11" text-anchor="end">airi · Live2D</text>
  <rect x="162" y="44" width="544" height="16" rx="4" fill="#334155"/>
  <text x="714" y="57" fill="#e2e8f0" font-size="11">90.7</text>
  <text x="150" y="84" fill="#94a3b8" font-size="11" text-anchor="end">airi · VRM</text>
  <rect x="162" y="72" width="266" height="16" rx="4" fill="#a78bfa"/>
  <text x="436" y="85" fill="#c4b5fd" font-size="11">44.4</text>
  <text x="150" y="112" fill="#94a3b8" font-size="11" text-anchor="end">pocket · 60 fps</text>
  <rect x="162" y="100" width="24" height="16" rx="4" fill="#22d3ee"/>
  <text x="194" y="113" fill="#22d3ee" font-size="11" font-weight="700">3.9</text>
  <text x="150" y="140" fill="#94a3b8" font-size="11" text-anchor="end">pocket · 30 fps</text>
  <rect x="162" y="128" width="13" height="16" rx="4" fill="#38bdf8"/>
  <text x="183" y="141" fill="#38bdf8" font-size="11" font-weight="700">2.1</text>
  <text x="24" y="192" fill="#f1f5f9" font-size="13" font-weight="700">Memory — RSS, full process tree (MB, median)</text>
  <text x="150" y="220" fill="#94a3b8" font-size="11" text-anchor="end">airi · Live2D</text>
  <rect x="162" y="208" width="434" height="16" rx="4" fill="#334155"/>
  <text x="604" y="221" fill="#e2e8f0" font-size="11">1742</text>
  <text x="150" y="248" fill="#94a3b8" font-size="11" text-anchor="end">airi · VRM</text>
  <rect x="162" y="236" width="544" height="16" rx="4" fill="#a78bfa"/>
  <text x="600" y="249" fill="#0b0f1a" font-size="11" font-weight="700">2184</text>
  <text x="150" y="276" fill="#94a3b8" font-size="11" text-anchor="end">pocket · 60 fps</text>
  <rect x="162" y="264" width="29" height="16" rx="4" fill="#22d3ee"/>
  <text x="199" y="277" fill="#22d3ee" font-size="11" font-weight="700">118</text>
  <text x="150" y="304" fill="#94a3b8" font-size="11" text-anchor="end">pocket · 30 fps</text>
  <rect x="162" y="292" width="29" height="16" rx="4" fill="#38bdf8"/>
  <text x="199" y="305" fill="#38bdf8" font-size="11" font-weight="700">117</text>
  <text x="380" y="348" fill="#475569" font-size="11" text-anchor="middle">8 processes → 1 · RSS ÷18 · CPU ÷11 at 60 fps, ÷21 at 30 fps · footprint 1870 → 518 MB</text>
</svg>

Activity Monitor tells the same story in screenshots. Here is airi's VRM stage at idle — the GPU helper and stage renderer between them holding ~70 % of a core and 1.5 GB:

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-character-airi-cpu.jpg" alt="Activity Monitor CPU tab with airi in VRM mode: AIRI Helper at 38.8 percent and AIRI Helper Renderer at 31.7 percent of a core, with the VRM character visible in the corner" />
<p class="text-sm text-slate-500 -mt-4">airi, VRM stage, idle. The same character sits in the corner of the screen; the two highlighted helpers are what it costs to keep her there.</p>

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-character-airi-memory.jpg" alt="Activity Monitor Memory tab: AIRI Helper at 920.2 megabytes and AIRI Helper Renderer at 587.8 megabytes" />
<p class="text-sm text-slate-500 -mt-4">The memory tab's two biggest airi rows — and these are just two of the eight processes.</p>

And here is the whole of pocket-character, one row, drawing the same model in the same kind of window:

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-character-activity.jpg" alt="Activity Monitor CPU tab with pocket-character selected: 6.2 percent CPU shortly after launch with 3.5 percent GPU, the character idling beside the terminal that launched it" />
<p class="text-sm text-slate-500 -mt-4">One process, freshly launched (the 6.2 % includes model-decode startup; it settles to 2.4–2.8 % at 30 fps). The %GPU column reads 3.5.</p>

One aside we didn't put in the ledger because the compositor is shared infrastructure: with airi's stage running, macOS's WindowServer sat at ~51 % of a core; with only pocket-character on screen it reads ~9 %. An uncapped, 2×-supersampled, full-window rAF repaint doesn't just spend its own processes' time.

## The numbers

- **1 process** instead of 8 · **118 MB** RSS instead of 2184 MB · **3.9 %** of one core at 60 fps instead of 44.4 % — and 2.1 % at 30 fps, against the 90.7 % of airi's out-of-the-box Live2D stage.
- Physical footprint **518 MB** vs ~1870 MB — and 454 MB of ours is Metal texture memory; the CPU heap is ~16 MB dirty. Capping the model's four 4096² authoring textures at 2048² (invisible in a 450×600 window) was worth 413 MB on its own.
- The whole per-tick pipeline — schedulers, clip sampling, look-at, 34 spring joints, 273-joint palette, guest turn — costs **~0.03 ms** of CPU.
- An **11 MB** binary plus 27 MB of downloaded model assets, vs a 1.8 GB installed app from an 822 MB DMG.
- `pocket-vrm` ships with **21 tests** against the real fixture, including retarget math and 600-step spring determinism (two runs, bitwise-equal quaternions).
- Behavior parity is parameter-exact: blink `sin(π·t/0.2 s)` at uniform 1–6 s; saccades on airi's own 400 ms-step interval CDF; springs from the model's 10 groups and 22 colliders; tracking mode `none` by default, mouse mode wired.

## What this doesn't claim

Fairness matters more than the ratio. airi is a *platform* — providers, voice pipelines, VAD, plugins, a settings surface, multiple stage backends — and this project reimplements exactly one slice of it: the idle character stage. The comparison holds because at idle, the stage is what's running; it does not make pocket-character an airi replacement. airi's literal default (Live2D Hiyori) stays out of reach of any open runtime for licensing reasons, not technical ones. On rendering: airi tone-maps through ACES with an HDR environment; we draw an MToon approximation with cutout alpha — side by side it reads as a subtle grade difference, and the honest place to close that gap is a proper MToon pass, not this post. Lip sync only activates with a TTS stack on both sides, so neither ledger includes it. And every number here is one machine, one OS, measured over minutes, not weeks — the [full methodology and raw tables](https://github.com/pocket-nexus/pocket-character/blob/main/REPORT.md) are in the repo for anyone who wants to re-run them.

## Try it

```bash
git clone --recurse-submodules https://github.com/pocket-nexus/pocket-character
cd pocket-character
bun run setup        # vendored install + model assets (not committed)
bun run widget       # build + launch the widget; Ctrl-C to quit

# once built:
target/release/pocket-character --max-fps 30            # the 2 % version
target/release/pocket-character --headless-shot s.png   # CI-friendly render, alpha intact
bun tools/measure.ts                                  # reproduce the table above
```

The personality lives in `app/main.ts` — a policy bundle over the `character` surface. Change it, `bun tools/build-ui.ts`, relaunch: no Rust rebuild. The engine halves — morph targets, pose injection, widget windows, `pocket-vrm` — shipped in PocketJS [0.6.0](/changelog/).

---

*pocket-character is open source at [pocket-nexus/pocket-character](https://github.com/pocket-nexus/pocket-character), on the same engine as [everything else in the family](https://github.com/pocket-nexus/pocketjs). Follow [@pocket_js](https://x.com/pocket_js) — the pocket now has someone living in it.*
