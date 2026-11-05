// Deterministic relay frame record/replay hook for sim conformance runs.
// It performs no ambient I/O: callers pass a sink for the JSON text and
// hand the resulting transport to the session stack. Mount like the other
// sim host namespaces (db/fs/audio) through bootWorld's extraGlobals:
//
//   const hook = createSimRelayTapeHook({ enabled: true, session: n });
//   await bootWorld(app, 60, { relayTape: hook });
//   const transport = hook.wrap(realOrFakeTransport);
//   ... run ...
//   hook.save((text) => writeFileSync(path, text));
//
// Replay mounts a fake transport that serves recorded inbound records in
// capture order and hashes every outbound record; result() mirrors
// tools/tape.ts --assert: ok, or the first divergent index + seq.

import {
  createRelayFrameReplay,
  parseFrameTape,
  stringifyFrameTape,
  type RelayFrameReplay,
  type RelayFrameTransport,
  type RelayFrameTape,
  type RelayFrameTapeVerdict,
  type RelayRecordingTransport,
  wrapRelayTransport,
  type RelayFrameWrapOptions,
} from "../../framework/src/relay/tape.ts";

export interface SimRelayTapeHookOptions extends RelayFrameWrapOptions {
  /** Recording is opt-in (R5 Q7); default false. */
  enabled?: boolean;
}

export interface SimRelayTapeHook {
  readonly enabled: boolean;
  /** Disabled: returns inner itself (same object, zero per-frame work).
   * Enabled: returns the recording wrapper. */
  wrap<T extends RelayFrameTransport>(inner: T): T | RelayRecordingTransport<T>;
  /** Frames observed since creation; zero while disabled. */
  readonly framesRecorded: number;
  readonly bytesRecorded: number;
  /** Serialize the recording; throws before the first frame. */
  toJson(): string;
  /** Serialize once and hand the text to sink. */
  save(sink: (text: string) => void): void;
}

/** Create the hook. A disabled hook never constructs a recorder, so its
 * counters are plain zero values and wrap() is identity. */
export function createSimRelayTapeHook(options: SimRelayTapeHookOptions = {}): SimRelayTapeHook {
  const enabled = options.enabled === true;
  let wrapper: RelayRecordingTransport<RelayFrameTransport> | null = null;
  return {
    enabled,
    wrap<T extends RelayFrameTransport>(inner: T): T | RelayRecordingTransport<T> {
      if (!enabled) return inner;
      if (wrapper) throw new Error("sim relay-tape: one hook wraps one transport");
      const w = wrapRelayTransport(inner, {
        enabled: true,
        session: options.session,
        maxFrames: options.maxFrames,
      }) as RelayRecordingTransport<T>;
      wrapper = w as unknown as RelayRecordingTransport<RelayFrameTransport>;
      return w;
    },
    get framesRecorded() { return wrapper?.relayRecorder.framesRecorded ?? 0; },
    get bytesRecorded() { return wrapper?.relayRecorder.bytesRecorded ?? 0; },
    toJson() {
      if (!wrapper) throw new Error("sim relay-tape: recording was never enabled or used");
      return stringifyFrameTape(wrapper.relayRecorder.toTape());
    },
    save(sink: (text: string) => void) { sink(this.toJson()); },
  };
}

export interface SimRelayReplay {
  /** Fake transport for the replayed session stack. */
  readonly transport: RelayFrameReplay;
  /** True iff every tuple replayed with matching sha256. */
  result(): RelayFrameTapeVerdict;
}

/** Parse a frame tape and build the fake replay transport. */
export function loadSimRelayReplay(text: string): { tape: RelayFrameTape; replay: SimRelayReplay } {
  const tape = parseFrameTape(text);
  const transport = createRelayFrameReplay(tape);
  return { tape, replay: { transport, result: () => transport.result() } };
}
