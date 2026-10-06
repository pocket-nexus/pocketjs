// The player of a Pocket3D game in a browser tab: one page chrome for every
// game. The game's name, the choice of device as text, the device's shell
// with the game's screens in it and its own keys as the controls, a mark that
// says the picture is simulated, the keys as a list, and the way to the game
// in Pocket Studio. Nothing here knows a game: a game says its name, its
// devices and one sentence a device where its picture differs, and draws into
// the canvas it is handed.
//
//   const player = createPlayer({
//     title: "My Game",
//     tagline: "One sentence about it.",
//     devices: [{ id: "vita", label: "PS Vita", note: "…" }, …],   // ids of ./shells/profiles.js
//                                                                  // (`mark`: the trademark in a label that is more than one,
//                                                                  //  { id: "android", label: "Android phone", mark: "Android" })
//     runsOn: ["psp", "vita", "3ds", "ipod-touch", "android"],     // what the game has packages for
//     withoutPackages: { heading: "…", sentence: "…" },            // the dock's words when a visitor can get none
//     about: "This is the Pocket3D web player.",                   // what the About panel says this player is
//     pick: (id) => present(id),                                   // another device was chosen
//   });
//   player.canvas                    // the scene's canvas, hidden until the game shows it
//   player.controls                  // pocket3d-controls.js, bound to the shell
//   player.show("vita", { width: 960, height: 544, lower, sticks: 2, glyphs: "playstation", touch: "primary", viewport: [480, 272] });
//   player.ready()                   // the game's first frame is drawn: the player reads what it kept back
//   player.say("…")                  // a sentence over the stage: what went wrong
//
// The page links pocket3d-stage.css and pocket3d-player.css.
//
// What the player knows of the game in Pocket Studio comes from `/app.json`
// on the page's own host, which a game's host answers (`id`, `title`,
// `tagline`, `author`, `packages`). A host that has none leaves the page's own
// words: `<meta name="pocket-app" content="<id>">` and
// `<meta name="pocket-studio" content="<origin>">`, then the Studio's front door.
//
// The host may also name an address that counts the players that open
// (`opened` in `/app.json`, or `<meta name="pocket-opened">`): the player asks
// for it once a page, and a host that names none is told nothing. The dock's
// links say where their visitor comes from (`from=player`).
import { createControls, FACES, legend } from "./pocket3d-controls.js";
import { choices, createStage } from "./pocket3d-stage.js";
import { SHELLS } from "./shells/profiles.js";

/** Pocket Studio, where no page says another. */
const STUDIO = "https://studio.pocket.nexus";
/** A package's target, as the Studio names it, in words. */
const TARGETS = { psp: "PSP", vita: "PS Vita", "3ds": "Nintendo 3DS", "ipod-touch": "iPod touch", android: "Android" };

const make = (tag, attributes = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "text") el.textContent = value;
    else if (value !== false && value !== undefined) el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children);
  return el;
};
const listed = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);
const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** A link into Pocket Studio that says its visitor comes from a player, with what the address already had. */
export function fromPlayer(address) {
  const url = new URL(address);
  url.searchParams.set("from", "player");
  return url.href;
}

let reported = false;
/**
 * Tells the address a host named that a player opened: one GET with the game's id (`app`) and the device
 * the page opened as (`layout`), with what the address already had. It is sent once a page, with the
 * visitor's own session, at low priority; no answer is waited for or read, and one that fails is not
 * heard of. Returns the address asked for, or null when nothing was sent (no address, no id, a second call).
 */
