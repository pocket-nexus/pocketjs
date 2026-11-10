// Pocket Link 2 carriers (docs/POCKET-LINK.md §2.0): a carrier hands the
// link one reliable, ordered, two-way byte stream and the largest frame
// payload its side accepts on it. TCP is the carrier of phase one; the pipe
// below joins two endpoints in one process, for tests and for a host that
// embeds both sides.

import type { Socket } from "node:net";
import { LINK2_TCP_PAYLOAD } from "../../../contracts/spec/link2.ts";

export interface Carrier {
  /** What this side offers as `maxPayload` on this carrier (§4.4). */
  readonly maxPayload: number;
  /** This side's and the peer's address, for the carriers that have one. */
  readonly localAddress: string;
  readonly remoteAddress: string;
  /** Queues bytes in order. `written` runs once the carrier has taken them
   *  (the socket's write callback): the one-chunk rule of §8.1 waits for it. */
  write(bytes: Uint8Array, written?: () => void): void;
  /** Bytes as they arrive, in order. Set before any are expected. */
  onData: (bytes: Uint8Array) => void;
  /** The stream ended, by either side or by an error. Called once. */
  onClose: () => void;
  /** Flushes what was written, then closes. */
  close(): void;
}

const v4 = (address: string | undefined) => (address ?? "").replace(/^::ffff:/, "");

/** One TCP connection as a carrier. */
export function tcpCarrier(socket: Socket, maxPayload: number = LINK2_TCP_PAYLOAD): Carrier {
  let closed = false;
  const carrier: Carrier = {
    maxPayload,
    localAddress: v4(socket.localAddress),
    remoteAddress: v4(socket.remoteAddress),
    write(bytes, written) {
      if (closed || socket.destroyed) return;
      socket.write(bytes, () => written?.());
    },
    onData: () => {},
    onClose: () => {},
    close() {
      if (!socket.destroyed) socket.end();
    },
  };
  socket.setNoDelay(true);
  socket.on("data", (chunk: Buffer) => carrier.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  const end = () => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) socket.destroy();
    carrier.onClose();
  };
  socket.on("close", end);
  socket.on("error", end);
  socket.on("end", end);
  return carrier;
}

/** Two carriers joined in memory: what one writes the other reads, in order,
 *  on a later turn of the event loop. Each end offers its own `maxPayload`,
 *  which stands in for a slow carrier (a UART offering 1 KiB) in tests. */
export function pipeCarriers(a: { maxPayload?: number; address?: string } = {}, b: { maxPayload?: number; address?: string } = {}): [Carrier, Carrier] {
  let open = true;
  const make = (own: typeof a, other: typeof a): Carrier => ({
    maxPayload: own.maxPayload ?? LINK2_TCP_PAYLOAD,
    localAddress: own.address ?? "",
    remoteAddress: other.address ?? "",
    write() {},
    onData: () => {},
    onClose: () => {},
    close() {},
  });
  const left = make(a, b);
  const right = make(b, a);
  const join = (from: Carrier, to: Carrier) => {
    from.write = (bytes, written) => {
      if (!open) return;
      const copy = bytes.slice();
      setImmediate(() => {
        if (!open) return;
        written?.();
        to.onData(copy);
      });
    };
    from.close = () => {
      if (!open) return;
      setImmediate(() => {
        if (!open) return;
        open = false;
        from.onClose();
        to.onClose();
      });
    };
  };
  join(left, right);
  join(right, left);
  return [left, right];
}
