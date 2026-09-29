<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-pi-esp32-hero.png" alt="Four screens of Pocket Pi's embedded device UI: a chat where the agent introduces itself as Pocket Pi, a chat where a five-minute schedule wake is created and shown in a NEXT WAKE panel, the workspace file browser listing memory.md and notes.txt on LittleFS, and the file viewer showing the contents of memory.md. The status bar of every screen shows live PSRAM, UI FPS, and LCD refresh telemetry." />

[Pi](https://github.com/badlogic/pi-mono) is a coding agent harness people actually build on: a deliberately minimal TypeScript loop with schema'd tools, streaming providers, and a clean extension seam. It runs wherever Node ≥ 22 runs — which is to say, nowhere near a microcontroller. We wanted the complete Pi to be usable on embedded devices: an agent that lives on the hardware, with its loop, files, schedules, and behavior on board, rather than a screen paired to a server that runs the real agent somewhere else. And we wanted it in TypeScript specifically, because an agent whose behavior is code-as-data can eventually revise itself — something an agent harness compiled into firmware can never offer.

So we ported it to an ESP32-P4 ([PR #9](https://github.com/pocket-nexus/pocket-pi/pull/9)). This is the story of how, layer by layer — starting with the part that didn't exist: embedded JavaScript has always meant an *engine*, never a *runtime*. [Pocket Pi](https://github.com/pocket-nexus/pocket-pi) is the runtime we built so that Pi would have something to stand on. (If you are new here: [PocketJS](/blog/introducing-pocketjs/) runs real web-framework components on 2004 handhelds; QuickJS, its engine, is about to get a very different tenant.)

## What Pi stands on

Pi's architecture is what made the port thinkable. Upstream, it splits into layers with real boundaries:

- **`pi-agent-core`** — the agent loop, turn state, and tool-call protocol. The model decides when to call a tool; tools return structured results; the loop knows nothing about transports or platforms.
- **The tool registry** — every capability is a schema'd value, not a hardcoded behavior.
- **Provider transports** — streaming adapters, separate from the loop.
- **`pi-coding-agent`** — the full product on top: sessions, extensions via a `(pi) => void` factory seam, the works.

Nothing in that stack *inherently* needs Node. It just assumes Node — casually, everywhere, the way all server-side JavaScript does: `fs`, `path`, `Buffer`, streams, `fetch`, an event loop, an ESM module graph. Engines like QuickJS, JerryScript, and Moddable XS give you ECMAScript and sometimes a module system of their own; none gives you that floor. Porting Pi therefore meant one thing at every layer: find what Pi assumes, and supply it.

## First, the desk: unmodified Pi with no Node installed

The port did not start on the board. It started with a stricter question: can the **full, unmodified** `pi-coding-agent` — the entire 9 MB bundle — run on QuickJS on a desktop, with no Node or Bun on the machine?

Getting to yes meant building the Node-shaped layer in Rust, feature by feature, in the order the bundle demanded it: a module system with CommonJS interop, then Web globals (`fetch`, streams), then the rest of the builtin surface — filesystem, `path`, `Buffer`, events, streams, `process`, synchronous subprocesses. Two problems stood out. Pi's dependency graph contains indirect ESM re-export cycles that QuickJS's module loader refuses outright, so the build pipeline learned to rewrite them before the engine ever sees the code. And extensions had to stay *dynamic*: Pi's plugin seam takes TypeScript factories at runtime, so the runtime transpiles them on the fly with oxc and injects them through Pi's own `extensionFactories` — the agent can be handed new tools, or write its own, without anyone recompiling anything. Pi itself is never patched.

That desktop profile still ships as the product's full tier. It also produced the number that shaped everything after.

## 46 MB of agent, 32 MB of PSRAM

With the runtime working, we measured what the board would actually have to hold:

<svg viewBox="0 0 760 210" width="100%" role="img" aria-label="Bar chart of QuickJS heap requirements. Booting the full pi-coding-agent takes 46.6 megabytes, of which 27.4 megabytes is compiled JS functions. The ESP32-P4's total PSRAM is 32 megabytes, which must also hold framebuffers and Wi-Fi. One pi-agent-core conversation turn holds about 1.3 megabytes." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="210" rx="12" fill="#0b0f1a"/>
  <text x="24" y="34" fill="#94a3b8" font-size="12">QuickJS heap, measured</text>
  <text x="24" y="66" fill="#f1f5f9" font-size="12">full pi-coding-agent, boot</text>
  <rect x="24" y="74" width="640" height="18" rx="4" fill="#f87171"/>
  <rect x="24" y="74" width="376" height="18" rx="4" fill="#b91c1c"/>
  <text x="672" y="88" fill="#f87171" font-size="12">46.6 MB</text>
  <text x="30" y="87" fill="#fee2e2" font-size="10">27.4 MB compiled JS functions</text>
  <text x="24" y="122" fill="#f1f5f9" font-size="12">ESP32-P4 PSRAM, total — incl. framebuffers &amp; Wi-Fi</text>
  <rect x="24" y="130" width="439" height="18" rx="4" fill="#38bdf8"/>
  <text x="471" y="144" fill="#38bdf8" font-size="12">32 MB</text>
  <text x="24" y="178" fill="#f1f5f9" font-size="12">pi-agent-core, one turn held</text>
  <rect x="24" y="186" width="18" height="18" rx="4" fill="#34d399"/>
  <text x="50" y="200" fill="#34d399" font-size="12">~1.3 MB</text>
</svg>

Booting the full bundle takes 46.6 MB of heap — 27.4 MB of it just compiled JS functions — against 32 MB of PSRAM that also has to hold framebuffers, Wi-Fi buffers, and TLS. That chart closed the "ship the desktop profile" debate in an afternoon and split the runtime into two compositions of one family:

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="Architecture diagram. Two profile boxes at the top: crates/pocket-pi, the full desktop profile running the unmodified 9 megabyte pi-coding-agent bundle, feeding hosts/desktop; and crates/pocket-pi-embedded, the embedded profile running pi-agent-core as a 304 kilobyte bundle, feeding crates/pocket-pi-device-ui, which fans out to firmware/esp32-p4 for the physical board and hosts/esp32-p4-sim for the macOS simulator." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="330" rx="12" fill="#0b0f1a"/>
  <rect x="36" y="28" width="300" height="66" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="186" y="55" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">crates/pocket-pi</text>
  <text x="186" y="76" fill="#94a3b8" font-size="11" text-anchor="middle">full pi-coding-agent · 9 MB bundle</text>
  <rect x="424" y="28" width="300" height="66" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="574" y="55" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">crates/pocket-pi-embedded</text>
  <text x="574" y="76" fill="#94a3b8" font-size="11" text-anchor="middle">pi-agent-core · 304 KB bundle</text>
  <line x1="186" y1="94" x2="186" y2="142" stroke="#475569" stroke-width="1.5"/>
  <line x1="574" y1="94" x2="574" y2="142" stroke="#475569" stroke-width="1.5"/>
  <rect x="66" y="142" width="240" height="52" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="186" y="173" fill="#f1f5f9" font-size="13" text-anchor="middle">hosts/desktop</text>
  <rect x="424" y="142" width="300" height="52" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="574" y="166" fill="#f1f5f9" font-size="13" text-anchor="middle">crates/pocket-pi-device-ui</text>
  <text x="574" y="184" fill="#94a3b8" font-size="11" text-anchor="middle">one draw list · one hit map · one font set</text>
  <line x1="574" y1="194" x2="484" y2="242" stroke="#475569" stroke-width="1.5"/>
  <line x1="574" y1="194" x2="664" y2="242" stroke="#475569" stroke-width="1.5"/>
  <rect x="374" y="242" width="220" height="62" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="484" y="268" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">firmware/esp32-p4</text>
  <text x="484" y="288" fill="#94a3b8" font-size="11" text-anchor="middle">the board</text>
  <rect x="614" y="242" width="130" height="62" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="679" y="268" fill="#f1f5f9" font-size="12" text-anchor="middle">esp32-p4-sim</text>
  <text x="679" y="288" fill="#94a3b8" font-size="11" text-anchor="middle">same product, Mac</text>
  <text x="36" y="312" fill="#64748b" font-size="11">two profiles of one agent — not three forks</text>
</svg>

The embedded profile runs upstream `pi-agent-core` — the loop, the turn state, the tool-call protocol, unchanged — bundled to **304 KB**, holding a conversation turn in about **1.3 MB** of heap. Under it sits the same runtime idea taken to its floor: the Rust host provides exactly what that core touches — `TextEncoder`, a microtask pump, `URL`, a streaming transport, tool dispatch — and nothing speculative. The list is honest because every missing item announced itself; the first on-device tool call died with `URL is not defined`, and `URL` joined the shims.

Even getting QuickJS to *parse* the bundle on-device was a fight. Fully minified esbuild output produces expressions nested deeply enough to blow the 8 KB task stack before the agent ever ran — and a later variant kept the parser busy for four minutes, tripping the 5-second watchdog. The fixes were humbling: `minifyWhitespace` only, and a dedicated 64 KB stack for the agent task.

## Tools are the operating system now

On the desk, Pi's tools lean on POSIX. On the board there are no processes, no pipes, no `/bin` — so every capability had to be rebuilt as native Rust behind Pi's own schemas, on a chip that fights back:

<svg viewBox="0 0 760 430" width="100%" role="img" aria-label="Board architecture. Inside the ESP32-P4: QuickJS runs the pi-agent-core bundle; native Rust tools provide read, write, edit, find, grep, ls, an allowlisted bash, device.status, time.now, workspace.context, and schedule operations; the PocketJS UI renders chat, files, settings, keyboard, and telemetry; an 8 megabyte LittleFS workspace persists schedules, files, and chat history. Below the streaming model boundary sit two backends: UartBackend bridging to a Mac's Codex or Claude CLI, and WirelessBackend speaking HTTPS to OpenAI, OpenRouter, or Anthropic." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="430" rx="12" fill="#0b0f1a"/>
  <rect x="24" y="22" width="712" height="252" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="44" y="48" fill="#f59e0b" font-size="12" font-weight="700">ESP32-P4</text>
  <rect x="44" y="62" width="330" height="52" rx="8" fill="#0b0f1a" stroke="#34d399" stroke-width="1.5"/>
  <text x="209" y="84" fill="#f1f5f9" font-size="12" text-anchor="middle">QuickJS — pi-agent-core</text>
  <text x="209" y="102" fill="#94a3b8" font-size="11" text-anchor="middle">304 KB bundle · ~1.3 MB heap per turn</text>
  <rect x="394" y="62" width="322" height="52" rx="8" fill="#0b0f1a" stroke="#34d399" stroke-width="1.5"/>
  <text x="555" y="84" fill="#f1f5f9" font-size="12" text-anchor="middle">PocketJS UI · 720×1280 RGB565</text>
  <text x="555" y="102" fill="#94a3b8" font-size="11" text-anchor="middle">chat · files · settings · keyboard · telemetry</text>
  <rect x="44" y="130" width="330" height="88" rx="8" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="209" y="152" fill="#f1f5f9" font-size="12" text-anchor="middle">native Rust tools</text>
  <text x="209" y="172" fill="#94a3b8" font-size="11" text-anchor="middle">read · write · edit · find · grep · ls · bash*</text>
  <text x="209" y="190" fill="#94a3b8" font-size="11" text-anchor="middle">device.status · time.now · workspace.context</text>
  <text x="209" y="208" fill="#94a3b8" font-size="11" text-anchor="middle">schedule.set / list / cancel / clear</text>
  <rect x="394" y="130" width="322" height="88" rx="8" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="555" y="152" fill="#f1f5f9" font-size="12" text-anchor="middle">LittleFS workspace — 8 MB</text>
  <text x="555" y="172" fill="#94a3b8" font-size="11" text-anchor="middle">agent files · schedule.json · chat JSONL</text>
  <text x="555" y="190" fill="#94a3b8" font-size="11" text-anchor="middle">survives reboot and power cuts</text>
  <text x="44" y="248" fill="#64748b" font-size="11">*bash is an allowlisted dispatcher — no processes, no pipes, no /bin</text>
  <line x1="380" y1="274" x2="380" y2="308" stroke="#475569" stroke-width="1.5"/>
  <text x="396" y="296" fill="#64748b" font-size="11">streaming model boundary</text>
  <line x1="380" y1="308" x2="200" y2="336" stroke="#475569" stroke-width="1.5"/>
  <line x1="380" y1="308" x2="560" y2="336" stroke="#475569" stroke-width="1.5"/>
  <rect x="60" y="336" width="280" height="66" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="200" y="362" fill="#f1f5f9" font-size="12" text-anchor="middle">UartBackend</text>
  <text x="200" y="382" fill="#94a3b8" font-size="11" text-anchor="middle">Mac bridge → Codex / Claude Code CLI</text>
  <rect x="420" y="336" width="280" height="66" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="560" y="362" fill="#f1f5f9" font-size="12" text-anchor="middle">WirelessBackend</text>
  <text x="560" y="382" fill="#94a3b8" font-size="11" text-anchor="middle">HTTPS → OpenAI / OpenRouter / Anthropic</text>
</svg>

The file six-pack — `read`, `write`, `edit`, `find`, `grep`, `ls` — landed on an 8 MB LittleFS partition, and immediately taught us LittleFS's rules: `rename` on a file whose handle is still open returns `EBUSY`, a lesson we got to learn twice, once in the file tools and once more in schedule persistence. `bash` became an honest allowlisted dispatcher (`ls`, `cat`, `grep`, `wifi status`, `reboot`; backticks rejected) rather than a POSIX cosplay that would only teach the model to fail. `workspace.context` aggregates the agent's own Markdown memory into its context, bounded at 16 KiB. And `schedule.*` turned the agent into something with a pulse: one-off and recurring wake prompts persisted to `/workspace/.pi-agent/schedule.json`, missed wakes collapsing into one catch-up run, fired by the firmware's wake loop with no human and no server involved. The Pi runtime reads tool definitions from the executable registry itself, so advertised and executable tools cannot drift.

The model is the one thing that stays remote — same as a laptop. Pi's provider layer kept its upstream boundary and grew two hosts: `WirelessBackend` speaks Chat Completions and Anthropic Messages over HTTPS, and `UartBackend` streams through a Mac's logged-in Codex or Claude Code CLI during development. Everything that decides, executes, and persists stays on the board.

## Wiring the glass

An agent you can hold needs a screen you can touch, and this is where PocketJS pays for itself twice. Its engine already hosts the agent; its renderer got a sibling crate, `pocket-pi-device-ui`, that emits draw lists straight to the panel — chat with streamed replies, the workspace file browser, Wi-Fi settings, an on-screen keyboard, and a telemetry bar showing real PSRAM, per-core CPU, and presented-frame FPS:

<svg viewBox="0 0 760 150" width="100%" role="img" aria-label="Render pipeline. A PocketJS draw list flows into damage regions, then the P4's PPA hardware blitter, then three RGB565 framebuffers totaling 5.5 megabytes, then two-lane MIPI-DSI scanout to the 720 by 1280 panel." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="150" rx="12" fill="#0b0f1a"/>
  <rect x="24" y="46" width="110" height="52" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="79" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">PocketJS</text>
  <text x="79" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">draw list</text>
  <line x1="134" y1="72" x2="158" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="158" y="46" width="110" height="52" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="213" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">damage</text>
  <text x="213" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">regions</text>
  <line x1="268" y1="72" x2="292" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="292" y="46" width="110" height="52" rx="10" fill="#111827" stroke="#475569" stroke-width="1.5"/>
  <text x="347" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">PPA</text>
  <text x="347" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">hardware blit</text>
  <line x1="402" y1="72" x2="426" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="426" y="46" width="130" height="52" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="491" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">3× RGB565</text>
  <text x="491" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">5.5 MB PSRAM</text>
  <line x1="556" y1="72" x2="580" y2="72" stroke="#475569" stroke-width="1.5"/>
  <rect x="580" y="46" width="156" height="52" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="658" y="68" fill="#f1f5f9" font-size="12" text-anchor="middle">MIPI-DSI</text>
  <text x="658" y="86" fill="#94a3b8" font-size="11" text-anchor="middle">720×1280 panel</text>
  <text x="24" y="128" fill="#64748b" font-size="11">quiet frames are nearly free; a full redraw is 921,600 pixels</text>
</svg>

The end-to-end interaction loop runs across two threads: touch events map through a hit table into screen state, the agent works on a worker thread, and streamed model deltas are projected into the chat as they arrive, so the UI never blocks on the model. Linking the renderer cost about **24 KB of code**, with **zero PocketJS engine changes** — the port pins an unmodified upstream revision. The same crate compiles into a macOS simulator (that is what the hero image shows): one draw list, one set of font atlases, one touch hit map, mouse clicks dispatched through the same `handle_tap` as the hardware touch controller, so product flows iterate in seconds while the board stays the acceptance target.

The glass also produced the port's best bugs. The panel flashed blue once per second, and we fixed it three times: triple buffering helped but didn't cure it, because the real cause was the MIPI-DSI controller underrunning while fetching frames from PSRAM — the ESP-IDF driver source literally documents that the panel "may turn blue." Damage-region rendering cut the write traffic; dropping the pixel clock from 58 MHz to 34 MHz and enabling the PPA finished it. And at the very end, with everything working, the model streamed `I'm Pocket Pi` — and the panel rendered `I?m`. The font atlases were ASCII-only; the model uses U+2019 like any well-raised language model. The last fix of the port baked curly quotes, dashes, and the ellipsis into all four atlases with the PocketJS font baker. If you want proof that a real model is talking to your firmware, typography is it.

## The end-to-end run

The acceptance run is a 45-second recording of the board doing, in order:

1. answering `Who are you?` as a Pi agent on an ESP32-P4;
2. calling `device.status` and reporting live heap numbers — values that change between runs, so they can't be canned;
3. reading three workspace files and writing a summary it composed itself, then showing the new file in the Files browser;
4. setting a one-minute schedule and waking up on its own, untouched, to reply;
5. coming back from a hard power cut with files and schedules intact — they live in LittleFS, not RAM.

Each step closes a specific skeptic's loophole: real tool calls instead of scripted text, a filesystem that visibly changed, a wake with no hands on the device, and persistence proven by cutting power rather than by claiming it.

## The gaps, named, because that is house policy

- The board runs the embedded `pi-agent-core` profile, not the desktop `pi-coding-agent` unchanged. That distinction is load-bearing and 46.6 MB wide.
- Runtime TypeScript extension loading ships in the desktop profile; the embedded profile's tool registry is still fixed at boot. The runtime treats code as data, so the path is open — but on-device hot-loading is direction, not shipped.
- The embedded runtime is not general Node: it implements what `pi-agent-core` exercises, and a dependency that wants more will say so at parse or boot.
- File tools and the on-device viewer handle UTF-8 text — no PDFs, no images. `bash` is an allowlisted dispatcher, not POSIX.
- Inference is remote; the model is a provisioned network service. Model transport errors still render as chat text rather than a proper faulted state.

## Try it

The repo is [pocket-nexus/pocket-pi](https://github.com/pocket-nexus/pocket-pi). The simulator runs the same embedded agent, tool registry, and UI crate as the firmware:

```sh
cargo xtask run esp32-p4-sim --backend codex --workspace target/esp32-workspace
```

And if you have the board:

```sh
cargo xtask build esp32-p4
espflash flash --baud 921600 --port "$DEVICE_PORT" \
  firmware/esp32-p4/target/riscv32imafc-esp-espidf/release/pocket-pi-p4
python3 tools/uart-model-bridge.py "$DEVICE_PORT" --backend uart --provider codex
```

Where this goes next follows from the property that justified the whole port — behavior as files. Apps as tools-plus-a-view in the agent's own workspace, loadable and revisable by the agent itself, are the obvious continuation; that is a post for when it is real.

The missing piece was never the agent, and it was never the chip. It was the runtime between them. Ask the board who it is. It knows.
