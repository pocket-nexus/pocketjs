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
`hosts/psp/src/audio.rs`, whose module header is the reference reading).
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
| web (`hosts/web/audio.js` + `audio-worklet.js`) | AudioWorklet ring on the render thread, main-thread credit mirror, gesture-deferred `AudioContext` | audible, ships with the dev host |
| sim (`hosts/sim/audio.ts`) | virtual-clock sink, `audioFramesForTick` consumption, PCM FNV-1a + op/event log | deterministic tests (`tests/audio.test.ts`, `tests/audio-sim.test.ts`) |
| desktop (`hosts/desktop/src/audio.rs`) | default `audio-output` feature: one CPAL output callback, per-realm four-stream rings, integer resampling into a 44.1 kHz mix | audible through a 44.1 kHz Linux or macOS device; `--no-default-features` omits device output and uses the clocked null sink |
| psp (`hosts/psp/src/audio_mod.rs`) | four-stream atomic ring mixer on one 44.1 kHz hardware channel | audible, capability advertised |
| vita | `hosts/vita/src/audio.rs` provides the video plane audio path; the PCM module is not mounted | capability not advertised |
| macos-widget / pocketbook | not mounted | capability not advertised |

The desktop host preallocates one audio client for the shell and each package
in the System catalog. **All desktop clients share one device callback, while
stream handles, credit and event queues remain scoped to one guest realm.** Set
`POCKETJS_AUDIO=null` to select the clocked null sink for headless validation.
The host parks this sink while the device callback is healthy and wakes it if
CPAL reports a device failure, so the module clock and event flow continue.
If the sink worker cannot be created, the 60 Hz host loop advances one
process-wide mixer by 735 frames before the guest turns. This fallback covers
all realms and preserves credit and ended events after device loss.

The desktop crate enables its `audio-output` Cargo feature by default. This
feature links CPAL; Linux builds require the ALSA development package at build
time and `libasound.so.2` at runtime. Build the desktop crate with
`--no-default-features` to omit CPAL and the ALSA link. The resulting host keeps
`globalThis.audio` mounted and runs its rings on the clocked null sink, but it
produces no audible output.

Other consoles adopt the module by implementing the namespace in their FFI
table (`hosts/psp/src/ffi.rs` registration pattern), reusing their existing
audio threads, then appending `audio.pcm` to their target profile in
`contracts/spec/platforms.ts`. No spec change, framework change or app change
is required.

## Assets

WAV files ship in the app pak under `audio:wav.<name>` via the raw-blob
`pak.json` route (`apps/music/pak.json`), spliced verbatim at build time and
parsed guest-side by `decodeWav` (RIFF walk, PCM16 only, rates as above —
anything else throws at decode time). `apps/music/gen-assets.ts`
deterministically synthesizes the demo's three original 5-second tracks;
`tests/audio.test.ts` pins their SHA-256. Raw-PCM entries and codec
registration are deliberately deferred until a second format needs them.

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

## Deferred (triggers in the ontology doc)

Cross-runtime priority and ducking, codec registration, raw-PCM pak entries,
and runtime capability negotiation are deferred until their trigger
conditions exist. The spec grows append-only when they do.
