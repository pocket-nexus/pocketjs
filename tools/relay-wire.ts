/** Provider-side relay wiring over an authenticated byte channel.
 *
 * The composed endpoint (`framework/src/relay/endpoint.ts`) is shared with
 * the guest: one object runs the L1 session, the P3 credit/queue machines
 * and the L2 authority. This file binds a provider endpoint to a duplex
 * byte transport:
 *
 *   bytes in  -> RelayRecordDecoder (split/coalesced records, bounded)
 *             -> RelayEndpoint.handleRecord (session, window, L2, credit)
 *   bytes out -> endpoint transport.trySend -> channel.send
 *
 * Authentication and encryption belong to the L0 transport profile
 * (draft §3.2 step 1); `serveRelayTcp` therefore takes an `authenticate`
 * callback that returns the peer identity and grants. The wire layer never
 * trusts identity claims inside HELLO metadata.
 *
 * Each physical connection gets a fresh endpoint: reconnect and guest
 * realm reset establish a new session with no carried-over
 * seq/credit/stream state. */

import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { RELAY_LIMITS } from "../contracts/spec/relay.ts";
import { RelayRecordDecoder, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import {
  RelayEndpoint,
  type RelayEndpointHooks,
  type RelayEndpointOptions,
} from "../framework/src/relay/endpoint.ts";
import type {
  RelayLocalCapabilities,
  RelayNegotiation,
  RelayOpenRequest,
  RelayPeerContext,
  RelayPhase,
  RelaySendStatus,
  RelaySession,
} from "../framework/src/relay/session.ts";

export type {
  RelayLocalCapabilities,
  RelayNegotiation,
  RelayOpenRequest,
  RelayPeerContext,
  RelayPhase,
  RelaySendStatus,
  RelaySession,
} from "../framework/src/relay/session.ts";
export type { RelayDecodedFrame } from "../framework/src/relay/frame.ts";
export {
  RelayEndpoint,
  type RelayEndpointHooks,
  type RelayEndpointOptions,
  type RelayIncomingRequest,
} from "../framework/src/relay/endpoint.ts";

/** An authenticated ordered byte channel. `send` is an admission decision:
 * it returns false only when the frame was not taken, so the endpoint
 * keeps the frame at the head of its ordered outbox and retries later.
 * Returning false after the bytes already entered an underlying queue is
 * wrong — the frame would be delivered and a retry would put it on the wire
 * twice. A dead channel returns false (or throws). The adapter keeps the
 * underlying socket. `onDrain` fires when a busy channel can take frames
 * again; the endpoint flushes its outbox then. */
export interface RelayByteChannel {
  /** Write one whole reassembled record. Returns false when the transport
   * has no queue room right now ("busy") and the frame was not written. */
  send(bytes: Uint8Array): boolean;
  readonly peer: RelayPeerContext;
  onData(callback: (chunk: Uint8Array) => void): void;
  onClose(callback: (reason: string) => void): void;
  onDrain?(callback: () => void): void;
  destroy(): void;
  readonly closed: boolean;
}

/** The endpoint hooks (OPEN authorization, phases, resource requests,
 * cancel, evict, protocol errors) plus the record-level failure of the
 * channel itself. */
export interface RelayProviderHooks extends RelayEndpointHooks {
  /** A record failed frame-level validation or a peer fault was seen; on
   * a record failure the connection is dropped. */
  onProtocolError?: (code: string, detail?: string) => void;
}

export interface RelayProviderConnection {
  endpoint: RelayEndpoint;
  /** The endpoint's session machine. */
  session: RelaySession;
  peer: RelayPeerContext;
  close(): void;
}

/** What a byte channel drives: the composed endpoint, or a bare session
 * machine in tests. */
export interface RelayRecordSink {
  handleRecord(bytes: Uint8Array): void;
  handleDisconnect(reason: string): void;
  close(): void;
  /** Retry the ordered outbox once a busy channel drained. */
  flush?(): void;
}

/** Bind one provider endpoint to one authenticated channel. The caller
 * owns accepting the physical connection and authenticating the peer. The
 * endpoint runs the session, the P3 windows and the L2 authority; the
 * application answers resource.get through `hooks.onGet` and the
 * endpoint's reply methods. */
export function attachRelayProvider(options: {
  channel: RelayByteChannel;
  local: RelayLocalCapabilities;
  hooks?: RelayProviderHooks;
  /** Endpoint tuning: pump budgets, request reserve, timers, randomness. */
  endpoint?: Pick<RelayEndpointOptions,
    "privateOps" | "resourceForms" | "operations" | "framesPerPump" | "bytesPerPump" | "requestReserve" | "outboxFrames"
    | "scheduler" | "randomBytes" | "pingIntervalMs" | "stallMs" | "retryMs">;
}): RelayProviderConnection {
  const { channel, local, hooks } = options;
  const endpoint = new RelayEndpoint({
    ...options.endpoint,
    role: "provider",
    local,
    transport: {
      peer: channel.peer,
      trySend(bytes): RelaySendStatus {
        if (channel.closed) return "offline";
        return channel.send(bytes) ? "accepted" : "busy";
      },
    },
    hooks: {
      ...hooks,
      onPhase: (phase, detail) => {
        hooks?.onPhase?.(phase, detail);
        // Protocol teardown ends the physical connection: a new one starts
        // a new session.
        if (phase === "closed") channel.destroy();
      },
    },
  });
  bindChannel(endpoint, channel, local.rxLimits.maxWireBytes, (code) => hooks?.onProtocolError?.(code, "record"));
  return {
    endpoint,
    session: endpoint.session,
    peer: channel.peer,
    close() {
      endpoint.close();
      channel.destroy();
    },
  };
}

/** Records in, records out: one fixed reassembly buffer of the advertised
 * receiver bound (a forged length prefix cannot drive an allocation), every
 * complete record to the sink, a record failure drops the connection, and
 * a drained channel retries the sink's outbox. */
function bindChannel(
  sink: RelayRecordSink,
  channel: RelayByteChannel,
  maxWireBytes: number,
  onRecordError?: (code: string) => void,
): void {
  // Inbound frames never exceed our own advertised guarantee; min() during
  // negotiation can only shrink it. Size for at least the bootstrap bound.
  const decoder = new RelayRecordDecoder(Math.max(maxWireBytes, RELAY_LIMITS.bootstrapMaxWireBytes));
  channel.onData((chunk) => {
    const pushed = decoder.push(chunk);
    if (!pushed.ok) {
      onRecordError?.(pushed.code ?? "RECORD");
      sink.handleDisconnect(`record: ${pushed.code ?? "RECORD"}`);
      channel.destroy();
      return;
    }
    for (const record of pushed.frames) sink.handleRecord(record);
  });
  channel.onClose((reason) => sink.handleDisconnect(reason));
  channel.onDrain?.(() => sink.flush?.());
}

// --- guest-side channel binding (the companion is the listener) -------------

/** Bind an existing guest endpoint (or bare session) to a byte channel;
 * used by device-side hosts that dial the companion. `maxWireBytes` is the
 * receiver guarantee the guest advertised in HELLO — the reassembly buffer
 * is one fixed buffer of that size, so a forged length prefix can never
 * drive an allocation. */
export function attachRelayChannel(sink: RelayRecordSink, channel: RelayByteChannel, options: {
  maxWireBytes?: number;
} = {}): {
  close(): void;
} {
  bindChannel(sink, channel, options.maxWireBytes ?? RELAY_LIMITS.controlMaxWireBytes);
  return {
    close() {
      sink.close();
      channel.destroy();
    },
  };
}

// --- node:net channel and listener ------------------------------------------

/** Admission check for one frame on a node writable stream.
 *
 * `socket.write()` returning false is backpressure *after* the bytes have
 * entered the stream's queue: the frame will still be flushed, so it cannot
 * be reported as "not admitted" (the session rolls the seq back on busy and
 * a retry puts the same seq on the wire twice). A frame is admitted only
 * when the existing queue plus the frame stays under the high-water mark;
 * with a non-empty queue at the cap the frame is refused before it is
 * written. A frame that alone reaches the mark on an empty queue is still
 * written (the queue drains and later sends return busy until it does). */
export function socketCanAdmit(
  socket: Pick<Socket, "writableLength" | "writableHighWaterMark">,
  bytes: Uint8Array,
): boolean {
  const buffered = socket.writableLength;
  return buffered === 0 || buffered + bytes.length < socket.writableHighWaterMark;
}

/** Adapt a connected (and authenticated) TCP socket to RelayByteChannel. */
export function relaySocketChannel(socket: Socket, peer: RelayPeerContext): RelayByteChannel {
  let closed = socket.destroyed;
  socket.setNoDelay(true);
  const channel: RelayByteChannel = {
    peer,
    get closed() { return closed; },
    send(bytes) {
      if (closed || socket.destroyed || !socket.writable) return false;
      if (!socketCanAdmit(socket, bytes)) return false;
      // The frame is inside the stream's ordered queue now and will be
      // flushed; never relay write()'s post-queue false, which falsely
      // claims the frame was not admitted.
      socket.write(bytes);
      return true;
    },
    onData(callback) {
      socket.on("data", (chunk: Buffer) => callback(chunk));
    },
    onClose(callback) {
      socket.once("close", () => callback(closed ? "closed" : "peer closed"));
      socket.on("error", (error) => {
        closed = true;
        callback((error as NodeJS.ErrnoException).code ?? "socket error");
      });
    },
    onDrain(callback) {
      socket.on("drain", callback);
    },
    destroy() {
      closed = true;
      socket.destroy();
    },
  };
  socket.on("close", () => { closed = true; });
  return channel;
}

export interface RelayTcpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Listen for authenticated relay connections. `authenticate` runs before
 * any session state exists and returns the peer grants, or null to reject
 * the connection. Every accepted socket gets its own provider session. */
export function serveRelayTcp(options: {
  port?: number;
  host?: string;
  local: RelayLocalCapabilities;
  privateOps?: RelayEndpointOptions["privateOps"];
  resourceForms?: RelayEndpointOptions["resourceForms"];
  operations?: RelayEndpointOptions["operations"];
  authenticate: (socket: Socket) => RelayPeerContext | null | Promise<RelayPeerContext | null>;
  hooks?: RelayProviderHooks | ((peer: RelayPeerContext) => RelayProviderHooks);
  onConnection?: (connection: RelayProviderConnection) => void;
}): Promise<RelayTcpServer> {
  const server = createServer((socket) => {
    void (async () => {
      let peer: RelayPeerContext | null = null;
      try {
        peer = await options.authenticate(socket);
      } catch {
        peer = null;
      }
      if (!peer) { socket.destroy(); return; }
      const hooks = typeof options.hooks === "function" ? options.hooks(peer) : options.hooks;
      const channel = relaySocketChannel(socket, peer);
      const connection = attachRelayProvider({ channel, local: options.local, hooks,
        endpoint: { privateOps: options.privateOps, resourceForms: options.resourceForms,
          operations: options.operations } });
      options.onConnection?.(connection);
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("relay tcp listen failed"));
        return;
      }
      resolve({
        server,
        port: address.port,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

/** The negotiated parameters once a connection reaches READY. */
export async function relayReady(session: RelaySession): Promise<RelayNegotiation> {
  return session.whenReady();
}
