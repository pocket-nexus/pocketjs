// The compact app frame: a status bar, a stack of scenes in the body, a
// hint bar, and the dialog and toast layers over them. One scene is the
// top; it alone hears navigation (input.ts scopes), and its title and
// hints fill the two bars. Scenes below stay mounted with their state and
// read `useSceneActive()` to pause their polling.

import { batch, createContext, createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, useContext, type Accessor, type JSX } from "solid-js";
import { ENUMS } from "../../../contracts/spec/spec.ts";
import { after } from "../clock.ts";
import { Text, View } from "../primitives.ts";
import type { TextEvent } from "../text-input.ts";
import { GLOBAL_SCOPE, installCompactInput, onKeyIn, onNavIn, setActiveScope, type NavHandler, KEY_LABEL } from "./input.ts";
import { arrive, FADES, MOTION, slideIn, slideOut } from "./motion.ts";
import type { NodeMirror } from "../renderer.ts";
import { animate, jump } from "../anim.ts";
import { measure, wrap } from "./text.ts";
import { BODY_H, BODY_Y, BUTTON_H, COLOR, GUTTER, HINT_H, LINE, SCREEN, SLOT, STATUS_H, TOAST_S, TONE_COLOR, type Tone } from "./tokens.ts";

export interface SceneDef {
  /** The status bar's title while the scene is top. */
  title: string;
  /** The hint bar's text while the scene is top; `useHints` changes it. */
  hints?: string;
  render: () => JSX.Element;
}

interface Entry {
  id: number;
  def: SceneDef;
  title: Accessor<string>;
  setTitle: (title: string) => void;
  hints: Accessor<string>;
  setHints: (hints: string) => void;
  /** Sliding out after a pop; removed when the slide ends. */
  leaving: Accessor<boolean>;
  setLeaving: (leaving: boolean) => void;
}

export interface Scenes {
  push(scene: SceneDef): void;
  /** False at the root. */
  pop(): boolean;
  replace(scene: SceneDef): void;
  popToRoot(): void;
  depth(): number;
}

interface Modal {
  title: string;
  text: string;
  action: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

interface Toast {
  text: string;
  tone: Tone;
  id: number;
}

interface Frame {
  scenes: Scenes;
  entries: Accessor<Entry[]>;
  topId: Accessor<number>;
  modal: Accessor<Modal | null>;
  setModal: (modal: Modal | null) => void;
  toast: Accessor<Toast | null>;
  setToast: (toast: Toast | null) => void;
}

const SceneContext = createContext<Entry | null>(null);
let frame: Frame | null = null;
let nextId = 1;

function current(): Frame {
  if (!frame) throw new Error("CompactApp is not mounted");
  return frame;
}

function makeEntry(def: SceneDef): Entry {
  const [title, setTitle] = createSignal(def.title);
  const [hints, setHints] = createSignal(def.hints ?? "");
  const [leaving, setLeaving] = createSignal(false);
  return { id: nextId++, def, title, setTitle, hints, setHints, leaving, setLeaving };
}

/** The scene stack of the mounted app. */
export function useScenes(): Scenes {
  return current().scenes;
}

/** True while this scene is the top and no dialog is open. */
export function useSceneActive(): Accessor<boolean> {
  const entry = useContext(SceneContext);
  const f = current();
  return createMemo(() => (entry ? f.topId() === entry.id : true) && f.modal() === null);
}

function scopeOf(): number | string {
  return useContext(SceneContext)?.id ?? GLOBAL_SCOPE;
}

/** Hear navigation while this scene is top. */
export function useNav(handler: NavHandler): void {
  onCleanup(onNavIn(scopeOf(), handler));
}

/** Hear raw keys while this scene is top, before navigation reads them. */
export function useKey(handler: (event: TextEvent) => boolean | void): void {
  onCleanup(onKeyIn(scopeOf(), handler));
}

/** The hint bar's text for this scene: a string, or an accessor followed
 *  while the scene is mounted. */
export function useHints(hints: string | Accessor<string>): void {
  const entry = useContext(SceneContext);
  if (!entry) return;
  if (typeof hints === "string") entry.setHints(hints);
  else createMemo(() => entry.setHints(hints()));
}

/** The status bar's title for this scene. */
export function useTitle(title: string | Accessor<string>): void {
  const entry = useContext(SceneContext);
  if (!entry) return;
  if (typeof title === "string") entry.setTitle(title);
  else createMemo(() => entry.setTitle(title()));
}

let toastId = 0;
/** A short line at the bottom right for TOAST_S seconds. */
export function toast(text: string, tone: Tone = "ink"): void {
  const f = current();
  const id = ++toastId;
  f.setToast({ text, tone, id });
  after(TOAST_S, () => {
    if (f.toast()?.id === id) f.setToast(null);
  });
}

export interface ConfirmOptions {
  title: string;
  text: string;
  /** The verb on the right button. */
  action: string;
  /** A destructive action: the button is pink, and Cancel is chosen first. */
  danger?: boolean;
}

/** A two-button dialog. Resolves true when the action is chosen. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  const f = current();
  return new Promise(resolve => {
    f.setModal({ title: options.title, text: options.text, action: options.action, danger: options.danger ?? false, resolve });
  });
}

export interface CompactAppProps {
  root: SceneDef;
  /** The status bar's right-hand text: the glance values. */
  glance?: () => string;
  /** Back at the root: asked with this dialog, then `onExit`. */
  exit?: { title: string; text: string; action: string; run: () => void };
}