export function reportOpened(address, app, layout, send = (...request) => fetch(...request), base = globalThis.location?.href) {
  if (reported || !address || !app) return null;
  let url;
  try {
    url = new URL(address, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  reported = true;
  url.searchParams.set("app", app);
  url.searchParams.set("layout", layout);
  try {
    Promise.resolve(send(url.href, { mode: "no-cors", credentials: "include", cache: "no-store", keepalive: true, priority: "low" })).catch(() => {});
  } catch {
    // (a browser that refuses the request says so to no one)
  }
  return url.href;
}

/**
 * What the dock says, and its doors, from what the game and its host say. `packages` is what the host
 * lists (leave it out for a host that said nothing) and `allowNative` whether a visitor may have them
 * (`false` when the host says no; a host that does not say lets them). With packages a visitor may get,
 * the dock says where they are and has two doors, "get" first; with none it says what the page is
 * (`withoutPackages.heading`, `withoutPackages.sentence`) and has the one door "make". A host that said
 * nothing leaves the game's own word: `runsOn`.
 */
export function dockWords({ title, runsOn = [], packages, allowNative, withoutPackages = {} }) {
  const targets = runsOn.filter((t) => t in TARGETS);
  const built = targets.length ? `${title} is built for ${listed(targets.map((t) => TARGETS[t]))}.` : "";
  const held = (packages ?? []).filter((p) => p && p.target in TARGETS);
  const may = packages ? held.length > 0 && allowNative !== false : targets.length > 0;
  if (!may) {
    return {
      heading: withoutPackages.heading ?? "Made for real handhelds",
      sentence: withoutPackages.sentence ?? `${built || `${title} runs here in your browser.`} It has no packages to download yet.`,
      doors: ["make"],
    };
  }
  return {
    heading: "Play it on the real thing",
    sentence: `${built || `${title} is built for real handhelds.`} ${
      held.length
        ? `Pocket Studio has its ${held.length > 1 ? "packages" : "package"} for ${listed(held.map((p) => (p.size > 0 ? `${TARGETS[p.target]} (${megabytes(p.size)})` : TARGETS[p.target])))}.`
        : "Its packages are in Pocket Studio, ready to install on your own."
    }`,
    doors: ["get", "make"],
  };
}

/**
 * The dock's second door: the Studio's front door, or, for a game whose host says it is `remixable`, the
 * Studio's way to start a game of one's own from a copy of this one (`/studio/?remix=<id>`).
 */
export function makeDoor({ studio = STUDIO, id = "", remixable = false } = {}) {
  return remixable && id
    ? { text: "Remix this game", href: fromPlayer(`${studio}/studio/?remix=${encodeURIComponent(id)}`) }
    : { text: "Make a game of your own", href: fromPlayer(`${studio}/`) };
}

/** A panel under the control that opens it: one open at a time, closed by Escape, by a press outside it, or by its control. */
function panels(root) {
  let open = null;
  const close = () => {
    if (!open) return;
    open.panel.hidden = true;
    open.control.setAttribute("aria-expanded", "false");
    open = null;
  };
  const place = () => {
    if (!open) return;
    const { panel, control } = open;
    const at = control.getBoundingClientRect(), within = root.getBoundingClientRect();
    const width = panel.offsetWidth;
    // (under the control, its right edges in line, kept inside the page)
    const left = Math.max(12, Math.min(at.right - width, within.width - width - 12));
    panel.style.left = `${Math.max(12, left)}px`;
    panel.style.top = `${at.bottom - within.top + 8}px`;
  };
  // (Escape closes what is open and goes no further: the device's own Escape is its START)
  addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !open) return;
      close();
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
  addEventListener("pointerdown", (event) => open && !open.panel.contains(event.target) && !open.control.contains(event.target) && close(), true);
  addEventListener("resize", place);
  return {
    /** `control` opens `panel` on a press. With `hover`, a pointer that rests on the control or the keys' focus opens it too. */
    bind(control, panel, { hover = false } = {}) {
      panel.hidden = true;
      control.setAttribute("aria-expanded", "false");
      const show = () => {
        if (open?.panel === panel) return;
        close();
        open = { panel, control };
        panel.hidden = false;
        control.setAttribute("aria-expanded", "true");
        place();
      };
      let pinned = false;
      control.addEventListener("click", () => {
        if (open?.panel === panel && (pinned || !hover)) return close();
        pinned = true;
        show();
      });
      if (hover) {
        const rest = () => {
          pinned = false;
          show();
        };
        control.addEventListener("pointerenter", (event) => event.pointerType === "mouse" && !open && rest());
        control.addEventListener("pointerleave", (event) => event.pointerType === "mouse" && open?.panel === panel && !pinned && close());
        control.addEventListener("focus", () => control.matches(":focus-visible") && !open && rest());
        control.addEventListener("blur", () => open?.panel === panel && !pinned && close());
      }
    },
    close,
  };
}

/** What the page's host, then the page, says of the game in Pocket Studio. */
async function readApp() {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || "";
  let app = null, studio = meta("pocket-studio"), opened = meta("pocket-opened");
  try {
    const reply = await fetch(new URL("/app.json", location.href), { headers: { accept: "application/json" } });
    const said = reply.ok && (reply.headers.get("content-type") ?? "").includes("json") ? await reply.json() : null;
    if (said && typeof said.id === "string" && said.id) {
      app = said;
      if (typeof said.opened === "string" && said.opened) opened = said.opened;
      // (a game's host is one label below the Studio's)
      if (!studio && typeof said.slug === "string" && location.hostname.startsWith(`${said.slug}.`)) studio = `${location.protocol}//${location.host.split(".").slice(1).join(".")}`;
    }
  } catch {
    // A host without the file: the page's own words stand.
  }
  if (!app && meta("pocket-app")) app = { id: meta("pocket-app") };
  try {
    studio = new URL(studio || STUDIO).origin;
  } catch {
    studio = STUDIO;
  }
  return { app, studio, opened };
}

/**
 * Builds the player in `root` (the page's body) and returns it. `devices` are `{ id, label, note }`: `id`
 * names a shell, `note` is the game's sentence on how its picture on that device differs from this one.
 * A device whose label is more than a trademark says which word is one (`mark`: "Android" for an
 * "Android phone"); About names that word among the marks.
 * `runsOn` are the targets the game has packages for, as Pocket Studio names them, for a host that lists
 * none. `withoutPackages` (`{ heading, sentence }`) are the dock's words when a visitor can get no package.
 * `about` is the first sentence of the About panel: what this player is. `pick(id)` is called when another
 * device is chosen.
 */
export function createPlayer({ root = document.body, title, tagline = "", devices, device, runsOn = [], withoutPackages = {}, about = "This is the Pocket3D web player.", pick }) {
  const canvas = make("canvas", { hidden: true });
  const name = make("h1", { text: title });
  const line = make("p", { text: tagline, hidden: !tagline });
  const nav = make("nav", { "aria-label": "Device" });
  const mark = make("button", { type: "button", "data-pocket-mark": true, "aria-describedby": "pocket-simulated", text: "Simulated" });
  const tip = make("div", { "data-pocket-panel": "tip", id: "pocket-simulated", role: "tooltip" });
  const keysControl = make("button", { type: "button", "data-pocket-open": "controls", "aria-controls": "pocket-controls", text: "Controls" });
  const keysPanel = make("div", { "data-pocket-panel": "controls", id: "pocket-controls", role: "dialog", "aria-label": "Controls" });
  const aboutControl = make("button", { type: "button", "data-pocket-open": "about", "aria-controls": "pocket-about", text: "About" });
  const aboutPanel = make("div", { "data-pocket-panel": "about", id: "pocket-about", role: "dialog", "aria-label": "About this player" });
  const stageRoot = make("main");
  const status = make("p", { "data-pocket-say": true, role: "status" });
  const heading = make("h2");
  const pitch = make("p");
  const get = make("a", { "data-pocket-action": "get", href: STUDIO, text: "Get it in Pocket Studio" });
  const own = make("a", { "data-pocket-action": "make", href: STUDIO, text: "Make a game of your own" });
  const dock = make("aside", { "data-pocket-studio": true, "aria-label": "Pocket Studio" }, make("div", { "data-pocket-pitch": true }, heading, pitch), make("div", { "data-pocket-actions": true }, get, own));
  const frame = make(
    "div",
    { "data-pocket-player": true },
    make("header", { "data-pocket-bar": true }, make("div", { "data-pocket-game": true }, name, line), make("div", { "data-pocket-device": true }, nav, mark), make("div", { "data-pocket-tools": true }, keysControl, aboutControl)),
    stageRoot,
    status,
    dock,
    tip,
    keysPanel,
    aboutPanel,
  );
  root.append(frame);

  const stage = createStage(stageRoot, canvas);
  const controls = createControls();
  controls.shell(stage.shell);
  const picker = choices(nav, devices, device, pick);
  const open = panels(frame);
  open.bind(mark, tip, { hover: true });
  open.bind(keysControl, keysPanel);
  open.bind(aboutControl, aboutPanel);

  // What is said of the game, until the host says more.
  // (`packages` is what the host lists: none is known until it has answered)
  let game = { title, packages: undefined, allowNative: undefined, studio: STUDIO, id: "", remixable: false };
  let current = devices.find((d) => d.id === device) ?? devices[0];
  let shape = { sticks: 0, glyphs: "playstation", touch: null };
  let kept = null;
  const write = () => {
    name.textContent = game.title;
    document.title = game.title;
    // What the game says it is built for, then what the Studio holds of it today when the host has said;
    // or, where a visitor can get no package, what the page is. The first door is the dock's own action.
    const words = dockWords({ title: game.title, runsOn, packages: game.packages, allowNative: game.allowNative, withoutPackages });
    heading.textContent = words.heading;
    pitch.textContent = words.sentence;
    get.hidden = !words.doors.includes("get");
    get.toggleAttribute("data-pocket-primary", words.doors[0] === "get");
    own.toggleAttribute("data-pocket-primary", words.doors[0] === "make");
    get.href = fromPlayer(game.id ? `${game.studio}/studio/?app=${encodeURIComponent(game.id)}` : `${game.studio}/`);
    const door = makeDoor(game);
    own.textContent = door.text;
    own.href = door.href;

    // The mark's words: what every game's picture here is, then the game's own sentence for this device.
    tip.replaceChildren(
      make("p", { text: `Your browser draws this picture. A real ${current.label} draws ${game.title} with its own hardware, so it looks and runs differently there.` }),
      ...(current.note ? [make("p", { text: current.note })] : []),
    );

    const keys = legend(shape);
    const face = FACES[shape.glyphs] ?? FACES.playstation;
    const touch = shape.touch === "auxiliary" ? "The pointer is a stylus on the lower screen." : shape.touch === "primary" ? (shape.sticks ? "The screen takes taps." : "The pointer is a finger on the screen.") : "";
    // (a browser whose only pointer is a finger has no keys to be told of)
    const fingers = matchMedia("(hover: none) and (pointer: coarse)").matches;
    keysPanel.replaceChildren(
      make("h2", { text: current.label }),
      ...(keys.length && !fingers
        ? [
            make("dl", {}, ...keys.flatMap(([key, what]) => [make("dt", { text: key }), make("dd", { text: what })])),
            make("p", { text: `The buttons and sticks on the picture work too: press them with the pointer. Enter is ${face.right}, Backspace is ${face.bottom}.` }),
          ]
        : []),
      ...(keys.length && fingers ? [make("p", { text: "The buttons and sticks on the picture are the controls: press them with a finger." })] : []),
      ...(touch ? [make("p", { text: touch })] : []),
    );
    const marks = [...new Set(devices.map((d) => d.mark ?? d.label))];
    aboutPanel.replaceChildren(
      make("h2", { text: "About this player" }),
      make("p", { text: `${about} The game is drawn in your browser; the handheld around it is a picture.` }),
      // One device's name is one mark: "Android is a trademark of its owner."
      make("p", { text: marks.length === 1 ? `${marks[0]} is a trademark of its owner. Pocket Nexus is not affiliated with it.` : `${listed(marks)} are trademarks of their owners. Pocket Nexus is not affiliated with them.` }),
      make("p", {}, "The PSP is rendered from a model by ", make("a", { href: "https://sketchfab.com/3d-models/playstation-portable-psp-eg02-b76c7f9158204a39929a9c97d0b813d0", target: "_blank", rel: "noopener", text: "Dibad" }), ", used under ", make("a", { href: "https://creativecommons.org/licenses/by/4.0/", target: "_blank", rel: "noopener", text: "CC BY 4.0" }), ", with its marks taken off."),
    );
  };
  write();
  readApp().then(({ app, studio, opened }) => {
    // (once a page, as the device it opened as: another device picked later is the same visit)
    reportOpened(opened, app?.id ?? "", current.id);
    game = {
      title: typeof app?.title === "string" && app.title ? app.title : title,
      // (a host that answered and lists none has none; a page that knows only the game's id knows nothing of them)
      packages: Array.isArray(app?.packages) ? app.packages.filter((p) => p && typeof p.target === "string") : undefined,
      allowNative: typeof app?.allowNative === "boolean" ? app.allowNative : undefined,
      studio,
      id: app?.id ?? "",
      // (a host says it when a game of one's own can start from a copy of this one)
      remixable: app?.remixable === true,
    };
    if (typeof app?.tagline === "string" && app.tagline) {
      line.textContent = app.tagline;
      line.hidden = false;
    }
    write();
  });

  return {
    canvas,
    stage,
    controls,
    /**
     * Another device from now on: its shell with screens of `width` by `height` (and `lower`), what its keys
     * stand for (`sticks`, `glyphs`), and which screen takes touch (`touch`: "primary", "auxiliary" or none)
     * in logical pixels of `viewport` (the lower screen's own size when it is the one). Returns the scale.
     */
    show(id, { width, height, lower, sticks = 0, glyphs = "playstation", touch = null, viewport }) {
      current = devices.find((d) => d.id === id) ?? current;
      shape = { sticks, glyphs, touch };
      picker.set(id);
      open.close();
      controls.device({ sticks, glyphs });
      const scale = stage.show({ device: id, width, height, lower });
      controls.touch(touch === "primary" ? canvas : touch === "auxiliary" ? stage.second : null, touch === "auxiliary" ? lower : viewport);
      write();
      return scale;
    },
    /**
     * The game's first frame is on the screen. The player reads what it kept back for it: the other
     * devices' shells, so that a change of device shows its case at once.
     */
    ready() {
      if (kept) return;
      kept = devices.flatMap((d) => (SHELLS[d.id] ? [SHELLS[d.id].art, SHELLS[d.id].partsArt] : [])).filter(Boolean).map((file) => Object.assign(new Image(), { src: new URL(`./shells/${file}`, import.meta.url).href }));
    },
    /** A sentence over the stage, in place of the game: a browser that cannot draw it, a start that failed. */
    say(text) {
      status.textContent = text;
    },
  };
}
