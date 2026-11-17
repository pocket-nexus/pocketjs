// @pocketjs/framework/game2d — the story UI: dialogue, choices, transitions and notices.
//
// Panels (dialogue, choices, the objective tracker, an info panel) are ordinary components on
// signals, so they cost nothing per frame while idle. Transient overlays (veil, card, banner,
// toast, labels) are drawn into a dynamic layer (`over`), because they animate and need images;
// with nothing showing they draw nothing. Every wait returns a Promise resolved on the frame
// clock; every menu goes through the input nav stack, so all of it works from buttons alone.
// Genre widgets, a battle's unit plates or a command grid, belong to the game.

import { createSignal, For, Show, type JSX } from "solid-js";
import { Text, View } from "../components.ts";
import * as hot from "../hot.ts";
import { getOps } from "../index.ts";
import type { NodeMirror } from "../index.ts";
import type { GameClock } from "./clock.ts";
import type { Input } from "./input.ts";
import { rgb, type Gfx } from "./layer.tsx";

/** Design tokens. Hex strings for components; `rgb(0x…)` for the immediate layer. */
export interface StoryTheme { ink: string; panel: string; panelHot: string; line: string; lineDim: string; gold: string; paper: string; paperDim: string; paperOff: string; red: string; green: string; jade: string; seal: string }
export const DEFAULT_THEME: StoryTheme = { ink: "#05060c", panel: "#0c1228", panelHot: "#24305e", line: "#c8b070", lineDim: "#5c4c24", gold: "#ffd860", paper: "#f4efdc", paperDim: "#b4b09c", paperOff: "#8c8a7a", red: "#d84830", green: "#a8e6b4", jade: "#a0dbe3", seal: "#b4282a" };
// Overlays draw every frame and parseInt is slow on a PSP, so colors resolve once.
const hexCache = new Map<string, number>();
const hex = (s: string, a = 255) => {
  const k = a === 255 ? s : s + a;
  let v = hexCache.get(k);
  if (v === undefined) { v = rgb(parseInt(s.slice(1), 16), a); hexCache.set(k, v); }
  return v;
};

export interface ChoiceOption { id: string; text: string; note?: string; disabled?: boolean }
export interface VeilOptions { kind?: "ink" | "fade" | "light"; time?: string; sub?: string; hold?: number; swap?: () => void; place?: string; placeSub?: string }
export interface BannerOptions { label: string; title: string; sub?: string; tone?: "battle" | "win" | "lose" }

export interface StoryConfig {
  width: number; height: number; clock: GameClock; input: Input<string>; over: Gfx; theme?: Partial<StoryTheme>;
  /** Draw a calligraphic word centred on x if the game baked one; return false to fall back to plain text. */
  display?: (s: string, x: number, y: number, alpha: number) => boolean;
  /** Draw a speaker's portrait with its top-left at (x, y); false if this speaker has none. */
  face?: (who: string, x: number, y: number) => boolean;
  sound?: (name: "line" | "pick" | "move" | "bell" | "place") => void;
}

export interface StoryUI {
  View: () => JSX.Element;
  /** Call once per frame after input, before the over stage ends. */
  frame(dtMs: number): void;
  say(who: string, text: string): Promise<void>;
  choose(opts: ChoiceOption[], prompt?: string, o?: { modal?: boolean; index?: number; onBack?: () => void }): Promise<string>;
  waiting(): boolean;
  next(): void;
  veil(o: VeilOptions): Promise<void>;
  veilBusy(): boolean;
  veilOpen(): void;
  card(title: string, sub?: string, seal?: string, ms?: number, stayCovered?: boolean): Promise<void>;
  banner(o: BannerOptions): Promise<void>;
  bannerUp(): boolean;
  toast(s: string, ms?: number): void;
  objective(text: string, label?: string): void;
  placeCard(name: string, sub?: string): void;
  tracker(text: string | null, sub?: string): void;
  progress(text: string): void;
  label(text: string, x: number, y: number): void;
  showWorldHud(on: boolean): void;
  /** Take down the place card now (a battle opening over it). */
  dismissPlace(): void;
  panel(content: { title: string; rows: [string, string][]; list?: [string, string][] } | null): void;
  panelOpen(): boolean;
  reset(): void;
  theme: StoryTheme;
}

