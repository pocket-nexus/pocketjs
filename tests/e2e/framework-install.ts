// tests/e2e/framework-install.ts — the framework as an application installs it.
//
//   bun tests/e2e/framework-install.ts [--keep]
//
// Packs @pocketjs/framework with `npm pack`, scaffolds standalone projects with
// `pocket create` (Solid, Vue Vapor and Octane for web-app, and an ESP-IDF
// host-profile project), installs the tarball into each with `bun install`,
// runs each project's `build` script through this checkout's CLI, and checks
// with `pocket target list --check` that the installed framework reports every
// target of pocket.config.ts ready to build. A symlinked
// checkout carries devDependencies and the checkout's node_modules; a tarball
// install carries `dependencies` alone and hoists them beside the framework,
// which is the layout this script checks. The installed framework is made
// read-only before the build: a build writes nothing into it. Needs the npm
// registry.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const cli = join(root, "tools/cli/bin.mjs");
const keep = process.argv.includes("--keep");
const scratch = mkdtempSync(join(tmpdir(), "pocketjs-framework-install-"));

function run(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: result.stdout.toString() + result.stderr.toString() };
}

const packed = run(["npm", "pack", "--silent", "--pack-destination", scratch], root);
if (!packed.ok) throw new Error(`npm pack failed:\n${packed.output}`);
const tarball = join(scratch, readdirSync(scratch).find((file) => file.endsWith(".tgz"))!);

mkdirSync(join(scratch, "firmware"));
cpSync(join(root, "hosts/esp-idf/examples/smoke/pocket.host.json"), join(scratch, "firmware/pocket.host.json"));

const projects: { name: string; args: string[]; artifact: string }[] = [
  { name: "solid-web", args: ["--target", "web-app"], artifact: "dist/solid-web-main.js" },
  { name: "vue-web", args: ["--target", "web-app", "--framework", "vue-vapor"], artifact: "dist/vue-web-main.js" },
  { name: "octane-web", args: ["--target", "web-app", "--framework", "octane"], artifact: "dist/octane-web-main.js" },
  { name: "idf-app", args: ["--host-profile", "firmware/pocket.host.json"], artifact: "dist/idf-app.pocket" },
];

let failed = 0;
for (const project of projects) {
  const directory = join(scratch, project.name);
  const steps: [string, () => { ok: boolean; output: string }][] = [
    ["create", () => run([process.execPath, cli, "create", project.name, ...project.args], scratch)],
    ["install", () => {
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      pkg.dependencies["@pocketjs/framework"] = `file:${tarball}`;
      delete pkg.devDependencies; // the CLI under test is this checkout's
      writeFileSync(join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
      const installed = run([process.execPath, "install"], directory);
      if (installed.ok) run(["chmod", "-R", "a-w", join(directory, "node_modules/@pocketjs/framework")], scratch);
      return installed;
    }],
    ["build", () => {
      const script: string = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).scripts.build;
      return run([process.execPath, cli, ...script.split(" ").slice(1)], directory);
    }],
    ["target list --check", () => run([process.execPath, cli, "target", "list", "--check"], directory)],
  ];
  let status = "ok";
  for (const [label, step] of steps) {
    const result = step();
    if (!result.ok) {
      status = `${label} failed\n${result.output.trim().split("\n").slice(-12).join("\n")}`;
      break;
    }
  }
  if (status === "ok" && !existsSync(join(directory, project.artifact))) status = `missing ${project.artifact}`;
  if (status !== "ok") failed++;
  console.log(`${status === "ok" ? "ok  " : "FAIL"} ${project.name}${status === "ok" ? ` → ${project.artifact}` : `: ${status}`}`);
}

if (keep) console.log(`kept ${scratch}`);
else {
  run(["chmod", "-R", "u+w", scratch], tmpdir());
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
