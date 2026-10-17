import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "tools/cli/bin.mjs");
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
    for (const name of ["pocket", "pocket-pack", "play", "symbian", "vita", "ios"]) {
      writeFileSync(join(scripts, `${name}.ts`), recorder);
    }

    const cases = [
      { cliArgs: ["check", "--target", "psp"], script: "pocket.ts", args: ["check", "--target", "psp"] },
      { cliArgs: ["compile", "--target", "vita"], script: "pocket.ts", args: ["compile", "--target", "vita"] },
      { cliArgs: ["build", "--target", "vita", "--", "--release"], script: "pocket.ts", args: ["build", "--target", "vita", "--", "--release"] },
      { cliArgs: ["pack", "--bytecode", "--target", "psp", "--manifest", "apps/demo/pocket.json"], script: "pocket-pack.ts", args: ["build", "--bytecode", "--target", "psp", "--manifest", "apps/demo/pocket.json"] },
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
});
