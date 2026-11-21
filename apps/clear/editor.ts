// In-place row editing: the caret-painted row text, the classic keyboard's
// handler wiring, the 15%-shade over the other rows, and the canvas lift
// that keeps the edited row above the keyboard. The host (app.tsx) supplies
// model/layout access; this module owns the editing state machine.

import { createIme, IME } from "@pocketjs/framework/ime";
import { hasCompanion } from "./remote-text.tsx";
import { animate } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { removeTodo, type Todo, type TodoList } from "./model.ts";
import { ROW_H, SCREEN_H } from "./metrics.ts";
import { makeKeyboard, type Keyboard } from "./keyboard.tsx";
import type { RowSlot } from "./rows.tsx";

export interface EditorHost {
  list(): TodoList;
  order(): Todo[];
  slots: RowSlot[];
  slotFor(todoId: number): RowSlot | undefined;
  scrollOffset(): number;
  canvas(): NodeMirror | null;
  layout(animated: boolean): void;
  report(): void;
}

export interface Editor {
  kb: Keyboard;
  editing(): Todo | null;
  open(todo: Todo, wasNew: boolean): void;
  close(commit: boolean): void;
  step(): void;
}

export function makeEditor(host: EditorHost): Editor {
  let editing: Todo | null = null;
  let editCaret = 0;
  let editOriginal = "";
  let editWasNew = false;
  let chinese = hasCompanion();
  let closeAfterComposition = false;
  let keyboardLift = NaN;

  function paintEditRow(): void {
    if (!editing) return;
    const slot = host.slotFor(editing.id);
    if (!slot) return;
    const t = editing.text;
    slot.text.value = `${t.slice(0, editCaret)}|${t.slice(editCaret)}`;
  }

  function shadeRows(shaded: boolean): void {
    const keep = editing ? host.slotFor(editing.id) : undefined;
    for (const slot of host.slots) {
      if (slot.todoId === -1 || slot.busy || !slot.front || slot === keep) continue;
      animate(slot.front, "opacity", shaded ? 0.15 : 1, { dur: 200, easing: "out" });
    }
  }

  function open(todo: Todo, wasNew: boolean): void {
    ime?.reset();
    closeAfterComposition = false;
    editing = todo;
    editWasNew = wasNew;
    editOriginal = todo.text;
    editCaret = todo.text.length;
    kb.setOpen(true);
    if (ime) kb.setIme(ime.state(), chinese);
    paintEditRow();
    shadeRows(true);
    keyboardLift = NaN;
    updateLift();
  }

  function updateLift(): void {
    if (!editing) return;
    const index = host.order().indexOf(editing);
    const rowBottom = index * ROW_H - host.scrollOffset() + ROW_H;
    const liftNeeded = Math.max(0, rowBottom - (SCREEN_H - kb.height()));
    if (liftNeeded === keyboardLift) return;
    keyboardLift = liftNeeded;
    const canvas = host.canvas();
    if (canvas) {
      animate(canvas, "translateY", -host.scrollOffset() - liftNeeded, { dur: 200, easing: "out" });
    }
  }

  function close(commit: boolean): void {
    const todo = editing;
    if (!todo) return;
    if (commit && ime?.composing()) {
      closeAfterComposition = true;
      ime.accept();
      return;
    }
    ime?.reset();
    closeAfterComposition = false;
    shadeRows(false);
    editing = null;
    kb.setOpen(false);
    const canvas = host.canvas();
    if (canvas) {
      animate(canvas, "translateY", -host.scrollOffset(), { dur: 200, easing: "out" });
    }
    if (commit) {
      todo.text = todo.text.trim();
      if (todo.text === "") removeTodo(host.list(), todo);
      else host.report();
    } else if (editWasNew) {
      removeTodo(host.list(), todo);
    } else {
      todo.text = editOriginal;
    }
    host.layout(true);
  }

  function insert(text: string): void {
    if (!editing) return;
    const room = 40 - Array.from(editing.text).length;
    const next = Array.from(text).slice(0, Math.max(0, room)).join("");
    editing.text = editing.text.slice(0, editCaret) + next + editing.text.slice(editCaret);
    editCaret += next.length;
    paintEditRow();
  }
  function backspace(): void {
    if (!editing || editCaret === 0) return;
    const prefix = Array.from(editing.text.slice(0, editCaret));
    const count = prefix.pop()!.length;
    editing.text = prefix.join("") + editing.text.slice(editCaret);
    editCaret -= count;
    paintEditRow();
  }
  function moveCaret(direction: number): void {
    if (!editing) return;
    if (direction < 0) editCaret -= Array.from(editing.text.slice(0, editCaret)).pop()?.length ?? 0;
    else editCaret += Array.from(editing.text.slice(editCaret))[0]?.length ?? 0;
    paintEditRow();
  }
  const ime = hasCompanion() ? createIme({
    changed: state => kb.setIme(state, chinese),
    commit: insert,
    edit: action => { if (action === "backspace") backspace(); else moveCaret(action === "left" ? -1 : 1); },
  }) : undefined;
  const kb = makeKeyboard({
    onInsert(ch) {
      if (!editing) return;
      if (chinese && ime && (/^[a-z']$/.test(ch) || ime.composing())) {
        if (ch === " ") ime.accept();
        else ime.key(ch.charCodeAt(0));
      } else insert(ch);
    },
    onBackspace() { if (ime?.composing()) ime.key(IME.backspace); else backspace(); },
    onEnter() { if (ime?.composing()) ime.accept(); else close(true); },
    onMode() {
      if (!ime) return;
      if (ime.composing()) ime.commitRaw();
      chinese = !chinese;
      kb.setIme(ime.state(), chinese);
    },
    onCandidate(index) { ime?.select(index); },
    onCandidateAbsolute(index) { ime?.selectAbsolute(index); },
    onBrowse(offset, complete) { return ime?.browse(offset, complete) ?? 0; },
    onCancelComposition() { ime?.reset(); closeAfterComposition = false; },
    onCaret(direction) {
      if (ime?.composing()) { ime.key(direction < 0 ? IME.left : IME.right); return; }
      moveCaret(direction);
    },
  });
  function step() {
    ime?.step();
    updateLift();
    if (closeAfterComposition && ime && !ime.composing()) close(true);
  }
  return { kb, editing: () => editing, open, close, step };
}
