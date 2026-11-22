// PocketUI ui/present.ts — content over the application: a sheet, a menu, a
// dialog, a notice.
//
// A presentation is a layer of the root above the application's (engine.ts
// UIRoot.layers): a scrim that takes every contact outside the panel, and a
// panel. While it is up it owns the buttons: focus stays inside it, and back
// dismisses it and nothing under it.
//
// The caller says what it is presenting (`style`); the theme decides what
// that is here. A `menu` rises from the bottom edge as a sheet in one
// tradition and opens as a small window in another; a dialog has a title bar
// with a close box, or a heading; the panel's frame, the scrim behind it and
// whether opening it is a motion are the theme's parts and traits.
import { createRoot, getOwner, runWithOwner, type Owner } from "solid-js";
import { animate, jump } from "../../animation.ts";
import { BTN } from "../../input-api.ts";
import { caption } from "./caption.ts";
import { element, HSTACK, VSTACK, ZSTACK, type Instance, type Rect, type UIElement, type UINode } from "./engine.ts";
import { provideUI, type UI } from "./mount.ts";
import { TEXT } from "./textview.ts";

/** Something a task or a dialog can do, or its way out. */
export interface PresentAction {
  label: string;
  /** `primary` is the thing it is for; `destructive` is that, undone only by doing the opposite; `cancel` is the way out */
  role?: "primary" | "destructive" | "cancel";
  disabled?: boolean;
  /** what it does; a `cancel` without one dismisses the panel. The panel stays up: an action that ends it dismisses it */
  run?: () => void;
}

export interface PresentOptions {
  /** `sheet` is a task and `menu` a list of choices: each rises from the bottom edge at full width, or opens as a window in the middle, as the theme has it; `dialog` sits in the middle; `side` covers the trailing edge at full height; `popover` opens beside `anchor` */
  style?: "sheet" | "dialog" | "side" | "menu" | "popover";
  /** what it is called: a title bar where the theme's dialogs have one, a heading otherwise */
  title?: string;
  /** names the control that dismisses it beside a heading ("Cancel"); a title bar has its close box */
  closeLabel?: string;
  /** What it does and its way out, read again when they change (a label, `disabled`). The caller draws no buttons: the theme arranges these as a row of push buttons at the panel's foot, in its order and at its end, or as the way out beside the heading and the thing to do as one wide button under the content. Their number and roles do not change while it is up. */
  actions?: () => readonly PresentAction[];
  /** for `popover`: the rectangle it opens under, in the surface's coordinates */
  anchor?: Rect;
  /** the panel's width for `dialog`, `side` and `popover` (default 280; 200 for a popover) */
  width?: number;
  /** at most this tall (default 80% of the surface) */
  maxHeight?: number;
  /** a tap on the scrim or back dismisses it (default true) */
  dismissable?: boolean;
  onDismiss?: () => void;
}

export interface Presentation {
  dismiss(): void;
  readonly open: boolean;
}

