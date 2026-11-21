import { resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "../../dist/icon-study");
const port = Number(process.env.PORT ?? 4176);
const server = Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(request) {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Bad URL", { status: 400 }); }
    const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(root + sep)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "Cache-Control": "no-store" } });
  },
});
console.log(`Pocket icon study → ${server.url}`);
