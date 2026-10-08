// site/microts/serve.ts — local server for the MicroTS site.
//
//   bun site/microts/serve.ts           # dev: build once, rebuild on change, reload the page
//   bun site/microts/serve.ts --dist    # serve an existing site/microts/dist/ (after build.ts)
//
// Paths without a file extension fall back to index.html, as the Worker does
// (wrangler.jsonc: not_found_handling = single-page-application).
import { existsSync, statSync, watch } from "node:fs";
import { extname, join } from "node:path";
import { buildApp, buildWasm, copyStatic, sourceCommit } from "./build.ts";
import { buildKit } from "./lib/kit.ts";
import { OUT, ROOT, SITE } from "./lib/paths.ts";
import { prepareRetro } from "./lib/retro.ts";

const PORT = Number(process.env.PORT ?? 8150);
const clients = new Set<ReadableStreamDefaultController<string>>();

if (!process.argv.includes("--dist")) {
  const commit = sourceCommit();
  await prepareRetro();
  buildWasm();
  await buildKit(OUT, commit);
  await buildApp({ dev: true, commit });
  copyStatic();

  // Rebuild what changed, one build at a time, then tell open pages to reload.
  const pending = new Set<"app" | "kit">();
  let building = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (building || !pending.size) return;
    building = true;
    const jobs = [...pending];
    pending.clear();
    try {
      if (jobs.includes("kit")) await buildKit(OUT, commit);
      if (jobs.includes("app")) await buildApp({ dev: true, commit });
      for (const c of clients) c.enqueue("data: reload\n\n");
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
    } finally {
      building = false;
      void run();
    }
  };
  const on = (path: string, job: "app" | "kit") =>
    watch(path, { recursive: true }, () => {
      pending.add(job);
      clearTimeout(timer);
      timer = setTimeout(run, 80);
    });
  on(join(SITE, "src"), "app");
  on(join(SITE, "content"), "app");
  on(join(SITE, "index.html"), "app");
  on(join(ROOT, "site/content/docs"), "app");
  on(join(ROOT, "site/nav.ts"), "app");
  on(join(ROOT, "apps/vue-sfc-lab"), "app");
  on(join(ROOT, "apps/solid-aot-lab"), "app");
  on(join(SITE, "kit"), "kit");
}

function file(pathname: string): string | null {
  const p = join(OUT, decodeURIComponent(pathname).replace(/\.\.+/g, ""));
  if (existsSync(p) && statSync(p).isFile()) return p;
  return extname(pathname) ? null : join(OUT, "index.html");
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // keep the reload stream open
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/__reload") {
      let self: ReadableStreamDefaultController<string>;
      const stream = new ReadableStream<string>({
        start(c) {
          self = c;
          clients.add(c);
          c.enqueue(": connected\n\n");
        },
        cancel() {
          clients.delete(self);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    const path = file(pathname);
    if (!path) return new Response(`not found: ${pathname}`, { status: 404 });
    return new Response(Bun.file(path), { headers: { "cache-control": "no-store" } });
  },
});
console.log(`MicroTS site: http://127.0.0.1:${PORT}/`);
