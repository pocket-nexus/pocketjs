// Local preview for pocket.nexus. Serves site/nexus/public/ the way the
// Cloudflare assets Worker does: /index.html at the root, /404.html for
// unknown paths.
//   bun site/nexus/preview.ts [--port=4190]
import { resolve, sep } from "node:path";

const ROOT = new URL("./public", import.meta.url).pathname;
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 4190);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    let path: string;
    try { path = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Bad path", { status: 400 }); }
    const target = resolve(ROOT, "." + (path.endsWith("/") ? path + "index.html" : path));
    const headers = { "Cache-Control": "no-store" };
    if (target.startsWith(ROOT + sep)) {
      const file = Bun.file(target);
      if (await file.exists()) return new Response(request.method === "HEAD" ? null : file, { headers: { ...headers, "Content-Type": file.type } });
    }
    return new Response(Bun.file(resolve(ROOT, "404.html")), { status: 404, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  },
});
console.log(`pocket.nexus preview: http://127.0.0.1:${server.port}/`);
