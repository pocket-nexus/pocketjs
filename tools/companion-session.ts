/** Paired desktop endpoint for the 3DS bounded worker mailbox.
 * The record transport is shared by request/reply offload and stateful rooms.
 * It owns reconnection; applications own replay, identity and session recovery.
 */
import { connect } from "node:net";
import { OFFLOAD } from "../contracts/spec/offload.ts";
import { OffloadDecoder, encodeOffloadRecord } from "./offload-wire.ts";

export interface CompanionSession {
  /** False means no transport credit. No hidden retry or unbounded queue. */
  send(record: string): boolean;
  /** Writes one already framed record (JSON or a binary image frame) to
   * the current connection. The frame is accepted once connected; false means
   * wait for `drained` before writing the next frame. A disconnected session
   * returns false without accepting a frame and discards its pending replies. */
  write(frame: Uint8Array): boolean;
  /** Re-runs the `admit` gate: held device records are delivered while credit
   * lasts, then the socket resumes or stays paused. */
  resume(): void;
  /** Kernel-buffered bytes of the current connection (diagnostics only). */
  readonly writableLength: number;
  /** `reason` replaces the socket's own reason in `disconnected`. */
  disconnect(reason?: string): void;
  close(): void;
}
export function connectCompanionSession(options: {
  address: string; key: string; port?: number;
  connected?: () => void;
  record: (record: string) => void;
  /** A returned promise defers the next connection attempt until it settles,
   * so an executor torn down here cannot leak late replies into the next session. */
  disconnected?: (reason: string) => void | Promise<unknown>;
  metrics?: (metrics: string) => void;
  /** Read credit, checked before resuming and after each delivered record.
   * While false the socket is paused and the unconsumed suffix of the last
   * chunk is held until resume(). Absent: every record is delivered at once. */
  admit?: () => boolean;
  /** The kernel buffer emptied after write() returned false. */
  drained?: () => void;
  retryMs?: number;
  /** A connection attempt that takes longer is abandoned and retried. */
  connectTimeoutMs?: number;
}): CompanionSession {
  if (!/^[0-9a-f]{64}$/.test(options.key)) throw new Error("Expected a 256-bit pairing key");
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let current: ReturnType<typeof connect> | undefined;
  let fail = (_reason?: string) => {};
  let read = () => {};
  const api: CompanionSession = {
    send(record) {
      if (!current || current.connecting || current.destroyed || current.writableLength >= OFFLOAD.recordBytes * OFFLOAD.pending) return false;
      current.write(encodeOffloadRecord(record));
      return true;
    },
    write(frame) {
      if (!current || current.connecting || current.destroyed) return false;
      return current.write(frame);
    },
    resume() { read(); },
    get writableLength() { return current?.writableLength ?? 0; },
    disconnect(reason) { fail(reason); },
    close() { stopped = true; clearTimeout(retry); fail(); },
  };
  const attach = () => {
    if (stopped) return;
    const socket = connect({ host: options.address, port: options.port ?? OFFLOAD.port });
    current = socket;
    let reason = "peer closed";
    let held: Buffer | undefined, consumed = 0;
    const decoder = new OffloadDecoder();
    const admit = options.admit ?? (() => true);
    const deliver = (raw: string) => {
      if (raw.startsWith('{"v":1,"id":0,"method":"offload.metrics"')) {
        const r = JSON.parse(raw);
        if (typeof r.payload !== "string" || r.payload.length > 160) throw new Error("Invalid metrics");
        options.metrics?.(r.payload);
      } else options.record(raw);
    };
    fail = why => { if (why) reason = why; socket.destroy(); };
    read = () => {
      if (socket.destroyed) return;
      try {
        if (held && admit()) {
          consumed += decoder.push(held.subarray(consumed), deliver, admit);
          if (consumed === held.length) { held = undefined; consumed = 0; }
        }
        if (!held && admit()) socket.resume(); else socket.pause();
      } catch { reason = "invalid record or callback"; socket.destroy(); }
    };
    const connecting = options.connectTimeoutMs === undefined ? undefined
      : setTimeout(() => { reason = "connect timeout"; socket.destroy(); }, options.connectTimeoutMs);
    socket.setNoDelay(true);
    socket.setTimeout(15000, () => { reason = "idle timeout"; socket.destroy(); });
    socket.on("connect", () => {
      clearTimeout(connecting);
      socket.write(options.key);
      // TCP connection is not an authentication receipt. The device's first
      // application record establishes its protocol session after key checking.
      try { options.connected?.(); } catch { reason = "invalid record or callback"; socket.destroy(); }
    });
    socket.on("data", chunk => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (!options.admit) {
        try { decoder.push(bytes, deliver); } catch { reason = "invalid record or callback"; socket.destroy(); }
        return;
      }
      // One chunk is held at a time; the socket stays paused until every
      // record in it has been admitted.
      socket.pause();
      if (held) { reason = "input credit exceeded"; socket.destroy(); return; }
      held = bytes; consumed = 0; read();
    });
    socket.on("drain", () => options.drained?.());
    socket.on("error", error => { reason = (error as NodeJS.ErrnoException).code ?? "socket error"; });
    socket.on("close", () => {
      clearTimeout(connecting);
      if (current === socket) current = undefined;
      held = undefined; fail = () => {}; read = () => {};
      let teardown: void | Promise<unknown> = undefined;
      try { teardown = options.disconnected?.(reason); } catch { /* an application failure does not stop reconnection */ }
      const schedule = () => { if (!stopped) retry = setTimeout(attach, options.retryMs ?? 1500); };
      Promise.resolve(teardown).then(schedule, schedule);
    });
  };
  attach();
  return api;
}
