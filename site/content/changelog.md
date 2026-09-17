# Changelog

Engine and site milestones, newest first. Versions track the
`@pocketjs/framework` npm package.

## 0.12.0 — September 17, 2026

**Whole-text CJK loading, background resources, and device-aware presentations.**
PSPMAN's Japanese text feedback helped shape this release's CJK work.
PocketJS can keep common characters in memory, load uncommon characters in
the background, and show an animated skeleton until an entire text is ready.
Dynamic content such as song titles and book chapters can appear together,
without characters arriving a few at a time.

- **Prepared text reserves every required glyph before loading begins.**
  `openFontArchive` configures common-character residency and memory limits;
  `prepareText` returns a resource for the complete text. Live resources pin
  their glyphs, including while offscreen, and overlapping texts share cells.
  Solid's `Text` consumes the resource through the existing resource boundary
  with loading and error fallbacks. A batch that exceeds capacity or contains
  an unavailable glyph reports an error instead of displaying partial text.
- **Font I/O runs through companion or PSP storage workers.** Both providers
  use `io.offload` with bounded requests, retries and session checks. Streamed
  source bitmaps share a 2 MiB native ceiling; closing an archive releases its
  allocations, and failed index-page reads cannot poison later cache hits.
  The Text Lab demonstrates a music list and chapter reader with animated
  skeletons. Regression coverage includes 1,000 runtime song titles, uncommon
  characters, eviction, pinned content and reloads; the PSP build was checked
  on hardware. The implementation is available on PSP and through WASM host
  operations. Other native hosts need the batch operations before enabling it.
