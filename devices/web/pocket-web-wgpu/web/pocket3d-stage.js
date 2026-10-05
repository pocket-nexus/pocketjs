// A handheld's screens on a page: the canvas a game draws its scene into, a
// second screen under it for a device that has one, the device's buttons at
// its two sides for a browser without keys, and the choice of device as plain
// text. Nothing here knows a game or draws a device's case.
//
//   const stage = createStage(document.getElementById("stage"), canvas);
//   stage.show({ width: 400, height: 240, lower: [320, 240] });   // a device's screens, in their own pixels
//   stage.lower                    // the second screen's 2D context, when there is one
//   stage.left, stage.right        // where the device's buttons go (pocket3d-controls.js)
//   choices(element, [{ id, label }], current, pick)              // the devices, as text
//
// A screen's pixel is a whole number of the display's own, the largest that
// fits, as a device's own presentation of PocketJS scales (`integer-fit`).
// Where that would leave more than two fifths of the room unused, or the
// window is too small for one display pixel each, the screens are shown at
// the fraction that fits, smoothed.

/**
 * Builds the stage inside `root` around `canvas` (the scene's): `root` holds
 * the left hand's buttons, the screens one above the other, and the right
 * hand's buttons.
 */
export function createStage(root, canvas) {
  const make = (name) => {
    const el = document.createElement("div");
    el.dataset.pocketStage = name;
    return el;
  };
  const left = make("left"), screens = make("screens"), right = make("right");
  const second = document.createElement("canvas");
  second.hidden = true;
  second.dataset.pocketScreen = "lower";
  canvas.dataset.pocketScreen = "upper";
  screens.append(canvas, second);
  root.append(left, screens, right);
  const context = second.getContext("2d");
  let shown = { width: canvas.width, height: canvas.height, lower: undefined };

  const fit = () => {
    const { width, height, lower } = shown;
    const tall = height + (lower ? lower[1] : 0);
    // The room the screens have: the stage's, less what the buttons take beside them, or under them where
    // the page stacks them (`data-stacked` on the stage, set by the page for a window taller than wide).
    const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 0;
    const beside = left.offsetWidth + right.offsetWidth + (left.offsetWidth ? 2 * gap : 0);
    const under = Math.max(left.offsetHeight, right.offsetHeight) + (left.offsetHeight ? Number.parseFloat(getComputedStyle(root).rowGap) || 0 : 0);
    const stacked = root.hasAttribute("data-stacked");
    const pad = Number.parseFloat(getComputedStyle(root).paddingLeft) * 2 || 0;
    const room = stacked ? [root.clientWidth - pad, root.clientHeight - under] : [root.clientWidth - pad - beside, root.clientHeight];
    const dpr = window.devicePixelRatio || 1;
    const most = Math.min((room[0] * dpr) / width, (room[1] * dpr) / tall);
    const whole = Math.floor(most) >= 1 && Math.floor(most) / most >= 0.6;
    const scale = (whole ? Math.floor(most) : most) / dpr;
    for (const [el, w, h] of [[canvas, width, height], ...(lower ? [[second, lower[0], lower[1]]] : [])]) {
      el.style.width = `${w * scale}px`;
      el.style.height = `${h * scale}px`;
      // (a pixel that is a whole number of the display's is shown as it is; a fraction is smoothed)
      el.style.imageRendering = whole ? "pixelated" : "auto";
    }
    return scale;
  };
  new ResizeObserver(fit).observe(root);
  window.addEventListener("resize", fit);

  return {
    left,
    right,
    canvas,
    /** The second screen's canvas and its 2D context; hidden while the device has one screen. */
    second,
    lower: context,
    /**
     * A device's screens from now on, in their own pixels: the scene's canvas at `width` by `height`, and
     * `lower` (`[width, height]`) for a second screen under it. Sets the canvases' sizes.
     */
    show(next) {
      shown = next;
      if (canvas.width !== next.width || canvas.height !== next.height) {
        canvas.width = next.width;
        canvas.height = next.height;
      }
      second.hidden = !next.lower;
      if (next.lower) [second.width, second.height] = next.lower;
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
