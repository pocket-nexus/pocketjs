// PocketUI ui/mount.ts — a PocketUI tree on a PocketJS surface.
//
//   mountPocketUI({ children: () => <App /> })
//
// PocketUI is one native view the size of the surface it is on: the
// auxiliary surface when the build has one (a dual-screen handheld's touch
// screen), else the primary display. Everything under it is PocketUI's: the
// element tree, its layout, the pointer and the focus. Components inside read
// the surface with useUI().
//
// A surface can change size while the application runs (a window retiled
// beside another). The host's resize (host.ts onViewport, display.ts
// onAuxiliaryViewport) or a call of `ui.resize` lays the same tree out again
// at the new size and re-derives the Environment, so the idioms follow: a
// split becomes a stack and back with every pane's state in place. Nothing
// remounts.
import { catchError, createContext, createMemo, createRenderEffect, createSignal, getOwner, onCleanup, untrack, useContext, type Accessor, type JSX } from "solid-js";
import { animate, animationClass, jump } from "../../animation.ts";
import { SCREEN_H, SCREEN_W } from "../../../../contracts/spec/spec.ts";
import { AuxiliarySurface, View } from "../../components.ts";
import { auxiliaryViewport, hasAuxiliarySurface, onAuxiliaryViewport } from "../../display.ts";
import { getOps, hostViewport, onViewport } from "../../host.ts";
import { mount } from "../../index.ts";
import { onFrame } from "../../lifecycle.ts";
import { modality, surfaceHasTouch } from "../../modality.ts";
import { setProp, type NodeMirror } from "../../renderer.ts";
import { deriveEnvironment, resolveIdioms, type Environment, type Idioms, type SurfaceFacts } from "../core/env.ts";
import { CommandProvider, createCommandCenter, type CommandCenter } from "./commands.ts";
import { element, UIRoot, ZSTACK, type UINode } from "./engine.ts";
import { attachInput, type UIInput } from "./input.ts";
import { createTransferCenter, type TransferCenter } from "./transfer.ts";
import { DEFAULT_THEME } from "../themes/index.ts";
import type { Metrics, Theme } from "./theme.ts";

export interface UI {
  root: UIRoot;
  input: UIInput;
  /** what the surface can do; changes when it is resized */
  env: Accessor<Environment>;
  /** the idiom each of the application's semantics takes on this surface */
  idioms: Accessor<Idioms>;
  /** the active theme: a signal read */
  readonly theme: Theme;
  /** Paint the same tree in another theme. Nothing remounts: sizes that differ lay out again, the rest repaints. */
  setTheme(theme: Theme): void;
  /** rows and gutters for the surface's density */
  metric: Accessor<Metrics>;
  /** the surface, in points */
  size: Accessor<{ width: number; height: number }>;
  /** The host gave the surface a new size. */
  resize(width: number, height: number): void;
  /** frames since the UI mounted */
  frame(): number;
  commands: CommandCenter;
  /** moving things onto other things (ui/transfer.ts) */
  transfer: TransferCenter;
}

const UIContext = createContext<UI>();

/** The surface a component is drawn on. */
export function useUI(): UI {
  const ui = useContext(UIContext);
  if (!ui) throw new Error("PocketUI: useUI() outside <PocketUI>");
  return ui;
}

export interface PocketUIProps {
  children: () => UINode;
  /** the theme to start in (default the Pocket theme); ui.setTheme changes it */
  theme?: Theme;
  /** facts the build does not carry: a keyboard the host shows, run-time glyphs */
  facts?: Partial<SurfaceFacts>;
  /** an application's own choice of idiom, over what the surface would get */
  idioms?: Partial<Idioms>;
  /** the UI, once it is up */
  ready?: (ui: UI) => void;
  /** the surface it is drawn on (default: the auxiliary surface when the build has one, else the primary display) */
  surface?: "primary" | "auxiliary";
}

/** The logical size of a surface now. */
function surfaceSize(surface: "primary" | "auxiliary"): { width: number; height: number } {
  if (surface === "auxiliary") {
    const auxiliary = auxiliaryViewport();
    if (auxiliary) return { width: auxiliary.width, height: auxiliary.height };
  }
  const viewport = hostViewport(getOps());
  return { width: viewport?.w ?? SCREEN_W, height: viewport?.h ?? SCREEN_H };
}

/** Mount an application's PocketUI tree on its surface: the auxiliary surface when the build has one, else the primary display at its full size. Returns the function that unmounts it.
 *
 *  Given a function, it is called inside the mounted root before the tree is made: what an application starts there (run-time text, frame hooks, its state) has the root as its owner. */
