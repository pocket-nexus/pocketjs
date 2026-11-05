# Pocket Agent

The console agent is the mascot on a console's top screen and the model that
operates Pocket apps for the user. The console streams the user's request (typed
text or microphone audio) over the [Pocket Link](POCKET-LINK.md) to the
companion; the companion runs the model, and the model acts on the console's
touch screen through tool calls the console answers. The wire contract is
`contracts/spec/agent.ts`. This page describes the console side (the 3DS host
in `products/3ds/src/stage.c` and `agent.c`, the guest overlay in
`framework/src/agent-layer.tsx`). The companion side runs in Pocket Hub
(`pocket-nexus/pocket-hub`).

## Who owns the screens

A guest that declares the capability **`system.agent`** (in
`engine.capabilities.enhances`) hands the top screen to the host. The plan's
feature reaches the host as `POCKET_GUEST_FEATURE_AGENT`: the host draws its
stage on the top screen, turns stereo on (`gfxSet3D`), publishes
`globalThis.agent`, and lays out the guest's primary surface without showing
it. The app's whole interface lives on the touch screen. A guest without the
capability keeps the top screen as before.

The build adds the overlay to every Solid app whose plan has the feature:
`tools/build.ts` walks `framework/src/agent-layer.tsx` in pass 1 (its classes
and glyphs compile with the app's) and bundles an entry that imports it ahead
of the app, so it registers with `framework/src/system-layers.ts` before the
app mounts. `render()` mounts registered system layers after the app. The app
does not import anything.

## The stage

`stage.c` draws a cartoon room from boxes, prisms and quads, built once into
one linear-memory vertex buffer: a wooden floor and rug, plaster and
panelled walls, a window, a poster with Claude's spark, a wall clock on the
companion's time (`link_clock_now`), a bookshelf, a lamp, a plant, a cushion,
and a side desk with a monitor. On the cushion sits Clawd, Claude's creature:
an orange block with two upright eyes, two arm stubs and four legs.

- **One shader** (`stage.v.pica`): every vertex carries a bone index into 16
  bone matrices (the room, the clock hands, the plant, and the mascot's body,
  eyes, arms and legs) and two normals, a face normal for light and a smooth
  normal for the outline. Light is two flat tones split on N·L plus a little
  N·L. The outline pass draws the outlined range again with front faces
  culled, pushed out along the smooth normal (an inverted hull).
- **Five draws an eye**: lit geometry, outlines, unlit pieces (sky, poster,
  lamp), the monitor's screen (textured), soft shadows (blended). With the 3D
  slider up the scene draws twice with `Mtx_PerspStereoTilt`, the zero
  parallax plane at the mascot's depth (3.6 units).
- **The monitor** samples one of three textures: the touch screen (a raw
  `C3D_SyncTextureCopy` of the auxiliary render target's tiles into a 256×512
  RGBA8 texture, every second frame while it is shown), the agent's own screen
  (RGB565 frames from `agent.screen`, tiled by a display transfer) or the
  screensaver (the flat PocketJS mark with a small "PocketJS" under it, on
  the brand's plum `#171226`: a 128×64 RGB565 texture
  from `stage_saver.h`, laid out on a 256×128 grid, drawn at four times that
  and box-filtered to about the size the monitor shows, so the GPU's linear
  filter does not minify it; it drifts at a constant speed and turns back
  where it meets an edge, and the clamped texture edge fills the rest of the
  screen with plum). A texture
  matrix uniform maps the quad's coordinates to the source's layout.
- **The mascot animates in C**, one step a frame (`stage_tick`): a pose target
  from the mode, eased every frame, with breathing, blinks, hops (a spring on
  the body's squash) and typing added on top. In mode `idle` a small scheduler
  picks acts (rest, look around, watch the monitor, kick, stretch, hop) and
  falls asleep after 75 s without input; input wakes it and now and then
  sends it to watch the touch screen on its monitor.

**The hints.** While the mode is `idle`, a pill in the bottom-right corner
shows two key caps, L and R, and "Ask Claude". While an applet other than the
launcher runs (`launcher_home_running()` is false), or while the launcher
shows a page other than its first and has said so with `agent.homeHint(true)`
(`setHomeHint` in `@pocketjs/framework/agent`; every guest boot clears it), a
second pill 6 px above it shows a SELECT key cap and "Home": SELECT returns to
the launcher, or to the launcher's first page. Both
pills are one 128×64 RGBA8 texture baked from Inter Bold by
`tools/3ds-stage-art.ts` into `products/3ds/src/stage_hint.h` (the L+R pill in
the top half, the SELECT pill from row `STAGE_SELECT_Y`), drawn as two quads
after each eye with an orthographic projection at the screen's pixels (zero
parallax), each with its own opacity in the texture combiner's constant
colour. It fades out in **about 0.2 s** when the mode
leaves `idle` and back in over **about 0.6 s**. `bun tools/3ds-stage-art.ts
--check` fails when either header is stale.

On an Old 3DS the stage adds about **0.4 ms** to the frame's GPU phase (3.0 ms
against 2.6 ms), and the Hacker News applet (pocket-nexus/applets `hn/`) still
scrolls its list at 59 to 61 frames a second.

