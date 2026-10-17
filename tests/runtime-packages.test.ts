import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUEST_RUNTIME_PACKAGE,
  compilerPackageDirectory,
  findPackageDirectory,
  packageVersion,
  runtimeVersionMismatch,
} from "../framework/compiler/runtime-packages.ts";

const root = realpathSync(new URL("..", import.meta.url).pathname);
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-runtime-")));
  temporary.push(path);
  return path;
}

function fakePackage(project: string, name: string, version: string): string {
  const directory = join(project, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
  return directory;
}

describe("guest runtime packages", () => {
  test("each framework names the package its application code imports", () => {
    expect(GUEST_RUNTIME_PACKAGE).toEqual({ solid: "solid-js", "vue-vapor": "vue", octane: "octane" });
  });

  test("package lookup walks node_modules upward and stops at the filesystem root", () => {
    const project = scratch();
    const installed = fakePackage(project, "solid-js", "1.0.0");
    const nested = join(project, "apps", "game", "src");
    mkdirSync(nested, { recursive: true });
    expect(findPackageDirectory("solid-js", nested)).toBe(installed);
    expect(findPackageDirectory("not-a-package-pocketjs", nested)).toBeNull();
  });

  test("the compiler bundles the copy installed beside it", () => {
    expect(compilerPackageDirectory("solid-js")).toBe(realpathSync(join(root, "node_modules/solid-js")));
  });

  test("a different application copy is a mismatch; the same version or no copy is not", () => {
    const bundled = packageVersion(compilerPackageDirectory("solid-js"));

    const differing = scratch();
    const copy = fakePackage(differing, "solid-js", "0.0.1");
    expect(runtimeVersionMismatch("solid", differing)).toEqual({
      name: "solid-js",
      application: { version: "0.0.1", directory: copy },
      bundled: { version: bundled, directory: compilerPackageDirectory("solid-js") },
    });

    const matching = scratch();
    fakePackage(matching, "solid-js", bundled);
    expect(runtimeVersionMismatch("solid", matching)).toBeNull();

    expect(runtimeVersionMismatch("solid", scratch())).toBeNull();
    expect(runtimeVersionMismatch("solid", join(root, "apps/hero"))).toBeNull();
  });

  test("pocket check stops before type checking when the application resolves another runtime", () => {
    const project = scratch();
    mkdirSync(join(project, "node_modules/@pocketjs"), { recursive: true });
    symlinkSync(root, join(project, "node_modules/@pocketjs/framework"), "dir");
    fakePackage(project, "solid-js", "0.0.1");
    writeFileSync(join(project, "main.tsx"), 'import { mount } from "@pocketjs/framework/solid";\n');
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id: "dev.example.runtime.mismatch",
      name: "runtime-mismatch",
      title: "Runtime Mismatch",
      version: "0.1.0",
      engine: { capabilities: { requires: ["text.glyphs.baked"] } },
      app: { entry: "main.tsx", output: "runtime-mismatch", framework: "solid", viewport: { logical: [480, 272], presentation: "integer-fit" } },
    }));
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(root, "tools/pocket.ts"), "check", "--target", "web-app"],
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    const bundled = packageVersion(compilerPackageDirectory("solid-js"));
    expect(result.stderr.toString()).toContain(
      `the application resolves solid-js 0.0.1 (${join(project, "node_modules/solid-js")}) and the compiler bundles solid-js ${bundled}`,
    );
    expect(result.stderr.toString()).toContain(`declare "solid-js": "${bundled}"`);
    expect(result.stdout.toString()).not.toContain("✓ TypeScript");
  });

  test("the framework pins every direct dependency whose code or output enters the guest bundle", () => {
    const dependencies: Record<string, string> = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies;
    const guest = [
      "solid-js",
      "@solid-primitives/keyed",
      "babel-preset-solid",
      "babel-plugin-jsx-dom-expressions",
      "@babel/core",
      "@babel/preset-typescript",
      "opentype.js",
      "vue",
      "vue-jsx-vapor",
      "@vue-jsx-vapor/runtime",
      "octane",
    ];
    const ranged = guest.filter((name) => !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(dependencies[name] ?? ""));
    expect(ranged).toEqual([]);
  });
});