export function mountPocketUI(setup: PocketUIProps | (() => PocketUIProps)): () => void {
  return mount(() => {
    const props = typeof setup === "function" ? setup() : setup;
    const surface = props.surface ?? (hasAuxiliarySurface() ? "auxiliary" : "primary");
    if (surface === "primary") return PocketUI({ ...props, surface });
    return AuxiliarySurface({
      get children() {
        return PocketUI({ ...props, surface });
      },
    });
  });
}

export function PocketUI(props: PocketUIProps): JSX.Element {
  const surface = props.surface ?? (hasAuxiliarySurface() ? "auxiliary" : "primary");
  const initial = surfaceSize(surface);
  const touch = surfaceHasTouch(surface);
  const [size, setSize] = createSignal({ width: initial.width, height: initial.height });
  // a host that takes text sessions shows a keyboard of its own (HostOps.textSession)
  const hostKeyboard = typeof getOps().textSession === "function";
  const env = createMemo<Environment>(() =>
    deriveEnvironment({
      width: size().width,
      height: size().height,
      touch,
      buttons: modality.buttons,
      pointer: modality.pointer === "pointer",
      keyboard: modality.text === "keyboard",
      analog: modality.analog,
      form: modality.form,
      hostKeyboard,
      motion: animationClass,
      ...props.facts,
    }),
  );
  const idioms = createMemo<Idioms>(() => ({ ...resolveIdioms(env()), ...props.idioms }));
  const first = props.theme ?? DEFAULT_THEME;
  let host!: NodeMirror;
  const view = View({
    ref: (node: NodeMirror) => {
      host = node;
    },
    style: { width: initial.width, height: initial.height, overflow: 1, bgColor: first.color.canvas },
    debugName: "PocketUI",
  });
  const root = new UIRoot(host, initial.width, initial.height, first);
  const metric = createMemo<Metrics>(() => (idioms().density === "compact" ? root.theme.compact : root.theme.metric));
  createRenderEffect(() => setProp(host, "style", { bgColor: root.theme.color.canvas }));
  // a pointer's press arrives as a contact (pointer.ts), so a surface with a pointer takes contacts too
  const input = attachInput(root, { surface, touch: touch || modality.pointer === "pointer", buttons: modality.buttons });
  let frames = 0;
  const ui: UI = {
    root,
    input,
    env,
    idioms,
    get theme() {
      return root.theme;
    },
    setTheme(theme) {
      if (theme === untrack(() => root.theme)) return;
      root.theme = theme;
      // the new look arrives over a moment, where the surface animates
      if (untrack(idioms).transition !== "cut") {
        jump(host, "opacity", 0.35);
        animate(host, "opacity", 1, { dur: 180, easing: "out" });
      }
    },
    metric,
    size,
    resize(width, height) {
      if (width === root.width && height === root.height) return;
      setProp(host, "style", { width, height });
      // AuxiliarySurface's own view was sized, and clips, at the surface's
      // first size (components.ts AuxiliarySurface): it follows too
      if (host.parent && host.parent.type === host.type) setProp(host.parent, "style", { width, height });
      setSize({ width, height });
      root.resize(width, height);
    },
    frame: () => frames,
    commands: undefined as unknown as CommandCenter,
    transfer: undefined as unknown as TransferCenter,
  };
  // the host's resize of the surface this tree is on
  onCleanup(surface === "auxiliary" ? onAuxiliaryViewport((width, height) => ui.resize(width, height)) : onViewport((width, height) => ui.resize(width, height)));
  ui.commands = createCommandCenter(ui);
  ui.transfer = createTransferCenter(ui);
  const owner = getOwner();
  const layer = root.addLayer(
    element(ZSTACK, {
      get children() {
        // An error in a component or in one of its effects is said aloud and the rest of the update
        // goes on. Left to rise, it would end the update it happened in without a word: a host
        // discards what a signal's setter throws out of a network callback, and every effect queued
        // behind the one that threw would silently not run.
        return catchError(() => provideUI(ui, props.children), (error) => console.error(`PocketUI: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)) as UINode;
      },
    }),
    owner,
  );
  onFrame((buttons: number) => {
    frames++;
    for (const hook of root.frameHooks) hook();
    input.frame(buttons);
    root.flush();
  });
  onCleanup(() => layer.remove());
  // the surface's UI, for a simulator's steps and a debugger: the last one mounted in the realm
  (globalThis as { __pocketUI?: UI }).__pocketUI = ui;
  props.ready?.(ui);
  return view;
}

/** `children` with the UI context of `ui`: for layers added outside the tree (ui/present.ts). */
export function provideUI(ui: UI, children: () => UINode): UINode {
  return UIContext.Provider({
    value: ui,
    get children() {
      return CommandProvider({
        value: ui.commands,
        get children() {
          return children();
        },
      });
    },
  });
}
