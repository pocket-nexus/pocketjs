import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectConfig, loadProject } from "../tools/targets/project.ts";

const root = realpathSync(new URL("..", import.meta.url).pathname);
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-project-")));
  temporary.push(path);
  return path;
}

const config = (body: string) => `import { definePocketConfig } from "@pocketjs/framework/config";\nexport default definePocketConfig(${body});\n`;
const smokeProfile = readFileSync(join(root, "hosts/esp-idf/examples/smoke/pocket.host.json"), "utf8");

describe("project configuration", () => {
  test("the nearest pocket.config.ts above the manifest directory wins and the lookup stops there", async () => {
    const project = scratch();
    writeFileSync(join(project, "pocket.config.ts"), config('{ targets: ["psp"] }'));
    const app = join(project, "apps", "game");
    mkdirSync(app, { recursive: true });
    expect(findProjectConfig(app)).toBe(join(project, "pocket.config.ts"));

    writeFileSync(join(app, "pocket.config.ts"), config("{ theme: {} }"));
    const result = await loadProject(app);
    expect(result).toEqual({ ok: true, project: { config: join(app, "pocket.config.ts"), targets: [] } });
  });

  test("entries resolve against the configuration file and host profiles are named by their id", async () => {
    const project = scratch();
    mkdirSync(join(project, "firmware"));
    writeFileSync(join(project, "firmware/pocket.host.json"), smokeProfile);
    writeFileSync(join(project, "pocket.config.ts"), config(`{
      targets: [
        "vita",
        { target: "moto-g-play", manifest: "pocket.android.json" },
        { hostProfile: "firmware/pocket.host.json" },
      ],
    }`));
    const result = await loadProject(join(project, "src"));
    expect(result).toEqual({
      ok: true,
      project: {
        config: join(project, "pocket.config.ts"),
        targets: [
          { id: "vita" },
          { id: "moto-g-play", manifest: join(project, "pocket.android.json") },
          { id: "idf-smoke", hostProfile: join(project, "firmware/pocket.host.json") },
        ],
      },
    });
  });

  test("unknown ids, duplicates, missing profiles and profile ids that collide are diagnostics", async () => {
    const project = scratch();
    writeFileSync(join(project, "colliding.host.json"), smokeProfile.replace('"idf-smoke"', '"psp"'));
    writeFileSync(join(project, "command.host.json"), smokeProfile.replace('"idf-smoke"', '"show"'));
    writeFileSync(join(project, "pocket.config.ts"), config(`{
      targets: ["gba", "psp", "psp", { hostProfile: "missing.json" }, { hostProfile: "colliding.host.json" }, { hostProfile: "command.host.json" }],
    }`));
    const result = await loadProject(project);
    expect(result.ok).toBe(false);
    const diagnostics = result.ok ? [] : result.diagnostics.join("\n");
    expect(diagnostics).toContain("targets[0]: unknown target gba");
    expect(diagnostics).toContain("target psp is listed twice");
    expect(diagnostics).toContain(`targets[3]: host profile not found: ${join(project, "missing.json")}`);
    expect(diagnostics).toContain("targets[4]: host profile id psp is a catalog id or a pocket command word");
    expect(diagnostics).toContain("targets[5]: host profile id show is a catalog id or a pocket command word");
  });

  test("a project without node_modules evaluates against this framework", () => {
    const project = scratch();
    writeFileSync(join(project, "pocket.config.ts"), config('{ targets: ["web-app"] }'));
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--no-install", join(root, "tools/pocket.ts"), "project"],
      cwd: project,
      env: { ...process.env, POCKETJS_FRAMEWORK_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      ok: true,
      project: { config: join(project, "pocket.config.ts"), targets: [{ id: "web-app" }] },
    });
  });

  test("tools/pocket.ts stops when the CLI speaks another protocol", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(root, "tools/pocket.ts"), "check", "--target", "psp", "--cli-protocol", "2"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("the CLI speaks protocol 2 and the framework");
  });
});
