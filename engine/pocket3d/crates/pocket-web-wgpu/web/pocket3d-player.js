// The player of a Pocket3D game in a browser tab: one page chrome for every
// game. The game's name, the choice of device as text, the device's shell
// with the game's screens in it and its own keys as the controls, a mark that
// says the picture is simulated, the keys as a list, and a dock with the two
// things a visitor does with the game: download it, remix it. Nothing here
// knows a game: a game says its name and its devices, and draws into the
// canvas it is handed.
//
//   const player = createPlayer({
//     title: "My Game",
//     tagline: { en: "One sentence about it.", ja: "ゲームを一文で。" },
//     devices: [{ id: "vita", label: "PS Vita" }, …],              // ids of ./shells/profiles.js
//                                                                  // (`mark`: the trademark in a label that is more than one,
//                                                                  //  { id: "android", label: "Android phone", mark: "Android" })
//     runsOn: ["psp", "vita", "3ds", "ipod-touch", "android"],     // what the game has packages for
//     about: "This is the Pocket3D web player.",                   // what the About panel says this player is
//     pick: (id) => present(id),                                   // another device was chosen
//   });
//   player.canvas                    // the scene's canvas, hidden until the game shows it
//   player.controls                  // pocket3d-controls.js, bound to the shell
//   player.show("vita", { width: 960, height: 544, lower, sticks: 2, glyphs: "playstation", touch: "primary", viewport: [480, 272] });
//   player.ready()                   // the game's first frame is drawn: the player reads what it kept back
//   player.say("…")                  // a sentence over the stage: what went wrong
//   player.sayNoWebGPU()             // the player's own sentence for a browser without WebGPU
//   player.lang                      // the language the player speaks now: "en" or "ja"
//   player.words({ en, ja })         // a game's words in that language
//   player.onLanguage((lang) => …)   // the visitor chose another language
//
// The page links pocket3d-stage.css and pocket3d-player.css.
//
// Languages (pocket3d-words.js): the player speaks English and Japanese, chosen by the address
// (`?lang=ja`), the visitor's saved choice, then the browser's language, and offers the other one in
// its bar. A game's words — `tagline`, a device's `label` and `mark`, `about`, what it hands
// `say` — are a string, said in every language, or one string per language:
// `{ en: "…", ja: "…" }`. Where a game gives no Japanese, the player's own words are Japanese and the
// game's are its English; a device's `label` given as a string is the player's own name for that
// device in a language other than English.
//
// What the player knows of the game in Pocket Studio comes from `/app.json`
// on the page's own host, which a game's host answers (`id`, `slug`, `title`,
// `tagline`, `author`, `packages`, `remixable`). A host that has none leaves
// the page's own words: `<meta name="pocket-app" content="<id>">` and
// `<meta name="pocket-studio" content="<origin>">`, then the Studio's front door.
//
// The dock (`<aside data-pocket-studio>`) holds links of an icon and one word
// (the words are pocket3d-words.js's `get`, `remix` and `make`): the first
// where a visitor may have the game's packages, to the game's page in Pocket
// Studio with its files open (`/games/<slug>?get`); the second where the host
// says the game is `remixable` (`/games/<slug>?remix`); and, where neither is
// so, the third alone, to the Studio's front door.
//
// A host may draw the dock itself. When `/app.json` has `chrome`, a path under
// `/play/` that ends in `.js` (`^/play/[A-Za-z0-9._/-]+\.js$`, no `..`), the
// player imports that module from the page's own origin and calls
//
//   mount({ dock, frame, app, studio, lang, title })
//
// `dock` is the aside, emptied and marked `data-pocket-hosted`; `frame` the
// player's root (`[data-pocket-player]`), for what stands beside the dock;
// `app` what `/app.json` said; `studio` the Studio's origin; `lang` the
// language the player speaks ("en" or "ja"); `title` the game's title as
// shown. `mount` may return `{ speak(lang) }`, called each time the visitor
// chooses another language. An import or a mount that throws leaves the
// player's own dock: its links are put back and the mark is taken off. The
// player's stylesheet styles the dock's own links only while the dock is not
// hosted; a host's stylesheet owns a hosted one
// (`[data-pocket-studio][data-pocket-hosted]`).
//
// The host may also name an address that counts the players that open
// (`opened` in `/app.json`, or `<meta name="pocket-opened">`): the player asks
// for it once a page, and a host that names none is told nothing. The dock's
// links say where their visitor comes from (`from=player`).
import { createControls, FACES, legend } from "./pocket3d-controls.js";
import { choices, createStage } from "./pocket3d-stage.js";
import { catalog, DEFAULT_LANGUAGE, LANGUAGES, layout, nextLanguage, readLanguage, saveLanguage, saysIn, WORDS, wordsIn } from "./pocket3d-words.js";
import { SHELLS } from "./shells/profiles.js";

