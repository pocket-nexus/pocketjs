// Build just the desk and its existing AppInstance runtime for a fast local preview.
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESK_APPS } from "../../site/desk-apps.ts";
import { emitDeskPackage } from "../../site/desk-package.ts";

const root = new URL("../../", import.meta.url).pathname;
const styles = resolve(root, "framework/src/styles.generated.ts");
if (!existsSync(styles)) writeFileSync(styles, `export const STYLE_IDS = {};
export const STYLE_COUNT = 0;
export const FONT_SLOTS = {};
export const DEFAULT_FONT_SLOT = 2;
`);
async function run(...args: string[]) {
  const child = Bun.spawn(["bun", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw Error(`Failed: bun ${args.join(" ")}`);
}
if (!existsSync(resolve(root, "hosts/web/pocketjs.wasm"))) await run("tools/wasm.ts");
if (!existsSync(resolve(root, "hosts/web/pocket_text.wasm"))) await run("tools/text-wasm.ts");
for (const app of DESK_APPS) {
  await run("tools/build.ts", app.output, `--density=${app.density}`, `--framework=${app.framework}`, "--outdir=dist/desk-apps");
}
const output = resolve(root, "site/dist");
mkdirSync(resolve(output, "pg"), { recursive: true });
for (const name of ["app-instance.html", "app-instance.js", "wasm-ops.js", "pocketjs.wasm",
  "offload-worker.js", "text-worker.js", "text-engine.js", "pocket_text.wasm"]) {
  cpSync(resolve(root, "hosts/web", name), resolve(output, "pg", name));
}
await emitDeskPackage(output);
console.log("Desk built. Preview: bun site/preview.ts --no-build --port=4173");
