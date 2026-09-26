// site/nav.ts — the docs information architecture. build.ts renders one page
// per slug from site/content/docs/<slug>.md and builds the sidebar from this.
export interface DocItem {
  slug: string;
  title: string;
}
export interface DocSection {
  title: string;
  items: DocItem[];
}

export const DOC_NAV: DocSection[] = [
  {
    title: "Introduction",
    items: [
      { slug: "overview", title: "Overview" },
      { slug: "getting-started", title: "Getting started" },
      { slug: "frameworks", title: "Frameworks" },
      { slug: "architecture", title: "Architecture" },
    ],
  },
  {
    title: "Guides",
    items: [
      { slug: "components", title: "Components" },
      { slug: "styling", title: "Styling" },
      { slug: "reactivity", title: "Reactivity" },
      { slug: "animation", title: "Animation" },
      { slug: "input-focus", title: "Input & focus" },
      { slug: "touch-gestures", title: "Touch & gestures" },
      { slug: "app-shell", title: "App shell & overlays" },
      { slug: "devtools", title: "DevTools" },
    ],
  },
  {
    title: "MicroTS",
    items: [
      { slug: "microts", title: "Build a native Vue app" },
      { slug: "microts-components", title: "Components and state" },
      { slug: "microts-reference", title: "API and commands" },
      { slug: "microts-solid", title: "Solid TSX to Rust" },
      { slug: "microts-model", title: "TypeScript models to Rust" },
      { slug: "microts-boundaries", title: "TypeScript and native code" },
    ],
  },
  {
    title: "Reference",
    items: [
      { slug: "typescript-support", title: "TypeScript support" },
      { slug: "api", title: "API reference" },
      { slug: "build-pipeline", title: "Build pipeline" },
      { slug: "native-contract", title: "Native contract" },
      { slug: "platform-contracts", title: "Platform contracts" },
      { slug: "esp-idf", title: "ESP-IDF" },
    ],
  },
];