## Display mode

The console has a display mode, `"dual"` or `"single"`
(`AGENT_DISPLAY`). A 3DS starts in dual: the stage owns the top screen.
Single is the layout of a device with one screen (an iPod touch, a phone):
the top screen is dark and the agent comes out of a notch on the touch
screen.

- **The host** (`agent.c`) keeps the mode in
  `sdmc:/pocketjs/runtime/display.txt` (`dual` or `single`), read on first
  use and written by `agent.setDisplay(mode)`, so it **outlasts reboots and
  app switches**; `agent.display()` reads it. A change queues a
  `{"t":"display","mode":…}` event.
- **In single mode, while an agent guest runs,** `main.c` skips the stage's
  draw (the top screen is cleared to black), 3D is off, and the top
  backlight is powered off through `GSPLCD_PowerOffBacklight`. An APT hook
  powers it on before the HOME Menu, sleep or exit and off again on return,
  and a guest without the capability or `agent_shutdown` powers it on, so no
  other program inherits a dark top screen. The chord, the microphone and
  the mirror capture work as in dual mode.
- **The framework** exports `displayMode()` and `setDisplayMode(mode)` from
  `@pocketjs/framework/agent`; Pocket Shell's Settings has the switch.

## The host's agent channel

`agent.c` holds the parts that must not wait for the guest:

- **The chord.** A shoulder's down edge waits `AGENT_CHORD_FRAMES` (6) for
  the other shoulder. Both down: the guest gets `chord.down`, and `chord.up
  {heldMs}` at the release, and never the shoulder bits. One shoulder alone:
  its bit reaches the guest at the end of the window, or as a one-frame pulse
  when it is let go inside it.
- **The microphone.** `listen(1)` starts MICU at 16,360 Hz (gain `0x40`),
  sends `agent.audio`, and every frame copies the samples that arrived (after
  invalidating the cache lines the microphone wrote behind) into a ring that
  drains into 100 ms data frames. `listen(0)` and `listen(-1)` stop it; once
  the ring is sent, the host sends `agent.audio.end` with `send` true or
  false. Recording stops at `AGENT_MIC_MAX_MS` with a `mic.stop` event.
  `status()` reports the level, the loudest sample and the gain.
- **Shots.** `shot()` returns a stream id; at the start of the next frame
  the host reads the touch screen's render target with a display transfer,
  converts it to row-major RGB565 and streams it after `agent.shot`.
- **Glyphs and own-screen frames.** `agent.glyphs` and `agent.screen` streams
  are consumed in C: an atlas loads with `ui_load_font_atlas` the moment its
  last byte arrives (the guest then gets a `glyphs` event), a frame goes to the
  stage's monitor texture. The guest never holds the bytes.

Every other `agent.*` ctrl message from the companion is queued as an event
for `poll()`; `send()` forwards a guest's `agent.*` message as a ctrl frame.

## Reading a screen

