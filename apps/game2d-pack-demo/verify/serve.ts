// Web host server: verify/ at /, the compiled bundle at /dist/, game data at /data/, the checkout at
// /pocketjs/ (TypeScript transpiled on request).
//   PORT=8150 POCKET_DIST=<outdir> bun apps/game2d-pack-demo/verify/serve.ts
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const VERIFY = import.meta.dir;
const APP = resolve(VERIFY, "..");
const ROOT = resolve(APP, "../..");
const DIST = process.env.POCKET_DIST ?? join(ROOT, ".pocket-build/validation/game2d-pack-demo/web");
const transpiler = new Bun.Transpiler({ loader: "ts" });
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", wasm: "application/wasm" };

function file(path: string): Response {
  if (!existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 });
  const extension = path.slice(path.lastIndexOf(".") + 1);
  return new Response(Bun.file(path), { headers: { "content-type": TYPES[extension] ?? "application/octet-stream", "cache-control": "no-store" } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8150),
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.includes("..")) return new Response("bad path", { status: 400 });
    if (path === "/") return file(join(VERIFY, "index.html"));
    if (path.startsWith("/dist/")) return file(join(DIST, path.slice(6)));
    if (path.startsWith("/data/")) return file(join(APP, "gen/data", path.slice(6)));
    if (path.startsWith("/pocketjs/")) {
      const target = join(ROOT, path.slice(10));
      if (target.endsWith(".ts") && existsSync(target)) {
        return new Response(transpiler.transformSync(await Bun.file(target).text()), { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      }
      return file(target);
    }
    return file(join(VERIFY, path.slice(1)));
  },
});
console.log(`pack demo: http://127.0.0.1:${server.port}/`);
