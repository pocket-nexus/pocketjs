import { getOps } from "./host.ts";
import { mediaPlayer, type MediaSource, type MediaStatus } from "./media.ts";
import { registerServicePump } from "./services.ts";
import type { ServiceClient, ServiceMessage } from "./service-client.ts";

/** Provider response: an encoded native source or a frame-indexed stream.
 * Applications carry media metadata without selecting a decoder or transport. */
export interface MediaPlaying extends ServiceMessage {
  t: "playing"; stream: string; source?: MediaSource; fps: number; position: number;
}
const emptyStatus = (): MediaStatus => ({ phase: "idle", positionMs: 0, bufferedMs: 0, decodedFrames: 0,
  presentedFrames: 0, droppedFrames: 0, receivedBytes: 0, decodeMaxUs: 0, audioUnderruns: 0, hardware: false, error: "" });

/** A single playback lifetime over native media or a companion-produced ring.
 * Native pause stays on the decoder; ring control and end polls stay here.
 * Both presentations consume the same texture, volume and status interface. */
export function createMediaService(service: ServiceClient) {
  let native: ReturnType<typeof mediaPlayer> | undefined;
  let active: MediaPlaying | undefined, snapshot = emptyStatus(), frame = 0, generation = 0;
  let busy = false, volume = .8;
  const listeners = new Set<(event: ServiceMessage) => void>();
  const emit = (event: ServiceMessage) => { for (const listener of listeners) listener(event); };
  const close = () => {
    generation++; busy = false;
    if (native) native.close(); else if (active) getOps().videoClose?.();
    native = undefined; active = undefined; snapshot = emptyStatus();
  };
  const unsubscribe = service.subscribe(event => {
    if (event.t === "offline") close();
    if (event.t === "ended") snapshot.phase = "ended";
    if (event.t === "playback-error" && event.stream === active?.stream) { snapshot.phase = "error"; snapshot.error = String(event.message); }
    emit(event);
  });
  const stopPump = registerServicePump(() => {
    if (!active) return;
    frame++;
    if (native) { snapshot = native.status(); return; }
    const index = getOps().videoTick?.() ?? -1;
    if (index >= 0) { snapshot.positionMs = index / active.fps * 1000; snapshot.presentedFrames++; }
    if (service.transport() !== "companion" || busy || snapshot.phase === "ended" || frame % 120) return;
    busy = true; const owner = generation;
    service.send({ t: "status" }, reply => {
      if (owner !== generation) return;
      busy = false;
      if (reply.t === "status" && reply.ended) { snapshot.phase = "ended"; emit({ t: "ended" }); }
      else if (reply.t === "error" && reply.message !== "Service busy") {
        snapshot.phase = "error"; snapshot.error = String(reply.message);
      }
    });
  });
  return {
    subscribe(deliver: (event: ServiceMessage) => void) { listeners.add(deliver); return () => listeners.delete(deliver); },
    send(message: ServiceMessage, deliver: (reply: ServiceMessage) => void) {
      if (!["play", "pause", "resume", "seek", "stop"].includes(message.t)) {
        service.send(message, deliver); return;
      }
      if ((message.t === "pause" || message.t === "resume") && native) {
        native.pause(message.t === "pause");
        deliver({ t: "state", id: message.id, playing: message.t === "resume", position: native.status().positionMs / 1000 }); return;
      }
      if (message.t === "stop") close();
      const owner = message.t === "play" || message.t === "seek" ? ++generation : generation;
      if (message.t === "play" || message.t === "seek") busy = false;
      service.send(message, reply => {
        if (owner !== generation) return;
        if (reply.t === "playing") {
          const source = reply as MediaPlaying;
          if (!Number.isFinite(source.fps) || source.fps <= 0 || !Number.isFinite(source.position)) {
            deliver({ t: "error", id: message.id, message: "Invalid media response" }); return;
          }
          if (active && !!source.source !== !!native) close();
          active = source; snapshot = { ...emptyStatus(), phase: "opening", positionMs: source.position * 1000 };
          try {
            let opened: boolean;
            if (source.source) { native = mediaPlayer(); opened = native.open(source.source); native.volume(volume); }
            else opened = service.openStream(source.stream);
            if (!opened) throw new Error("Player unavailable. Retry playback.");
            if (!native) snapshot.phase = "playing";
          } catch (error) {
            close(); snapshot.phase = "error"; snapshot.error = String(error);
            deliver({ t: "error", id: message.id, message: snapshot.error }); return;
          }
        } else if (reply.t === "state" && active) {
          snapshot.phase = reply.playing ? "playing" : "paused";
          if (typeof reply.position === "number") snapshot.positionMs = reply.position * 1000;
        }
        deliver(reply);
      });
    },
    texture: () => native ? native.texture() : getOps().videoTexture?.() ?? -1,
    status: (): MediaStatus => ({ ...snapshot }),
    volume(value: number) { volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; native?.volume(volume); },
    dispose() { close(); unsubscribe(); stopPump(); listeners.clear(); },
  };
}