`ui.captureTexts(surface, root)` arms a capture in the core: the next draw of
that surface records every text run painted inside node `root`'s subtree with
its visible box (clipped, world pixels), then disarms. `ui.capturedTexts
(surface)` returns it as lines of `x,y,w,h`, a tab and the text. The overlay
captures the app layer of the auxiliary surface, so its own words stay out of
the report. Runs at opacity 0, outside every clip or off the screen are not
painted and not read.

## The overlay

`framework/src/agent-layer.tsx` renders into its own node above the
auxiliary surface's layers, in a Solid root under `SystemFrameContext`: its
frame callbacks belong to the system registry in `frame.ts`, which keeps
running while `suspendApp(true)` stops the app's.

| State | Touch screen | Mascot (mode, monitor) |
| --- | --- | --- |
| closed | the app | idle, screensaver |
| L+R (`choose`) | scrim, a card with two tiles: Talk (A) and Type (X) | attend, mirror |
| Talk (`listening`) | scrim, a card with the microphone, the live transcript and Send (A) | listen, mirror |
| Type (`compose`) | scrim, a card with the request field, the system keyboard (`Osk`, contact layout) | attend, mirror |
| working | scrim, the request, the step line, the reply as it streams, the token count | think, act or speak; mirror, or own on the agent's screen |
| acting on the user's screen | the app, running, and a banner with the step | act, mirror |
| tucked (B while the agent works on its own screen) | the app, running, and a banner | think or act, own |
| reply | scrim, the reply, the token count, Talk (A) and Type (X) for the next request | happy, then attend; mirror |

**The notch.** In single mode the overlay draws a black notch over every
app at `AGENT_NOTCH` (x 124, 72×14, bottom corners rounded 7). A gesture
whose region is the notch takes its taps, and the app keeps every other
touch. A tap makes a 2D Clawd (an orange block with two eyes and two arm
stubs, drawn with Views) spring down from under the notch to peek out below
it, blink at 0.3 s, and at 0.5 s the choice opens as L+R opens it. Clawd stays
out while a card is up and slides back under the notch when it closes. A tap
on the notch with a card up closes it; with a tucked turn, it brings the
turn back. While the agent works, an orange dot pulses in the notch.

The overlay ignores how long the chord is held: `chord.down` opens the choice,
closes an open card, sends a recording in progress or brings a tucked
overlay back. B steps back from Talk or Type to the choice and closes the
choice. A tile or pill darkens under the stylus and acts when the stylus
lifts on it; a stroke longer than 10 px cancels it.

While the scrim is up the app is paused: `suspendApp(true)`,
`pushButtonHandlerBlock` and `pushTouchBlock`, and a `FocusScope` holds the
d-pad. While the agent acts on the user's screen the overlay's input filter
(`setFrameInputFilter`) replaces the user's input with the agent's: a tap is
the stylus down four frames, a drag sixteen frames between two still ends, a
press one frame down and two up. B in the user's own input stops the turn.
After the frames the overlay waits `AGENT_SETTLE_FRAMES`, captures the texts
and answers `agent.result`; `observe` with `image` also takes a shot, with
the banner hidden for that frame.

Every text that can hold the agent's words draws from `AGENT_FONT_SLOT`. The
core breaks lines only at `\n`, so the overlay wraps them itself from the
slot's advances (`ops.measureText` per character, cached until the next
`glyphs` event): wide characters break anywhere, Latin words at spaces, and
closing punctuation hangs at the end of a line. Without a companion the slot
is empty and the overlay says so in ASCII from the bundle's baked glyphs.

## The companion side

Pocket Hub runs the companion side of the agent. A companion that runs it
lists the feature `agent` in `ready`. It runs **one `codex app-server` child
for all consoles and one thread per console**, runs the tool calls of
`AGENT_TOOLS` one at a time per console, runs the agent's own screen (the
app's `3ds-dev` bundle in the sim host with the 3DS geometry of
`programs/sim/console-3ds.ts`, in a child process), builds the glyph atlas for
`AGENT_FONT_SLOT`, and turns the console's microphone audio into text on the
Mac. Pocket Hub's documentation describes the model runtime, the order of a
turn's messages, the tools, the glyph atlas and speech. Its tests drive the
companion with the reference console client
(`tools/pocket-link/console-client.ts`).