/** Wrap through the engine's own text metrics. */
export function wrapText(s: string, px: 12 | 16, maxW: number): string[] {
  const ops = getOps() as unknown as { wrapText?: (s: string, slot: number, w: number) => number[] };
  const out: string[] = [];
  for (const para of s.split("\n")) {
    const breaks = ops.wrapText ? ops.wrapText(para, px === 16 ? 2 : 0, maxW) : Array.from({ length: Math.floor((para.length - 1) / Math.floor(maxW / px)) }, (_, i) => (i + 1) * Math.floor(maxW / px));
    let at = 0;
    for (const b of breaks) { out.push(para.slice(at, b)); at = b; }
    out.push(para.slice(at));
  }
  return out;
}

const PAGE_LINES = 3, LINE_H = 20, CHARS_PER_MS = 0.045;

export function createStoryUI(cfg: StoryConfig): StoryUI {
  const T: StoryTheme = { ...DEFAULT_THEME, ...cfg.theme };
  const { clock, input, over, width: W, height: H } = cfg;
  const sound = (n: "line" | "pick" | "move" | "bell" | "place") => cfg.sound?.(n);

  // —— dialogue ——————————————————————————————————————————————
  const [dlgOn, setDlgOn] = createSignal(false);
  const [dlgWho, setDlgWho] = createSignal("");
  const [dlgFace, setDlgFace] = createSignal(false);
  let dlgText: NodeMirror | undefined;
  let pages: string[] = [], pageAt = 0, typed = 0, typeDone = false, dlgResolve: (() => void) | null = null, curWho = "";
  const showPage = () => { typed = 0; typeDone = false; hot.text(dlgText, ""); };
  const gate: { fn: (() => void) | null } = { fn: null };

  // —— transient overlays (drawn each frame) ———————————————————————
  let toastT = 0, toastS = "";
  let objT = 0, objS = "", objL = "";
  let placeT = 0, placeN = "", placeS = "";
  let labelS: string | null = null, labelX = 0, labelY = 0;
  let veil = { on: false, alpha: 0, color: hex(T.ink), time: "", sub: "", busy: false };
  let cardS: { title: string; sub: string; seal: string; a: number } | null = null;
  let ban: { o: BannerOptions; t: number; dur: number; done: () => void } | null = null;

  const animate = async (ms: number, fn: (k: number) => void) => {
    const gen = clock.generation(), t0 = clock.uiNow(), dur = Math.max(1, ms * clock.speed);
    for (;;) {
      await clock.uiSleep(16);
      if (gen !== clock.generation()) return;
      const k = Math.min(1, (clock.uiNow() - t0) / dur);
      fn(k);
      if (k >= 1) return;
    }
  };
  const holdOrPress = (ms: number) => new Promise<void>((resolve) => {
    let done = false; const end = () => { if (!done) { done = true; if (gate.fn === end) gate.fn = null; resolve(); } };
    gate.fn = end; void clock.uiSleep(ms).then(end);
  });

  // —— world HUD / battle HUD / panels ————————————————————————————
  const [worldOn, setWorldOn] = createSignal(false);
  const [trackText, setTrackText] = createSignal<string | null>(null);
  const [trackSub, setTrackSub] = createSignal("");
  const [progressText, setProgress] = createSignal("");
  const [choice, setChoice] = createSignal<{ opts: ChoiceOption[]; prompt: string; modal: boolean } | null>(null);
  const [choiceHot, setChoiceHot] = createSignal(0);
  const [panelData, setPanelData] = createSignal<{ title: string; rows: [string, string][]; list?: [string, string][] } | null>(null);

  const hud: StoryUI = {
    theme: T,
    say(who, text) {
      hud.veilOpen();
      curWho = who;
      const hasFace = !!who && !!cfg.face?.(who, -999, -999);
      setDlgWho(who); setDlgFace(hasFace);
      const lines = wrapText(text, 16, W - (hasFace ? 124 : 32));
      pages = [];
      for (let i = 0; i < lines.length; i += PAGE_LINES) pages.push(lines.slice(i, i + PAGE_LINES).join("\n"));
      pageAt = 0; setDlgOn(true); showPage(); sound("line");
      return new Promise<void>((resolve) => { dlgResolve = resolve; });
    },
    waiting: () => dlgResolve != null || gate.fn != null,
    next() {
      if (gate.fn) { const f = gate.fn; f(); return; }
      if (!dlgResolve) return;
      if (!typeDone) { typeDone = true; hot.text(dlgText, pages[pageAt]); return; }
      if (pageAt + 1 < pages.length) { pageAt++; showPage(); sound("line"); return; }
      const r = dlgResolve; dlgResolve = null; setDlgOn(false); r();
    },
    choose(opts, prompt = "", o = {}) {
      hud.veilOpen();
      return new Promise<string>((resolve) => {
        setChoice({ opts, prompt, modal: !!o.modal });
        const nav = input.nav(opts.length, {
          modal: true, index: o.index ?? 0, disabled: (i) => !!opts[i].disabled,
          onChange: (i) => { setChoiceHot(i); sound("move"); },
          onPick: (i) => { nav.close(); setChoice(null); sound("pick"); resolve(opts[i].id); },
          onBack: o.onBack,
        });
        setChoiceHot(nav.index);
      });
    },
    async veil(o) {
      const kind = o.kind ?? "ink";
      const gen = clock.generation();
      veil.busy = true; veil.time = ""; veil.sub = "";
      veil.color = kind === "light" ? hex("#fffaf0") : hex(T.ink);
      const from = veil.alpha;
      await animate(kind === "fade" ? 240 : 420, (k) => { veil.alpha = Math.max(from, k); });
      if (gen !== clock.generation()) return;
      o.swap?.();
      setDlgOn(false);
      if (o.time || o.sub) { veil.time = o.time ?? ""; veil.sub = o.sub ?? ""; await holdOrPress(o.hold ?? 1600); if (gen !== clock.generation()) return; veil.time = ""; veil.sub = ""; }
      await animate(kind === "fade" ? 240 : 480, (k) => { veil.alpha = 1 - k; });
      if (gen !== clock.generation()) return;
      veil.alpha = 0; veil.busy = false;
      if (o.place) hud.placeCard(o.place, o.placeSub);
    },
    veilBusy: () => veil.busy || veil.alpha > 0,
    veilOpen() { if (!veil.busy) veil.alpha = 0; },
    async card(title, sub = "", seal = "", ms = 2200, stayCovered = false) {
      const gen = clock.generation();
      veil.busy = true; veil.color = hex(T.ink);
      await animate(320, (k) => { veil.alpha = Math.max(veil.alpha, k); });
      if (gen !== clock.generation()) return;
      cardS = { title, sub, seal, a: 0 };
      await animate(240, (k) => { if (cardS) cardS.a = k; });
      if (gen !== clock.generation()) return;
      await holdOrPress(ms);
      if (gen !== clock.generation()) return;
      await animate(240, (k) => { if (cardS) cardS.a = 1 - k; });
      cardS = null;
      veil.busy = false;
      if (stayCovered) { veil.alpha = 1; return; } // the next veil() or veilOpen() reveals
      await animate(320, (k) => { veil.alpha = 1 - k; });
    },
    banner(o) {
      sound("bell");
      return new Promise<void>((resolve) => {
        ban = { o, t: 0, dur: 1500 * clock.speed, done: resolve };
        gate.fn = () => { if (ban) ban.t = ban.dur; gate.fn = null; };
      });
    },
    bannerUp: () => !!ban,
    toast(s, ms = 2200) { toastS = s; toastT = ms; },
    objective(text, label = "") { objS = text; objL = label; objT = 2600; },
    placeCard(name, sub = "") { placeN = name; placeS = sub; placeT = 2200; sound("place"); },
    tracker(text, sub = "") { setTrackText(text); setTrackSub(sub); },
    progress: setProgress,
    label(text, x, y) { labelS = text; labelX = x; labelY = y; },
    showWorldHud: setWorldOn,
    dismissPlace() { placeT = 0; },
    panel: setPanelData,
    panelOpen: () => panelData() != null,
    reset() {
      gate.fn = null; dlgResolve = null; setDlgOn(false); setChoice(null); setPanelData(null);
      setWorldOn(false); setTrackText(null); veil = { on: false, alpha: 0, color: hex(T.ink), time: "", sub: "", busy: false }; cardS = null; ban = null; toastT = objT = placeT = 0;
    },
    frame(dt) {
      // typewriter
      if (dlgResolve && !typeDone) {
        typed += dt * CHARS_PER_MS / clock.speed;
        const p = pages[pageAt], n = Math.floor(typed);
        if (n >= p.length) { typeDone = true; hot.text(dlgText, p); }
        else hot.text(dlgText, p.slice(0, n));
      }
      if (dlgOn() && curWho) cfg.face?.(curWho, 0, H - 96);
      // transient
      const dim = hex(T.ink, 220);
      if (placeT > 0) {
        placeT -= dt; const a = Math.min(1, placeT / 300);
        over.rect(0, 24, 170, placeS ? 42 : 28, dim, a);
        over.rect(0, 24, 3, placeS ? 42 : 28, hex(T.line), a);
        if (!cfg.display?.(placeN, 85, 26, a)) over.text(placeN, 10, 28, { size: 16, color: hex(T.gold), alpha: a });
        if (placeS) over.text(placeS, 10, 48, { color: hex(T.paperDim), alpha: a });
      }
      if (objT > 0) {
        objT -= dt; const a = Math.min(1, objT / 300);
        over.rect(W / 2 - 120, 40, 240, 24, dim, a);
        over.text(objL ? `${objL}  ${objS}` : objS, W / 2, 44, { align: "center", color: hex(T.gold), alpha: a });
      }
      if (toastT > 0) {
        toastT -= dt; const a = Math.min(1, toastT / 300);
        over.rect(W / 2 - 110, 70, 220, 22, dim, a);
        over.text(toastS, W / 2, 73, { align: "center", color: hex(T.paper), alpha: a });
      }
      if (labelS !== null) {
        over.rect(labelX - 60, labelY - 1, 120, 16, dim, 1);
        over.text(labelS, labelX, labelY, { align: "center", color: hex(T.paper) });
        labelS = null;
      }
      if (ban) {
        ban.t += dt;
        const b = ban, k = b.t / b.dur, a = Math.min(1, Math.min(b.t, b.dur - b.t) / (200 * clock.speed));
        const tone = b.o.tone === "win" ? T.gold : b.o.tone === "lose" ? T.red : T.paper;
        over.rect(0, H / 2 - 36, W, 72, hex(T.ink, 230), a);
        over.rect(0, H / 2 - 36, W, 1, hex(T.line), a); over.rect(0, H / 2 + 35, W, 1, hex(T.line), a);
        over.text(b.o.label, W / 2, H / 2 - 30, { align: "center", color: hex(tone), alpha: a });
        if (!cfg.display?.(b.o.title, W / 2, H / 2 - 12, a)) over.text(b.o.title, W / 2, H / 2 - 10, { size: 16, align: "center", color: hex(T.paper), alpha: a });
        if (b.o.sub) over.text(b.o.sub, W / 2, H / 2 + 16, { align: "center", color: hex(T.paperDim), alpha: a });
        if (k >= 1) { ban = null; if (gate.fn) gate.fn = null; b.done(); }
      }
      if (veil.alpha > 0) {
        over.rect(0, 0, W, H, veil.color, veil.alpha);
        if (veil.time || veil.sub) {
          if (veil.time && !cfg.display?.(veil.time, W / 2, H / 2 - 26, veil.alpha)) over.text(veil.time, W / 2, H / 2 - 20, { size: 16, align: "center", color: hex(T.paper) });
          if (veil.sub) over.text(veil.sub, W / 2, H / 2 + 12, { align: "center", color: hex(T.paperDim) });
        }
      }
      if (cardS) {
        const c = cardS;
        if (!cfg.display?.(c.title, W / 2, H / 2 - 46, c.a)) over.text(c.title, W / 2, H / 2 - 40, { size: 16, align: "center", color: hex(T.gold), alpha: c.a });
        if (c.sub && !cfg.display?.(c.sub, W / 2, H / 2 - 8, c.a)) over.text(c.sub, W / 2, H / 2 - 2, { size: 16, align: "center", color: hex(T.paper), alpha: c.a });
        if (c.seal) over.text(c.seal, W / 2, H / 2 + 40, { align: "center", color: hex(T.paperDim), alpha: c.a });
      }
    },
    View() {
      const frame = { borderWidth: 1, borderColor: T.line, bgColor: T.panel };
      return (
        <View class="absolute left-0 top-0" style={{ width: W, height: H }}>
          <Show when={worldOn()}>
            <Show when={trackText()}>
              <View class="absolute flex-col right-[4] top-[4] px-2 py-1" style={{ width: 196, bgColor: "#05060cc0", borderWidth: 1, borderColor: T.lineDim }}>
                <Text class="text-xs" style={{ textColor: T.gold }}>{trackText()}</Text>
                <Show when={trackSub()}><Text class="text-xs" style={{ width: 184, textColor: T.paperDim, lineHeight: 15 }}>{wrapText(trackSub(), 12, 182).slice(0, 3).join("\n")}</Text></Show>
              </View>
            </Show>
            <View class="absolute left-[4] top-[4] px-1" style={{ bgColor: "#05060c90" }}>
              <Text class="text-xs" style={{ textColor: T.paperDim }}>{progressText()}</Text>
            </View>
          </Show>


          <Show when={dlgOn()}>
            <View class="absolute" style={{ insetL: 6, insetT: H - 86, width: W - 12, height: 82, ...frame }}>
              <Text class="absolute text-base" style={{ insetL: dlgFace() ? 92 : 8, insetT: 1, textColor: T.gold }}>{dlgWho()}</Text>
              <Text class="absolute text-base" style={{ insetL: dlgFace() ? 92 : 8, insetT: dlgWho() ? 20 : 8, width: W - (dlgFace() ? 120 : 28), height: 62, textColor: T.paper, lineHeight: LINE_H }} ref={(n: NodeMirror) => { dlgText = n; }}>{" "}</Text>
            </View>
          </Show>

          <Show when={choice()}>
            <View class="absolute items-center justify-center" style={{ insetL: 0, insetT: 0, width: W, height: H, bgColor: choice()!.modal ? "#05060cb0" : "#00000000" }}>
              <View class="flex-col px-2 py-2" style={{ width: 300, ...frame }}>
                <Show when={choice()!.prompt}><Text class="text-xs" style={{ textColor: T.paper, marginB: 4 }}>{wrapText(choice()!.prompt, 12, 280).join("\n")}</Text></Show>
                <For each={choice()!.opts}>{(o, i) => (
                  <View class="flex-col px-2 py-1" style={{ bgColor: choiceHot() === i() ? T.panelHot : "#00000000" }}>
                    <Text class="text-base" style={{ textColor: o.disabled ? T.paperOff : choiceHot() === i() ? T.gold : T.paper }}>{o.text}</Text>
                    <Show when={o.note}><Text class="text-xs" style={{ textColor: T.paperDim }}>{o.note}</Text></Show>
                  </View>
                )}</For>
              </View>
            </View>
          </Show>

          <Show when={panelData()}>
            <View class="absolute flex-col px-3 py-2" style={{ insetL: 60, insetT: 24, width: W - 120, height: H - 48, ...frame }}>
              <Text class="text-base" style={{ textColor: T.gold, marginB: 4 }}>{panelData()!.title}</Text>
              <For each={panelData()!.rows}>{(r) => <View class="flex-row justify-between"><Text class="text-xs" style={{ textColor: T.paperDim }}>{r[0]}</Text><Text class="text-xs" style={{ textColor: T.paper }}>{r[1]}</Text></View>}</For>
              <Show when={panelData()!.list}><For each={panelData()!.list!}>{(r) => <View class="flex-row" style={{ marginT: 2 }}><Text class="text-xs" style={{ width: 76, textColor: T.gold }}>{r[0]}</Text><Text class="text-xs" style={{ width: 240, textColor: T.paperDim }}>{r[1].slice(0, 22)}</Text></View>}</For></Show>
            </View>
          </Show>
        </View>
      );
    },
  };
  return hud;
}

