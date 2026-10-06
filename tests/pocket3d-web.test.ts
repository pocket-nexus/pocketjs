import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cutPack, PACK_PIECES, POCKET3D_WEB, stagePocket3dWeb } from "../tools/pocket3d-web.ts";

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
    const files = await stagePocket3dWeb(staged);
    expect(files.sort()).toEqual([
      "app-instance.html", "app-instance.js", "art.js", "fonts/OFL.txt", "fonts/gabarito-800-latin.woff2", "offload-worker.js",
      "pocket3d-controls.js", "pocket3d-interface.js", "pocket3d-player.css", "pocket3d-player.js", "pocket3d-shell.js", "pocket3d-stage.css", "pocket3d-stage.js", "pocket3d-title.js",
      "pocketjs-host.js", "pocketjs.wasm",
      "shells/3ds-parts.webp", "shells/3ds.webp", "shells/ATTRIBUTION.md", "shells/ipod.webp", "shells/profiles.js", "shells/psp-parts.webp", "shells/psp.webp", "shells/vita-parts.webp", "shells/vita.webp",
      "wasm-ops.js",
    ]);
    for (const file of files) expect([file, existsSync(join(staged, file))]).toEqual([file, true]);
    // PocketJS's own files are staged as they are.
    for (const file of POCKET3D_WEB.realm) expect(readFileSync(join(staged, file), "utf8")).toBe(readFileSync(ROOT + "hosts/web/" + file, "utf8"));
    // Every module a staged module imports is staged too.
    for (const file of files.filter((name) => name.endsWith(".js"))) {
      for (const [, from] of readFileSync(join(staged, file), "utf8").matchAll(/^import [^;]*? from "\.\/([^"]+)";$/gm)) {
        // (a module in a directory names its neighbours from there)
        const named = join(file, "..", from!);
        expect([file, from, files.includes(named)]).toEqual([file, from, true]);
      }
    }

    const run = Bun.spawnSync(["bun", ROOT + "tests/fixtures/pocket3d-web/realm.ts", staged], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const out = JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
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

    // The stylesheet styles every element the two modules mark, by the attributes they set.
    const sheet = readFileSync(join(staged, "pocket3d-stage.css"), "utf8");
    const marks = new Set<string>();
    for (const file of ["pocket3d-stage.js", "pocket3d-controls.js"]) {
      for (const [, name] of readFileSync(join(staged, file), "utf8").matchAll(/dataset\.pocket([A-Z][A-Za-z]*)/g)) marks.add("data-pocket-" + name![0]!.toLowerCase() + name!.slice(1));
    }
    expect([...marks].sort()).toEqual(["data-pocket-choices", "data-pocket-control", "data-pocket-pad", "data-pocket-part", "data-pocket-partKind", "data-pocket-screen", "data-pocket-shell", "data-pocket-shellArt", "data-pocket-shellParts", "data-pocket-stage", "data-pocket-stick"]);
    for (const mark of marks) {
      const attribute = mark.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
      expect([attribute, sheet.includes(`[${attribute}`)]).toEqual([attribute, true]);
    }

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
    expect(manifest).toEqual({ pack: PACK_PIECES, bytes: 10_000, piece: 4096, sha256: cut.sha256, pieces: cut.pieces });
    // (the name the Rust reader checks: devices/web/pocket-web-wgpu/src/source.rs)
    expect(readFileSync(ROOT + "devices/web/pocket-web-wgpu/src/source.rs", "utf8")).toContain(`pub const MANIFEST: &str = "${PACK_PIECES}";`);
    expect(manifest.pieces.map((name: string) => readFileSync(join(directory, "pieces", name)).length)).toEqual([4096, 4096, 1808]);
    expect(Buffer.concat(manifest.pieces.map((name: string) => readFileSync(join(directory, "pieces", name)))).equals(Buffer.from(whole))).toBe(true);
    // Cut again, the pack has the same names: a host's cache keeps them.
    expect(cutPack(join(directory, "a.pack"), join(directory, "again"), 4096)).toEqual(cut);
    expect(() => cutPack(join(directory, "a.pack"), join(directory, "pieces"), 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the kernel names no game, and its manifest and documents name its license", () => {
  const kernel = ROOT + "devices/web/pocket-web-wgpu/";
  const text = (directory: string): string[] => readdirSync(kernel + directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? text(`${directory}/${entry.name}`) : /\.(rs|js|css|toml|txt)$/.test(entry.name) ? [`${directory}/${entry.name}`] : []));
  const sources = [...text("src"), ...text("web"), "tests/overlay.rs", "Cargo.toml"];
  for (const file of sources) expect([file, /tokyo|atlas|maneuver|openstrike/i.test(readFileSync(kernel + file, "utf8"))]).toEqual([file, false]);
  expect(readFileSync(kernel + "Cargo.toml", "utf8")).toContain('license-file = "../../../pocket3d/LICENSE"');
  const readme = readFileSync(kernel + "README.md", "utf8");
  expect(readme).toContain("(../../../pocket3d/LICENSE)");
  expect(readme).toContain("title card");
  expect(readFileSync(ROOT + "devices/README.md", "utf8")).toContain("`web/pocket-web-wgpu`");
  expect(readFileSync(ROOT + "pocket3d/README.md", "utf8")).toContain("pocket-web-wgpu");
});

