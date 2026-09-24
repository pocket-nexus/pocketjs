// PocketJS audio spec — the boundary of the AUDIO module (`globalThis.audio`).
//
// This is a MODULE spec in the docs/RUNTIMES.md §5 sense: a vertical slice
// with its own vocabulary, mounted as its own namespace, pinned here as data.
// It is deliberately NOT part of the `ui` op table — audio evolves append-only
// in its own op space, and a host adopts it independently of the UI surface
// (capability id `audio.pcm` in contracts/spec/platforms.ts).
//
// The four parts of the boundary:
//
//   ops            guest -> core intent (numeric codes below, append-only)
//   events         core -> guest facts (per-tick batch, drained via poll())
//   data contract  PCM buffer layout + WAV pak entry layout (this file)
//   frame contract the native-audio-clock rules (below)
//
// Frame contract — the audio module owns a NATIVE-SIDE CLOCK:
//
//   The output device (sceAudio thread, AudioWorklet callback, CPAL stream)
//   runs on its own real-time clock. It never calls the guest, never blocks
//   on the guest, and never allocates on the hot path. Facts produced on the
//   audio clock (frames consumed, underrun, drain) are batched and delivered
//   to the guest ON THE TICK CLOCK: `poll()` during the guest's single
//   per-tick turn returns events describing everything up to the previous
//   tick boundary. The guest stays single-clock (law 3 holds unchanged).
//
//   Flow control is credit-based: the core grants ring space as `credit`
//   events, the guest writes PCM as `writePcm` ops. The guest mirrors its
//   free-frame budget (starts at AUDIO_RING_FRAMES, minus its own accepted
//   writes, reset by each credit event) so the hot path never queries.
//
//   Virtual-clock hosts (hosts/sim) consume EXACTLY audioFramesForTick()
//   frames per tick while a stream plays. That makes consumed PCM a pure
//   function of (tick index, op stream) — byte-exact audio traces, the same
//   determinism story as the pixel goldens.
//
// Ownership: `writePcm` BORROWS the guest buffer for the duration of the
// synchronous call — the host copies into its ring before returning, and the
// guest may reuse the buffer immediately. No shared mutable buffers, ever.
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts`, commit
// the regenerated engine/core/src/spec.rs (tests/contract.ts byte-compares).

// ---------------------------------------------------------------------------
// Audio ops (the `audio.*` native contract)
// ---------------------------------------------------------------------------
// Numeric codes are the FFI ABI identity of each op. 0 is reserved
// (invalid/nop). Codes are append-only: never renumber, never reuse.
//
// Signatures (authoritative; hosts marshal them however they like):
//   createStream(sampleRate:u32, channels:u32) -> handle | -1
//                    [rate must be in AUDIO_RATES, channels 1|2; -1 = refused
//                     (bad format or AUDIO_MAX_STREAMS live streams already)]
//   destroyStream(handle)                 [stops output, frees the ring]
//   writePcm(handle, pcm:ArrayBuffer) -> framesAccepted:i32
//                    [interleaved s16 LE frames at the stream rate; BORROWED
//                     for the call. Accepts min(free ring space, frames);
//                     the guest budgets via credit so partial accepts mean a
//                     racing flush, not an error]
//   play(handle)                          [start consuming on the audio clock]
//   pause(handle)                         [stop consuming; ring is kept]
//   stop(handle)                          [pause + flush the ring]
//   setVolume(handle, volume:f64)         [0..1, applied on the audio clock]
//   endStream(handle)                     [no more writes will come: when the
//                                          ring drains, the stream auto-pauses
//                                          and emits one `ended` event]
//   poll() -> string | undefined          [drain ONE queued event per call
//                                          (svcPoll convention); undefined =
//                                          batch empty. Call at most once per
//                                          event per tick — events are queued
//                                          at tick boundaries only]

export const AUDIO_OP = {
  createStream: 1,
  destroyStream: 2,
  writePcm: 3,
  play: 4,
  pause: 5,
  stop: 6,
  setVolume: 7,
  endStream: 8,
  poll: 9,
} as const;

// ---------------------------------------------------------------------------
// Audio events (core -> guest facts, JSON, one object per poll() line)
// ---------------------------------------------------------------------------
// Shapes are append-only: new fields may be added, existing fields never
// change meaning. `h` is always the stream handle.
//
//   { "t": "credit",   "h": <handle>, "free": <frames> }
//        Ring space available at the last tick boundary. Emitted whenever
//        occupancy changed since the previous tick (consumption or flush).
//        Resets the guest's free-frame mirror to the authoritative value.
//   { "t": "underrun", "h": <handle> }
//        The audio clock wanted frames the ring didn't have. Emitted once per
//        starved episode (edge-triggered), not per starved block. The device
//        outputs silence for the gap; playback resumes when data arrives.
//   { "t": "ended",    "h": <handle> }
//        endStream() was called and the ring has fully drained. The stream is
//        auto-paused; it may be destroyed or rewritten-to and replayed.

export const AUDIO_EVENT = {
  credit: "credit",
  underrun: "underrun",
  ended: "ended",
} as const;

// ---------------------------------------------------------------------------
// Data contract — PCM
// ---------------------------------------------------------------------------

/**
 * Accepted stream sample rates. This is the PSP hardware constraint promoted
 * to the portable contract: the PSP outputs at its native 44.1 kHz and only
 * integer upsample ratios avoid the (audibly broken) hardware resampler —
 * see hosts/psp/src/audio.rs. Keeping every stream an integer divisor of
 * 44.1 kHz means every current and future host resamples with cheap exact
 * math, so a bundle that plays anywhere plays everywhere.
 */
export const AUDIO_RATES = [44100, 22050, 11025] as const;

/** Interleaved s16 LE; 1 (upmixed by the host) or 2 channels. */
export const AUDIO_MAX_CHANNELS = 2;

/**
 * Per-stream ring capacity in SOURCE sample frames (~740 ms at 22.05 kHz —
 * the same figure hosts/psp/src/audio.rs carries for the video plane ring).
 * This is the credit ceiling: a guest's free-frame mirror starts here.
 */
export const AUDIO_RING_FRAMES = 16384;

/** Live streams per runtime. A music player needs 1; leave room for a UI
 *  sound layered over it. Deliberately tiny — a mixer with real polyphony is
 *  a future module concern, not a bigger constant. */
export const AUDIO_MAX_STREAMS = 4;

/**
 * Frames the audio clock consumes on virtual tick `tick` (0-based, counted
 * per stream while playing) at `ticksPerSecond` core ticks per second — the
 * realm's declared rate, 60 unless the host declares otherwise. The
 * Bresenham-style floor difference distributes non-divisible rates
 * (22050/60 = 367.5) with zero drift: the sum over any `ticksPerSecond`
 * consecutive ticks is exactly `rate`.
 *
 * This formula IS the deterministic-audio contract: virtual-clock hosts
 * (hosts/sim) consume exactly this many frames per playing tick, making the
 * consumed PCM byte-stream a pure function of (tick index, op stream).
 * Real-time hosts consume on the device clock instead and report through
 * `credit` — the formula is their long-run average by construction.
 *
 * An audio-capable host that declares a non-60 realm rate must pass that
 * rate here; the pairing invariant (framework/src/host.ts) refuses the
 * mismatched mount, so formula and realm can only disagree through a host
 * bug, never through a bundle.
 */
export function audioFramesForTick(rate: number, tick: number, ticksPerSecond = 60): number {
  return (
    Math.floor(((tick + 1) * rate) / ticksPerSecond) -
    Math.floor((tick * rate) / ticksPerSecond)
  );
}

// ---------------------------------------------------------------------------
// Data contract — WAV pak entries
// ---------------------------------------------------------------------------
// Audio assets ship in the app pak under the module's own key namespace
// (capability id = spec namespace = pak prefix):
//
//   audio:wav.<name>   a complete RIFF/WAVE file, spliced verbatim
//                      (apps/<app>/pak.json raw-blob route, PAK_DTYPE.u8)
//
// Accepted WAV shape (decodeWav in framework/src/audio-api.ts is the
// reference decoder; anything else must fail loudly at decode time):
//   - RIFF/WAVE, `fmt ` chunk audioFormat 1 (PCM), bitsPerSample 16
//   - channels 1..AUDIO_MAX_CHANNELS, sampleRate in AUDIO_RATES
//   - one `data` chunk; frames = dataBytes / (2 * channels)
//
// The container is parsed guest-side (44-byte header class, cold path, once
// per track). Raw-PCM pak entries and codec registration are deliberately
// absent until a second format needs them (docs/RUNTIMES.md discipline).

export const AUDIO_PAK_WAV_PREFIX = "audio:wav.";
