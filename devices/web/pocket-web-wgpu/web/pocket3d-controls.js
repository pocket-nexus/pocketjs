// A handheld's controls on a page: its buttons and sticks from the keyboard
// and from buttons drawn on the page, and the contacts of pointers on a
// surface that takes touch. Nothing here knows a game: buttons are PocketJS's
// bits (the ones a guest's `frame` is handed), sticks are -1…1 with right and
// up positive, contacts are in a surface's logical pixels.
//
//   const controls = createControls();
//   controls.device({ sticks: 2, glyphs: "playstation" });   // what the keys and the buttons stand for
//   controls.buttonsIn(element);                             // buttons on the page, for a browser without keys
//   controls.touch(canvas, [480, 320]);                      // a pointer on it is a finger on the panel
//   …each frame:
//   const held = controls.read();     // { buttons, left: [x, y], right: [x, y], contacts: [{ id, x, y }] }
//   controls.next();                  // after the frame has used them
//
// The keys, for every device with buttons:
//
//   arrows        the d-pad                     Q, E          the shoulders, left and right
//   W A S D       the stick (the left one)      Space         START (Escape too)
//   Z, Enter      the face button at the right  Shift         SELECT
//   X, Backspace  the one at the bottom         C, V          the ones at the left and at the top
//   I J K L       the right stick of a device with two; on a device with one, the four face
//                 buttons by their place (I top, K bottom, J left, L right)
import { BTN } from "./pocketjs-host.js";

const KEYS = {
  ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT,
  KeyZ: BTN.CIRCLE, Enter: BTN.CIRCLE, KeyX: BTN.CROSS, Backspace: BTN.CROSS, KeyC: BTN.SQUARE, KeyV: BTN.TRIANGLE,
  KeyQ: BTN.LTRIGGER, KeyE: BTN.RTRIGGER, Space: BTN.START, Escape: BTN.START, ShiftLeft: BTN.SELECT, ShiftRight: BTN.SELECT,
};
const DIAMOND = { KeyI: BTN.TRIANGLE, KeyK: BTN.CROSS, KeyJ: BTN.SQUARE, KeyL: BTN.CIRCLE };
const STICKS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyI", "KeyJ", "KeyK", "KeyL"];

/** What a face button is called: PlayStation's marks, or the letters of a Nintendo pad, by its place. */
export const FACES = {
  playstation: { top: "△", right: "○", bottom: "✕", left: "□" },
  letters: { top: "X", right: "A", bottom: "B", left: "Y" },
};

/** The keys that stand for a device's controls, as short text for a page: `[["W A S D", "stick"], …]`. */
export function legend({ sticks, glyphs }) {
  const face = FACES[glyphs] ?? FACES.playstation;
  if (!sticks) return [];
  const faces = sticks > 1
    ? [["I J K L", "right stick"], ["Z X C V", `${face.right} ${face.bottom} ${face.left} ${face.top}`]]
    : [["I K J L", `${face.top} ${face.bottom} ${face.left} ${face.right}`]];
  return [["W A S D", sticks > 1 ? "left stick" : "stick"], ["arrows", "d-pad"], ...faces, ["Q E", "L R"], ["Space", "START"], ["Shift", "SELECT"]];
}

