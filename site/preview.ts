// Serve the production build locally.
import { resolve, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = resolve(ROOT, "site/dist");
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
if (!process.argv.includes("--no-build")) {
  const build = Bun.spawn(["bun", "tools/site-build.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) process.exit(1);
}
if (!await Bun.file(resolve(OUT, "index.html")).exists()) throw new Error("Missing site build; run bun run site:preview without --no-build");
const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  let path: string;
  try { path = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Bad path", { status: 400 }); }
  const target = resolve(OUT, "." + path);
  if (target !== OUT && !target.startsWith(OUT + sep)) return new Response("Not found", { status: 404 });
  const isDirectory = await Bun.file(resolve(target, "index.html")).exists();
  if (isDirectory && !path.endsWith("/")) {
    const url = new URL(request.url); url.pathname += "/";
    return Response.redirect(url, 302);
  }
  const file = Bun.file(isDirectory ? resolve(target, "index.html") : target);
  if (!await file.exists()) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type, "Cache-Control": "no-store" } });
} });
console.log(`Homepage:             http://127.0.0.1:${server.port}/`);
console.log(`Mobile docs:          http://127.0.0.1:${server.port}/docs/overview/`);
