Somewhere in your CI, right now, there is a test like this:

```ts
await page.getByRole("button", { name: "Place order" }).click();
await expect(page.getByText("Order confirmed")).toBeVisible();
```

It passed four times today. On the fifth run — same commit, same code, same test — it failed. Your team calls it *flaky*. There is a retry policy for it, a quarantine list, maybe a dashboard that tracks the flake rate the way one tracks the weather. And that is the tell: we treat flakiness as weather — an ambient hazard to be endured, mitigated, budgeted for.

This post argues that flakiness is not weather. It is a *property of the runtime's model of time*, it has a precise cause, and a UI runtime can be designed so that flakiness is not merely rare but **impossible by construction** — the way a sorted list doesn't *usually* keep order, it *cannot* lose it. Then it shows the receipts: a runtime that works this way, a real app scenario with async fetches and mutations, an experiment where the same code runs under two different clocks — one produces a histogram, the other produces a single bar — and a CI suite where the assertion is byte equality on every pixel of every frame.

And "can't flake" is only the doorway — the claim behind it is bigger than testing. `ui = f(state)` — the idea React planted — made the *view* a pure function and changed how a generation thinks about interfaces. But it purified **space** and said nothing about **time**: *when* state changes, in what order, interleaved with what. Everything that still hurts — flaky tests, unreproducible bug reports, "works on my machine," debugging by staring at videos — lives in that gap. The missing half of the equation is:

```
state[n+1] = F(state[n], input[n])
pixels[n]  = G(state[n])
```

Space *and* time, both pure. The rest of this post is what falls out when a UI runtime actually commits to that pair — and it turns out "your tests can't flake" is only the first and least interesting consequence.

## Flakiness is a hidden input

Start with a definition sharp enough to build on. Run a program twice from the same initial state with the same recorded inputs. If it can produce two different results, then — by definition — something varied that your recording didn't capture. **A test is flaky precisely when the program has inputs its tape doesn't record.**

Written as an equation: you wanted your app to be

```
state[n+1] = F(state[n], input[n])
```

but on a real browser runtime the function that actually executes is

```
state[n+1] = F(state[n], input[n],
               ⏱ wall clock, 🎲 scheduler interleaving,
               📶 network arrival order, 🗑 GC pauses,
               🖥 vsync phase, 🔤 font-load completion, …)
```

Every argument after `input[n]` is a hidden input: it changes the trajectory, nobody records it, and nobody *could* record all of it. You cannot replay what you did not record. That single sentence is the whole theory of flaky tests.

Seen this way, the industry's testing stack is a catalogue of coping strategies for hidden inputs. Mock `Date.now()` — one hidden input down. Fake timers — another. Stub `fetch`, stub `requestAnimationFrame`, preload the fonts, disable animations in test mode. Each mock is an *admission* that an unrecorded input exists, and the list never ends, because the runtime is free to invent new ones (an `IntersectionObserver` callback, an image decode completing, the microtask interleaving between two `await`s). Playwright's auto-waiting — the state of the art — doesn't remove the nondeterminism at all: it wraps every assertion in a retry loop and polls until the world happens to pass through a state where the assertion holds. That converts a hard failure into a slow pass. It also quietly forfeits an entire class of assertions: you can no longer ask *"was the confirmation visible within 500 ms?"*, because the framework's answer to "when?" is "keep asking until yes." Timing itself has become untestable.

