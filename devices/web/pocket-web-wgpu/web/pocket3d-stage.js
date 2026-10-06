// A handheld on a page: its shell, with the canvas a game draws its scene
// into where the shell's screen is, a second screen for a device that has
// one, and the shell's own keys, pads and sticks as the controls. Nothing
// here knows a game.
//
//   const stage = createStage(document.getElementById("stage"), canvas);
//   stage.show({ device: "3ds", width: 400, height: 240, lower: [320, 240] });   // a device's screens, in their own pixels
//   stage.lower                    // the second screen's 2D context, when there is one
//   stage.shell                    // the shell's controls, for pocket3d-controls.js (`controls.shell(stage.shell)`)
//   choices(element, [{ id, label }], current, pick)              // the devices, as text
//
// The shells are pictures (./shells/*.webp) with a profile each
// (./shells/profiles.js): where the screens are, where each control is, and
// which part moves with it. A shell is two pictures: the case with its moving
// parts taken out, and a sheet of those parts, each rendered alone. A key
// that is held goes down into its socket; a stick's cap slides in its well.
// A device without a profile is shown as its screens alone. A shell with no
// key (a touch panel's) is stood up for a screen taller than wide: its picture
// a quarter turned, its rectangles with it.
//
// pocket3d-stage.css lays these out: a page links it. The elements are found
// by the `data-pocket-*` attributes this module sets.
//
// A screen's pixel is a whole number of the display's own, the largest at
// which the whole shell fits, as a device's own presentation of PocketJS
// scales (`integer-fit`). Where that would make the shell less than three
// quarters of the size that fits (nine tenths, in a window narrower than 900
// CSS pixels), or the window is too small for one display pixel each, the
// shell is shown at the fraction that fits, smoothed.
import { SHELLS } from "./shells/profiles.js";

/**
 * A shell a quarter turn clockwise: a point (x, y) of its picture goes to (height - y, x), so what was at
 * the picture's right is at the bottom. `standing` says its picture is to be drawn turned.
 */
export function stoodUp(shell) {
  const turn = ([x, y, w, h, ...rest]) => [shell.height - y - h, x, h, w, ...rest];
  return { ...shell, standing: true, width: shell.height, height: shell.width, screens: Object.fromEntries(Object.entries(shell.screens).map(([name, rect]) => [name, turn(rect)])) };
}

/**
 * The shell a device is shown in, for screens of `width` by `height` (and `lower`): its profile as it
 * lies in ./shells/profiles.js, or stood up when the screen is taller than wide, the picture's screen is
 * wider than tall and the shell has no key, stick or moving part (those would have to turn too). Null for
 * a device without a profile.
 */
export function shellFor(device, { width, height, lower } = {}) {
  const shell = SHELLS[device] ?? null;
  if (!shell) return null;
  const keyless = !shell.controls.length && !shell.sticks.length && !shell.parts.length && !lower;
  return keyless && height > width && shell.screens.upper[2] > shell.screens.upper[3] ? stoodUp(shell) : shell;
}

const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const NAMES = { up: "Up", down: "Down", left: "Left", right: "Right", triangle: "Top face button", circle: "Right face button", cross: "Bottom face button", square: "Left face button", l: "L", r: "R", start: "START", select: "SELECT" };
const percent = (part, whole) => `${(part / whole) * 100}%`;

/**
 * Builds the stage inside `root` around `canvas` (the scene's): the shell, the screens in it and its controls.
 */
