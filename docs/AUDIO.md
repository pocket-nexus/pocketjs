# The Audio Module

Audio is PocketJS's third module (after the ui surface and OpenStrike's
`strike`), and the first written spec-first: the boundary existed before any
host code, every host implements the same pinned protocol, and a developer
adding an audio feature extends the spec instead of forking a host.
`contracts/spec/audio.ts` is normative; this page is the map.

```
platform audio device (AudioWorklet · sceAudio · CPAL · …)     Host / substrate
    ↑ real-time clock, never calls the guest
audio core: per-stream PCM ring + credit accounting            the module
audio spec: ops (createStream, writePcm, play, …)
            events (credit, underrun, ended — via poll())
            data contract (s16 interleaved PCM · audio:wav.* pak entries)
            frame contract (native clock, tick-batched facts)
SDK: @pocketjs/framework/audio (decodeWav, createWavPlayer)
    ↓
app: apps/music — track state, UI, and a pump() call per frame Guest
```

## The boundary in one page

**Mount.** The module is its own namespace: `globalThis.audio`, one method per
op (`AUDIO_OP` codes are the ABI identity, append-only). Capability id
`audio.pcm` = spec namespace = pak prefix. Hosts that don't mount it cost
nothing — the SDK degrades every call to a silent no-op.

**Ops** (guest → core, synchronous): `createStream(rate, channels)` →
handle, `writePcm(handle, buf)` → frames accepted, `play/pause/stop`,
`setVolume`, `endStream`, `destroyStream`, `poll`. PCM buffers are **borrowed
for the call** — the host copies into its ring before returning.

**Events** (core → guest, batched per tick, drained by `poll()` one JSON line
at a time, the svcPoll convention): `credit {h, free}` re-grounds the guest's
free-frame mirror, `underrun {h}` is edge-triggered per starved episode,
`ended {h}` fires once after `endStream` drains.

**Flow control** is credit-based (docs/RUNTIMES.md law 1 applied to a byte
stream): the guest budgets writes against a mirror that starts at
`AUDIO_RING_FRAMES`, decrements on accepted writes, and is reset by each
credit event. The hot path — one `poll()` drain plus at most one `writePcm`
per tick — never queries.

**Frame contract.** The module owns a *native-side clock*: the output device
consumes on its own real-time thread/callback, which never calls the guest,
never blocks on it, and never allocates on the hot path (rules earned by
`platforms/psp/audio/src/output.rs`, whose module header is the reference reading).
Facts produced on that clock are batched to **tick boundaries**; the guest
stays single-clock and law 3 holds unchanged. Virtual-clock hosts consume
exactly

```
audioFramesForTick(rate, n) = floor((n+1)·rate/60) − floor(n·rate/60)
```

frames per playing tick, which makes consumed PCM a pure function of
(tick index, op stream) — the audio equivalent of byte-exact pixel goldens.

**Rates** are pinned to `44100 | 22050 | 11025`: integer divisors of the
PSP's native 44.1 kHz output, so every host resamples with exact math (the
PSP's hardware resampler is audibly broken; see the pocket-youtube blog
post). This is a hardware constraint promoted to the portable contract on
purpose — a bundle that plays anywhere plays everywhere.

## Host status

| Host | Implementation | Status |
|---|---|---|
| web (`platforms/web/audio.js` + `audio-worklet.js`) | AudioWorklet ring on the render thread, main-thread credit mirror, gesture-deferred `AudioContext` | audible, ships with the dev host |
| sim (`platforms/sim/audio.ts`) | virtual-clock sink, `audioFramesForTick` consumption, PCM FNV-1a + op/event log | deterministic tests (`tests/audio.test.ts`, `tests/audio-sim.test.ts`) |
| psp (`platforms/psp/audio/src/streams.rs`, mounted by `programs/psp/src/service_bindings.rs` `register_audio`) | four rings at the source rate, one mixer thread at priority 16 on one normal 44.1 kHz hardware channel, integer upsample with linear interpolation, facts published as atomics and folded by `poll()` | capability advertised in `hosts/psp/pocket.host.json`; recorded through PPSSPP `DumpAudio`, no real-unit recording yet |
| vita | not mounted — `engine/spec/src/lib.rs` `pub mod audio` carries the contract; the channel/ring/thread discipline to copy exists in `platforms/vita/audio/src/lib.rs` (built for the video plane) | seam documented, capability not advertised |
| macos-widget / pocketbook | not mounted | capability not advertised |

Consoles adopt the module by implementing the namespace in their FFI table
(`programs/psp/src/service_bindings.rs` registration pattern), reusing their existing audio
threads, then appending `audio.pcm` to the capabilities of their host contract,
`hosts/<id>/pocket.host.json`. No spec change, no framework change, no app
change.

## Assets

WAV files ship in the app pak under `audio:wav.<name>` via the raw-blob
`pak.json` route (`apps/music/pak.json`), spliced verbatim at build time and
parsed guest-side by `decodeWav` (RIFF walk, PCM16 only, rates as above —
anything else throws at decode time). `apps/music/gen-assets.ts`
deterministically synthesizes the demo's three original 5-second tracks;
`tests/audio.test.ts` pins their SHA-256. Raw-PCM entries and codec
registration are deliberately deferred until a second format needs them.

## Streaming and sound effects

`createWavPlayer` keeps one whole track in the JS heap, and `pakGet` copies it out of the pak first.
**`framework/src/game2d/music.ts` reads raw s16le mono PCM from a pack file (docs/PACKS.md)** in
8 KiB blocks through one reused buffer, so a track of any length costs the stream's ring and those
8 KiB. `createMusicPlayer` holds at least three blocks in the ring: **557 ms of audio at 22 050 Hz,
278 ms at 44 100 Hz**, the time a slow read has before the output starves. One `pump()` reads at
most one block, plus one more on the frame a loop wraps.

`createSfxBank` decodes a `audio:wav.<name>` entry on first play into its own `ArrayBuffer` and
passes that buffer to `writePcm` on every later play. A sound up to `AUDIO_RING_FRAMES` long takes
one write; a longer one is cut into 8192-frame chunks and fed by credit.

**`poll()` is one queue across streams.** Both use one router that hands each event to the owner of
its handle. `createWavPlayer` drains the same queue and drops events for other handles, so an app
uses one or the other.

**`AUDIO_MAX_STREAMS` is 4.** Music takes one, a crossfade one more until the old track reaches gain 0,
a sounding effect one. The bank releases a stream when its sound ends and defaults to three voices;
a fourth play stops the oldest. A crossfade that finds no free stream fades the old track out first
and starts the new one when a stream frees.

Volume applies per mixer block on PSP (1024 output frames, 23 ms) with no ramp inside the block, so
a fade moves in steps of that length.

## The demo (and the golden-safety property)

`apps/music` streams a real WAV per track on hosts with the module — all
three framework variants (solid / vue-vapor / octane) wire the same
`createWavPlayer`: load on select/skip, play/pause slaved to the UI state,
one `pump()` per frame.

The **tick clock stays authoritative**: position, equalizer and track advance
are the same frame counters with or without audio, and the player only
follows them. `tests/audio-sim.test.ts` pins this by running the same journey
with the module mounted and absent and asserting byte-identical pixel hashes
— which is why all 17 committed music goldens (web + psp×3 + vita) remained
valid without re-baking. A demo that *reacted* to audio events visually would
break exactly this; don't.

## Deferred

Host-level mixing across runtimes, codec registration, raw-PCM pak entries,
and runtime capability negotiation are all deferred until their trigger
conditions exist. The spec grows append-only when they do.
