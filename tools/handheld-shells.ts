// tools/handheld-shells.ts: the handhelds' shells a page shows a device's
// screens in, in two sets: the Pocket3D player's
// (devices/web/pocket-web-wgpu/web/shells) and the MicroTS playground's
// (site/microts/shells; the playground also shows the PSP and the 3DS of the
// Pocket3D set).
//
//   bun tools/handheld-shells.ts pocket3d [psp|vita|3ds|ipod|android …] [--samples 128] [--no-render]
//   bun tools/handheld-shells.ts microts [gba|iphone-4s|ipod-touch-5|bb-classic|ipod-nano …] [--samples 128] [--no-render]
//
// For each device, Blender renders its front in two passes
// (tools/handheld-models/shells.py → dist/handheld-shells/<id>/): the case with
// its moving parts taken out, and each of those parts alone, on one sheet.
// This tool encodes both as WebP with alpha and writes every device's profile
// into one module per set, `profiles.js`: the picture's size, the screens'
// rectangles, each part's rectangle in the picture and its place on the
// sheet, each control's rectangle and the part that moves with it, each
// stick's centre and travel, and the keys that belong to the system.
//
// It needs Blender (BLENDER, or /Applications/Blender.app) and `cwebp` on the
// path. The renders stay under the ignored dist/; the encoded shells are
// product assets and are committed. Cycles' noise differs between two runs, so
// a rerun changes the files' bytes: run it when a shell changes.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RENDERS = join(ROOT, "dist/handheld-shells");
export const SHELL_SETS = {
  pocket3d: { out: "devices/web/pocket-web-wgpu/web/shells", ids: ["psp", "vita", "3ds", "ipod", "android"] },
  microts: { out: "site/microts/shells", ids: ["gba", "iphone-4s", "ipod-touch-5", "bb-classic", "ipod-nano"] },
} as const;
export type ShellSet = keyof typeof SHELL_SETS;

/** Models of other authors that shells.py renders and this repository does not carry, by shell. */
export const DOWNLOADS: Record<string, { title: string; author: string; url: string; uid: string; license: string; sha256: string }> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(join(ROOT, "tools/handheld-models/downloads.json"), "utf8"))).filter(([key]) => key !== "about"),
) as never;

/**
 * Puts a shell's downloaded model at dist/handheld-sources/<id>.glb, once: from Sketchfab, with the token
 * in SKETCHFAB_TOKEN or ~/.sketchfab-token (Sketchfab gives a download only to an account). The file must
 * have the SHA-256 downloads.json names.
 */