<svg viewBox="0 0 760 430" width="100%" role="img" aria-label="Two models of time. Left: a sampled-time runtime — a vsync timeline with unrecorded inputs (fetch resolution, setTimeout, GC pause, compositor commit, microtask drain) striking it at arbitrary moments, each marked as never recorded. Right: a frame-fold runtime — an input tape of per-frame cells feeding a chain of frame transactions in order; every arrow into the world originates from the tape." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="8" y="8" width="362" height="414" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="189" y="34" fill="#f1f5f9" font-size="13.5" font-weight="700" text-anchor="middle">the sampled-time runtime</text>
  <text x="189" y="52" fill="#64748b" font-size="11" text-anchor="middle">view = render(state, wallClock)</text>
  <line x1="36" y1="330" x2="342" y2="330" stroke="#475569" stroke-width="1.5"/>
  <g stroke="#475569" stroke-width="1">
    <line x1="36" y1="324" x2="36" y2="336"/><line x1="87" y1="324" x2="87" y2="336"/>
    <line x1="138" y1="324" x2="138" y2="336"/><line x1="189" y1="324" x2="189" y2="336"/>
    <line x1="240" y1="324" x2="240" y2="336"/><line x1="291" y1="324" x2="291" y2="336"/>
    <line x1="342" y1="324" x2="342" y2="336"/>
  </g>
  <text x="189" y="352" fill="#64748b" font-size="10.5" text-anchor="middle">vsync — a deadline, not a boundary</text>
  <g stroke="#f87171" stroke-width="1.5" fill="none">
    <path d="M70 90 L102 322"/><path d="M150 74 L128 322"/><path d="M215 96 L246 322"/>
    <path d="M298 78 L281 322"/><path d="M330 130 L317 322"/>
  </g>
  <g fill="#f87171" font-size="10.5">
    <text x="70" y="82" text-anchor="middle">fetch resolves (IPC)</text>
    <text x="150" y="66" text-anchor="middle">setTimeout fires</text>
    <text x="215" y="88" text-anchor="middle">GC pause ends</text>
    <text x="298" y="70" text-anchor="middle">compositor commit</text>
    <text x="318" y="122" text-anchor="middle">microtasks drain</text>
  </g>
  <text x="189" y="384" fill="#f87171" font-size="11" text-anchor="middle">arrival times owned by the machine,</text>
  <text x="189" y="400" fill="#f87171" font-size="11" text-anchor="middle">recorded by no one — every run is a different program</text>

  <rect x="390" y="8" width="362" height="414" rx="10" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="571" y="34" fill="#f1f5f9" font-size="13.5" font-weight="700" text-anchor="middle">the frame-fold runtime</text>
  <text x="571" y="52" fill="#38bdf8" font-size="11" text-anchor="middle">state[n+1] = F(state[n], input[n])</text>
  <g>
    <rect x="418" y="86" width="88" height="46" rx="6" fill="#0e1626" stroke="#2b3a55"/>
    <text x="462" y="106" fill="#e2e8f0" font-size="10.5" text-anchor="middle">frame n</text>
    <text x="462" y="121" fill="#64748b" font-size="9.5" text-anchor="middle">transaction</text>
    <rect x="527" y="86" width="88" height="46" rx="6" fill="#0e1626" stroke="#2b3a55"/>
    <text x="571" y="106" fill="#e2e8f0" font-size="10.5" text-anchor="middle">frame n+1</text>
    <text x="571" y="121" fill="#64748b" font-size="9.5" text-anchor="middle">transaction</text>
    <rect x="636" y="86" width="88" height="46" rx="6" fill="#0e1626" stroke="#2b3a55"/>
    <text x="680" y="106" fill="#e2e8f0" font-size="10.5" text-anchor="middle">frame n+2</text>
    <text x="680" y="121" fill="#64748b" font-size="9.5" text-anchor="middle">transaction</text>
    <g stroke="#475569" stroke-width="1.5" fill="none">
      <path d="M506 109 L527 109"/><path d="M615 109 L636 109"/>
      <path d="M521 105 l6 4 l-6 4" fill="#475569"/><path d="M630 105 l6 4 l-6 4" fill="#475569"/>
    </g>
  </g>
  <g stroke="#38bdf8" stroke-width="1.5" fill="none">
    <path d="M462 214 L462 134"/><path d="M571 214 L571 134"/><path d="M680 214 L680 134"/>
    <path d="M458 141 l4 -7 l4 7" fill="#38bdf8"/><path d="M567 141 l4 -7 l4 7" fill="#38bdf8"/><path d="M676 141 l4 -7 l4 7" fill="#38bdf8"/>
  </g>
  <g>
    <rect x="414" y="214" width="96" height="70" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
    <text x="462" y="234" fill="#22d3ee" font-size="10" text-anchor="middle">input[n]</text>
    <text x="462" y="250" fill="#e2e8f0" font-size="9.5" text-anchor="middle">buttons ○ △</text>
    <text x="462" y="265" fill="#e2e8f0" font-size="9.5" text-anchor="middle">deliveries: —</text>
    <text x="462" y="279" fill="#e2e8f0" font-size="9.5" text-anchor="middle">timers due: —</text>
    <rect x="523" y="214" width="96" height="70" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
    <text x="571" y="234" fill="#22d3ee" font-size="10" text-anchor="middle">input[n+1]</text>
    <text x="571" y="250" fill="#e2e8f0" font-size="9.5" text-anchor="middle">buttons: —</text>
    <text x="571" y="265" fill="#e2e8f0" font-size="9.5" text-anchor="middle">deliver: order✓</text>
    <text x="571" y="279" fill="#e2e8f0" font-size="9.5" text-anchor="middle">timers due: —</text>
    <rect x="632" y="214" width="96" height="70" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
    <text x="680" y="234" fill="#22d3ee" font-size="10" text-anchor="middle">input[n+2]</text>
    <text x="680" y="250" fill="#e2e8f0" font-size="9.5" text-anchor="middle">buttons: —</text>
    <text x="680" y="265" fill="#e2e8f0" font-size="9.5" text-anchor="middle">deliveries: —</text>
    <text x="680" y="279" fill="#e2e8f0" font-size="9.5" text-anchor="middle">timer: toast⏻</text>
  </g>
  <text x="571" y="312" fill="#94a3b8" font-size="10.5" text-anchor="middle">the tape — the ONLY door into the world</text>
  <text x="571" y="384" fill="#4ade80" font-size="11" text-anchor="middle">everything that can change the world is on the tape,</text>
  <text x="571" y="400" fill="#4ade80" font-size="11" text-anchor="middle">so the tape replays the world — byte for byte</text>
</svg>

## Why the big runtimes flake by construction

None of this is an accident or an oversight, and it is worth being precise about why, because the answer is *architecture*, not sloppiness.

