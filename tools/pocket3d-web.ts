// tools/pocket3d-web.ts: what a Pocket3D game's browser build takes from this
// repository beside the Rust kernel it links (devices/web/pocket-web-wgpu).
//
//   bun tools/pocket3d-web.ts stage <directory>
//       The modules a game's page loads, as files a static server serves:
//       the kernel's page modules, the Pocket3D title card, the realm of the
//       interface's guest with PocketJS's UI core, and the host helpers
//       bundled from the framework.
//   bun tools/pocket3d-web.ts cut <pack> <directory> [--piece 2]
//       A pack as pieces of one size (MiB) and the manifest
//       pocket_web_wgpu::source reads, for a host that limits a file's size.
//
// A game's build tool imports `stagePocket3dWeb` and `cutPack` from its
// PocketJS checkout; this file's command line is the same two functions.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The kernel: the crate a game links, and the modules of its page. */
export const POCKET3D_WEB = {
  crate: join(ROOT, "devices/web/pocket-web-wgpu"),
  modules: ["pocket3d-shell.js", "pocket3d-interface.js", "pocket3d-controls.js", "pocket3d-stage.js", "pocket3d-stage.css", "pocket3d-player.js", "pocket3d-player.css"],
  /** What the player's modules load beside themselves: the handhelds' shells with their profiles, and the display face. */
  assets: ["shells", "fonts"],
  /** The Pocket3D title card for a page, as pocket3d-title ships it. */
  title: ["pocket3d-title.js", "art.js"],
  /** The realm of a guest: PocketJS's AppInstance and what it imports. A realm started with
   *  `text: false` reads no text worker, so the worker and its wasm are not staged. */
  realm: ["app-instance.html", "app-instance.js", "wasm-ops.js", "offload-worker.js"],
  core: "pocketjs.wasm",
  /** What a host needs of the framework to hand a guest its contacts and name its buttons. */
  host: "pocketjs-host.js",
} as const;

/** The name of the manifest format `cutPack` writes. */
export const PACK_PIECES = "pocket-pack-pieces/1";

/**
 * Writes into `out` every file a Pocket3D game's page loads from PocketJS and
 * returns their names. The UI core is built when the checkout has none
 * (`bun tools/wasm.ts`). The game's own build adds its module, its page and
 * its interface bundles beside them.
 */
export async function stagePocket3dWeb(out: string): Promise<string[]> {
  mkdirSync(out, { recursive: true });
  const web = join(ROOT, "hosts/web");
  if (!existsSync(join(web, POCKET3D_WEB.core))) {
    const built = Bun.spawnSync(["bun", "tools/wasm.ts"], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
    if (built.exitCode !== 0) throw new Error("pocket3d-web: the UI core did not build (bun tools/wasm.ts)");
  }
  for (const file of POCKET3D_WEB.modules) cpSync(join(POCKET3D_WEB.crate, "web", file), join(out, file));
  const assets: string[] = [];
  for (const directory of POCKET3D_WEB.assets) {
    cpSync(join(POCKET3D_WEB.crate, "web", directory), join(out, directory), { recursive: true });
    assets.push(...readdirSync(join(POCKET3D_WEB.crate, "web", directory)).map((file) => `${directory}/${file}`));
  }
  for (const file of POCKET3D_WEB.title) cpSync(join(ROOT, "engine/pocket3d/crates/pocket3d-title/web", file), join(out, file));
  for (const file of [...POCKET3D_WEB.realm, POCKET3D_WEB.core]) cpSync(join(web, file), join(out, file));
  // One module of the framework's own sources: the contact wire format, the touch hit facts and the button bits.
  const entry = join(tmpdir(), `pocketjs-host-${process.pid}.ts`);
  writeFileSync(entry, `export { __packTouch, createTouchHitFacts } from ${JSON.stringify(join(ROOT, "framework/src/touch.ts"))};\nexport { BTN } from ${JSON.stringify(join(ROOT, "contracts/spec/spec.ts"))};\n`);
  const bundle = await Bun.build({ entrypoints: [entry], format: "esm", target: "browser" });
  if (!bundle.success) throw new Error(`pocket3d-web: ${bundle.logs.join("; ")}`);
  writeFileSync(join(out, POCKET3D_WEB.host), await bundle.outputs[0]!.text());
  return [...POCKET3D_WEB.modules, ...assets, ...POCKET3D_WEB.title, ...POCKET3D_WEB.realm, POCKET3D_WEB.core, POCKET3D_WEB.host];
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Cuts the pack at `file` into pieces of `pieceBytes` under `out`, each named
 * by its own hash, and writes the manifest that lists them, named by the
 * pack's hash. A host keeps such files in a browser's cache for as long as it
 * likes: a pack that changes has other names. Returns the manifest's name.
 */
export function cutPack(file: string, out: string, pieceBytes = 2 << 20): { manifest: string; pieces: string[]; bytes: number; sha256: string } {
  if (!Number.isInteger(pieceBytes) || pieceBytes < 1) throw new Error("pocket3d-web: a piece is a whole number of bytes");
  const whole = readFileSync(file);
  const hash = sha256(whole);
  mkdirSync(out, { recursive: true });
  const pieces: string[] = [];
  for (let at = 0; at < whole.length; at += pieceBytes) {
    const piece = whole.subarray(at, at + pieceBytes);
    pieces.push(`${sha256(piece).slice(0, 20)}.bin`);
    writeFileSync(join(out, pieces.at(-1)!), piece);
  }
  const manifest = `${hash.slice(0, 16)}.json`;
  writeFileSync(join(out, manifest), JSON.stringify({ pack: PACK_PIECES, bytes: whole.length, piece: pieceBytes, sha256: hash, pieces }, null, 1));
  // What was written is the pack.
  const again = new Bun.CryptoHasher("sha256");
  for (const name of pieces) again.update(readFileSync(join(out, name)));
  if (again.digest("hex") !== hash) throw new Error("pocket3d-web: the pieces do not make up the pack");
  return { manifest, pieces, bytes: whole.length, sha256: hash };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "stage" && rest[0]) {
    console.log((await stagePocket3dWeb(rest[0])).join("\n"));
  } else if (command === "cut" && rest[0] && rest[1]) {
    const at = rest.indexOf("--piece");
    const cut = cutPack(rest[0], rest[1], at >= 0 ? Math.round(Number(rest[at + 1]) * (1 << 20)) : undefined);
    console.log(`${cut.pieces.length} pieces, ${cut.bytes} bytes, ${cut.manifest}`);
  } else {
    console.error("usage: bun tools/pocket3d-web.ts stage <directory> | cut <pack> <directory> [--piece MiB]");
    process.exit(1);
  }
}
