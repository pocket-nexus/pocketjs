// Reference CONSOLE side of Pocket Link (contracts/spec/link.ts) in TS: the
// handshake in both modes, ping, net / catalog / install requests, the agent
// channel's raw messages and streams (contracts/spec/agent.ts), and a beacon
// listener. The tests drive the companion through it; a desktop or sim host
// can use it as its link.

import { createSocket } from "node:dgram";
import { connect as tcpConnect, type Socket } from "node:net";
import {
  LINK_BEACON_PORT,
  LINK_CONNECT_TIMEOUT_MS,
  LINK_HANDSHAKE_TIMEOUT_MS,
  LINK_MAX_DATA,
  LINK_PING_MS,
  LINK_VERSION,
  type LinkCatalogApp,
} from "../../contracts/spec/link.ts";
import {
  KEY_RE,
  LinkFrameDecoder,
  companionProof,
  consoleProof,
  decodeBeacon,
  encodeCtrl,
  encodeData,
  encodePing,
  encodePreamble,
  maskKey,
  newNonce,
  parsePairUri,
  proofEquals,
  type LinkBeacon,
  type LinkCtrl,
  type LinkFrame,
} from "./protocol.ts";
import { fnv1a64Hex, storedFooterHex } from "./catalog.ts";

export interface ConsoleDevice {
  id: string;
  name: string;
  model: string;
  target: string;
}

export class LinkRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export class LinkNetError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export interface ConsoleNetRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  body?: Uint8Array;
  app?: string;
}

export interface ConsoleNetResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface Stream {
  expected: number;
  received: number;
  chunks: Uint8Array[];
  done: (bytes: Uint8Array) => void;
  progress?: (received: number, total: number) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onCtrl: (message: LinkCtrl) => void;
}

export interface ConnectOptions {
  host: string;
  port: number;
  device: ConsoleDevice;
  companion: string;
  /** "connect": the 64-hex link key. "pair": the 32-hex pairing secret. */
  secret: string;
  mode?: "connect" | "pair";
  /** Ping every LINK_PING_MS (default true). */
  ping?: boolean;
  /** Test seam: override the hello's protocol version. */
  version?: number;
}

export class LinkConsoleClient {
  companionName = "";
  features: string[] = [];
  /** The unmasked link key after a pair-mode handshake. */
  key = "";
  private decoder = new LinkFrameDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private streams = new Map<number, Stream>();
  private listeners = new Set<(message: LinkCtrl) => void>();
  private dataListeners = new Set<(stream: number, bytes: Uint8Array) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private closedReason: string | undefined;

  private constructor(readonly socket: Socket) {}

