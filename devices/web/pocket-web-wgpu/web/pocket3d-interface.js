// A Pocket3D game's interface on a page: the PocketJS guest that draws it, in
// a realm of its own, and what passes between it and the game.
//
// The realm is PocketJS's AppInstance (hosts/web/app-instance.html): a hidden
// frame of the page with its own globals and its own instance of the UI core
// (pocketjs.wasm), started without the text worker. The guest is the bundle
// the game's build wrote for a device, as that device loads it. It opens the
// service it opens there (`pocket.overlay`), and the page carries the lines.
//
//   const ui = await openInterface({ realm, wasm, bundle, pak, plan });
//   …each frame, after the game's own step:
//   if (line) ui.send(line);                  // the game's state, as the guest's service delivers it
//   ui.turn(buttons, contacts, ticks);        // the guest's turn
//   for (const line of ui.drain()) …          // what the guest asks of the game
//   if (ui.changed()) upload(ui.picture());   // premultiplied RGBA, when what it shows has changed
//   if (ui.lowerChanged()) paint(ui.lower()); // a second screen's opaque RGBA
//
// `plan` is the build plan PocketJS wrote for the device the bundle is for
// (plan.json): the surfaces, the raster density and which surface takes touch
// are read from it, so a page that offers several devices holds no table of
// its own.
import { __packTouch, createTouchHitFacts } from "./pocketjs-host.js";

/** What a plan says of the screens: sizes in logical pixels. */
export function screens(plan) {
  const primary = plan.modality.screens.find((s) => s.role === "primary");
  const auxiliary = plan.modality.screens.find((s) => s.role === "auxiliary");
  return {
    viewport: plan.viewport.logical,
    density: plan.viewport.rasterDensity,
    /** The primary surface in the pixels it is drawn with. */
    physical: plan.viewport.physical,
    auxiliary: auxiliary?.logical,
    /** The surface a contact lands on: "primary", "auxiliary" or "none". */
    touch: primary?.touch ? "primary" : auxiliary?.touch ? "auxiliary" : "none",
    buttons: plan.modality.buttons,
    /** The family the device's face buttons are named in: "playstation" or "letters". */
    glyphs: plan.modality.glyphs,
  };
}

/**
 * What a page does with a started AppInstance (`instance`, the object
 * `PocketAppInstance.create` resolves): turns, lines, and its pictures when
 * they have changed. `close` ends the realm.
 */
export function attach(instance, plan, close = () => {}) {
  const shape = screens(plan);
  const surface = shape.touch === "auxiliary" ? 1 : 0;
  // A contact's node is found once, where it comes down (PocketJS's touch hit facts).
  const facts = createTouchHitFacts((x, y) => instance.hitTestBounds(x, y, shape.touch === "auxiliary" ? "auxiliary" : "primary"));
  let shown = null;
  let shownLower = null;
  return {
    plan,
    ...shape,
    /** A line for the guest's next turn. */
    send: (line) => instance.sendService(line.endsWith("\n") ? line.slice(0, -1) : line),
    /** The lines the guest sent since the last call. */
    drain: () => instance.drainService(),
    /**
     * One turn of the guest: `buttons` are PocketJS's bits; `contacts` are
     * `{ id, x, y }` on the touch surface, in its logical pixels. The UI core
     * then advances `ticks` sixtieths of a second.
     */
    turn(buttons, contacts, ticks = 1) {
      const packed = contacts.length ? contacts.map((c) => __packTouch(c.id, Math.round(c.x), Math.round(c.y))) : undefined;
      instance.step(buttons, packed, facts(packed), packed?.map(() => surface), ticks);
    },
    /** Whether the primary surface shows something else than at the last `picture()`. */
    changed: () => instance.drawHash() !== shown,
    /**
     * The primary surface as the UI core rasterizes it with coverage:
     * premultiplied RGBA rows, `width` by `height`, alpha 0 where the
     * interface draws nothing. `pixels` is the core's own buffer, good until
     * the next `picture()`.
     */
    picture() {
      shown = instance.drawHash();
      const pixels = instance.renderPremultiplied(shape.density);
      if (!pixels) throw new Error("this pocketjs.wasm has no premultiplied render: build it again (bun tools/wasm.ts)");
      return { pixels, width: shape.physical[0], height: shape.physical[1] };
    },
    /** Whether the second screen shows something else than at the last `lower()`. */
    lowerChanged: () => shape.auxiliary !== undefined && instance.drawHashAuxiliary() !== shownLower,
    /** The second screen as opaque RGBA rows (the core's own buffer), one sample a logical pixel. */
    lower() {
      shownLower = instance.drawHashAuxiliary();
      return instance.renderAuxiliary();
    },
    /** Ends the guest and its realm. */
    close() {
      instance.dispose();
      close();
    },
  };
}

/**
 * What the realm is started with (`PocketAppInstance.create`) for the guest
 * of `bundle` and `pak` on the device of `plan`.
 */
export function realmOptions({ wasm, bundle, pak, plan, service = "pocket.overlay", simHz }) {
  const shape = screens(plan);
  return {
    packageId: plan.app.id,
    viewport: shape.viewport,
    rasterDensity: shape.density,
    auxiliary: shape.auxiliary,
    wasmUrl: wasm,
    bundleUrl: bundle,
    pakUrl: pak,
    companions: [service],
    simHz,
    // An interface's glyphs are baked: the realm starts no text worker.
    text: false,
  };
}

/**
 * Starts the guest of `bundle` and `pak` for the device of `plan`, in a
 * hidden frame that loads `realm` (PocketJS's app-instance.html). Resolves
 * when the guest has run its first lines and opened `service`.
 *
 * `simHz` is the turns a second the game gives the guest while it takes
 * every one, published to it as `globalThis.__simHz` before its bundle
 * runs, as a device's host does. The framework's clock counts a turn as
 * `1 / simHz` seconds: a game that turns its guest 30 times a second says
 * 30 here and passes 2 ticks a turn. Without it the realm says 60.
 */
export async function openInterface({ realm, wasm, bundle, pak, plan, service = "pocket.overlay", simHz }) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("the interface's realm did not load")), { once: true });
  });
  frame.src = realm;
  document.body.append(frame);
  try {
    await loaded;
    // (the realm's module has run when its document has loaded)
    const instance = await frame.contentWindow.PocketAppInstance.create(realmOptions({ wasm, bundle, pak, plan, service, simHz }));
    return attach(instance, plan, () => frame.remove());
  } catch (error) {
    frame.remove();
    throw error;
  }
}
