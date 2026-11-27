// platforms/web/browser-input.js — the browser's pointer, wheel and keyboard
// as PocketJS input facts (`AppInstance.stepInput`, programs/web/wasm
// web_advance).
//
// `createBrowserInput(element, options)` listens on `element` (the canvas the
// guest's pixels are shown in, or a layer above a page's own canvas) and
// returns `sample()`, which a frame loop calls once per guest turn. A sample
// holds what happened since the previous one:
//
//   - `pointer` (input.pointer): the position in logical px of the surface,
//     with no button down as well, and the held DOM buttons (bit 0 primary).
//     Runtime turns a held primary button into a contact, so `onPress`,
//     gestures and touch facts follow the mouse. Absent while the pointer is
//     outside the element.
//   - `scroll` (input.scroll): wheel and trackpad deltas summed since the last
//     sample, in logical px, positive toward the content's end as
//     WheelEvent.deltaY. Line and page deltas convert at 16 px a line and the
//     element's height a page.
//   - `text` (input.text, input.ime): key events named as KeyboardEvent.key,
//     with Control, Alt and Meta written first when held ("Control+z"); the
//     characters typed, as commits; and IME composition, from a hidden
//     textarea that keeps the keyboard focus while the element is used.
//
// `contacts: true` reports pointers as touch contacts instead of a pointer
// (a host without input.pointer). `buttons` maps KeyboardEvent.code to
// PocketJS button bits for hosts whose apps read buttons.

const LINE_PX = 16;

