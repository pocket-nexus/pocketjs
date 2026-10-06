// The words of the Pocket3D web player in each language it speaks, and how a
// page knows which one its visitor reads. Nothing here knows a game.
//
//   import { chooseLanguage, readLanguage, saveLanguage, WORDS, wordsIn } from "./pocket3d-words.js";
//
//   const { lang } = readLanguage();          // "en" or "ja"
//   WORDS[lang].controls                      // "Controls" / "操作方法"
//   WORDS[lang].noWebGPU({ title })           // a sentence made from facts
//   wordsIn({ en: "One sentence.", ja: "一文。" }, lang)   // a game's own words
//
// A language is one entry of `LANGUAGES` and one catalog in `WORDS` with the
// keys of the English one; a key a catalog lacks is read from English.
//
// The order a page reads the language in:
//
//   1. `?lang=<code>` in the address. The page saves it (3) and takes it out
//      of the address.
//   2. (Pocket Studio's own pages: the path, `/ja/…`. The player has none.)
//   3. The visitor's saved choice: the cookie `lang` where the page is on
//      Pocket Studio's own host, and the key `pocket3d-player.lang` of the
//      host's localStorage on a game's host. No cookie crosses hosts: the
//      player's links into Pocket Studio carry `lang`.
//   4. The browser's first language, `navigator.languages[0]`.
//   5. English.

/** The languages the player speaks: each one's code, and its name in itself. */
export const LANGUAGES = { en: "English", ja: "日本語" };
/** The language of a page that knows nothing of its visitor. */
export const DEFAULT_LANGUAGE = "en";
/** Where a game's host keeps a visitor's choice. */
export const STORED_LANGUAGE = "pocket3d-player.lang";
/** The cookie Pocket Studio's own host keeps a visitor's choice in. */
export const LANGUAGE_COOKIE = "lang";

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/;
const LATIN = /[A-Za-z0-9]/;
/**
 * Japanese with facts in it: one half-width space where a fact's Latin letter or digit meets a Japanese
 * character, and where a Latin sentence's full stop is followed by Japanese; none between two Japanese
 * characters, and none beside a full-width bracket or mark. The catalog writes no space around a fact.
 */
export function ja(strings, ...facts) {
  let text = strings[0];
  facts.forEach((fact, index) => {
    for (const piece of [String(fact), strings[index + 1]]) {
      const left = text.at(-1) ?? "", right = piece[0] ?? "";
      const gap = (LATIN.test(left) && CJK.test(right)) || (CJK.test(left) && LATIN.test(right)) || (/[.!?]/.test(left) && CJK.test(right));
      text += (gap ? " " : "") + piece;
    }
  });
  return text;
}

