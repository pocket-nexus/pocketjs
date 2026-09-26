// tools/dev.ts — one-shot dev loop: build the wasm backend, build the demo
// bundle(s), then serve the browser host.
//
//   bun tools/dev.ts                 # wasm + hero-main + serve
//   bun tools/dev.ts hero-main cards # build specific demos instead
//   bun tools/dev.ts --framework=vue-vapor hero-main
//   PORT=9000 bun tools/dev.ts
//
// Rebuild-on-change is deliberately manual (dev-tool simplicity): re-run
// `bun tools/build.ts <app>` (or this script) and reload the page.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url))); // PocketJS/

function run(cmd: string[]): void {
  console.log(`dev: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
}

const buildFlags = process.argv
  .slice(2)
  .filter((a) => a === "--no-config" || a.startsWith("--framework=") || a.startsWith("--config=") || a.startsWith("--extra-chars="));
const demos = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (demos.length === 0) demos.push("hero-main");

run([process.execPath, "tools/wasm.ts"]);
for (const demo of demos) {
  run([process.execPath, "tools/build.ts", demo, ...buildFlags]);
}

await import("../hosts/web/serve.ts");
