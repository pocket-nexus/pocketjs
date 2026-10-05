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