**Chromium is a distributed system wearing a rendering engine's clothes.** Your page's JavaScript runs on the main thread — alongside style recalculation and layout. Scrolling and CSS animations run on a separate *compositor* thread so they stay smooth while your JS is busy. Rasterization happens on a pool of worker threads; actual GPU submission lives in a *different process*; so does the network stack. These components coordinate through asynchronous IPC, and every boundary is a place where ordering is decided at runtime by whichever message lands first. On top of that, the main thread itself schedules macrotasks, microtasks, `requestAnimationFrame` callbacks and idle callbacks by rules with real degrees of freedom. When your `fetch` resolves, what you observe is the *last hop of an inter-process race*. The frame you screenshot is an emergent artifact of thread scheduling. Chromium's frame is a **deadline** — "whatever has committed by vsync ships" — not a transaction.

**Flutter made the same trade with its eyes open.** A Flutter app runs its Dart on a UI thread while a raster thread draws and a platform thread feeds in events; animations, by explicit design, *sample the wall clock* — an `AnimationController` maps elapsed real time onto a curve, so if a frame drops, the animation doesn't slow down, it *skips ahead*. That is the correct choice for a phone: the user lives in wall time, and catching up to reality beats replaying it. But look at what Flutter's own test story has to build to compensate: `FakeAsync` to virtualize timers, `tester.pump(duration)` to advance a *simulated* clock frame by frame, `pumpAndSettle()` to spin until the UI stops moving. Flutter testing works by **simulating time** — which concedes the whole argument. The simulation covers what the framework owns; the moment a plugin channel, an isolate, or a real network call crosses the boundary, the hidden inputs return.

The pattern generalizes. These runtimes treat time as something to *sample*: `view = render(state, wallClock)`. The in-between moments have no committed semantics — which frees the runtime to drop, coalesce, and race them, and that freedom is exactly where the smoothness comes from *and* exactly where determinism dies. Once the wall clock is an input anywhere, it is an input everywhere, and no test harness bolted on afterward can un-ask the question "what time was it?"

The frontend has actually brushed against the alternative once before: **Redux time travel**. Record the actions, fold them over a reducer, scrub back and forth — `state = actions.reduce(reducer, state0)` is precisely the right shape. But Redux could only purify the *store*. The runtime around it — rendering, animation, layout, the event loop, every `setTimeout` in every component — stayed on wall time, so the replay was always an approximation that ended at the edge of the state tree. The pixels never came along. The lesson wasn't that the idea was wrong; it's that **the fold has to own the whole world, or the world leaks**.

## The other tradition

There is a lineage of software that refused to leak, because for them replay wasn't a developer convenience — it was the product, or the only path to correctness.

Game developers solved this in the 1990s under duress. A StarCraft or Factorio replay file contains no video: it is a list of *inputs per simulation tick*, and the simulation is deterministic, so replaying the inputs regenerates the entire match — which is also how lockstep multiplayer ships only keystrokes over the wire. Fighting games run the idea *backwards*: GGPO's rollback netcode predicts the remote player, and when the real input arrives late, rewinds the world and **re-simulates several frames inside one frame budget** — feasible only because a frame is a pure function you can call as fast as the CPU allows. Databases got there next: FoundationDB ran its entire distributed database inside a deterministic simulator and injected years of network partitions and disk failures into CI; TigerBeetle's VOPR does this today, and Antithesis productized the idea as *deterministic hypervisor time travel* for arbitrary software. And `rr` gave systems programmers record-and-replay debugging by capturing exactly the nondeterministic inputs (syscalls, signals, thread scheduling) so execution becomes reproducible.

One move, every time: **make the program a pure function of a recorded event log, and bugs become data.** Tests cannot flake because there is nothing left to vary. The UI world never adopted the move — not because it can't work for UI, but because UI runtimes were never *designed as simulations*. So we designed one that is.

## The frame is a transaction

[PocketJS](/blog/introducing-pocketjs/) is a UI runtime we built for constrained machines — real Solid (and Vue Vapor) components with Tailwind-style classes, compiled to run against a Rust core; it drives [a real 2004 Sony PSP](/blog/shipping-openstrike/), a browser canvas, and a headless test host from one bundle. From day one it has had one load-bearing rule, inherited from the game-loop tradition:

**vblank paces; it does not define.** The display's refresh — PSP vblank, browser `requestAnimationFrame` — only decides *when* to run the next step. What a step *is* belongs to the runtime, and it is a fixed-order transaction:

```
frame n:
  advance the virtual clock        (frame counter += 1; due timers fire)
  apply queued effect deliveries   (results from the outside world)
  run app frame hooks              (onFrame, button edge detection)
  run input pass                   (focus navigation, onPress → reactive updates)
  end-of-frame sweep               (reclaim detached subtrees)
  advance the core                 (animations — EXACTLY 1/60 s per tick)
  render                           (pure projection of state)
```

Nothing is allowed to touch the world between transactions. Core animation ticks advance by exactly `1/60 s` of *simulated* time per tick — never by measured elapsed time. Text layout is deterministic. There is no `Date.now()` in the reactive path. The wall clock doesn't merely *rarely* interfere; **it has no door**.

