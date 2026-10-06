// tests/class-diagnostics.test.ts — a class literal that does not compile is
// reported by the build with its file, line and the unsupported utility
// (tools/build.ts, framework/compiler/jsx-plugin.ts `literalSites`).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformFile } from "../framework/compiler/jsx-plugin.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const made: string[] = [];

afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-class-")));
  made.push(directory);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return directory;
}

function build(directory: string, ...flags: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync(
    [process.execPath, "tools/build.ts", join(directory, "main.tsx"), "--no-config", `--project-root=${directory}`, `--outdir=${join(directory, "out")}`, ...flags],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const MAIN = (view: string): string =>
  [
    'import { mount } from "@pocketjs/framework/solid";',
    'import { Text, View } from "@pocketjs/framework/components";',
    'import { title } from "./layout.ts";',
    "const big = () => true;",
    `mount(() => (${view}));`,
    "",
  ].join("\n");

describe("class literals the compiler leaves out", () => {
  const broken = project({
    "main.tsx": MAIN(
      [
        "",
        '  <View class="flex-col items-centre gap-2">',
        '    <Text class={big() ? "text-2xl font-bold" : "text-smal font-bold"}>one</Text>',
        '    <Text class={title}>two</Text>',
        '    <Text class="hiden">three</Text>',
        "  </View>",
        "",
      ].join("\n"),
    ),
    "layout.ts": 'export const title = "text-xl font-bold txt-center";\nexport const label = "Tap to start";\n',
  });

  test("the collector says where each literal is and whether a class attribute holds it", async () => {
    const source = await Bun.file(join(broken, "main.tsx")).text();
    const { literalSites } = await transformFile(join(broken, "main.tsx"), source, "solid");
    const inClass = literalSites.filter((site) => site.inClass).map((site) => `${site.line}:${site.column} ${site.literal}`);
    expect(inClass).toEqual([
      "6:15 flex-col items-centre gap-2",
      "7:26 text-2xl font-bold",
      "7:49 text-smal font-bold",
      "9:17 hiden",
    ]);
  });

  test("a build prints each one as a warning and still succeeds", () => {
    const result = build(broken);
    expect(result.code).toBe(0);
    const warnings = result.err.split("\n").filter((line) => line.includes("warning:")).map((line) => line.trim());
    expect(warnings).toEqual([
      'warning: layout.ts:1:22: "text-xl font-bold txt-center" reads as a class string and does not compile: unknown utility txt-center',
      'warning: main.tsx:6:15: class "flex-col items-centre gap-2" does not compile: unknown utility items-centre',
      'warning: main.tsx:7:49: class "text-smal font-bold" does not compile: unknown utility text-smal',
      'warning: main.tsx:9:17: class "hiden" does not compile: unknown utility hiden',
    ]);
    expect(existsSync(join(broken, "out/main.js"))).toBe(true);
  }, 60000);

  test("--strict-classes fails on the ones in a class attribute and writes no bundle", () => {
    rmSync(join(broken, "out"), { recursive: true, force: true });
    const result = build(broken, "--strict-classes");
    expect(result.code).toBe(1);
    const errors = result.err.split("\n").filter((line) => line.startsWith("error: "));
    expect(errors).toEqual([
      'error: main.tsx:6:15: class "flex-col items-centre gap-2" does not compile: unknown utility items-centre',
      'error: main.tsx:7:49: class "text-smal font-bold" does not compile: unknown utility text-smal',
      'error: main.tsx:9:17: class "hiden" does not compile: unknown utility hiden',
    ]);
    // The literal in a constant is a warning in either mode: where it is used is not known.
    expect(result.err).toContain('warning: layout.ts:1:22: "text-xl font-bold txt-center" reads as a class string');
    expect(existsSync(join(broken, "out/main.js"))).toBe(false);
  }, 60000);

  test("a project whose class literals all compile builds the same under --strict-classes", () => {
    const sound = project({
      "main.tsx": MAIN('<View class="flex-col items-center gap-2"><Text class={big() ? "text-2xl font-bold" : "text-sm font-bold"}>{title}</Text></View>'),
      "layout.ts": 'export const title = "Tap to start";\n',
    });
    const result = build(sound, "--strict-classes");
    expect(result.err).not.toContain("warning:");
    expect(result.code).toBe(0);
    expect(existsSync(join(sound, "out/main.js"))).toBe(true);
  }, 60000);
});
