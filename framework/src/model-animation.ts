import { animate as nativeAnimate, jump as nativeJump, type AnimateOptions } from "./anim.ts";
import { getOps } from "./host.ts";
import { deliverModelResult, registerModelCommandHandler, type RequestId } from "./model-tasks.ts";
import type { PropName } from "../../contracts/spec/spec.ts";
import type { NodeSlot } from "./model-node-ref.ts";
export { createNodeRef, type NodeSlot } from "./model-node-ref.ts";
export type ModelAnimationResult = "ended" | "replaced" | "dropped";
const pending = new Map<number, RequestId>();

export function installModelAnimationCommands(): void { registerModelCommandHandler((region, op, args, request) => {
  if (op === "log") { console.log(...args); return; }
  if (op !== "animate" && op !== "jump") throw new Error(`Unknown model command ${op}`);
  const slot = region.refs.get(String(args[0])) as NodeSlot | undefined;
  const node = slot?.current;
  if (!node) { if (request) deliverModelResult(request, "dropped"); return; }
  if (op === "jump") { nativeJump(node, args[1] as PropName, args[2] as number); return; }
  if (request && !getOps().takeAnimationCompletions) throw new Error("Host lacks model animation completions; rebuild the host with Model AOT support");
  const id = nativeAnimate(node, args[1] as PropName, args[2] as number, args[3] as AnimateOptions | undefined);
  if (request) {
    if (id < 0) deliverModelResult(request, "dropped");
    else pending.set(id, request);
    return () => { pending.delete(id); };
  }
}); }
installModelAnimationCommands();

/** Called once at the input boundary, before readiness is frozen. */
export function pollModelAnimations(): void {
  if (!pending.size) return;
  const raw = getOps().takeAnimationCompletions?.();
  if (!raw) return;
  const completions = JSON.parse(raw) as [number, number][];
  for (const [id, reason] of completions) {
    const request = pending.get(id);
    if (!request) continue;
    pending.delete(id);
    deliverModelResult(request, reason === 0 ? "ended" : reason === 1 ? "replaced" : "dropped");
  }
}
