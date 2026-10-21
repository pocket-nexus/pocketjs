// platforms/web/audio-worklet.js — the browser embodiment of the audio module's
// NATIVE CLOCK (contracts/spec/audio.ts frame contract): this processor runs
// on the real-time audio rendering thread, never calls the guest, never
// blocks, and only moves ring memory into the device. The main thread
// (platforms/web/audio.js) owns the guest-facing ops and the credit bookkeeping;
// this side receives commands and PCM over the port and reports consumption
// facts back, which the host batches to tick boundaries.
//
// Per stream: a Float32 ring at the SOURCE rate (capacity mirrors
// AUDIO_RING_FRAMES in contracts/spec/audio.ts), a fractional read cursor
// resampling to the device rate by linear interpolation (the same
// carry-the-previous-frame join platforms/psp/audio/src/output.rs uses), an underrun
// edge flag, and a consumed-frames accumulator flushed every ~512 frames so
// the port isn't hammered once per 128-frame quantum.

/** Must equal AUDIO_RING_FRAMES in contracts/spec/audio.ts. */
const RING_FRAMES = 16384;
/** Post a consumed report at least this often (source frames). */
const REPORT_FRAMES = 512;

class PocketAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.streams = new Map();
    this.port.onmessage = (e) => this.command(e.data);
  }

  command(m) {
    const s = this.streams.get(m.id);
    switch (m.t) {
      case "create":
        this.streams.set(m.id, {
          rate: m.rate,
          channels: m.channels,
          ring: new Float32Array(RING_FRAMES * m.channels),
          writePos: 0, // absolute source frames written
          readPos: 0, // absolute source frames read, fractional
          consumed: 0, // integer source frames reported so far
          acc: 0, // consumed frames not yet reported
          volume: m.volume,
          playing: false,
          endFlagged: false,
          starved: false,
        });
        break;
      case "write": {
        if (!s) break;
        // Credit is enforced on the main thread — pcm always fits.
        const pcm = m.pcm;
        const ch = s.channels;
        const frames = (pcm.length / ch) | 0;
        for (let i = 0; i < frames; i++) {
          const dst = ((s.writePos + i) % RING_FRAMES) * ch;
          for (let c = 0; c < ch; c++) s.ring[dst + c] = pcm[i * ch + c];
        }
        s.writePos += frames;
        break;
      }
      case "play":
        if (s) s.playing = true;
        break;
      case "pause":
        if (s) {
          s.playing = false;
          this.flushReport(m.id, s);
        }
        break;
      case "stop":
        if (s) {
          s.playing = false;
          // Flush: skip the read cursor to the write head WITHOUT reporting
          // the dropped frames as consumed — the main thread already zeroed
          // its occupancy mirror when it issued the stop.
          s.readPos = s.writePos;
          s.consumed = s.writePos;
          s.acc = 0;
          s.endFlagged = false;
          s.starved = false;
        }
        break;
      case "volume":
        if (s) s.volume = m.v;
        break;
      case "end":
        if (s) s.endFlagged = true;
        break;
      case "destroy":
        this.streams.delete(m.id);
        break;
    }
  }

  flushReport(id, s) {
    if (s.acc > 0) {
      this.port.postMessage({ t: "consumed", id, frames: s.acc });
      s.acc = 0;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const n = outL.length;
    for (const [id, s] of this.streams) {
      if (!s.playing) continue;
      const step = s.rate / sampleRate;
      const ch = s.channels;
      let i = 0;
      for (; i < n; i++) {
        // Linear interpolation needs the frame at floor(readPos) and its
        // successor; the successor must already be written.
        const base = Math.floor(s.readPos);
        if (base + 1 >= s.writePos) break; // ring exhausted
        const frac = s.readPos - base;
        const i0 = (base % RING_FRAMES) * ch;
        const i1 = ((base + 1) % RING_FRAMES) * ch;
        const l = s.ring[i0] + (s.ring[i1] - s.ring[i0]) * frac;
        const r = ch === 2 ? s.ring[i0 + 1] + (s.ring[i1 + 1] - s.ring[i0 + 1]) * frac : l;
        outL[i] += l * s.volume;
        outR[i] += r * s.volume;
        s.readPos += step;
      }
      const wholeRead = Math.floor(s.readPos);
      if (wholeRead > s.consumed) {
        s.acc += wholeRead - s.consumed;
        s.consumed = wholeRead;
      }
      if (i < n) {
        // Ran dry mid-block: end-of-stream drain or an underrun.
        if (s.endFlagged) {
          s.playing = false;
          this.flushReport(id, s);
          this.port.postMessage({ t: "ended", id });
        } else if (!s.starved) {
          s.starved = true;
          this.flushReport(id, s);
          this.port.postMessage({ t: "underrun", id });
        }
      } else {
        s.starved = false;
        if (s.acc >= REPORT_FRAMES) this.flushReport(id, s);
      }
    }
    return true;
  }
}

registerProcessor("pocket-audio", PocketAudioProcessor);
