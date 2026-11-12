// tests/build-font-flags.test.ts — `tools/build.ts --font-mono=` bakes the `font-mono` slots from the given face, as
// `--font-regular=` / `--font-bold=` do for theirs; the other slots are untouched.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FONTS = join(ROOT, "assets/fonts");
const made: string[] = [];
afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

const directory = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-font-flags-")));
made.push(directory);
writeFileSync(
  join(directory, "main.tsx"),
  [
    'import { mount } from "@pocketjs/framework/solid";',
    'import { Text, View } from "@pocketjs/framework/components";',
    'mount(() => (<View class="flex-col"><Text class="text-sm">Proportional</Text><Text class="text-sm font-mono">mono 0123</Text></View>));',
    "",
  ].join("\n"),
);

/** Builds the app into its own directory and returns the log and the pak. */
function build(name: string, ...flags: string[]): { log: string; pak: Buffer } {
  const outdir = join(directory, name);
  const run = Bun.spawnSync([process.execPath, "tools/build.ts", join(directory, "main.tsx"), `--project-root=${directory}`, `--outdir=${outdir}`, ...flags], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const log = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode, log).toBe(0);
  return { log, pak: readFileSync(join(outdir, "main.pak")) };
}

/** The `font: slot …` lines of a build log, by slot. */
function slots(log: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of log.matchAll(/font: slot (\d+) \(([^)]*)\) (\d+) glyphs, cell (\S+), coverage (\S+) @\S+, (\d+) bytes/g)) out.set(Number(m[1]), m.slice(2).join(" "));
  return out;
}

test("--font-mono replaces the face of the mono slots only", () => {
  const plain = build("plain");
  const same = build("same", `--font-mono=${join(FONTS, "JetBrainsMono-Regular.ttf")}`);
  const other = build("other", `--font-mono=${join(FONTS, "Inter-Regular.ttf")}`);
  // The default face named explicitly bakes the same atlases.
  expect(Buffer.compare(same.pak, plain.pak)).toBe(0);
  // Another face changes the mono slot (16 + size index; 14 px is index 1) and nothing else.
  const a = slots(plain.log), b = slots(other.log);
  const mono = [...a.keys()].filter((s) => s >= 16 && s < 19);
  const proportional = [...a.keys()].filter((s) => s < 16);
  expect(mono.length).toBe(1);
  expect(proportional.length).toBeGreaterThan(0);
  for (const s of mono) expect(b.get(s)).not.toBe(a.get(s));
  for (const s of proportional) expect(b.get(s)).toBe(a.get(s));
});
