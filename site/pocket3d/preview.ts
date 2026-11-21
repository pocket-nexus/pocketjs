// Local preview for 3d.pocket.nexus. Serves site/pocket3d/public/ the way the
// Cloudflare assets Worker does: /index.html at the root, /404.html for
// unknown paths. It also serves the mark study from site/pocket3d/logo/ at
// /logo/; that directory is outside public/, so the Worker does not deploy it.
//   bun site/pocket3d/preview.ts [--port=4191]
import { resolve, sep } from "node:path";

const PUBLIC = new URL("./public", import.meta.url).pathname;
const LOGO = new URL("./logo", import.meta.url).pathname;
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 4191);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response("Bad path", { status: 400 }); }
    if (path === "/logo") return Response.redirect(url.origin + "/logo/" + url.search, 307);
    const [root, rest] = path.startsWith("/logo/") ? [LOGO, path.slice("/logo".length)] : [PUBLIC, path];
    const headers = { "Cache-Control": "no-store" };
    const target = resolve(root, "." + (rest.endsWith("/") ? rest + "index.html" : rest));
    if (target.startsWith(root + sep)) {
      const file = Bun.file(target);
      if (await file.exists()) return new Response(request.method === "HEAD" ? null : file, { headers: { ...headers, "Content-Type": file.type } });
    }
    return new Response(Bun.file(resolve(PUBLIC, "404.html")), { status: 404, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  },
});
console.log(`3d.pocket.nexus preview: http://127.0.0.1:${server.port}/`);