- **External fonts are generated assets with an explicit migration path.**
  Font tooling builds PJFA archives from application-supplied font files and
  can derive coverage from text files or Unicode ranges. Full font sources
  and generated archives stay outside Git. Downstream apps using custom
  formats, including PSPMAN's PJPF, must regenerate archives and adopt the
  prepared-text lifecycle. This release supplies that framework path; it does
  not migrate PSPMAN itself. See the
  [dynamic text guide](https://github.com/pocket-stack/pocketjs/blob/v0.12.0/docs/DYNAMIC_TEXT.md).
- **Shared resources and offload queues separate I/O from frame work.**
  Scoped demand, reactive reads and cache ownership connect visibility to
  resource lifetime. Bounded worker mailboxes carry provider requests and
  results without socket or storage calls on the UI thread. Shared companion
  sessions add reconnect and backpressure for stateful services. A bounded
  Rust prediction module reconciles simulation state without rewinding UI or
  repeating external effects.
- **Applications select presentations from device input and display facts.**
  Manifest presentations can target screen count, touch location and control
  availability. Shared actions express confirm, back and media intents;
  keyboards choose layouts for buttons or touch surfaces. Classic controls
  add shared lists, footers, skeletons and sprite spinners, while the system
  sheet exposes application actions and return-to-launcher behavior.
- **Media and text services cover more application flows.** Native 3DS
  playback uses the shared media provider with audio-clock timing and bounded
  buffering. Media support adds local downloads and timed captions. Clear's
  companion input uses reusable glyph resources, revision-checked candidate
  windows and text layouts that preserve cached characters across edits.
- **Desktop rendering and native integrations expand.** Desktop hosts gain
  portable GPU rendering and offloaded text. ESP-IDF integrations provide
  separate package, guest, UI and renderer components for ESP32-P4 and S3.
  The 3DS runtime isolates application state, returns to the Homebrew Launcher,
  and acquires native sources without PSP dependencies. Legacy iPod touch
  installs use removable user applications.
- **Pocket3D shares geometry across rendering and simulation.** Handheld
  animation uses shared skin bindings and indexed PICA skinning. Collision
  geometry also governs water transport; contact-based locomotion, occluder
  fading and themed PocketJS control overlays extend the shared world.
  The site adds handheld application demos, updated use cases and restored
  mobile documentation navigation.

## 0.11.0 — August 30, 2026

**Two more device families run PocketJS, a second backend class paints through gpui and measures text on the host, and a paired Nintendo 3DS takes new guests over Wi-Fi.**
0.11.0 adds the Nintendo 3DS and the BlackBerry Classic to the host set, a
backend class that hands text measurement to the platform instead of a baked
atlas, and a System that supervises several guests behind one compositor on
macOS, Linux and the browser. Both new device profiles remain private
development targets: each records an exact hardware and firmware tuple, and
neither advertises a production capability from a build alone.

- **The Nintendo 3DS runs a QuickJS guest on both screens.** The split follows
  `hosts/iphone2g` rather than `hosts/psp`: citro3d is mostly `static inline`,
  so C owns the GPU while a `no_std` Rust staticlib built for the built-in
  `armv6k-nintendo-3ds` target owns the core and exports the DrawList. The top
  screen is a fixed 400×240 viewport and the touch screen a 320×240 auxiliary
  surface; touch arrives on the auxiliary surface alone. `3ds-dev` is host ABI
  8. The demo splits one classic iPhone Contacts app across the two: a
  10,000-row virtual list, its section index and its scrubber below, and the
  detail card the phone had to push a navigation level to reach above. Goldens
  run the same PICA200 code path under Azahar and match hardware.
- **Pocket Runtime accepts a new guest over Wi-Fi.** `bun run 3ds:dev pair`
  installs a 32-byte key once through ftpd; after that a paired TCP connection
  carries `.pocket` updates and dual-screen RGB8 captures as bounded binary
  frames that never enter QuickJS, and `bun run 3ds:dev dev` bridges the
  existing DevTools protocol to the panel. Updates reuse the Runtime's target
  and ABI admission, immutable package storage, retired-frame acceptance and
  rollback path. `L+R+SELECT` opens a Runtime-owned menu on the bottom screen
  with the device's IP, pairing and connection state, generation and package
  hash. The pairing key authenticates but does not encrypt the LAN connection,
  and the channel updates guests only: a new `.3dsx` or CIA still requires
  deployment and a restart.
- **The BlackBerry Classic runs two hosts over one shared contract.**
  `hosts/blackberry-classic-qnx` is a BB10 Core Native host (libscreen, BPS,
  EGL/GLES2) built and packaged as an unsigned development BAR inside the
  digest-pinned BBNDK image and installed on a rooted Classic;
  `hosts/blackberry-classic-android` is an Android Runtime (API 18) host whose
  v1-signed APK drives the same QuickJS bridge and Rust core through a JNI
  `armeabi-v7a` library. Both register at 720×720 physical, 360×360 logical at
  density 2, host ABI 9. First device run recorded on an SQC100-4 at
  10.3.3.3216; the [port write-up](/blog/blackberry-classic/) walks the QNX
  route onto the square screen.
- **A second backend class paints through gpui and measures text on the
  host.** The portable family (wgpu, software raster, PPA, GLES2) keeps
  executing the DrawList against compile-time baked font atlases.
  `engine/backends/gpui` paints through Zed's gpui/Metal renderer instead, and
  `text::MeasureFn` plus `DRAW_OP.TEXT_RUN` route measurement and shaping to
  CoreText when an app opts in — a `styleHash` word keeps identical word
  streams pixel-identical, so demand-render hashes stay truthful. The
  `macos-app` target ships with it, together with a `wrapText` host op and a
  Notepad whose word wrap, hit-testing, caret movement, selection and
  undo/redo all read one visual-segment layout, so reflow on resize falls out
  of the reactive width.
- **A System supervises several guests behind one compositor.** Pocket System
  resolution, role-scoped compositor surfaces and isolated `AppInstance`
  supervision arrive with a product-neutral macOS compositor host, and Linux
  and browser System hosts run the same resolved plan.
- **The manifest and the resolved plan carry companion adapters and viewport
  policy.** `app.companions` names the exact `svcOpen` service names an app's
  adapters speak, and the plan carries `companions` and `viewport.policy`, so
  a host derives every boot flag from one artifact instead of re-reading the
  raw manifest and matching on the application's name.
- **The gesture layer is framework-neutral and recognizes pinch.** The
  recognizer machinery and the kinetic scroller move into `gesture-core.ts`
  and `kinetics-core.ts` behind per-framework shims, so the Vue Vapor entry
  runs the same touch pipeline as Solid: contacts latch with their
  host-resolved hit facts, the gesture pump runs before app frame hooks, and
  the tap-to-press recognizer installs at mount. A two-contact pinch
  recognizer measures span on the locked axis and claims both contacts when
  the span change beats `pinchSlop` and the centroid travel. The legacy UIKit
  runtime replaces its single-contact globals with an eight-slot touch table.
  Pocket Clear on the iPod touch 4 is the demo the layer was built against.
- **`via-*` adds a middle gradient stop, and vertical gradients point the
  right way on the 3DS.** The core draws a three-stop gradient as two ordinary
  two-stop boxes, so every backend still sees `GRAD_RECT` and clipping stays
  where it was. `hosts/3ds/src/gfx.c` copies the spec's `GradDir` ordinals
  into C by hand and had `ToTop` and `ToBottom` swapped, which inverted every
  vertical gradient on the one backend that does not read the generated Rust
  enum. The gpui raster fallback renders the full viewport and composites
  transparently, and the compiler's path handling is portable on Windows
  again.
- **PocketJS 98 and a desktop benchmark measure the gpui host.** `apps/desk98`
  is a Windows 98 desktop as one guest — draggable, resizable, z-ordered
  windows, taskbar, Start menu, Notepad, Minesweeper and the classic
  shortcuts — with window moves riding paint-only transform props so a drag
  never relayouts and the idle desktop holds the demand-render governor at a
  few frames a second. `tools/bench-desktop.ts` measures byte-identical web
  editors shelled by Tauri v2 and Electron against the Pocket note on the same
  host; the numbers and their fairness caveats ship with the report.
- **The site is one design system across a nine-chapter homepage.** Shared
  tokens, chrome and base stylesheets replace the per-page CSS, the landing
  carries compatibility receipts, and an icon family covers every surface from
  the favicon to the Safari bookmark and the iOS home screen. A new post
  derives the [agent-native runtime for embedded
  systems](/blog/agent-native-runtime-embedded-systems/).

## 0.10.1 — August 16, 2026

**Three more physical phones run PocketJS, Pocket Vapor compiles a smaller reactive graph, and Pocket3D gains a deterministic systemic world.**
0.10.1 carries the connected-device work completed after 0.10.0 together with
the compiler, renderer and tooling fixes those devices exposed. The new phone
profiles remain private development targets: each one records an exact
hardware and firmware tuple, and none advertises a production capability from
a build or upload alone.

- **Windows CE runs a real Solid guest on the Meizu M8.** One ARM executable
  embeds QuickJS, the app and its assets, and the Rust software renderer; the
  native host copies a 480×720 BGRA framebuffer to the LCD through GDI without
  stretching. The host turns WinCE messages into wide touch coordinates,
  closes cleanly on Home or Escape, registers a build-qualified MiniOneShell
  icon, and deploys over the phone's ActiveSync serial function through PPP
  and RAPI. Status requires advancing guest frames, successful GDI composites
  and matching logical and physical viewports; acceptance additionally
  requires a completed touch and changed application action. The
  [field report](/blog/pocketjs-on-windows-ce/) follows the port from the first
  clipped 320×480 frame to the native, readable result.
- **The sixth-generation iPod touch has a transactional native host.** The
  tested `iPod7,1` on iOS 12.5.8 runs an arm64 UIKit application at a 320×568
  logical viewport and density 2. Each deploy re-identifies the device, opens
  a fresh UDID-scoped USB tunnel, verifies the staged bundle byte by byte, and
  keeps a rollback copy until SpringBoard registration succeeds. Wide touch
  words preserve the bottom of the 568-point surface, while the device receipt
  proves a live process, advancing frames, completed release and `hero_tap`.
- **The iPhone 4S runs the retained UI through OpenGL ES 1.1 at Retina
  density.** The private iOS 6.1.3 host builds an ARMv7 bundle against locally
  derived, hash-pinned linker stubs and requires the physical runtime to report
  a 640×960 GLES1 drawable for its 320×480 logical viewport. Transaction leases,
  staged file hashes, signature checks and rollback keep a failed install from
  replacing the working application; the captured device frame comes from the
  actual Retina renderbuffer.
- **The modern iOS shell's 120 Hz path is complete.** Its NativeScript plugin
  pin moves to `@nativescript/pocketjs` 0.2.1, whose native bridge publishes the
  requested tick rate before guest evaluation. This closes 0.10.0's known
  limitation: a 120 Hz bundle and host now establish the same mount invariant
  instead of refusing the unpublished 0.2.0 bridge.
- **Pocket Vapor removes work that static analysis proves unreachable.** A
  sparse conditional constant-propagation pass folds constant ref reads,
  selects decidable branches, and removes their dead dependencies and ROM.
  Frame-local view and bounded-string temporaries now share statically colored
  overlay slots when their generated owners cannot be live together, reducing
  permanent RAM and stack pressure on the NES and Game Boy. Linux parity runs
  can supply `MGBA_PREFIX` and `CC65_LIB` without changing the macOS defaults.
- **`pocket3d-world` is a renderer-independent fixed-step simulation.** Stable
  entity IDs, seeded randomness and ordered phases cover sphere and capsule
  bodies, attachments, structural damage, retained water, heat, fuel and
  combustion. Inputs, initial state and configuration replay to a stable state
  hash; shared collision and reaction laws are tested as general invariants,
  while concrete material recipes remain application-owned. Pocket3D model
  sockets and the optional stylized scene path present that state without
  moving simulation policy into the renderer.
- **Font and desktop-host regressions are closed.** The font baker now closes
  implicitly closed CFF contours before scanline filling, retaining their final
  edge, and the Note and widget launchers resolve their Cargo outputs from the
  current `engine/` workspace rather than the retired nested path.
- **Release automation runs on the current Node 24-backed GitHub Actions.** The
  checkout, cache and setup-node upgrades preserve the existing OIDC trusted
  publishing, build gates and deployment behavior.

## 0.10.0 — August 15, 2026

**Apps reach the network, a database and their own files, and a realm declares the rate its virtual time runs at.**
0.10.0 adds three modules — `net`, `db` and `fs` — each behind its own
append-only op spec, a deterministic sim host and a reference Rust core, and
turns the core's fixed 1/60 s step into a per-realm constant chosen before the
first tick. Every default remains 60 and the 60 Hz path is the identical
expression throughout, so existing bundles, tapes and frame-hash goldens are
byte-for-byte unchanged.

- **`net` — bounded whole-response HTTP.** `fetch()` and `globalThis.net` over
  five ops (`start`, `take`, `cancel`, `poll`, `lastError`), with the bounds in
  the spec rather than in each host: **2 in flight**, **64 KB** of request,
  **128 KB** of response by default and **256 KB** at most, 32 headers. The
  transport never calls into QuickJS — completions are staged to tick
  boundaries and drained one batch per tick — so a network answer cannot land
  in the middle of a frame. Transport adapters stay host-owned; the browser dev
  host, the sim and `engine/crates/pocket-net` exercise the contract without
  granting network access to every host.
- **`db` — SQLite behind five synchronous ops.** `open`, `close`, `exec`,
  `query`, `lastError`, with rows arriving as one JSON line per `query()` call
  rather than a cursor: at most **4 databases** per app, **4096 rows** per
  result, names matched against a fixed pattern, and storage the host confines
  to the app. `:memory:` is spelled the same as SQLite spells it.
- **`fs` — a per-app file tree behind nine ops.** `read`, `write`, `remove`,
  `list`, `stat`, `mkdir`, `rename`, `usage`, `lastError`, plus a
  `readFileSync`/`writeFileSync` surface for code that expects one. **Every
  path is confined to the app's own data root** — apps cannot name, let alone
  reach, each other's trees — and the shape of a path is bounded too: **160
  bytes**, **8 levels**, 64 bytes per segment.
- **No stock target advertises the three capabilities yet.** `net.http`,
  `data.sqlite` and `data.fs` are registered ahead of any console host shipping
  them, exactly as `audio.pcm` was: the sim host and the reference cores
  implement the whole contract, so an app can declare the requirement today,
  run against the sim (and, for `net`, the browser dev host), and fail
  admission cleanly where the module is absent. A device target appends the id
  to its profile when its native host ships the module — not before.
- **A realm declares its tick rate before its first tick.** `Ui::set_tick_rate`
  threads `dt` through the spring integrators and every ms-to-frame conversion,
  keeping exact integer hz alongside it so frame counts stay integers;
  `tools/build.ts --hz` bakes the same rate into the bundle, and clock,
  kinetics, input, deepzoom and the styles.bin ANIM TABLE all derive their
  per-tick constants from it. The rate is **fixed for the whole run** — a
  realm's frame content stays a pure function of its frame index, which is what
  keeps goldens byte-exact.
- **A bundle refuses a host that drives another rate.** The host publishes its
  rate as `ui.__tickHz` and the bundle checks it where it already checks target
  and host ABI. **An absent `__tickHz` means 60**, so every host that predates
  per-realm rates keeps mounting every bundle built the ordinary way. Without
  this a 120-baked bundle mounted on a 60-stepped core and ran at half speed
  silently; it now fails at mount with both rates named.
- **Modern iOS runs guests, as a transitional target.** `pocket ios
  doctor|build|stage|play` builds against an `ios-dev` plan and launches inside
  a NativeScript shell on an arm64 simulator, over the `pocket-apple` crate:
  one guest realm, one UI surface, and the software rasterizer driven
  incrementally through a damage tracker behind a small C ABI, with a UIKit
  view compositing only what changed. The profile stays **out of
  `POCKET_TARGETS`** until it has device-level acceptance, following the same
  convention the iPhone 2G target used. **Known limitation:** the 120 Hz path
  needs `@nativescript/pocketjs` 0.2.1, which is not published yet — against
  the current 0.2.0 plugin a 120 Hz bundle refuses to mount (loudly, by the
  rule above) while 60 Hz is unaffected.
- **Hosts choose the guest allocator**, so an embedder with its own arena no
  longer has to accept the default one.
- **Site**: the landing page leads with a machine collage and per-audience
  `/for/` pages, the in-browser playground reuses the landing PSP model, and
  every playground demo is validated and restored on build.

## 0.9.3 — August 8, 2026

**The PSP arena no longer strands the memory a QuickJS boot needs.**
A guest whose boot parses a megabyte of JSON could exhaust the heap while
megabytes sat free, because the arena's power-of-two size classes never hand a
block to a different class. 0.9.3 closes that, and
[Pocket Voxel](https://github.com/pocket-stack/pocket-voxel) boots on a real
PSP-2000 at the default arena size again.

- **`realloc` keeps the pointer when the new size stays inside the block's
  class.** The arena rounds every request up to a power of two, so a grow that
  stays in class already owns those bytes. QuickJS grows its string and array
  builders geometrically, and the previous allocator answered every one of those
  grows with an allocate, a copy, and a free that put the old block into a class
  nothing asked for again. A boot parsing 1.15 MB of game data stranded
  megabytes this way.
- **`arena::alloc` splits a larger free block when the bump is spent**, halving
  down to the class it needs. It runs last on purpose: a heap with room behaves
  exactly as it did in 0.9.2, and large blocks stay whole for the callers that
  want them.
- **A null exception object is an out-of-memory signature.** `[PocketJS js
  error] null` followed by `JS_Eval threw` means QuickJS could not allocate an
  `Error` to throw, so the guest source is not the suspect. The same halt line
  covers every eval failure, which is what made this one read as a code bug for
  a day.
- **`globalThis.audio` mounts without the `ui` surface.** `register_audio` is
  split out of `register`, so a host that owns its own surface can still offer
  the `audio.pcm` capability. The credit mirror also decays with the hardware
  stream: `poll()` never subtracted what `write()` accepted, so a ring the mixer
  drained completely between two polls sent no credit and the guest went
  permanently silent after a couple of seconds.

Measured on the hardware that found it. The same guest bundle peaks at
**12.3 MB** under desktop QuickJS and needed more than **15.5 MB** on the device
before this release; it now boots inside the **14.3 MB** an XMB launch leaves
after a 32 MB pak, with the emulator journey green at 11 of 11 marks and
frame-hash goldens byte-identical at both quality rungs.

## 0.9.2 — August 6, 2026

**A locked 60 fps on a 2007 iPhone, because the composite was the only stage that was never damage-limited.**
PocketJS 0.9.2 makes the software rasterizer scope its screen composite to the
damaged rectangle, which takes the original iPhone from 22–26 fps to **59.99**,
and exposes the damage statistics that made the diagnosis possible. The
[deep dive](/blog/pocketjs-on-the-first-iphone/) has the numbers.

- **The composite now follows the damage plan.** The rasterizer was always
  incremental; the composite was not. The tick called `setNeedsDisplay` on the
  whole view and `drawRect:` discarded the dirty rectangle UIKit passes, so every
  frame rebuilt a `CGImage` over all 320×480 — **22–27 ms**. An empty plan now
  invalidates nothing (626 of 961 frames in one sample), and a non-empty plan
  goes to `setNeedsDisplayInRect:` with `drawRect:` clipping to what it is
  handed. The composite costs **0.26 ms**, and the frame **7.63 ms** of a
  16.67 ms budget. No preservation guarantee is relied on: when UIKit discards
  the backing store it passes full bounds and the full frame is drawn.
- **Damage is observable.** `engine/ui-cabi` was discarding the `DamagePlan` the
  incremental rasterizer returns. Six new C ABI accessors expose attempts,
  failures, policy-chosen full redraws, region count, pixel area and union
  bounds, and four of them ride in the device record. **`damage_failures` is the
  one that matters:** planning that errors silently draws a complete frame, and
  without a counter that is indistinguishable from a slow machine. A
  `composites` counter sits beside it, because a scoped invalidation that never
  fires looks exactly like a very fast one.
- **The software rasterizer is now the default on this target**, and the OpenGL
  ES 1.1 backend is opt-in. The GL path is correct and pixel-verified but costs
  17.2–19.7 ms and delivers 48.6–50.7 fps, because it re-submits and re-fills
  the entire DrawList every frame. **This supersedes rather than corrects
  0.9.1:** the GPU path really was faster than the CPU path as that code stood;
  the CPU path then got an optimization the GPU path still lacks.
- **Both paths can be captured and diffed.** The capture works on the software
  path too, which is the test that matters for a damage-limited rasterizer —
  the framebuffer persists and only damaged spans are rewritten, so
  under-reported damage would accumulate as staleness. After **2,581 frames**:
  mean absolute channel difference 0.039 of 255, with the only residue inside
  the animating spinner's own 40×40 box. Note the two captures disagree about
  format — `glReadPixels` is R,G,B,A bottom-up, the core's ARGB32 words are
  B,G,R,A top-down — and comparing the software one unswapped reports a
  convincing 9.3/255 failure that is entirely in the comparison.

## 0.9.1 — August 6, 2026

**The GPU path on the original iPhone was never losing; three stacked measurement bugs said it was.**
PocketJS 0.9.1 corrects the central performance claim of 0.9.0, fixes the two
real defects that produced it, and adds the instrument that settled it — the
device's own framebuffer, read back and diffed against the reference
rasterizer. The [rewritten deep
dive](/blog/pocketjs-on-the-first-iphone/) tells it in order.

- **Correction to 0.9.0.** That release reported the OpenGL ES 1.1 path as
  **2.4× slower** than the software rasterizer on the original iPhone. It is
  **1.8–2× faster**: 46.7–49.4 fps against 21.9–26.5, and 19.4–20.5 ms per
  frame against 33.9–40.8. The old comparison timed GL's rasterize *and*
  present against software's rasterize *only*, because the software
  composite runs in `drawRect:` later in the run loop. (0.9.2 then scoped that
  composite and the ordering flipped again — see above.)
- **Fixed: the software fallback never composited.** `+layerClass` returned
  `CAEAGLLayer` unconditionally, and a GL-backed layer never receives
  `drawRect:`. The documented fallback — the one the host drops to whenever GL
  fails — computed frames that could not reach the screen. The layer class now
  agrees with the selected renderer.
- **Fixed: the GPU drew colour blocks.** In OpenGL ES 1.1 texturing is a
  per-unit enable, and `glEnable(GL_TEXTURE_2D)` was missing, so every fragment
  took only its vertex colour: flat fills looked right while all text, images
  and font-atlas content silently vanished. ES 2 has no equivalent, which is
  exactly why deriving the ES 1 pipeline from the ES 2 one hid it. Also states
  `GL_MODULATE`, `glShadeModel(GL_SMOOTH)` and an identity texture matrix, with
  a test pinning all four.
- **Pixel parity, off the device.** A one-shot `glReadPixels` capture writes the
  phone's framebuffer to a file the host pulls over USB. Against the same guest
  rendered by the reference core: **mean absolute channel difference 0.04 of
  255**, no channel off by more than 32, worst single channel 7 — the residue
  being antialiased glyph edges. First PocketJS host verified by reading pixels
  back off physical hardware.
- **A frame rate you can trust.** The device now reports `window_frames` and
  `window_us`, so the rate is computed from exact on-device counters instead of
  differencing two status records with one-second timestamps — the ±4 fps of
  slop that let the original discrepancy hide.

## 0.9.0 — August 6, 2026

**The runtime reaches the original iPhone, and its GPU backend learns a second generation.**
PocketJS 0.9.0 adds an experimental ARMv6 target for the 2007 `iPhone1,1`
running iPhone OS 3.1.3, generalizes the hardware DrawList backend so it
serves both OpenGL ES 2 and the fixed-function OpenGL ES 1.1 that older
GPUs speak, and hardens what the project accepts as proof that something
ran on hardware. Its performance claim about that GPU path was wrong and is
corrected in 0.9.1 above.

- **An ARMv6 UIKit host for the original iPhone.** Current Xcode still
  emits ARMv6 and `ld-classic` still links a 2008 sysroot, so the host is
  built against an iPhone OS 1.1.4 ABI floor and targets 3.1.3, probing
  both UIKit generations at runtime with `respondsToSelector:` and
  `dlsym`. It contains **no Objective-C**: the classic linker crashes on
  the ObjC1 relocations current Clang emits, so the view and app delegate
  are registered through `objc_allocateClassPair` at startup. The guest
  JavaScript and asset pack ride inside the executable as Mach-O sections,
  and deployment is a signed transaction with byte-exact readback and
  rollback over key-only USB SSH. The target stays deliberately outside
  the production registry, with a test asserting it.
- **The GL backend now serves two GPU generations.** `engine/ui-cabi`'s
  renderer split into a generation-independent DrawList walker plus two
  pipelines: the existing ES 2 shader program, and a new fixed-function ES
  1.1 path for GPUs that predate shaders. The two shader lines turned out
  to have exact fixed-function equivalents — the pixel-to-NDC transform is
  `glOrthof`, and `texture2D(…) * v_color` is `GL_MODULATE` — so the
  interleaved vertex layout is reused byte for byte. All ten backend tests
  pass on either pipeline, and Symbian's verified ES 2 output is unchanged.
- **A GPU path measured, and reported wrongly — see 0.9.1.** This release
  reported the hardware path as 2.4× slower than the software rasterizer. That
  conclusion was the product of three stacked measurement bugs and is exactly
  backwards; the corrected figures and the two defects behind them are in
  0.9.1 above. What stands from this entry: the device record reports which
  renderer and which clock actually ran rather than leaving it to be inferred,
  and a marker file selects between both paths so they can be measured from
  one binary.
- **Runtime acceptance got harder to fool.** A review found that the
  first "it runs on hardware" receipt could pass before the finger lifted
  and could be re-read from a process that had already died. The record is
  now schema 2 and requires a live PID, an advancing heartbeat, a
  completed touch release, and an application-reported action — which
  arrives through the new `reportAppAction` framework surface and its
  optional host sink, so the evidence path runs through the reactive
  graph. Frame-loop timings ride in the same record.

## 0.8.0 — August 5, 2026

**The runtime learns to be touched and heard, and reaches four new kinds
of machine.** PocketJS 0.8.0 makes Octane the third first-class framework
beside Solid and Vue Vapor, grows a real touch system with gesture
physics and a deterministic audio pipeline, and adds four machine
families: Symbian phones, PocketBook e-readers, the ESP32-P4, and the
Playdate. The [landing page](/) now tells that story: rich interactive
JavaScript where no browser fits.

- **Octane, the third framework.** Dominic Gannaway's compiled
  implementation of the React programming model (`useState`, `useEffect`,
  JSX, no virtual DOM) drives the same native tree as Solid and Vue Vapor
  through a universal framework driver. Every Vue Vapor demo has an Octane
  twin; 14 of the 23 committed Octane PSP goldens are byte-identical to
  the Vue Vapor frame, and the [three-framework
  benchmark](/blog/octane-on-psp/) lands every demo inside the 16.7 ms
  frame budget on real hardware. The port also uncovered that every PSP
  build since 2021 had shipped an unoptimized QuickJS interpreter; the fix
  speeds up every guest app.
- **A real touch system.** Per-contact snapshots carry host-resolved hit
  facts; a gesture layer sits on top with a kinetic scroller tuned to
  iOS-feel physics, axis dominance that defers instead of killing so a
  thumb can arc, and tap activation that presses any focusable.
  `VirtualList` turns the IM thread pattern into a component. The OSK
  gains a modern touch press model, backspace auto-repeat, and
  `TextField`, the editable activation semantic. DevTools tapes add a
  sparse touch track, e2e gains scripted touch input and the first touch
  goldens, and
  [Touch & gestures](/docs/touch-gestures/)
  writes down the measured cost model.
- **Audio, credit-based and deterministic.** `globalThis.audio` is a
  spec-first PCM streaming interface: apps push samples against a credit
  budget and hosts drain it, with a web worklet, a sim sink, and a PSP
  hardware channel behind the same contract. Playback defers until fed, so
  replays stay byte-stable, and the music demo plays real WAV files.
- **Symbian, the first phone family.** PocketJS apps run natively on a
  2011 Nokia E7 as installed Symbian applications with their own UIDs: a
  GLES2 renderer, an app catalog, live portrait and landscape relayout,
  and the slide-out QWERTY. The write-up is [Symbian Wanted a Frame
  Function](/blog/pocketjs-on-symbian/).
- **PocketBook, the first e-ink surface.** The inkview host renders
  incrementally and chooses partial, dynamic, or full refresh per update
  from tile diffs, on a display that fights every frame.
- **ESP32-P4, rendered by damage.** An RGB565 raster path and a hybrid
  PPA hardware backend (contributed by @HalfSweet, hardware-verified on an
  M5Stack Tab5 at 1280×720), built on new backend-independent damage
  rendering and transactional strip rendering with a strip-equals-full
  parity suite.
- **Playdate, the fifth Pocket Vapor target.** The 400×240 1-bit panel
  as a 50×30 grid, `.pdx` packaging for device and Simulator, and the
  crank arriving through the hardware-neutral `RelativeAxis` contract:
  hosts preserve signed millidegrees, apps own their detents, and
  admission is checked per target against the real Vue oracle.
- **Vita system services.** The Cover Flow launcher ports to Vita, and
  the svc mailbox goes wireless: a PKNT wire protocol, RAM-assembled
  `.pkst` streams, a video plane, and audio over WiFi TCP.
- **Toolchain.** `--font-regular`/`--font-bold` source overrides in the
  build, Vue SFC template comments handled correctly, and the npm files
  map pinned to its governed surface.
- **Compatibility:** apps and the npm packages build unchanged.
  **Breaking** for native embedders only: `render_scaled_argb` now emits
  the documented little-endian ARGB8888 word layout instead of the
  byte-swapped surface it produced before; re-check any code that consumed
  the old order.

## 0.7.0 — July 23, 2026

**Vue compiles all the way down.** Pocket Vapor takes a real Vue Vapor
component — actual `ref`/`computed`, actual JSX — and emits native code for
machines that could never host a JavaScript engine: Game Boy Advance, Game
Boy, NES cartridges, and now an ESP32 dev board, with the same file proven
cell-identical against real `vue@3.6` after every button press. [The film
and the whole argument](/blog/pocket-vapor/). Around it, the platform grew
a launcher, a package format, and a desktop widget runtime.

- **Pocket Vapor** (`vapor/`) — an AOT compiler for a strict TypeScript
  subset of Vue Vapor: reactivity lowered to dirty-bit dependency masks
  baked into ROM, template bindings to span-merged paint effects, every
  byte planned at compile time (no allocator, no GC). One TodoMVC component
  becomes `.gba`, `.gb`, and `.nes` carts; `SCREEN` folds make layout a
  compile-time constant per target — responsive UI with zero bytes of
  runtime cost.
- **The oracle is real Vue** — the same file runs unmodified on
  `vue@3.6` `runtime-with-vapor`, and the parity suite replays one
  interaction tape through the oracle and every console emulator, comparing
  the full logical grid — characters *and* palettes — after each press.
  `bun run vapor:dev` serves the oracle in a browser to make degradation
  visible before you burn a cart.
- **A class DSL with per-target style contracts** — the same Tailwind
  names the big framework compiles, lowered per machine: GBA palette
  banks (rgb555), ESP32 RGB565 ink/paper pairs, GB/NES two glyph styles by
  luminance. `vapor:check` prints the whole cross-target diagnostics
  matrix in one run; `--strict` turns lossy lowering into failure.
- **ESP32 MeowBit, the fourth target** — an ST7735 RGB565 cell raster,
  release-latched button chords, and a USB verifier that replays the shared
  tape against the *physical* board: 32 full-grid receipts, 23,040
  character/palette cell comparisons, zero tripwires, firmware identity
  hash-checked so a stale flash can't pass.
- **Boards as data, execution classes in the contract** — MCU devices are
  JSON board profiles (pins, panel, pad coverage) validated against the
  runtime; the compiler derives what an app demands (buttons statically
  used, style pairs, grid) and `check --json` judges every registered
  board. pocket.json v2 names the guest/aot split (`execution.classes`) —
  [vapor/BOARDS.md](https://github.com/pocket-stack/pocketjs/blob/main/vapor/BOARDS.md)
  is the scaling argument.
- **Cover Flow launcher + whole-guest app switching** — the launcher is
  Home: scrub a cover deck with real momentum, boot any installed app, and
  SELECT summons the deck from inside a running guest behind a frozen-shot
  veil (ops 39–41). Verified on real PSP hardware.
- **`.pocket` v1** — one app, every target, one file: identity, build
  plan, bundle, and assets as sorted sections with deterministic encoding;
  `build --all-targets`, `thin`, `inspect`, and `verify` in the CLI.
  Devices re-verify the embedded plan against their own profile before
  booting.
- **Widgets grow a family** — the `pocket-widget` crate (demand-rendered
  embedded surfaces with parts + picking), flat widgets — Pocket Note, a
  markdown sticky with selection/undo/clipboard/IME on a new
  `desktop-widget-macos` target — and `pocket-stage` authored 3D stage
  packages: the landing page's PSP is one, an iPod nano is another.
- **Vita renders through GXM** — Pocket3D worlds move off the CPU blitter
  onto the native GPU pipeline.
- **Vue single-file components** — `.vue` SFCs compile through
  `@vue/compiler-sfc` vapor mode in the guest vue-vapor framework, and Vue
  itself moves up to `3.6.0-rc.1` (functional props arrive resolved).
- **Contracts: semantics as fields** — target profiles carry `platform`
  and `form` as queryable fields (ids stay labels nothing may parse), and
  apps declare viewport intent per policy (`fixed`/`dynamic`) instead of
  per target.
- **Compatibility:** existing apps and the npm packages build unchanged;
  the bare fixed-viewport manifest spelling remains valid, and
  `execution.classes` is optional (omitted means guest). The repository
  itself moved to one-axis-per-top-level-directory (`docs/STRUCTURE.md`) —
  contributor-facing only.

## 0.6.0 — July 19, 2026

**The engine leaves the handheld.** The Pocket runtime's first desktop
product surface: transparent widget windows and a VRM character stack,
proven by rebuilding airi's 3D digital human as one native process at
118 MB / 3.9 % of a core — an [order of magnitude below its Electron
stage](/blog/pocket-character/) on every axis, same character, same
behaviors.

- **Widget windows** (pocket3d): `AppConfig` grows `transparent`,
  `decorations`, `always_on_top`, `resizable`, `drag_window`, and `max_fps`
  frame pacing that sleeps between frames instead of spinning on vsync;
  scenes can clear to alpha 0 for desktop-composited windows.
- **Morph targets** (pocket3d): sparse CPU deltas + per-instance overlay
  vertex buffers, flushed only when a weight changes — blend-shape faces
  cost nothing at rest. Draws redirect via `base_vertex`; shared index
  buffers stay untouched.
- **Procedural poses** (pocket3d): `Skeleton::sample_locals` /
  `globals_from_locals` split plus `ModelInstance::pose`, so hosts inject
  look-at and physics edits between clip sampling and the hierarchy walk.
  Joint palettes grow 128 → 512 matrices for VRoid-scale humanoid rigs.
- **pocket-vrm** (new crate): VRM 0.x parsing (humanoid map, blend-shape
  groups, spring config, MToon material info, look-at ranges), a
  deterministic allocation-free spring-bone verlet solver, VRMA retargeting
  with the VRM1 +Z → VRM0 −Z conversion, and bone-type eye look-at —
  21 tests against the real VRoid sample fixture.
- **Asset diet** (pocket3d): `load_glb_opts` skips images no material
  references and caps authoring-resolution textures
  (`max_texture_dim`) — 413 MB of GPU memory back on the reference
  character.
- [pocket-character](https://github.com/pocket-stack/pocket-character):
  the airi-parity widget itself — character surface + QuickJS policy
  bundle, blink/saccade schedulers with airi's exact constants, headless
  render harness, and the [measured report](/blog/pocket-character/).
- **Compatibility:** no breaking changes; `AppConfig` and `ModelInstance`
  gained fields (struct-literal constructors need `..Default::default()`).

## 0.5.0 — July 17, 2026

**The console grows system software.** Streaming media, a system keyboard, a
virtual pointer, and self-diagnosing devices — capabilities every handheld
app needs, now owned by the framework instead of copy-pasted per demo —
proven by [streaming YouTube to a PSP over USB](/blog/pocket-youtube/).

- **App services over USB** — the `pocket-svc` mailbox gives any app a JSON
  command channel to a companion desktop service (request/reply with side
  files for bulk bytes), the same file-transport model DevTools proved,
  hardened against host restarts. Pocket YouTube — search, host-rendered CJK
  result rows, and full-motion playback on real hardware — ships as its own
  app repo (`pocket-stack/pocket-youtube`) built entirely on these APIs.
- **A streaming video plane** — `.pkst` ring files carry palettized frames
  and PCM audio from the host; the native side pumps them under a per-frame
  IO budget, commits texture updates only in the GE-idle window (tear-free
  by construction), and plays audio on a dedicated hardware channel with a
  software resampler. Seek, pause, and epoch resync are part of the
  contract, not the app.
- **A system on-screen keyboard** — `@pocketjs/framework/osk`: an LVGL-style
  variable-width key grid with letters/caps/symbols layers, dark and light
  themes, and a caret-editing session (`createOsk`). While open it owns
  input outright (modal focus scope + button block), retiring the
  gate-every-handler pattern. One component, per-platform input: d-pad
  spatial navigation and the classic PSP chords, front-touch on Vita, and
  the virtual cursor for free.
- **A virtual cursor capability** (`input.cursor`) — the analog nub steers a
  core-drawn pointer; hover *is* focus, so every `focus:` style doubles as
  the hover style, presses arm and fire like real buttons, and d-pad
  traversal stays available as a fallback. Opt-in via `enableCursor()`.
- **Devices that vouch for themselves** — every build embeds an FNV-1a64
  hash of its app bundle; the PSPLINK bridge verifies it against `dist/` on
  every boot and calls out a stale embed (or a silent, pre-handshake build)
  before you trust a single observation. `OP.debugStats` exposes live
  audio/video/transport counters through the new DevTools `devStats` query —
  underruns, torn frames, and truncation resets become one request instead
  of a thread autopsy.
- **Compatibility:** existing apps build unchanged. New host ops (30–38) are
  optional capabilities — hosts that lack them simply omit the op, and the
  framework degrades gracefully (the OSK falls back to bottom-dock geometry
  without hit testing; `devStats` replies `data: null`). PS Vita builds now
  ship complete default LiveArea artwork.

## 0.4.0 — July 13, 2026

**One app, two PlayStations.** PocketJS now treats PSP and PS Vita as two
profiles of one [portable application contract](/docs/platform-contracts/),
with native-density rendering, touch, a reproducible PSP toolchain, and
target-specific golden tests.

- **PS Vita is a first-class target** — the QuickJS + vita2d host renders a
  480×272 logical scene directly at 960×544, bakes fonts, SVGs, and masks at 2×,
  accepts buttons, left-analog, and front multi-touch input, and gives every
  app a stable Title ID and named VPK. `bun play vita <demo>` builds, installs,
  and launches the selected demo in Vita3K; the Vita golden suite exercises
  the same native plan and package path used by release builds.
  [Read the port story](/blog/pocketjs-on-ps-vita/).
- **Portable build contracts** — strict `pocket.json` v2 manifests declare app
  identity, entrypoint, logical viewport, required APIs, and optional
  enhancements. One resolver produces the checked build plan consumed by the
  JS compiler and native backend; unavailable literal `hasFeature()` branches
  fold away at build time. A PSP-baseline app resolves unchanged for Vita,
  while Vita-only touch code can retain a controller fallback.
- **A self-contained PSP toolchain** — `bun run bootstrap` and `pocket setup`
  install exact `pocket-stack` revisions plus a SHA-256-verified SDK into one
  shared cache. `PSP_SDK` and `PSPDEV` remain explicit overrides, but builds no
  longer inspect DreamCart or sibling source checkouts. Cache receipts, staged
  publication, and host-revision checks make setup repeatable across PocketJS,
  OpenStrike, and Pocket Figma.
- **Pocket3D ships on the PSP GE** — the new `no_std` backend consumes cooked
  `.p3d` worlds with PVS/frustum culling, shared collision, CLUT8 mip chains,
  baked vertex lighting, and a composable JSX HUD pass. It is the framework
  path behind [OpenStrike](/blog/shipping-openstrike/), including the texture
  and light-baking improvements proven on real hardware.
- **Determinism now includes time and effects** — the virtual clock,
  frame-boundary effect shell, and headless simulation host make async product
  journeys repeatable across 60 Hz and deliberately slow worlds. Desktop wgpu
  apps join the same DevTools mailbox, while cached text shaping and the
  imperative `hot.text` / `hot.prop` path remove interaction-time PSP spikes.
  [Read the model](/blog/ui-runtime-that-cant-flake/).
- **Large native canvases and richer app chrome** — streamed TILESET entries,
  generation-tagged textures, CLUT8 palettes, and `<DeepZoom>` power the
  compile-time [Pocket Figma](/blog/pocket-figma/) viewer; Vita adds anchored
  pinch, inertial pan, and native-detail tiles. Classic bevel rings, working
  `active:` pressed styles, Pocket Talk's virtualized IM/OSK demo, and a real
  PSP texture-cache fix round out the 2D runtime.
- **Compatibility:** existing script-driven PSP apps continue to build, while
  `pocket.json` is required when opting into `bun pocket` and target-aware
  Vita builds. **Breaking for custom hosts:** `Host.kind` now reports
  `"native"` instead of `"psp"`; manifest bundles require `__host` and
  `__hostAbi`. Rebuild framework/compiler/core/host artifacts together and consume the
  stable `HostBuildInputs` projection rather than the internal build plan.
  Vita builds still require VitaSDK + `cargo-vita`; arbitrary logical sizes
  and dynamic host text are not part of this release.

## 0.3.0 — July 8, 2026

**Pocket DevTools.** Time travel + inspection as framework primitives —
[read the deep-dive](/blog/time-travel-devtools/), design in
[docs/DEVTOOLS.md](https://github.com/pocket-stack/pocketjs/blob/main/DEVTOOLS.md).

- **Component inspector with on-device highlight** — a desktop panel
  (`/devtools`) shows the component tree with semantic names (`debugName`
  prop, `<Named>` wrapper; all demos annotated); hovering a node draws a
  highlight overlay **on the device screen** — the core emits it into the
  DrawList, so real PSP hardware, the wasm rasterizer and wgpu all render
  it. Switching nodes glides the box across the screen.
- **Time travel on an always-on flight recorder** — every bundle records
  its input tape (one `u16`/frame, 10 min ≈ 70 KB); sessions replay
  byte-exactly. Pause / single-step freeze the whole world in the core;
  click the tape strip to seek (reload + deterministic fast-forward).
  `bun run tape` replays headlessly: per-frame hashes,
  first-divergent-frame asserts (session goldens, `bun run tape:check`),
  PNG of any frame, component tree as JSON at any frame.
- **Real PSP debugging over the PSPLINK USB cable** — a `host0:` file
  mailbox (the trace/bench channel, formalized): REPL `eval` into the
  running handheld, the first working `console.log` on PSP, frame-stamped
  error reports, and on-demand 📷 screenshots (raw VRAM rides usbhostfs;
  the desktop bridge encodes the PNG). Verified on hardware.
- **One command** — `bun run devtools [app]` runs the panel, WS hub, USB
  bridge and (optionally) the whole PSP session; detects an existing
  tools/psplink/hw link and bridges into it. Also via the CLI: `pocket devtools`.
- **Breaking:** the `@pocketjs/cli` binary is renamed `pocketjs` → `pocket`.
- New spec ops 18–22 (`debugInspect/RectXY/RectWH/Pause/Step`), all
  debug-only and default-off — shipped rendering is byte-identical.

## 0.2.1 — July 7, 2026

**On npm.** PocketJS is now installable.

- [`@pocketjs/framework`](https://www.npmjs.com/package/@pocketjs/framework)
  and [`@pocketjs/cli`](https://www.npmjs.com/package/@pocketjs/cli) published
  under the MIT license.
- New `pocketjs` CLI — flutter-style `doctor` / `setup` for the bun + Rust +
  PSP toolchain, `create` app scaffolding, and `dev` / `build` / `psp` / `hw` /
  `psplink` passthrough.
- Releases are automated: pushing a version tag publishes both packages from
  GitHub Actions via npm trusted publishing (OIDC), with provenance.

## 0.2.0 — July 7, 2026

**The animation engine.** The Tailwind style table learned motion —
[read the deep-dive](/blog/baking-motion/).

- **Baked keyframe timelines** — `theme.keyframes` / `theme.animation` in
  `pocket.config.ts` (tailwind.config shape) compile into frame-precise,
  per-property segment timelines inside `styles.bin`; `animate-<name>`
  utilities apply them. Full CSS shorthand semantics: comma lists, fills,
  delays, `reverse`, `infinite`, `cubic-bezier(…)` with named easings baked
  to their canonical curves.
- **`animate-loop-[Nms]`** — a style-level loop period that replays a node's
  whole choreography (delays included), the loop plain CSS can't express
  without a remount.
- **3D transform pipeline** — `perspective-[N]` context roots,
  `rotate-x/-y-[deg]`, `translate-z-[px]`; subtrees compose 3×4 matrices,
  project about the root center and painter-sort into clipped triangles.
- **Arc primitive** — `arc-start/-sweep/-width` stroke a round-capped
  annular sector from the background color; all three animatable.
- **`TEX_TRI` DrawList op** — textured triangles in all three backends;
  2D-rotated images un-culled, textures ride 3D surfaces.
- **SVG path baking** — `framework/compiler/bake-svg.ts` rasterizes `<path>` data
  (beziers, winding rules, transforms, `fill="hole"` masks) into pak
  textures.
- **Real-hardware performance** (measured on a PSP over PSPLINK): baked-disc
  rounded corners, incremental taffy layout, a radius-capped disc cache and
  a pipelined CPU/GPU frame loop took the busiest demo page from 17.4 ms
  and dropped frames to a locked 60 FPS.
- **Motion Lab demo** — four pages of yui540's motion studies ported
  one-to-one; now the homepage hero and the playground default.
- Tooling: `bun psplink` rebuilds stale cached PRXs by input mtime.

## 0.1.0 — July 6, 2026

**Initial public release** — [Introducing PocketJS](/blog/introducing-pocketjs/).

- `#![no_std]` Rust core: retained tree, taffy flexbox, compiled Tailwind
  styles, baked font atlases, tween/spring animation, deterministic
  fixed-dt DrawList rendering.
- Real Solid and Vue Vapor components through their official custom
  renderers; React Native-style `<View>` / `<Text>` / `<Image>` primitives.
- Hosts: Sony PSP (QuickJS + sceGu), browser WebAssembly (software
  rasterizer), desktop wgpu window, headless Bun for byte-exact golden
  tests, PPSSPP end-to-end capture harness.
- Two-pass build: class literals and codepoints collected from the AST,
  styles/fonts/images baked into a `.pak`.
- pocketjs.dev: docs, blog, and the in-browser live-recompile playground.