export function createStage(root, canvas) {
  root.dataset.pocketStage = "root";
  const shell = document.createElement("div");
  shell.dataset.pocketShell = "";
  const art = new Image();
  art.alt = "";
  art.draggable = false;
  art.decoding = "async";
  art.dataset.pocketShellArt = "";
  const second = document.createElement("canvas");
  second.hidden = true;
  second.dataset.pocketScreen = "lower";
  canvas.dataset.pocketScreen = "upper";
  const moving = document.createElement("div");
  moving.dataset.pocketShellParts = "";
  shell.append(art, canvas, second, moving);
  root.append(shell);
  const context = second.getContext("2d");
  let shown = { device: "", width: canvas.width, height: canvas.height, lower: undefined };
  let profile = null;
  // What pocket3d-controls.js binds and moves: rebuilt for each device.
  const controls = { buttons: [], pad: null, sticks: [], hold() {}, slide() {}, onchange: null };

  // A screen in a rectangle of the shell's picture: as large as fits, in the middle.
  const within = (rect, width, height) => {
    const scale = Math.min(rect[2] / width, rect[3] / height);
    return [rect[0] + (rect[2] - width * scale) / 2, rect[1] + (rect[3] - height * scale) / 2, width * scale, height * scale];
  };
  const place = (el, rect) => {
    el.style.left = percent(rect[0], profile.width);
    el.style.top = percent(rect[1], profile.height);
    el.style.width = percent(rect[2], profile.width);
    el.style.height = percent(rect[3], profile.height);
  };

  const build = () => {
    moving.replaceChildren();
    controls.buttons = [];
    controls.pad = null;
    controls.sticks = [];
    controls.hold = () => {};
    controls.slide = () => {};
    if (!profile) return;
    // The parts, each a window on the parts' picture.
    const sheet = profile.partsArt ? `url("${new URL(`./shells/${profile.partsArt}`, import.meta.url).href}")` : "none";
    const parts = profile.parts.map((rect, index) => {
      const el = document.createElement("div");
      el.dataset.pocketPart = String(index);
      place(el, rect);
      el.style.backgroundImage = sheet;
      el.style.backgroundSize = `${(profile.partsWidth / rect[2]) * 100}% ${(profile.partsHeight / rect[3]) * 100}%`;
      el.style.backgroundPosition = `${(rect[4] / (profile.partsWidth - rect[2])) * 100}% ${(rect[5] / (profile.partsHeight - rect[3])) * 100}%`;
      moving.append(el);
      return { el, held: new Set() };
    });
    const users = profile.controls.reduce((count, c) => (c.part === null ? count : count.set(c.part, (count.get(c.part) ?? 0) + 1)), new Map());
    for (const c of profile.controls) {
      if (c.part === null) continue;
      // (one moulded cross rocks under a thumb; a key of its own goes straight down; a shoulder key goes in from the edge)
      parts[c.part].el.dataset.pocketPartKind = users.get(c.part) > 1 ? "rocker" : c.button === "l" || c.button === "r" ? "shoulder" : "key";
    }

    // The d-pad is one place for a thumb: where it rests says which arms are down.
    const arms = profile.controls.filter((c) => c.button in DIRECTIONS);
    if (arms.length === 4) {
      const x0 = Math.min(...arms.map((c) => c.rect[0])), y0 = Math.min(...arms.map((c) => c.rect[1]));
      const x1 = Math.max(...arms.map((c) => c.rect[0] + c.rect[2])), y1 = Math.max(...arms.map((c) => c.rect[1] + c.rect[3]));
      const grow = (x1 - x0) * 0.08;
      const el = document.createElement("div");
      el.dataset.pocketPad = "";
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", "Directional pad");
      place(el, [x0 - grow, y0 - grow, x1 - x0 + 2 * grow, y1 - y0 + 2 * grow]);
      moving.append(el);
      controls.pad = el;
    }
    for (const c of profile.controls) {
      if (c.button in DIRECTIONS && controls.pad) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.dataset.pocketControl = c.button;
      el.setAttribute("aria-label", NAMES[c.button] ?? c.button);
      // (a finger is wider than a key: the place that takes it is a fifth larger each way)
      const grow = Math.min(c.rect[2], c.rect[3]) * 0.2;
      place(el, [c.rect[0] - grow, c.rect[1] - grow, c.rect[2] + 2 * grow, c.rect[3] + 2 * grow]);
      // A key with no picture of its own (it is out of sight from the front) is its name.
      if (c.part === null) el.textContent = NAMES[c.button] ?? c.button;
      moving.append(el);
      controls.buttons.push({ button: c.button, el });
    }
    for (const s of profile.sticks) {
      const el = document.createElement("div");
      el.dataset.pocketStick = s.id;
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", profile.sticks.length > 1 ? `${s.id === "left" ? "Left" : "Right"} stick` : "Stick");
      const reach = s.radius * 1.7;
      place(el, [s.centre[0] - reach, s.centre[1] - reach, 2 * reach, 2 * reach]);
      moving.append(el);
      controls.sticks.push({ id: s.id, el });
    }

    const byButton = new Map(profile.controls.map((c) => [c.button, c]));
    const marked = new Map(controls.buttons.map((b) => [b.button, b.el]));
    controls.hold = (button, on) => {
      const c = byButton.get(button);
      if (!c) return;
      marked.get(button)?.toggleAttribute("data-held", on);
      if (c.part === null) return;
      const part = parts[c.part];
      on ? part.held.add(button) : part.held.delete(button);
      part.el.toggleAttribute("data-held", part.held.size > 0);
      // (a rocker leans toward what is held on it)
      let lean = [0, 0];
      for (const name of part.held) lean = [lean[0] + (DIRECTIONS[name]?.[0] ?? 0), lean[1] + (DIRECTIONS[name]?.[1] ?? 0)];
      part.el.style.setProperty("--lean-x", String(lean[0]));
      part.el.style.setProperty("--lean-y", String(lean[1]));
    };
    const caps = new Map(profile.sticks.map((s) => [s.id, { part: parts[s.part], rect: profile.parts[s.part], travel: s.travel }]));
    controls.slide = (id, x, y) => {
      const cap = caps.get(id);
      if (!cap) return;
      // (in the part's own size, so it holds at any scale; up on a stick is up on the page)
      cap.part.el.style.transform = x || y ? `translate(${(x * cap.travel * 100) / cap.rect[2]}%, ${(-y * cap.travel * 100) / cap.rect[3]}%)` : "";
      cap.part.el.toggleAttribute("data-held", Boolean(x || y));
    };
    for (const s of profile.sticks) parts[s.part].el.dataset.pocketPartKind = "cap";
  };

  const fit = () => {
    const { width, height, lower } = shown;
    const dpr = window.devicePixelRatio || 1;
    const style = getComputedStyle(root);
    const room = [root.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight), root.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)];
    // The whole thing in the scene's pixels: the shell around its screen, or the screens one above the other.
    let size, upper, under;
    if (profile) {
      upper = within(profile.screens.upper, width, height);
      under = lower && profile.screens.lower ? within(profile.screens.lower, lower[0], lower[1]) : null;
      const perPixel = upper[2] / width;
      size = [profile.width / perPixel, profile.height / perPixel];
    } else {
      size = [Math.max(width, lower ? lower[0] : 0), height + (lower ? lower[1] : 0)];
    }
    const most = Math.min((room[0] * dpr) / size[0], (room[1] * dpr) / size[1]);
    const keep = root.clientWidth >= 900 ? 0.75 : 0.9;
    const whole = Math.floor(most) >= 1 && Math.floor(most) / most >= keep;
    const scale = Math.max(0, whole ? Math.floor(most) : most) / dpr;
    shell.style.width = `${size[0] * scale}px`;
    shell.style.height = `${size[1] * scale}px`;
    // (a hundredth of the shell's width, for what is written on it)
    shell.style.setProperty("--pocket-shell-unit", `${(size[0] * scale) / 100}px`);
    shell.style.translate = "";
    const rendering = whole ? "pixelated" : "auto";
    if (profile) {
      place(canvas, upper);
      if (under) place(second, under);
    } else {
      for (const [el, w, h, top] of [[canvas, width, height, 0], ...(lower ? [[second, lower[0], lower[1], height]] : [])]) {
        el.style.left = `${((size[0] - w) / 2) * scale}px`;
        el.style.top = `${top * scale}px`;
        el.style.width = `${w * scale}px`;
        el.style.height = `${h * scale}px`;
      }
    }
    canvas.style.imageRendering = second.style.imageRendering = rendering;
    // A screen whose pixels are whole display pixels starts on one: the shell moves by the part of a pixel it is off.
    if (whole) {
      const at = canvas.getBoundingClientRect();
      shell.style.translate = `${Math.round(at.left * dpr) / dpr - at.left}px ${Math.round(at.top * dpr) / dpr - at.top}px`;
    }
    return scale;
  };
  new ResizeObserver(fit).observe(root);
  window.addEventListener("resize", fit);

  return {
    canvas,
    /** The second screen's canvas and its 2D context; hidden while the device has one screen. */
    second,
    lower: context,
    /** The shell's controls as elements, and what shows one held or a stick moved (pocket3d-controls.js). */
    shell: controls,
    /**
     * A device's screens from now on, in their own pixels: the scene's canvas at `width` by `height`, and
     * `lower` (`[width, height]`) for a second screen. `device` names its shell (`SHELLS` in
     * ./shells/profiles.js: "psp", "vita", "3ds", "ipod"); without one the screens stand alone.
     * Sets the canvases' sizes.
     */
    show(next) {
      const chosen = shellFor(next.device, next);
      const changed = next.device !== shown.device || Boolean(chosen?.standing) !== Boolean(profile?.standing);
      shown = next;
      if (canvas.width !== next.width || canvas.height !== next.height) {
        canvas.width = next.width;
        canvas.height = next.height;
      }
      second.hidden = !next.lower;
      if (next.lower) [second.width, second.height] = next.lower;
      if (changed) {
        profile = chosen;
        shell.dataset.pocketShell = profile ? next.device : "";
        // (a shell that stands: the picture lies on its side, so it is drawn at its own size about the
        // shell's middle and turned, which pocket3d-stage.css does)
        shell.toggleAttribute("data-pocket-standing", Boolean(profile?.standing));
        art.style.width = profile?.standing ? percent(profile.height, profile.width) : "";
        art.style.height = profile?.standing ? percent(profile.width, profile.height) : "";
        if (profile) {
          // (the case comes in when its picture has: until then the screens stand where they will)
          shell.toggleAttribute("data-loading", true);
          art.hidden = false;
          art.onload = art.onerror = () => shell.removeAttribute("data-loading");
          art.src = new URL(`./shells/${profile.art}`, import.meta.url).href;
        } else {
          art.hidden = true;
          art.removeAttribute("src");
        }
        build();
        controls.onchange?.();
      }
      return fit();
    },
    fit,
  };
}

/**
 * The devices a page offers, as plain text in `element`: one `<button>` each, the current one marked
 * `aria-pressed`. `pick(id)` is called for another; the mark moves when `set(id)` is.
 */
export function choices(element, list, current, pick) {
  element.dataset.pocketChoices = "";
  const buttons = new Map();
  for (const { id, label } of list) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", () => {
      // (the keys go back to the device, not to this button)
      el.blur();
      if (el.getAttribute("aria-pressed") !== "true") pick(id);
    });
    buttons.set(id, el);
    element.append(el);
  }
  const set = (id) => {
    for (const [key, el] of buttons) el.setAttribute("aria-pressed", String(key === id));
  };
  set(current);
  return { set };
}
