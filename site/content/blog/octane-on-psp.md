<img class="w-full rounded-xl border border-line" src="/assets/blog/octane-hero-jsx-60fps.png" alt="The PocketJS hero demo running through Octane on a PSP: a headline reading JSX at 60 FPS, a live FPS counter showing 60, 42 nodes, 9 draw calls, a Press Circle button with Count: 1, and a subtitle reading Flexbox, springs and baked type running through Octane" />

<p class="text-sm text-slate-500 -mt-4">The hero demo's "pressed" moment — a committed 480×272 PPSSPP golden from the Octane e2e suite, shown at 2×. The counter under the button is <code>useState</code>. The 60 in the corner is real.</p>

When we first benchmarked JavaScript frameworks on the PSP ([PR #6](https://github.com/pocket-nexus/pocketjs/pull/6)), React was the one that didn't make it: after the measurements, the writeup's conclusion was that original React has no viable path on a 333 MHz MIPS handheld with 32 MB of RAM. Solid and Vue Vapor became PocketJS's two frameworks, and "React on a PSP" went into the drawer labeled *not with that runtime*.

[Octane](https://github.com/octanejs/octane) reopened the drawer. It is Dominic Gannaway's compiled implementation of the React programming model — `useState`, `useEffect`, JSX, the works — with no virtual DOM and no reconciler, because a compiler resolved the component tree's shape before the app ever shipped. That is not a performance detail. It is the difference between "React can't run here" and "the React *model* compiles to something that can."

So we ported it. If you are new here: [PocketJS](/blog/introducing-pocketjs/) runs real web-framework components on a 2004 Sony PSP at a locked 60 FPS, and lately on [Vitas](/blog/pocketjs-on-ps-vita/), [Nokias](/blog/pocketjs-on-symbian/), and e-readers. As of this release it supports three frameworks over one native tree and one Rust core: Solid, Vue Vapor, and Octane. Every demo Vue Vapor has, Octane now has; 14 of the 23 committed Octane PSP goldens are **byte-identical** to the Vue Vapor frame; and the three-way benchmark below is the complete comparative dataset PR #6 could not produce — every cell of it inside the 16.7 ms budget of a 60 FPS frame. It did not start that way. Getting there took a memory hunt through a pinned JS engine, the discovery that every PSP build since 2021 had been running an unoptimized interpreter, and a hardware test that read "under 1 FPS" before it read anything else.

## A third dialect, not a third engine

An Octane PocketJS app reads exactly the way a React developer would write it — hooks from `octane`, host components from the framework:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/octane";
import { View, Text } from "@pocketjs/framework/octane/components";
import { useState } from "octane";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">{`Framework: ${frameworkName()}`}</Text>
      <View focusable onPress={() => setCount(count + 1)}>
        <Text class="text-sm text-blue-600">{`Count: ${count}`}</Text>
      </View>
      {count > 2 ? <Text class="text-sm text-emerald-600">Octane, native tree.</Text> : null}
    </View>
  );
}

mount(App);
```

At build time, Octane's *universal* compiler lowers the JSX into static host plans plus dynamic slots, and infers effect dependency arrays from captures (you may still write them; you mostly don't). Hooks are tracked by call site rather than by array index, which is why an Octane hook is allowed inside an `if`. At runtime, the compiled output talks to whatever renderer the build named — and ours is `@pocketjs/framework/octane/renderer`, a driver that maps Octane's host command batches (create, update, insert, move, remove, destroy) directly onto the same native `ui.*` tree Solid and Vue Vapor render into.

<svg viewBox="0 0 760 430" width="100%" role="img" aria-label="Architecture diagram. Three framework boxes at the top: Solid with signals and JSX through the universal-mode renderer; Vue Vapor with refs through a small DOM shim; Octane with hooks and JSX compiled at build time to host plans and slot batches, no DOM shim. All three arrows converge on one native ui tree of NodeMirrors owning styles, focus and animation, which flows into pocketjs-core for layout, clipping and the DrawList, which flows into sceGu, the PSP's fixed-function graphics engine, at 480 by 272 and 60 hertz. Caption: a third framework is a third dialect, not a third engine" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="14" width="225" height="84" rx="10" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="128" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Solid</text>
  <text x="128" y="60" fill="#94a3b8" font-size="11" text-anchor="middle">signals · JSX</text>
  <text x="128" y="78" fill="#64748b" font-size="10.5" text-anchor="middle">universal-mode renderer</text>
  <rect x="268" y="14" width="225" height="84" rx="10" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="380" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Vue Vapor</text>
  <text x="380" y="60" fill="#94a3b8" font-size="11" text-anchor="middle">refs · JSX</text>
  <text x="380" y="78" fill="#64748b" font-size="10.5" text-anchor="middle">renderer + small DOM shim</text>
  <rect x="520" y="14" width="225" height="84" rx="10" fill="#0b0f1a" stroke="#e8590c" stroke-width="1.5"/>
  <text x="632" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Octane</text>
  <text x="632" y="60" fill="#94a3b8" font-size="11" text-anchor="middle">hooks · JSX · compiled</text>
  <text x="632" y="78" fill="#64748b" font-size="10.5" text-anchor="middle">universal driver · no DOM shim</text>
  <path d="M128 98 L128 130 L340 158" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M380 98 L380 158" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M632 98 L632 130 L420 158" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M380 158 l-5 -8 M380 158 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="644" y="146" fill="#e8590c" font-size="10" text-anchor="middle">compiled to host plans + slot batches</text>
  <rect x="180" y="162" width="400" height="64" rx="10" fill="#0e1626" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="188" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">one native ui.* tree</text>
  <text x="380" y="208" fill="#22d3ee" font-size="11" text-anchor="middle">NodeMirrors · styles · focus · input · animation</text>
  <path d="M380 226 L380 262" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 262 l-5 -8 M380 262 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="205" y="266" width="350" height="58" rx="9" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="290" fill="#e2e8f0" font-size="13" font-weight="700" text-anchor="middle">pocketjs-core</text>
  <text x="380" y="310" fill="#22d3ee" font-size="11" text-anchor="middle">layout · clip · paint transforms · DrawList</text>
  <path d="M380 324 L380 358" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 358 l-5 -8 M380 358 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="230" y="362" width="300" height="44" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="381" fill="#e2e8f0" font-size="12" text-anchor="middle">sceGu · fixed-function GE</text>
  <text x="380" y="398" fill="#64748b" font-size="10.5" text-anchor="middle">480×272 · 60 Hz</text>
  <text x="380" y="424" fill="#475569" font-size="11" text-anchor="middle">a third framework is a third dialect, not a third engine</text>
</svg>

The driver is deliberately boring: batches in, `NodeMirror` mutations out, text through the host's text nodes, portals as a driver capability that mints overlay hosts transactionally. Two details are less boring. Unlike Vue Vapor, there is **no DOM shim** — Octane's universal target never asks for a document, so the adapter is the thinnest of the three. And PocketJS's frame loop drains Octane's microtask-scheduled re-renders **synchronously inside each frame**, so a `setState` in a button handler commits in the same tick that pressed the button — the same latency contract Solid and Vue Vapor already keep, and the reason input tapes stay [deterministic](/blog/ui-runtime-that-cant-flake/) across all three.

Selecting it is one flag, or one manifest line:

```sh
bun tools/build.ts hero-main --framework=octane   # dist/hero-main.octane.js
bun tools/psp.ts hero --framework=octane --release  # a real EBOOT.PBP
```

An `app.octane.tsx` next to `app.tsx` is picked up automatically — which is how one demo directory carries all of its ports.

## Porting eight demos, and what the compiler taught us

All eight showcase demos — hero, cards, stats, library, settings, notifications, music, gallery — now ship an Octane twin beside their Solid original and Vue Vapor port, sim-verified against the Vue Vapor variants and pinned by 23 byte-exact PPSSPP goldens. Fifteen of those 23 goldens are byte-identical to the Vue Vapor frame: same input tape, same frame index, same pixels, different programming model. The eight that differ are all frames captured mid-animation — sprite phases, equalizer bars, spring tails — where the frameworks' schedulers land on slightly different phases of the same motion.

Porting produced a short list of authoring rules, each discovered the hard way and now in [the frameworks doc](/docs/frameworks/):

- **The entry passes the component itself.** `mount(App)`, not `mount(() => <App />)` — JSX inside a call-argument arrow is a fail-closed error in the universal target.
- **Mixed static and dynamic text is one template literal.** ``<Text>{`Count: ${count}`}</Text>`` — the compiler drops trailing whitespace on a static segment that precedes an expression, and `Count:0` is not a good look.
- **Frame-loop counters use functional updates.** `setX((v) => v + 1)`; a same-frame handler's write would otherwise be clobbered by a stale read.
- **Keep natively animated properties out of `style` objects whose values change across renders.** Re-applying a changed style value cancels the running tween; drive those from an effect with `animate()` and a `nodeRef`.
- **Keep always-animating state in leaf components.** This one turned out to be about memory, not CPU — the next section is why.

PocketJS's own per-frame hooks came along renamed: `useFrame`, `useButtonPress`, `useSpriteAnimation`. The `use` prefix is not a style choice — the Octane compiler slot-keys custom hooks by the `use[A-Z]` call-site convention, and an `onFrame`-style name compiles into a plain call whose internal slots silently collide. We found that out when a gallery demo's left trigger started acting as a +1 button.

## The memory hunt

The first full Octane demos did not survive their runs. The music demo died at frame 58 with `InternalError: out of memory` — while megabytes of the QuickJS arena sat free. Exceptions arrived as `null`. The frame loop wedged. Every one of those symptoms pointed somewhere different, and all of them were real.

The excavation went three layers down:

1. **Octane's profiler is on by default** — and its `trackedComponents` WeakMap keeps being written even after `profiler.stop()`, with per-render closures as values.
2. **The pinned QuickJS marks WeakMap values strongly.** Our engine is a 2026 QuickJS revision whose new GC is not ephemeron-aware: a ten-line repro (`wm.set(key, {back: key})`) never collects, and the same code is on bellard master today. Every render's owner graph was being pinned by a profiler nobody asked for.
3. **The engine's slab allocator amplifies whatever survives.** A few live objects pin whole chunks of `JSMallocArena`, so a small true leak carves the fixed arena 10–20× faster than its own size, and the engine's auto-GC threshold (live × 1.5) is far too lazy for a heap this small.

The fixes ship in this release: `framework=octane` builds alias `octane/profiling` to a no-op stub; the PSP frame loop gained an **arena-pressure GC** that runs a collection when a frame leaves the bump pointer more than 256 KiB past the last one (steady-state Solid and Vue Vapor guests never trigger it); and the Octane ports moved their always-animating state into leaf components so a tick re-rendered a handful of nodes instead of the screen. That last fix turned out to be only half the answer — the next section is what the other half cost to learn.

What the fixes do **not** do is make frequent re-rendering free on this engine revision. Post-stub, each re-render still retains a residue the collector cannot reclaim — measured at ~80–115 KB per frame across the per-frame-state demos — so an always-animating Octane screen has a session memory horizon until the engine is repaired: it outlives its capture window, not an unbounded afternoon. The stats demo's benchmark window ends with the arena at 16.87 of 17.06 MiB. That is 98.9 % used, which its own screen almost predicted:

<img class="w-full rounded-xl border border-line" src="/assets/blog/octane-stats-mission-control.png" alt="The stats demo running through Octane on a PSP: a Mission Control dashboard with tiles for players online 12,480, sessions today 3,642, draw calls 268, and a status list where GE PIPELINE, AUDIO MIXER and WIFI LINK read ONLINE while MEMORY ARENA reads 87 percent used in amber" />

<p class="text-sm text-slate-500 -mt-4">The stats demo's Mission Control screen — a committed Octane golden. Its telemetry is fictional demo copy, but "MEMORY ARENA: 87% USED" aged into near-documentary: at the end of the real benchmark window the real arena sat at 98.9 %.</p>

<svg viewBox="0 0 760 412" width="100%" role="img" aria-label="Cascade diagram of the memory pathology and its fixes. Top row: an always-animating screen calling setState every frame leads to roughly 80 to 115 kilobytes retained per re-render that the pinned engine cannot reclaim, which leads to the slab allocator pinning whole chunks around survivors, which leads to a live set that grows every frame — stats reaches 16.87 of 17.06 mebibytes by the window's last frame. That flows into: the engine's auto-GC walks the growing set, 254 milliseconds of stats' 280 millisecond frame is JS plus GC, which is why benchmark average frame work reads 15.58 times Solid — GC dominance, not render cost. Bottom row, what ships today: the profiler stubbed out, an arena-pressure GC in the host frame loop, and state kept in leaf components. Caption: the residue itself is an engine bug; the quickjs-rs GC repair and repin is the tracked follow-up, and apps without per-frame state are unaffected" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="28" width="168" height="82" rx="9" fill="#0b0f1a" stroke="#e8590c" stroke-width="1.5"/>
  <text x="100" y="54" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">always-animating screen</text>
  <text x="100" y="74" fill="#94a3b8" font-size="10.5" text-anchor="middle">setState every frame</text>
  <path d="M184 69 L200 69" stroke="#475569" stroke-width="1.5"/>
  <path d="M200 69 l-7 -4 M200 69 l-7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="202" y="28" width="168" height="82" rx="9" fill="#0b0f1a" stroke="#854d0e" stroke-width="1.5"/>
  <text x="286" y="50" fill="#eab308" font-size="11.5" font-weight="700" text-anchor="middle">~80–115 KB retained</text>
  <text x="286" y="68" fill="#eab308" font-size="11.5" font-weight="700" text-anchor="middle">per re-render</text>
  <text x="286" y="90" fill="#94a3b8" font-size="10" text-anchor="middle">engine can't reclaim it</text>
  <path d="M370 69 L386 69" stroke="#475569" stroke-width="1.5"/>
  <path d="M386 69 l-7 -4 M386 69 l-7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="388" y="28" width="168" height="82" rx="9" fill="#0b0f1a" stroke="#854d0e" stroke-width="1.5"/>
  <text x="472" y="54" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">slab chunks pinned</text>
  <text x="472" y="74" fill="#94a3b8" font-size="10" text-anchor="middle">whole chunks stay alive</text>
  <text x="472" y="90" fill="#94a3b8" font-size="10" text-anchor="middle">around each survivor</text>
  <path d="M556 69 L572 69" stroke="#475569" stroke-width="1.5"/>
  <path d="M572 69 l-7 -4 M572 69 l-7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="574" y="28" width="170" height="82" rx="9" fill="#0b0f1a" stroke="#854d0e" stroke-width="1.5"/>
  <text x="659" y="54" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">live set grows every frame</text>
  <text x="659" y="74" fill="#94a3b8" font-size="10" text-anchor="middle">stats: 16.87 of 17.06 MiB</text>
  <text x="659" y="90" fill="#94a3b8" font-size="10" text-anchor="middle">by the window's last frame</text>
  <path d="M659 110 L659 142 L560 166" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M560 166 l9 -3 M560 166 l4 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="376" y="170" width="368" height="66" rx="9" fill="#0b0f1a" stroke="#e8590c" stroke-width="1.5"/>
  <text x="560" y="194" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">engine auto-GC walks the growing set</text>
  <text x="560" y="216" fill="#94a3b8" font-size="10.5" text-anchor="middle">stats: 254 ms of a 280 ms frame is JS + GC</text>
  <path d="M376 203 L360 203" stroke="#475569" stroke-width="1.5"/>
  <path d="M360 203 l7 -4 M360 203 l7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="170" width="342" height="66" rx="9" fill="#0e1626" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="187" y="194" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">benchmark: avg frame work 15.58× Solid</text>
  <text x="187" y="216" fill="#22d3ee" font-size="10.5" text-anchor="middle">GC dominance — not Octane's render cost</text>
  <text x="380" y="266" fill="#e2e8f0" font-size="11.5" font-weight="700" text-anchor="middle">what ships today</text>
  <rect x="16" y="278" width="232" height="72" rx="9" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="132" y="302" fill="#e2e8f0" font-size="11" font-weight="700" text-anchor="middle">profiler stubbed out</text>
  <text x="132" y="322" fill="#94a3b8" font-size="10" text-anchor="middle">octane/profiling → no-op</text>
  <text x="132" y="338" fill="#64748b" font-size="10" text-anchor="middle">for framework=octane builds</text>
  <rect x="264" y="278" width="232" height="72" rx="9" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="380" y="302" fill="#e2e8f0" font-size="11" font-weight="700" text-anchor="middle">arena-pressure GC in the host</text>
  <text x="380" y="322" fill="#94a3b8" font-size="10" text-anchor="middle">JS_RunGC when a frame leaves bump</text>
  <text x="380" y="338" fill="#64748b" font-size="10" text-anchor="middle">>256 KiB past the last collection</text>
  <rect x="512" y="278" width="232" height="72" rx="9" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="628" y="302" fill="#e2e8f0" font-size="11" font-weight="700" text-anchor="middle">state lives in leaf components</text>
  <text x="628" y="322" fill="#94a3b8" font-size="10" text-anchor="middle">a tick re-renders four bars,</text>
  <text x="628" y="338" fill="#64748b" font-size="10" text-anchor="middle">not the screen</text>
  <text x="380" y="380" fill="#475569" font-size="10.5" text-anchor="middle">the residue is an engine bug — the quickjs-rs GC repair + repin is the tracked follow-up</text>
  <text x="380" y="398" fill="#475569" font-size="10.5" text-anchor="middle">apps without per-frame state are unaffected</text>
</svg>

Along the way the PSP host's exception logger learned to print tag, message, and stack — a `null` exception, it turns out, is QuickJS telling you it had no room left to construct the Error object. And the debug rig that cracked the case was not on the PSP at all: a scratch Cargo probe pinned to the exact same QuickJS revision, evaluating the real bundle against a stubbed `ui`, with heap histograms and a GC root dump. It reproduced the handheld's memory behavior byte-for-byte on a desktop, which is the only reason a three-layer engine bug was findable in finite time.

## The hardware said no

With the emulator suite green we put the release EBOOTs on a Memory Stick, and the real PSP delivered its verdict on the hero demo: **under one frame per second**. Not "a bit heavy" — a slideshow. The rest of this section is the two things that number was made of, because both are the kind of bug that hides in plain sight for years.

**The first was not Octane's fault at all.** While chasing it we repinned our QuickJS fork to pick up a known interpreter fix — and the benchmark numbers did not move by a microsecond. Byte-identical archives on both sides of an optimizer change means the optimizer change never happened: our PSP build exports `CRATE_CC_NO_DEFAULTS=1` (needed to keep the cc crate's host-flag synthesis out of a MIPS cross-compile), and that flag also drops the `-O` level the build script asks for. With no `-O` in our own `TARGET_CFLAGS` either, clang fell back to `-O0` — **every QuickJS interpreter PocketJS ever shipped on PSP had been unoptimized, since the flag was introduced in a 2021 bring-up experiment**. One `-O2` in the right place: hero's average frame work fell from 387.8 ms to 154.4 ms, and Solid and Vue Vapor got faster retroactively too.

**The second was architectural, and it rewrote our own advice.** Profiling the remaining 154 ms on a desktop probe showed the frame machinery costs microseconds and a single Octane re-render costs the same ~2 ms whether the state lives in the root or in a one-node leaf: an Octane state commit replays the whole root. Moving state into leaf components — the guidance we shipped in the first cut of this port — changes how *often* you replay, not what a replay costs. `memo` does not help either; component bodies already skip, and the cost is the replay walk itself. On a 333 MHz handheld one replay is a multi-frame stall, so the only number that matters is **replays per second, and for anything continuously animated the right answer is zero**.

PocketJS already had the channels to make it zero — the same native machinery Solid and Vue Vapor demos lean on:

- **Sprite cycling** → the native `<Sprite>` atlas (`sprites.json`, host auto-play). The hero, gallery, and library spinners became one 256×128 atlas baked from the eight spinner SVGs; per-frame JS: none. (The atlas itself shipped broken once: our SVG baker silently dropped `<g transform>`, so seven of eight cells baked blank — on hardware the spinner blinked instead of spun, and a golden re-baseline had quietly enshrined the bug. The baker now hard-errors on `<g transform>`, and the goldens got looked at with actual eyes.)
- **Looping choreography** → baked keyframe timelines. The music equalizer's `|sin|` curve, phase per bar included, is sampled into four keyframe tracks in `pocket.config.ts` and loops in `styles.bin` forever; play/pause just switches classes:

```tsx
const EQ_BARS_PLAYING = [
  "w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600 h-[6] animate-eq0",
  // …eq1, eq2, eq3 — same bar, phase baked into each timeline
] as const;

function Equalizer(props: { playing: boolean }) {
  return (
    <View class="flex-row items-end gap-1 h-16">
      {([0, 1, 2, 3] as const).map((i) => (
        <View key={i} class={props.playing ? EQ_BARS_PLAYING[i] : EQ_BAR_PAUSED} />
      ))}
    </View>
  );
}
```

- **One-shot motion** → `animate()`/`jump()` from a mount effect (the stats reveal's staggered rows, notification rows), instead of easing curves computed in a per-frame `setState`.
- **Per-frame text** → a new escape hatch, `setTextContent(nodeRef, string)` — the text-shaped sibling of `animate()`. The stats count-up and the music progress percentage now write one host op per visible change and never re-render anything.
- **Phase timers** → refs that count frames and commit state exactly once at the boundary (a dismissal finishing, a loading screen ending).

Average frame work per demo on PPSSPP, before and after (the 60 FPS budget is 16.7 ms):

| demo | first full port | this release |
|---|---:|---:|
| hero | 387.8 ms | **6.5 ms** |
| stats | 279.9 ms | **9.2 ms** |
| music | 282.7 ms | **12.9 ms** |
| notifications | 271.2 ms | **13.8 ms** |
| library | 50.8 ms | **4.9 ms** |
| settings | 27.4 ms | **14.5 ms** |
| cards | 9.7 ms | **6.6 ms** |

One cost stays, named: a button press is still one replay, and on the PSP that is a **150–250 ms hitch on the press frame** — Solid and Vue Vapor handle the same press in milliseconds. The replay walk re-resolves owner identity paths from the root on every lookup (13,000 calls per replay in the stats demo), which looks cacheable; that is upstream work we intend to take to Octane itself rather than paper over in the driver.

## The benchmark PR #6 couldn't run

PR #6's React column was empty because nothing bootable existed to measure. This time all three columns are full: 7 apps × 3 frameworks × 7 samples on deterministic headless PPSSPP — repeated runs are byte-identical — with geomean-vs-Solid ratios and bootstrap CIs, archived in [`docs/bench/`](https://github.com/pocket-nexus/pocketjs/tree/grass-responsibility/docs/bench). (For the record: the first full dataset, taken before the fixes above, read avg frame work at **15.58×** Solid. This is the same suite after them.)

| geomean vs Solid (lower is better) | Vue Vapor | Octane |
|---|---:|---:|
| bundle eval | 2.91× | 2.88× |
| boot → first frame | 2.02× | 2.00× |
| avg frame work | 1.11× | **1.66×** |
| bundle size | 2.41× | 2.96× |

<svg viewBox="0 0 760 468" width="100%" role="img" aria-label="Linear-scale horizontal bar chart of average JS work per frame for seven demo apps in three frameworks on PPSSPP, after the optimization work. Every bar of all three frameworks sits inside the 16.7 millisecond 60 FPS budget line: Solid ranges 3.7 to 10.4 milliseconds, Vue Vapor 3.6 to 10.4, and Octane 4.9 to 14.5, with settings at 14.5 and notifications at 13.8 as Octane's heaviest screens" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="16" y="20" fill="#e2e8f0" font-size="13" font-weight="700">Average JS work per frame — all 21 cells inside the frame budget</text>
  <rect x="16" y="34" width="10" height="10" fill="#38bdf8"/><text x="30" y="43" fill="#e2e8f0" font-size="10">Solid</text>
  <rect x="86" y="34" width="10" height="10" fill="#42b883"/><text x="100" y="43" fill="#e2e8f0" font-size="10">Vue Vapor</text>
  <rect x="186" y="34" width="10" height="10" fill="#e8590c"/><text x="200" y="43" fill="#e2e8f0" font-size="10">Octane</text>
  <line x1="279" y1="60" x2="279" y2="402" stroke="#1e293b"/>
  <line x1="449" y1="60" x2="449" y2="402" stroke="#1e293b"/>
  <line x1="618" y1="60" x2="618" y2="402" stroke="#1e293b"/>
  <line x1="676" y1="56" x2="676" y2="402" stroke="#854d0e" stroke-dasharray="5 4"/>
  <text x="672" y="64" fill="#eab308" font-size="10" text-anchor="end">16.7 ms budget</text>
  <text x="100" y="92" fill="#cbd5e1" font-size="10.5" text-anchor="end">hero</text>
  <rect x="110" y="70" width="124.0" height="11" fill="#38bdf8"/>
  <text x="239.0" y="79" fill="#94a3b8" font-size="9">3.66</text>
  <rect x="110" y="83" width="122.3" height="11" fill="#42b883"/>
  <text x="237.3" y="92" fill="#94a3b8" font-size="9">3.61</text>
  <rect x="110" y="96" width="221.3" height="11" fill="#e8590c"/>
  <text x="336.3" y="105" fill="#94a3b8" font-size="9">6.53</text>
  <text x="100" y="140" fill="#cbd5e1" font-size="10.5" text-anchor="end">cards</text>
  <rect x="110" y="118" width="163.3" height="11" fill="#38bdf8"/>
  <text x="278.3" y="127" fill="#94a3b8" font-size="9">4.82</text>
  <rect x="110" y="131" width="174.2" height="11" fill="#42b883"/>
  <text x="289.2" y="140" fill="#94a3b8" font-size="9">5.14</text>
  <rect x="110" y="144" width="222.3" height="11" fill="#e8590c"/>
  <text x="337.3" y="153" fill="#94a3b8" font-size="9">6.56</text>
  <text x="100" y="188" fill="#cbd5e1" font-size="10.5" text-anchor="end">stats</text>
  <rect x="110" y="166" width="231.8" height="11" fill="#38bdf8"/>
  <text x="346.8" y="175" fill="#94a3b8" font-size="9">6.84</text>
  <rect x="110" y="179" width="272.5" height="11" fill="#42b883"/>
  <text x="387.5" y="188" fill="#94a3b8" font-size="9">8.04</text>
  <rect x="110" y="192" width="313.5" height="11" fill="#e8590c"/>
  <text x="428.5" y="201" fill="#94a3b8" font-size="9">9.25</text>
  <text x="100" y="236" fill="#cbd5e1" font-size="10.5" text-anchor="end">library</text>
  <rect x="110" y="214" width="124.7" height="11" fill="#38bdf8"/>
  <text x="239.7" y="223" fill="#94a3b8" font-size="9">3.68</text>
  <rect x="110" y="227" width="148.8" height="11" fill="#42b883"/>
  <text x="263.8" y="236" fill="#94a3b8" font-size="9">4.39</text>
  <rect x="110" y="240" width="167.4" height="11" fill="#e8590c"/>
  <text x="282.4" y="249" fill="#94a3b8" font-size="9">4.94</text>
  <text x="100" y="284" fill="#cbd5e1" font-size="10.5" text-anchor="end">settings</text>
  <rect x="110" y="262" width="231.8" height="11" fill="#38bdf8"/>
  <text x="346.8" y="271" fill="#94a3b8" font-size="9">6.84</text>
  <rect x="110" y="275" width="249.8" height="11" fill="#42b883"/>
  <text x="364.8" y="284" fill="#94a3b8" font-size="9">7.37</text>
  <rect x="110" y="288" width="492.4" height="11" fill="#e8590c"/>
  <text x="607.4" y="297" fill="#94a3b8" font-size="9">14.53</text>
  <text x="100" y="332" fill="#cbd5e1" font-size="10.5" text-anchor="end">notifications</text>
  <rect x="110" y="310" width="153.2" height="11" fill="#38bdf8"/>
  <text x="268.2" y="319" fill="#94a3b8" font-size="9">4.52</text>
  <rect x="110" y="323" width="206.7" height="11" fill="#42b883"/>
  <text x="321.7" y="332" fill="#94a3b8" font-size="9">6.1</text>
  <rect x="110" y="336" width="469.0" height="11" fill="#e8590c"/>
  <text x="584.0" y="345" fill="#94a3b8" font-size="9">13.84</text>
  <text x="100" y="380" fill="#cbd5e1" font-size="10.5" text-anchor="end">music</text>
  <rect x="110" y="358" width="353.8" height="11" fill="#38bdf8"/>
  <text x="468.8" y="367" fill="#94a3b8" font-size="9">10.44</text>
  <rect x="110" y="371" width="352.1" height="11" fill="#42b883"/>
  <text x="467.1" y="380" fill="#94a3b8" font-size="9">10.39</text>
  <rect x="110" y="384" width="437.8" height="11" fill="#e8590c"/>
  <text x="552.8" y="393" fill="#94a3b8" font-size="9">12.92</text>
  <text x="279" y="416" fill="#64748b" font-size="10" text-anchor="middle">5 ms</text>
  <text x="449" y="416" fill="#64748b" font-size="10" text-anchor="middle">10 ms</text>
  <text x="618" y="416" fill="#64748b" font-size="10" text-anchor="middle">15 ms</text>
  <text x="380" y="448" fill="#475569" font-size="10.5" text-anchor="middle">PPSSPP software renderer · 7 deterministic samples per cell · byte-identical reruns · base 4e097c0</text>
</svg>

The 1.66× is a real, honest gap — per app Octane runs 1.2–3.1× Solid's frame work — but it is a gap measured in *milliseconds inside the budget*, not in dropped frames: the heaviest Octane screen (settings, 14.5 ms) still clears 60 FPS on the PSP's worst path. Boot, eval, and bundle land essentially on top of Vue Vapor — a compiled React model costs about what a compiled Vue costs to ship and start. And the `-O2` discovery cut Solid and Vue Vapor's own numbers roughly in half too, which is why every column here is faster than in any earlier PocketJS writeup.

Two footnotes for the methodologically suspicious. The bench window and its input tape are baked into each EBOOT at build time, which is why runs are byte-identical — and why our first attempt to "reproduce" a number by rebuilding without the bake measured a completely different, idle window. And the report can be rebuilt from raw samples without re-running emulation, which mattered the day the report builder crashed *after* 147 emulator runs had already succeeded.

## In the playground, too

The [playground](/playground/) grew a third toggle. The real Octane universal compiler runs in the browser — it is pure JavaScript, so unlike some of our compilers it needed no WASM shim — and the docs' framework-switchable code blocks now carry all three variants, 29 blocks' worth. Same editor, same native-tree WASM host, third dialect.

<img class="w-full rounded-xl border border-line" src="/assets/blog/octane-music-leaf-state.png" alt="The music demo running through Octane on a PSP: a Now Playing screen for MIDNIGHT REPLAY by SYNC PULSE with a progress bar at one percent, a three-track playlist, a four-bar equalizer in the corner, and controller hints for focus, play and skip" />

<p class="text-sm text-slate-500 -mt-4">The music demo's Octane port mid-playback. Everything moving in this frame moves without JavaScript: the four equalizer bars are baked keyframe timelines looping in <code>styles.bin</code>, the progress fill is one native linear tween, and the percent label is a <code>setTextContent</code> host op per visible change.</p>

## What's named, what's next

The gaps, named, because that is house policy: a button press is one root replay and costs a visible 150–250 ms hitch on the PSP until the replay walk is fixed upstream in Octane (the identity-path caching described above); the per-replay memory residue on the pinned engine is still real — replays are now rare enough that it no longer bounds a session, but the quickjs-rs GC repair and repin remain owed, as does an upstream report for the ten-line WeakMap repro that also reproduces on bellard master; the benchmark numbers above are emulator numbers from PPSSPP's software renderer, but the post-fix builds have since been re-tested on the same physical PSP that failed the first run — smooth, spinner turning; and `gallery`, the eighth demo, ports and builds like the rest but is not yet in the golden suite.

Everything here — adapter, compiler wiring, eight ports, playground, docs, benchmark — lands in [#203](https://github.com/pocket-nexus/pocketjs/pull/203). Three frameworks now compile into the same native tree on the same 2004 handheld, and the newest one writes like React because, at the source level, it is: hooks, JSX, and a compiler that did the reconciler's job before the code left your machine.

Follow [@pocket_js](https://x.com/pocket_js) for what's next. The pocket keeps getting deeper.
