import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FRAMEWORKS,
  RENDERER_OCTANE_PATH,
  RENDERER_PATH,
  RENDERER_SOLID_PATH,
  RENDERER_VUE_VAPOR_PATH,
  frameworkVariantPath,
  jsxPlugin,
  packagePath,
  transformFile,
} from "../framework/compiler/jsx-plugin.ts";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function expectNativeFile(path: string): void {
  if (process.platform === "win32") {
    expect(path).toMatch(/^(?:[A-Za-z]:\\|\\\\)/);
    expect(path).not.toMatch(/^\/[A-Za-z]:\//);
  } else {
    expect(path.startsWith("/")).toBe(true);
  }
  expect(existsSync(path), path).toBe(true);
}

describe("compiler filesystem portability", () => {
  test("compiler-owned renderer and package paths are native files", () => {
    for (const path of [
      RENDERER_PATH,
      RENDERER_SOLID_PATH,
      RENDERER_VUE_VAPOR_PATH,
      RENDERER_OCTANE_PATH,
    ]) {
      expectNativeFile(path);
    }

    for (const framework of ["solid", "vue-vapor", "octane"] as const) {
      expectNativeFile(FRAMEWORKS[framework].rootPath);
      expectNativeFile(FRAMEWORKS[framework].rendererPath);
      const components = packagePath("@pocketjs/framework/components", framework);
      expect(components).not.toBeNull();
      expectNativeFile(components!);
    }
  });

  test("the transform cache accepts compiler output on the native filesystem", async () => {
    const source = "export const view = <View>Cache probe</View>;";
    const first = await transformFile("/virtual/compiler-cache-probe.tsx", source, "solid");
    const second = await transformFile("/virtual/compiler-cache-probe.tsx", source, "solid");

    expect(second.code).toBe(first.code);
    expect(second.classStrings).toEqual(first.classStrings);
    expect(second.textCodepoints).toEqual(first.textCodepoints);
  });

  test.each([
    ["solid", 'import { createSignal } from "solid-js"; export const value = createSignal(1);'],
    ["vue-vapor", 'import { ref } from "vue"; export const value = ref(1);'],
  ] as const)("%s runtime alias resolves to a bundleable native file", async (framework, source) => {
    const directory = await temporaryDirectory(`pocketjs-${framework}-runtime-`);
    const entry = join(directory, "entry.js");
    await Bun.write(entry, source);

    const result = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      target: "browser",
      conditions: ["browser"],
      define: {
        "process.env.NODE_ENV": '"production"',
        document: "globalThis.__pocketDocument",
        __POCKET_TARGET__: '""',
        __POCKET_HOST_ABI__: String(POCKET_BINDING_GENERATION),
        __POCKET_FEATURES__: "{}",
        __POCKET_PIXEL_RATIO__: "1",
      },
      plugins: [jsxPlugin(framework, { entry })],
    });

    expect(result.success).toBe(true);
    expect((await result.outputs[0]!.text()).length).toBeGreaterThan(0);
  });

  test("LF and CRLF JSXText produce equivalent compiler output", async () => {
    const lf = "export const view = <View>\n  Hello\n</View>;\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const fromLf = await transformFile("/virtual/line-endings.tsx", lf, "solid");
    const fromCrlf = await transformFile("/virtual/line-endings.tsx", crlf, "solid");

    expect(fromCrlf.code).toBe(fromLf.code);
    expect(fromCrlf.classStrings).toEqual(fromLf.classStrings);
    expect(fromCrlf.textCodepoints).toEqual(fromLf.textCodepoints);
  });

  test.each([
    ["named", "&eacute;"],
    ["numeric LF", "&#10;"],
    ["numeric CR", "&#13;"],
  ])("rejects %s entities in JSXText", async (name, entity) => {
    await expect(
      transformFile(`/virtual/entity-${name}.tsx`, `<View>${entity}</View>`, "solid"),
    ).rejects.toThrow("HTML entities in JSX text are not decoded");
  });

  test("native node_modules separators do not select framework variants", async () => {
    const directory = await temporaryDirectory("pocketjs-node-modules-path-");
    const moduleDirectory = process.platform === "win32"
      ? join(directory, "node_modules", "fixture")
      : directory;
    await mkdir(moduleDirectory, { recursive: true });
    const source = process.platform === "win32"
      ? join(moduleDirectory, "entry.ts")
      : join(moduleDirectory, String.raw`C:\repo\node_modules\fixture\entry.ts`);
    const variant = source.replace(/\.ts$/, ".octane.ts");
    await Bun.write(source, "export const selected = 'package';\n");
    await Bun.write(variant, "export const selected = 'variant';\n");

    expect(frameworkVariantPath(source, "octane")).toBe(source);
  });
});
