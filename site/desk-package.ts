import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESK_APPS } from "./desk-apps.ts";

const ROOT = new URL("..", import.meta.url).pathname;

export async function emitDeskPackage(outputRoot: string) {
  const output = resolve(outputRoot, "desk");
  const source = resolve(ROOT, "assets/scenes/desk-scene");
  mkdirSync(resolve(output, "apps"), { recursive: true });
  for (const name of ["preview.png", "web.json"]) cpSync(resolve(source, name), resolve(output, name));
  const attribution = readFileSync(resolve(source, "ATTRIBUTION.md"), "utf8")
    .replaceAll("](../../../", "](https://github.com/pocket-stack/pocketjs/blob/main/");
  writeFileSync(resolve(output, "ATTRIBUTION.md"), attribution);
  cpSync(resolve(ROOT, "site/desk/index.html"), resolve(output, "index.html"));
  cpSync(resolve(ROOT, "site/desk/desk.css"), resolve(output, "desk.css"));
  const result = await Bun.build({ entrypoints: [resolve(ROOT, "site/desk/desk.js")],
    outdir: output, naming: "desk.js", target: "browser", minify: true });
  if (!result.success) throw new AggregateError(result.logs, "Desk browser bundle failed");
  for (const app of DESK_APPS) for (const ext of ["js", "pak"]) {
    const artifact = "artifact" in app ? app.artifact : app.output;
    const path = resolve(ROOT, `dist/desk-apps/${artifact}.${ext}`);
    if (!existsSync(path)) throw Error(`Missing ${path}; run bun tools/desk-scene/web.ts`);
    cpSync(path, resolve(output, `apps/${app.output}.${ext}`));
  }
}