test("each shell has its pictures, its screens in the device's shape, and controls that are in the picture", async () => {
  const web = ROOT + "devices/web/pocket-web-wgpu/web/";
  const { SHELLS } = await import(pathToFileURL(web + "shells/profiles.js").href);
  const { SHELL_IDS } = await import("../tools/pocket3d-shells.ts");
  expect(Object.keys(SHELLS)).toEqual([...SHELL_IDS]);
  // The screens of the devices, in their own pixels (a device's profile under contracts/ and the 3DS's two).
  const screens: Record<string, Record<string, [number, number]>> = { psp: { upper: [480, 272] }, vita: { upper: [960, 544] }, "3ds": { upper: [400, 240], lower: [320, 240] }, ipod: { upper: [480, 320] } };
  const buttons = ["up", "down", "left", "right", "triangle", "circle", "cross", "square", "l", "r", "start", "select"];
  let bytes = 0;
  for (const id of SHELL_IDS) {
    const shell = SHELLS[id];
    for (const file of [shell.art, shell.partsArt].filter(Boolean)) {
      const picture = readFileSync(web + "shells/" + file);
      // (a WebP: "RIFF" …… "WEBP")
      expect([file, picture.subarray(0, 4).toString("latin1"), picture.subarray(8, 12).toString("latin1")]).toEqual([file, "RIFF", "WEBP"]);
      // A shell is read before a game's first frame: a picture of it stays under 96 kB.
      expect([file, picture.length < 96_000]).toEqual([file, true]);
      bytes += picture.length;
    }
    expect(Object.keys(shell.screens)).toEqual(Object.keys(screens[id]!));
    for (const [name, rect] of Object.entries(shell.screens) as [string, number[]][]) {
      const [width, height] = screens[id]![name]!;
      // The picture's screen has the device's shape to a twentieth, and the game's canvas is fitted inside it.
      expect([id, name, Math.abs(rect[2]! / rect[3]! / (width / height) - 1) < 0.05]).toEqual([id, name, true]);
    }
    const inside = (rect: number[]) => rect[0]! >= 0 && rect[1]! >= 0 && rect[0]! + rect[2]! <= shell.width && rect[1]! + rect[3]! <= shell.height;
    for (const control of shell.controls) {
      expect([id, control.button, buttons.includes(control.button), inside(control.rect)]).toEqual([id, control.button, true, true]);
      expect([id, control.button, control.part === null || control.part < shell.parts.length]).toEqual([id, control.button, true]);
    }
    for (const part of shell.parts) {
      expect([id, inside(part.slice(0, 4)), part[4] + part[2] <= shell.partsWidth, part[5] + part[3] <= shell.partsHeight]).toEqual([id, true, true, true]);
    }
    for (const stick of shell.sticks) expect([id, stick.id, stick.part < shell.parts.length, stick.travel > 0]).toEqual([id, stick.id, true, true]);
    // A device with buttons has every one a guest reads; a touch panel has none.
    expect([id, shell.controls.map((c: { button: string }) => c.button).sort()]).toEqual([id, id === "ipod" ? [] : [...buttons].sort()]);
  }
  // The four together, for a page that has shown each: under 400 kB.
  expect(bytes < 400_000).toBe(true);
});

