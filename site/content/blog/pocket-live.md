Pick a character. Pick a stage. Point your webcam at your face, and join the meeting as neither — a VRM performer on a composed set, mirroring your expressions in real time, delivered to Zoom as an ordinary camera device. That's Pocket Live: the livestreaming chain — tracking, character, stage, program, delivery — built as a small native runtime instead of a streaming app's worth of processes.

[Pocket Character](/blog/pocket-character/) was the seed: airi's idle VRM widget rebuilt as one native process, 118 MB and 4 % of a core where the Electron tree spends 2.2 GB and 44 %. That post ends where the character starts breathing. This one is about everything a *live* character needs that an idle one doesn't — a face to mirror, a set to stand on, a video contract to honor, and an audience on the other side of a conferencing app that only trusts things which look like webcams. End to end:

```
real camera ──▶ tracking (blendshapes + skeleton, NDJSON)
                   │
                   ▼
             character sim (VRM: expressions, motion, springs)
                   │
                   ▼
             stage compositor (background mode: virtual · camera ·
                   │            matte · clean · split · transparent)
                   ▼
             program output (fixed-size texture, e.g. 1920×1080)
                   │
                   ├──▶ on-screen preview / fullscreen per monitor
                   └──▶ virtual camera ──▶ Zoom / Teams / FaceTime / OBS
```

The widget's one rule carries over unchanged — things that happen sixty times a second run in Rust, things that happen occasionally run in JavaScript, things that don't change at all are data — and it matters here for a new reason: **the character itself is nearly free, so the budget goes where live actually needs it**, tracking inference and video delivery. Every arrow in that diagram is a narrow, boring protocol (JSON lines, plain objects, BGRA bytes behind a C struct), every box is replaceable, and the chain is built to run for *hours* next to your real meeting on your own machine — which makes idle cost, latency, and privacy product features rather than engineering hygiene.

## A performance is a file

The unit of use is a *vibe* — one JSON file naming a character, a stage, and the run parameters:

```json
{
  "kind": "vibe",
  "character": "pocket-live.default-character",
  "background": "pocket-live.hundred-flowers-stage",
  "tracking": "camera",
  "output_size": "1920x1080"
}
```

Underneath it, the content system is three kinds of plugin, all data:

- A **character plugin** is a manifest pointing at a VRM model, its animations, a QuickJS policy bundle (the personality — hot-swappable, [as before](/blog/pocket-character/)), and framing parameters: camera FOV, anchor height, and a separate framing distance for split-screen mode.
- A **background plugin** is a manifest plus one WGSL pixel function. The checked-in award-stage set is about a page of shader — film strips, drifting gold particles, a spotlight wash — no video decode, no image assets, resolution-independent, microseconds per frame.
- A **vibe** composes the two by id and adds tracking and output settings.

The host recognizes none of them specifically; it consumes manifest paths. A launcher resolves ids and cross-combines freely:

```bash
bun run vibe:list                                                  # everything discovered
bun run vibe -- --character golden-horn --background japanese-station
bun run vibe -- --vibe default --background hundred-flowers-stage  # override one axis
```

The payoff is that a show is *reproducible*: a vibe file is a complete, versionable description of a performance setup. And the two places plugin content gets to execute anything — the policy bundle and the pixel function — are both sandboxes. The alternative everyone reaches for, native plugin libraries, offers unlimited power and no boundary: a plugin crash is a show crash, mid-stream.

## Tracking without giving up your camera

The chain's input stage turns the real camera into semantic control signals, and it's the one place we deliberately spend a second process. `--tracking off | mock | camera`: `off` is the idle widget, `mock` replays synthetic signals so the whole chain can be developed and demoed with no camera attached, and `camera` runs the real pipeline — a MediaPipe sidecar beside a native Apple Vision bridge.