  /** Open TCP, run the handshake, resolve once `ready`/`paired` arrives. */
  static async open(options: ConnectOptions): Promise<LinkConsoleClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = tcpConnect({ host: options.host, port: options.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`connect timeout to ${options.host}:${options.port}`));
      }, LINK_CONNECT_TIMEOUT_MS);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.setNoDelay(true);
    const client = new LinkConsoleClient(socket);
    await client.handshake(options);
    if (options.ping !== false) client.pingTimer = setInterval(() => client.socket.write(encodePing()), LINK_PING_MS);
    return client;
  }

  static connect(options: Omit<ConnectOptions, "mode" | "secret"> & { key: string }) {
    return LinkConsoleClient.open({ ...options, mode: "connect", secret: options.key });
  }

  /** Pair from a scanned URI: tries each host in order. */
  static async pair(uri: string, device: ConsoleDevice, options: { ping?: boolean } = {}): Promise<LinkConsoleClient> {
    const parsed = parsePairUri(uri);
    if (!parsed) throw new Error("not a Pocket Link pairing URI");
    let last: Error = new Error("no hosts");
    for (const host of parsed.hosts) {
      try {
        return await LinkConsoleClient.open({ host, port: parsed.port, device, companion: parsed.companion, secret: parsed.secret, mode: "pair", ...options });
      } catch (error) {
        if (error instanceof LinkRefused) throw error;
        last = error as Error;
      }
    }
    throw last;
  }

  private handshake(options: ConnectOptions): Promise<void> {
    const mode = options.mode ?? "connect";
    const nD = newNonce();
    const inputs = { nD, nC: "", device: options.device.id, companion: options.companion };
    return new Promise<void>((resolve, reject) => {
      let stage: "challenge" | "result" = "challenge";
      let settled = false;
      const timer = setTimeout(() => fail(new Error("handshake timeout")), LINK_HANDSHAKE_TIMEOUT_MS);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.destroy();
        reject(error);
      };
      const onFrames = (frames: LinkFrame[]) => {
        for (const frame of frames) {
          if (frame.type !== "ctrl") continue;
          const m = frame.message;
          if (m.t === "refused") return fail(new LinkRefused(String(m.code), String(m.message ?? "")));
          if (stage === "challenge") {
            if (m.t !== "challenge" || typeof m.nonce !== "string") return fail(new Error(`expected challenge, got ${m.t}`));
            inputs.nC = m.nonce;
            // The console checks the companion first, so a companion without the secret learns nothing.
            if (!proofEquals(m.proof, companionProof(options.secret, inputs))) return fail(new Error("companion proof did not verify"));
            this.socket.write(encodeCtrl({ t: "auth", proof: consoleProof(options.secret, inputs) }));
            stage = "result";
          } else if (m.t === "ready" || m.t === "paired") {
            if (m.t === "paired" !== (mode === "pair")) return fail(new Error(`unexpected ${m.t}`));
            this.companionName = String(m.name ?? "");
            this.features = Array.isArray(m.features) ? m.features.map(String) : [];
            if (m.t === "paired") {
              if (typeof m.key !== "string" || !KEY_RE.test(m.key)) return fail(new Error("paired without a key"));
              this.key = maskKey(m.key, options.secret, nD, inputs.nC);
            } else this.key = options.secret;
            settled = true;
            clearTimeout(timer);
            this.socket.off("data", onData);
            this.socket.on("data", (chunk) => this.receive(chunk as Buffer));
            const rest = frames.slice(frames.indexOf(frame) + 1);
            for (const later of rest) this.dispatch(later);
            return resolve();
          } else return fail(new Error(`unexpected ${m.t}`));
        }
      };
      const onData = (chunk: Buffer) => {
        try {
          onFrames(this.decoder.push(new Uint8Array(chunk)));
        } catch (error) {
          fail(error as Error);
        }
      };
      this.socket.on("data", onData);
      this.socket.on("close", () => {
        fail(new Error("connection closed during the handshake"));
        this.closedNow("closed by companion");
      });
      this.socket.on("error", () => {});
      this.socket.write(encodePreamble(options.version ?? LINK_VERSION));
      this.socket.write(
        encodeCtrl({
          t: "hello",
          v: options.version ?? LINK_VERSION,
          mode,
          device: options.device.id,
          companion: options.companion,
          nonce: nD,
          name: options.device.name,
          model: options.device.model,
          target: options.device.target,
        }),
      );
    });
  }

  private receive(chunk: Buffer) {
    let frames: LinkFrame[];
    try {
      frames = this.decoder.push(new Uint8Array(chunk));
    } catch (error) {
      this.socket.destroy();
      this.closedNow((error as Error).message);
      return;
    }
    for (const frame of frames) this.dispatch(frame);
  }

  private dispatch(frame: LinkFrame) {
    if (frame.type === "data") {
      const stream = this.streams.get(frame.stream);
      if (!stream) {
        for (const listener of this.dataListeners) listener(frame.stream, frame.bytes);
        return;
      }
      stream.chunks.push(frame.bytes);
      stream.received += frame.bytes.length;
      stream.progress?.(stream.received, stream.expected);
      if (stream.received >= stream.expected) {
        this.streams.delete(frame.stream);
        stream.done(concat(stream.chunks, stream.received));
      }
      return;
    }
    if (frame.type !== "ctrl") return;
    const m = frame.message;
    for (const listener of this.listeners) listener(m);
    if (typeof m.id === "number") this.pending.get(m.id)?.onCtrl(m);
  }

  private closedNow(reason: string) {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    clearInterval(this.pingTimer);
    for (const pending of this.pending.values()) pending.reject(new Error(`link closed: ${reason}`));
    this.pending.clear();
    this.streams.clear();
    for (const listener of this.closeListeners) listener(reason);
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** Unsolicited ctrl messages (e.g. catalog.changed) and replies alike. */
  onMessage(listener: (message: LinkCtrl) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Data frames on streams this client did not open (agent.screen). */
  onData(listener: (stream: number, bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /** One ctrl message as is (the agent channel's messages). */
  sendCtrl(message: LinkCtrl) {
    this.socket.write(encodeCtrl(message));
  }

  /** A fresh console-side id for a request or a stream. */
  takeId(): number {
    return this.nextId++;
  }

  /** Bytes on stream `stream`, in LINK_MAX_DATA chunks. */
  sendStream(stream: number, bytes: Uint8Array) {
    for (let at = 0; at < bytes.length; at += LINK_MAX_DATA) this.socket.write(encodeData(stream, bytes.subarray(at, at + LINK_MAX_DATA)));
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason !== undefined) listener(this.closedReason);
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Raw bytes on the socket (tests). */
  writeRaw(bytes: Uint8Array) {
    this.socket.write(bytes);
  }

  close() {
    clearInterval(this.pingTimer);
    this.socket.end();
    this.closedNow("closed by console");
  }

  private request<T>(build: (id: number) => LinkCtrl, onCtrl: (message: LinkCtrl, id: number, settle: { resolve: (v: T) => void; reject: (e: Error) => void }) => void): { id: number; done: Promise<T> } {
    const id = this.nextId++;
    const done = new Promise<T>((resolve, reject) => {
      if (this.closedReason !== undefined) return reject(new Error(`link closed: ${this.closedReason}`));
      const settle = {
        resolve: (value: T) => {
          this.pending.delete(id);
          resolve(value);
        },
        reject: (error: Error) => {
          this.pending.delete(id);
          this.streams.delete(id);
          reject(error);
        },
      };
      this.pending.set(id, { resolve: settle.resolve as (v: unknown) => void, reject: settle.reject, onCtrl: (m) => onCtrl(m, id, settle) });
      this.socket.write(encodeCtrl(build(id)));
    });
    return { id, done };
  }

  net(request: ConsoleNetRequest): { id: number; done: Promise<ConsoleNetResponse> } {
    const body = request.body ?? new Uint8Array(0);
    const handle = this.request<ConsoleNetResponse>(
      (id) => ({
        t: "net",
        id,
        app: request.app ?? "dev.pocketjs.console-client",
        url: request.url,
        method: request.method ?? "GET",
        headers: request.headers ?? {},
        timeoutMs: request.timeoutMs ?? 30_000,
        maxBytes: request.maxBytes ?? 128 * 1024,
        bytes: body.length,
      }),
      (m, id, settle) => {
        if (m.t === "net.error") settle.reject(new LinkNetError(String(m.code), String(m.message ?? "")));
        else if (m.t === "net.head") {
          const head = { status: Number(m.status), url: String(m.url), headers: (m.headers ?? {}) as Record<string, string> };
          const bytes = Number(m.bytes);
          if (bytes === 0) settle.resolve({ ...head, body: new Uint8Array(0) });
          else this.streams.set(id, { expected: bytes, received: 0, chunks: [], done: (b) => settle.resolve({ ...head, body: b }) });
        }
      },
    );
    for (let at = 0; at < body.length; at += LINK_MAX_DATA) this.socket.write(encodeData(handle.id, body.subarray(at, at + LINK_MAX_DATA)));
    return handle;
  }

  cancelNet(id: number) {
    this.socket.write(encodeCtrl({ t: "net.cancel", id }));
    this.pending.get(id)?.reject(new LinkNetError("cancelled", "cancelled by console"));
  }

  catalog(): Promise<LinkCatalogApp[]> {
    return this.request<LinkCatalogApp[]>(
      (id) => ({ t: "catalog", id }),
      (m, _id, settle) => {
        if (m.t === "catalog") settle.resolve((m.apps ?? []) as LinkCatalogApp[]);
      },
    ).done;
  }

  /** Stream one app; verifies the footer hash against install.head.hash. */
  install(app: string, progress?: (received: number, total: number) => void): Promise<{ hash: string; bytes: Uint8Array }> {
    return this.request<{ hash: string; bytes: Uint8Array }>(
      (id) => ({ t: "install", id, app }),
      (m, id, settle) => {
        if (m.t === "install.error") settle.reject(new Error(String(m.message)));
        else if (m.t === "install.head") {
          const hash = String(m.hash);
          this.streams.set(id, {
            expected: Number(m.bytes),
            received: 0,
            chunks: [],
            progress,
            done: (bytes) => {
              if (bytes.length < 8 || storedFooterHex(bytes) !== hash || fnv1a64Hex(bytes.subarray(0, bytes.length - 8)) !== hash) {
                settle.reject(new Error("package footer hash does not match install.head.hash"));
              } else settle.resolve({ hash, bytes });
            },
          });
        }
      },
    ).done;
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

/** Listen for companion beacons; the callback gets the decoded beacon and the
 *  datagram's source address (the connect target). */
export function listenBeacons(
  onBeacon: (beacon: LinkBeacon, address: string) => void,
  port = LINK_BEACON_PORT,
): Promise<{ port: number; close: () => void }> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (message, remote) => {
    const beacon = decodeBeacon(new Uint8Array(message));
    if (beacon) onBeacon(beacon, remote.address);
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, () => resolve({ port: socket.address().port, close: () => socket.close() }));
  });
}