export function createControls(target = window) {
  let device = { sticks: 0, glyphs: "playstation" };
  // Keys held, and keys struck since the last frame: one struck and let go between two frames is held for
  // the frame that follows.
  const down = new Set();
  const struck = new Set();
  const key = (code) => down.has(code) || struck.has(code);
  target.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !device.sticks) return;
    if (!(event.code in KEYS) && !STICKS.includes(event.code)) return;
    down.add(event.code);
    struck.add(event.code);
    // (the page does not scroll, and no control of it is pressed, under a key the device reads)
    event.preventDefault();
  });
  target.addEventListener("keyup", (event) => down.delete(event.code));
  window.addEventListener("blur", () => down.clear());

  // Buttons on the page: bits held by pointers, and the two sticks.
  let pressed = 0;
  const sticks = { left: [0, 0], right: [0, 0] };
  let panel = null;

  // Contacts on the touch surface, by pointer. One that lifts before two frames have seen it stays for them:
  // a tap is a contact that comes down, is there, and leaves.
  const contacts = new Map();
  let lifted = false;
  let untouch = () => {};

  const button = (label, bit, area) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.dataset.pocketButton = label;
    el.style.gridArea = area;
    const hold = (on) => (event) => {
      event.preventDefault();
      if (on) el.setPointerCapture(event.pointerId);
      pressed = on ? pressed | bit : pressed & ~bit;
      el.toggleAttribute("data-held", on);
    };
    el.addEventListener("pointerdown", hold(true));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, hold(false));
    el.addEventListener("contextmenu", (event) => event.preventDefault());
    return el;
  };
  const stick = (name, which) => {
    const el = document.createElement("div");
    el.dataset.pocketStick = name;
    const knob = document.createElement("div");
    el.append(knob);
    const move = (event) => {
      const box = el.getBoundingClientRect();
      const reach = box.width / 2;
      let x = (event.clientX - box.left - reach) / (reach * 0.7), y = (box.top + reach - event.clientY) / (reach * 0.7);
      const length = Math.hypot(x, y);
      if (length > 1) (x /= length), (y /= length);
      sticks[which] = [x, y];
      knob.style.transform = `translate(${x * reach * 0.5}px, ${-y * reach * 0.5}px)`;
    };
    const rest = () => {
      sticks[which] = [0, 0];
      knob.style.transform = "";
    };
    el.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      move(event);
    });
    el.addEventListener("pointermove", (event) => el.hasPointerCapture(event.pointerId) && move(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, rest);
    return el;
  };
  const group = (name, areas, children) => {
    const el = document.createElement("div");
    el.dataset.pocketGroup = name;
    el.style.gridTemplateAreas = areas;
    el.append(...children);
    return el;
  };

  return {
    /** What the keys and the page's buttons stand for from now on: `sticks` is 0 for a device with no
     *  buttons at all, `glyphs` names its face buttons ("playstation" or "letters"). */
    device(next) {
      device = { ...device, ...next };
      down.clear();
      struck.clear();
      pressed = 0;
      sticks.left = [0, 0];
      sticks.right = [0, 0];
      if (panel) this.buttonsIn(panel.left, panel.right);
    },
    /**
     * Draws the device's buttons into two elements of the page, the left hand's and the right hand's, and
     * empties them for a device without buttons. The page styles them: every button is a `<button
     * data-pocket-button>`, a stick a `<div data-pocket-stick>` with its knob inside, in groups
     * `<div data-pocket-group>` laid out as grids.
     */
    buttonsIn(left, right) {
      panel = { left, right };
      left.replaceChildren();
      right.replaceChildren();
      if (!device.sticks) return;
      const face = FACES[device.glyphs] ?? FACES.playstation;
      // (each hand: the shoulder and a system button in a row, then what the thumb rests on)
      left.append(
        group("top", '"l select"', [button("L", BTN.LTRIGGER, "l"), button("SELECT", BTN.SELECT, "select")]),
        stick("stick", "left"),
        group("pad", '". up ." "left . right" ". down ."', [button("▲", BTN.UP, "up"), button("◀", BTN.LEFT, "left"), button("▶", BTN.RIGHT, "right"), button("▼", BTN.DOWN, "down")]),
      );
      right.append(
        group("top", '"start r"', [button("START", BTN.START, "start"), button("R", BTN.RTRIGGER, "r")]),
        group("faces", '". top ." "left . right" ". bottom ."', [button(face.top, BTN.TRIANGLE, "top"), button(face.left, BTN.SQUARE, "left"), button(face.right, BTN.CIRCLE, "right"), button(face.bottom, BTN.CROSS, "bottom")]),
        ...(device.sticks > 1 ? [stick("right stick", "right")] : []),
      );
    },
    /**
     * A pointer on `element` is a finger on a surface of `size` logical pixels from now on (one surface at
     * a time; `null` for a device whose screens take no touch).
     */
    touch(element, size) {
      untouch();
      contacts.clear();
      if (!element) return;
      const at = (event) => {
        const box = element.getBoundingClientRect();
        return [Math.max(0, Math.min(size[0] - 1, ((event.clientX - box.left) / box.width) * size[0])), Math.max(0, Math.min(size[1] - 1, ((event.clientY - box.top) / box.height) * size[1]))];
      };
      const downAt = (event) => {
        if (contacts.size >= 8 || (event.pointerType === "mouse" && event.button !== 0)) return;
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        // (a contact's number stays its own while it is down: the lowest one free, from 1)
        let id = 1;
        while ([...contacts.values()].some((c) => c.id === id)) id++;
        const [x, y] = at(event);
        contacts.set(event.pointerId, { id, x, y, seen: 0, up: false });
      };
      const moveAt = (event) => {
        const contact = contacts.get(event.pointerId);
        if (contact && !contact.up) [contact.x, contact.y] = at(event);
      };
      const upAt = (event) => {
        const contact = contacts.get(event.pointerId);
        if (contact) contact.up = true;
      };
      const none = (event) => event.preventDefault();
      element.addEventListener("pointerdown", downAt);
      element.addEventListener("pointermove", moveAt);
      element.addEventListener("pointerup", upAt);
      element.addEventListener("pointercancel", upAt);
      element.addEventListener("contextmenu", none);
      untouch = () => {
        element.removeEventListener("pointerdown", downAt);
        element.removeEventListener("pointermove", moveAt);
        element.removeEventListener("pointerup", upAt);
        element.removeEventListener("pointercancel", upAt);
        element.removeEventListener("contextmenu", none);
        untouch = () => {};
      };
    },
    /** The controls as they are held now. `touching`: a contact is down, or left since the last frame. */
    read() {
      let buttons = pressed;
      const axis = (less, more) => (key(more) ? 1 : 0) - (key(less) ? 1 : 0);
      const left = [...sticks.left], right = [...sticks.right];
      if (device.sticks) {
        for (const code in KEYS) if (key(code)) buttons |= KEYS[code];
        const keyed = [axis("KeyA", "KeyD"), axis("KeyS", "KeyW")];
        if (keyed[0] || keyed[1]) [left[0], left[1]] = keyed;
        if (device.sticks > 1) {
          const second = [axis("KeyJ", "KeyL"), axis("KeyK", "KeyI")];
          if (second[0] || second[1]) [right[0], right[1]] = second;
        } else for (const code in DIAMOND) if (key(code)) buttons |= DIAMOND[code];
      }
      const held = [...contacts.values()].map(({ id, x, y }) => ({ id, x, y }));
      return { buttons, left, right, contacts: held, touching: held.length > 0 || lifted };
    },
    /** The frame has used what `read` gave it. `turned`: the guest took its turn and saw the contacts. */
    next(turned = true) {
      struck.clear();
      lifted = false;
      if (!turned) return;
      for (const [pointer, contact] of contacts) {
        contact.seen++;
        if (contact.up && contact.seen >= 2) {
          contacts.delete(pointer);
          lifted = true;
        }
      }
    },
  };
}
