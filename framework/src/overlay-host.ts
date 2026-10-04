// Optional in-process overlay channel. The host supplies state and ordered
// pointer events; the UI emits application commands without owning game state.
import { getOps } from "./host.ts";
import { registerServicePump } from "./services.ts";
import { desktopPointer, type PointerPacket, type DragPosition } from "./desktop-pointer.ts";
import type { NodeMirror } from "./renderer.ts";

export type { PointerPacket, DragPosition } from "./desktop-pointer.ts";
export const OVERLAY_SERVICE = "pocket.overlay";

export function connectOverlay<State, Command>(receive: (state: State) => void) {
  const ops = getOps();
  const pointer = desktopPointer();
  if (!ops.svcOpen?.(OVERLAY_SERVICE)) throw new Error("PocketJS overlay host is unavailable");
  const disposePump = registerServicePump(() => {
    const batch = ops.svcPoll?.();
    if (!batch) return;
    for (const line of batch.split("\n")) {
      if (!line.trim()) continue;
      // A malformed line (bad JSON or a shape the dispatch dereferences,
      // such as null or a pointer without an event) cannot break the frame:
      // throwing here would discard every later line in the already-drained
      // batch and starve pumps registered after this one. Mirrors the
      // per-line isolation in service-client.ts.
      try {
        const message = JSON.parse(line) as { type: string; value: State; event: PointerPacket };
        if (message.type === "state") receive(message.value);
        else if (message.type === "pointer") pointer.update(message.event);
      } catch { /* One malformed overlay line cannot break the frame. */ }
    }
  });
  return {
    control(name: string, node: NodeMirror) {
      ops.svcSend?.(JSON.stringify({ type: "pocket.overlay.control", name, node: node.id }));
      return () => ops.svcSend?.(JSON.stringify({ type: "pocket.overlay.control", name, node: node.id, remove:true }));
    },
    send(command: Command) { ops.svcSend?.(JSON.stringify(command)); },
    drag(node: NodeMirror, move: (position: DragPosition) => void) { return pointer.registerDrag(node, move); },
    cancel() { pointer.cancel(); },
    dispose() { pointer.cancel(); disposePump(); },
  };
}