/** Put `content` over the application. */
export function present(ui: UI, content: () => UINode, options: PresentOptions = {}, owner: Owner | null = getOwner()): Presentation {
  const traits = ui.theme.traits;
  const asked = options.style ?? "sheet";
  // what the theme makes of a sheet or a menu is fixed when it opens
  const style = asked === "menu" || asked === "sheet" ? (traits.sheets === "window" ? "dialog" : "sheet") : asked;
  const cut = ui.idioms().transition === "cut" || traits.motion === "cut";
  let open = true;
  let panel: Instance | undefined;
  let removeButtons: (() => void) | undefined;
  let previousTrap: Instance | null = null;
  let previousFocus: Instance | null = null;
  // eslint-disable-next-line prefer-const
  let layer: { instance: Instance; remove(): void };
  const dismiss = (): void => {
    if (!open) return;
    open = false;
    removeButtons?.();
    ui.input.trap = previousTrap;
    if (previousFocus?.placed) ui.input.focus(previousFocus, ui.input.focusVisible());
    options.onDismiss?.();
    if (cut || !panel) {
      layer.remove();
      return;
    }
    const node = panel.node;
    if (style === "side") animate(node, "translateX", panel.w, { dur: 120, easing: "in" });
    else if (style === "sheet") animate(node, "translateY", panel.h, { dur: 120, easing: "in" });
    else animate(node, "translateY", style === "popover" ? -6 : 12, { dur: 120, easing: "in" });
    animate(layer.instance.node, "opacity", 0, { dur: 120 });
    let frames = 9;
    const wait = () => {
      if (--frames > 0) return;
      ui.root.frameHooks.delete(wait);
      layer.remove();
    };
    ui.root.frameHooks.add(wait);
  };
  const size = ui.size();
  const anchor = options.anchor;
  const width = style === "sheet" ? size.width : Math.min(options.width ?? (style === "popover" ? 200 : asked === "sheet" ? 340 : 280), size.width - 16);
  const left = anchor ? Math.max(4, Math.min(Math.round(anchor.x), size.width - width - 4)) : 0;
  const top = anchor ? Math.round(anchor.y + anchor.h) : 0;
  const maxHeight = options.maxHeight ?? (style === "popover" ? Math.max(60, size.height - top - 4) : Math.round(size.height * (style === "sheet" ? 0.82 : 0.9)));
  const titled = options.title !== undefined && options.title !== "";
  // made once: a change of theme repaints the panel around the same content
  const body = element(VSTACK, {
    name: "panel.body",
    part: "dialog.body",
    get variant() {
      return style;
    },
    // a panel as tall as its content; only the one that covers an edge fills it
    grow: style === "side" ? 1 : 0,
    get children() {
      return provideUI(ui, content);
    },
  });
  // --- what it does: the actions, arranged by the theme -----------------------
  const actions = options.actions;
  const roles = actions ? actions().map((action) => action.role ?? "primary") : [];
  const cancelAt = roles.indexOf("cancel");
  const cancelAction = () => (actions && cancelAt >= 0 ? actions()[cancelAt] : undefined);
  const closeLabel = options.closeLabel ?? cancelAction()?.label;
  /** a row of push buttons at the foot: a dialog's always, a task's where the theme has it so */
  const footer = () => asked === "dialog" || ui.theme.traits.actions === "footer";
  const actionButton = (index: number, wide: boolean): UIElement =>
    element(HSTACK, {
      name: `panel.action.${index}`,
      part: "button",
      variant: roles[index] === "cancel" ? "tinted" : "filled",
      tone: roles[index] === "destructive" ? "bad" : undefined,
      justify: "center",
      autoFocus: roles[index] !== "cancel",
      grow: wide ? 1 : 0,
      get minHeight() {
        return ui.metric().control;
      },
      get minWidth() {
        return wide ? undefined : ui.metric().buttonMin;
      },
      get disabled() {
        return actions!()[index]?.disabled === true;
      },
      onPress: () => {
        const action = actions!()[index];
        if (action?.run) action.run();
        else dismiss();
      },
      children: element(TEXT, { lines: 1, get value() { return actions!()[index]?.label ?? ""; } }) as UINode,
    });
  const foot = actions
    ? element(HSTACK, {
        name: "panel.actions",
        padding: [8, 14, 12, 14],
        spacing: 10,
        get justify() {
          return footer() ? (ui.theme.traits.dialogButtons === "center" ? ("center" as const) : ("end" as const)) : ("start" as const);
        },
        get children() {
          const order = roles.map((_, index) => index);
          if (footer()) {
            // the way out and the thing to do, in the order the tradition has them
            const last = ui.theme.traits.defaultLast;
            order.sort((a, b) => (roles[a] === "cancel" ? 0 : 1) - (roles[b] === "cancel" ? 0 : 1));
            if (!last) order.reverse();
            return order.map((index) => actionButton(index, false)) as UINode;
          }
          // the way out is beside the heading: here, the thing to do, as wide as the panel
          return order.filter((index) => roles[index] !== "cancel").map((index) => actionButton(index, true)) as UINode;
        },
      })
    : null;
  const bar = titled
    ? caption(ui, { part: "dialog.caption", title: () => options.title!, close: options.dismissable === false ? undefined : () => dismiss })
    : null;
  const heading = titled
    ? element(HSTACK, {
        part: "menu.title",
        variant: asked,
        get hidden() {
          return ui.theme.traits.dialogCaption;
        },
        children: [
          // a menu's heading is set as a section's is; a task's or a dialog's is its title
          element(TEXT, { grow: 1, lines: asked === "menu" ? 1 : 2, get value() { return ui.theme.traits.sectionCaps && asked === "menu" ? options.title!.toUpperCase() : options.title!; }, role: asked === "menu" ? undefined : ("title" as const), tone: asked === "menu" ? undefined : ("plain" as const) }),
          closeLabel ? element(TEXT, { name: "panel.close", value: closeLabel, role: "strong", tone: "accent", lines: 1, padding: [2, 4], alignSelf: "center", get hidden() { return footer(); }, onPress: () => (cancelAction()?.run ?? dismiss)() }) : null,
        ].filter((entry) => entry !== null) as UINode,
      })
    : null;
  if (bar) (bar.props as { hidden?: boolean }) = Object.defineProperty(bar.props as object, "hidden", { get: () => !ui.theme.traits.dialogCaption, enumerable: true, configurable: true }) as never;
  const panelElement: UIElement = element(VSTACK, {
    name: "panel",
    part: style === "sheet" ? "sheet" : style === "popover" ? "menu" : "dialog",
    get variant() {
      return asked;
    },
    anchor: style === "sheet" ? "bottom" : style === "side" ? "trailing" : style === "popover" ? "topLeading" : "center",
    width: style === "sheet" ? "fill" : width,
    height: style === "side" ? "fill" : undefined,
    maxHeight: style === "side" ? undefined : maxHeight,
    clip: true,
    // a contact on the panel is not a contact on the scrim
    onPress: () => {},
    focusable: false,
    ref: (instance: Instance) => {
      panel = instance;
    },
    children: [bar, heading, body, foot].filter((entry) => entry !== null) as UINode,
  });
  const layerElement: UIElement = element(ZSTACK, {
    name: "presentation",
    children: [
      element(VSTACK, {
        name: "scrim",
        part: "scrim",
        get variant() {
          return style;
        },
        onPress: options.dismissable === false ? () => {} : dismiss,
        focusable: false,
      }),
      style === "popover" ? element(ZSTACK, { padding: [top, 0, 0, left], children: panelElement as UINode }) : panelElement,
    ] as UINode,
  });
  layer = runWithOwner(owner, () => createRoot(() => ui.root.addLayer(layerElement, getOwner())))!;
  previousTrap = ui.input.trap;
  previousFocus = ui.input.focused();
  ui.input.trap = layer.instance;
  if (ui.input.focusVisible()) ui.input.focus(null, true);
  removeButtons = ui.input.onButton((button) => {
    if (button & BTN.CROSS && options.dismissable !== false) dismiss();
    // a presentation owns the buttons: nothing under it hears them
    return true;
  });
  if (!cut && panel) {
    // the first layout has not run: the offset is a fixed rise, not the panel's height
    const node = panel.node;
    jump(layer.instance.node, "opacity", 0);
    animate(layer.instance.node, "opacity", 1, { dur: 140 });
    if (style === "side") {
      jump(node, "translateX", 60);
      animate(node, "translateX", 0, { dur: 160, easing: "out" });
    } else {
      jump(node, "translateY", style === "sheet" ? 60 : style === "popover" ? -6 : 12);
      animate(node, "translateY", 0, { dur: 160, easing: "out" });
    }
  }
  // focus lands in the panel when a button opened it, or the focus was showing
  if (ui.idioms().focus && (ui.input.focusVisible() || ui.input.byPad())) {
    const land = () => {
      ui.root.afterLayout.delete(land);
      if (open) ui.input.move("down");
    };
    ui.root.afterLayout.add(land);
  }
  return {
    dismiss,
    get open() {
      return open;
    },
  };
}
