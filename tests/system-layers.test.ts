// tests/system-layers.test.ts — the two build inputs a product's guest code
// arrives through (tools/build.ts): a system layer named with --layer, and a
// package linked from its source tree. Pass 1 walks both, so their class
// strings compile; pass 2 imports a layer ahead of the app's entry.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const made: string[] = [];

afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-layer-")));
  made.push(directory);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  return directory;
}

function build(directory: string, ...flags: string[]): { code: number; err: string; js: string; styles: string } {
  const out = join(directory, "out");
  const run = Bun.spawnSync(
    [process.execPath, "tools/build.ts", join(directory, "main.tsx"), `--project-root=${directory}`, `--outdir=${out}`, ...flags],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const read = (suffix: string): string => {
    if (run.exitCode !== 0) return "";
    const name = readdirSync(out).find(file => file.endsWith(suffix));
    return name ? readFileSync(join(out, name), "utf8") : "";
  };
  return { code: run.exitCode, err: run.stderr.toString(), js: read(".js"), styles: read(".styles.ts") };
}

const MAIN = [
  'import { mount } from "@pocketjs/framework/solid";',
  'import { Text } from "@pocketjs/framework/components";',
  'globalThis.__order = [...(globalThis.__order ?? []), "app entry marker"];',
  'mount(() => <Text class="text-xl">app</Text>);',
  "",
].join("\n");

describe("--layer", () => {
  const LAYER = [
    'import { registerSystemLayer } from "@pocketjs/framework/system-layers";',
    'import { Text } from "@pocketjs/framework/components";',
    'globalThis.__order = [...(globalThis.__order ?? []), "layer module marker"];',
    'export const Badge = () => <Text class="rounded-[7] bg-[#123456]">layer</Text>;',
    "registerSystemLayer(() => null);",
    "",
  ].join("\n");
  const directory = project({ "main.tsx": MAIN, "layers/badge.tsx": LAYER });

  test("without the flag the module is not in the bundle", () => {
    const result = build(directory);
    expect(result.code).toBe(0);
    expect(result.js).not.toContain("layer module marker");
    expect(result.styles).not.toContain("rounded-[7] bg-[#123456]");
  });

  test("pass 1 compiles the layer's classes and pass 2 imports it ahead of the entry", () => {
    const result = build(directory, `--layer=${join(directory, "layers/badge.tsx")}`);
    expect(result.err).not.toContain("error");
    expect(result.code).toBe(0);
    expect(result.styles).toContain("rounded-[7] bg-[#123456]");
    expect(result.styles).toContain("text-xl");
    const layer = result.js.indexOf("layer module marker");
    const entry = result.js.indexOf("app entry marker");
    expect(layer).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(layer);
  });

  test("a layer that is not a file fails the build", () => {
    const result = build(directory, `--layer=${join(directory, "layers/absent.tsx")}`);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("--layer names");
  });
});

describe("a package linked from its source tree", () => {
  const KIT = {
    "package.json": JSON.stringify({ name: "@fixture/kit", type: "module", exports: { "./badge": "./badge.tsx" } }),
    "badge.tsx": [
      'import { Text } from "@pocketjs/framework/components";',
      'export const Badge = () => <Text class="rounded-[9] bg-[#654321]">kit</Text>;',
      "",
    ].join("\n"),
  };
  const APP = [
    'import { mount } from "@pocketjs/framework/solid";',
    'import { Badge } from "@fixture/kit/badge";',
    "mount(() => <Badge />);",
    "",
  ].join("\n");

  test("pass 1 walks it through the link and compiles its classes", () => {
    const directory = project({ "main.tsx": APP, ...Object.fromEntries(Object.entries(KIT).map(([name, text]) => [`kit/${name}`, text])) });
    mkdirSync(join(directory, "node_modules/@fixture"), { recursive: true });
    symlinkSync(join(directory, "kit"), join(directory, "node_modules/@fixture/kit"), "dir");
    const result = build(directory);
    expect(result.err).not.toContain("error");
    expect(result.code).toBe(0);
    expect(result.styles).toContain("rounded-[9] bg-[#654321]");
  });

  test("a package installed under node_modules stays outside pass 1", () => {
    // An installed package ships built JavaScript; its strings are not class
    // candidates, so a class it names is compiled only where the app spells it.
    const directory = project({
      "main.tsx": [
        'import { mount } from "@pocketjs/framework/solid";',
        'import { Text } from "@pocketjs/framework/components";',
        'import { kitClass } from "@fixture/kit/badge";',
        "mount(() => <Text class={kitClass}>kit</Text>);",
        "",
      ].join("\n"),
      "node_modules/@fixture/kit/package.json": JSON.stringify({ name: "@fixture/kit", type: "module", exports: { "./badge": "./badge.js" } }),
      "node_modules/@fixture/kit/badge.js": 'export const kitClass = "rounded-[9] bg-[#654321]";\n',
    });
    const result = build(directory);
    expect(result.code).toBe(0);
    expect(result.js).toContain("rounded-[9] bg-[#654321]");
    expect(result.styles).not.toContain("rounded-[9] bg-[#654321]");
  });
});
