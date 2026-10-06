// A handheld's controls on a page: its buttons and sticks from the keyboard
// and from the keys, the pad and the sticks of the shell the page shows
// (pocket3d-stage.js), and the contacts of pointers on a surface that takes
// touch. Nothing here knows a game: buttons are PocketJS's bits (the ones a
// guest's `frame` is handed), sticks are -1…1 with right and up positive,
// contacts are in a surface's logical pixels.
//
//   const controls = createControls();
//   controls.device({ sticks: 2, glyphs: "playstation" });   // what the keys stand for
//   controls.shell(stage.shell);                             // the shell's keys take pointers and show what is held
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
//
// A key that is held on the keyboard goes down on the shell too, and a stick
// the keys move slides there: the shell shows the device's state, whatever
// set it.
import { BTN } from "./pocketjs-host.js";
import { WORDS } from "./pocket3d-words.js";

const KEYS = {
  ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT,
  KeyZ: BTN.CIRCLE, Enter: BTN.CIRCLE, KeyX: BTN.CROSS, Backspace: BTN.CROSS, KeyC: BTN.SQUARE, KeyV: BTN.TRIANGLE,
  KeyQ: BTN.LTRIGGER, KeyE: BTN.RTRIGGER, Space: BTN.START, Escape: BTN.START, ShiftLeft: BTN.SELECT, ShiftRight: BTN.SELECT,
};
const DIAMOND = { KeyI: BTN.TRIANGLE, KeyK: BTN.CROSS, KeyJ: BTN.SQUARE, KeyL: BTN.CIRCLE };
const STICKS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyI", "KeyJ", "KeyK", "KeyL"];

/** A shell's control (`button` in ./shells/profiles.js) as PocketJS's bit. */
const BITS = {
  up: BTN.UP, down: BTN.DOWN, left: BTN.LEFT, right: BTN.RIGHT,
  triangle: BTN.TRIANGLE, circle: BTN.CIRCLE, cross: BTN.CROSS, square: BTN.SQUARE,
  l: BTN.LTRIGGER, r: BTN.RTRIGGER, start: BTN.START, select: BTN.SELECT,
};

/** What a face button is called: PlayStation's marks, or the letters of a Nintendo pad, by its place. */
export const FACES = {
  playstation: { top: "△", right: "○", bottom: "✕", left: "□" },
  letters: { top: "X", right: "A", bottom: "B", left: "Y" },
};

/**
 * The keys that stand for a device's controls, as short text for a page: `[["W A S D", "stick"], …]`, in
 * the words of a catalog of pocket3d-words.js (English when none is given).
 */
