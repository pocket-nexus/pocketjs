// @pocketjs/framework/game2d — the camera: a window onto world space.
//
// Layers inside a camera draw in world coordinates. Moving the camera sets the translation of one
// container view per parallax factor, so a frame in which the world scrolls costs one or two
// native calls however much is on screen, and a static layer inside it never draws again.

import { onCleanup, type JSX } from "solid-js";
import { View } from "../components.ts";
import { getOps } from "../index.ts";
import type { NodeMirror } from "../index.ts";
import { PROP } from "../../../contracts/spec/spec.ts";

export interface CameraConfig { width: number; height: number }

export interface Camera {
  /** World position of the screen's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** Place the camera; positions round to whole pixels. */
  move(x: number, y: number): void;
  /** The screen window. Children draw in world space; `parallax` scales the camera's motion for
   *  this group (0.5 scrolls at half speed, 0 stays on screen). Default 1. */
  View(props: { parallax?: number; children?: JSX.Element }): JSX.Element;
}

const P_TX = PROP.translateX, P_TY = PROP.translateY;
// Half up, and the same for every integer shift: round(v + k) === round(v) + k. Rounding in world
// space and in screen space then agree, so a sprite does not move a pixel as it crosses an edge.
const round = (v: number) => ((v | 0) === v ? v : ((v + 32768.5) | 0) - 32768);

interface Group { node: NodeMirror | undefined; factor: number; tx: number; ty: number }

export function createCamera(cfg: CameraConfig): Camera {
  const groups: Group[] = [];
  let cx = 0, cy = 0;
  const ops = () => getOps() as unknown as { setProp(id: number, prop: number, value: number): void };
  const place = (g: Group) => {
    if (!g.node) return;
    const tx = -round(cx * g.factor), ty = -round(cy * g.factor);
    if (tx !== g.tx) { g.tx = tx; ops().setProp(g.node.id, P_TX, tx); }
    if (ty !== g.ty) { g.ty = ty; ops().setProp(g.node.id, P_TY, ty); }
  };
  const box = { width: cfg.width, height: cfg.height };
  const camera: Camera = {
    get x() { return cx; },
    get y() { return cy; },
    move(x, y) {
      if (x === cx && y === cy) return;
      cx = x; cy = y;
      for (let i = 0; i < groups.length; i++) place(groups[i]);
    },
    View(props) {
      const g: Group = { node: undefined, factor: props.parallax ?? 1, tx: 0, ty: 0 };
      groups.push(g);
      onCleanup(() => { const i = groups.indexOf(g); if (i >= 0) groups.splice(i, 1); });
      return (
        <View class="absolute left-0 top-0 overflow-hidden" style={box}>
          <View class="absolute left-0 top-0" style={box} ref={(n: NodeMirror) => { g.node = n; place(g); }}>{props.children}</View>
        </View>
      );
    },
  };
  return camera;
}
