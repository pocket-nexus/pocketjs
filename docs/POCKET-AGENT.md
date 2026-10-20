# Pocket Agent

The console agent is the mascot on a console's top screen and the model that
operates Pocket apps for the user. The console streams the user's request (typed
text or microphone audio) over the [Pocket Link](POCKET-LINK.md) to the
companion; the companion runs the model, and the model acts on the console's
touch screen through tool calls the console answers. The wire contract is
`contracts/spec/agent.ts`. This page describes the console side (the 3DS host
in `hosts/3ds/src/stage.c` and `agent.c`, the guest overlay in
`framework/src/agent-layer.tsx`) and the companion side (`tools/companion/`).

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

**The hint.** While the mode is `idle`, a pill in the bottom-right corner
shows two key caps, L and R, and "Ask Claude". It is a 128×32 RGBA8 texture
baked from Inter Bold by `tools/3ds-stage-art.ts` into
`hosts/3ds/src/stage_hint.h`, drawn after each eye with an orthographic
projection at the screen's pixels (zero parallax), its opacity in the texture
combiner's constant colour. It fades out in **about 0.2 s** when the mode
leaves `idle` and back in over **about 0.6 s**. `bun tools/3ds-stage-art.ts
--check` fails when either header is stale.

On an Old 3DS the stage adds about **0.4 ms** to the frame's GPU phase (3.0 ms
against 2.6 ms), and the Hacker News app (pocket-shell `shells/3ds/hn`) still
scrolls its list at 59 to 61 frames a second.

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

| File | Role |
| --- | --- |
| `agent.ts` | `AgentService` (one per companion) and `AgentSession` (one per paired console) |
| `codex.ts` | the `codex app-server` child and its JSON-RPC client |
| `transcribe.ts`, `macos/Transcribe.swift` | speech to text on the Mac |
| `glyphs.ts`, `macos/Glyphs.swift` | the font atlas for the agent's text on the console |
| `swift-helper.ts` | finds or builds the two Swift helpers |
| `own-screen.ts` | the agent's own screen: a Pocket app in the sim host, in a child process |

## Model runtime

The companion runs **one `codex app-server` child** (stdio, one JSON object per
line) for all consoles and starts it at the first request. It sends
`initialize` with `capabilities.experimentalApi: true`, which the dynamic tools
need. A child that exits fails the turn in progress; the next request starts a
new child and new threads.

