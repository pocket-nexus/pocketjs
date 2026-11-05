// platforms/web/audio.js — the browser host's implementation of the audio module
// (contracts/spec/audio.ts): the guest-facing `globalThis.audio` namespace,
// credit bookkeeping, and the bridge to the real-time side in
// platforms/web/audio-worklet.js.
//
// Split of labor mirrors the frame contract:
//   - ops run synchronously on the main thread against a guest-visible
//     occupancy MIRROR (the worklet can't be queried synchronously);
//   - the worklet consumes on the device clock and reports facts
//     (consumed/underrun/ended) over the port;
//   - beginFrame() — called by engine.js at the top of every guest frame —
//     folds those facts into the per-tick event batch that poll() drains.
//
// AudioContext quirks handled here: the context starts suspended until a
// user gesture (we resume on the first keydown/pointerdown — the demo needs
// a button press to start playback anyway, so the gesture always arrives
// first), and worklet module loading is async (commands queue until ready).

/** Must equal AUDIO_RING_FRAMES / AUDIO_MAX_STREAMS / AUDIO_RATES in
 *  contracts/spec/audio.ts. */
const RING_FRAMES = 16384;
const MAX_STREAMS = 4;
const RATES = [44100, 22050, 11025];

export function createAudioHost() {
  let ctx = null;
  let node = null; // AudioWorkletNode once the module loads
  let pending = []; // port messages queued until the worklet is live
  let nextHandle = 1;
  const streams = new Map(); // handle -> stream state (main-thread mirror)
  const inbox = []; // worklet fact messages, drained by beginFrame()
  const events = []; // this tick's event batch, drained by poll()

  function post(msg, transfer) {
    if (node) node.port.postMessage(msg, transfer || []);
    else pending.push(msg);
  }

  function resumeOnGesture() {
    const resume = () => {
      if (ctx && ctx.state === "suspended") ctx.resume();
      window.removeEventListener("keydown", resume);
      window.removeEventListener("pointerdown", resume);
    };
    window.addEventListener("keydown", resume);
    window.addEventListener("pointerdown", resume);
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new AudioContext();
    if (ctx.state === "suspended") resumeOnGesture();
    ctx.audioWorklet
      .addModule(new URL("./audio-worklet.js", import.meta.url))
      .then(() => {
        node = new AudioWorkletNode(ctx, "pocket-audio", {
          numberOfInputs: 0,
          outputChannelCount: [2],
        });
        node.port.onmessage = (e) => inbox.push(e.data);
        node.connect(ctx.destination);
        for (const m of pending) node.port.postMessage(m);
        pending = [];
      })
      .catch((e) => console.error("audio: worklet failed to load — silent host", e));
  }

  const ns = {
    createStream(sampleRate, channels) {
      if (RATES.indexOf(sampleRate) < 0 || channels < 1 || channels > 2) return -1;
      if (streams.size >= MAX_STREAMS) return -1;
      ensureContext();
      const handle = nextHandle++;
      streams.set(handle, {
        occupancy: 0, // source frames queued (guest-visible credit mirror)
        lastFree: RING_FRAMES, // last credit value the guest saw
        channels,
      });
      post({ t: "create", id: handle, rate: sampleRate, channels, volume: 1 });
      return handle;
    },
    destroyStream(handle) {
      if (!streams.delete(handle)) return;
      post({ t: "destroy", id: handle });
    },
    writePcm(handle, pcm) {
      const s = streams.get(handle);
      if (!s) return 0;
      const src = new Int16Array(pcm);
      const frames = (src.length / s.channels) | 0;
      const accepted = Math.min(frames, RING_FRAMES - s.occupancy);
      if (accepted <= 0) return 0;
      const f32 = new Float32Array(accepted * s.channels);
      for (let i = 0; i < f32.length; i++) f32[i] = src[i] / 32768;
      s.occupancy += accepted;
      post({ t: "write", id: handle, pcm: f32 }, [f32.buffer]);
      return accepted;
    },
    play(handle) {
      if (streams.has(handle)) post({ t: "play", id: handle });
      if (ctx && ctx.state === "suspended") ctx.resume();
    },
    pause(handle) {
      if (streams.has(handle)) post({ t: "pause", id: handle });
    },
    stop(handle) {
      const s = streams.get(handle);
      if (!s) return;
      // The flush is authoritative main-side: occupancy drops to zero NOW so
      // the next credit reflects an empty ring; the worklet skips its cursor
      // without reporting the dropped frames (see audio-worklet.js "stop").
      s.occupancy = 0;
      post({ t: "stop", id: handle });
    },
    setVolume(handle, volume) {
      if (streams.has(handle)) {
        post({ t: "volume", id: handle, v: Math.max(0, Math.min(1, volume)) });
      }
    },
    endStream(handle) {
      if (streams.has(handle)) post({ t: "end", id: handle });
    },
    poll() {
      return events.length ? events.shift() : undefined;
    },
  };

  return {
    ns,
    /** Fold audio-clock facts into this tick's event batch. Called by
     *  engine.js before every guest frame (events describe the world up to
     *  the previous tick boundary, per the frame contract). */
    beginFrame() {
      for (const m of inbox) {
        const s = streams.get(m.id);
        if (!s) continue; // stream destroyed while the fact was in flight
        if (m.t === "consumed") {
          s.occupancy = Math.max(0, s.occupancy - m.frames);
        } else if (m.t === "underrun") {
          events.push(JSON.stringify({ t: "underrun", h: m.id }));
        } else if (m.t === "ended") {
          events.push(JSON.stringify({ t: "ended", h: m.id }));
        }
      }
      inbox.length = 0;
      for (const [handle, s] of streams) {
        const free = RING_FRAMES - s.occupancy;
        if (free !== s.lastFree) {
          s.lastFree = free;
          events.push(JSON.stringify({ t: "credit", h: handle, free }));
        }
      }
    },
    /** Fresh app load: destroy every stream, drop queued events. The
     *  AudioContext and worklet node survive across reloads. */
    reset() {
      for (const handle of [...streams.keys()]) ns.destroyStream(handle);
      events.length = 0;
      inbox.length = 0;
    },
  };
}
