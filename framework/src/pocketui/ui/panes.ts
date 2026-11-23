// PocketUI ui/panes.ts — list, detail and inspector, on whatever the surface
// has room for.
//
// An application has three panes that relate as a list, the thing picked
// from it, and facts about that thing. It says which exist now (`depth`: 0
// the list alone, 1 a detail is open, 2 its inspector too). The surface's
// `panes` idiom decides how they share the screen:
//
//   stack    one pane at a time, the deepest open one; Back closes it
//            (ui/deck.ts carries the motion between two)
//   split    the list beside the detail; the inspector slides over the
//            detail's trailing part
//   triple   three columns
//
// The three panes are the same three instances in every idiom. When the
// surface changes size and the idiom with it, they are placed again and
// nothing remounts: a transcript keeps its place, a draft its caret, a list
// its offset. That is what lets a window be retiled mid-task.
import { createRenderEffect } from "solid-js";
import { setProp } from "../../renderer.ts";
import { animate, jump } from "../../animation.ts";
import { DeckInstance, type DeckProps } from "./deck.ts";
import type { Instance, Kind, UIRoot } from "./engine.ts";
import { REST } from "./theme.ts";

export interface PanesProps extends DeckProps {
  /** how the panes share the surface */
  idiom: "stack" | "split" | "triple";
  /** the list's width where it has a column (default 200) */
  listWidth?: number;
  /** the inspector's width where it has a column or slides over (default 220) */
  inspectorWidth?: number;
  /** where the inspector starts, from the top, when it slides over the detail: under the panes' bars */
  inspectorTop?: number;
  /** the colour of the 1-point rule between columns */
  rule?: string;
}

class PanesInstance extends DeckInstance {
  private idiom: PanesProps["idiom"] = "stack";
  private lastIdiom: PanesProps["idiom"] | null = null;
  private visible: Instance[] = [];
  private inspectorShown = false;

  constructor(private readonly panesProps: PanesProps, parent: Instance | null, root: UIRoot) {
    super(panesProps, parent, root);
    createRenderEffect(() => {
      this.idiom = panesProps.idiom;
      void panesProps.listWidth;
      void panesProps.inspectorWidth;
      void panesProps.inspectorTop;
      this.invalidate();
    });
    createRenderEffect(() => this.style({ bgColor: panesProps.rule ?? root.theme.paint("divider", { ...REST, variant: "panes" }).fill ?? root.theme.color.line }));
  }

  protected override mode(): NonNullable<DeckProps["transition"]> {
    return this.deckProps.transition ?? "animate";
  }

  private widths(w: number): { list: number; inspector: number } {
    const list = Math.min(this.panesProps.listWidth ?? 200, Math.round(w * 0.4));
    const inspector = Math.min(this.panesProps.inspectorWidth ?? 220, Math.round((w - list) * 0.7));
    return { list, inspector };
  }

  protected override go(index: number): void {
    if (this.idiom === "stack") return super.go(index);
    this.shown = index;
    this.invalidate();
    this.root.schedule();
  }

  protected override park(): void {
    if (this.idiom === "stack") return super.park();
  }

  protected override arrange(w: number, h: number): void {
    const list = this.list;
    const idiom = this.idiom;
    if (idiom === "stack") {
      if (this.lastIdiom !== "stack") {
        // from columns back to one pane: nothing is mid-transition
        this.settling = 0;
        for (const child of list) setProp(child.node, "style", { zIndex: 0 });
      }
      this.lastIdiom = idiom;
      return super.arrange(w, h);
    }
    const { list: listW, inspector: inspectorW } = this.widths(w);
    const [first, detail, inspector] = list;
    const open = this.shown >= 2 && inspector !== undefined;
    const third = idiom === "triple" && open ? inspectorW + 1 : 0;
    if (first) {
      first.place(0, 0, listW, h);
      jump(first.node, "translateX", 0);
      jump(first.node, "opacity", 1);
      setProp(first.node, "style", { zIndex: 0 });
    }
    if (detail) {
      detail.place(listW + 1, 0, Math.max(0, w - listW - 1 - third), h);
      jump(detail.node, "translateX", 0);
      jump(detail.node, "opacity", 1);
      setProp(detail.node, "style", { zIndex: 0 });
    }
    if (inspector) {
      // over the detail it is a panel under the bars, which stay in reach; as a column it is a pane like the others
      const top = idiom === "split" ? Math.min(h, this.panesProps.inspectorTop ?? 0) : 0;
      inspector.place(w - inspectorW, top, inspectorW, h - top);
      setProp(inspector.node, "style", { zIndex: 3 });
      const cut = this.mode() === "cut" || this.lastIdiom !== idiom || idiom === "triple";
      if (open !== this.inspectorShown || this.lastIdiom !== idiom) {
        if (cut) {
          jump(inspector.node, "translateX", open ? 0 : inspectorW + 8);
          jump(inspector.node, "opacity", open ? 1 : 0);
        } else if (open) {
          jump(inspector.node, "opacity", 1);
          jump(inspector.node, "translateX", inspectorW);
          animate(inspector.node, "translateX", 0, { dur: 200, easing: "out" });
        } else animate(inspector.node, "translateX", inspectorW + 8, { dur: 160, easing: "in" });
        this.inspectorShown = open;
      }
    }
    this.lastIdiom = idiom;
  }

  override kids(): readonly Instance[] {
    if (this.idiom === "stack") return super.kids();
    const [first, detail, inspector] = this.list;
    this.visible.length = 0;
    if (first) this.visible.push(first);
    if (detail) this.visible.push(detail);
    if (inspector && this.shown >= 2) this.visible.push(inspector);
    return this.visible;
  }

  override claimPan(dx: number, dy: number) {
    return this.idiom === "stack" ? super.claimPan(dx, dy) : null;
  }
}

export const PANES: Kind<PanesProps> = (props, parent, root) => new PanesInstance(props, parent, root);
