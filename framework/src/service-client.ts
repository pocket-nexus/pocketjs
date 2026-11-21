import { getOps } from "./host.ts";
import { offload } from "./offload.ts";
import { hasFeature, platform } from "./platform.ts";
import { registerServicePump } from "./services.ts";

/** JSON service protocol shared by mailbox, HTTP and companion providers. */
export interface ServiceMessage { t: string; id?: number; [key: string]: unknown }
export type ServiceTransport = "companion" | "usb" | "http" | "none";
export interface ServiceClient {
  transport(): ServiceTransport;
  send(message: ServiceMessage, deliver: (reply: ServiceMessage) => void): void;
  subscribe(deliver: (event: ServiceMessage) => void): () => void;
  image(file: string): number;
  openStream(file: string): boolean;
  dispose(): void;
}

/** Owns request deadlines, asynchronous jobs, reconnect and legacy event polls.
 * Namespace names a provider, never a device. The framework frame pump owns IO. */
export function createServiceClient(namespace: string, options: { httpBase?: string; timeoutFrames?: number } = {}): ServiceClient {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) throw new Error("Invalid service namespace");
  const client = () => offload(), listeners = new Set<(event: ServiceMessage) => void>();
  type Work = { message: ServiceMessage; deliver: (reply: ServiceMessage) => void; job: number; busy: boolean; deadline: number };
  const pending = new Map<number, Work>();
  let frame = 0, session = 0, nextId = -1, cursor = 0, eventsBusy = false, disposed = false;
  let mailbox = false, files = false;
  const emit = (message: ServiceMessage) => { for (const listener of listeners) listener(message); };
  const finish = (id: number, reply: ServiceMessage) => {
    const work = pending.get(id); if (!work) return;
    pending.delete(id); work.deliver({ ...reply, id: work.message.id });
  };
  const fail = (id: number, message: string) => finish(id, { t: "error", message });
  const transport = (): ServiceTransport => {
    if (disposed) return "none";
    if (hasFeature("io.offload")) return client().connected() ? "companion" : "none";
    if (!mailbox) mailbox = getOps().svcOpen?.(namespace) ?? false;
    if (mailbox) return "usb";
    return options.httpBase && typeof fetch === "function" && !getOps().svcOpen ? "http" : "none";
  };
  const route = (message: ServiceMessage) => {
    if (typeof message.id === "number" && pending.has(message.id)) finish(message.id, message);
    else emit(message);
  };
  const readReply = (id: number, raw: string, poll: boolean) => {
    if (!pending.has(id)) return;
    try {
      const reply = JSON.parse(raw), work = pending.get(id)!;
      if (!reply || typeof reply !== "object") throw new Error();
      if (poll) {
        if (reply.state === "done") finish(id, reply.value);
        else if (reply.state === "error") fail(id, String(reply.message));
        else if (reply.state !== "pending") throw new Error();
      } else if (Number.isInteger(reply.job) && reply.job > 0) work.job = reply.job;
      else if (typeof reply.t === "string") finish(id, reply);
      else throw new Error();
    } catch { fail(id, "Invalid service reply"); }
  };
  const openFiles = () => {
    if (mailbox) return true;
    if (!files) files = getOps().svcOpen?.(namespace) ?? false;
    return files;
  };
  const safeFile = (file: string) => typeof file === "string" && /^[\w./-]+$/.test(file) && !file.startsWith("/") && !file.split("/").includes("..");
  const pump = registerServicePump(() => {
    if (disposed) return;
    frame++;
    if (hasFeature("io.offload")) {
      const current = client().session();
      if (session && current !== session) {
        files = false;
        for (const id of [...pending.keys()]) fail(id, "offline");
        emit({ t: "offline" });
      }
      session = current;
      if (current && frame % 20 === 0) for (const [id, work] of pending) {
        if (!work.job || work.busy) continue;
        work.busy = true;
        const ticket = client().request(`${namespace}.poll`, JSON.stringify({ job: work.job }), result => {
          work.busy = false;
          if (result.ok) readReply(id, result.value, true); else fail(id, result.error);
        });
        if (!ticket) work.busy = false;
        break;
      }
    } else if (mailbox && frame % 5 === 0) {
      for (const line of (getOps().svcPoll?.() ?? "").split("\n")) {
        if (!line.trim()) continue;
        try { route(JSON.parse(line)); } catch { /* A malformed event cannot break the frame. */ }
      }
    } else if (options.httpBase && !eventsBusy && frame % 90 === 0 && transport() === "http") {
      eventsBusy = true;
      void fetch(`${options.httpBase}/events?since=${cursor}`).then(r => r.json()).then(data => {
        if (disposed) return;
        cursor = data.next;
        for (const event of data.events) if (event.id === undefined) emit(event);
      }).catch(() => {}).finally(() => { eventsBusy = false; });
    }
    for (const [id, work] of pending) if (frame >= work.deadline) fail(id, "Service operation timed out");
  });
  return {
    transport,
    subscribe(deliver) { listeners.add(deliver); return () => listeners.delete(deliver); },
    send(message, deliver) {
      const via = transport(), id = nextId--;
      if (via === "none") { deliver({ t: "error", id: message.id, message: "offline" }); return; }
      if (pending.size >= 16) { deliver({ t: "error", id: message.id, message: "Service busy" }); return; }
      const work: Work = { message, deliver, job: 0, busy: true, deadline: frame + (options.timeoutFrames ?? 3600) };
      pending.set(id, work);
      const raw = JSON.stringify({ ...(message.t === "hello" ? { device: { target: platform.target } } : {}), ...message, id });
      if (via === "companion") {
        const ticket = client().request(`${namespace}.command`, raw, result => {
          work.busy = false;
          if (result.ok) readReply(id, result.value, false); else fail(id, result.error);
        });
        if (!ticket) fail(id, "Service busy");
      } else if (via === "usb") {
        getOps().svcSend?.(raw);
      } else {
        void fetch(`${options.httpBase}/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: raw })
          .then(r => { if (!r.ok) throw new Error(); return r.json(); })
          .then(reply => finish(id, reply)).catch(() => fail(id, "Host unreachable"));
      }
    },
    image(file) { return safeFile(file) && openFiles() ? getOps().loadImgFile?.(file) ?? -1 : -1; },
    openStream(file) { return safeFile(file) && openFiles() ? getOps().videoOpen?.(file) ?? false : false; },
    dispose() {
      disposed = true; pump();
      for (const id of [...pending.keys()]) fail(id, "Service closed");
      listeners.clear();
    },
  };
}
