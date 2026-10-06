// tools/pocket3d-shells.ts: the handhelds' shells a Pocket3D game's page shows
// its screens in (devices/web/pocket-web-wgpu/web/shells).
//
//   bun tools/pocket3d-shells.ts [psp|vita|3ds|ipod|android …] [--samples 128] [--no-render]
//
// For each device, Blender renders its front in two passes
// (tools/handheld-models/shells.py → dist/handheld-shells/<id>/): the case with
// its moving parts taken out, and each of those parts alone, on one sheet.
// This tool encodes both as WebP with alpha and writes every device's profile
// into one module, `profiles.js`: the picture's size, the screens'
// rectangles, each part's rectangle in the picture and its place on the
// sheet, each control's rectangle and the part that moves with it, each
// stick's centre and travel.
//
// It needs Blender (BLENDER, or /Applications/Blender.app) and `cwebp` on the
// path. The renders stay under the ignored dist/; the encoded shells are
// product assets and are committed. Cycles' noise differs between two runs, so
// a rerun changes the files' bytes: run it when a shell changes.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RENDERS = join(ROOT, "dist/handheld-shells");
const OUT = join(ROOT, "devices/web/pocket-web-wgpu/web/shells");
export const SHELL_IDS = ["psp", "vita", "3ds", "ipod", "android"] as const;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const samples = args.includes("--samples") ? args[args.indexOf("--samples") + 1]! : "128";
  const wanted = args.filter((a) => (SHELL_IDS as readonly string[]).includes(a));
  const ids = wanted.length ? wanted : [...SHELL_IDS];
  if (!args.includes("--no-render")) {
    const blender = process.env.BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
    if (!existsSync(blender)) throw new Error(`pocket3d-shells: no Blender at ${blender} (set BLENDER)`);
    for (const id of ids) {
      const run = Bun.spawnSync([blender, "--background", "--python", join(ROOT, "tools/handheld-models/shells.py"), "--", id, "--samples", samples], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      // (Blender exits with 0 when its script has raised: the script's last line says it reached the end)
      const done = run.stdout.toString().split("\n").find((line) => /^shells: \S+ \d+ x \d+ \d+ parts$/.test(line));
      if (run.exitCode !== 0 || !done) throw new Error(`pocket3d-shells: Blender did not render ${id}\n${(run.stdout.toString() + run.stderr.toString()).slice(-3000)}`);
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
      if (made.exitCode !== 0) throw new Error(`pocket3d-shells: cwebp failed for ${png}: ${made.stderr.toString()}`);
      files[pass] = name;
      console.log(`${name}: ${statSync(join(OUT, name)).size} bytes`);
    }
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
    };
  }
  const ordered = Object.fromEntries(SHELL_IDS.filter((id) => profiles[id]).map((id) => [id, profiles[id]]));
  const lines = Object.entries(ordered).map(([id, profile]) => `  ${JSON.stringify(id)}: ${JSON.stringify(profile)},`);
  writeFileSync(
    join(OUT, "profiles.js"),
    `// Written by tools/pocket3d-shells.ts from tools/handheld-models/shells.py: do not edit.\n// A shell's picture (\`art\`), the sheet of its moving parts (\`partsArt\`), and where things are in the\n// picture's pixels, as [x, y, width, height] from the top left: the screens, each control with the part that\n// moves with it, each stick with its centre, its cap's radius and how far the cap slides. A part is its\n// rectangle in the picture and then its place on the sheet: [x, y, width, height, sheetX, sheetY].\nexport const SHELLS = {\n${lines.join("\n")}\n};\n`,
  );
}
