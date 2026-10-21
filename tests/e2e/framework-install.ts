// Installs packed framework and CLI into standalone projects, checks application
// types, and compiles version 2 packages with a read-only framework install.
// Run: bun tests/e2e/framework-install.ts [--keep]
// Requires access to the npm registry.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("../..", import.meta.url).pathname;
const cli = join(root, "tools/cli/bin.mjs");
const keep = process.argv.includes("--keep");
const validationRoot = join(root, ".pocket-build/validation/framework-install");
mkdirSync(validationRoot, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "pocketjs-framework-install-"));

function run(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: result.success, output: result.stdout.toString() + result.stderr.toString() };
}

const packed = run(["npm", "pack", "--silent", "--pack-destination", scratch], root);
if (!packed.ok) throw new Error(`npm pack failed:\n${packed.output}`);
const tarball = join(scratch, readdirSync(scratch).find((file) => file.endsWith(".tgz"))!);

const packedCli = run(["npm", "pack", "--silent", "--pack-destination", scratch], join(root, "tools/cli"));
if (!packedCli.ok) throw new Error("CLI npm pack failed: " + packedCli.output);
const cliTarball = join(scratch, readdirSync(scratch).find((file) => file.startsWith("pocketjs-cli-") && file.endsWith(".tgz"))!);

const projects: { name: string; args: string[]; artifact: string }[] = [
  { name: "solid-web", args: ["--target", "web-app"], artifact: "dist/solid-web.pocket" },
  { name: "vue-web", args: ["--target", "web-app", "--framework", "vue-vapor"], artifact: "dist/vue-web.pocket" },
  { name: "octane-web", args: ["--target", "web-app", "--framework", "octane"], artifact: "dist/octane-web.pocket" },
  { name: "idf-app", args: ["--target", "esp-idf"], artifact: "dist/idf-app.pocket" },
];

let failed = 0;
for (const project of projects) {
  const directory = join(scratch, project.name);
  const installedCli = join(directory, "node_modules/@pocketjs/cli/bin.mjs");
  const steps: [string, () => { ok: boolean; output: string }][] = [
    ["create", () => run([process.execPath, cli, "create", project.name, ...project.args], scratch)],
    ["install", () => {
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      pkg.dependencies["@pocketjs/framework"] = `file:${tarball}`;
      pkg.devDependencies["@pocketjs/cli"] = "file:" + cliTarball;
      writeFileSync(join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
      const installed = run([process.execPath, "install"], directory);
      if (installed.ok) run(["chmod", "-R", "a-w", join(directory, "node_modules/@pocketjs/framework")], scratch);
      return installed;
    }],
    ["build", () => {
      const script: string = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).scripts.build;
      return run([process.execPath, installedCli, ...script.split(" ").slice(1)], directory);
    }],
    ["check", () => {
      const script: string = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).scripts.check;
      return run([process.execPath, installedCli, ...script.split(" ").slice(1)], directory);
    }],
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
  if (status === "ok" && readFileSync(join(directory, project.artifact)).readUInt32LE(4) !== 2) status = "package version is not 2";
  if (status !== "ok") failed++;
  console.log(`${status === "ok" ? "ok  " : "FAIL"} ${project.name}${status === "ok" ? ` → ${project.artifact}` : `: ${status}`}`);
}

if (keep) {
  const saved = join(validationRoot, basename(scratch));
  renameSync(scratch, saved);
  console.log(`kept ${saved}`);
}
else {
  run(["chmod", "-R", "u+w", scratch], validationRoot);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
