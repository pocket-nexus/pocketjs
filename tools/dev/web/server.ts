// tools/dev/web/server.ts — the dev server as a module: static browser host +
// demo manifest + the Pocket DevTools panel and WS hub (docs/DEVTOOLS.md).
// Thin CLI wrapper: tools/dev/web/serve.ts. In-process consumer: tools/devtools.ts.
//
// The hub is a dumb relay between roles: every device line goes to every
// panel and vice versa (plus deviceConnected/deviceGone notices). No state,
// no parsing; the runtime shim (framework/src/devtools.ts) and the panel own the
// protocol.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url))); // PocketJS/
const HOST_DIR = join(ROOT, "programs/web/dev/");
const DIST_DIR = join(ROOT, "dist/");

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  wasm: "application/wasm",
  png: "image/png",
  pak: "application/octet-stream",
};

function fileResponse(path: string): Response {
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return new Response(Bun.file(path), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

export function demoManifest(): { name: string; hasPak: boolean; mounts: boolean }[] {
  if (!existsSync(DIST_DIR)) return [];
  return readdirSync(DIST_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -3);
      // A mounting entry bundles framework/src/index.ts, whose frame hookup goes
      // through installFrameHandler — cheap, reliable dev-tool heuristic.
      const src = readFileSync(DIST_DIR + f, "utf8");
      return {
        name,
        hasPak: existsSync(DIST_DIR + name + ".pak"),
        mounts: src.includes("installFrameHandler"),
      };
    });
}

type Role = "panel" | "device";
type DevWS = Bun.ServerWebSocket<{ role: Role }>;

export interface DevServer {
  port: number;
  url: string;
  panelUrl: string;
  stop(): void;
}

export interface DevServerOptions {
  port?: number;
  /** Try up to this many consecutive ports when the first is taken. */
  portRetries?: number;
}

export function startDevServer(opts: DevServerOptions = {}): DevServer {
  const wanted = opts.port ?? Number(process.env.PORT ?? 8130);
  const retries = opts.portRetries ?? 0;

  const peers: Record<Role, Set<DevWS>> = { panel: new Set(), device: new Set() };

  function relay(from: Role, data: string | Buffer): void {
    const to: Role = from === "device" ? "panel" : "device";
    const text = typeof data === "string" ? data : data.toString("utf8");
    for (const ws of peers[to]) ws.send(text);
  }

  function notifyPanels(msg: object): void {
    const text = JSON.stringify(msg);
    for (const ws of peers.panel) ws.send(text);
  }

  let server: ReturnType<typeof Bun.serve<{ role: Role }>> | null = null;
  let lastErr: unknown = null;
  for (let port = wanted; port <= wanted + retries; port++) {
    try {
      server = Bun.serve<{ role: Role }>({
        hostname: "127.0.0.1",
        port,
        fetch(req, srv) {
          const url = new URL(req.url);
          const path = url.pathname.replace(/\.\.+/g, ""); // no traversal
          if (path === "/ws") {
            const role: Role = url.searchParams.get("role") === "device" ? "device" : "panel";
            if (srv.upgrade(req, { data: { role } })) return undefined as unknown as Response;
            return new Response("websocket upgrade failed", { status: 400 });
          }
          if (path === "/" || path === "/index.html") return fileResponse(HOST_DIR + "index.html");
          if (path === "/devtools" || path === "/devtools/") {
            return fileResponse(HOST_DIR + "devtools.html");
          }
          if (path === "/demos") {
            return Response.json(demoManifest(), { headers: { "cache-control": "no-store" } });
          }
          if (path.startsWith("/dist/")) return fileResponse(DIST_DIR + path.slice("/dist/".length));
          if (path.startsWith("/platforms/web/") || path.startsWith("/programs/web/")) return fileResponse(join(ROOT, path.slice(1)));
          return fileResponse(HOST_DIR + path.slice(1));
        },
        websocket: {
          open(ws) {
            peers[ws.data.role].add(ws);
            if (ws.data.role === "device") notifyPanels({ t: "deviceConnected" });
          },
          message(ws, data) {
            relay(ws.data.role, data as string | Buffer);
          },
          close(ws) {
            peers[ws.data.role].delete(ws);
            if (ws.data.role === "device") notifyPanels({ t: "deviceGone" });
          },
        },
      });
      break;
    } catch (e) {
      lastErr = e;
      server = null;
    }
  }
  if (!server) {
    throw new Error(
      `port ${wanted}${retries ? `-${wanted + retries}` : ""} unavailable: ${lastErr}`,
    );
  }

  return {
    port: server.port!,
    url: `http://127.0.0.1:${server.port}/`,
    panelUrl: `http://127.0.0.1:${server.port}/devtools`,
    stop: () => server!.stop(true),
  };
}