export function CompactApp(props: CompactAppProps): JSX.Element {
  installCompactInput();
  const [entries, setEntries] = createSignal<Entry[]>([makeEntry(props.root)]);
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [toastValue, setToast] = createSignal<Toast | null>(null);
  // The scenes that stay: a popped scene slides out and then leaves the list.
  const staying = createMemo(() => entries().filter(entry => !entry.leaving()));
  const topId = createMemo(() => staying()[staying().length - 1]?.id ?? 0);
  const retire = (leaving: Entry[]) => {
    if (leaving.length === 0) return;
    for (const entry of leaving) entry.setLeaving(true);
    after(MOTION.scene / 1000, () => setEntries(list => list.filter(entry => !leaving.includes(entry))));
  };
  const scenes: Scenes = {
    push: scene => setEntries(list => [...list, makeEntry(scene)]),
    pop: () => {
      const current = staying();
      if (current.length <= 1) return false;
      retire([current[current.length - 1]!]);
      return true;
    },
    replace: scene => {
      const current = staying();
      retire(current.slice(-1));
      setEntries(list => [...list, makeEntry(scene)]);
    },
    popToRoot: () => retire(staying().slice(1)),
    depth: () => staying().length,
  };
  frame = { scenes, entries, topId, modal, setModal, toast: toastValue, setToast };
  onCleanup(() => {
    if (frame?.scenes === scenes) frame = null;
  });

  // The scope that hears input: the dialog, else the top scene.
  createMemo(() => setActiveScope(modal() ? "modal" : topId()));

  // Back a scene did not take pops it; at the root it asks to leave. Home
  // pops to the root.
  onCleanup(
    onNavIn(GLOBAL_SCOPE, event => {
      if (modal()) return;
      if (event.key === "home") {
        scenes.popToRoot();
        return true;
      }
      if (event.key === "back") {
        if (staying().length > 1) {
          scenes.pop();
          return true;
        }
        if (props.exit) {
          const exit = props.exit;
          void confirm({ title: exit.title, text: exit.text, action: exit.action }).then(ok => {
            if (ok) exit.run();
          });
          return true;
        }
      }
      return;
    }),
  );

  const top = createMemo(() => staying()[staying().length - 1]);
  const hints = () => {
    const m = modal();
    if (m) return `${KEY_LABEL.leftright} choose   ${KEY_LABEL.ok} ${m.action}   ${KEY_LABEL.back} cancel`;
    return top()?.hints() ?? "";
  };

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#171226]">
      <StatusBar title={() => top()?.title() ?? ""} glance={props.glance} />
      <For each={entries()}>
        {(entry, index) => {
          // A pushed scene slides in from the right over the one below; a
          // popped one slides back out. The root appears in place. Scenes
          // under the top two are hidden, with their state.
          let frame: NodeMirror | undefined;
          const shown = () => {
            const list = entries();
            const at = index();
            return at >= list.length - 2 || entry.leaving();
          };
          createEffect(() => {
            if (!frame) return;
            if (entry.leaving()) slideOut(frame, SCREEN.w);
          });
          return (
            <SceneContext.Provider value={entry}>
              <View
                ref={node => {
                  frame = node;
                  if (index() > 0) slideIn(node, SCREEN.w);
                }}
                class="absolute left-0 w-[320] overflow-hidden bg-[#171226]"
                style={{ insetT: BODY_Y, height: BODY_H, display: shown() ? ENUMS.Display.Flex : ENUMS.Display.None }}
              >
                {/* Untracked: a signal a scene reads while it sets up must not
                    make the frame build the scene again. */}
                {untrack(() => entry.def.render())}
              </View>
            </SceneContext.Provider>
          );
        }}
      </For>
      <HintBar text={hints} />
      <Show when={toastValue()} keyed>
        {value => <ToastView toast={value} />}
      </Show>
      <Show when={modal()} keyed>
        {value => <DialogView modal={value} close={() => setModal(null)} />}
      </Show>
    </View>
  );
}

function StatusBar(props: { title: () => string; glance?: () => string }): JSX.Element {
  const glance = () => props.glance?.() ?? "";
  const glanceWidth = () => Math.ceil(measure(glance(), SLOT.tiny));
  return (
    <View class="absolute left-0 top-0 w-[320] bg-[#1c1630]" style={{ height: STATUS_H }}>
      <Text class="absolute text-xs font-bold leading-[18] text-[#fcf6ff]" style={{ insetL: GUTTER, insetT: 0 }}>
        {props.title()}
      </Text>
      <Text class="absolute text-2xs leading-[18] text-[#8e80ac]" style={{ insetL: SCREEN.w - GUTTER - glanceWidth(), insetT: 0 }}>
        {glance()}
      </Text>
      <View class="absolute left-0 w-[320] h-[1] bg-[#2b2148]" style={{ insetT: STATUS_H - 1 }} />
    </View>
  );
}

