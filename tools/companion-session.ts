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
  disconnect(): void;
  close(): void;
}
export function connectCompanionSession(options: {
  address: string; key: string; port?: number;
  connected?: () => void;
  record: (record: string) => void;
  disconnected?: (reason: string) => void;
  metrics?: (metrics: string) => void;
  retryMs?: number;
}): CompanionSession {
  if (!/^[0-9a-f]{64}$/.test(options.key)) throw new Error("Expected a 256-bit pairing key");
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let current: ReturnType<typeof connect> | undefined;
  const api: CompanionSession = {
    send(record) {
      if (!current || current.connecting || current.destroyed || current.writableLength >= OFFLOAD.recordBytes * OFFLOAD.pending) return false;
      current.write(encodeOffloadRecord(record));
      return true;
    },
    disconnect() { current?.destroy(); },
    close() { stopped = true; clearTimeout(retry); current?.destroy(); },
  };
  const attach = () => {
    if (stopped) return;
    const socket = connect({ host: options.address, port: options.port ?? OFFLOAD.port });
    current = socket;
    let reason = "peer closed";
    const decoder = new OffloadDecoder();
    socket.setNoDelay(true);
    socket.setTimeout(15000, () => { reason = "idle timeout"; socket.destroy(); });
    socket.on("connect", () => {
      socket.write(options.key);
      // TCP connection is not an authentication receipt. The device's first
      // application record establishes its protocol session after key checking.
      try { options.connected?.(); } catch { reason = "invalid record or callback"; socket.destroy(); }
    });
    socket.on("data", chunk => {
      try {
        decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, raw => {
          if (raw.startsWith('{"v":1,"id":0,"method":"offload.metrics"')) {
            const r = JSON.parse(raw);
            if (typeof r.payload !== "string" || r.payload.length > 160) throw new Error("Invalid metrics");
            options.metrics?.(r.payload);
          } else options.record(raw);
        });
      } catch { reason = "invalid record or callback"; socket.destroy(); }
    });
    socket.on("error", error => { reason = (error as NodeJS.ErrnoException).code ?? "socket error"; });
    socket.on("close", () => {
      current = undefined;
      try { options.disconnected?.(reason); } finally {
        if (!stopped) retry = setTimeout(attach, options.retryMs ?? 1500);
      }
    });
  };
  attach();
  return api;
}
