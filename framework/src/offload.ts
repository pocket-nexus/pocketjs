import {
  OFFLOAD,
  type OffloadOps,
  type OffloadReply,
  type OffloadImageTicket,
} from "../../contracts/spec/offload.ts";
import { registerServicePump } from "./services.ts";

export { OFFLOAD };
export type { OffloadOps };
export { uploadIndexedImage, type IndexedImage } from "./indexed-image.ts";
/** Fixed-budget native resource upload when implemented by the host.
 * Optional column colors use one hex palette index per pixel column and
 * up to 16 concatenated RGB hex colors. They retain the one-upload budget. */
export function uploadCoverage(
  base64: string,
  width: number,
  height: number,
  foreground: number,
  colors?: { columns: string; palette: string },
): number | undefined {
  return (globalThis as unknown as { offload?: OffloadOps }).offload?.uploadCoverage?.(
    base64,
    width,
    height,
    foreground,
    colors?.columns,
    colors?.palette,
  );
}
export type OffloadResult = { ok: true; value: string } | { ok: false; error: string };
type Callback = (result: OffloadResult) => void;
type Pending = {
  record: string;
  callback: Callback | undefined;
  deadline: number;
  sent: boolean;
  session: number;
  response?: "image";
};

function imageTicket(value: unknown): value is OffloadImageTicket {
  const v = value as OffloadImageTicket | undefined;
  const side = (n: number) => Number.isInteger(n) && n >= 16 && n <= 256 && (n & (n - 1)) === 0;
  return (
    !!v && Number.isSafeInteger(v.token) && v.token > 0 && v.token <= 0xffffffff && side(v.width) && side(v.height)
  );
}

/** One client per JS realm. Inputs are already serialized bounded strings:
 * arbitrary object traversal/serialization is never hidden inside this API. */
export function createOffloadClient(ops: OffloadOps) {
  const pending = new Map<number, Pending>();
  let nextId = 1,
    frame = 0,
    disposed = false;
  const finish = (id: number, result: OffloadResult) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    try { item.callback?.(result); }
    catch (error) {
      // A callback that throws has not retained a usable response owner.
      // Returning staging is safe even if it uploaded the value first.
      if (result.ok && item.response) {
        const ticket: unknown = JSON.parse(result.value);
        if (item.response === "image" && imageTicket(ticket)) ops.releaseImage?.(ticket.token);
      }
      throw error;
    }
  };
  function request(method: string, payload: string, callback: Callback, response?: "image"): number {
    if (disposed || pending.size >= OFFLOAD.pending) return 0;
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(method)) throw new Error("Invalid offload capability");
    if (typeof payload !== "string" || payload.length > OFFLOAD.payloadChars)
      throw new Error("Offload payload exceeds budget");
    if (nextId > 0xffffffff) throw new Error("Offload request ID exhausted; restart the realm");
    const id = nextId++;
    const record = JSON.stringify({ v: 1, id, method, payload, ...(response ? { response } : {}) });
    // Conservative UTF-8 bound, refined without allocating a byte buffer.
    let bytes = 0;
    for (let i = 0; i < record.length; i++) {
      const c = record.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < record.length) {
        bytes += 4;
        i++;
      } else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
    }
    if (bytes > OFFLOAD.recordBytes) throw new Error("Offload record exceeds budget");
    pending.set(id, { record, callback, deadline: frame + OFFLOAD.timeoutFrames, sent: false, session: 0, response });
    return id;
  }
  return {
    connected: () => !disposed && ops.session() > 0,
    session: () => (disposed ? 0 : ops.session()),
    /** Transport reservations, including cancelled/timed-out sent requests.
     * Those retain credit until a reply arrives or their session ends. */
    pending: () => pending.size,
    request,
    requestImage(method: string, payload: string, callback: Callback): number {
      if (!ops.uploadImage || !ops.releaseImage) throw new Error("Host does not implement offload images");
      return request(method, payload, callback, "image");
    },
    /** The resource scheduler owns this small serialized ticket after delivery. */
    uploadImage(raw: string) {
      const ticket: unknown = JSON.parse(raw);
      if (!imageTicket(ticket)) throw new Error("Invalid offload image ticket");
      const handle = ops.uploadImage?.(ticket.token) ?? -1;
      if (handle < 0) throw new Error("Image staging or frame upload credit unavailable");
      return { handle, width: ticket.width, height: ticket.height };
    },
    releaseImage(raw: string) {
      const ticket: unknown = JSON.parse(raw);
      if (imageTicket(ticket)) ops.releaseImage?.(ticket.token);
    },
    cancel(id: number) {
      const item = pending.get(id);
      if (!item) return;
      // Withdrawing UI interest does not cancel bytes or work already sent.
      // Free the callback/owner, retaining the bounded transport reservation.
      if (item.sent) item.callback = undefined;
      else pending.delete(id);
    },
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
          const image = imageTicket(reply.image) ? reply.image : undefined;
          const valid = item?.sent && item.session === session && session > 0;
          const expected = !!valid && !!item.callback;
          if (image && (!expected || item?.response !== "image")) ops.releaseImage?.(image.token);
          if (valid) {
            delivered = !!item.callback;
            const ticket = item.response === "image" ? image : undefined;
            finish(
              reply.id,
              ticket
                ? { ok: true, value: JSON.stringify(ticket) }
                : !item.response &&
                    !image &&
                    typeof reply.payload === "string" &&
                    reply.payload.length <= OFFLOAD.payloadChars
                  ? { ok: true, value: reply.payload }
                  : {
                      ok: false,
                      error: typeof reply.error === "string" ? reply.error.slice(0, 160) : "Malformed reply",
                    },
            );
          }
        } catch {
          /* A malformed bounded record cannot stop the UI. */
        }
      }
      let submitted = 0;
      for (const [id, item] of pending) {
        if (item.sent && item.session !== session && (!delivered || !item.callback)) {
          delivered = delivered || !!item.callback;
          finish(id, { ok: false, error: "Connection lost; outcome may be unknown" });
        } else if (!delivered && frame >= item.deadline && item.callback) {
          delivered = true;
          if (item.sent) {
            const callback = item.callback;
            item.callback = undefined;
            callback({ ok: false, error: "Request expired; outcome may be unknown" });
          } else finish(id, { ok: false, error: "Provider unavailable" });
        } else if (!item.sent && session > 0 && submitted < OFFLOAD.submissionsPerFrame && ops.submit(item.record)) {
          item.sent = true;
          item.session = session;
          submitted++;
        }
      }
    },
    dispose() {
      disposed = true;
      pending.clear();
    },
  };
}

let client: ReturnType<typeof createOffloadClient> | undefined;
let localClient: ReturnType<typeof createOffloadClient> | undefined;
/** No synchronous FS, DB, DNS or socket operation is exposed to the guest. */
export function offload(provider: "companion" | "local" = "companion") {
  if (provider === "local" && localClient) return localClient;
  if (provider === "companion" && client) return client;
  const root = (globalThis as unknown as { offload?: OffloadOps }).offload;
  const ops = provider === "local" ? root?.local : root;
  if (!ops) throw new Error("Host does not implement io.offload");
  const next = createOffloadClient(ops);
  if (provider === "local") localClient = next; else client = next;
  registerServicePump(() => next.step());
  return next;
}