export function createBrowserInput(element, options = {}) {
  const {
    pointer: wantPointer = true,
    scroll: wantScroll = true,
    text: wantText = true,
    contacts: asContacts = false,
    buttons: buttonMap = {},
    viewport = () => [element.clientWidth, element.clientHeight],
  } = options;
  const doc = element.ownerDocument;
  const listeners = [];
  const on = (target, type, handler, opts) => { target.addEventListener(type, handler, opts); listeners.push([target, type, handler, opts]); };
  let position = null, held = 0, scrollX = 0, scrollY = 0;
  const textEvents = [], contacts = new Map(), cancellations = [], retired = new Set(), keys = new Set(), down = new Set();

  const logical = event => {
    const rect = element.getBoundingClientRect();
    const [w, h] = viewport();
    return { x: (event.clientX - rect.left) * w / (rect.width || 1), y: (event.clientY - rect.top) * h / (rect.height || 1) };
  };

  // The hidden textarea receives the keyboard so the OS keyboard layout and
  // IME produce text; it never shows and never keeps a value.
  let field = null;
  if (wantText) {
    field = doc.createElement("textarea");
    field.setAttribute("aria-hidden", "true");
    field.autocapitalize = "off";
    field.spellcheck = false;
    field.tabIndex = -1;
    Object.assign(field.style, { position: "fixed", left: "0px", top: "0px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", resize: "none", border: "0", padding: "0" });
    doc.body.appendChild(field);
    let composing = false;
    on(field, "compositionstart", () => { composing = true; });
    on(field, "compositionupdate", event => {
      const text = event.data ?? "";
      textEvents.push({ kind: "composition", text, selectionStart: text.length, selectionEnd: text.length });
    });
    on(field, "compositionend", event => {
      composing = false;
      textEvents.push({ kind: "compositionEnd" });
      if (event.data) textEvents.push({ kind: "commit", text: event.data });
      field.value = "";
    });
    on(field, "input", event => {
      if (composing || event.isComposing) return;
      if (event.data && (event.inputType === "insertText" || event.inputType === "insertFromPaste")) textEvents.push({ kind: "commit", text: event.data });
      field.value = "";
    });
    on(field, "paste", event => {
      const text = event.clipboardData?.getData("text/plain");
      if (text) { event.preventDefault(); textEvents.push({ kind: "commit", text }); }
    });
  }
  const focusField = () => { if (field && doc.activeElement !== field) field.focus({ preventScroll: true }); };

  const keyName = event => {
    let name = event.key;
    if (event.shiftKey && name.length > 1 && !["Shift"].includes(name)) name = `Shift+${name}`;
    if (event.metaKey && name !== "Meta") name = `Meta+${name}`;
    if (event.altKey && name !== "Alt") name = `Alt+${name}`;
    if (event.ctrlKey && name !== "Control") name = `Control+${name}`;
    return name;
  };
  const key = pressed => event => {
    if (event.isComposing || event.key === "Process" || event.key === "Unidentified") return;
    if (wantText) {
      const name = keyName(event);
      textEvents.push({ kind: "key", key: name, pressed, repeat: pressed && event.repeat });
      if (pressed) down.add(name); else down.delete(name);
    }
    if (buttonMap[event.code] !== undefined) { if (pressed) keys.add(event.code); else keys.delete(event.code); }
    // Tab stays in the application; the page's focus order does not move.
    if (event.key === "Tab" || buttonMap[event.code] !== undefined) event.preventDefault();
  };
  on(doc.defaultView, "keydown", key(true));
  on(doc.defaultView, "keyup", key(false));

  if (wantPointer || asContacts) {
    on(element, "pointerdown", event => {
      focusField();
      if (asContacts) {
        if (event.button !== 0 || contacts.size >= 8) return;
        const used = new Set([...contacts.values()].map(c => c.id).concat([...retired]));
        let id = 0; while (used.has(id)) id++;
        contacts.set(event.pointerId, { surface: 0, id, ...logical(event), cancelled: false });
      } else {
        position = logical(event);
        held = event.buttons;
      }
      element.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    on(element, "pointermove", event => {
      if (asContacts) { const c = contacts.get(event.pointerId); if (c) Object.assign(c, logical(event)); return; }
      position = logical(event);
      held = event.buttons;
    });
    const release = event => {
      if (asContacts) { const c = contacts.get(event.pointerId); if (c) retired.add(c.id); contacts.delete(event.pointerId); return; }
      position = logical(event);
      held = event.buttons;
    };
    on(element, "pointerup", release);
    on(element, "pointercancel", event => {
      if (asContacts) {
        const c = contacts.get(event.pointerId);
        if (c) { retired.add(c.id); cancellations.push({ ...c, cancelled: true }); }
        contacts.delete(event.pointerId);
        return;
      }
      held = 0;
    });
    on(element, "pointerleave", event => { if (!asContacts && event.buttons === 0) position = null; });
    on(element, "contextmenu", event => event.preventDefault());
  }
  if (wantScroll) {
    on(element, "wheel", event => {
      const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? viewport()[1] : 1;
      scrollX += event.deltaX * unit;
      scrollY += event.deltaY * unit;
      if (!position) position = logical(event);
      event.preventDefault();
    }, { passive: false });
  }
  on(doc.defaultView, "blur", () => {
    held = 0;
    // A key held while the window loses focus never sends its key-up here.
    for (const key of down) textEvents.push({ kind: "key", key, pressed: false, repeat: false });
    down.clear();
    for (const name of [...keys]) keys.delete(name);
    for (const c of contacts.values()) { retired.add(c.id); cancellations.push({ ...c, cancelled: true }); }
    contacts.clear();
  });

  return {
    /** Facts since the previous sample: { buttons, pointer?, scroll?, text?, contacts? }. */
    sample() {
      let buttons = 0;
      for (const code of keys) buttons |= buttonMap[code];
      const facts = { buttons };
      if (asContacts) {
        facts.contacts = [...contacts.values(), ...cancellations.splice(0)].map(c => ({ ...c }));
        retired.clear();
      } else if (position) {
        facts.pointer = { surface: 0, x: position.x, y: position.y, buttons: held };
      }
      if (scrollX !== 0 || scrollY !== 0) { facts.scroll = [scrollX, scrollY]; scrollX = 0; scrollY = 0; }
      if (textEvents.length) facts.text = textEvents.splice(0);
      return facts;
    },
    /** Put the hidden field at the caret (logical px) so the OS IME window docks beside it. */
    caret(x, y, h = 16) {
      if (!field) return;
      const rect = element.getBoundingClientRect();
      const [w, vh] = viewport();
      Object.assign(field.style, { left: `${rect.left + x * rect.width / w}px`, top: `${rect.top + y * rect.height / vh}px`, height: `${h}px` });
    },
    focus: focusField,
    dispose() {
      for (const [target, type, handler, opts] of listeners) target.removeEventListener(type, handler, opts);
      listeners.length = 0;
      field?.remove();
    },
  };
}