/** Pocket Studio, where no page says another. */
const STUDIO = "https://studio.pocket.nexus";

const make = (tag, attributes = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "text") el.textContent = value;
    else if (value !== false && value !== undefined) el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children);
  return el;
};

/** The dock's icons: the paths of a 24 unit box, drawn with the text's colour. */
const ICONS = {
  get: [["path", { d: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" }]],
  remix: [
    ["circle", { cx: 7, cy: 6, r: 2.2 }],
    ["circle", { cx: 17, cy: 6, r: 2.2 }],
    ["circle", { cx: 12, cy: 18, r: 2.2 }],
    ["path", { d: "M7 8.2v1.3a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V8.2M12 12.5v3.3" }],
  ],
};
const SVG = "http://www.w3.org/2000/svg";
/** One of `ICONS` as an element, or null for a door that has none. The link's word names it. */
const icon = (name) => {
  if (!ICONS[name]) return null;
  const drawn = document.createElementNS(SVG, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", "stroke-width": 2.4, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) drawn.setAttribute(key, value);
  for (const [tag, attributes] of ICONS[name]) {
    const shape = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    drawn.append(shape);
  }
  return drawn;
};

/** The address of a host's own dock (`chrome` in `/app.json`): a script under `/play/` on the page's own origin. */
const CHROME = /^\/play\/[A-Za-z0-9._/-]+\.js$/;
/** `chrome` as an address to import, or null for a value that is none: another kind, another directory, a way up out of it. */
export function chromeAddress(chrome, origin = globalThis.location?.origin) {
  if (typeof chrome !== "string" || !CHROME.test(chrome) || chrome.includes("..") || chrome.includes("//")) return null;
  try {
    return new URL(chrome, origin).href;
  } catch {
    return null;
  }
}

/**
 * A link into Pocket Studio that says its visitor comes from a player, with what the address already had,
 * and the language the visitor reads (`lang`) when one is to be carried.
 */
export function fromPlayer(address, lang = null) {
  const url = new URL(address);
  url.searchParams.set("from", "player");
  if (lang) url.searchParams.set("lang", lang);
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
 * The dock's doors, in order, from what the game and its host say: "get" where a visitor may have the
 * game's packages, "remix" where the host says a game of one's own can start from this one, and "make"
 * alone where neither is so. `packages` is what the host lists (leave it out for a host that said
 * nothing) and `allowNative` whether a visitor may have them (`false` when the host says no; a host that
 * does not say lets them). A host that said nothing leaves the game's own word: `runsOn`. The first door
 * is the dock's own action.
 */
export function dockWords({ runsOn = [], packages, allowNative, remixable = false, lang = DEFAULT_LANGUAGE } = {}) {
  const w = catalog(lang);
  const targets = runsOn.filter((t) => t in w.targets);
  const held = (packages ?? []).filter((p) => p && p.target in w.targets);
  const may = packages ? held.length > 0 && allowNative !== false : targets.length > 0;
  const doors = [...(may ? ["get"] : []), ...(remixable ? ["remix"] : [])];
  return { doors: doors.length ? doors : ["make"] };
}

/**
 * The door to the game's files: its page in Pocket Studio with them open (`/games/<slug>?get`), or the
 * Studio's front door for a game whose host named no `slug`. `carry` is the language the link carries
 * (`lang`), or null.
 */
export function getDoor({ studio = STUDIO, slug = "", lang = DEFAULT_LANGUAGE, carry = null } = {}) {
  return { text: catalog(lang).get, href: fromPlayer(slug ? `${studio}/games/${encodeURIComponent(slug)}?get` : `${studio}/`, carry) };
}

/**
 * The door to a game of one's own from a copy of this one: the game's page in Pocket Studio with its
 * remix open (`/games/<slug>?remix`), or, for a game whose host named no `slug`, the room's own way to
 * start one (`/studio/?remix=<id>`).
 */
export function remixDoor({ studio = STUDIO, id = "", slug = "", lang = DEFAULT_LANGUAGE, carry = null } = {}) {
  return { text: catalog(lang).remix, href: fromPlayer(slug ? `${studio}/games/${encodeURIComponent(slug)}?remix` : `${studio}/studio/?remix=${encodeURIComponent(id)}`, carry) };
}

/**
 * The door a dock has when it has no other: the Studio's front door. In a language other than English
 * the front door is that language's (`/ja/`). `carry` is the language the links into the Studio carry
 * (`lang`), or null: the visitor's choice, or a language that is not English.
 */
export function makeDoor({ studio = STUDIO, lang = DEFAULT_LANGUAGE, carry = null } = {}) {
  // (the front door has a page in each language: its path says which, so only an English choice is carried)
  return { text: catalog(lang).make, href: fromPlayer(lang === DEFAULT_LANGUAGE ? `${studio}/` : `${studio}/${lang}/`, lang === DEFAULT_LANGUAGE ? carry : null) };
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
 * Builds the player in `root` (the page's body) and returns it. `devices` are `{ id, label }`: `id`
 * names a shell. A device whose label is more than a trademark says which word is one (`mark`:
 * "Android" for an "Android phone"); About names that word among the marks.
 * `runsOn` are the targets the game has packages for, as Pocket Studio names them, for a host that lists
 * none. `about` is the first sentence of the About panel: what this player is (the player's own
 * sentence when a page gives none). `pick(id)` is called when another device is chosen. Every one of the
 * game's words but `title` is a string or one string per language (`{ en, ja }`); the top of this file
 * says how each one is read.
 *
 * Two things a page of an earlier player gave are taken and not shown: a device's `note` (the mark says
 * one sentence for every game and every device) and `withoutPackages` (the dock has no sentence).
 */
export function createPlayer({ root = document.body, title, tagline = "", devices, device, runsOn = [], about = null, pick }) {
  let { lang, from } = readLanguage({ studio: new URL(document.querySelector('meta[name="pocket-studio"]')?.content || STUDIO, location.href).origin });
  // (a language the visitor chose is carried into the room; so is any that is not English)
  let chosen = from === "address" || from === "cookie" || from === "stored";
  let w = catalog(lang);
  document.documentElement.lang = lang;

  const canvas = make("canvas", { hidden: true });
  const name = make("h1", { text: title });
  const line = make("p", { hidden: true });
  const nav = make("nav");
  const mark = make("button", { type: "button", "data-pocket-mark": true, "aria-describedby": "pocket-simulated" });
  const tip = make("div", { "data-pocket-panel": "tip", id: "pocket-simulated", role: "tooltip" });
  const keysControl = make("button", { type: "button", "data-pocket-open": "controls", "aria-controls": "pocket-controls" });
  const keysPanel = make("div", { "data-pocket-panel": "controls", id: "pocket-controls", role: "dialog" });
  const aboutControl = make("button", { type: "button", "data-pocket-open": "about", "aria-controls": "pocket-about" });
  const aboutPanel = make("div", { "data-pocket-panel": "about", id: "pocket-about", role: "dialog" });
  // The other language: its name in itself, which a visitor who reads it finds.
  const speech = make("button", { type: "button", "data-pocket-language": true });
  const stageRoot = make("main");
  const status = make("p", { "data-pocket-say": true, role: "status" });
  // The dock's own links: each an icon, where it has one, and a word.
  const door = (action) => {
    const word = make("span");
    const link = make("a", { "data-pocket-action": action, href: STUDIO }, ...[icon(action)].filter(Boolean), word);
    return { link, word };
  };
  const doors = { get: door("get"), remix: door("remix"), make: door("make") };
  const actions = make("div", { "data-pocket-actions": true }, doors.get.link, doors.remix.link, doors.make.link);
  const dock = make("aside", { "data-pocket-studio": true, "aria-label": "Pocket Studio" }, actions);
  const frame = make(
    "div",
    { "data-pocket-player": true },
    make("header", { "data-pocket-bar": true }, make("div", { "data-pocket-game": true }, name, line), make("div", { "data-pocket-device": true }, nav, mark), make("div", { "data-pocket-tools": true }, keysControl, aboutControl, speech)),
    stageRoot,
    status,
    dock,
    tip,
    keysPanel,
    aboutPanel,
  );
  root.append(frame);

  // A device's name in the player's language: the game's own when it gives one in that language, the
  // player's for the device in a language other than English, and the game's English otherwise.
  const label = (d) => (saysIn(d.label, lang) || lang === DEFAULT_LANGUAGE || !(d.id in w.devices) ? wordsIn(d.label, lang) : w.devices[d.id]);
  const labels = () => Object.fromEntries(devices.map((d) => [d.id, label(d)]));

  const stage = createStage(stageRoot, canvas);
  stage.speak(w.shell);
  const controls = createControls();
  controls.shell(stage.shell);
  const picker = choices(nav, devices.map((d) => ({ id: d.id, label: label(d) })), device, pick);
  const open = panels(frame);
  open.bind(mark, tip, { hover: true });
  open.bind(keysControl, keysPanel);
  open.bind(aboutControl, aboutPanel);

  // What is said of the game, until the host says more.
  // (`packages` is what the host lists: none is known until it has answered)
  let game = { title, packages: undefined, allowNative: undefined, studio: STUDIO, id: "", slug: "", remixable: false };
  /** What a host's own dock returned (`mount`), while the dock is hosted: null while it is the player's own. */
  let hostDock = null;
  /** What the host said of the game (`/app.json`), for its tagline in each language. */
  let hosted = null;
  let current = devices.find((d) => d.id === device) ?? devices[0];
  let shape = { sticks: 0, glyphs: "playstation", touch: null };
  let kept = null;
  /** The game's last words over the stage, said again in another language. */
  let said = "";
  const listeners = [];
  const carry = () => (chosen || lang !== DEFAULT_LANGUAGE ? lang : null);

  // The tagline: in English the host's, which follows what the author last wrote, then the page's. In
  // another language the host's in that language, then the page's in it, then the English.
  const taglineNow = () => {
    const translated = lang === DEFAULT_LANGUAGE ? "" : hosted?.listing?.translations?.[lang]?.tagline;
    if (typeof translated === "string" && translated) return translated;
    if (lang !== DEFAULT_LANGUAGE && saysIn(tagline, lang)) return tagline[lang];
    return typeof hosted?.tagline === "string" && hosted.tagline ? hosted.tagline : wordsIn(tagline, lang);
  };

  const write = () => {
    name.textContent = game.title;
    document.title = game.title;
    const words = taglineNow();
    line.textContent = words;
    line.hidden = !words;
    nav.setAttribute("aria-label", w.device);
    mark.textContent = w.simulated;
    keysControl.textContent = w.controls;
    keysPanel.setAttribute("aria-label", w.controls);
    aboutControl.textContent = w.about;
    aboutPanel.setAttribute("aria-label", w.aboutHeading);
    const next = nextLanguage(lang);
    speech.textContent = LANGUAGES[next];
    speech.lang = next;
    speech.title = w.switchTo({ name: w.names[next] });

    // The dock's own doors, where no host draws it: which ones the game and its host give, the first as
    // the dock's own action, and where each leads.
    if (!dock.hasAttribute("data-pocket-hosted")) {
      const dockSays = dockWords({ runsOn, packages: game.packages, allowNative: game.allowNative, remixable: game.remixable && Boolean(game.slug || game.id), lang });
      const leads = { get: getDoor, remix: remixDoor, make: makeDoor };
      for (const [action, { link, word }] of Object.entries(doors)) {
        const shown = dockSays.doors.includes(action);
        link.hidden = !shown;
        link.toggleAttribute("data-pocket-primary", dockSays.doors[0] === action);
        const to = leads[action]({ ...game, lang, carry: carry() });
        word.textContent = to.text;
        link.href = to.href;
      }
    }

    // The mark's words: what every game's picture here is. One sentence, the same for every game.
    tip.replaceChildren(make("p", { text: w.simulatedSays({ device: label(current), title: game.title }) }));

    const keys = legend(shape, w);
    const face = FACES[shape.glyphs] ?? FACES.playstation;
    const touch = shape.touch === "auxiliary" ? w.touchStylus : shape.touch === "primary" ? (shape.sticks ? w.touchTaps : w.touchFinger) : "";
    // (a browser whose only pointer is a finger has no keys to be told of)
    const fingers = matchMedia("(hover: none) and (pointer: coarse)").matches;
    keysPanel.replaceChildren(
      make("h2", { text: label(current) }),
      ...(keys.length && !fingers
        ? [
            make("dl", {}, ...keys.flatMap(([key, what]) => [make("dt", { text: key }), make("dd", { text: what })])),
            make("p", { text: w.keysPointer({ right: face.right, bottom: face.bottom }) }),
          ]
        : []),
      ...(keys.length && fingers ? [make("p", { text: w.keysFinger })] : []),
      ...(touch ? [make("p", { text: touch })] : []),
    );
    // One device's name is one mark: "Android is a trademark of its owner."
    const marks = [...new Set(devices.map((d) => (d.mark == null ? label(d) : wordsIn(d.mark, lang))))];
    aboutPanel.replaceChildren(
      make("h2", { text: w.aboutHeading }),
      make("p", { text: w.aboutSays({ about: about == null ? w.aboutPlayer : wordsIn(about, lang) }) }),
      make("p", { text: marks.length === 1 ? w.markOne({ mark: marks[0] }) : w.markMany({ marks: w.list(marks) }) }),
      make(
        "p",
        {},
        ...layout(w.pspCredit, {
          author: make("a", { href: "https://sketchfab.com/3d-models/playstation-portable-psp-eg02-b76c7f9158204a39929a9c97d0b813d0", target: "_blank", rel: "noopener", text: "Dibad" }),
          license: make("a", { href: "https://creativecommons.org/licenses/by/4.0/", target: "_blank", rel: "noopener", text: "CC BY 4.0" }),
        }),
      ),
    );
    status.textContent = wordsIn(said, lang);
  };

  /** The player speaks `next` from now on: its own words, the game's, the shell's controls and the devices' names. */
  const speak = (next) => {
    lang = next;
    w = catalog(lang);
    document.documentElement.lang = lang;
    stage.speak(w.shell);
    picker.name(labels());
    write();
    try {
      hostDock?.speak?.(lang);
    } catch {
      // (a host's dock that cannot change its language keeps the one it has)
    }
    for (const heard of listeners) heard(lang);
  };

  /**
   * The host's own dock, when `/app.json` names one (`chrome`): its module is imported from the page's
   * own origin and handed the dock, emptied and marked. One that cannot be read, or that throws, leaves
   * the player's own dock as it was.
   */
  const hostTheDock = async (app, studio) => {
    const address = chromeAddress(app?.chrome);
    if (!address) return;
    try {
      const module = await import(address);
      if (typeof module.mount !== "function") return;
      dock.replaceChildren();
      dock.setAttribute("data-pocket-hosted", "");
      const told = lang;
      const handle = await module.mount({ dock, frame, app, studio, lang: told, title: game.title });
      hostDock = handle && typeof handle === "object" ? handle : {};
      // (the visitor chose another language while the dock was being drawn)
      if (lang !== told) hostDock.speak?.(lang);
    } catch {
      hostDock = null;
      dock.removeAttribute("data-pocket-hosted");
      dock.replaceChildren(actions);
      write();
    }
  };
  speech.addEventListener("click", () => {
    chosen = true;
    const next = nextLanguage(lang);
    saveLanguage(next, { studio: game.studio });
    open.close();
    speech.blur();
    speak(next);
  });

  write();
  readApp().then(({ app, studio, opened }) => {
    // (once a page, as the device it opened as: another device picked later is the same visit)
    reportOpened(opened, app?.id ?? "", current.id);
    hosted = app;
    game = {
      title: typeof app?.title === "string" && app.title ? app.title : title,
      // (a host that answered and lists none has none; a page that knows only the game's id knows nothing of them)
      packages: Array.isArray(app?.packages) ? app.packages.filter((p) => p && typeof p.target === "string") : undefined,
      allowNative: typeof app?.allowNative === "boolean" ? app.allowNative : undefined,
      studio,
      id: app?.id ?? "",
      // (the label of the game's own address, which its page in Pocket Studio is named by)
      slug: typeof app?.slug === "string" ? app.slug : "",
      // (a host says it when a game of one's own can start from a copy of this one)
      remixable: app?.remixable === true,
    };
    write();
    void hostTheDock(app, studio);
  });

  return {
    canvas,
    stage,
    controls,
    /** The language the player speaks now: a code of `LANGUAGES` in pocket3d-words.js. */
    get lang() {
      return lang;
    },
    /** A game's words (a string, or one string per language) in the language the player speaks now. */
    words: (words) => wordsIn(words, lang),
    /** `heard(lang)` is called each time the visitor chooses another language. */
    onLanguage(heard) {
      listeners.push(heard);
    },
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
    /**
     * Words over the stage, in place of the game: a browser that cannot draw it, a start that failed. A
     * string, or one per language; said again in the language the visitor chooses next. "" clears them.
     */
    say(words) {
      said = words ?? "";
      status.textContent = wordsIn(said, lang);
    },
    /** The player's own sentence for a browser that has no WebGPU, with the game's name in it. */
    sayNoWebGPU() {
      said = Object.fromEntries(Object.keys(WORDS).map((code) => [code, catalog(code).noWebGPU({ title: game.title })]));
      status.textContent = wordsIn(said, lang);
    },
  };
}
