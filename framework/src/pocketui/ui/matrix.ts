// PocketUI ui/matrix.ts — a matrix code (a QR code) from its modules.
//
// What draws it is rectangles: each run of dark modules in a row is one
// native node. It is always dark on light with a light margin, whatever the
// theme: a camera has to read it.
import { createRenderEffect } from "solid-js";
import { createElement, detachNode, insertNode, setProp, type NodeMirror } from "../../renderer.ts";
import { Instance, type BoxProps, type Kind, type Size, type UIRoot } from "./engine.ts";

export interface MatrixProps extends BoxProps {
  /** one string a row, top to bottom: "1" a dark module, anything else a light one; no margin */
  rows: readonly string[];
  /** a module's side in points (default 3) */
  module?: number;
  /** light modules around the code (default 2) */
  margin?: number;
}

class MatrixInstance extends Instance {
  private marks: NodeMirror[] = [];
  private side = 0;

  constructor(private readonly matrixProps: MatrixProps, parent: Instance | null, root: UIRoot) {
    super(matrixProps, parent, root);
    createRenderEffect(() => {
      const props = this.matrixProps;
      const unit = props.module ?? 3;
      const margin = props.margin ?? 2;
      const rows = props.rows;
      const width = rows.reduce((most, row) => Math.max(most, row.length), 0);
      this.side = (Math.max(width, rows.length) + 2 * margin) * unit;
      let used = 0;
      const put = (x: number, y: number, w: number) => {
        let node = this.marks[used];
        if (!node) {
          node = createElement("view");
          insertNode(this.node, node);
          this.marks[used] = node;
        }
        setProp(node, "style", { posType: 1, hitPass: 1, insetL: (x + margin) * unit, insetT: (y + margin) * unit, width: w * unit, height: unit, bgColor: "#000000" });
        used++;
      };
      for (let y = 0; y < rows.length; y++) {
        const row = rows[y]!;
        for (let x = 0; x < row.length; ) {
          if (row[x] !== "1") {
            x++;
            continue;
          }
          let end = x;
          while (end < row.length && row[end] === "1") end++;
          put(x, y, end - x);
          x = end;
        }
      }
      while (this.marks.length > used) detachNode(this.node, this.marks.pop()!);
      this.invalidate();
    });
  }

  protected override paint(): void {
    super.paint();
    this.style({ bgColor: "#ffffff" });
  }

  protected measureContent(): Size {
    return { w: this.side, h: this.side };
  }

  override blocksHit(): boolean {
    return this.interactive;
  }
}

export const MATRIX: Kind<MatrixProps> = (props, parent, root) => new MatrixInstance(props, parent, root);
