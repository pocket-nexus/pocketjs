import { fileURLToPath } from "node:url";
import { RELAY_ERROR } from "@pocketjs/framework/relay/spec";
import type { OffloadImage } from "../../../contracts/spec/offload.ts";
import { mangaMethods } from "./provider.ts";

export interface MangaReply { payload?: string; image?: OffloadImage; revision?: string; notModified?: boolean; error?: { code: string; message: string } }
export interface MangaBackend { call(method: string, payload: string, ifRevision?: string): Promise<MangaReply>; close(): void | Promise<void> }
export function dispatchManga(service: ReturnType<typeof mangaMethods>, method: string, payload: string, ifRevision?: string): MangaReply {
  try {
    if (["manga.read", "manga.describe", "manga.image"].includes(method)) return service.resource(method, payload, ifRevision);
    if (!Object.hasOwn(service.methods, method)) return { error: { code: RELAY_ERROR.UNSUPPORTED, message: "Unknown manga operation" } };
    const result = service.methods[method as keyof typeof service.methods](payload);
    return typeof result === "string" ? { payload: result } : { image: result };
  } catch (error) {
    return { error: { code: (error as { code?: string }).code === "ENOENT" ? RELAY_ERROR.NOT_FOUND : RELAY_ERROR.INVALID,
      message: error instanceof Error ? error.message : String(error) } };
  }
}

/** The relay loop handles sockets; pack inflation, pixels and SQLite stay in
 * the same isolated process used by the offload companion. */
export function workerBackend(root: string): MangaBackend {
  let next = 1, closed = false;
  const pending = new Map<number, { resolve(reply: MangaReply): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.resolve({ error: { code: RELAY_ERROR.BUSY, message: "Manga worker stopped" } }); }
    pending.clear();
  };
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../../tools/offload-process.ts", import.meta.url)),
    new URL("./provider-worker.ts", import.meta.url).href], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit", serialization: "advanced",
    ipc(value) {
      const reply = value as MangaReply & { id: number };
      const item = pending.get(reply.id);
      if (!item) return;
      pending.delete(reply.id); clearTimeout(item.timer); item.resolve(reply);
    }, onExit: fail,
  });
  child.send({ init: { root } });
  return {
    call(method, payload, ifRevision) {
      if (closed || pending.size >= 8) return Promise.resolve({ error: { code: RELAY_ERROR.BUSY, message: "Manga worker unavailable" } });
      return new Promise(resolve => {
        const id = next++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve({ error: { code: RELAY_ERROR.DEADLINE, message: "Manga worker deadline" } });
        }, 9000);
        timer.unref(); pending.set(id, { resolve, timer });
        try { child.send({ relay: true, id, method, payload, ifRevision }); } catch { fail(); }
      });
    },
    async close() { fail(); if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); await child.exited; },
  };
}