// The blog registry. build.ts renders one page per post from
// site/content/blog/<slug>.md plus the /blog/ index (newest first).
export interface BlogPost {
  slug: string;
  title: string;
  date: string; // ISO yyyy-mm-dd
  description: string;
  author: { name: string; url: string };
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "one-relay-for-every-companion",
    title: "One Relay for Every Companion: Sessions, Resources, and Backpressure",
    date: "2026-09-22",
    description:
      "Pocket Map and Pocket Term each grew private machinery for sessions, frames, resource identity and backpressure. Pocket Relay extracts those repeated layers without merging their product schemas, with measured results from both migrations and explicit physical-hardware limits.",
    author: { name: "liufengkai", url: "https://github.com/lfkdsk" },
  },
  {
    slug: "blackberry-classic",
    title:
      "A Square Screen and a Dead Signing Server: PocketJS on the BlackBerry Classic",
    date: "2026-08-19",
    description:
      "A 2014 square-screen BlackBerry, and the only thing standing between it and a freshly written frame: signing servers that went dark in January 2022. The port itself is one 547-line BB10 Core Native host over libscreen, EGL and GLES2. Around it: QNX's microkernel, where even the compositor is a user-space service; the community root project that reopened the door; a phone that appears on your desk as a network host, managed over HTTPS+CGI+XML and mounted over SMB; and an optical trackpad treated as just another relative axis.",
    author: { name: "HalfSweet", url: "https://github.com/HalfSweet" },
  },
  {
    slug: "pocketjs-on-windows-ce",
    title: "From Message Pump to Multitouch: Windows CE, PocketJS, and the Meizu M8",
    date: "2026-08-16",
    description:
      "A PocketJS port becomes an excavation of the Windows CE programming model: message pumps, HWNDs and GDI versus reactive state and declarative UI—and the shell, caches, interaction design and stubborn engineering that made the Meizu M8 feel like an iPhone.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "agent-native-runtime-embedded-systems",
    title: "Taking a Step Further Towards an Agent-Native Runtime on Embedded Systems",
    date: "2026-08-15",
    description:
      "Pocket Pi's Bundle-first runtime proved installable Apps on an ESP32-P4. This post derives the next architecture from first principles: protected native mechanisms, one PocketJS substrate, a JavaScript System Framework, bounded Guests, durable App Data, and a path from source-native revision to hardware portability and System OTA.",
    author: { name: 'Siwei "Jerry" Yuan', url: "https://github.com/siwei-yuan" },
  },
  {
    slug: "pocket-pi-agent-native-runtime",
    title: "Designing Apps for Humans and Agents in an Agent-Native Runtime",
    date: "2026-08-11",
    description:
      "What should an App be when both a human and an Agent can act on it? Pocket Pi derives the answer from first principles: each App is a firmware-independent product unit executed by one or more isolated PocketJS Guests, built from App-owned SQLite Data, actor-neutral Actions, and a fixed human-facing View. Tools and UI intents become two surfaces over the same behavior; a resident Pi Agent coordinates many isolated Apps and can help evolve each complete product boundary without teaching firmware what the product means.",
    author: { name: 'Siwei "Jerry" Yuan', url: "https://github.com/siwei-yuan" },
  },
  {
    slug: "pocket-voxel",
    title: "Pocket Voxel: A Creature-RPG From First Principles",
    date: "2026-08-07",
    description:
      "A Game Boy creature-RPG and the mod that presents it as a walking 3D voxel diorama, both Lua on LÖVE, rewritten as a TypeScript gameplay guest and a Rust scene core on a real 2004 PSP. You bring the cartridge. Inside: the inverted split that puts the whole game state in QuickJS, luajit re-running the original as a bit-for-bit oracle, the hardware bug determinism could never catch, and the campaign that took outdoor frames from 102 ms to a locked 30 fps.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocketjs-on-the-first-iphone",
    title: "No Shaders, No Objective-C: PocketJS on the First iPhone",
    date: "2026-08-06",
    description:
      "Xcode 26 still compiles ARMv6, but its classic linker crashes on the Objective-C metadata its own compiler emits \u2014 so the UIKit host for a 2007 iPhone is C that registers its classes through the Objective-C runtime at startup. And the PowerVR MBX Lite predates shaders, so the renderer feeding it has none either: the two lines of GLSL PocketJS used on Symbian turn out to be exactly glOrthof plus GL_MODULATE. Verified by reading the phone's own framebuffer back over USB and diffing it against the reference rasterizer \u2014 0.04 of 255. Then the part where we measured the result wrong three times running and published the opposite of the truth.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocket-pi-on-esp32-p4",
    title: "Just Enough Node: Porting the Pi Coding Agent to the ESP32-P4",
    date: "2026-08-06",
    description:
      "Pi is a TypeScript coding agent harness people build on, and it runs wherever Node ≥ 22 runs — nowhere near a microcontroller. We wanted the complete agent living on embedded hardware, not a screen paired to a server, so we ported it layer by layer: a Node-shaped runtime in Rust around QuickJS (the unmodified 9 MB pi-coding-agent runs on the desktop with no Node installed), a 304 KB pi-agent-core profile for the board after the 46.6 MB measurement, native Rust tools standing in for POSIX on LittleFS, a streaming model transport over Wi-Fi or UART, and a PocketJS UI wired end to end. What Pi assumes, what the chip lacks, what broke, and how it ran.",
    author: { name: 'Siwei "Jerry" Yuan', url: "https://github.com/siwei-yuan" },
  },
  {
    slug: "octane-on-psp",
    title: "useState at 333 MHz: Octane Is PocketJS's Third Framework",
    date: "2026-07-30",
    description:
      "React itself can't run on a 2004 Sony PSP — 333 MHz, 32 MB of RAM. Octane compiles React's programming model instead of shipping its runtime, so we made it PocketJS's third framework beside Solid and Vue Vapor. Between \"it boots\" and 60 FPS: a WeakMap the JS engine's GC never frees, the discovery that a 2021 build flag had been silently shipping an unoptimized interpreter ever since, and a hard rule — on hardware like this, continuous animation never touches setState. Full three-framework benchmark included; every demo ends up inside the 16.7 ms frame budget.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocketjs-on-symbian",
    title: "Symbian Wanted a Frame Function: PocketJS on a Nokia E7",
    date: "2026-07-26",
    description:
      "Solid components, a Cover Flow launcher, a real Figma file and a 3D FPS, running natively on Symbian Belle. What the active-object model is, and what a new machine is allowed to change.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocket-character",
    title: "Pocket Character: a Desktop Digital Human in One Native Process",
    date: "2026-07-19",
    description:
      "airi's 3D digital human — same VRM model, same idle loop, same blink math, same spring-bone physics, same transparent always-on-top window — rebuilt as a single native process on the Pocket runtime: 118 MB and 4 % of one core instead of an Electron tree's 2.2 GB and 44 %. Inside: morph targets that cost nothing between blinks, a VRM crate that learned the difference between +Z and −Z the hard way, a QuickJS bundle as the hot-swappable personality, and a measurement section with receipts — same machine, same ruler, screenshots included.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocket-youtube",
    title: "Pocket YouTube: Streaming YouTube to a PSP over a USB Cable",
    date: "2026-07-17",
    description:
      "The PSP's radio can't reach the modern web, so the network moved to the other end of the cable: a Mac companion runs yt-dlp and ffmpeg, and the handheld plays a ring buffer that happens to be a file — search, CJK titles, seek, pause, 44.1 kHz audio and all. Inside: a stream container you can ls, 256 colors impersonating 720p at 12 fps, and the three bugs only real silicon would show — a GPU race photographed by its own raster line, a leaked audio channel, and a build that shipped last week's code with a green checkmark.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocketjs-on-ps-vita",
    title: "Twice the Pixels, Zero Forks: PocketJS on PS Vita",
    date: "2026-07-13",
    description:
      "PocketJS 0.4.0's headline: the same apps, unchanged, as native PS Vita bubbles. The Vita port is now verified on real hardware: the 480×272 logical world renders at a true 960×544 through a target-owned raster density, while a pocket.json contract system makes ad hoc platform hacks fail the build. Plus front touch as deterministic input, 44 byte-exact Vita goldens, and release VPKs installed and run on a physical Vita.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "pocket-figma",
    title: "Pocket Figma: Figma at 333 MHz",
    date: "2026-07-10",
    description:
      "The limit of 2D UI is Figma — so we made a 2004 Sony PSP open a real design file. What actually lives inside a .fig, mapped byte by byte (it tells you how to read itself), baking 14,430 nodes into streamed CLUT8 tile pyramids where whitespace is free, the anatomy of a zoom, and nub-panning a 26,000-pixel artboard at 60 FPS in 32 MB — deterministic to the byte, at any clock rate.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "ui-runtime-that-cant-flake",
    title: "The UI Runtime That Can't Flake",
    date: "2026-07-09",
    description:
      "Why UI tests flake — a runtime-architecture answer, not a tooling one. Make every frame a pure state transition, quantize the network onto frame boundaries, and time becomes data: 60 runs of the same journey, one histogram bar. Then turn the clock rate into a dial and a whole user session becomes 13 replayable frames — the world an agent actually wants to live in.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "shipping-openstrike",
    title: "Shipping OpenStrike: a Counter-Strike-Shaped FPS on a 2004 Handheld",
    date: "2026-07-09",
    description:
      "OpenStrike is out — classic BSP maps, bots, tracers, and a Solid JSX HUD holding a locked 60 FPS on a real Sony PSP: 333 MHz, 32 MB, no shaders. A field guide for JavaScript developers to how it works: rules and HUD in TypeScript on QuickJS, a bundler for 1999's geometry, and a 16.7 ms budget with receipts.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "time-travel-devtools",
    title: "Time Travel over a USB Cable: PocketJS DevTools",
    date: "2026-07-08",
    description:
      "A component inspector that highlights on the PSP's physical screen, pause/step for the whole world, a REPL into the handheld — and time-travel debugging where a session is two bytes per frame, carried over PSPLINK, the homebrew scene's answer to the GDB remote stub.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "baking-motion",
    title: "Baking Motion into PocketJS: Keyframes, Arcs, and a 3D Pipeline",
    date: "2026-07-07",
    description:
      "The style table learns motion: compile-time keyframe timelines, an animatable stroke-arc primitive, and a painter-sorted 3D pipeline — plus the four hardware performance lessons a one-to-one port of yui540's motion studies forced out of the engine.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
  {
    slug: "introducing-pocketjs",
    title: "Introducing PocketJS",
    date: "2026-07-06",
    description:
      "Real Solid and Vue Vapor components, a compile-time Tailwind design system, and 60 FPS native animation on a 2004 handheld — inside 8 MB. What PocketJS is, and what's actually new in it.",
    author: { name: 'Yifeng "Evan" Wang', url: "https://github.com/doodlewind" },
  },
];
