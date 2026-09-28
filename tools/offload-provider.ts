/** Desktop transport. Capability implementations execute in a Worker or an
 * isolated process owned by each authenticated device connection, never
 * inside the socket callbacks. */
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { OFFLOAD, type OffloadRequest, type OffloadProviderReply, type OffloadImage } from "../contracts/spec/offload.ts";
import { encodeOffloadRecord, encodeOffloadImage } from "./offload-wire.ts";
import { connectCompanionSession } from "./companion-session.ts";
export type { OffloadImage } from "../contracts/spec/offload.ts";

/** One capability executor per connection: a Worker thread or a Bun subprocess. */
interface Executor { postMessage(value: unknown): void; terminate(): void | Promise<unknown> }

export function connectOffloadProvider(options: {
  address: string; key: string; worker: string | URL; data?: unknown;
  port?: number; log?: (message: string) => void;
  /** Opt-in request timing and socket backpressure diagnostics; no payloads. */
  trace?: boolean;
  /** Process mode isolates native codecs and fetch teardown from the transport.
   * Both modes use the same self.onmessage/postMessage provider module API. */
  isolation?: "thread" | "process";
}) {
  let stopped = false, generation = 0, lastConnectFailure = "";
  let worker: Executor | undefined;
  let log = (message: string) => options.log?.(message);
  const pending = new Map<number, { response?: "image"; method: string; started: number }>();
  const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
  const replies: Buffer[] = [];
  let writing = false, blockedAt = 0;
  // Sending an image and computing the next resource can overlap. The same
  // eight credits cover active work, queued replies and the blocked write.
  const canRead = () => pending.size + replies.length + Number(writing) < OFFLOAD.pending;
  const fail = (why: string) => session.disconnect(why);
  function flush() {
    while (!writing && replies.length) {
      writing = !session.write(replies.shift()!);
      if (writing) { blockedAt = Date.now(); if (options.trace) log(`write blocked bytes=${session.writableLength} queued=${replies.length}`); }
    }
    session.resume();
  }
  const replyToDevice = (owner: Executor, reply: OffloadProviderReply & { ready?: boolean }) => {
    if (worker !== owner || stopped) return;
    if (reply?.ready === true) return;
    if (!reply || !Number.isSafeInteger(reply.id) || reply.id < 1 || reply.id > 0xffffffff) return fail("invalid provider reply ID");
    const request = pending.get(reply.id);
    if (!request) return fail("unexpected provider reply ID");
    pending.delete(reply.id);
    clearTimeout(deadlines.get(reply.id)); deadlines.delete(reply.id);
    try {
      if (typeof reply.payload === "string" && reply.payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
      if (reply.image && request.response !== "image") throw new Error("Unrequested image response");
      const record = reply.image ? encodeOffloadImage(reply.id, reply.image) : encodeOffloadRecord(JSON.stringify(reply));
      if (options.trace) log(`reply id=${reply.id} method=${request.method} providerMs=${Date.now() - request.started} bytes=${record.length} error=${!!reply.error} pending=${pending.size} queued=${replies.length}`);
      // Each queued reply replaces one admitted request. Slow LAN writes
      // consume credit; they are not an invalid connection.
      if (replies.length >= OFFLOAD.pending) return fail("provider reply credit exceeded");
      replies.push(record); flush();
    } catch { fail("invalid provider response"); }
  };
  function start(): Executor {
    if (options.isolation === "process") {
      const entry = options.worker instanceof URL ? options.worker.href : options.worker.startsWith("file:") ? options.worker : pathToFileURL(resolve(options.worker)).href;
      let child: ReturnType<typeof Bun.spawn>;
      const executor: Executor = {
        postMessage: value => child.send(value),
        terminate() {
          if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
          return child.exited;
        },
      };
      child = Bun.spawn([process.execPath, fileURLToPath(new URL("./offload-process.ts", import.meta.url)), entry], {
        stdin: "ignore", stdout: "inherit", stderr: "inherit", serialization: "advanced",
        ipc: reply => replyToDevice(executor, reply),
        onExit(_child, code, signal) { if (worker === executor) fail(`provider process exited (code=${code}, signal=${signal ?? "none"})`); },
      });
      log(`provider process pid=${child.pid}`);
      return executor;
    }
    const thread = new Worker(options.worker, { type: "module" });
    const executor: Executor = { postMessage: value => thread.postMessage(value), terminate: () => thread.terminate() };
    thread.onerror = () => { if (worker === executor) fail("provider worker error"); };
    thread.onmessage = event => replyToDevice(executor, event.data);
    return executor;
  }
  const session = connectCompanionSession({
    address: options.address, key: options.key, port: options.port,
    connectTimeoutMs: 5000,
    admit: canRead,
    connected() {
      const n = ++generation;
      log = message => options.log?.(`Session ${n}: ${message}`);
      lastConnectFailure = "";
      try {
        worker = start();
        worker.postMessage({ init: options.data });
        log("transport connected; waiting for paired device requests");
      } catch { fail("provider executor could not start"); }
    },
    record(raw) {
      const request = JSON.parse(raw) as OffloadRequest;
      if (request.v !== 1 || !Number.isSafeInteger(request.id) || request.id < 1 || request.id > 0xffffffff ||
          typeof request.method !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.method) ||
          typeof request.payload !== "string" || request.payload.length > OFFLOAD.payloadChars ||
          request.response !== undefined && request.response !== "image" ||
          pending.size >= OFFLOAD.pending || pending.has(request.id)) throw new Error("Invalid request");
      pending.set(request.id, { response: request.response, method: request.method, started: Date.now() });
      if (options.trace) log(`request id=${request.id} method=${request.method} pending=${pending.size}`);
      // Terminate a wedged provider. Sent mutations are never retried.
      deadlines.set(request.id, setTimeout(() => fail(`request deadline: ${request.method} id=${request.id}`), 9000));
      worker!.postMessage(request);
    },
    metrics: text => options.log?.(`Device ${text}`),
    drained() {
      if (options.trace && writing) log(`write drained waitMs=${Date.now() - blockedAt} queued=${replies.length}`);
      writing = false; flush();
    },
    disconnected(reason) {
      for (const timer of deadlines.values()) clearTimeout(timer);
      if (worker) log(`disconnected: ${reason}; pending=${pending.size}`);
      else if (!stopped && reason !== lastConnectFailure) { log(`waiting for device: ${reason}`); lastConnectFailure = reason; }
      replies.length = 0; pending.clear(); deadlines.clear(); writing = false;
      // Reap the old executor before the next connection; its late replies
      // cannot enter a replacement session, including after request IDs restart.
      const old = worker; worker = undefined;
      return old?.terminate();
    },
  });
  return { close() { stopped = true; session.close(); } };
}

/** Worker-side allowlist. A missing method cannot open arbitrary resources. */
export async function dispatchOffload(
  methods: Readonly<Record<string, (payload: string) => string | OffloadImage | Promise<string | OffloadImage>>>,
  request: OffloadRequest,
): Promise<OffloadProviderReply> {
  try {
    const handler = Object.prototype.hasOwnProperty.call(methods, request.method) ? methods[request.method] : undefined;
    if (!handler) throw new Error("Capability not granted");
    const payload = await handler(request.payload);
    if (typeof payload !== "string") {
      if (request.response !== "image") throw new Error("Image response was not requested");
      encodeOffloadImage(request.id, payload);
      return { id: request.id, image: payload };
    }
    if (payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
    const reply = { id: request.id, payload };
    encodeOffloadRecord(JSON.stringify(reply));
    return reply;
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message.slice(0, 160) : "Provider failed" };
  }
}

export { connectOffloadUsbProvider } from "./offload-usb-provider.ts";