const join = { en: (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`), ja: (items) => items.join("、") };

/**
 * The catalogs. An entry is a string, or a function of named facts that returns one. A string with
 * `{name}` slots is laid out with elements put in them (`pspCredit`).
 */
export const WORDS = {
  en: {
    language: "Language",
    /** What the language control does, in the page's language: "Show this page in Japanese". */
    switchTo: ({ name }) => `Show this page in ${name}`,
    /** The languages' names in this language, for that sentence. */
    names: { en: "English", ja: "Japanese" },
    device: "Device",
    simulated: "Simulated",
    simulatedSays: ({ device, title }) => `Your browser draws this picture. A real ${device} draws ${title} with its own hardware, so it looks and runs differently there.`,
    controls: "Controls",
    about: "About",
    aboutHeading: "About this player",
    aboutPlayer: "This is the Pocket3D web player.",
    aboutSays: ({ about }) => `${about} The game is drawn in your browser; the handheld around it is a picture.`,
    markOne: ({ mark }) => `${mark} is a trademark of its owner. Pocket Nexus is not affiliated with it.`,
    markMany: ({ marks }) => `${marks} are trademarks of their owners. Pocket Nexus is not affiliated with them.`,
    pspCredit: "The PSP is rendered from a model by {author}, used under {license}, with its marks taken off.",
    keysPointer: ({ right, bottom }) => `The buttons and sticks on the picture work too: press them with the pointer. Enter is ${right}, Backspace is ${bottom}.`,
    keysFinger: "The buttons and sticks on the picture are the controls: press them with a finger.",
    touchStylus: "The pointer is a stylus on the lower screen.",
    touchTaps: "The screen takes taps.",
    touchFinger: "The pointer is a finger on the screen.",
    // The keys a device's controls are held with (pocket3d-controls.js `legend`).
    arrows: "arrows",
    stick: "stick",
    leftStick: "left stick",
    rightStick: "right stick",
    dpad: "d-pad",
    // The shell's own controls, as a reader of the page hears them (pocket3d-stage.js).
    shell: {
      up: "Up", down: "Down", left: "Left", right: "Right",
      triangle: "Top face button", circle: "Right face button", cross: "Bottom face button", square: "Left face button",
      l: "L", r: "R", start: "START", select: "SELECT",
      pad: "Directional pad", stick: "Stick", leftStick: "Left stick", rightStick: "Right stick",
    },
    // The dock: what the game is built for, and the doors into Pocket Studio.
    playReal: "Play it on the real thing",
    madeFor: "Made for real handhelds",
    builtFor: ({ title, targets }) => `${title} is built for ${targets}.`,
    builtForReal: ({ title }) => `${title} is built for real handhelds.`,
    runsHere: ({ title }) => `${title} runs here in your browser.`,
    noPackagesYet: "It has no packages to download yet.",
    packagesHeld: ({ list, count }) => `Pocket Studio has its ${count > 1 ? "packages" : "package"} for ${list}.`,
    packagesIn: "Its packages are in Pocket Studio, ready to install on your own.",
    sized: ({ name, size }) => `${name} (${size})`,
    get: "Get it in Pocket Studio",
    make: "Make a game of your own",
    remix: "Remix this game",
    noWebGPU: ({ title }) => `This browser has no WebGPU, which ${title} draws with.`,
    list: join.en,
    /** Sentences one after another. */
    sentences: (...parts) => parts.filter(Boolean).join(" "),
    /** A package's target, as Pocket Studio names it. */
    targets: { psp: "PSP", vita: "PS Vita", "3ds": "Nintendo 3DS", "ipod-touch": "iPod touch", android: "Android" },
    /** A shell's device (./shells/profiles.js). */
    devices: { psp: "PSP", vita: "PS Vita", "3ds": "Nintendo 3DS", ipod: "iPod touch", android: "Android phone" },
  },
  ja: {
    language: "言語",
    switchTo: ({ name }) => ja`${name}で表示`,
    names: { en: "英語", ja: "日本語" },
    device: "デバイス",
    simulated: "シミュレーション",
    simulatedSays: ({ device, title }) => ja`この画面はブラウザが描いています。実機の${device}は${title}を本体のハードウェアで描くため、見た目も動きもここと異なります。`,
    controls: "操作方法",
    about: "概要",
    aboutHeading: "このプレイヤーについて",
    aboutPlayer: "これは Pocket3D のウェブプレイヤーです。",
    aboutSays: ({ about }) => ja`${about}ゲームはブラウザの中で描かれ、まわりの本体は画像です。`,
    markOne: ({ mark }) => ja`${mark}は権利者の商標です。Pocket Nexus はその権利者と提携していません。`,
    markMany: ({ marks }) => ja`${marks}は、それぞれの権利者の商標です。Pocket Nexus はこれらの権利者と提携していません。`,
    pspCredit: "PSP の画像は、{author} によるモデルを {license} のもとで使い、ロゴを外して描いたものです。",
    keysPointer: ({ right, bottom }) => ja`画像のボタンとスティックも、ポインタで押して使えます。Enter は${right}、Backspace は${bottom}です。`,
    keysFinger: "画像のボタンとスティックで操作します。指で押してください。",
    touchStylus: "ポインタは下画面に触れるタッチペンになります。",
    touchTaps: "画面はタップにも反応します。",
    touchFinger: "ポインタは画面に触れる指になります。",
    arrows: "矢印キー",
    stick: "スティック",
    leftStick: "左スティック",
    rightStick: "右スティック",
    dpad: "十字キー",
    shell: {
      up: "上", down: "下", left: "左", right: "右",
      triangle: "上のボタン", circle: "右のボタン", cross: "下のボタン", square: "左のボタン",
      l: "L", r: "R", start: "START", select: "SELECT",
      pad: "十字キー", stick: "スティック", leftStick: "左スティック", rightStick: "右スティック",
    },
    playReal: "実機で遊ぶ",
    madeFor: "実機のために作られたゲーム",
    builtFor: ({ title, targets }) => ja`${title}は${targets}向けに作られています。`,
    builtForReal: ({ title }) => ja`${title}は携帯ゲーム機の実機向けに作られています。`,
    runsHere: ({ title }) => ja`${title}はこのブラウザで動いています。`,
    noPackagesYet: "ダウンロードできるパッケージはまだありません。",
    packagesHeld: ({ list }) => ja`Pocket Studio に${list}のパッケージがあります。`,
    packagesIn: "パッケージは Pocket Studio にあり、自分のデバイスにインストールできます。",
    sized: ({ name, size }) => `${name}（${size}）`,
    get: "Pocket Studio で入手",
    make: "自分のゲームを作る",
    remix: "このゲームをリミックス",
    noWebGPU: ({ title }) => ja`このブラウザは WebGPU に対応していないため、${title}を表示できません。`,
    list: join.ja,
    sentences: (...parts) => parts.filter(Boolean).join(""),
    targets: { psp: "PSP", vita: "PS Vita", "3ds": "ニンテンドー3DS", "ipod-touch": "iPod touch", android: "Android" },
    devices: { psp: "PSP", vita: "PS Vita", "3ds": "ニンテンドー3DS", ipod: "iPod touch", android: "Android スマートフォン" },
  },
};

/** The catalog of `lang`, with English under it for a key it lacks. */
export function catalog(lang) {
  const own = WORDS[lang] ?? {};
  return lang === DEFAULT_LANGUAGE ? WORDS.en : new Proxy(own, { get: (target, key) => (key in target ? target[key] : WORDS.en[key]) });
}

/** A language this player speaks, from a code such as "ja", "ja-JP" or "EN"; null for another. */
export function languageOf(code) {
  if (typeof code !== "string") return null;
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return base in LANGUAGES ? base : null;
}

/**
 * A game's words in `lang`: a string is the same in every language; an object holds one string per
 * language code (`{ en: "…", ja: "…" }`) and gives English, then its first, where it has none for `lang`.
 */
export function wordsIn(words, lang) {
  if (words == null) return "";
  if (typeof words !== "object") return String(words);
  return words[lang] ?? words[DEFAULT_LANGUAGE] ?? Object.values(words)[0] ?? "";
}

/** Whether a game's words say something in `lang` itself (not by falling back to English). */
export function saysIn(words, lang) {
  return words != null && typeof words === "object" && typeof words[lang] === "string" && words[lang] !== "";
}

/**
 * The language, from what a page can read, in the order at the top of this file: `search` (the
 * address's query), `cookie` (`document.cookie`), `stored` (the host's saved choice) and `languages`
 * (the browser's, first first). `from` says which one decided: "address", "cookie", "stored", "browser"
 * or "default". A choice is "address", "cookie" or "stored": the visitor made it.
 */
export function chooseLanguage({ search = "", cookie = "", stored = null, languages = [] } = {}) {
  const asked = languageOf(new URLSearchParams(search).get("lang"));
  if (asked) return { lang: asked, from: "address" };
  const kept = languageOf(cookie.split(/;\s*/).find((part) => part.startsWith(`${LANGUAGE_COOKIE}=`))?.slice(LANGUAGE_COOKIE.length + 1));
  if (kept) return { lang: kept, from: "cookie" };
  const saved = languageOf(stored);
  if (saved) return { lang: saved, from: "stored" };
  const browser = languageOf(languages[0]);
  if (browser) return { lang: browser, from: "browser" };
  return { lang: DEFAULT_LANGUAGE, from: "default" };
}

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * The page's language, read from this page. A `lang` in the address is saved as the visitor's choice
 * and taken out of the address; the rest of the query stays.
 */
export function readLanguage({ studio = "" } = {}) {
  let stored = null;
  try {
    stored = storage()?.getItem(STORED_LANGUAGE) ?? null;
  } catch {
    stored = null;
  }
  const chosen = chooseLanguage({
    search: globalThis.location?.search ?? "",
    cookie: globalThis.document?.cookie ?? "",
    stored,
    languages: globalThis.navigator?.languages?.length ? [...globalThis.navigator.languages] : [globalThis.navigator?.language].filter(Boolean),
  });
  if (chosen.from === "address") {
    saveLanguage(chosen.lang, { studio });
    try {
      const url = new URL(location.href);
      url.searchParams.delete("lang");
      history.replaceState(history.state, "", url.href);
    } catch {
      // (a page that cannot rewrite its address keeps the parameter)
    }
  }
  return chosen;
}

/**
 * Saves `lang` as the visitor's choice: in the host's localStorage, and in the cookie `lang` when the
 * page is on Pocket Studio's own host (`studio`, an origin), which the Studio's pages and Worker read.
 */
export function saveLanguage(lang, { studio = "" } = {}) {
  try {
    storage()?.setItem(STORED_LANGUAGE, lang);
  } catch {
    // (a browser that keeps nothing keeps nothing)
  }
  if (studio && globalThis.location?.origin === studio) {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${LANGUAGE_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }
}

/** The language after `lang` in `LANGUAGES`, for a control that offers the next one. */
export function nextLanguage(lang) {
  const codes = Object.keys(LANGUAGES);
  return codes[(codes.indexOf(lang) + 1) % codes.length];
}

/**
 * A sentence of a catalog with elements in its `{name}` slots, as nodes for `element.append`:
 * `layout("By {author}.", { author: link })` → ["By ", link, "."].
 */
export function layout(template, parts) {
  return template.split(/(\{[a-z]+\})/).filter(Boolean).map((piece) => (/^\{[a-z]+\}$/.test(piece) ? parts[piece.slice(1, -1)] ?? piece : piece));
}
