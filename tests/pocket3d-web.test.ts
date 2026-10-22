import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cutPack, PACK_PIECES, stagePocket3dWeb } from "../tools/pocket3d-web.ts";

// devices/web/pocket-web-wgpu is what a Pocket3D game drawn with wgpu takes
// for a browser tab. This is its check without a game: the files a page
// loads are staged, a guest written by hand runs in the realm and is driven
// through the kernel's page module, and a pack is cut into pieces. The Rust
// side has its own (`cargo test` in the crate: the overlay pass on a GPU,
// 16-bit pictures, a pack in pieces read beside its file).
const ROOT = new URL("..", import.meta.url).pathname;

test("the staged directory holds what a page loads, and a guest runs in its realm", async () => {
  const staged = mkdtempSync(join(tmpdir(), "pocket3d-web-"));
  try {
    await stagePocket3dWeb(staged);

    const run = Bun.spawnSync(["bun", ROOT + "tests/fixtures/pocket3d-web/realm.ts", staged], { stdout: "pipe", stderr: "pipe" });
    expect(run.success, run.stderr.toString()).toBe(true);
    const out = JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
    expect(out.disposedAfterPagehide).toBe(true);
    expect(out.realmReleased).toBe(true);
    expect(out.shape).toEqual({ viewport: [32, 16], density: 2, physical: [64, 32], auxiliary: [24, 16], touch: "auxiliary", buttons: true, glyphs: "letters" });
    // A realm started with `text: false` starts no worker and gives the guest no offload.
    expect([out.workersWithoutText, out.offloadWithoutText]).toEqual([0, "undefined"]);
    expect([out.workersWithText, out.offloadWithText]).toEqual([1, "object"]);
    // The picture has its alpha: white at half strength where the panel is, nothing elsewhere.
    expect(out.changedAtFirst).toEqual([true, true]);
    expect(out.picture).toEqual({ bytes: 64 * 32 * 4, size: [64, 32], inside: [128, 128, 128, 128], outside: [0, 0, 0, 0] });
    expect(out.opaque).toEqual({ inside: [128, 128, 128, 255], outside: [0, 0, 0, 255] });
    expect(out.lower).toEqual([0, 255, 0, 255]);
    // Each surface is drawn again when it has changed, and not when the other has.
    expect(out.changedAfterReading).toEqual([false, false]);
    expect(out.changedAfterPanel).toEqual([true, false]);
    expect(out.wider).toEqual([128, 128, 128, 128]);
    expect(out.changedAfterLower).toEqual([false, true]);
    expect(out.lowerWider).toEqual([0, 255, 0, 255]);
    // A contact reaches the guest on the surface that takes touch, with the node under it and the buttons held.
    expect(out.heard).toEqual([{ touches: 1, hit: true, surface: 1, buttons: 0x2000, offload: "undefined", simHz: 30 }]);
    // (a game that names no rate leaves the realm at 60 turns a second)
    expect(out.simHzUnsaid).toBe(60);
    expect(out.drainedOnce).toBe(0);

    // The controls name a device's keys from PocketJS's button bits.
    const { legend, FACES } = await import(pathToFileURL(join(staged, "pocket3d-controls.js")).href);
    expect(legend({ sticks: 0, glyphs: "letters" })).toEqual([]);
    expect(legend({ sticks: 1, glyphs: "letters" })).toContainEqual(["I K J L", "X B Y A"]);
    expect(legend({ sticks: 2, glyphs: "playstation" })).toContainEqual(["Z X C V", "○ ✕ □ △"]);
    expect(FACES.letters.right).toBe("A");
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);

test("a pack is cut into pieces of one size with the manifest the kernel reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket3d-pack-"));
  try {
    const whole = Uint8Array.from({ length: 10_000 }, (_, i) => (i * 2_654_435_761) >>> 24);
    writeFileSync(join(directory, "a.pack"), whole);
    const cut = cutPack(join(directory, "a.pack"), join(directory, "pieces"), 4096);
    expect([cut.bytes, cut.pieces.length]).toEqual([10_000, 3]);
    const manifest = JSON.parse(readFileSync(join(directory, "pieces", cut.manifest), "utf8"));
    expect(manifest).toMatchObject({ pack: PACK_PIECES, bytes: 10_000, piece: 4096, pieces: cut.pieces });
    expect(manifest.pieces.map((name: string) => readFileSync(join(directory, "pieces", name)).length)).toEqual([4096, 4096, 1808]);
    expect(Buffer.concat(manifest.pieces.map((name: string) => readFileSync(join(directory, "pieces", name)))).equals(Buffer.from(whole))).toBe(true);
    expect(() => cutPack(join(directory, "a.pack"), join(directory, "pieces"), 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the dock's links say they come from a player, and a player that opens is reported once to the address a host named", async () => {
  const staged = mkdtempSync(join(tmpdir(), "pocket3d-player-"));
  try {
    await stagePocket3dWeb(staged);
    // (a page loads the module once: each copy here is another page. They are written before the first is read.)
    for (const page of ["links", "once", "fails", "refuses"]) writeFileSync(join(staged, `player-${page}.js`), readFileSync(join(staged, "pocket3d-player.js")));
    const load = (page: string) => import(pathToFileURL(join(staged, `player-${page}.js`)).href);
    const { fromPlayer } = await load("links");
    expect(fromPlayer("https://studio.example/studio/?app=a1")).toBe("https://studio.example/studio/?app=a1&from=player");
    expect(fromPlayer("https://studio.example/")).toBe("https://studio.example/?from=player");
    expect(fromPlayer("https://studio.example/?from=elsewhere&x=1")).toBe("https://studio.example/?from=player&x=1");

    // One GET with the game's id and the device, the visitor's session, and no answer read.
    const { reportOpened } = await load("once");
    const sent: [string, Record<string, unknown>][] = [];
    const send = (url: string, options: Record<string, unknown>) => (sent.push([url, options]), Promise.resolve());
    // (a host that names no address, or a page that knows no id, reports nothing and may report later)
    expect([reportOpened("", "a1", "vita", send), reportOpened("https://studio.example/api/events/player", "", "vita", send), reportOpened("javascript:alert(1)", "a1", "vita", send)]).toEqual([null, null, null]);
    expect(reportOpened("https://studio.example/api/events/player?kept=1", "a1", "3ds", send)).toBe("https://studio.example/api/events/player?kept=1&app=a1&layout=3ds");
    expect(sent).toEqual([["https://studio.example/api/events/player?kept=1&app=a1&layout=3ds", { mode: "no-cors", credentials: "include", cache: "no-store", keepalive: true, priority: "low" }]]);
    // Once a page: another device picked later sends nothing.
    expect(reportOpened("https://studio.example/api/events/player", "a1", "psp", send)).toBe(null);
    expect(sent.length).toBe(1);

    // A request that is refused, or that fails, is heard of by no one: nothing is thrown and nothing rejects.
    const rejections: unknown[] = [];
    const heard = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", heard);
    try {
      const failing = await load("fails");
      expect(failing.reportOpened("/api/events/player", "a1", "ipod", () => Promise.reject(new TypeError("Failed to fetch")), "https://game.example/")).toBe("https://game.example/api/events/player?app=a1&layout=ipod");
      const refusing = await load("refuses");
      expect(refusing.reportOpened("https://studio.example/e", "a1", "ipod", () => { throw new Error("blocked"); })).toBe("https://studio.example/e?app=a1&layout=ipod");
      await new Promise((done) => setTimeout(done, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", heard);
    }

  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);

test("a shell with no key stands for a screen that stands, the dock is Download and Remix by what the host says, a host may draw it, and About says what the player is", async () => {
  const staged = mkdtempSync(join(tmpdir(), "pocket3d-player-"));
  try {
    await stagePocket3dWeb(staged);
    const { shellFor, stoodUp } = await import(pathToFileURL(join(staged, "pocket3d-stage.js")).href);
    const { SHELLS } = await import(pathToFileURL(join(staged, "shells/profiles.js")).href);

    // A screen that lies keeps the shell as its picture has it; one that stands turns a keyless shell a quarter.
    expect(shellFor("ipod", { width: 480, height: 320 })).toBe(SHELLS.ipod);
    const stood = shellFor("ipod", { width: 320, height: 480 });
    expect([stood.standing, stood.width, stood.height, stood.art]).toEqual([true, SHELLS.ipod.height, SHELLS.ipod.width, SHELLS.ipod.art]);
    const [x, y, w, h] = SHELLS.ipod.screens.upper;
    expect(stood.screens.upper).toEqual([SHELLS.ipod.height - y - h, x, h, w]);
    expect(Math.abs(stood.screens.upper[2] / stood.screens.upper[3] / (320 / 480) - 1) < 0.05).toBe(true);
    // The Android phone stands for the Studio's 720 by 1280 and lies for a game that holds it on its side.
    const phone = shellFor("android", { width: 720, height: 1280 });
    const [px, py, pw, ph] = SHELLS.android.screens.upper;
    expect([phone.standing, phone.width, phone.height, phone.screens.upper]).toEqual([true, SHELLS.android.height, SHELLS.android.width, [SHELLS.android.height - py - ph, px, ph, pw]]);
    expect(phone.screens.upper[2] * 16).toBe(phone.screens.upper[3] * 9);
    expect(shellFor("android", { width: 1280, height: 720 })).toBe(SHELLS.android);
    // (what is at the picture's right, the home key's end, is at the bottom of the standing shell)
    const right = { width: 100, height: 40, screens: { upper: [90, 0, 10, 40] }, controls: [], sticks: [], parts: [] };
    expect(stoodUp(right).screens.upper).toEqual([0, 90, 40, 10]);
    // A shell with keys is not turned: its parts would have to turn too. Neither is one with two screens.
    expect(shellFor("vita", { width: 544, height: 960 })).toBe(SHELLS.vita);
    expect(shellFor("3ds", { width: 240, height: 400, lower: [240, 320] })).toBe(SHELLS["3ds"]);
    expect(shellFor("a device without a shell", { width: 320, height: 480 })).toBe(null);

    const { dockWords, getDoor, remixDoor, makeDoor, chromeAddress } = await import(pathToFileURL(join(staged, "pocket3d-player.js")).href);
    const runsOn = ["psp", "vita", "3ds"];
    const packages = [{ target: "psp", size: 42_934_596 }, { target: "3ds", size: 32_037_912 }];
    // Packages a visitor may get: the door to them. A game its host calls remixable: the door to a remix, after it.
    expect(dockWords({ runsOn, packages, allowNative: true })).toEqual({ doors: ["get"] });
    expect(dockWords({ runsOn, packages, remixable: true })).toEqual({ doors: ["get", "remix"] });
    // A host that said nothing leaves the game's own word.
    expect(dockWords({ runsOn })).toEqual({ doors: ["get"] });
    // None to get: the host lists none, or its author keeps them, or no one named any.
    expect(dockWords({ runsOn, packages: [], remixable: true })).toEqual({ doors: ["remix"] });
    expect(dockWords({ runsOn, packages, allowNative: false, remixable: true })).toEqual({ doors: ["remix"] });
    // Neither: the one door to the Studio.
    expect(dockWords({ runsOn, packages: [] })).toEqual({ doors: ["make"] });
    expect(dockWords({ runsOn, packages, allowNative: false })).toEqual({ doors: ["make"] });
    expect(dockWords({})).toEqual({ doors: ["make"] });
    // (a target the Studio does not name is no package to get)
    expect(dockWords({ packages: [{ target: "toaster", size: 1 }] })).toEqual({ doors: ["make"] });

    // Where each door leads: the game's page in Pocket Studio with its files or its remix open, by the label of the game's address.
    expect(getDoor({ studio: "https://studio.example", slug: "tokyo" })).toEqual({ text: "Download", href: "https://studio.example/games/tokyo?get=&from=player" });
    expect(remixDoor({ studio: "https://studio.example", id: "a1", slug: "tokyo" })).toEqual({ text: "Remix", href: "https://studio.example/games/tokyo?remix=&from=player" });
    expect(new URL(getDoor({ studio: "https://studio.example", slug: "tokyo" }).href).searchParams.has("get")).toBe(true);
    expect(new URL(remixDoor({ studio: "https://studio.example", slug: "tokyo" }).href).searchParams.has("remix")).toBe(true);
    // A game whose host named no label has no page: the Studio's front door, and the room's own way to a remix.
    expect(getDoor({ studio: "https://studio.example" })).toEqual({ text: "Download", href: "https://studio.example/?from=player" });
    expect(remixDoor({ studio: "https://studio.example", id: "a1" })).toEqual({ text: "Remix", href: "https://studio.example/studio/?remix=a1&from=player" });
    expect(makeDoor({ studio: "https://studio.example" })).toEqual({ text: "Make a game of your own", href: "https://studio.example/?from=player" });

    // The dock has no heading and no sentence, and a low window keeps both of its doors.
    const sheet = readFileSync(join(staged, "pocket3d-player.css"), "utf8");
    expect(/data-pocket-pitch/.test(sheet)).toBe(false);
    const low = sheet.slice(sheet.indexOf("@media (max-height: 560px)"));
    expect(low).not.toContain("display: none; }\n  [data-pocket-action]");
    expect(/\[data-pocket-action[^\]]*\][^{]*\{[^}]*display: none/.test(low)).toBe(false);
    expect(/\[data-pocket-action="(get|remix|make)"\]/.test(sheet)).toBe(false);
    // Every rule for the dock's own links holds only while no host draws the dock.
    for (const [rule] of sheet.matchAll(/^[^\n{}/]*\[data-pocket-action[^\n{]*\{/gm)) expect([rule, rule.includes("[data-pocket-studio]:not([data-pocket-hosted])")]).toEqual([rule, true]);
    // (a door that is not shown is not drawn: the rule that lays a door out does not outrank `hidden`)
    expect(sheet).toContain("[data-pocket-studio]:not([data-pocket-hosted]) [data-pocket-action][hidden] { display: none; }");
    const player = readFileSync(join(staged, "pocket3d-player.js"), "utf8");
    expect(player).toContain('link.toggleAttribute("data-pocket-primary", dockSays.doors[0] === action)');
    for (const gone of ["data-pocket-pitch", "withoutPackages.heading", "current.note", "megabytes("]) expect([gone, player.includes(gone)]).toEqual([gone, false]);

    // A host's own dock: a script under /play/ on the page's own origin, and nothing else.
    const here = "https://tokyo.studio.example";
    expect(chromeAddress("/play/dock.js", here)).toBe("https://tokyo.studio.example/play/dock.js");
    expect(chromeAddress("/play/chrome/dock-1.2.js", here)).toBe("https://tokyo.studio.example/play/chrome/dock-1.2.js");
    for (const refused of ["https://elsewhere.example/play/dock.js", "//elsewhere.example/play/dock.js", "/play/../app.js", "/play//dock.js", "/assets/dock.js", "/play/dock.mjs", "/play/dock.js?x=1", "play/dock.js", "", null, undefined, 7, {}]) {
      expect([refused, chromeAddress(refused as string, here)]).toEqual([refused, null]);
    }
    // The player hands the dock over only after the module is read, and takes it back when the mount fails.
    expect(player).toContain("const module = await import(address);");
    expect(player).toContain('dock.setAttribute("data-pocket-hosted", "")');
    expect(player).toContain("module.mount({ dock, frame, app, studio, lang: told, title: game.title })");
    expect(player).toContain('dock.removeAttribute("data-pocket-hosted");\n      dock.replaceChildren(actions);');
    expect(player).toContain("hostDock?.speak?.(lang)");
    // The mark opens one sentence: the player's own, the same for every game and device.
    expect(player).toContain("tip.replaceChildren(make(\"p\", { text: w.simulatedSays({ device: label(current), title: game.title }) }));");
    // What the player is, in About: the page's sentence, or the player's own.
    const { WORDS } = await import(pathToFileURL(join(staged, "pocket3d-words.js")).href);
    expect(WORDS.en.aboutPlayer).toBe("This is the Pocket3D web player.");
    expect(WORDS.en.aboutSays({ about: WORDS.en.aboutPlayer })).toBe("This is the Pocket3D web player. The game is drawn in your browser; the handheld around it is a picture.");
    expect(player).toContain("about == null ? w.aboutPlayer : wordsIn(about, lang)");
    // A label that is more than a trademark names the word that is one: About lists "Android", not "Android phone".
    expect(player).toContain("d.mark == null ? label(d) : wordsIn(d.mark, lang)");
    // A game for one device names one mark in the singular.
    expect(WORDS.en.markOne({ mark: "Android" })).toBe("Android is a trademark of its owner. Pocket Nexus is not affiliated with it.");
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);

test("the player speaks English and Japanese: each catalog has every word, and the language is read in one order", async () => {
  const staged = mkdtempSync(join(tmpdir(), "pocket3d-words-"));
  try {
    await stagePocket3dWeb(staged);
    const words = await import(pathToFileURL(join(staged, "pocket3d-words.js")).href);
    const { LANGUAGES, WORDS, DEFAULT_LANGUAGE, chooseLanguage, languageOf, wordsIn, saysIn, layout, nextLanguage, catalog } = words;
    expect(LANGUAGES).toEqual({ en: "English", ja: "日本語" });
    expect(DEFAULT_LANGUAGE).toBe("en");

    // Every catalog has the keys of the English one, nested ones too, of the same kind.
    const shapeOf = (value: unknown): unknown =>
      typeof value === "function" ? "function" : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shapeOf(inner)])) : typeof value;
    for (const code of Object.keys(LANGUAGES)) expect([code, shapeOf(WORDS[code])]).toEqual([code, shapeOf(WORDS.en)]);
    // The names a page shows for every target and shell, in each language.
    expect(WORDS.ja.devices).toEqual({ psp: "PSP", vita: "PS Vita", "3ds": "ニンテンドー3DS", ipod: "iPod touch", android: "Android スマートフォン" });
    expect(WORDS.ja.targets["3ds"]).toBe("ニンテンドー3DS");
    // Japanese text holds no English the visitor reads, beyond names and keys.
    const names = /Pocket(?: Studio| Nexus|3D)|PSP|PS Vita|3DS|iPod touch|Android|WebGPU|Enter|Backspace|START|SELECT|CC BY 4\.0|\{[a-z]+\}|\b[LR]\b|MB|Gabarito|Dibad/g;
    const flat = (value: unknown, facts: Record<string, unknown>): string[] =>
      typeof value === "function" ? [String(value({ title: "T", device: "D", mark: "M", marks: "M", right: "○", bottom: "✕", name: "N", about: "A" }))] : value && typeof value === "object" ? Object.values(value).flatMap((inner) => flat(inner, facts)) : [String(value)];
    const { list: _list, names: _names, ...said } = WORDS.ja;
    for (const text of flat(said, {})) {
      const left = text.replace(names, "").replace(/\b[TDMANX]\b/g, "");
      expect([text, /[A-Za-z]{2,}/.test(left)]).toEqual([text, false]);
    }

    // The order: the address, the cookie, the host's saved choice, the browser, English.
    expect(chooseLanguage({ search: "?lang=ja&device=psp", cookie: "lang=en", stored: "en", languages: ["en-US"] })).toEqual({ lang: "ja", from: "address" });
    expect(chooseLanguage({ search: "?lang=fr", cookie: "theme=x; lang=ja", stored: "en", languages: ["en-US"] })).toEqual({ lang: "ja", from: "cookie" });
    expect(chooseLanguage({ cookie: "theme=x", stored: "ja", languages: ["en-US"] })).toEqual({ lang: "ja", from: "stored" });
    expect(chooseLanguage({ languages: ["ja-JP", "en"] })).toEqual({ lang: "ja", from: "browser" });
    expect(chooseLanguage({ languages: ["en-GB", "ja"] })).toEqual({ lang: "en", from: "browser" });
    expect(chooseLanguage({ languages: ["fr-FR", "ja"] })).toEqual({ lang: "en", from: "default" });
    expect(chooseLanguage()).toEqual({ lang: "en", from: "default" });
    expect([languageOf("JA_jp"), languageOf("en"), languageOf("de"), languageOf(undefined)]).toEqual(["ja", "en", null, null]);
    expect([nextLanguage("en"), nextLanguage("ja")]).toEqual(["ja", "en"]);

    // A game's words: one string for every language, or one per language with English under it.
    expect([wordsIn("Same.", "ja"), wordsIn({ en: "One.", ja: "一。" }, "ja"), wordsIn({ en: "One." }, "ja"), wordsIn(null, "ja")]).toEqual(["Same.", "一。", "One.", ""]);
    expect([saysIn({ en: "One.", ja: "一。" }, "ja"), saysIn({ en: "One." }, "ja"), saysIn("One.", "ja")]).toEqual([true, false, false]);
    expect(layout("By {author}, under {license}.", { author: "A", license: "L" })).toEqual(["By ", "A", ", under ", "L", "."]);
    // Japanese with facts in it: a space where Latin meets Japanese, none between Japanese, none by a bracket.
    expect(WORDS.ja.simulatedSays({ device: "ニンテンドー3DS", title: "Pocket Tokyo" })).toBe("この画面はブラウザが描いています。実機のニンテンドー3DS は Pocket Tokyo を本体のハードウェアで描くため、見た目も動きもここと異なります。");
    expect(WORDS.ja.simulatedSays({ device: "PS Vita", title: "ポケット東京" })).toStartWith("この画面はブラウザが描いています。実機の PS Vita はポケット東京を");
    expect(WORDS.ja.keysPointer({ right: "A", bottom: "B" })).toEndWith("Enter は A、Backspace は B です。");
    expect(WORDS.ja.keysPointer({ right: "○", bottom: "✕" })).toEndWith("Enter は○、Backspace は✕です。");
    expect(WORDS.ja.aboutSays({ about: "This is the PocketJS web player." })).toBe("This is the PocketJS web player. ゲームはブラウザの中で描かれ、まわりの本体は画像です。");
    // A catalog that lacks a word reads English's.
    WORDS.xx = { controls: "Kontrolle" };
    try {
      expect([catalog("xx").controls, catalog("xx").about]).toEqual(["Kontrolle", "About"]);
    } finally {
      delete WORDS.xx;
    }

    // The dock, the doors and the keys in Japanese.
    const { dockWords, getDoor, remixDoor, makeDoor, fromPlayer } = await import(pathToFileURL(join(staged, "pocket3d-player.js")).href);
    const runsOn = ["psp", "vita", "3ds"];
    const packages = [{ target: "psp", size: 42_934_596 }, { target: "3ds", size: 32_037_912 }];
    // (which doors a dock has is the same in every language)
    expect(dockWords({ runsOn, packages, remixable: true, lang: "ja" })).toEqual({ doors: ["get", "remix"] });
    expect(dockWords({ packages: [], lang: "ja" })).toEqual({ doors: ["make"] });
    // Links into Pocket Studio carry the language; the front door is the language's own page.
    expect(fromPlayer("https://studio.example/studio/?app=a1", "ja")).toBe("https://studio.example/studio/?app=a1&from=player&lang=ja");
    expect(getDoor({ studio: "https://studio.example", slug: "tokyo", lang: "ja", carry: "ja" })).toEqual({ text: "ダウンロード", href: "https://studio.example/games/tokyo?get=&from=player&lang=ja" });
    expect(remixDoor({ studio: "https://studio.example", id: "a1", slug: "tokyo", lang: "ja", carry: "ja" })).toEqual({ text: "リミックス", href: "https://studio.example/games/tokyo?remix=&from=player&lang=ja" });
    expect(remixDoor({ studio: "https://studio.example", id: "a1", lang: "ja", carry: "ja" })).toEqual({ text: "リミックス", href: "https://studio.example/studio/?remix=a1&from=player&lang=ja" });
    expect(makeDoor({ studio: "https://studio.example", lang: "ja", carry: "ja" })).toEqual({ text: "自分のゲームを作る", href: "https://studio.example/ja/?from=player" });
    // (English chosen by a visitor whose browser asks for Japanese: the front door is told so)
    expect(makeDoor({ studio: "https://studio.example", carry: "en" })).toEqual({ text: "Make a game of your own", href: "https://studio.example/?from=player&lang=en" });
    const { legend } = await import(pathToFileURL(join(staged, "pocket3d-controls.js")).href);
    expect(legend({ sticks: 2, glyphs: "playstation" }, WORDS.ja).slice(0, 3)).toEqual([["W A S D", "左スティック"], ["矢印キー", "十字キー"], ["I J K L", "右スティック"]]);
    expect(legend({ sticks: 1, glyphs: "letters" })[0]).toEqual(["W A S D", "stick"]);

    // The player builds every word it shows from the catalog: no English sentence is left in its source.
    const player = readFileSync(join(staged, "pocket3d-player.js"), "utf8");
    for (const gone of ["\"Simulated\"", "\"Controls\"", "\"About this player\"", "\"Get it in Pocket Studio\"", "\"Download\"", "\"Remix\"", "Play it on the real thing", "Your browser draws this picture"]) expect([gone, player.includes(gone)]).toEqual([gone, false]);
    const stage = readFileSync(join(staged, "pocket3d-stage.js"), "utf8");
    expect(stage.includes("\"Directional pad\"")).toBe(false);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);