function HintBar(props: { text: () => string }): JSX.Element {
  return (
    <View class="absolute left-0 w-[320]" style={{ insetT: SCREEN.h - HINT_H, height: HINT_H }}>
      <View class="absolute left-0 top-0 w-[320] h-[1] bg-[#2b2148]" />
      <Text class="absolute text-2xs leading-[15] text-[#8e80ac]" style={{ insetL: GUTTER, insetT: 1 }}>
        {props.text()}
      </Text>
    </View>
  );
}

function ToastView(props: { toast: Toast }): JSX.Element {
  const width = Math.min(SCREEN.w - 2 * GUTTER, Math.ceil(measure(props.toast.text, SLOT.xsBold)) + 16);
  return (
    <View ref={node => arrive(node, 8, MOTION.toast)} class="absolute rounded-md bg-[#2b2148] border-[#3a2d5c] border" style={{ insetL: SCREEN.w - GUTTER - width, insetT: SCREEN.h - HINT_H - BUTTON_H - 6, width, height: BUTTON_H }}>
      <Text class="absolute left-0 top-0 text-xs font-bold leading-[16] text-center" style={{ width, textColor: TONE_COLOR[props.toast.tone] }}>
        {props.toast.text}
      </Text>
    </View>
  );
}

function DialogView(props: { modal: Modal; close: () => void }): JSX.Element {
  const [choice, setChoice] = createSignal(props.modal.danger ? 0 : 1);
  const width = 260;
  const inner = width - 24;
  const titleLines = wrap(props.modal.title, SLOT.smBold, inner);
  const lines = wrap(props.modal.text, SLOT.xs, inner);
  const height = 10 + titleLines.length * LINE.sm + 4 + lines.length * LINE.xs + 10 + BUTTON_H + 10;
  const top = Math.round((SCREEN.h - HINT_H - height) / 2);
  const cancelW = Math.ceil(measure("Cancel", SLOT.xsBold)) + 20;
  const actionW = Math.ceil(measure(props.modal.action, SLOT.xsBold)) + 20;
  const finish = (ok: boolean) => {
    batch(() => {
      props.close();
      props.modal.resolve(ok);
    });
  };
  onCleanup(
    onNavIn("modal", event => {
      switch (event.key) {
        case "left":
        case "right":
        case "up":
        case "down":
          setChoice(choice() ? 0 : 1);
          return true;
        case "ok":
          finish(choice() === 1);
          return true;
        case "back":
          finish(false);
          return true;
        default:
          return true;
      }
    }),
  );
  const accent = props.modal.danger ? COLOR.warn : COLOR.accent;
  const veil = (node: NodeMirror) => {
    if (!FADES) return;
    jump(node, "opacity", 0);
    animate(node, "opacity", 1, { dur: MOTION.toast, easing: "out" });
  };
  return (
    <View ref={veil} class="absolute left-0 top-0 w-[320] h-[170] bg-[#000000a0]">
      <View ref={node => arrive(node, 6, MOTION.toast)} class="absolute rounded-lg bg-[#231b3b] border-[#3a2d5c] border" style={{ insetL: (SCREEN.w - width) / 2, insetT: top, width, height }}>
        <Text class="absolute text-sm font-bold leading-[16] text-[#fcf6ff]" style={{ insetL: 12, insetT: 10 }}>
          {titleLines.join("\n")}
        </Text>
        <Text class="absolute text-xs leading-[14] text-[#cbbde2]" style={{ insetL: 12, insetT: 14 + titleLines.length * LINE.sm }}>
          {lines.join("\n")}
        </Text>
        <View class="absolute rounded-md" style={{ insetL: width - 12 - actionW - 6 - cancelW, insetT: height - 10 - BUTTON_H, width: cancelW, height: BUTTON_H, bgColor: choice() === 0 ? COLOR.accent : COLOR.raised }}>
          <Text class="absolute left-0 top-0 text-xs font-bold leading-[18] text-center" style={{ width: cancelW, textColor: choice() === 0 ? COLOR.accentInk : COLOR.ink }}>
            Cancel
          </Text>
        </View>
        <View class="absolute rounded-md" style={{ insetL: width - 12 - actionW, insetT: height - 10 - BUTTON_H, width: actionW, height: BUTTON_H, bgColor: choice() === 1 ? accent : COLOR.raised }}>
          <Text class="absolute left-0 top-0 text-xs font-bold leading-[18] text-center" style={{ width: actionW, textColor: choice() === 1 ? COLOR.accentInk : accent }}>
            {props.modal.action}
          </Text>
        </View>
      </View>
    </View>
  );
}