The sidecar runs Google's Face/Pose/Hand Landmarker models and emits **52 blendshape coefficients** — semantic values like "left eye closed 0.8," "mouth smile 0.3" — plus a small set of skeletal points. Those 52 names were coined by Apple's ARKit and became the industry's face-tracking vocabulary, and they map almost directly onto VRM expressions; that shared vocabulary is the entire reason the character can mirror a performer without a hand-authored mapping layer. The Vision bridge exists because the hybrid is genuinely better than either half: Apple's framework gives facial *geometry* but no blendshape coefficients (recovering expressions from raw landmarks is a research project), while MediaPipe gives the coefficients directly — so a `--face-only` flag keeps the face on MediaPipe and lets body and hands ride the native path.

Three rules keep this stage honest. The sidecar speaks newline-delimited JSON and nothing else — MediaPipe's result objects may not leak into the host, so the tracker is swappable without touching it. The camera is claimed **once**, by the host, and frames reach the sidecar through a shared-memory ring — no copies, no second permission prompt, no fighting the meeting app for the device. And nothing persists: frames are never written, never networked; what leaves the tracking stage is numbers, not pixels.

The alternatives map the landscape. ARKit's TrueDepth tracking is the quality ceiling, but Macs have no TrueDepth camera — VTubers bridge an iPhone as a peripheral, which is a fine hobbyist workflow and a terrible onboarding story. OpenSeeFace is the beloved community veteran that newer models have outrun. NVIDIA Maxine wants a GPU this machine doesn't have.

## The show is a texture, not a window

A window is a terrible video contract: transparent, resizable, Retina-scaled, occludable, sometimes portrait. So the live chain promotes the **program** — the pixels the audience sees — to a first-class render target: a fixed-size texture (the vibe's `output_size`) that scene, stage, and effects render into. The desktop window is demoted to a *preview* blitted from that texture (there's a `--fullscreen --monitor` path for a dedicated display), and every downstream consumer sees the same pixels no matter what the user does to the window.

What stands behind the character is the compositor's **background mode**, a first-class setting rather than a stack of ad-hoc toggles:

```
--background-mode  transparent | virtual | camera | matte | clean | split
```

`transparent` is the desktop-widget mode. `virtual` is a procedural WGSL stage. `camera` puts the real feed behind the character. `split` renders performer and puppet side by side — the honest format for "show me the human and the character," with its own framing parameter in the character manifest. The interesting pair is `matte` and `clean`: background replacement without a green screen. The clean-plate approach asks the performer to step out of frame once; the compositor captures the empty room (the background manifest carries the delay), and from then on the person can be separated by difference against the plate — free per-frame, pixel-exact for a static desk camera. The road not taken is ML person-segmentation, which needs no choreography but costs continuous inference and produces the familiar hair-eating halo. For a camera that doesn't move, the plate wins on both axes.

The program contract doubles as a privacy line, enforced by construction rather than policy: final composition happens *before* the texture with alpha forced opaque; debug skeletons, tracking points, FPS counters and window chrome can't reach it; and the raw camera feed participates only in tracking and in the modes that explicitly name it — it can never become an implicit background because someone toggled the wrong thing mid-meeting.

## Becoming a webcam

Delivery is the most platform-shaped stage, and the design is worth describing even though it's the part still being built (the Xcode skeleton is in-tree; the design doc is in the repo). Zoom trusts only devices in the OS camera list, so the program must *be* a camera. macOS has a before-and-after story here: the old mechanism, DAL plugins, injected your code into Zoom's own process — unsandboxed, routinely rejected by hardening policies, deprecated since macOS 12.3. The modern mechanism is the **CoreMediaIO Camera Extension**: the fake camera is a separate, sandboxed system-extension process, the same path OBS moved to in v28.

It works like a post office with the OS as the carrier. The extension publishes one device with two same-format streams — a *sink* only Pocket Live writes, and a *source* that Zoom, Teams and FaceTime read:

