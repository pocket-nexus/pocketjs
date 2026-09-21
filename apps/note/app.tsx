// apps/note/app.tsx — Pocket Note: a markdown widget as a PocketJS app.
//
// Two modes over one string document. View mode renders parsed markdown as
// measured, absolutely-positioned rows (layout.ts) behind a manual virtual
// scroll — the IM thread contract: an untransformed overflow-hidden clip
// around a translateY canvas that mounts only the visible slice. Edit mode
// soft-wraps the raw source (editor.ts) with a real caret, drag selection
// and an undo/redo stack. The desktop host feeds keys/mouse/resizes through
// the svc channel (svc.ts) and synthesizes CIRCLE for clicks, so
// hover-focus + the stock onPress pipeline dispatch the chrome (toggle,
// menu) while content pointer gestures (caret, drag-select) ride the svc
// mouse stream directly; on hosts without svc (PSP, sim, goldens) the app
// is a read-only note scrolled by d-pad — unmodified-app base case.

import { createMemo, createRenderEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { RuntimeFont, RuntimeTextLayout, RuntimeTextResource } from "@pocketjs/framework/fonts";
import { Focusable, Image, Portal, Text, View } from "@pocketjs/framework/components";
import { after, virtualNow } from "@pocketjs/framework/clock";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN, focusNode, hitFocusable } from "@pocketjs/framework/input";
import { resizeViewport, type NodeMirror } from "@pocketjs/framework";
import { platform } from "@pocketjs/framework/platform";
import { parseMarkdown } from "./markdown.ts";
import {
  BODY_LINE_H,
  bodyWidth,
  EDGE_PAD,
  layoutBlocks,
  textWidth,
  type Seg,
  type ViewRow,
} from "./layout.ts";
import {
  backspaceSel,
  breakRun,
  caretFromX,
  caretLine,
  caretX,
  deleteSel,
  emptyHistory,
  layoutDoc,
  layoutFromText,
  lineCaretX,
  moveCaret,
  lineEnd,
  lineStart,
  moveVertical,
  recordEdit,
  redo,
  selBounds,
  typeText,
  undo,
  wordRangeAt,
  type EditKind,
  type SelEdit,
} from "./editor.ts";
import {
  cmpPos,
  rowChFromX,
  rowFromY,
  rowSelSpan,
  rowText,
  selectedText,
  type RowPos,
} from "./select.ts";
import { connectSvc, type HostEvent } from "./svc.ts";
import { SAMPLE_DOC } from "./sample.ts";

const HEADER_H = 30;
/** Minimum side padding of the content column (the floor narrow windows
 *  pin to — kept roomy so text never hugs the window edge). */
const PAD_X = 28;
/** The content column stops growing here and centers (markdown-app feel). */
const MAX_CONTENT_W = 560;
const OVERSCAN = 40;
const SCROLL_STEP = 40; //  d-pad / PageUp step base
const SAVE_DEBOUNCE = 45; // ticks (~0.75 s) after the last edit
const CARET_H = 16;
/** Pointer movement (logical px) that turns a press into a drag. */
const DRAG_SLOP = 3;

// Theme ink. Class literals carry fonts/geometry; colors ride inline so
// both themes share one compiled style table.
const INK = {
  dark: {
    body: "#d7dee7",
    dim: "#7e8994",
    accent: "#6fb3ff",
    em: "#b9cbdf",
    code: "#95d79d",
    codeBg: "#19212b",
    quote: "#a8b3c0",
    bar: "#3a4450",
    hr: "#232b34",
    thumb: "#414d5b",
    header: "#8d98a5",
    sel: "#2a4a6e",
    chrome: "#1a212b",
  },
  light: {
    body: "#272b31",
    dim: "#8b9199",
    accent: "#1c6fd2",
    em: "#4a5d75",
    code: "#20713a",
    codeBg: "#f0efe9",
    quote: "#5d6672",
    bar: "#d9d6cb",
    hr: "#e6e4dc",
    thumb: "#c9c6bb",
    header: "#6f7680",
    sel: "#cfe3fb",
    chrome: "#eceade",
  },
};

type Ink = (typeof INK)["dark"];

function segFontClass(seg: Seg): string {
  switch (seg.slot) {
    case 17:
      return "absolute text-sm font-mono";
    case 12:
      return "absolute text-2xl font-bold";
    case 11:
      return "absolute text-xl font-bold";
    case 10:
      return "absolute text-lg font-bold";
    case 8:
      return "absolute text-sm font-bold";
    default:
      return "absolute text-sm";
  }
}

function segColor(seg: Seg, ink: Ink): string {
  switch (seg.style) {
    case "code":
      return ink.code;
    case "link":
      return ink.accent;
    case "em":
      return ink.em;
    case "marker":
      return ink.dim;
    default:
      return ink.body;
  }
}

