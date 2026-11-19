import { getOps } from "./host.ts";
import { registerServicePump } from "./services.ts";
import type { ServiceClient, ServiceMessage } from "./service-client.ts";

/** Provider response: a frame-indexed stream the host presents on its video
 * plane (`videoOpen`, `videoTick`, `videoTexture`, `videoClose`). */
export interface MediaPlaying extends ServiceMessage {
  t: "playing"; stream: string; fps: number; position: number;
}
export type MediaServicePhase = "idle" | "playing" | "paused" | "ended" | "error";
export interface MediaServiceStatus {
  phase: MediaServicePhase;
  positionMs: number;
  presentedFrames: number;
  error: string;
}
const emptyStatus = (): MediaServiceStatus => ({ phase: "idle", positionMs: 0, presentedFrames: 0, error: "" });

/** A single playback lifetime over a companion-produced ring. Ring control
 * and end polls stay here; the host's video plane presents the frames. */
export function createMediaService(service: ServiceClient) {
  let active: MediaPlaying | undefined, snapshot = emptyStatus(), frame = 0, generation = 0;
  let busy = false;
  const listeners = new Set<(event: ServiceMessage) => void>();
  const emit = (event: ServiceMessage) => { for (const listener of listeners) listener(event); };
  const close = () => {
    generation++; busy = false;
    if (active) getOps().videoClose?.();
    active = undefined; snapshot = emptyStatus();
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
          active = source; snapshot = { ...emptyStatus(), phase: "playing", positionMs: source.position * 1000 };
          try {
            if (!service.openStream(source.stream)) throw new Error("Player unavailable. Retry playback.");
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
    texture: () => getOps().videoTexture?.() ?? -1,
    status: (): MediaServiceStatus => ({ ...snapshot }),
    dispose() { close(); unsubscribe(); stopPump(); listeners.clear(); },
  };
}
