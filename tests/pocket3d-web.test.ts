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
    expect(files.sort()).toEqual(["app-instance.html", "app-instance.js", "art.js", "offload-worker.js", "pocket3d-controls.js", "pocket3d-interface.js", "pocket3d-shell.js", "pocket3d-stage.css", "pocket3d-stage.js", "pocket3d-title.js", "pocketjs-host.js", "pocketjs.wasm", "wasm-ops.js"]);
    for (const file of files) expect([file, existsSync(join(staged, file))]).toEqual([file, true]);
    // PocketJS's own files are staged as they are.
    for (const file of POCKET3D_WEB.realm) expect(readFileSync(join(staged, file), "utf8")).toBe(readFileSync(ROOT + "hosts/web/" + file, "utf8"));
    // Every module a staged module imports is staged too.
    for (const file of files.filter((name) => name.endsWith(".js"))) {
      for (const [, from] of readFileSync(join(staged, file), "utf8").matchAll(/^import [^;]*? from "\.\/([^"]+)";$/gm)) expect([file, from, files.includes(from!)]).toEqual([file, from, true]);
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
    expect([...marks].sort()).toEqual(["data-pocket-button", "data-pocket-choices", "data-pocket-group", "data-pocket-screen", "data-pocket-stage", "data-pocket-stick"]);
    for (const mark of marks) expect([mark, sheet.includes(`[${mark}`)]).toEqual([mark, true]);

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
  const sources = [...readdirSync(kernel + "src").map((f) => "src/" + f), ...readdirSync(kernel + "web").map((f) => "web/" + f), "tests/overlay.rs", "Cargo.toml"];
  for (const file of sources) expect([file, /tokyo|atlas|maneuver|openstrike/i.test(readFileSync(kernel + file, "utf8"))]).toEqual([file, false]);
  expect(readFileSync(kernel + "Cargo.toml", "utf8")).toContain('license-file = "../../../pocket3d/LICENSE"');
  const readme = readFileSync(kernel + "README.md", "utf8");
  expect(readme).toContain("(../../../pocket3d/LICENSE)");
  expect(readme).toContain("title card");
  expect(readFileSync(ROOT + "devices/README.md", "utf8")).toContain("`web/pocket-web-wgpu`");
  expect(readFileSync(ROOT + "pocket3d/README.md", "utf8")).toContain("pocket-web-wgpu");
});