export default function Note(props: { font?: RuntimeFont; initialEditing?: boolean; initialDocument?: string } = {}): ReturnType<typeof View> {
  const svc = connectSvc();
  // Editing and pointer gestures arrive over the COMPANION svc adapter
  // (svc.ts), so their gates track its runtime presence — never a target
  // capability id (the macos-app profile deliberately registers neither:
  // pointer/text there are companion-delivered, not host-generic). Without
  // a companion (PSP, sim, goldens) the note is a read-only d-pad note —
  // the unmodified-app base case, unchanged.
  const canEdit = svc !== null;
  const hasPointer = svc !== null;
  // Widget chrome (card corners, resize grip, the Close menu item) belongs
  // to the frameless always-on-top shell; on a real window (macos-app) the
  // OS provides corners, resizing and closing.
  const widgetChrome = platform.target === "macos-widget";
  const [vp, setVp] = createSignal({ w: 480, h: 272 });
  const [doc, setDoc] = createSignal(props.initialDocument ?? SAMPLE_DOC);
  const [editing, setEditing] = createSignal(props.initialEditing ?? false);
  const [dark, setDark] = createSignal(true);
  const [menuOpen, setMenuOpenRaw] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  /** Browser caret discipline: SOLID while typing or moving, and a crisp
   *  square-wave blink (animate-caret, pocket.config.ts) after a 0.6 s
   *  rest. The <Show> swap remounts the blinking node, restarting the wave
   *  at its ON phase — exactly a browser's reset-on-input. */
  const [caretResting, setCaretResting] = createSignal(true);
  let caretRestTimer: (() => void) | null = null;
  const wakeCaret = () => {
    setCaretResting(false);
    caretRestTimer?.();
    caretRestTimer = after(0.6, () => setCaretResting(true));
  };
  const [anchor, setAnchor] = createSignal(0);
  const [vsel, setVsel] = createSignal<{ start: RowPos; end: RowPos } | null>(null);
  /** IME composition riding at the caret: not in the document until commit. */
  const [preedit, setPreedit] = createSignal<{ text: string; cursor: number } | null>(null);
  const [scrollV, setScrollV] = createSignal(0);
  const [scrollE, setScrollE] = createSignal(0);
  const [mouse, setMouse] = createSignal({ x: -1, y: -1 });

  const ink = () => (dark() ? INK.dark : INK.light);
  const contentW = () => Math.min(vp().w - PAD_X * 2, MAX_CONTENT_W);
  /** Left edge of the centered content column. */
  const marginX = () => Math.max(PAD_X, (vp().w - contentW()) / 2);
  const viewH = () => vp().h - HEADER_H;

  /** The host gates its header-drag/resize claims while the menu is up
   *  (otherwise a click on the header starts a window drag instead of
   *  reaching the backdrop to close the menu). */
  const setMenuOpen = (open: boolean) => {
    if (open !== menuOpen()) svc?.send({ t: "menu", open });
    setMenuOpenRaw(open);
  };

  // ---- view layout -------------------------------------------------------
  const viewLayout = createMemo(() => layoutBlocks(parseMarkdown(doc()), contentW()));
  const maxScrollV = () => Math.max(0, viewLayout().total - viewH());
  const visibleRows = createMemo(() => {
    const top = scrollV() - OVERSCAN;
    const bottom = scrollV() + viewH() + OVERSCAN;
    const out: { row: ViewRow; i: number }[] = [];
    const rows = viewLayout().rows;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.y < bottom && r.y + r.h > top) out.push({ row: r, i });
    }
    return out;
  });

  // ---- edit layout -------------------------------------------------------
  // The editor renders the DISPLAY doc: the document with any IME preedit
  // spliced at the caret. Navigation paths only run while no composition
  // is active (the IME consumes keys, content clicks are blocked), so
  // display == document exactly when caret math matters.
  const displayDoc = createMemo(() => {
    const p = preedit();
    if (!p) return doc();
    return doc().slice(0, caret()) + p.text + doc().slice(caret());
  });
  const displayCaret = () => {
    const p = preedit();
    return p ? caret() + p.cursor : caret();
  };
  const [runtimeResource, setRuntimeResource] = createSignal<RuntimeTextResource>();
  const [runtimeLayout, setRuntimeLayout] = createSignal<RuntimeTextLayout>();
  const [runtimeError, setRuntimeError] = createSignal("");
  createRenderEffect(() => {
    const font = props.font, source = displayDoc(), width = contentW();
    setRuntimeLayout(undefined);
    setRuntimeResource(undefined); setRuntimeError("");
    if (!font) { setRuntimeResource(undefined); return; }
    let resource: RuntimeTextResource;
    try { resource = font.prepareText(source, { width }); }
    catch (error) { setRuntimeError(String(error)); return; }
    setRuntimeResource(resource);
    const update = () => {
      setRuntimeLayout(resource.layout());
      const state = resource.state();
      if (state.status === "error") setRuntimeError(String(state.error));
    };
    update(); const unsubscribe = resource.subscribe(update);
    onCleanup(() => { unsubscribe(); resource.dispose(); });
  });
  const dlines = createMemo(() => props.font
    ? runtimeLayout() ? layoutFromText(runtimeLayout()!) : [{ start: 0, end: 0, soft: false, carets: [[0, 0] as const] }]
    : layoutDoc(displayDoc(), contentW(), bodyWidth));
  const editLineHeight = () => runtimeLayout()?.font.lineHeight ?? BODY_LINE_H;
  const editTotal = () => dlines().length * editLineHeight() + EDGE_PAD * 2;
  const maxScrollE = () => Math.max(0, editTotal() - viewH());
  const visibleLines = createMemo(() => {
    const lines = dlines();
    const from = Math.max(0, Math.floor((scrollE() - OVERSCAN - EDGE_PAD) / editLineHeight()));
    const to = Math.min(
      lines.length,
      Math.ceil((scrollE() + viewH() + OVERSCAN - EDGE_PAD) / editLineHeight()),
    );
    const out: { index: number; start: number; end: number; soft: boolean }[] = [];
    for (let i = from; i < to; i++) {
      out.push({ index: i, start: lines[i].start, end: lines[i].end, soft: lines[i].soft });
    }
    return out;
  });
  const caretRow = () => caretLine(dlines(), displayCaret());
  const caretPx = () => caretX(displayDoc(), dlines(), displayCaret(), bodyWidth);
  /** Normalized selection bounds, null when collapsed. */
  const editSel = () => {
    if (caret() === anchor()) return null;
    const [lo, hi] = selBounds({ doc: doc(), caret: caret(), anchor: anchor() });
    return { lo, hi };
  };

  // ---- edits + history ---------------------------------------------------
  const history = emptyHistory();
  let goalX = 0;
  let goalSticky = false;
  let saveIn = -1;
  let lastHover: NodeMirror | null = null;
  /** Re-run hover→focus next frame (a mode switch remounted the target). */
  let rehover = false;

  const markDirty = () => {
    saveIn = SAVE_DEBOUNCE;
  };
  const save = () => {
    saveIn = -1;
    svc?.send({ t: "save", text: doc() });
  };
  const revealCaret = () => {
    const y = EDGE_PAD + caretRow() * editLineHeight();
    if (y < scrollE() + 4) setScrollE(Math.max(0, y - 4));
    else if (y + editLineHeight() > scrollE() + viewH() - 4) {
      setScrollE(Math.min(maxScrollE(), y + editLineHeight() - viewH() + 4));
    }
  };
  const selState = (): SelEdit => ({ doc: doc(), caret: caret(), anchor: anchor() });
  const applyState = (s: SelEdit) => {
    if (s.doc !== doc()) {
      setDoc(s.doc);
      markDirty();
    }
    setCaret(s.caret);
    setAnchor(s.anchor);
  };
  /** One undoable mutation: snapshot, apply, reveal. */
  const mutate = (kind: EditKind, fn: (s: SelEdit) => SelEdit) => {
    const before = selState();
    const next = fn(before);
    if (next.doc !== before.doc) recordEdit(history, before, kind);
    applyState(next);
    goalSticky = false;
    revealCaret();
  };
  /** Collapse-or-move for plain arrows: a selection collapses to its edge. */
  const collapseOr = (edge: "lo" | "hi", move: (s: SelEdit) => number) => {
    const s = selState();
    const [lo, hi] = selBounds(s);
    const pos = s.caret === s.anchor ? move(s) : edge === "lo" ? lo : hi;
    setCaret(pos);
    setAnchor(pos);
    breakRun(history);
    goalSticky = false;
    revealCaret();
  };
  const applyUndoRedo = (fn: typeof undo) => {
    if (!editing()) return;
    const state = fn(history, selState());
    if (!state) return;
    applyState(state);
    markDirty();
    goalSticky = false;
    revealCaret();
  };

  const enterEdit = (offset: number) => {
    setMenuOpen(false);
    setVsel(null);
    pvAnchor = null;
    const pos = Math.max(0, Math.min(offset, doc().length));
    setCaret(pos);
    setAnchor(pos);
    breakRun(history);
    // Keep roughly the same place on screen across the mode switch.
    const y = EDGE_PAD + caretLine(dlines(), pos) * editLineHeight();
    setScrollE(Math.max(0, Math.min(maxScrollE(), y - viewH() / 3)));
    setEditing(true);
    goalSticky = false;
    rehover = true;
  };
  const leaveEdit = () => {
    setPreedit(null);
    setEditing(false);
    if (saveIn > 0) save();
    setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV())));
    rehover = true;
  };

  const handleKey = (k: string, shift = false) => {
    if (props.font && !runtimeLayout() && ["Left", "Right", "Up", "Down", "Home", "End", "Backspace", "Delete"].includes(k)) return;
    // Shift + navigation extends the selection: the caret moves, the
    // anchor holds.
    if (shift && editing() && !preedit()) {
      const extend = (pos: number) => {
        setCaret(Math.max(0, Math.min(pos, doc().length)));
        breakRun(history);
        revealCaret();
      };
      switch (k) {
        case "Left":
          extend(moveCaret(doc(), dlines(), caret(), -1));
          return;
        case "Right":
          extend(moveCaret(doc(), dlines(), caret(), 1));
          return;
        case "Home":
          extend(lineStart(dlines(), caret()));
          return;
        case "End":
          extend(lineEnd(dlines(), caret()));
          return;
        case "Up":
        case "Down": {
          if (!goalSticky) {
            goalX = caretPx();
            goalSticky = true;
          }
          extend(moveVertical(doc(), dlines(), caret(), k === "Up" ? -1 : 1, goalX, bodyWidth));
          goalSticky = true;
          return;
        }
      }
    }
    if (k === "Escape") {
      if (menuOpen()) setMenuOpen(false);
      else if (!editing() && vsel()) setVsel(null);
      else if (editing() && editSel()) collapseOr("hi", (s) => s.caret);
      else if (editing()) leaveEdit();
      return;
    }
    if (k === "Copy") {
      const text = editing()
        ? (() => {
            const sel = editSel();
            return sel ? doc().slice(sel.lo, sel.hi) : "";
          })()
        : (() => {
            const sel = vsel();
            return sel ? selectedText(viewLayout().rows, sel.start, sel.end) : "";
          })();
      if (text !== "") svc?.send({ t: "copy", text });
      return;
    }
    if (k === "Cut") {
      const sel = editSel();
      if (editing() && sel) {
        svc?.send({ t: "copy", text: doc().slice(sel.lo, sel.hi) });
        mutate("other", (s) => typeText(s, ""));
      }
      return;
    }
    if (k === "Undo") {
      applyUndoRedo(undo);
      return;
    }
    if (k === "Redo") {
      applyUndoRedo(redo);
      return;
    }
    if (!editing()) {
      // View mode: keyboard scrolls.
      const step =
        k === "Up" ? -SCROLL_STEP : k === "Down" ? SCROLL_STEP : k === "PageUp" ? -viewH() : k === "PageDown" ? viewH() : k === "Home" ? -1e9 : k === "End" ? 1e9 : 0;
      if (step !== 0) setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV() + step)));
      return;
    }
    switch (k) {
      case "Backspace":
        mutate("delete", s => backspaceSel(s, dlines()));
        break;
      case "Delete":
        mutate("delete", s => deleteSel(s, dlines()));
        break;
      case "Enter":
        mutate("other", (s) => typeText(s, "\n"));
        break;
      case "Tab":
        mutate("other", (s) => typeText(s, "  "));
        break;
      case "Left":
        collapseOr("lo", (s) => moveCaret(s.doc, dlines(), s.caret, -1));
        break;
      case "Right":
        collapseOr("hi", (s) => moveCaret(s.doc, dlines(), s.caret, 1));
        break;
      case "Home":
        collapseOr("lo", (s) => lineStart(dlines(), s.caret));
        break;
      case "End":
        collapseOr("hi", (s) => lineEnd(dlines(), s.caret));
        break;
      case "Up":
      case "Down": {
        if (!goalSticky) {
          goalX = caretPx();
          goalSticky = true;
        }
        const next = moveVertical(doc(), dlines(), caret(), k === "Up" ? -1 : 1, goalX, bodyWidth);
        setCaret(next);
        setAnchor(next);
        breakRun(history);
        goalSticky = true;
        revealCaret();
        break;
      }
      case "PageUp":
      case "PageDown":
        setScrollE(
          Math.max(0, Math.min(maxScrollE(), scrollE() + (k === "PageUp" ? -viewH() : viewH()))),
        );
        break;
    }
  };

  // ---- pointer gestures over the content (svc mouse stream) --------------
  // Chrome (toggle, menu) rides the framework's hover-focus + CIRCLE press;
  // content needs press/drag/release, which BTN bits can't carry.
  let press: { x: number; y: number; dragged: boolean; content: boolean } | null = null;
  /** Preview selection anchor — persists across clicks so shift-click
   *  extends from the last plain click. */
  let pvAnchor: RowPos | null = null;
  let prevDown = false;
  /** Double-click detection on the virtual clock: a second plain press
   *  within 0.4 s and 3 px of the last selects the word under it. */
  let lastPress: { t: number; x: number; y: number } | null = null;
  const doubleClicked = (x: number, y: number, shift: boolean): boolean => {
    const now = virtualNow();
    const dbl =
      !shift &&
      lastPress !== null &&
      now - lastPress.t <= 0.4 &&
      Math.abs(x - lastPress.x) <= 3 &&
      Math.abs(y - lastPress.y) <= 3;
    lastPress = dbl ? null : { t: now, x, y }; // a triple starts a new pair
    return dbl;
  };

  const editPosAt = (x: number, y: number): number => {
    if (props.font && !runtimeLayout()) return caret();
    const line = Math.floor((y - HEADER_H + scrollE() - EDGE_PAD) / editLineHeight());
    return caretFromX(doc(), dlines(), line, x - marginX(), bodyWidth);
  };
  const viewPosAt = (x: number, y: number): RowPos => {
    const rows = viewLayout().rows;
    const row = rowFromY(rows, y - HEADER_H + scrollV());
    return { row, ch: rows.length ? rowChFromX(rows[row], x - marginX(), textWidth) : 0 };
  };

  const pointerDown = (x: number, y: number, shift: boolean) => {
    const content = y >= HEADER_H && !menuOpen() && !preedit();
    press = { x, y, dragged: false, content };
    if (!content) return;
    const dbl = doubleClicked(x, y, shift);
    if (editing()) {
      const pos = editPosAt(x, y);
      if (dbl) {
        // Double click selects the word (or space/punctuation run) under
        // the pointer; a drag afterwards extends from its start.
        const [start, end] = wordRangeAt(doc(), pos);
        setAnchor(start);
        setCaret(end);
        breakRun(history);
        goalSticky = false;
        return;
      }
      setCaret(pos);
      // Shift-click keeps the anchor: the span from the previous caret
      // (or selection anchor) to the clicked point becomes the selection.
      if (!shift) setAnchor(pos);
      breakRun(history);
      goalSticky = false;
    } else if (shift && pvAnchor) {
      const here = viewPosAt(x, y);
      const [start, end] = cmpPos(pvAnchor, here) <= 0 ? [pvAnchor, here] : [here, pvAnchor];
      setVsel({ start, end });
    } else if (dbl) {
      // Preview double click: word selection within the clicked row (code
      // blocks are atomic — any hit selects the whole block, matching
      // rowSelSpan's granularity).
      const here = viewPosAt(x, y);
      const row = viewLayout().rows[here.row];
      if (row && row.kind !== "hr") {
        const text = row.kind === "code" ? row.text : rowText(row);
        if (text.length > 0) {
          const [s, e] =
            row.kind === "code" ? ([0, text.length] as const) : wordRangeAt(text, here.ch);
          if (e > s) {
            pvAnchor = { row: here.row, ch: s };
            setVsel({ start: { row: here.row, ch: s }, end: { row: here.row, ch: e } });
          }
        }
      }
    } else {
      setVsel(null);
      pvAnchor = viewPosAt(x, y);
    }
  };
  const pointerMove = (x: number, y: number, down: boolean) => {
    if (!down || !press || !press.content) return;
    if (!press.dragged && Math.abs(x - press.x) + Math.abs(y - press.y) < DRAG_SLOP) return;
    press.dragged = true;
    if (editing()) {
      setCaret(editPosAt(x, y)); // anchor stays: the selection
      revealCaret();
    } else if (pvAnchor) {
      const here = viewPosAt(x, y);
      const [start, end] = cmpPos(pvAnchor, here) <= 0 ? [pvAnchor, here] : [here, pvAnchor];
      setVsel({ start, end });
    }
  };
  const pointerUp = (_x: number, _y: number) => {
    // Preview clicks are inert (a markdown preview doesn't react to
    // clicks — the pencil toggle and the menu enter edit mode); the
    // pointer-down already placed the caret / cleared the selection.
    // pvAnchor survives the release so a later shift-click extends.
    press = null;
  };

  const handleEvent = (ev: HostEvent) => {
    switch (ev.t) {
      case "hello":
      case "resize":
        setVp({ w: ev.w ?? 480, h: ev.h ?? 272 });
        resizeViewport(ev.w ?? 480, ev.h ?? 272);
        setVsel(null); // row geometry changed under the selection
        pvAnchor = null;
        setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV())));
        setScrollE(Math.max(0, Math.min(maxScrollE(), scrollE())));
        break;
      case "load":
        setDoc(ev.text ?? "");
        setCaret(0);
        setAnchor(0);
        setVsel(null);
        setPreedit(null);
        history.past.length = 0;
        history.future.length = 0;
        history.last = null;
        saveIn = -1;
        break;
      case "ch":
        if (editing() && ev.s) {
          wakeCaret();
          setPreedit(null); // a commit replaces the preedit it finalizes
          mutate("type", (s) => typeText(s, ev.s!));
        }
        break;
      case "paste":
        if (editing() && ev.text) {
          wakeCaret();
          mutate("other", (s) => typeText(s, ev.text!));
        }
        break;
      case "ime": {
        if (!editing()) break;
        wakeCaret();
        const text = ev.s ?? "";
        if (text === "") {
          setPreedit(null);
          break;
        }
        // Composition replaces a live selection the moment it starts.
        if (editSel()) mutate("other", (st) => typeText(st, ""));
        setPreedit({ text, cursor: Math.min(ev.c ?? text.length, text.length) });
        revealCaret();
        break;
      }
      case "key":
        if (ev.k) {
          if (editing()) wakeCaret();
          handleKey(ev.k, ev.sh ?? false);
        }
        break;
      case "mouse": {
        const p = { x: ev.x ?? -1, y: ev.y ?? -1 };
        const down = ev.d ?? false;
        setMouse(p);
        if (down && !prevDown && editing()) wakeCaret();
        if (down && !prevDown) pointerDown(p.x, p.y, ev.sh ?? false);
        else if (down) pointerMove(p.x, p.y, true);
        if (!down && prevDown) pointerUp(p.x, p.y);
        prevDown = down;
        const n = hitFocusable(p.x, p.y);
        if (n && n !== lastHover) focusNode(n);
        lastHover = n;
        break;
      }
      case "scroll": {
        const dy = ev.dy ?? 0;
        if (editing()) setScrollE(Math.max(0, Math.min(maxScrollE(), scrollE() - dy)));
        else setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV() - dy)));
        break;
      }
    }
  };

  let lastCaretRect = { x: -1, y: -1, h: -1 };
  onFrame(() => {
    if (saveIn > 0 && --saveIn === 0) save();
    if (!svc) return;
    for (const ev of svc.poll()) handleEvent(ev);
    if (editing()) {
      const rect = {
        x: Math.round(marginX() + caretPx()),
        y: Math.round(HEADER_H + EDGE_PAD + caretRow() * editLineHeight() - scrollE()),
        h: editLineHeight(),
      };
      if (rect.x !== lastCaretRect.x || rect.y !== lastCaretRect.y) {
        lastCaretRect = rect;
        svc.send({ t: "caret", ...rect });
      }
    }
    if (rehover) {
      // The frame after a mode switch: the node under the pointer was
      // remounted, so hover-focus it again without waiting for a move.
      rehover = false;
      const m = mouse();
      if (m.x >= 0) {
        const n = hitFocusable(m.x, m.y);
        if (n) focusNode(n);
        lastHover = n;
      }
    }
  });

  // Pointerless hosts (PSP, sim): d-pad scrolls the rendered note.
  onButtonPress(BTN.UP, () => {
    if (!hasPointer) setScrollV(Math.max(0, scrollV() - SCROLL_STEP));
  });
  onButtonPress(BTN.DOWN, () => {
    if (!hasPointer) setScrollV(Math.min(maxScrollV(), scrollV() + SCROLL_STEP));
  });

  // ---- render ------------------------------------------------------------
  const thumbH = (total: number) => Math.max(24, (viewH() * viewH()) / total);
  const scrollbar = (scroll: number, total: number) => (
    <Show when={total > viewH()}>
      <View
        class="absolute rounded-sm"
        style={{
          width: 3,
          insetR: 3,
          insetT: (scroll / (total - viewH())) * (viewH() - thumbH(total) - 8) + 4,
          height: thumbH(total),
          bgColor: ink().thumb,
        }}
      />
    </Show>
  );

  /** Edit-mode selection rect for one display line, null outside. */
  const lineSelRect = (line: { index: number; start: number; end: number }) => {
    const sel = editSel();
    if (!sel) return null;
    const lo = Math.max(sel.lo, line.start);
    const hi = Math.min(sel.hi, line.end);
    if (hi < lo) return null;
    if (hi === lo && !(sel.lo < line.start && sel.hi > line.end)) return null;
    const x0 = lineCaretX(displayDoc(), dlines()[line.index], lo, bodyWidth);
    const x1 = lineCaretX(displayDoc(), dlines()[line.index], hi, bodyWidth);
    // A fully-selected empty line still shows a sliver (the newline).
    return { x0, x1: Math.max(x1, x0 + (hi === line.end && sel.hi > line.end ? 4 : 0)) };
  };

  /** IME composition underline span for one display line, null outside. */
  const preeditRect = (line: { index: number; start: number; end: number }) => {
    const p = preedit();
    if (!p) return null;
    const lo = Math.max(caret(), line.start);
    const hi = Math.min(caret() + p.text.length, line.end);
    if (hi <= lo) return null;
    return {
      x0: lineCaretX(displayDoc(), dlines()[line.index], lo, bodyWidth),
      x1: lineCaretX(displayDoc(), dlines()[line.index], hi, bodyWidth),
    };
  };

  return (
    <View
      class={
        widgetChrome
          ? dark()
            ? "flex-col w-full h-full rounded-xl overflow-hidden bg-[#11151b]"
            : "flex-col w-full h-full rounded-xl overflow-hidden bg-[#fbfaf6]"
          : dark()
            ? "flex-col w-full h-full overflow-hidden bg-[#11151b]"
            : "flex-col w-full h-full overflow-hidden bg-[#fbfaf6]"
      }
    >
      {/* Header: the host's drag region (everything left of the buttons).
          The wordmark is widget identity — a real window already carries
          the title in its OS titlebar. */}
      <View class="flex-row items-center gap-2 px-3" style={{ height: HEADER_H }}>
        <Show when={widgetChrome}>
          <Text class="text-xs font-bold tracking-wide" style={{ textColor: ink().header }}>
            POCKET NOTE
          </Text>
        </Show>
        <View class="flex-1" />
        {/* Preview/edit segmented toggle (text-input hosts only). */}
        <Show when={canEdit}>
        <View class="flex-row rounded-md p-[2] gap-[2]" style={{ bgColor: ink().chrome }}>
          <ToggleSeg
            active={() => !editing()}
            ink={ink}
            dark={dark}
            onPress={() => {
              if (editing()) leaveEdit();
            }}
          >
            <Image
              src={dark() ? "icon-eye-dark.svg" : "icon-eye-light.svg"}
              style={{ width: 16, height: 16 }}
            />
          </ToggleSeg>
          <ToggleSeg
            active={editing}
            ink={ink}
            dark={dark}
            onPress={() => {
              if (!editing()) enterEdit(caret());
            }}
          >
            <Image
              src={dark() ? "icon-edit-dark.svg" : "icon-edit-light.svg"}
              style={{ width: 16, height: 16 }}
            />
          </ToggleSeg>
        </View>
        </Show>
        <Focusable
          class={
            dark()
              ? "px-2 py-1 rounded-md focus:bg-[#1d242e]"
              : "px-2 py-1 rounded-md focus:bg-[#eceade]"
          }
          onPress={() => setMenuOpen(!menuOpen())}
        >
          <Text class="text-xs font-bold" style={{ textColor: ink().header }}>
            •••
          </Text>
        </Focusable>
      </View>

      {/* Content: untransformed clip + translated canvas (the IM contract). */}
      <Show
        when={editing()}
        fallback={
          <Focusable class="relative flex-1 overflow-hidden">
            <View
              class="absolute"
              style={{
                insetL: marginX(),
                width: contentW(),
                insetT: 0,
                height: viewLayout().total,
                translateY: -scrollV(),
              }}
            >
              <For each={visibleRows()}>
                {(entry) => (
                  <MdRow
                    row={entry.row}
                    ink={ink}
                    span={() => {
                      const sel = vsel();
                      return sel
                        ? rowSelSpan(viewLayout().rows, entry.i, sel.start, sel.end, textWidth)
                        : null;
                    }}
                  />
                )}
              </For>
            </View>
            {scrollbar(scrollV(), viewLayout().total)}
          </Focusable>
        }
      >
        <Focusable class="relative flex-1 overflow-hidden">
          <View
            class="absolute"
            style={{
              insetL: marginX(),
              width: contentW(),
              insetT: 0,
              height: editTotal(),
              translateY: -scrollE(),
            }}
          >
            <For each={visibleLines()}>
              {(line) => (
                <View
                  class="absolute left-0 right-0"
                  style={{ insetT: EDGE_PAD + line.index * editLineHeight(), height: editLineHeight() }}
                >
                  <Show when={lineSelRect(line) != null}>
                    <View
                      class="absolute rounded-sm"
                      style={{
                        insetL: lineSelRect(line)?.x0 ?? 0,
                        insetT: 1,
                        width: Math.max(
                          2,
                          (lineSelRect(line)?.x1 ?? 0) - (lineSelRect(line)?.x0 ?? 0),
                        ),
                        height: editLineHeight() - 2,
                        bgColor: ink().sel,
                      }}
                    />
                  </Show>
                  <Show when={preeditRect(line) != null}>
                    <View
                      class="absolute rounded-sm"
                      style={{
                        insetL: preeditRect(line)?.x0 ?? 0,
                        insetT: editLineHeight() - 3,
                        width: Math.max(
                          2,
                          (preeditRect(line)?.x1 ?? 0) - (preeditRect(line)?.x0 ?? 0),
                        ),
                        height: 2,
                        bgColor: ink().accent,
                      }}
                    />
                  </Show>
                  <Show when={!props.font}><Text
                    class="absolute text-sm"
                    style={{
                      insetL: 0,
                      insetT: 0,
                      height: editLineHeight(),
                      lineHeight: editLineHeight(),
                      textColor: ink().body,
                    }}
                  >
                    {displayDoc().slice(line.start, line.end)}
                  </Text></Show>
                </View>
              )}
            </For>
            <Show when={props.font}>
              <Text resource={runtimeResource()} class="absolute" style={{ insetL: 0, insetT: EDGE_PAD, textColor: ink().body }} />
            </Show>
            <Show when={runtimeError()}><Text class="text-xs" style={{ textColor: ink().dim }}>{runtimeError()}</Text></Show>
            <Show when={!editSel() && (!props.font || runtimeLayout())}>
              <Show
                when={caretResting()}
                fallback={
                  <View
                    class="absolute rounded-sm"
                    style={{
                      width: 2,
                      insetL: caretPx() - 1,
                      insetT: EDGE_PAD + caretRow() * editLineHeight() + (editLineHeight() - CARET_H) / 2,
                      height: CARET_H,
                      bgColor: ink().accent,
                    }}
                  />
                }
              >
                <View
                  class="absolute animate-caret rounded-sm"
                  style={{
                    width: 2,
                    insetL: caretPx() - 1,
                    insetT: EDGE_PAD + caretRow() * editLineHeight() + (editLineHeight() - CARET_H) / 2,
                    height: CARET_H,
                    bgColor: ink().accent,
                  }}
                />
              </Show>
            </Show>
          </View>
          {scrollbar(scrollE(), editTotal())}
        </Focusable>
      </Show>

      {/* Resize grip affordance (the widget host claims the corner drag;
          a real window resizes at its OS edges — no affordance to draw). */}
      <Show when={widgetChrome}>
      <View class="absolute" style={{ insetR: 4, insetB: 4, width: 12, height: 12 }}>
        <For each={[{ x: 8, y: 0 }, { x: 4, y: 4 }, { x: 8, y: 4 }, { x: 0, y: 8 }, { x: 4, y: 8 }, { x: 8, y: 8 }]}>
          {(d) => (
            <View
              class="absolute rounded-sm"
              style={{ insetL: d.x, insetT: d.y, width: 2, height: 2, bgColor: ink().dim }}
            />
          )}
        </For>
      </View>
      </Show>

      {/* The ••• menu: portal overlay, backdrop press closes. */}
      <Show when={menuOpen()}>
        <Portal>
          <Focusable class="absolute inset-0 bg-[#00000001]" onPress={() => setMenuOpen(false)} />
          <View
            class={
              dark()
                ? "absolute flex-col p-1 rounded-lg shadow-lg bg-[#171d25] w-[148]"
                : "absolute flex-col p-1 rounded-lg shadow-lg bg-[#ffffff] w-[148]"
            }
            style={{ insetT: HEADER_H, insetR: 8 }}
          >
            <Show when={canEdit}>
              <MenuItem
                label={editing() ? "Preview" : "Edit"}
                dark={dark()}
                color={ink().body}
                onPress={() => {
                  setMenuOpen(false);
                  if (editing()) leaveEdit();
                  else enterEdit(caret());
                }}
              />
            </Show>
            <MenuItem
              label={dark() ? "Light theme" : "Dark theme"}
              dark={dark()}
              color={ink().body}
              onPress={() => {
                setDark(!dark());
                setMenuOpen(false);
              }}
            />
            <MenuItem
              label="Reset note"
              dark={dark()}
              color={ink().body}
              onPress={() => {
                recordEdit(history, selState(), "other");
                setDoc(props.initialDocument ?? SAMPLE_DOC);
                setCaret(0);
                setAnchor(0);
                setVsel(null);
                setScrollV(0);
                setScrollE(0);
                markDirty();
                setMenuOpen(false);
              }}
            />
            {/* A real window closes from its titlebar / Cmd-W — the item is
                widget-shell chrome only. */}
            <Show when={widgetChrome}>
            <View style={{ height: 1, bgColor: ink().hr }} />
            <MenuItem
              label="Close widget"
              dark={dark()}
              color={ink().accent}
              onPress={() => {
                if (saveIn > 0) save();
                svc?.send({ t: "quit" });
                setMenuOpen(false);
              }}
            />
            </Show>
          </View>
        </Portal>
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Header toggle + icons (pure Views — the atlas has no icon glyphs)
// ---------------------------------------------------------------------------

function ToggleSeg(props: {
  active: () => boolean;
  ink: () => Ink;
  dark: () => boolean;
  onPress: () => void;
  children?: JSX.Element;
}): ReturnType<typeof View> {
  return (
    <Focusable
      class={
        props.dark()
          ? "rounded items-center justify-center w-[26] h-[20] focus:bg-[#242e3a]"
          : "rounded items-center justify-center w-[26] h-[20] focus:bg-[#e0ddd2]"
      }
      style={{ bgColor: props.active() ? (props.dark() ? "#2c3947" : "#ffffff") : "#00000000" }}
      onPress={props.onPress}
    >
      {props.children}
    </Focusable>
  );
}

function MenuItem(props: {
  label: string;
  dark: boolean;
  color: string;
  onPress: () => void;
}): ReturnType<typeof View> {
  return (
    <Focusable
      class={
        props.dark
          ? "px-2 py-1 rounded-md focus:bg-[#222b36]"
          : "px-2 py-1 rounded-md focus:bg-[#f0eee6]"
      }
      onPress={props.onPress}
    >
      <Text class="text-sm" style={{ textColor: props.color, lineHeight: 18 }}>
        {props.label}
      </Text>
    </Focusable>
  );
}

function MdRow(props: {
  row: ViewRow;
  ink: () => Ink;
  span: () => { x0: number; x1: number } | null;
}): ReturnType<typeof View> {
  const row = props.row;
  // Reactive selection highlight — mounted rows must follow a live drag,
  // so this is a <Show> over the span accessor, never a bare call child.
  const highlight = (
    <Show when={props.span() != null}>
      <View
        class="absolute rounded-sm"
        style={{
          insetL: props.span()?.x0 ?? 0,
          insetT: 0,
          width: Math.max(2, (props.span()?.x1 ?? 0) - (props.span()?.x0 ?? 0)),
          height: row.h,
          bgColor: props.ink().sel,
        }}
      />
    </Show>
  );
  if (row.kind === "hr") {
    return (
      <View
        class="absolute left-0 right-0"
        style={{ insetT: row.y + Math.floor(row.h / 2), height: 1, bgColor: props.ink().hr }}
      />
    );
  }
  if (row.kind === "code") {
    return (
      <View
        class="absolute left-0 right-0 rounded-md"
        style={{ insetT: row.y, height: row.h, bgColor: props.ink().codeBg }}
      >
        {highlight}
        <Text
          class="absolute text-sm font-mono"
          style={{ insetL: 8, insetT: 8, lineHeight: 18, textColor: props.ink().code }}
        >
          {row.text}
        </Text>
      </View>
    );
  }
  return (
    <View class="absolute left-0 right-0" style={{ insetT: row.y, height: row.h }}>
      {highlight}
      <Show when={row.bar}>
        {/* Unrounded so consecutive quote lines read as one bar. */}
        <View
          class="absolute"
          style={{ insetL: 0, insetT: 0, width: 3, height: row.h, bgColor: props.ink().bar }}
        />
      </Show>
      <For each={row.segs}>
        {(seg) => (
          <Text
            class={segFontClass(seg)}
            style={{
              insetL: row.indent + seg.x,
              insetT: 0,
              height: row.h,
              lineHeight: row.h,
              textColor: segColor(seg, props.ink()),
            }}
          >
            {seg.text}
          </Text>
        )}
      </For>
    </View>
  );
}