```
Pocket Live host ──frames──▶ sink stream ("Pocket Live In")
                                │  OS handles IPC, validation, fan-out
                                ▼
                     extension keeps only the newest frame
                                │  re-emitted on a steady 30 fps clock
                                ▼
              source stream ("Pocket Live Camera") ──▶ Zoom / Teams / FaceTime
```

The host pushes frames into the sink; the extension keeps only the newest and re-emits it on a steady clock; the OS handles the IPC, buffer validation, permission prompts, and fan-out to multiple simultaneous readers. Host and meeting app never touch.

The design decisions worth stealing, in order of how much pain they prevent:

- **The render thread never waits for the camera.** GPU→CPU readback goes through three rotating staging buffers with async callbacks; if all three are busy, the frame is dropped and counted. For live video, dropping beats queueing — latency is the product.
- **720p30 on purpose.** One readback plus one row copy is ~111 MB/s, comfortably affordable, and most conferencing links re-scale and re-encode anyway. Zero-copy IOSurface interop through wgpu's unstable HAL is explicitly deferred until measurement demands it — and step one of the plan is a signed, notarized template extension *enumerated by Zoom*, because code signing and system-extension approval are where projects like this actually die, not throughput.
- **Privacy as a state machine.** The extension never opens the real camera — it doesn't even hold the entitlement. If the host goes silent for 500 ms, viewers get a locally-generated "paused" placeholder. No failure mode falls back to the performer's real face; the extension outliving a host crash is precisely what makes that guarantee enforceable.

The alternatives: depending on OBS's virtual camera makes "user has OBS installed" a product prerequisite and routes the show through OBS; Syphon and NDI share textures between production tools but never appear as cameras to conferencing apps; screen-sharing the preview window surrenders resolution, framing, and the privacy line in one move.

## Measuring a multi-process show honestly

The [parity experiment's](/blog/pocket-character/) methodology carries over, extended for the multi-process reality: the measurement script walks the launcher's full process tree, tags each process by role — renderer, vision, mediapipe, launcher — and reports median and p10/p90 per role over a settled sampling window. There is no pretending the chain is one process; with everything on, it's the host plus the tracking sidecars, plus the camera extension when it ships.

The distinction worth defending is *why* each process exists. An Electron tree's processes arrive before you draw anything — they're the vehicle. The live chain's extras each mark a boundary that genuinely wants to be a process: the sidecar quarantines a Python/ML runtime behind a JSON pipe, so crashing the tracker leaves the show rendering and the character idling; the camera extension is OS-mandated, sandboxed, and alive even when the host is dead — which is exactly what the paused-placeholder guarantee is made of. Processes bought at isolation boundaries, not paid as vehicle tax. Every one of them terminates with its feature, and idle cost returns to the one-process baseline the widget started from.

## What this doesn't claim

Status, honestly: the character runtime, plugin/vibe system, tracking pipeline and background modes run today; the virtual camera is a completed design with its extension skeleton in-tree, staged behind the prove-the-platform-first plan above — this post describes that design, not a shipped device. No audio: the microphone stays whatever the meeting app already uses. And none of this makes Pocket Live a streaming *platform* — there's no scene switching, no overlays-as-apps, no RTMP. It's the narrower bet that the live chain itself — track, perform, compose, deliver — fits in a runtime small enough to sit beside your actual work, on the machine you're already using, for hours.

If you're keeping score on the choices, two invariants decided every contested one: **idle costs almost nothing** (the show runs for hours beside real work), and **the host knows nothing about specific content** (a performance is a vibe file, not a build). The roads not taken — three-vrm, ML matting, OBS's virtual camera, ARKit-over-iPhone, dlopen plugins — are mostly the pragmatic picks for someone shipping fast; each just breaks one of those two lines somewhere.

---

*Pocket Live builds on [pocket-character](https://github.com/pocket-stack/pocket-character) and the [PocketJS engine family](https://github.com/pocket-stack/pocketjs) — the VRM crate, morph targets, and widget windowing shipped upstream. Follow [@pocket_js](https://x.com/pocket_js) for the parts still landing.*