export function legend({ sticks, glyphs }, words = WORDS.en) {
  const face = FACES[glyphs] ?? FACES.playstation;
  if (!sticks) return [];
  const faces = sticks > 1
    ? [["I J K L", words.rightStick], ["Z X C V", `${face.right} ${face.bottom} ${face.left} ${face.top}`]]
    : [["I K J L", `${face.top} ${face.bottom} ${face.left} ${face.right}`]];
  return [["W A S D", sticks > 1 ? words.leftStick : words.stick], [words.arrows, words.dpad], ...faces, ["Q E", "L R"], ["Space", "START"], ["Shift", "SELECT"]];
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
    // (a control of the page that the keys have reached keeps its own keys: Enter opens it, Space presses it)
    if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea, [role='dialog']") && !event.target.closest("[data-pocket-shell]")) return;
    down.add(event.code);
    struck.add(event.code);
    // (the page does not scroll, and no control of it is pressed, under a key the device reads)
    event.preventDefault();
  });
  target.addEventListener("keyup", (event) => down.delete(event.code));
  window.addEventListener("blur", () => down.clear());

  // The shell's controls: bits held by pointers, and the two sticks.
  let pressed = 0;
  const sticks = { left: [0, 0], right: [0, 0] };
  let shell = null;
  // (what the shell last showed, so a frame that changes nothing writes nothing)
  let showing = { buttons: 0, left: "0,0", right: "0,0" };

  // Contacts on the touch surface, by pointer. One that lifts before two frames have seen it stays for them:
  // a tap is a contact that comes down, is there, and leaves.
  const contacts = new Map();
  let lifted = false;
  let untouch = () => {};

  const quiet = (event) => event.preventDefault();
  // A key of the shell: down while a pointer is on it.
  const bindButton = ({ button, el }) => {
    const bit = BITS[button] ?? 0;
    const hold = (on) => (event) => {
      event.preventDefault();
      if (on) el.setPointerCapture(event.pointerId);
      pressed = on ? pressed | bit : pressed & ~bit;
    };
    el.addEventListener("pointerdown", hold(true));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, hold(false));
    el.addEventListener("contextmenu", quiet);
    // (a click must not leave the keys with this element: the device has them)
    el.tabIndex = -1;
  };
  // The d-pad: the arms under the pointer, one or two, as a thumb that rolls from one to the next.
  const PAD = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;
  const bindPad = (el) => {
    const aim = (event) => {
      const box = el.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5, y = (event.clientY - box.top) / box.height - 0.5;
      let bits = 0;
      if (Math.hypot(x, y) > 0.07) {
        // (eight ways: an arm takes the 45 degrees about its own direction and shares the rest with its neighbour)
        const turn = Math.atan2(-y, x) / (Math.PI / 4);
        const way = ((Math.round(turn) % 8) + 8) % 8;
        bits = [BTN.RIGHT, BTN.RIGHT | BTN.UP, BTN.UP, BTN.UP | BTN.LEFT, BTN.LEFT, BTN.LEFT | BTN.DOWN, BTN.DOWN, BTN.DOWN | BTN.RIGHT][way];
      }
      pressed = (pressed & ~PAD) | bits;
    };
    el.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      aim(event);
    });
    el.addEventListener("pointermove", (event) => el.hasPointerCapture(event.pointerId) && aim(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, () => (pressed &= ~PAD));
    el.addEventListener("contextmenu", quiet);
  };
  // A stick: where the pointer is from its middle, to the edge of its place.
  const bindStick = ({ id, el }) => {
    const which = id === "right" ? "right" : "left";
    const move = (event) => {
      const box = el.getBoundingClientRect();
      const reach = box.width / 2;
      let x = (event.clientX - box.left - reach) / (reach * 0.6), y = (box.top + reach - event.clientY) / (reach * 0.6);
      const length = Math.hypot(x, y);
      if (length > 1) (x /= length), (y /= length);
      sticks[which] = [x, y];
    };
    el.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      move(event);
    });
    el.addEventListener("pointermove", (event) => el.hasPointerCapture(event.pointerId) && move(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, () => (sticks[which] = [0, 0]));
    el.addEventListener("contextmenu", quiet);
  };
  const bind = () => {
    pressed = 0;
    sticks.left = [0, 0];
    sticks.right = [0, 0];
    showing = { buttons: 0, left: "0,0", right: "0,0" };
    if (!shell) return;
    shell.buttons.forEach(bindButton);
    if (shell.pad) bindPad(shell.pad);
    shell.sticks.forEach(bindStick);
  };
  // The shell shows what is held, by the keys or by a pointer.
  const show = (buttons, left, right) => {
    if (!shell) return;
    const changed = buttons ^ showing.buttons;
    if (changed) {
      for (const name in BITS) if (changed & BITS[name]) shell.hold(name, Boolean(buttons & BITS[name]));
      showing.buttons = buttons;
    }
    for (const [id, value] of [["left", left], ["right", right]]) {
      const key = `${value[0].toFixed(2)},${value[1].toFixed(2)}`;
      if (key !== showing[id]) {
        shell.slide(id, value[0], value[1]);
        showing[id] = key;
      }
    }
  };

  return {
    /** What the keys stand for from now on: `sticks` is 0 for a device with no buttons at all, `glyphs`
     *  names its face buttons ("playstation" or "letters"). */
    device(next) {
      device = { ...device, ...next };
      down.clear();
      struck.clear();
      pressed = 0;
      sticks.left = [0, 0];
      sticks.right = [0, 0];
    },
    /**
     * The shell the page shows (`stage.shell` of pocket3d-stage.js): its keys, its d-pad and its sticks take
     * pointers from now on, and show what is held. The stage rebuilds them for each device; this binds the
     * new ones when it does.
     */
    shell(next) {
      shell = next;
      shell.onchange = bind;
      bind();
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
      show(buttons, left, right);
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