The binary is `$CODEX_BIN`, else the first `codex` on `PATH`, else
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`, every
`~/.nvm/versions/node/*/bin`, and `Codex.app/Contents/Resources/codex-cli/bin`.
`PATH` directories of terminal wrappers (`.superset/bin`) are skipped. The
binary's directory leads the child's `PATH`, so an npm install's
`#!/usr/bin/env node` finds its node.

**The child runs with its own `CODEX_HOME`**, `<store>/codex/`:

- `auth.json` is a **symlink** to `~/.codex/auth.json`; the companion never
  reads or copies the sign-in. With no `auth.json` the agent is off.
- `config.toml` is written at every start: `model` from the user's
  `~/.codex/config.toml` (or `--agent-model`), `model_reasoning_effort = "low"`
  (or `--agent-effort`), approval `never`, sandbox `read-only`,
  `project_doc_max_bytes = 0`, web search off, and the features that bring
  tools or startup work turned off (`CODEX_FEATURES_OFF`: shell, unified exec,
  view_image, sleep, hooks, multi-agent, apps, plugins, browser and computer
  use, image generation, skills, goals, memories, in-app browser, realtime).
  `code_mode_host` stays on: dynamic tool calls go through it.

The user's global instructions, hooks, MCP servers, skills and plugins do not
reach the console's turns. Measured on one turn ("看看我屏幕上有什么", one
`observe`, gpt-6-astra, effort low):

| `CODEX_HOME` | first request input | turn total | `turn/start` → request sent | `turn/start` → reply done |
| --- | --- | --- | --- | --- |
| user's `~/.codex` | 36,230 tokens | 36,327 tokens | 5.0 s (hooks, MCP servers) | 13.6 s |
| `<store>/codex` | **7,051 tokens** | 14,880 tokens (text report) | 4.7 s cold, **1.4 s** on a thread opened ≥ 8 s earlier | 11.7 s, 3 s after `hello` |

**Each console has one thread** (`thread/start`, `ephemeral`), created when
the console's guest sends `agent.hello`: the first request finds the thread
open, and the child's connection warm. The thread holds the conversation
until `agent.reset` or until the child exits. `baseInstructions` replaces
codex's coding prompt with the persona and the rules of the job
(`AGENT_INSTRUCTIONS` in `agent.ts`): Claude, the mascot in the room on the
top screen; observe before acting; replies in the user's language, one to four
sentences of plain text for a 320×240 screen. Each turn's input is two text
items: a context line (the app on the user's screen, the installed apps, the
own screen's app, the locale) and the request.

## Turns

```
console   agent.turn {id, text}                    or the end of a spoken request
companion agent.request {id, text}
          agent.state {phase: "thinking"}
          agent.step / agent.tool …                (tool calls, below)
          agent.state {phase: "replying"} + agent.delta {id, text} …
          agent.usage {id, usage} …
          agent.done {id, text, usage}             or agent.error {id, message}
          agent.state {phase: "idle"}
```

- `item/agentMessage/delta` of a **final** message is reply text
  (`agent.delta`). A message the model marks `commentary` (a note before a
  tool call) is sent once complete as an `agent.step` line, never as reply
  text.
- `usage` sums the turn's model requests (`thread/tokenUsage/updated`
  `last`); `usage.total` is the conversation's total.
- A request while a turn runs is refused with `agent.error` ("我还在忙上一件事").
- `agent.cancel` answers every waiting tool call with a failure, sends
  `turn/interrupt`, and ends the turn with `agent.done` (the text so far). A
  turn codex does not close within 3 s is closed by the companion.
- Approval requests are declined; the agent has no other tools.

`agent.state` goes out on every change of phase or screen, and as the answer
to every `agent.hello`, so a guest that boots mid-turn (after `launch`)
resumes from it. It carries the turn's request text, so a guest that did not
see `agent.request` still shows it.

## Tools

The thread's dynamic tools are `AGENT_TOOLS` from the contract: `observe`,
`tap`, `drag`, `press`, `type`, `launch`, `wait`, each with
`screen: "user" | "own"`. **The companion runs one tool call at a time per
console**, in arrival order: the model may issue several calls at once, and a
screen does one thing at a time. Each call sends `agent.step` with a short
line in English, the console's interface language ("Tapping \"Comments\"",
"Opening Hacker News", "On my screen: Looking at the screen"); a tap names the
text under the point from the last report.

**User screen.** The companion sends `agent.tool {id, call, name, args}` and
waits for `agent.result {call, ok, text, shot?}`, at most **20 s**. `text` is
the console's report (`AgentScreenReport` as JSON) and goes to the model as
is. A `shot` names a stream the console opened with `agent.shot` (320×240
RGB565); the companion turns it into a PNG data URL. **The image reaches the
model only for `observe` with `image: true`**: a 320×240 screenshot costs the
model 12k to 17k input tokens, the text report of the same screen about 0.6k.

`launch` replaces the console's guest: the old guest never answers. The call
waits up to **30 s** for the next `agent.hello` and succeeds with the app
that said hello. A link that drops fails every other waiting call; a launch
keeps waiting for the console to come back.

**Own screen.** The companion runs the app's `3ds-dev` bundle from the
catalog's `.pocket` file (extracted to `<store>/own/`) in the sim host with
the 3DS geometry (`hosts/sim/console-3ds.ts`), in a child process, since the
sim replaces process globals. The child steps the app at 60 frames a second
of wall time; its NET module is the companion's own fetch, with the link's
destination policy. Actions queue touch and button frames, then wait
`AGENT_SETTLE_FRAMES` frames and while requests are in flight (at most 4 s
more). The report's texts come from the sim's tree in reading order. The
first own-screen call boots the app on the user's screen; `launch` boots
another. `type` is not available there yet.

After every own-screen action, and every **500 ms** during an own-screen turn,
the companion sends the frame to the console's monitor when it changed:
`agent.screen {stream, width: 320, height: 240, format: "rgb565", bytes}` on a
stream id with `AGENT_COMPANION_STREAM` set, then 153,600 bytes of data
frames. A frame still being sent makes the next one wait its turn.

## Messages and glyphs

Every message to a console leaves through one **outbox per session**, in the
order the session made it. Reply deltas wait **250 ms** for more and leave as
one `agent.delta`; any other message sends the held text first.

A console bakes only the glyphs its bundle's source names, so the agent's
words have none there. Before a message whose text (`agent.request`,
`agent.transcript`, `agent.delta`, `agent.step`, `agent.done`, the
`agent.error` message) uses a codepoint the console does not hold, the outbox
sends the console's whole atlas: `agent.glyphs {stream, slot: 23, bytes}` and
the blob as data frames on a stream id with `AGENT_COMPANION_STREAM` set, then
the message. The blob is a FONT ATLAS v3 (`contracts/spec/spec.ts`) for
`AGENT_FONT_SLOT`: `AGENT_FONT` cells (15×18 at density 1, baseline 14 px
from the top), gid 0 a tofu box mapped from U+FFFD as `bake-font.ts` maps it,
one cmap entry per glyph sorted by codepoint. It holds printable ASCII, common
CJK punctuation, the overlay's own words (`AGENT_LABEL_GLYPHS`) and every
codepoint the conversation has sent; past
`AGENT_FONT_MAX_GLYPHS` it starts over with the base set and the codepoints of
the current turn. Every `agent.hello` (a new guest holds no agent glyphs)
sends the atlas again.

`pocket-glyphs` (`macos/Glyphs.swift`) rasterizes with CoreText: PingFang SC
at 13 px, a codepoint it lacks drawn by the font CoreText's cascade picks,
antialiased coverage without font smoothing, the advance rounded and at most
the cell's width, `xoff` the shift that keeps negative left-side-bearing ink
in the cell. A codepoint no font draws stays out of the cmap and shows the
tofu box. One helper child serves every console and the cells are cached by
codepoint: the first request (with the build) took 1.3 s for 15 glyphs, 95
more took 2 ms. A glyph costs 278 bytes (cell and cmap entry): the base atlas
of 165 glyphs is 45,886 bytes, a full one 333,894.

## Speech

`agent.audio {id, rate}` starts a transcription; the data frames on stream
`id` are s16le mono PCM, capped at `AGENT_MIC_MAX_MS` of audio.
`agent.audio.end {id, send}` ends it. While audio arrives, the companion sends
`agent.transcript {id, text, final: false}` with the whole text so far; after
the end, one `agent.transcript {final: true}`. With `send`, a non-empty final
text starts turn `id`; an empty one ends with `agent.error` ("I didn't catch
that. Say it again?").

`pocket-transcribe` (`macos/Transcribe.swift`) runs **macOS 26
SpeechAnalyzer + SpeechTranscriber on the Mac**: it reads PCM at the given rate
from stdin, converts it to the model's format with `AVAudioConverter`, prints
`{"text", "final"}` JSON lines with volatile results, and prints the final line
after stdin closes. The locale is the console's (`agent.hello.locale`), else
the language of the user's last request (Chinese when it holds a CJK
character), else Chinese when the Mac lists a Chinese language among its
preferred ones, else English. Step lines and error messages are English. The
reply follows the language of the request. A locale's model downloads on first use;
no audio leaves the Mac. The helper is built at the first `agent.hello`. The 3DS probe sentence (3.9 s of audio
at 16,360 Hz, streamed in 100 ms chunks) gave 23 partial results and the
final text **61 ms after the end of the audio**.

Both helpers (`pocket-transcribe`, `pocket-glyphs`) come from, in order, an
environment override (`$POCKET_AGENT_TRANSCRIBER`, `$POCKET_AGENT_GLYPHS`: a
binary, or a `.ts` file run with Bun), the binary of that name next to the
daemon (the app bundle's `Contents/MacOS`), or a `swiftc` build of the source
into `<store>/bin/<name>-<hash>`.

## Running

`bun run companion serve` runs the agent when codex is found and signed in;
`ready` then lists the feature `agent`. Options: `--no-agent`,
`--agent-model <id>`, `--agent-effort <level>`. The own screen needs a
PocketJS checkout: the daemon runs `tools/companion/own-screen.ts` from its
own checkout, or, as the app bundle, from the checkout its apps directory
belongs to, with Bun. `bun run companion:app` also builds `pocket-transcribe`
and `pocket-glyphs` into the bundle.

## Tests

`tests/pocket-agent.test.ts` (unit stage of `tools/test.ts`) runs the
companion on loopback with a scripted fake `codex app-server` and a fake
transcriber, and drives it with the reference console client
(`tools/companion/console-client.ts`): hello and state, a typed turn whose
`observe` the console answers with a shot stream, a shot the model did not ask
for, a spoken turn and a silent one, busy and cancel, a tool the console never
answers, `launch` resumed by the next guest's hello, reset, and a companion
without codex. With a fake glyph helper it reads every atlas back with its
own FONT ATLAS v3 reader: the base atlas after hello, the atlas ahead of the
first message that needs its glyphs, one delta for two within the hold, the
whole atlas again after a guest switch, tofu for an undrawable codepoint and
the start-over past the cap. It also checks the dedicated codex home, the RGB565 and PNG
conversions and the order of screen texts.
