// A desktop pointer feeds the existing focus/onPress authority. It keeps a
// press owner through release; moving onto another control cannot activate it.
import { focusNode, hitFocusable, hitNode, pressNode, setActiveNode } from "./input.ts";
import type { NodeMirror } from "./renderer.ts";

export type PointerPacket =
  | { kind: "move"; x: number | null; y: number | null }
  | { kind: "button"; x: number | null; y: number | null; down: boolean }
  | { kind: "cancel" };
export interface DragPosition { x: number; y: number; dx: number; dy: number; started: boolean }
export interface PointerAuthority<Node> {
  hit(x: number, y: number): Node | null;
  rawHit(x: number, y: number): Node | null;
  parent(node: Node): Node | null;
  focus(node: Node): void;
  active(node: Node | null): void;
  press(node: Node): void;
}

export function createPointerController<Node>(authority: PointerAuthority<Node>) {
  const drags = new Map<Node, (position: DragPosition) => void>();
  let owner: Node | null = null;
  let drag: ((position: DragPosition) => void) | undefined;
  let down = false;
  let startX = 0, startY = 0;
  return {
    registerDrag(node: Node, move: (position: DragPosition) => void): () => void {
      drags.set(node, move);
      return () => { drags.delete(node); if (drag === move) this.cancel(); };
    },
    cancel() { owner = null; drag = undefined; down = false; authority.active(null); },
    update(packet: PointerPacket) {
      if (packet.kind === "cancel") { this.cancel(); return; }
      const valid = packet.x !== null && packet.y !== null && Number.isFinite(packet.x) && Number.isFinite(packet.y);
      const hit = valid ? authority.hit(packet.x!, packet.y!) : null;
      if (packet.kind === "move") {
        if (down && drag && valid) {
          drag({ x: packet.x!, y: packet.y!, dx: packet.x! - startX, dy: packet.y! - startY, started:false });
        } else if (down) authority.active(hit === owner ? owner : null);
        else if (hit) authority.focus(hit);
        return;
      }
      if (packet.down) {
        if (down) return;
        down = true;
        owner = hit;
        startX = packet.x ?? 0; startY = packet.y ?? 0;
        // A focusable child (caption close button) owns its click before an
        // ancestor's drag region can claim it.
        if (hit) { authority.focus(hit); authority.active(hit); }
        else if (valid) {
          let node = authority.rawHit(packet.x!, packet.y!);
          while (node) { if (drags.has(node)) { drag = drags.get(node); drag?.({x:startX,y:startY,dx:0,dy:0,started:true}); break; } node = authority.parent(node); }
        }
      } else {
        const activate = down && !drag && owner !== null && owner === hit;
        const target = owner;
        this.cancel();
        if (activate) authority.press(target!);
      }
    },
  };
}

export function desktopPointer() {
  return createPointerController<NodeMirror>({
    hit: hitFocusable, rawHit: hitNode, parent: n => n.parent,
    focus: focusNode, active: setActiveNode, press: pressNode,
  });
}
