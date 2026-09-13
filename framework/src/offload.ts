import { OFFLOAD, type OffloadOps, type OffloadReply } from "../../contracts/spec/offload.ts";
import { registerServicePump } from "./services.ts";

export { OFFLOAD };
export type { OffloadOps };
export { uploadIndexedImage, type IndexedImage } from "./indexed-image.ts";
/** Fixed-budget native resource upload when implemented by the host.
 * Optional column colors use one hex palette index per pixel column and
 * up to 16 concatenated RGB hex colors. They retain the one-upload budget. */
export function uploadCoverage(base64: string, width: number, height: number, foreground: number,
  colors?: { columns: string; palette: string }): number | undefined {
  return (globalThis as unknown as { offload?: OffloadOps }).offload?.uploadCoverage?.(base64, width, height, foreground, colors?.columns, colors?.palette);
}
export type OffloadResult = { ok: true; value: string } | { ok: false; error: string };
type Pending = { record: string; callback: (result: OffloadResult) => void; deadline: number; sent: boolean; session: number };

/** One client per JS realm. Inputs are already serialized bounded strings:
 * arbitrary object traversal/serialization is never hidden inside this API. */
export function createOffloadClient(ops: OffloadOps) {
  const pending = new Map<number, Pending>();
  let nextId = 1, frame = 0, disposed = false;
  const finish = (id: number, result: OffloadResult) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    item.callback(result);
  };
  return {
    connected: () => !disposed && ops.session() > 0,
    session: () => disposed ? 0 : ops.session(),
    pending: () => pending.size,
    request(method: string, payload: string, callback: Pending["callback"]): number {
      if (disposed || pending.size >= OFFLOAD.pending) return 0;
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(method)) throw new Error("Invalid offload capability");
      if (typeof payload !== "string" || payload.length > OFFLOAD.payloadChars) throw new Error("Offload payload exceeds budget");
      const id = nextId++;
      const record = JSON.stringify({ v: 1, id, method, payload });
      // Conservative UTF-8 bound, refined without allocating a byte buffer.
      let bytes = 0;
      for (let i = 0; i < record.length; i++) {
        const c = record.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < record.length) { bytes += 4; i++; }
        else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
      }
      if (bytes > OFFLOAD.recordBytes) throw new Error("Offload record exceeds budget");
      pending.set(id, { record, callback, deadline: frame + OFFLOAD.timeoutFrames, sent: false, session: 0 });
      return id;
    },
    cancel(id: number) { pending.delete(id); },
    /** Called exactly once at the frame boundary by the realm service pump. */
    step() {
      if (disposed) return;
      frame++;
      const session = ops.session();
      let delivered = false;
      const raw = ops.take();
      if (raw && raw.length <= OFFLOAD.recordBytes) {
        try {
          const reply = JSON.parse(raw) as OffloadReply;
          const item = pending.get(reply.id);
          if (item?.sent && item.session === session && session > 0) {
            delivered = true;
            finish(reply.id, typeof reply.payload === "string" && reply.payload.length <= OFFLOAD.payloadChars
              ? { ok: true, value: reply.payload }
              : { ok: false, error: typeof reply.error === "string" ? reply.error.slice(0, 160) : "Malformed reply" });
          }
        } catch { /* A malformed bounded record cannot stop the UI. */ }
      }
      let submitted = 0;
      for (const [id, item] of pending) {
        if (!delivered && (frame >= item.deadline || (item.sent && item.session !== session))) {
          delivered = true;
          finish(id, { ok: false, error: item.sent ? "Connection lost or request expired; outcome may be unknown" : "Provider unavailable" });
        } else if (!item.sent && session > 0 && submitted < OFFLOAD.submissionsPerFrame && ops.submit(item.record)) {
          item.sent = true; item.session = session; submitted++;
        }
      }
    },
    dispose() { disposed = true; pending.clear(); },
  };
}

let client: ReturnType<typeof createOffloadClient> | undefined;
/** No synchronous FS, DB, DNS or socket operation is exposed to the guest. */
export function offload() {
  if (client) return client;
  const ops = (globalThis as unknown as { offload?: OffloadOps }).offload;
  if (!ops) throw new Error("Host does not implement io.offload");
  client = createOffloadClient(ops);
  registerServicePump(() => client!.step());
  return client;
}