test("the player's display face is a file of the kernel, with its licence beside it", () => {
  const web = ROOT + "devices/web/pocket-web-wgpu/web/";
  const face = readFileSync(web + "fonts/gabarito-800-latin.woff2");
  expect([face.subarray(0, 4).toString("latin1"), face.length < 24_000]).toEqual(["wOF2", true]);
  expect(readFileSync(web + "fonts/OFL.txt", "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
  const sheet = readFileSync(web + "pocket3d-player.css", "utf8");
  expect(sheet).toContain('url("./fonts/gabarito-800-latin.woff2")');
  expect(sheet).toContain("font-display: swap");
  // The page asks no other host for anything it draws with.
  for (const file of ["pocket3d-player.css", "pocket3d-stage.css"]) expect([file, /url\(["']?https?:/.test(readFileSync(web + file, "utf8"))]).toEqual([file, false]);
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

    // The player learns the address from the host or the page, and names no route of its own.
    const source = readFileSync(join(staged, "pocket3d-player.js"), "utf8");
    expect(source).toContain("said.opened");
    expect(source).toContain('meta("pocket-opened")');
    expect(/api\/events|\/events\//.test(source)).toBe(false);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);

test("a shell with no key stands for a screen that stands, the dock follows what the host says of packages, and About says what the player is", async () => {
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
    // (what is at the picture's right, the home key's end, is at the bottom of the standing shell)
    const right = { width: 100, height: 40, screens: { upper: [90, 0, 10, 40] }, controls: [], sticks: [], parts: [] };
    expect(stoodUp(right).screens.upper).toEqual([0, 90, 40, 10]);
    // A shell with keys is not turned: its parts would have to turn too. Neither is one with two screens.
    expect(shellFor("vita", { width: 544, height: 960 })).toBe(SHELLS.vita);
    expect(shellFor("3ds", { width: 240, height: 400, lower: [240, 320] })).toBe(SHELLS["3ds"]);
    expect(shellFor("a device without a shell", { width: 320, height: 480 })).toBe(null);
    expect(readFileSync(join(staged, "pocket3d-stage.css"), "utf8")).toContain("[data-pocket-shell][data-pocket-standing] > [data-pocket-shell-art]");

    const { dockWords } = await import(pathToFileURL(join(staged, "pocket3d-player.js")).href);
    const runsOn = ["psp", "vita", "3ds"];
    const packages = [{ target: "psp", size: 42_934_596 }, { target: "3ds", size: 32_037_912 }];
    const real = { heading: "Play it on the real thing", doors: ["get", "make"] };
    // Packages a visitor may get: where they are, and both doors.
    expect(dockWords({ title: "A Game", runsOn, packages, allowNative: true })).toEqual({ ...real, sentence: "A Game is built for PSP, PS Vita and Nintendo 3DS. Pocket Studio has its packages for PSP (43 MB) and Nintendo 3DS (32 MB)." });
    expect(dockWords({ title: "A Game", runsOn, packages }).doors).toEqual(["get", "make"]);
    // A host that said nothing leaves the game's own word.
    expect(dockWords({ title: "A Game", runsOn })).toEqual({ ...real, sentence: "A Game is built for PSP, PS Vita and Nintendo 3DS. Its packages are in Pocket Studio, ready to install on your own." });
    // None to get: the host lists none, or its author keeps them, or no one named any. One door, and no word of packages to get.
    const plain = { heading: "Made for real handhelds", sentence: "A Game is built for PSP, PS Vita and Nintendo 3DS. It has no packages to download yet.", doors: ["make"] };
    expect(dockWords({ title: "A Game", runsOn, packages: [] })).toEqual(plain);
    expect(dockWords({ title: "A Game", runsOn, packages, allowNative: false })).toEqual(plain);
    expect(dockWords({ title: "A Game" })).toEqual({ ...plain, sentence: "A Game runs here in your browser. It has no packages to download yet." });
    // The page's own words for it.
    expect(dockWords({ title: "A Game", packages: [], withoutPackages: { heading: "Made with Pocket Studio", sentence: "A Game is a PocketJS app." } })).toEqual({ heading: "Made with Pocket Studio", sentence: "A Game is a PocketJS app.", doors: ["make"] });

    // A low window keeps the dock's first door, whichever it is, and hides the other.
    const sheet = readFileSync(join(staged, "pocket3d-player.css"), "utf8");
    const low = sheet.slice(sheet.indexOf("@media (max-height: 560px)"));
    expect(low).toContain("[data-pocket-action]:not([data-pocket-primary]) { display: none; }");
    expect(/\[data-pocket-action="(get|make)"\]/.test(sheet)).toBe(false);
    const player = readFileSync(join(staged, "pocket3d-player.js"), "utf8");
    expect(player).toContain('get.toggleAttribute("data-pocket-primary", words.doors[0] === "get")');
    expect(player).toContain('own.toggleAttribute("data-pocket-primary", words.doors[0] === "make")');
    // What the player is, in About: the page's sentence, or this one.
    expect(player).toContain('about = "This is the Pocket3D web player."');
    expect(player).toContain("`${about} The game is drawn in your browser; the handheld around it is a picture.`");
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}, 120_000);