<svg viewBox="0 0 760 230" width="100%" role="img" aria-label="The fold: state 0 passes through F with input 0 to make state 1, through F with input 1 to make state 2, through F with input 2 to make state 3; each state projects up through G to a screen of pixels. Below: state[3] = F(F(F(state[0], in[0]), in[1]), in[2])." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <g font-size="11">
    <rect x="22" y="96" width="92" height="40" rx="7" fill="#0e1626" stroke="#2b3a55"/>
    <text x="68" y="120" fill="#e2e8f0" text-anchor="middle">state[0]</text>
    <rect x="216" y="96" width="92" height="40" rx="7" fill="#0e1626" stroke="#2b3a55"/>
    <text x="262" y="120" fill="#e2e8f0" text-anchor="middle">state[1]</text>
    <rect x="410" y="96" width="92" height="40" rx="7" fill="#0e1626" stroke="#2b3a55"/>
    <text x="456" y="120" fill="#e2e8f0" text-anchor="middle">state[2]</text>
    <rect x="604" y="96" width="92" height="40" rx="7" fill="#0e1626" stroke="#2b3a55"/>
    <text x="650" y="120" fill="#e2e8f0" text-anchor="middle">state[3]</text>
    <circle cx="165" cy="116" r="17" fill="#0c1a22" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="165" y="121" fill="#38bdf8" text-anchor="middle" font-weight="700">F</text>
    <circle cx="359" cy="116" r="17" fill="#0c1a22" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="359" y="121" fill="#38bdf8" text-anchor="middle" font-weight="700">F</text>
    <circle cx="553" cy="116" r="17" fill="#0c1a22" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="553" y="121" fill="#38bdf8" text-anchor="middle" font-weight="700">F</text>
    <g stroke="#475569" stroke-width="1.5" fill="none">
      <path d="M114 116 L148 116"/><path d="M182 116 L216 116"/>
      <path d="M308 116 L342 116"/><path d="M376 116 L410 116"/>
      <path d="M502 116 L536 116"/><path d="M570 116 L604 116"/>
      <path d="M142 112 l6 4 l-6 4" fill="#475569"/><path d="M210 112 l6 4 l-6 4" fill="#475569"/>
      <path d="M336 112 l6 4 l-6 4" fill="#475569"/><path d="M404 112 l6 4 l-6 4" fill="#475569"/>
      <path d="M530 112 l6 4 l-6 4" fill="#475569"/><path d="M598 112 l6 4 l-6 4" fill="#475569"/>
    </g>
    <g stroke="#22d3ee" stroke-width="1.5" fill="none">
      <path d="M165 168 L165 133"/><path d="M359 168 L359 133"/><path d="M553 168 L553 133"/>
      <path d="M161 140 l4 -7 l4 7" fill="#22d3ee"/><path d="M355 140 l4 -7 l4 7" fill="#22d3ee"/><path d="M549 140 l4 -7 l4 7" fill="#22d3ee"/>
    </g>
    <g fill="#22d3ee" font-size="10.5">
      <text x="165" y="184" text-anchor="middle">in[0]</text>
      <text x="359" y="184" text-anchor="middle">in[1]</text>
      <text x="553" y="184" text-anchor="middle">in[2]</text>
    </g>
    <g stroke="#4ade80" stroke-width="1.2" fill="none" opacity="0.9">
      <path d="M68 96 L68 66"/><path d="M262 96 L262 66"/><path d="M456 96 L456 66"/><path d="M650 96 L650 66"/>
    </g>
    <g fill="#4ade80" font-size="10.5">
      <text x="68" y="54" text-anchor="middle">G → pixels[0]</text>
      <text x="262" y="54" text-anchor="middle">G → pixels[1]</text>
      <text x="456" y="54" text-anchor="middle">G → pixels[2]</text>
      <text x="650" y="54" text-anchor="middle">G → pixels[3]</text>
    </g>
  </g>
  <text x="380" y="218" fill="#94a3b8" font-size="12" text-anchor="middle">state[3] = F(F(F(state[0], in[0]), in[1]), in[2]) — the app's entire history is a reduce()</text>
</svg>

This is not aspiration; it has been load-bearing in this repo for a while. The test suite holds **35 pixel goldens** that assert *byte equality of encoded PNGs* — not screenshot-diff-with-tolerance, byte equality — across nine demo apps with springs, staggered mounts, and keyframe choreography. A 180-frame recorded interaction session replays as a [session golden](/blog/time-travel-devtools/) on every build: same tape, same 180 framebuffer hashes, or CI names the first divergent frame. The DevTools time-travel *seek* is implemented as nothing more than "re-run the fold from frame 0" — which only works because the fold is real. [OpenStrike](/blog/shipping-openstrike/), the Counter-Strike-shaped FPS that ships on the PSP, is byte-replayable the same way, bots and tracers included.

But until this week the fold had a famous asymmetry. Buttons were on the tape. **The network was not.**

## The effect shell: putting the outside world on the tape

"Fine for a game HUD," says the app developer, correctly, "but my app talks to servers." This is where UI determinism usually goes to die: a `fetch` resolves *whenever*, a promise's `.then` runs at the scheduler's discretion, and the fold's purity is broken by the first spinner.