async function fetchSource(id: string): Promise<void> {
  const source = DOWNLOADS[id];
  if (!source) return;
  const file = join(ROOT, "dist/handheld-sources", `${id}.glb`);
  const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (existsSync(file) && sha(readFileSync(file)) === source.sha256) return;
  const saved = join(homedir(), ".sketchfab-token");
  const token = process.env.SKETCHFAB_TOKEN ?? (existsSync(saved) ? readFileSync(saved, "utf8").trim() : "");
  if (!token) throw new Error(`handheld-shells: ${id} is ${source.url}; set SKETCHFAB_TOKEN (or ~/.sketchfab-token) to download it`);
  const links = await fetch(`https://api.sketchfab.com/v3/models/${source.uid}/download`, { headers: { Authorization: `Token ${token}` } });
  if (!links.ok) throw new Error(`handheld-shells: Sketchfab answered ${links.status} for ${id}`);
  const { glb } = (await links.json()) as { glb?: { url: string } };
  if (!glb) throw new Error(`handheld-shells: Sketchfab offers no GLB of ${id}`);
  const bytes = new Uint8Array(await (await fetch(glb.url)).arrayBuffer());
  if (sha(bytes) !== source.sha256) throw new Error(`handheld-shells: ${id}'s GLB is not the one downloads.json names (${sha(bytes)})`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`${id}: downloaded ${source.title} by ${source.author} (${bytes.length} bytes)`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const set = args[0] as ShellSet;
  if (!(set in SHELL_SETS)) throw new Error(`handheld-shells: name a set first: ${Object.keys(SHELL_SETS).join(" or ")}`);
  const { out, ids: all } = SHELL_SETS[set];
  const OUT = join(ROOT, out);
  const samples = args.includes("--samples") ? args[args.indexOf("--samples") + 1]! : "128";
  const wanted = args.filter((a) => (all as readonly string[]).includes(a));
  const ids = wanted.length ? wanted : [...all];
  if (!args.includes("--no-render")) {
    for (const id of ids) await fetchSource(id);
    const blender = process.env.BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
    if (!existsSync(blender)) throw new Error(`handheld-shells: no Blender at ${blender} (set BLENDER)`);
    for (const id of ids) {
      const run = Bun.spawnSync([blender, "--background", "--python", join(ROOT, "tools/handheld-models/shells.py"), "--", id, "--samples", samples], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      // (Blender exits with 0 when its script has raised: the script's last line says it reached the end)
      const done = run.stdout.toString().split("\n").find((line) => /^shells: \S+ \d+ x \d+ \d+ parts$/.test(line));
      if (run.exitCode !== 0 || !done) throw new Error(`handheld-shells: Blender did not render ${id}\n${(run.stdout.toString() + run.stderr.toString()).slice(-3000)}`);
      console.log(done);
    }
  }
  mkdirSync(OUT, { recursive: true });
  const round = (n: number) => Math.round(n);
  const profiles: Record<string, unknown> = existsSync(join(OUT, "profiles.js")) ? (await import(join(OUT, "profiles.js"))).SHELLS : {};
  for (const id of ids) {
    const dir = join(RENDERS, id);
    const profile = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
    const files: Record<string, string> = {};
    for (const pass of ["base", "parts"]) {
      const png = join(dir, `${pass}.png`);
      if (!existsSync(png)) continue;
      const name = pass === "base" ? `${id}.webp` : `${id}-parts.webp`;
      const made = Bun.spawnSync(["cwebp", "-quiet", "-q", "88", "-alpha_q", "90", "-m", "6", "-sharp_yuv", png, "-o", join(OUT, name)]);
      if (made.exitCode !== 0) throw new Error(`handheld-shells: cwebp failed for ${png}: ${made.stderr.toString()}`);
      files[pass] = name;
      console.log(`${name}: ${statSync(join(OUT, name)).size} bytes`);
    }
    const system = profile.system as Record<string, number[]> | undefined;
    profiles[id] = {
      name: profile.name,
      art: files.base,
      ...(files.parts ? { partsArt: files.parts } : {}),
      width: profile.width,
      height: profile.height,
      pixelsPerMm: profile.pixelsPerMm,
      ...(files.parts ? { partsWidth: profile.partsWidth, partsHeight: profile.partsHeight } : {}),
      screens: Object.fromEntries(Object.entries(profile.screens as Record<string, number[]>).map(([name, rect]) => [name, rect.map(round)])),
      parts: (profile.parts as number[][]).map((rect) => rect.map(round)),
      controls: (profile.controls as { button: string; rect: number[]; part: number | null }[]).map((c) => ({ button: c.button, rect: c.rect.map(round), part: c.part })),
      sticks: (profile.sticks as { id: string; centre: number[]; radius: number; travel: number; part: number }[]).map((s) => ({ id: s.id, centre: s.centre.map(round), radius: round(s.radius), travel: round(s.travel), part: s.part })),
      ...(system && Object.keys(system).length ? { system: Object.fromEntries(Object.entries(system).map(([name, rect]) => [name, rect.map(round)])) } : {}),
    };
  }
  const ordered = Object.fromEntries(all.filter((id) => profiles[id]).map((id) => [id, profiles[id]]));
  const lines = Object.entries(ordered).map(([id, profile]) => `  ${JSON.stringify(id)}: ${JSON.stringify(profile)},`);
  writeFileSync(
    join(OUT, "profiles.js"),
    `// Written by tools/handheld-shells.ts from tools/handheld-models/shells.py: do not edit.\n// A shell's picture (\`art\`), the sheet of its moving parts (\`partsArt\`), and where things are in the\n// picture's pixels, as [x, y, width, height] from the top left: the screens, each control with the part that\n// moves with it, each stick with its centre, its cap's radius and how far the cap slides, and (\`system\`) the\n// keys the device keeps for itself. A part is its rectangle in the picture and then its place on the sheet:\n// [x, y, width, height, sheetX, sheetY].\nexport const SHELLS = {\n${lines.join("\n")}\n};\n`,
  );
}
