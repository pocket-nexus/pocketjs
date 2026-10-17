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
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "@pocketjs/framework", pocketjs: { protocol: 1 } }));
  temporary.push(path);
  return path;
}

// Every CLI run gets its own settings directory and no POCKET_TARGET, so the
// machine's settings never reach a test.
const settingsHome = `/tmp/pocketjs-cli-settings-${process.pid}`;
mkdirSync(settingsHome, { recursive: true });
temporary.push(settingsHome);

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
    env: { ...process.env, XDG_CONFIG_HOME: settingsHome, POCKET_TARGET: "", ...env },
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
    expect(readFileSync(join(app, "pocket.config.ts"), "utf8")).toContain('targets: ["psp"]');
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
    const recorder = `if (Bun.argv[2] === "project") {
  console.log(JSON.stringify({ ok: true, project: { config: null, targets: [] } }));
  process.exit(0);
}
await Bun.write(process.env.POCKET_CLI_TEST_LOG, JSON.stringify({
  script: import.meta.url,
  args: Bun.argv.slice(2),
}));\n`;
    for (const name of ["pocket", "play", "symbian", "vita", "ios"]) {
      writeFileSync(join(scripts, `${name}.ts`), recorder);
    }

    const cases = [
      { cliArgs: ["check", "--target", "psp"], script: "pocket.ts", args: ["check", "--target", "psp", "--cli-protocol", "1"] },
      { cliArgs: ["compile", "--target", "vita"], script: "pocket.ts", args: ["compile", "--target", "vita", "--cli-protocol", "1"] },
      { cliArgs: ["build", "--target", "vita", "--", "--release"], script: "pocket.ts", args: ["build", "--target", "vita", "--cli-protocol", "1", "--", "--release"] },
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
    writeFileSync(join(framework, "package.json"), JSON.stringify({ name: "@pocketjs/framework", pocketjs: { protocol: 1 } }));
    writeFileSync(join(framework, "tools/pocket.ts"), `if (Bun.argv[2] === "project") {
  console.log(JSON.stringify({ ok: true, project: { config: null, targets: [] } }));
  process.exit(0);
}
await Bun.write(process.env.POCKET_CLI_TEST_LOG, JSON.stringify({
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
        "--cli-protocol",
        "1",
        "--manifest",
        "app/pocket.json",
      ],
      cwd: realpathSync(cwd),
    });
  });

  test("runs on Bun and says so under Node", () => {
    const node = Bun.which("node");
    if (!node) return;
    const result = Bun.spawnSync({ cmd: [node, cli, "show"], stdout: "pipe", stderr: "pipe" });
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
    for (const file of ["package.json", "tsconfig.json", "pocket.json", "pocket.config.ts", "main.tsx", "app.tsx", "README.md", ".gitignore"]) {
      expect(existsSync(join(app, file)), file).toBe(true);
    }
    expect(existsSync(join(app, "pocket.host.json"))).toBe(false);

    const pkg = readJson(join(app, "package.json"));
    expect(pkg.dependencies).toEqual({ "@pocketjs/framework": `^${cliVersion}`, vue: FRAMEWORK_DEPENDENCIES["vue-vapor"].vue });
    expect(pkg.devDependencies).toEqual({ "@pocketjs/cli": `^${cliVersion}` });
    expect(pkg.scripts).toEqual({
      check: "pocket check",
      compile: "pocket compile",
      build: "pocket build -- --release",
    });
    expect(readFileSync(join(app, "pocket.config.ts"), "utf8")).toContain('targets: ["vita"]');
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
    expect(pkg.scripts.check).toBe("pocket check");
    expect(pkg.scripts.build).toBe("pocket build --output dist/app.pocket");
    expect(readFileSync(join(app, "pocket.config.ts"), "utf8")).toContain('targets: [{ hostProfile: "../firmware/pocket.host.json" }]');
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
    expect(readJson(join(app, "package.json")).scripts.check).toBe("pocket check");
    expect(readFileSync(join(app, "pocket.config.ts"), "utf8")).toContain('targets: [{ hostProfile: "pocket.host.json" }]');
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

describe("target selection", () => {
  const catalog = [
    { id: "psp", title: "PlayStation Portable", contract: { kind: "registry", target: "psp" }, hosts: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] },
    { id: "vita", title: "PlayStation Vita", contract: { kind: "registry", target: "vita" }, hosts: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] },
    { id: "web-app", title: "Browser", contract: { kind: "registry", target: "web-app" }, hosts: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] },
    { id: "moto-g-play", title: "Moto G Play", contract: { kind: "profile", target: "moto-g-play-dev" }, hosts: ["darwin-arm64", "darwin-x64", "linux-x64"] },
  ];

  const status = [
    { id: "psp", title: "PlayStation Portable", hosts: catalog[0]!.hosts, state: "not installed", digest: "3f9a12c0".padEnd(64, "0"), detail: "pocket target add psp" },
    { id: "vita", title: "PlayStation Vita", hosts: catalog[1]!.hosts, state: "no manifest", detail: "its build script finds its own tools" },
    { id: "web-app", title: "Browser", hosts: catalog[2]!.hosts, state: "nothing to install", detail: "the compiler builds it" },
    { id: "moto-g-play", title: "Moto G Play", hosts: catalog[3]!.hosts, state: "no manifest", detail: "its build script finds its own tools" },
  ];

  /** A framework whose tools/pocket.ts answers `project`, `catalog` and
   *  `status` from the environment and appends every other invocation to a log. */
  function fakeFramework(protocol = 1) {
    const cwd = checkout();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "@pocketjs/framework", version: "9.9.9", pocketjs: { protocol } }));
    mkdirSync(join(cwd, "tools"));
    writeFileSync(join(cwd, "tools/pocket.ts"), `const command = Bun.argv[2];
if (command === "project") { console.log(process.env.FAKE_PROJECT); process.exit(0); }
if (command === "catalog") { console.log(process.env.FAKE_CATALOG); process.exit(0); }
if (command === "status") { console.log(process.env.FAKE_STATUS); process.exit(0); }
const log = process.env.POCKET_CLI_TEST_LOG;
const previous = (await Bun.file(log).exists()) ? await Bun.file(log).json() : [];
await Bun.write(log, JSON.stringify([...previous, Bun.argv.slice(2)]));\n`);
    const settings = join(cwd, "settings");
    mkdirSync(settings);
    return { cwd, log: join(cwd, "log.json"), settings };
  }

  function pocket(
    framework: ReturnType<typeof fakeFramework>,
    args: string[],
    project: { config: string | null; targets: unknown[] } = { config: null, targets: [] },
    env: Record<string, string> = {},
  ) {
    rmSync(framework.log, { force: true });
    const result = runCli(framework.cwd, args, {
      POCKET_CLI_TEST_LOG: framework.log,
      XDG_CONFIG_HOME: framework.settings,
      FAKE_PROJECT: JSON.stringify({ ok: true, project }),
      FAKE_CATALOG: JSON.stringify(catalog),
      FAKE_STATUS: JSON.stringify(status),
      ...env,
    });
    const calls: string[][] = existsSync(framework.log) ? readJson(framework.log) : [];
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), calls };
  }

  const project = (targets: unknown[]) => ({ config: "/work/game/pocket.config.ts", targets });

  test("no source names a target", () => {
    const framework = fakeFramework();
    const result = pocket(framework, ["check"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no target selected");
    expect(result.calls).toEqual([]);
  });

  test("each source overrides the ones after it", () => {
    const framework = fakeFramework();
    const targetOf = (result: ReturnType<typeof pocket>) => result.calls[0]?.slice(1, 3);

    expect(pocket(framework, ["default", "psp"]).code).toBe(0);
    let result = pocket(framework, ["check"]);
    expect(targetOf(result)).toEqual(["--target", "psp"]);
    expect(result.err).toContain("pocket: target psp · user default");

    result = pocket(framework, ["check"], project([{ id: "vita" }]));
    expect(targetOf(result)).toEqual(["--target", "vita"]);
    expect(result.err).toContain("pocket: target vita · /work/game/pocket.config.ts");

    expect(pocket(framework, ["override", "set", "web-app"]).code).toBe(0);
    result = pocket(framework, ["check"], project([{ id: "vita" }]));
    expect(targetOf(result)).toEqual(["--target", "web-app"]);
    expect(result.err).toContain(`pocket: target web-app · directory override ${realpathSync(framework.cwd)}`);

    result = pocket(framework, ["check"], project([{ id: "vita" }]), { POCKET_TARGET: "moto-g-play" });
    expect(targetOf(result)).toEqual(["--target", "moto-g-play"]);

    for (const args of [["+psp", "check"], ["check", "+psp"], ["check", "--target", "psp"], ["check", "--target=psp"]]) {
      result = pocket(framework, args, project([{ id: "vita" }]), { POCKET_TARGET: "moto-g-play" });
      expect(targetOf(result), args.join(" ")).toEqual(["--target", "psp"]);
    }

    expect(pocket(framework, ["override", "unset"]).code).toBe(0);
    expect(pocket(framework, ["default", "--unset"]).code).toBe(0);
    expect(pocket(framework, ["check"]).code).toBe(1);
  });

  test("an override applies below its directory", () => {
    const framework = fakeFramework();
    const nested = join(framework.cwd, "apps", "game");
    mkdirSync(nested, { recursive: true });
    expect(pocket(framework, ["override", "set", "vita", "--path", framework.cwd]).code).toBe(0);
    rmSync(framework.log, { force: true });
    const result = runCli(nested, ["check"], {
      POCKET_CLI_TEST_LOG: framework.log,
      XDG_CONFIG_HOME: framework.settings,
      FAKE_PROJECT: JSON.stringify({ ok: true, project: { config: null, targets: [] } }),
      FAKE_CATALOG: JSON.stringify(catalog),
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readJson(framework.log)[0].slice(1, 3)).toEqual(["--target", "vita"]);
  });

  test("conflicting and misplaced selections are errors", () => {
    const framework = fakeFramework();
    let result = pocket(framework, ["+psp", "check", "--target", "vita"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("conflicting targets: +psp and --target vita");

    result = pocket(framework, ["check", "--manifest", "pocket.json", "+psp"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("+psp must come right after `pocket` or right after the command");

    result = pocket(framework, ["check", "--target", "psp", "--", "+vita"]);
    expect(result.code).toBe(0);
    expect(result.calls[0]).toEqual(["check", "--target", "psp", "--cli-protocol", "1", "--", "+vita"]);

    result = pocket(framework, ["+psp", "create", "x"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("+psp selects a target for check, compile, build or show");
  });

  test("a project entry's manifest and host profile reach tools/pocket.ts", () => {
    const framework = fakeFramework();
    const entries = project([
      { id: "moto-g-play", manifest: "/work/game/pocket.android.json" },
      { id: "idf-panel", hostProfile: "/work/firmware/pocket.host.json" },
    ]);
    let result = pocket(framework, ["build"], entries);
    expect(result.calls[0]).toEqual(["build", "--target", "moto-g-play", "--manifest", "/work/game/pocket.android.json", "--cli-protocol", "1"]);

    result = pocket(framework, ["build", "--manifest", "other.json"], entries);
    expect(result.calls[0]).toEqual(["build", "--target", "moto-g-play", "--cli-protocol", "1", "--manifest", "other.json"]);

    result = pocket(framework, ["+idf-panel", "build", "--output", "dist/panel.pocket"], entries);
    expect(result.calls[0]).toEqual(["build", "--host-profile", "/work/firmware/pocket.host.json", "--cli-protocol", "1", "--output", "dist/panel.pocket"]);
  });

  test("build --all builds every project target in order", () => {
    const framework = fakeFramework();
    const result = pocket(framework, ["build", "--all", "--", "--release"], project([{ id: "psp" }, { id: "vita" }]));
    expect(result.code, result.err).toBe(0);
    expect(result.calls).toEqual([
      ["build", "--target", "psp", "--cli-protocol", "1", "--", "--release"],
      ["build", "--target", "vita", "--cli-protocol", "1", "--", "--release"],
    ]);
    expect(pocket(framework, ["build", "--all"]).err).toContain("lists none");
    expect(pocket(framework, ["+psp", "build", "--all"], project([{ id: "psp" }])).err).toContain("drop the explicit target");
  });

  test("a framework on another protocol stops the CLI", () => {
    const framework = fakeFramework(2);
    const result = pocket(framework, ["check", "--target", "psp"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("speaks protocol 1");
    expect(result.err).toContain("speaks protocol 2");
    expect(result.calls).toEqual([]);
  });

  test("default and override reject an id outside the catalog and the project", () => {
    const framework = fakeFramework();
    const result = pocket(framework, ["default", "gba"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("unknown target gba");
  });

  test("show reports the framework, the project and the selection with its source", () => {
    const framework = fakeFramework();
    const result = pocket(framework, ["show", "--json"], project([{ id: "vita" }]));
    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.framework).toMatchObject({ version: "9.9.9", source: "checkout", protocol: 1, root: realpathSync(framework.cwd) });
    expect(report.selection).toEqual({ id: "vita", source: "project", origin: "/work/game/pocket.config.ts" });
    expect(report.targets.map((target: { id: string; state: string }) => [target.id, target.state])).toEqual([
      ["psp", "not installed"],
      ["vita", "no manifest"],
      ["web-app", "nothing to install"],
      ["moto-g-play", "no manifest"],
    ]);

    const explicit = JSON.parse(pocket(framework, ["+psp", "show", "--json"], project([{ id: "vita" }])).out);
    expect(explicit.selection).toEqual({ id: "psp", source: "explicit", origin: "+psp" });

    const text = pocket(framework, ["show"], project([{ id: "vita" }])).out;
    expect(text).toContain("targets for this framework");
    expect(text).toMatch(/psp\s+.*not installed.*pocket target add psp/);
  });

  test("target commands run in the framework, which holds the pins", () => {
    const framework = fakeFramework();
    let result = pocket(framework, ["target", "add", "psp", "vita"]);
    expect(result.code, result.err).toBe(0);
    expect(result.calls).toEqual([["target", "add", "psp", "vita", "--cli-protocol", "1"]]);

    result = pocket(framework, ["target", "list", "--check"]);
    expect(result.calls).toEqual([["target", "list", "--check", "--cli-protocol", "1"]]);

    result = pocket(fakeFramework(2), ["target", "add", "psp"]);
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
  });
});

describe("framework resolution", () => {
  test("the marker identifies a framework under any package name, and the nearest candidate wins", async () => {
    const { resolveFramework } = await import("../tools/cli/framework.mjs");
    const base = scratch();
    const fork = join(base, "fork");
    mkdirSync(fork);
    writeFileSync(join(fork, "package.json"), JSON.stringify({ name: "@me/pocketjs-fork", version: "1.0.0", pocketjs: { protocol: 1 } }));
    expect(resolveFramework({ cwd: fork, env: {} })).toMatchObject({ root: fork, source: "checkout", name: "@me/pocketjs-fork" });

    const app = join(fork, "apps", "game");
    mkdirSync(join(app, "node_modules/@pocketjs/framework"), { recursive: true });
    writeFileSync(join(app, "node_modules/@pocketjs/framework/package.json"), JSON.stringify({ name: "@pocketjs/framework", version: "2.0.0", pocketjs: { protocol: 1 } }));
    expect(resolveFramework({ cwd: app, env: {} })).toMatchObject({ source: "project", version: "2.0.0", origin: "registry" });

    const unmarked = join(base, "unmarked");
    mkdirSync(join(unmarked, "node_modules/@pocketjs/framework"), { recursive: true });
    writeFileSync(join(unmarked, "node_modules/@pocketjs/framework/package.json"), JSON.stringify({ name: "@pocketjs/framework", version: "0.14.0" }));
    expect(resolveFramework({ cwd: unmarked, env: {} }).error).toContain("no \"pocketjs\": { \"protocol\": … } marker");

    expect(resolveFramework({ cwd: base, env: { POCKETJS_FRAMEWORK_ROOT: unmarked } }).error).toContain("is not a PocketJS framework");
  });

  test("a linked install reports where it points", async () => {
    const { resolveFramework } = await import("../tools/cli/framework.mjs");
    const base = scratch();
    const fork = join(base, "fork");
    mkdirSync(fork);
    writeFileSync(join(fork, "package.json"), JSON.stringify({ name: "@me/fork", version: "1.0.0", pocketjs: { protocol: 1 } }));
    const app = join(base, "app");
    mkdirSync(join(app, "node_modules/@pocketjs"), { recursive: true });
    symlinkSync(fork, join(app, "node_modules/@pocketjs/framework"), "dir");
    expect(resolveFramework({ cwd: app, env: {} })).toMatchObject({ root: realpathSync(fork), source: "project", origin: `link → ${realpathSync(fork)}` });
  });
});