The fix is to stop letting the outside world *push* into the program, and make it *queue* instead. PocketJS now ships an **effect shell** ([docs/DETERMINISM.md](https://github.com/pocket-nexus/pocketjs/blob/main/DETERMINISM.md)): an app never awaits a promise and never registers a native callback. It emits a **command**, and the result comes back as a **delivery** — applied at the start of a later frame's transaction, as part of that frame's `input[n]`:

```tsx
import { runEffect } from "@pocketjs/framework/effects";

runEffect<Receipt>("order", { items }, (receipt) => {
  setReceipt(receipt);          // runs at a frame boundary — always
  setPhase("confirmed");
});
```

Two details carry all the weight. First, the API takes a callback, not a promise — deliberately. A promise resolution is timed by the microtask queue, and the microtask queue is a *hidden input owned by the JS scheduler* — precisely the thing being exiled. In this runtime, **the frame boundary is the event loop.** Second, the thing that actually performs the work — the *driver* — is swappable per host. A live host installs a driver that does real fetches and queues results as they arrive (still only ever *applied* on frame boundaries). A test host installs a driver that delivers from a recorded tape, at recorded frame indices. The app cannot tell the difference, because the app only ever sees deliveries at frame edges. Every command and every delivery is also streamed out with its frame index — so an interactive session writes, as a side effect of running, the *complete causal record* needed to replay itself.

Determinism ends where an unrecorded input enters; the shell's job is to make sure every entrance goes through the recorder. The equation grows one term and closes again:

```
state[n+1] = F(state[n], input[n])
input[n]   = buttons[n] ⊕ deliveries[n] ⊕ timers-due[n]
```

To prove this on something shaped like real work rather than a toy counter, the repo now includes **Pocket Café** — a little ordering app with everything that makes UI tests miserable: it boots into a `CONNECTING…` state and fetches the menu (async, 500 ms), the user browses with focus navigation and adds drinks, placing the order is a mutation with real latency (async, 1 s), a `PLACING ORDER…` phase animates while it's in flight, and the confirmation toast auto-dismisses on a timer. The timer is the third leg of the tape: `after(1.5, reset)` — *1.5 seconds of virtual time*, a frame-indexed deadline, `setTimeout` with the wall clock amputated.

<img class="w-full rounded-xl border border-line" src="/assets/blog/cafe-phases.png" alt="Three phases of the Pocket Café demo at 480×272: the CONNECTING TO STORE screen while the menu fetch is in flight; the menu with ESPRESSO x1 and OAT LATTE x2 in the cart, the focused row lime-highlighted, TOTAL $12.00; and the settled confirmation state showing ORDER #1042 · READY IN 7 MIN." />

<p class="text-sm text-slate-500 -mt-4">One journey through Pocket Café: fetch in flight → cart building → confirmation landed. Async everywhere — and every run of it, on every machine, produces these exact pixels at these exact frames.</p>

## The experiment: same code, two clocks

Here is the part I like most, because it isolates the variable the way a lab would. We did not compare our runtime against a browser — too many confounds. Instead we took *our own runtime* and made it flaky, by changing exactly one thing: **what "time" means.**

- **Runtime W (wall)** drives the café app the way mainstream runtimes drive apps. A rAF-style accumulator loop paced by real `setTimeout` — with the timer jitter every OS delivers — plus occasional injected main-thread stalls (the GC/raster pauses every real machine has), and the order result delivered by a real wall-clock timer with network-like jitter. Nothing exotic; this is an ordinary Tuesday for a browser test.
- **Runtime V (virtual)** runs the *identical bundle* and the *identical journey* through the deterministic sim host, where time is the frame counter.

Both measure the same event: the frame at which the order confirmation *enters the world*. And both run the same Playwright-style assertion: *"the confirmation is visible by t = 2.5 s."* Sixty runs each:

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="Histogram comparison over 60 runs each. Left, wall clock: delivery frame spread across 22 distinct values from 140 to 164, tallest bar 6; timing assertion passed 9 of 60 runs. Right, virtual clock: a single bar at frame 144 with all 60 runs; assertion passed 60 of 60." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="8" y="8" width="362" height="314" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="189" y="34" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">wall clock — 60 runs</text>
  <text x="189" y="52" fill="#f87171" font-size="11" text-anchor="middle">22 distinct outcomes · "visible by 2.5 s": 9/60</text>
  <g fill="#f87171" opacity="0.85">
    <rect x="49.8"  y="242" width="8" height="18"  /><rect x="83.9"  y="242" width="8" height="18"/>
    <rect x="95.3"  y="224" width="8" height="36"  /><rect x="106.7" y="242" width="8" height="18"/>
    <rect x="118.1" y="242" width="8" height="18"  /><rect x="129.4" y="224" width="8" height="36"/>
    <rect x="140.8" y="206" width="8" height="54"  /><rect x="152.2" y="206" width="8" height="54"/>
    <rect x="163.6" y="224" width="8" height="36"  /><rect x="175.0" y="224" width="8" height="36"/>
    <rect x="186.3" y="206" width="8" height="54"  /><rect x="197.7" y="170" width="8" height="90"/>
    <rect x="209.1" y="206" width="8" height="54"  /><rect x="220.5" y="242" width="8" height="18"/>
    <rect x="231.9" y="188" width="8" height="72"  /><rect x="243.2" y="188" width="8" height="72"/>
    <rect x="254.6" y="206" width="8" height="54"  /><rect x="266.0" y="188" width="8" height="72"/>
    <rect x="277.4" y="242" width="8" height="18"  /><rect x="288.8" y="188" width="8" height="72"/>
    <rect x="300.1" y="152" width="8" height="108" /><rect x="322.9" y="188" width="8" height="72"/>
  </g>
  <line x1="30" y1="260" x2="350" y2="260" stroke="#475569"/>
  <g fill="#64748b" font-size="10">
    <text x="53.8"  y="278" text-anchor="middle">140</text>
    <text x="110.7" y="278" text-anchor="middle">145</text>
    <text x="167.6" y="278" text-anchor="middle">150</text>
    <text x="224.5" y="278" text-anchor="middle">155</text>
    <text x="281.4" y="278" text-anchor="middle">160</text>
    <text x="338.3" y="278" text-anchor="middle">165</text>
  </g>
  <text x="189" y="304" fill="#64748b" font-size="10.5" text-anchor="middle">frame at which the confirmation entered the world</text>

  <rect x="390" y="8" width="362" height="314" rx="10" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="571" y="34" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">virtual clock — 60 runs</text>
  <text x="571" y="52" fill="#4ade80" font-size="11" text-anchor="middle">1 outcome · "visible by 2.5 s": 60/60</text>
  <rect x="473.3" y="80" width="10" height="180" fill="#4ade80"/>
  <text x="478.3" y="72" fill="#4ade80" font-size="10.5" text-anchor="middle">all 60 runs</text>
  <line x1="412" y1="260" x2="732" y2="260" stroke="#475569"/>
  <g fill="#64748b" font-size="10">
    <text x="435.8" y="278" text-anchor="middle">140</text>
    <text x="492.7" y="278" text-anchor="middle">145</text>
    <text x="549.6" y="278" text-anchor="middle">150</text>
    <text x="606.5" y="278" text-anchor="middle">155</text>
    <text x="663.4" y="278" text-anchor="middle">160</text>
    <text x="720.3" y="278" text-anchor="middle">165</text>
  </g>
  <text x="571" y="304" fill="#64748b" font-size="10.5" text-anchor="middle">frame 144 — every run, forever</text>
</svg>

The wall runtime's delivery frame took **22 distinct values across 60 runs**, spread over frames 140–164 — a spread produced by nothing more sinister than timer jitter and simulated GC pauses on a fast, idle machine. The timing assertion passed 9 times out of 60. Not because the app is wrong — the app is *identical* — but because "visible by 2.5 s" is a question about a race, and every run resolves the race differently. This is the histogram your flaky test lives inside. A test-tooling response would now widen the timeout until the failures hide; the timing requirement itself — *is the product actually responsive?* — silently becomes untestable.

The virtual runtime's delivery frame is **144. Every run. Forever.** Not "passed 60 times" — *cannot fail*, in the sense that there is no remaining variable to make it fail: the delivery frame is a deterministic function of the tape, so asserting it is asserting arithmetic. And because pixel trajectories are deterministic too, the assertion vocabulary gets *stronger* than anything a wall-clock harness can offer: the CI suite that ships with this post asserts **run-to-run byte identity of the framebuffer hash of all 390 frames** of the café journey. It also runs the whole journey with *chaos injected between frames* — real wall-clock sleeps of random length, allocation garbage, forced GC — and asserts the trace does not change by one bit. It doesn't. The wall clock isn't an input, so torturing the wall clock changes nothing. That test is the architecture's signature, executable in about a third of a second: `bun test tests/sim.test.ts`.

One more honesty note: Runtime W *is* our runtime too. Determinism is not a property a good implementation earns; it is a property the **clock contract** grants. Change the contract, lose the property — instantly, in both directions.

## Time as a dial

Once time is a fold index instead of a physical fact, something strange and useful becomes possible: **the rate of time becomes a parameter.**

PocketJS's core has always advanced in fixed `1/60 s` ticks. The new virtual clock makes the *simulation rate* a host policy: a world can run at `simulationHz = 2`, meaning one frame transaction per half-second of virtual time, with the core catching up `30` fixed ticks inside each transaction. Durations don't warp — a 300 ms transition still takes 300 ms of virtual time at any rate, because it's defined in time, not in frames; the 2 Hz world just *observes* it coarsely. On the browser host this is literally a URL parameter — `?hz=2` runs the two-frames-per-second world on a real screen, animations easing in slow, deliberate steps.

Why on earth would you want a 2 FPS world? Because of what the CI suite proves next — the result I find genuinely beautiful. For an app whose logic lives on events and virtual time (not per-frame counters), the low-rate world is **not a degraded approximation of the 60 Hz world. It is the same world, observed less often**:

```
pixels_hz[m] == pixels_60[(60/hz)·(m+1) − 1]        for EVERY frame m
```

The test asserts this per frame, by hash, for 4 Hz and 2 Hz against 60 Hz: every one of the 2 Hz world's 13 framebuffers is byte-identical to the corresponding framebuffer of the 60 Hz world's 390. Same journey, same trajectory, same effects landing at the same virtual seconds (menu at 0.5 s, order at 3.5 s, confirmation at 4.5 s — at every rate), same settled final screen, byte-equal.

<svg viewBox="-14 0 774 268" width="100%" role="img" aria-label="Three time rails for the same journey at 60, 4, and 2 Hz. Vertical alignment lines mark shared milestones: menu lands at 0.5 s, order sent at 3.5 s, confirmed at 4.5 s, reset at 6.0 s. The 60 Hz rail has 390 dense frame ticks, the 4 Hz rail 26, the 2 Hz rail 13 — and at every shared instant the framebuffers are byte-equal." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <g stroke="#2b3a55" stroke-width="1" stroke-dasharray="3 4">
    <line x1="110.8" y1="42" x2="110.8" y2="206"/>
    <line x1="415.3" y1="42" x2="415.3" y2="206"/>
    <line x1="516.8" y1="42" x2="516.8" y2="206"/>
    <line x1="669"   y1="42" x2="669"   y2="206"/>
  </g>
  <g font-size="10">
    <text x="110.8" y="32" fill="#22d3ee" text-anchor="middle">menu lands · 0.5s</text>
    <text x="415.3" y="18" fill="#fbbf24" text-anchor="middle">order sent · 3.5s</text>
    <text x="516.8" y="36" fill="#4ade80" text-anchor="middle">confirmed · 4.5s</text>
    <text x="669"   y="18" fill="#94a3b8" text-anchor="middle">reset · 6.0s</text>
  </g>
  <g>
    <line x1="60" y1="70" x2="720" y2="70" stroke="#475569" stroke-width="1"/>
    <line x1="60" y1="64" x2="720" y2="64" stroke="#38bdf8" stroke-width="7" stroke-dasharray="1 0.69" opacity="0.8"/>
    <text x="52" y="68" fill="#e2e8f0" font-size="11" text-anchor="end">60 Hz</text>
    <text x="52" y="82" fill="#64748b" font-size="9" text-anchor="end">390 frames</text>
    <line x1="60" y1="130" x2="720" y2="130" stroke="#475569" stroke-width="1"/>
    <line x1="60" y1="124" x2="720" y2="124" stroke="#38bdf8" stroke-width="7" stroke-dasharray="2 23.4" opacity="0.9"/>
    <text x="52" y="128" fill="#e2e8f0" font-size="11" text-anchor="end">4 Hz</text>
    <text x="52" y="142" fill="#64748b" font-size="9" text-anchor="end">26 frames</text>
    <line x1="60" y1="190" x2="720" y2="190" stroke="#475569" stroke-width="1"/>
    <line x1="60" y1="184" x2="720" y2="184" stroke="#38bdf8" stroke-width="7" stroke-dasharray="2.5 48.25" opacity="0.9"/>
    <text x="52" y="188" fill="#e2e8f0" font-size="11" text-anchor="end">2 Hz</text>
    <text x="52" y="202" fill="#64748b" font-size="9" text-anchor="end">13 frames</text>
  </g>
  <g fill="#22d3ee"><circle cx="110.8" cy="70" r="3.4"/><circle cx="110.8" cy="130" r="3.4"/><circle cx="110.8" cy="190" r="3.4"/></g>
  <g fill="#fbbf24"><circle cx="415.3" cy="70" r="3.4"/><circle cx="415.3" cy="130" r="3.4"/><circle cx="415.3" cy="190" r="3.4"/></g>
  <g fill="#4ade80"><circle cx="516.8" cy="70" r="3.4"/><circle cx="516.8" cy="130" r="3.4"/><circle cx="516.8" cy="190" r="3.4"/></g>
  <g fill="#94a3b8"><circle cx="669" cy="70" r="3.4"/><circle cx="669" cy="130" r="3.4"/><circle cx="669" cy="190" r="3.4"/></g>
  <text x="380" y="234" fill="#94a3b8" font-size="11.5" text-anchor="middle">one journey, three rates of time — byte-equal wherever the worlds share an instant:</text>
  <text x="380" y="252" fill="#94a3b8" font-size="11.5" text-anchor="middle">pixels_hz[m] = pixels_60[(60/hz)(m+1)−1]</text>
</svg>

The rate dial has an obvious first customer: cost. The full 60 Hz café journey — 390 frames, every framebuffer rasterized and hashed — replays in **352 ms**, eighteen times faster than the 6.5 real-time seconds it represents. The 2 Hz journey replays in **22 ms**, three hundred times faster than real time. There is no waiting inside a fold; `sleep()` is just an index that increments.

But the deeper customer is whoever *reads* the trace.

## The world an agent wants to live in

Here is every frame the 2 Hz world produces for the entire café session. Not highlights — **all of it**:

<img class="w-full rounded-xl border border-line" src="/assets/blog/strip-2hz.png" alt="A filmstrip of all 13 frames of the café session at 2 Hz, labeled frame 0 through frame 12 with virtual timestamps: connecting, menu arrival, espresso added at t=1.0s, focus moving, latte x1 then x2, PLACING ORDER at t=3.5s, ORDER #1042 confirmed from t=4.5s, and the reset state at t=6.0s showing ORDERS PLACED 1." />

<p class="text-sm text-slate-500 -mt-4">The complete 2 Hz session: 13 frames, 6.5 virtual seconds, every phase of the journey legible — and each of these framebuffers is byte-identical to its counterpart in the 390-frame 60 Hz run.</p>

Look at that strip the way an AI agent would. An agent driving a UI today — through a browser — screenshots an unrepeatable process at arbitrary wall-clock moments, guesses whether the spinner it sees is *still* spinning or *newly* spinning, waits pessimistically, and can never re-examine a past state, only its stale screenshot of one. Every one of those pains is a hidden-input pain. Now give the agent this runtime instead:

- **Observation is enumerable.** The world advances in numbered transactions. "The state at frame 9" is a well-posed expression, not a race with a screenshot API. At 2 Hz, a whole session is 13 observations — and the subsampling theorem says these are *the same states* the 60 Hz user saw, not a lossy summary.
- **History is a data structure.** The input tape plus the effect trace *is* the session — a few hundred bytes of causality. Any past state is `O(n)` to revisit exactly, and at fold speed, "revisit frame 200" costs milliseconds. Time-travel debugging stops being a product feature and becomes an index lookup.
- **Hypotheticals are cheap.** Fork the tape at frame 9, splice in a different press, re-run the fold: a counterfactual world in 22 ms. An agent can *search* over futures the way a chess engine searches moves — because the world, like a chess position, finally has a transition function.
- **Verification is equality.** "Did my change break the flow?" is not a judgment call over screenshots; it is `trace == trace`, per frame, per byte. The agent-written test cannot flake for the same reason the human-written one can't: there is nothing left to vary.

We think this is what "agent-friendly UI" actually means. Not a better accessibility tree bolted onto a nondeterministic process — a **legible world**: enumerable time, recorded causes, replayable history, byte-checkable outcomes. The PSP taught this runtime to be small; determinism is what makes it *knowable*. It is probably not a coincidence that the tradition this borrows from — deterministic simulation — is also how we train and evaluate game-playing agents.

## What this doesn't claim

Boundaries, stated plainly, because a claim of "impossible" earns scrutiny.

**The fold is only as complete as its tape.** A live network is nondeterministic by nature; the shell doesn't change that — it *records* it, and the replay is then exact. Determinism here is a property of replay and simulation, not a denial that the outside world varies. Likewise, `Math.random()` and `Date.now()` are not fenced off by force; the contract is to express randomness as seeded state and time through the virtual clock, and the linters of the future can enforce what the architecture makes natural.

**A 2 Hz run validates the 2 Hz world.** The subsampling theorem covers the shared instants; if your app hard-codes per-frame logic ("on frame 37..."), its meaning legitimately differs across rates — so write seconds, which is what the clock API hands you. And the theorem's precondition (event- and time-driven logic) is a *discipline the runtime encourages*, not a law it can force on a counter you increment every frame.

**Wall-clock runtimes are not wrong.** Flutter skipping animation frames to stay glued to real time is the right call for a phone in a hand. Sampled time buys fluidity under jitter and pays in replayability; owned time buys replayability and pays by *scheduling* its world. The mistake is not either choice — it is making the first choice and then spending two decades of test-infrastructure effort pretending you made the second.

## Determinism is a choice

Here is the whole post in one sentence: **tests flake because runtimes let things change your app that nobody writes down — and a runtime can refuse.**

Every UI runtime decides what is allowed to change your program. The mainstream stack allows almost everything: the wall clock, the OS scheduler, whichever network packet lands first, a GC pause. Each guest was let in for a good reason, and each one makes your app's history unrepeatable — which is why your tests retry, your bug reports say "sometimes," and your debugger can only walk forward. Flakiness was never a tooling gap. It is simply what "anything can change the program at any moment" looks like from inside a test.

The games industry showed the other choice decades ago: let *nothing* change the program except the recorded input of each frame. Make the frame a transaction. Make time a counter. Make the network queue at the door. Then the entire life of an interface — every animation frame, every spinner, every confirmation toast — collapses into one expression:

```
history = inputs.reduce(F, state0)
```

and anything you can write as a `reduce` you can replay, subsample, fork, diff, and prove. `ui = f(state)` told us what a view is. `state[n+1] = F(state[n], input[n])` tells us what a *moment* is. The first equation gave interfaces to declarative programming; the second gives them to *simulation* — with byte-exact tests as the appetizer and legible worlds for agents as the meal.

Time is an input. Record it, and it will testify. Refuse, and it will flake — not sometimes; for as long as you refuse.

---

*The receipts, runnable from the [PocketJS repo](https://github.com/pocket-nexus/pocketjs): `bun test tests/sim.test.ts` (byte-identity, chaos immunity, the subsampling theorem), `bun tools/flake-lab.ts` (the two-clock histogram on your own machine), `?hz=2` on the web host (the 2 FPS world, on a real screen), and [docs/DETERMINISM.md](https://github.com/pocket-nexus/pocketjs/blob/main/DETERMINISM.md) (the contract). The café demo is `apps/cafe` — an ordinary PocketJS bundle; every host, including the PSP one, drives it through the same frame transaction.*
