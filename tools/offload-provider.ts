/** Desktop transport. Capability implementations execute in a Worker owned by
 * each authenticated device connection, never inside the socket callbacks. */
import { OFFLOAD, type OffloadRequest, type OffloadReply } from "../contracts/spec/offload.ts";
import { encodeOffloadRecord } from "./offload-wire.ts";
import { connectCompanionSession } from "./companion-session.ts";

export function connectOffloadProvider(options: {
  address: string; key: string; worker: string | URL; data?: unknown;
  port?: number; log?: (message: string) => void;
}) {
  let worker: Worker | undefined;
  const pending = new Set<number>();
  const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
  const session = connectCompanionSession({
    ...options,
    connected() {
      worker = new Worker(options.worker, { type: "module" });
      const owner = worker;
      worker.postMessage({ init: options.data });
      worker.onerror = () => { if (worker === owner) { options.log?.("Capability worker failed; reconnecting"); session.disconnect(); } };
      worker.onmessage = (event: MessageEvent<OffloadReply>) => {
        if (worker !== owner) return;
        const reply = event.data;
        if ((reply as OffloadReply & { ready?: boolean }).ready === true) return;
        if (!pending.delete(reply.id)) { options.log?.("Unexpected capability reply; reconnecting"); return session.disconnect(); }
        clearTimeout(deadlines.get(reply.id)); deadlines.delete(reply.id);
        try {
          if (typeof reply.payload === "string" && reply.payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
          if (!session.send(JSON.stringify(reply))) session.disconnect();
        } catch { session.disconnect(); }
      };
      options.log?.("Transport connected; waiting for paired device requests");
    },
    record(raw) {
      const request = JSON.parse(raw) as OffloadRequest;
      if (request.v !== 1 || !Number.isSafeInteger(request.id) || request.id < 1 ||
          typeof request.method !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.method) ||
          typeof request.payload !== "string" || request.payload.length > OFFLOAD.payloadChars ||
          pending.size >= OFFLOAD.pending || pending.has(request.id)) throw new Error("Invalid request");
      pending.add(request.id);
      deadlines.set(request.id, setTimeout(() => { options.log?.("Capability deadline expired; reconnecting"); session.disconnect(); }, 9000));
      worker!.postMessage(request);
    },
    metrics: text => options.log?.(`Device ${text}`),
    disconnected(reason) {
      options.log?.(`Transport disconnected: ${reason}`);
      worker?.terminate(); worker = undefined;
      for (const timer of deadlines.values()) clearTimeout(timer);
      deadlines.clear(); pending.clear();
    },
  });
  return { close() { session.close(); } };
}

/** Worker-side allowlist. A missing method cannot open arbitrary resources. */
export async function dispatchOffload(
  methods: Readonly<Record<string, (payload: string) => string | Promise<string>>>,
  request: OffloadRequest,
): Promise<OffloadReply> {
  try {
    const handler = Object.prototype.hasOwnProperty.call(methods, request.method) ? methods[request.method] : undefined;
    if (!handler) throw new Error("Capability not granted");
    const payload = await handler(request.payload);
    if (payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
    const reply = { id: request.id, payload };
    encodeOffloadRecord(JSON.stringify(reply));
    return reply;
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message.slice(0, 160) : "Provider failed" };
  }
}
