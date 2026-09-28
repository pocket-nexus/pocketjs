import type { OffloadResult } from "@pocketjs/framework/offload";
import type { MangaTransport } from "./client.ts";

export interface Withdrawal { cancelled: boolean; cancel?(): void }
interface SharedImage {
  key: string; payload: string; fetch: Withdrawal; write: Withdrawal;
  ready: Promise<void>; persisted: Promise<Error | undefined>;
  waiters: Set<number>; leases: Set<number>; raw?: string;
  width: number; height: number; settled: boolean; writing: boolean; invalidated: boolean;
}

/** Readers and offline downloads share a bounded set of remote images. Each
 * consumer owns a lease; the SD writer keeps the underlying ticket alive until
 * its acknowledgement, without delaying delivery to the renderer. */
export function createMangaImages(options: {
  remote: MangaTransport;
  fetch(payload: string, withdrawal: Withdrawal): Promise<string>;
  save?(payload: string, ticket: string, withdrawal: Withdrawal): Promise<void>;
  onCacheError?(error: string): void;
}) {
  const { remote } = options;
  const groups = new Map<string, SharedImage>(), retained = new Set<SharedImage>();
  const requests = new Map<number, SharedImage>(), leases = new Map<number, SharedImage>();
  const blocked = new Set<string>();
  let sequence = 0, token = 0, disposed = false;
  const errorOf = (error: unknown) => error instanceof Error ? error : Error(String(error));
  function forget(group: SharedImage) { if (groups.get(group.key) === group) groups.delete(group.key); }
  function collect(group: SharedImage) {
    if (!group.settled || group.writing || group.waiters.size || group.leases.size) return;
    forget(group); retained.delete(group);
    if (group.raw !== undefined) { const raw = group.raw; group.raw = undefined; remote.releaseImage(raw); }
  }
  function cancel(id: number) {
    const group = requests.get(id);
    if (!group) return;
    requests.delete(id); group.waiters.delete(id);
    if (!group.settled && !group.waiters.size) {
      group.fetch.cancelled = true; group.fetch.cancel?.(); forget(group);
    }
    collect(group);
  }
  function releaseImage(raw: string) {
    const ticket = JSON.parse(raw), group = leases.get(ticket.token);
    if (!group) return;
    leases.delete(ticket.token); group.leases.delete(ticket.token); collect(group);
  }
  function shared(payload: string): SharedImage {
    const key = `${remote.session()}:${payload}`, held = groups.get(key);
    if (held) return held;
    const group: SharedImage = { key, payload, fetch: { cancelled: false }, write: { cancelled: false },
      ready: Promise.resolve(), persisted: Promise.resolve(Error("Offline cache unavailable")), waiters: new Set(), leases: new Set(),
      width: 0, height: 0, settled: false, writing: false, invalidated: false };
    groups.set(key, group); retained.add(group);
    group.ready = Promise.resolve().then(() => options.fetch(payload, group.fetch)).then(raw => {
      group.raw = raw;
      if (disposed || group.invalidated || group.fetch.cancelled) throw Error("Manga image cancelled");
      const envelope = JSON.parse(raw);
      if (![envelope.width, envelope.height].every(n => Number.isInteger(n) && n >= 16 && n <= 256 && !(n & (n - 1)))) throw Error("Invalid manga image dimensions");
      group.width = envelope.width; group.height = envelope.height;
      if (options.save) {
        group.writing = true;
        group.persisted = Promise.resolve().then(() => options.save!(payload, raw, group.write)).then(() => undefined, error => {
          if (!group.write.cancelled && !disposed) options.onCacheError?.(String(error));
          return errorOf(error);
        }).finally(() => { group.writing = false; collect(group); });
      }
    }).finally(() => { group.settled = true; collect(group); });
    return group;
  }
  function requestImage(_method: string, payload: string, complete: (result: OffloadResult) => void): number {
    if (!remote.connected() || disposed || requests.size + leases.size >= 24 || blocked.has(payload.split("/")[0]!)) return 0;
    if (!groups.has(`${remote.session()}:${payload}`) && retained.size >= 4) return 0;
    const group = shared(payload), id = ++sequence;
    requests.set(id, group); group.waiters.add(id);
    void group.ready.then(() => {
      if (!requests.delete(id)) return;
      group.waiters.delete(id);
      if (disposed || group.invalidated) {
        try { if (!disposed) complete({ ok: false, error: "Manga cache removed" }); } catch { /* Consumer closed. */ }
        collect(group);
        return;
      }
      const handle = ++token, value = JSON.stringify({ token: handle, width: group.width, height: group.height });
      leases.set(handle, group); group.leases.add(handle);
      try { complete({ ok: true, value }); }
      catch { releaseImage(value); }
    }, error => {
      if (requests.delete(id)) {
        group.waiters.delete(id);
        try { complete({ ok: false, error: String(error) }); } catch { /* Consumer has already closed. */ }
      }
      collect(group);
    });
    return id;
  }
  function invalidate(group: SharedImage, closing = false) {
    group.invalidated = true; forget(group);
    if (closing) for (const id of [...group.waiters]) cancel(id);
    group.fetch.cancelled = true; group.fetch.cancel?.();
    if (closing) { group.write.cancelled = true; group.write.cancel?.(); }
  }
  return {
    connected: () => !disposed && remote.connected(), requestImage, cancel, releaseImage,
    uploadImage(raw: string) {
      const group = leases.get(JSON.parse(raw).token);
      if (group?.raw === undefined) throw Error("Manga image lease expired");
      return remote.uploadImage(group.raw);
    },
    async persist(raw: string) {
      const group = leases.get(JSON.parse(raw).token);
      if (!group) throw Error("Manga image lease expired");
      const error = await group.persisted;
      if (error) throw error;
    },
    async block(pack: string) {
      blocked.add(pack);
      const pending = [...retained].filter(group => group.payload.startsWith(pack + "/"));
      for (const group of pending) invalidate(group);
      // Native writes can continue after a JS cancellation. Drain their
      // acknowledgements before allowing removal to enter the worker queue.
      await Promise.all(pending.map(async group => { await group.ready.catch(() => {}); await group.persisted; }));
    },
    unblock(pack: string) { blocked.delete(pack); },
    dispose() {
      disposed = true;
      for (const group of retained) invalidate(group, true);
      for (const [handle, group] of leases) { leases.delete(handle); group.leases.delete(handle); collect(group); }
    },
  };
}
