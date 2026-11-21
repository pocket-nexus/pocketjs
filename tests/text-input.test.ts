// tests/text-input.test.ts — hardware text events (input.text): the frame's
// ninth argument reaches onTextEvent handlers newest first, and the open
// system keyboard session types what a real keyboard sends.

import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { TEXT_EVENT_KINDS } from "../contracts/spec/input.ts";
import { createOsk } from "../framework/src/osk-controller.ts";
import { __dispatchTextEvents, __resetTextInput, __setTextEvents, decodeTextEvent, onTextEvent, type TextEvent } from "../framework/src/text-input.ts";

const frame = (records: Parameters<typeof __setTextEvents>[0]) => {
  __setTextEvents(records);
  __dispatchTextEvents();
};

describe("decoding", () => {
  test("the wire kinds become the app-facing events", () => {
    expect(decodeTextEvent({ kind: TEXT_EVENT_KINDS.COMMIT, text: "ab" })).toEqual({ kind: "commit", text: "ab" });
    expect(decodeTextEvent({ kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Enter", repeat: true })).toEqual({ kind: "key", key: "Enter", pressed: true, repeat: true });
    expect(decodeTextEvent({ kind: TEXT_EVENT_KINDS.KEY_UP, text: "Enter" })).toEqual({ kind: "key", key: "Enter", pressed: false, repeat: false });
    expect(decodeTextEvent({ kind: TEXT_EVENT_KINDS.COMPOSITION, text: "ni", selectionStart: 0, selectionEnd: 2 })).toEqual({ kind: "composition", text: "ni", selectionStart: 0, selectionEnd: 2 });
    expect(decodeTextEvent({ kind: TEXT_EVENT_KINDS.COMPOSITION_END })).toEqual({ kind: "compositionEnd" });
    expect(decodeTextEvent({ kind: 99 })).toBeNull();
  });
});

describe("dispatch", () => {
  test("handlers run newest first and a true return consumes", () => {
    __resetTextInput();
    const seen: string[] = [];
    const first = onTextEvent((event) => void seen.push(`first:${event.kind}`));
    const second = onTextEvent((event) => {
      seen.push(`second:${event.kind}`);
      return event.kind === "commit";
    });
    frame([{ kind: TEXT_EVENT_KINDS.COMMIT, text: "a" }, { kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Enter" }]);
    expect(seen).toEqual(["second:commit", "second:key", "first:key"]);
    second();
    seen.length = 0;
    frame([{ kind: TEXT_EVENT_KINDS.COMMIT, text: "b" }]);
    expect(seen).toEqual(["first:commit"]);
    first();
    frame([{ kind: TEXT_EVENT_KINDS.COMMIT, text: "c" }]);
    expect(seen).toEqual(["first:commit"]);
  });

  test("a frame without events dispatches nothing and clears the last frame's", () => {
    __resetTextInput();
    const events: TextEvent[] = [];
    onTextEvent((event) => void events.push(event));
    __setTextEvents([{ kind: TEXT_EVENT_KINDS.COMMIT, text: "x" }]);
    __setTextEvents(undefined);
    __dispatchTextEvents();
    expect(events).toEqual([]);
  });
});

describe("the system keyboard session", () => {
  test("types, edits and commits from the keyboard while open", () => {
    __resetTextInput();
    const [value, setValue] = createSignal("");
    const committed: string[] = [];
    const osk = createOsk({ value, setValue, onCommit: (text) => committed.push(text), closeOnCommit: false });
    frame([{ kind: TEXT_EVENT_KINDS.COMMIT, text: "closed" }]);
    expect(value()).toBe("");
    osk.open();
    frame([{ kind: TEXT_EVENT_KINDS.COMMIT, text: "pock" }, { kind: TEXT_EVENT_KINDS.COMMIT, text: "ett" }]);
    expect(value()).toBe("pockett");
    frame([{ kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Backspace" }, { kind: TEXT_EVENT_KINDS.KEY_UP, text: "Backspace" }]);
    expect(value()).toBe("pocket");
    frame([{ kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Home" }, { kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Delete" }, { kind: TEXT_EVENT_KINDS.COMMIT, text: "P" }]);
    expect(value()).toBe("Pocket");
    frame([{ kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "ArrowLeft" }, { kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "End" }, { kind: TEXT_EVENT_KINDS.COMMIT, text: "!" }]);
    expect(value()).toBe("Pocket!");
    frame([{ kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Enter" }]);
    expect(committed).toEqual(["Pocket!"]);
    expect(osk.isOpen()).toBe(true);
    frame([{ kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Escape" }]);
    expect(osk.isOpen()).toBe(false);
    frame([{ kind: TEXT_EVENT_KINDS.COMMIT, text: "gone" }]);
    expect(value()).toBe("Pocket!");
  });

  test("a key the session does not edit with reaches the app's handler", () => {
    __resetTextInput();
    const keys: string[] = [];
    onTextEvent((event) => void (event.kind === "key" && event.pressed && keys.push(event.key)));
    const [value, setValue] = createSignal("");
    const osk = createOsk({ value, setValue });
    osk.open();
    frame([{ kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Tab" }, { kind: TEXT_EVENT_KINDS.KEY_DOWN, text: "Backspace" }]);
    expect(keys).toEqual(["Tab"]);
  });
});
