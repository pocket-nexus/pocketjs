import { lockLibrary } from "./lock.ts";
import { encodePng } from "../png.ts";
import { parseSeries, packOf } from "../model.ts";
import { readDocument } from "../document.ts";
import { addSource, getBook, identity, listBooks } from "./sources.ts";
import { MangaStore, type ImportRequest } from "./store.ts";
import { runJobs } from "./jobs.ts";
import { packPath, readPack, packImage, packSignature } from "./packs.ts";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function serveManga(options: { root: string; port?: number; allowPrivate?: boolean }) {
  const unlock = lockLibrary(options.root);
  let store: MangaStore;
  try { store = new MangaStore(options.root); } catch (error) { unlock(); throw error; }
  let jobs: ReturnType<typeof runJobs> | undefined;
  try {
  // Workspaces are private to this daemon; interrupted jobs remain retryable.
  for (const item of readdirSync(options.root)) if (item.startsWith("import-")) rmSync(join(options.root, item), { recursive: true, force: true });
  store.publish();
  jobs = runJobs(store, options.allowPrivate);
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const network = { allowPrivate: options.allowPrivate };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 8743, maxRequestBodySize: 16384,
    async fetch(request) {
      const url = new URL(request.url), p = url.pathname;
      // Local administration: cross-origin pages cannot enqueue downloads or
      // read the local filesystem through a re-bound hostname.
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return json({ error: "Use the loopback companion address" }, 403);
      if (request.method !== "GET" && (request.headers.get("X-Manga-Request") !== "1" ||
        request.headers.get("origin") && request.headers.get("origin") !== url.origin)) return json({ error: "Same-origin request required" }, 403);
      try {
        if (request.method === "GET" && p === "/") return new Response(Bun.file(new URL("./index.html", import.meta.url)), { headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        } });
        if (request.method === "GET" && p === "/api/state") return json({ sources: store.sources(), library: store.index().series, jobs: store.jobs() });
        if (request.method === "POST" && p === "/api/sources") {
          const input = await request.json();
          if (typeof input.url !== "string") throw Error("Source URL is required");
          const source = await addSource(input.url, { ...network, signal: request.signal }); store.addSource(source); return json(source, 201);
        }
        if (request.method === "DELETE" && p.startsWith("/api/sources/")) { store.removeSource(p.slice(13)); return json({ ok: true }); }
        if (request.method === "GET" && p === "/api/catalog") {
          const offset = Number(url.searchParams.get("offset") ?? "0"), query = url.searchParams.get("q") ?? "";
          if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || query.length > 240) throw Error("Invalid catalog query");
          return json(await listBooks(store.source(url.searchParams.get("source") ?? ""), query, offset, url.searchParams.get("language") ?? "en", { ...network, signal: request.signal }));
        }
        if (request.method === "GET" && p === "/api/book") return json(await getBook(store.source(url.searchParams.get("source") ?? ""), url.searchParams.get("book") ?? "", url.searchParams.get("language") ?? "en", { ...network, signal: request.signal }));
        if (request.method === "POST" && p === "/api/import") {
          const input = await request.json() as ImportRequest;
          const job = store.enqueue({ ...input, language: input.language ?? "en" }); jobs!.pump(); return json(job, 202);
        }
        const action = /^\/api\/jobs\/([a-f0-9-]+)\/(cancel|retry)$/.exec(p);
        if (request.method === "POST" && action) { if (action[2] === "cancel") jobs!.cancel(action[1]!); else jobs!.retry(action[1]!); return json({ ok: true }); }
        const book = /^\/api\/library\/([a-z0-9-]+)$/.exec(p);
        if (book && request.method === "DELETE") { store.removeBook(book[1]!); return json({ ok: true }); }
        if (book && request.method === "GET") {
          const summary = store.index().series.find(s => s.slug === book[1]);
          if (!summary) return json({ error: "Series not found" }, 404);
          const meta = parseSeries(JSON.parse(await readDocument(async n => readPack(options.root, packOf(summary), n).bytes.toString())));
          if (!meta) throw Error("Invalid series metadata"); return json(meta);
        }
        const image = /^\/api\/image\/([a-z0-9-]+)\/(\d+)$/.exec(p);
        if (request.method === "GET" && image) {
          const tag = (signature: string) => `"${identity(`${signature}/${image[2]}`)}"`;
          const headers = { "Content-Type": "image/png", ETag: tag(packSignature(options.root, image[1]!)),
            "Cache-Control": /^mg-[a-f0-9]{32}$/.test(image[1]!) ? "private, max-age=31536000, immutable" : "private, max-age=0, must-revalidate" };
          const candidates = request.headers.get("If-None-Match")?.split(",").map(value => value.trim()) ?? [];
          const unchanged = () => candidates.includes(headers.ETag) || candidates.includes(`W/${headers.ETag}`);
          if (unchanged())
            return new Response(null, { status: 304, headers });
          const record = readPack(options.root, image[1]!, Number(image[2]));
          // A pack may be replaced between stat and open. Tag the inode that
          // supplied this response's pixels, as the Relay provider does.
          headers.ETag = tag(record.signature);
          const img = packImage(record);
          if (unchanged() || candidates.includes("*")) return new Response(null, { status: 304, headers });
          const png = encodePng(img.width, img.height, (x, y) => {
            const at = (y * img.width + x) * 2, v = img.pixels[at]! | (img.pixels[at + 1]! << 8);
            return [Math.round((v & 31) * 255 / 31), Math.round(((v >> 5) & 63) * 255 / 63), Math.round((v >> 11) * 255 / 31)];
          });
          return new Response(Buffer.from(png), { headers });
        }
        const pack = /^\/api\/packs\/([a-z0-9-]+)$/.exec(p);
        if (request.method === "GET" && pack) {
          const path = packPath(options.root, pack[1]!);
          if (!existsSync(path)) return json({ error: "Pack not found" }, 404);
          return new Response(Bun.file(path), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${pack[1]}.prp"` } });
        }
        return json({ error: "Not found" }, 404);
      } catch (error) { return json({ error: error instanceof Error ? error.message : "Relay request failed" }, 400); }
    },
  });
  return { server, store, close() { jobs!.close(); server.stop(true); store.close(); unlock(); } };
  } catch (error) { jobs?.close(); store.close(); unlock(); throw error; }
}
