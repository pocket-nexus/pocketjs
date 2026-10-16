import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  hashPocketIdfHostProfile,
  pocketIdfHostExtension,
  pocketIdfHostRegistry,
  validatePocketIdfHostProfile,
} from "../framework/src/manifest/idf-host.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { FRAMEWORK_DEPENDENCIES } from "../tools/cli/create.mjs";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "tools/cli/bin.mjs");
const cliVersion = JSON.parse(readFileSync(join(root, "tools/cli/package.json"), "utf8")).version as string;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function checkout(): string {
  const path = `/tmp/pocketjs-cli-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@pocketjs/framework" }));
  temporary.push(path);
  return path;
}

/** A directory no PocketJS checkout owns: `pocket create` writes a standalone project here. */
function scratch(): string {
  const path = `/tmp/pocketjs-cli-standalone-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  temporary.push(path);
  return path;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Resolve a manifest against an ESP-IDF host profile the way tools/pocket.ts does. */
function resolveAgainstProfile(manifest: unknown, profile: unknown) {
  const validated = validatePocketIdfHostProfile(profile);
  expect(validated.ok, JSON.stringify(validated)).toBe(true);
  if (!validated.ok) throw new Error("unreachable");
  const host = validated.value;
  return validateAndResolveBuildPlan(
    manifest,
    { target: host.id, hostExtension: pocketIdfHostExtension(hashPocketIdfHostProfile(host), host.tickHz) },
    pocketIdfHostRegistry(host),
  );
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("published PocketJS CLI", () => {
  test("create emits one portable pocket.json v2 source of truth", async () => {
    const cwd = checkout();
    const result = runCli(cwd, ["create", "portable-counter"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const app = join(cwd, "apps/portable-counter");
    const manifest = JSON.parse(readFileSync(join(app, "pocket.json"), "utf8"));
    expect(manifest).toMatchObject({
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id: "dev.example.portable.counter",
      name: "portable-counter",
      version: "0.1.0",
      app: {
        entry: "main.tsx",
        output: "portable-counter-main",
        framework: "solid",
        viewport: { logical: [480, 272], presentation: "integer-fit" },
      },
    });
    expect(existsSync(join(app, "pocket.config.ts"))).toBe(false);
    expect(readFileSync(join(app, "main.tsx"), "utf8"))
      .toContain('from "@pocketjs/framework/solid"');

    for (const target of ["psp", "vita"] as const) {
      const resolution = validateAndResolveBuildPlan(manifest, { target });
      expect(resolution.ok, target).toBe(true);
    }
  });

  test("target commands delegate to canonical checkout scripts", () => {
    const cwd = checkout();
    const scripts = join(cwd, "tools");
    const log = join(cwd, "cli-log.json");
    mkdirSync(scripts);
    const recorder = `await Bun.write(process.env.POCKET_CLI_TEST_LOG, JSON.stringify({
  script: import.meta.url,
  args: Bun.argv.slice(2),
}));\n`;
    for (const name of ["pocket", "play", "symbian", "vita", "ios"]) {
      writeFileSync(join(scripts, `${name}.ts`), recorder);
    }

    const cases = [
      { cliArgs: ["check", "--target", "psp"], script: "pocket.ts", args: ["check", "--target", "psp"] },
      { cliArgs: ["compile", "--target", "vita"], script: "pocket.ts", args: ["compile", "--target", "vita"] },
      { cliArgs: ["build", "--target", "vita", "--", "--release"], script: "pocket.ts", args: ["build", "--target", "vita", "--", "--release"] },
      { cliArgs: ["play", "vita", "hero"], script: "play.ts", args: ["vita", "hero"] },
      { cliArgs: ["vita", "hero", "--release"], script: "vita.ts", args: ["hero", "--release"] },
      { cliArgs: ["symbian", "doctor", "--device"], script: "symbian.ts", args: ["doctor", "--device"] },
      { cliArgs: ["symbian", "coda", "usb"], script: "symbian.ts", args: ["coda", "usb"] },
      { cliArgs: ["symbian", "coda", "usb", "launch"], script: "symbian.ts", args: ["coda", "usb", "launch"] },
      { cliArgs: ["ios", "play", "nsengine"], script: "ios.ts", args: ["play", "nsengine"] },
      { cliArgs: ["play", "ios", "nsengine"], script: "play.ts", args: ["ios", "nsengine"] },
    ];

    for (const fixture of cases) {
      rmSync(log, { force: true });
      const result = runCli(cwd, fixture.cliArgs, { POCKET_CLI_TEST_LOG: log });
      expect(result.exitCode, `${fixture.cliArgs.join(" ")}\n${result.stderr}`).toBe(0);
      const recorded = JSON.parse(readFileSync(log, "utf8"));
      expect(basename(new URL(recorded.script).pathname)).toBe(fixture.script);
      expect(recorded.args).toEqual(fixture.args);
    }
  });

  test("manifest commands resolve a project-local published framework", () => {
    const cwd = `/tmp/pocketjs-cli-external-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const framework = join(cwd, "node_modules/@pocketjs/framework");
    const log = join(cwd, "cli-log.json");
    mkdirSync(join(framework, "tools"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "external-pocket-app" }));
    writeFileSync(join(framework, "package.json"), JSON.stringify({ name: "@pocketjs/framework" }));
    writeFileSync(join(framework, "tools/pocket.ts"), `await Bun.write(process.env.POCKET_CLI_TEST_LOG, JSON.stringify({
  args: Bun.argv.slice(2),
  cwd: process.cwd(),
}));\n`);
    temporary.push(cwd);

    const result = runCli(cwd, [
      "build",
      "--host-profile",
      "firmware/pocket.host.json",
      "--manifest",
      "app/pocket.json",
    ], { POCKET_CLI_TEST_LOG: log });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual({
      args: [
        "build",
        "--host-profile",
        "firmware/pocket.host.json",
        "--manifest",
        "app/pocket.json",
      ],
      cwd: realpathSync(cwd),
    });
  });

  test("runs on Bun and says so under Node", () => {
    const node = Bun.which("node");
    if (!node) return;
    const result = Bun.spawnSync({ cmd: [node, cli, "doctor"], stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("runs on Bun");
    expect(readJson(join(root, "tools/cli/package.json")).engines).toEqual({ bun: ">=1.2" });
  });

  test("standalone create writes a project that depends on the published framework", () => {
    const cwd = scratch();
    const result = runCli(cwd, ["create", "counter", "--target", "vita", "--framework", "vue-vapor"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("bun install");

    const app = join(cwd, "counter");
    for (const file of ["package.json", "tsconfig.json", "pocket.json", "main.tsx", "app.tsx", "README.md", ".gitignore"]) {
      expect(existsSync(join(app, file)), file).toBe(true);
    }
    expect(existsSync(join(app, "pocket.host.json"))).toBe(false);

    const pkg = readJson(join(app, "package.json"));
    expect(pkg.dependencies).toEqual({ "@pocketjs/framework": `^${cliVersion}`, vue: FRAMEWORK_DEPENDENCIES["vue-vapor"].vue });
    expect(pkg.devDependencies).toEqual({ "@pocketjs/cli": `^${cliVersion}` });
    expect(pkg.scripts).toEqual({
      check: "pocket check --target vita",
      compile: "pocket compile --target vita",
      build: "pocket build --target vita -- --release",
    });
    expect(readFileSync(join(app, "main.tsx"), "utf8")).toContain('from "@pocketjs/framework/vue-vapor"');
    expect(readFileSync(join(app, "app.tsx"), "utf8")).toContain('from "@pocketjs/framework/vue-vapor/lifecycle"');
    expect(readJson(join(app, "tsconfig.json")).include).toEqual([
      "*.ts",
      "*.tsx",
      "node_modules/@pocketjs/framework/framework/src/jsx.d.ts",
      "node_modules/@pocketjs/framework/framework/src/vue-sfc.d.ts",
    ]);

    const manifest = readJson(join(app, "pocket.json"));
    expect(manifest.app.framework).toBe("vue-vapor");
    expect(validateAndResolveBuildPlan(manifest, { target: "vita" }).ok).toBe(true);
  });

  test("standalone dependency pins match the framework package.json", () => {
    const framework = readJson(join(root, "package.json")).dependencies as Record<string, string>;
    for (const dependencies of Object.values(FRAMEWORK_DEPENDENCIES)) {
      for (const [name, version] of Object.entries(dependencies)) {
        expect(framework[name], name).toBe(version);
      }
    }
  });

  test("create --host-profile derives the manifest from the ESP-IDF host contract", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, "firmware"));
    const profile = readJson(join(root, "hosts/esp-idf/examples/smoke/pocket.host.json"));
    writeFileSync(join(cwd, "firmware/pocket.host.json"), JSON.stringify(profile));

    const result = runCli(cwd, ["create", "app", "--host-profile", "firmware/pocket.host.json"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const app = join(cwd, "app");
    const manifest = readJson(join(app, "pocket.json"));
    expect(manifest.app.viewport).toEqual({ logical: [320, 240], presentation: "native" });
    expect(manifest.engine.capabilities.requires).toEqual(["text.glyphs.baked", "input.buttons"]);
    expect(resolveAgainstProfile(manifest, profile).ok).toBe(true);
    expect(readFileSync(join(app, "app.tsx"), "utf8")).toContain("onButtonPress(BTN.CROSS");

    const pkg = readJson(join(app, "package.json"));
    expect(pkg.scripts.check).toBe("pocket check --host-profile ../firmware/pocket.host.json");
    expect(pkg.scripts.build).toBe("pocket build --host-profile ../firmware/pocket.host.json --output dist/app.pocket");
    const readme = readFileSync(join(app, "README.md"), "utf8");
    expect(readme).toContain("pocketjs_compile_app(");
    expect(readme).toContain("pocketjs_embed_package(");
    expect(readme).toContain('HOST_PROFILE "${CMAKE_SOURCE_DIR}/firmware/pocket.host.json"');
    expect(readme).toContain('PACKAGE "${CMAKE_SOURCE_DIR}/app/dist/app.pocket"');

    // A touch-only panel: no button handler, the host's own viewport and presentation.
    const touch = {
      ...profile,
      id: "touch-panel",
      display: { ...profile.display, physicalViewport: [240, 320], logicalViewports: [[240, 320]], presentations: ["fit"] },
      capabilities: ["input.touch", "text.glyphs.baked"],
    };
    writeFileSync(join(cwd, "firmware/touch.host.json"), JSON.stringify(touch));
    const touchResult = runCli(cwd, ["create", "touch-app", "--host-profile", "firmware/touch.host.json", "--framework", "octane"]);
    expect(touchResult.exitCode, touchResult.stderr.toString()).toBe(0);
    const touchManifest = readJson(join(cwd, "touch-app/pocket.json"));
    expect(touchManifest.app.viewport).toEqual({ logical: [240, 320], presentation: "fit" });
    expect(touchManifest.engine.capabilities.requires).toEqual(["text.glyphs.baked"]);
    expect(resolveAgainstProfile(touchManifest, touch).ok).toBe(true);
    expect(readFileSync(join(cwd, "touch-app/app.tsx"), "utf8")).not.toContain("useButtonPress");
  });

  test("create --target esp-idf writes a starting host profile the manifest resolves against", () => {
    const cwd = scratch();
    const result = runCli(cwd, ["create", "a-very-long-product-name", "--target", "esp-idf"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const app = join(cwd, "a-very-long-product-name");
    const profile = readJson(join(app, "pocket.host.json"));
    expect(profile.id).toBe("a-very-long-pro");
    const manifest = readJson(join(app, "pocket.json"));
    expect(manifest.app.viewport).toEqual({ logical: [320, 240], presentation: "native" });
    expect(resolveAgainstProfile(manifest, profile).ok).toBe(true);
    expect(readJson(join(app, "package.json")).scripts.check).toBe("pocket check --host-profile pocket.host.json");
  });

  test("create rejects a target that needs a dynamic viewport and a mixed selector", () => {
    const cwd = scratch();
    for (const args of [
      ["create", "Widget"],
      ["create", "widget", "--target", "macos-widget"],
      ["create", "widget", "--target", "psp", "--host-profile", "pocket.host.json"],
      ["create", "widget", "--framework", "react"],
    ]) {
      const result = runCli(cwd, args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stderr.toString()).toContain("usage: pocket create");
    }
    expect(existsSync(join(cwd, "widget"))).toBe(false);
  });

  test("scaffolded projects pass `pocket check` against a linked framework", () => {
    const cwd = scratch();
    mkdirSync(join(cwd, "node_modules/@pocketjs"), { recursive: true });
    symlinkSync(root, join(cwd, "node_modules/@pocketjs/framework"), "dir");
    for (const dependency of ["solid-js", "vue", "octane"]) {
      symlinkSync(join(root, "node_modules", dependency), join(cwd, "node_modules", dependency), "dir");
    }
    mkdirSync(join(cwd, "firmware"));
    cpSync(join(root, "hosts/esp-idf/examples/smoke/pocket.host.json"), join(cwd, "firmware/pocket.host.json"));

    const projects = [
      ["solid-psp", "--target", "psp"],
      ["vue-vita", "--target", "vita", "--framework", "vue-vapor"],
      ["octane-web", "--target", "web-app", "--framework", "octane"],
      ["idf-app", "--host-profile", "firmware/pocket.host.json"],
    ];
    for (const [name, ...flags] of projects) {
      const created = runCli(cwd, ["create", name, ...flags]);
      expect(created.exitCode, created.stderr.toString()).toBe(0);
      const app = join(cwd, name);
      const check = (readJson(join(app, "package.json")).scripts.check as string).split(" ").slice(1);
      const result = runCli(app, check);
      expect(result.exitCode, `${name}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.toString()).toContain("✓ TypeScript");
    }
  }, 180_000);
});
