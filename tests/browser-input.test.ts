// platforms/web/browser-input.js turns DOM pointer, wheel and keyboard events
// into the facts AppInstance.stepInput takes. The DOM here is a stand-in made
// of EventTargets: the module reads only the fields these events carry.
import { expect, test } from "bun:test";
import { createBrowserInput } from "../platforms/web/browser-input.js";

function page() {
  const view = new EventTarget();
  const field = Object.assign(new EventTarget(), { style: {}, value: "", focus() { doc.activeElement = field; }, remove() {}, setAttribute() {} });
  const doc: any = { defaultView: view, activeElement: null, body: { appendChild() {} }, createElement: () => field };
  const element = Object.assign(new EventTarget(), {
    ownerDocument: doc, clientWidth: 400, clientHeight: 300,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
    setPointerCapture() {},
  });
  const fire = (target: EventTarget, type: string, fields: Record<string, unknown> = {}) =>
    target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields));
  return { element, field, view, fire };
}

test("pointer, wheel and keyboard become one sample of facts", () => {
  const { element, field, view, fire } = page();
  const input = createBrowserInput(element as unknown as HTMLElement, { viewport: () => [400, 300] });
  fire(element, "pointermove", { clientX: 410, clientY: 320, buttons: 0 });
  fire(element, "wheel", { deltaX: 0, deltaY: 3, deltaMode: 1, clientX: 410, clientY: 320 });
  fire(view, "keydown", { key: "w", code: "KeyW", repeat: false });
  fire(field, "input", { data: "w", inputType: "insertText" });
  fire(view, "keydown", { key: "s", code: "KeyS", ctrlKey: true, repeat: false });
  fire(field, "compositionstart");
  fire(field, "compositionupdate", { data: "dao" });
  fire(field, "input", { data: "dao", inputType: "insertCompositionText", isComposing: true });
  fire(field, "compositionend", { data: "岛" });
  fire(view, "keyup", { key: "w", code: "KeyW" });
  // Logical px of a 400 x 300 surface shown at 800 x 600 CSS px.
  expect(input.sample()).toEqual({
    buttons: 0,
    pointer: { surface: 0, x: 200, y: 150, buttons: 0 },
    scroll: [0, 48],
    text: [
      { kind: "key", key: "w", pressed: true, repeat: false },
      { kind: "commit", text: "w" },
      { kind: "key", key: "Control+s", pressed: true, repeat: false },
      { kind: "composition", text: "dao", selectionStart: 3, selectionEnd: 3 },
      { kind: "compositionEnd" },
      { kind: "commit", text: "岛" },
      { kind: "key", key: "w", pressed: false, repeat: false },
    ],
  });
  // A sample takes what happened since the previous one; the pointer stays.
  expect(input.sample()).toEqual({ buttons: 0, pointer: { surface: 0, x: 200, y: 150, buttons: 0 } });
  fire(element, "pointerdown", { clientX: 30, clientY: 40, buttons: 1, button: 0, pointerId: 1 });
  expect(input.sample().pointer).toEqual({ surface: 0, x: 10, y: 10, buttons: 1 });
  fire(element, "pointerup", { clientX: 30, clientY: 40, buttons: 0, pointerId: 1 });
  fire(element, "pointerleave", { buttons: 0 });
  expect(input.sample().pointer).toBeUndefined();
  input.dispose();
});

test("contacts and button bits serve hosts without a pointer", () => {
  const { element, view, fire } = page();
  const input = createBrowserInput(element as unknown as HTMLElement, { contacts: true, text: false, buttons: { ArrowUp: 16 }, viewport: () => [400, 300] });
  fire(view, "keydown", { key: "ArrowUp", code: "ArrowUp" });
  fire(element, "pointerdown", { clientX: 410, clientY: 320, button: 0, pointerId: 7 });
  expect(input.sample()).toEqual({ buttons: 16, contacts: [{ surface: 0, id: 0, x: 200, y: 150, cancelled: false }] });
  fire(element, "pointercancel", { pointerId: 7 });
  expect(input.sample().contacts).toEqual([{ surface: 0, id: 0, x: 200, y: 150, cancelled: true }]);
  input.dispose();
});
