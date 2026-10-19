// Local control API for the menu-bar app and the CLI: HTTP on 127.0.0.1, a
// random port, bearer-token auth. `control.json` ({port, token, pid}, 0600) in
// the store directory tells clients where the running daemon is.
//
//   GET    /status         companion, connected + paired consoles, apps, pairing
//   POST   /pair           open a pairing window -> {uri, expiresAt}
//   DELETE /pair           close the pairing window
//   DELETE /consoles/:id   forget a console (delete its key, close its link)
//   POST   /apps-dir       {path} -> set the owner's apps folder

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Companion } from "./server.ts";

export interface ControlInfo {
  port: number;
  token: string;
  pid: number;
}

export function controlFile(storeDir: string): string {
  return join(storeDir, "control.json");
}

export function startControl(companion: Companion, storeDir: string): { info: ControlInfo; stop: () => void } {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const auth = Buffer.from(request.headers.get("authorization") ?? "");
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json({ error: "unauthorized" }, 401);
      const { pathname } = new URL(request.url);
      const method = request.method;
      if (method === "GET" && pathname === "/status") return json(companion.status());
      if (method === "POST" && pathname === "/pair") return json(companion.openPairing());
      if (method === "DELETE" && pathname === "/pair") return json({ closed: companion.closePairing() });
      const forget = pathname.match(/^\/consoles\/([0-9a-f]{16})$/);
      if (method === "DELETE" && forget) {
        const removed = companion.forget(forget[1]);
        return json({ removed }, removed ? 200 : 404);
      }
      if (method === "POST" && pathname === "/apps-dir") {
        let body: { path?: unknown };
        try {
          body = (await request.json()) as { path?: unknown };
        } catch {
          return json({ error: "expected JSON {path}" }, 400);
        }
        if (typeof body.path !== "string" || !body.path) return json({ error: "expected JSON {path}" }, 400);
        const path = resolve(body.path);
        if (!existsSync(path) || !statSync(path).isDirectory()) return json({ error: `${path} is not a directory` }, 400);
        companion.setAppsDir(path);
        return json({ appsDir: path, apps: companion.status().apps });
      }
      return json({ error: "not found" }, 404);
    },
  });
  const info: ControlInfo = { port: server.port as number, token, pid: process.pid };
  const file = controlFile(storeDir);
  writeFileSync(file, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return {
    info,
    stop() {
      server.stop(true);
      try {
        const current = JSON.parse(readFileSync(file, "utf8")) as ControlInfo;
        if (current.pid === process.pid) rmSync(file);
      } catch {}
    },
  };
}

/** Read control.json and check the daemon it names is alive. */
export function readControl(storeDir: string): ControlInfo | null {
  try {
    const info = JSON.parse(readFileSync(controlFile(storeDir), "utf8")) as ControlInfo;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

export async function controlRequest<T = unknown>(info: ControlInfo, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
