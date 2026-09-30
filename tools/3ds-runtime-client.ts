import { EventEmitter } from "node:events";
import { createSocket } from "node:dgram";
import { Socket } from "node:net";
import {
  POCKET_RUNTIME_ACK_BYTES,
  POCKET_RUNTIME_FRAME_HEADER_BYTES,
  POCKET_RUNTIME_MAX_CTRL_BYTES,
  POCKET_RUNTIME_MAX_FRAME_BYTES,
  POCKET_RUNTIME_MSG,
  POCKET_RUNTIME_NATIVE_FLAG_LAUNCH,
  POCKET_RUNTIME_WIRE_PORT,
  PocketRuntimeFrameDecoder,
  decodePocketRuntimeAck,
  decodePocketRuntimeDiscoveryReply,
  decodePocketRuntimeScreenshotBegin,
  encodePocketRuntimeDiscoveryRequest,
  encodePocketRuntimeFrame,
  encodePocketRuntimeHello,
  encodePocketRuntimeLaunch,
  encodePocketRuntimeNativeBegin,
  encodePocketRuntimePackageBegin,
  encodePocketRuntimePackageChunk,
  pocketPackageFooterHash,
  pocketRuntimeCrc32,
  type PocketRuntimeAck,
  type PocketRuntimeDiscovery,
  type PocketRuntimeFrame,
  type PocketRuntimeScreenshotBegin,
} from "../contracts/spec/pocket-runtime-wire.ts";
import { encodePNG } from "../tests/png.ts";

export interface PocketRuntimeScreenshot {
  readonly frame: number;
  readonly top: Uint8Array;
  readonly auxiliary: Uint8Array;
  readonly metadata: PocketRuntimeScreenshotBegin;
  readonly png: Buffer;
}

export interface PocketRuntimeClientOptions {
  readonly host: string;
  readonly token: Uint8Array;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
}

export interface DiscoveredPocketRuntime extends PocketRuntimeDiscovery {
  readonly address: string;
}

export interface PocketRuntimeDiscoveryOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly addresses?: readonly string[];
}

export interface PocketRuntimeSessionOptions {
  readonly createClient: () => PocketRuntimeClient | Promise<PocketRuntimeClient>;
  readonly retryDelayMs?: number;
}

export async function discoverPocketRuntimes(
  options: PocketRuntimeDiscoveryOptions = {},
): Promise<DiscoveredPocketRuntime[]> {
  const port = options.port ?? POCKET_RUNTIME_WIRE_PORT;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const addresses = options.addresses ?? ["255.255.255.255", "127.0.0.1"];
  const socket = createSocket("udp4");
  const found = new Map<string, DiscoveredPocketRuntime>();
  return await new Promise<DiscoveredPocketRuntime[]>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setInterval> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (retry) clearInterval(retry);
      if (settle) clearTimeout(settle);
      socket.close();
      if (error) reject(error);
      else resolve([...found.values()].sort((a, b) => a.address.localeCompare(b.address)));
    };
    socket.on("message", (message, remote) => {
      try {
        const value = decodePocketRuntimeDiscoveryReply(new Uint8Array(message));
        const key = value.deviceId.toString(16);
        const current = found.get(key);
        const candidate = {
          ...value,
          address: remote.address,
        };
        // One Runtime can answer through more than one local interface. Its
        // pairing-derived ID is stable across DHCP changes, so keep one route
        // and prefer a LAN address over loopback when both answer.
        if (!current || (current.address === "127.0.0.1" && remote.address !== "127.0.0.1")) {
          found.set(key, candidate);
        }
        // Startup may need several seconds for SOC to become reachable. Once
        // the first reply arrives, keep only a short window for other devices
        // on the LAN instead of charging every command the startup timeout.
        if (settle) clearTimeout(settle);
        settle = setTimeout(
          () => finish(),
          Math.min(150, Math.max(10, Math.floor(timeoutMs / 2))),
        );
      } catch {
        // Other UDP services may share the broadcast domain.
      }
    });
    socket.once("error", (error) => finish(error));
    socket.bind(0, "0.0.0.0", () => {
      socket.setBroadcast(true);
      const request = encodePocketRuntimeDiscoveryRequest();
      const send = () => {
        for (const address of addresses) socket.send(request, port, address, () => {});
      };
      send();
      // UDP discovery is deliberately stateless. Repeating the tiny request
      // inside the same bounded window tolerates one dropped Wi-Fi broadcast.
      retry = setInterval(send, Math.max(20, Math.min(250, Math.floor(timeoutMs / 3))));
      timer = setTimeout(() => finish(), timeoutMs);
    });
  });
}

type CtrlValue = Record<string, unknown>;

export class PocketRuntimeClient extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly token: Uint8Array;
  readonly timeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  #socket: Socket | null = null;
  #decoder = new PocketRuntimeFrameDecoder();
  #handshake = new Uint8Array(0);
  #connected = false;
  #closed = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #lastPongMs = 0;
  #screenshot: {
    metadata: PocketRuntimeScreenshotBegin;
    top: Uint8Array;
    auxiliary: Uint8Array;
    topReceived: number;
    auxiliaryReceived: number;
  } | null = null;

  constructor(options: PocketRuntimeClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? POCKET_RUNTIME_WIRE_PORT;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 8_000;
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatTimeoutMs <= this.heartbeatIntervalMs) {
      throw new Error("Pocket Runtime heartbeat timeout must exceed its positive interval");
    }
  }

  get connected(): boolean {
    return this.#connected && !this.#closed;
  }

  async connect(): Promise<PocketRuntimeAck> {
    if (this.#socket) throw new Error("Pocket Runtime client is already connected");
    const socket = new Socket();
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.#onData(new Uint8Array(chunk)));
    socket.on("error", (error) => this.emit("socketError", error));
    socket.on("close", () => {
      this.#connected = false;
      this.#closed = true;
      if (this.#pingTimer) clearInterval(this.#pingTimer);
      this.#pingTimer = null;
      this.emit("close");
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Pocket Runtime connection to ${this.host}:${this.port} timed out`)),
        this.timeoutMs,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", fail);
      socket.connect(this.port, this.host, () => {
        socket.off("error", fail);
        clearTimeout(timer);
        resolve();
      });
    });
    const ackPromise = new Promise<PocketRuntimeAck>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Pocket Runtime handshake timed out")),
        this.timeoutMs,
      );
      const onAck = (value: PocketRuntimeAck) => {
        clearTimeout(timer);
        this.off("protocolError", onError);
        resolve(value);
      };
      const onError = (error: Error) => {
        clearTimeout(timer);
        this.off("ack", onAck);
        reject(error);
      };
      this.once("ack", onAck);
      this.once("protocolError", onError);
    });
    await this.#write(encodePocketRuntimeHello(this.token));
    const ack = await ackPromise;
    if (!ack.accepted) {
      this.close();
      throw new Error(`Pocket Runtime rejected the pairing token (status ${ack.status})`);
    }
    this.#connected = true;
    this.#lastPongMs = Date.now();
    this.#pingTimer = setInterval(() => {
      if (Date.now() - this.#lastPongMs > this.heartbeatTimeoutMs) {
        this.emit(
          "heartbeatTimeout",
          new Error(`Pocket Runtime did not answer a heartbeat within ${this.heartbeatTimeoutMs} ms`),
        );
        this.close();
        return;
      }
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, Date.now() >>> 0, true);
      void this.sendFrame(POCKET_RUNTIME_MSG.ping, payload).catch((error) => {
        this.emit("socketError", error);
        this.close();
      });
    }, this.heartbeatIntervalMs);
    return ack;
  }

  async sendFrame(
    type: number,
    payload: Uint8Array = new Uint8Array(0),
    flags = 0,
  ): Promise<void> {
    if (!this.#socket || this.#closed) throw new Error("Pocket Runtime socket is closed");
    await this.#write(encodePocketRuntimeFrame(type, payload, flags));
  }

  async sendCtrl(value: string | CtrlValue): Promise<void> {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const bytes = new TextEncoder().encode(text);
    if (bytes.length === 0 || bytes.length > POCKET_RUNTIME_MAX_CTRL_BYTES || /[\r\n]/.test(text)) {
      throw new Error(`Pocket Runtime control must be one JSON record of at most ${POCKET_RUNTIME_MAX_CTRL_BYTES} bytes`);
    }
    await this.sendFrame(POCKET_RUNTIME_MSG.ctrl, bytes);
  }

  async requestStatus(): Promise<void> {
    await this.sendFrame(POCKET_RUNTIME_MSG.statusRequest);
  }

  async install(bytes: Uint8Array): Promise<bigint> {
    const hash = pocketPackageFooterHash(bytes);
    await this.sendFrame(
      POCKET_RUNTIME_MSG.packageBegin,
      encodePocketRuntimePackageBegin(bytes.length, hash),
    );
    const chunkBytes = POCKET_RUNTIME_MAX_FRAME_BYTES - 4;
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
      await this.sendFrame(
        POCKET_RUNTIME_MSG.packageChunk,
        encodePocketRuntimePackageChunk(offset, chunk),
      );
    }
    await this.sendFrame(POCKET_RUNTIME_MSG.packageCommit);
    return hash;
  }

  /** Stream a .3dsx to sdmc:/3ds/<name>; returns the CRC-32 the device checks. */
  async installNative(bytes: Uint8Array, name: string, launch: boolean): Promise<number> {
    const crc = pocketRuntimeCrc32(bytes);
    await this.sendFrame(
      POCKET_RUNTIME_MSG.nativeBegin,
      encodePocketRuntimeNativeBegin(bytes.length, crc, name, launch ? POCKET_RUNTIME_NATIVE_FLAG_LAUNCH : 0),
    );
    const chunkBytes = POCKET_RUNTIME_MAX_FRAME_BYTES - 4;
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
      await this.sendFrame(POCKET_RUNTIME_MSG.nativeChunk, encodePocketRuntimePackageChunk(offset, chunk));
    }
    await this.sendFrame(POCKET_RUNTIME_MSG.nativeCommit);
    return crc;
  }

  /** Start sdmc:/3ds/<name>: the running app exits into it. */
  async launch(name: string): Promise<void> {
    await this.sendFrame(POCKET_RUNTIME_MSG.launch, encodePocketRuntimeLaunch(name));
  }

  async waitForCtrl(
    predicate: (value: CtrlValue) => boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<CtrlValue> {
    return await new Promise<CtrlValue>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("ctrl", onCtrl);
        this.off("close", onClose);
        this.off("protocolError", onProtocolError);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Pocket Runtime control response timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onCtrl = (value: CtrlValue) => {
        // The device says when a record was too large for a frame. Whatever is
        // being awaited may well be that record, and a stated size beats
        // waiting out the timeout with nothing to go on.
        if (value.t === "ctrlDropped") {
          cleanup();
          reject(
            new Error(
              `Pocket Runtime dropped a ${String(value.bytes)} byte control record ` +
                `(frame cap ${String(value.cap)})`,
            ),
          );
          return;
        }
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Pocket Runtime connection closed while waiting for control"));
      };
      const onProtocolError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.on("ctrl", onCtrl);
      this.once("close", onClose);
      this.once("protocolError", onProtocolError);
    });
  }

  async waitForScreenshot(timeoutMs = this.timeoutMs): Promise<PocketRuntimeScreenshot> {
    return await new Promise<PocketRuntimeScreenshot>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("screenshot", onScreenshot);
        this.off("close", onClose);
        this.off("protocolError", onProtocolError);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Pocket Runtime screenshot timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onScreenshot = (value: PocketRuntimeScreenshot) => {
        cleanup();
        resolve(value);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Pocket Runtime connection closed while waiting for screenshot"));
      };
      const onProtocolError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.on("screenshot", onScreenshot);
      this.once("close", onClose);
      this.once("protocolError", onProtocolError);
    });
  }

  close(): void {
    this.#closed = true;
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    this.#socket?.destroy();
    this.#socket = null;
  }

  async #write(bytes: Uint8Array): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error("Pocket Runtime socket is closed");
    await new Promise<void>((resolve, reject) => {
      socket.write(bytes, (error) => error ? reject(error) : resolve());
    });
  }

  #onData(chunk: Uint8Array): void {
    try {
      if (!this.#connected) {
        const joined = new Uint8Array(this.#handshake.length + chunk.length);
        joined.set(this.#handshake);
        joined.set(chunk, this.#handshake.length);
        this.#handshake = joined;
        if (this.#handshake.length < POCKET_RUNTIME_ACK_BYTES) return;
        const ackBytes = this.#handshake.slice(0, POCKET_RUNTIME_ACK_BYTES);
        const remainder = this.#handshake.slice(POCKET_RUNTIME_ACK_BYTES);
        this.#handshake = new Uint8Array(0);
        const ack = decodePocketRuntimeAck(ackBytes);
        this.#connected = ack.accepted;
        this.emit("ack", ack);
        if (ack.accepted && remainder.length > 0) this.#decodeFrames(remainder);
        return;
      }
      this.#decodeFrames(chunk);
    } catch (error) {
      this.emit("protocolError", error instanceof Error ? error : new Error(String(error)));
      this.close();
    }
  }

  #decodeFrames(chunk: Uint8Array): void {
    for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame);
  }

  #handleFrame(frame: PocketRuntimeFrame): void {
    switch (frame.type) {
      case POCKET_RUNTIME_MSG.ping:
        void this.sendFrame(POCKET_RUNTIME_MSG.pong, frame.payload).catch(() => {});
        return;
      case POCKET_RUNTIME_MSG.pong:
        this.#lastPongMs = Date.now();
        this.emit("pong", frame.payload);
        return;
      case POCKET_RUNTIME_MSG.ctrl: {
        const line = new TextDecoder().decode(frame.payload);
        this.emit("ctrlLine", line);
        try {
          this.emit("ctrl", JSON.parse(line) as CtrlValue);
        } catch {
          this.emit("protocolError", new Error("Pocket Runtime sent invalid control JSON"));
        }
        return;
      }
      case POCKET_RUNTIME_MSG.screenshotBegin: {
        const metadata = decodePocketRuntimeScreenshotBegin(frame.payload);
        this.#screenshot = {
          metadata,
          top: new Uint8Array(metadata.topBytes),
          auxiliary: new Uint8Array(metadata.auxiliaryBytes),
          topReceived: 0,
          auxiliaryReceived: 0,
        };
        return;
      }
      case POCKET_RUNTIME_MSG.screenshotChunk: {
        const shot = this.#screenshot;
        if (!shot || frame.payload.length <= 4 || frame.flags > 1) {
          throw new Error("Pocket Runtime screenshot chunk arrived out of sequence");
        }
        const offset = new DataView(
          frame.payload.buffer,
          frame.payload.byteOffset,
          4,
        ).getUint32(0, true);
        const destination = frame.flags === 0 ? shot.top : shot.auxiliary;
        const received = frame.flags === 0 ? shot.topReceived : shot.auxiliaryReceived;
        const bytes = frame.payload.subarray(4);
        if (offset !== received || offset + bytes.length > destination.length) {
          throw new Error("Pocket Runtime screenshot chunk is out of order or exceeds its surface");
        }
        destination.set(bytes, offset);
        if (frame.flags === 0) shot.topReceived += bytes.length;
        else shot.auxiliaryReceived += bytes.length;
        return;
      }
      case POCKET_RUNTIME_MSG.screenshotEnd: {
        const shot = this.#screenshot;
        if (!shot || frame.payload.length !== 4) {
          throw new Error("Pocket Runtime screenshot end arrived out of sequence");
        }
        const frameNumber = new DataView(
          frame.payload.buffer,
          frame.payload.byteOffset,
          4,
        ).getUint32(0, true);
        if (frameNumber !== shot.metadata.frame) {
          throw new Error("Pocket Runtime screenshot frame identity changed mid-transfer");
        }
        if (shot.topReceived !== shot.top.length ||
            shot.auxiliaryReceived !== shot.auxiliary.length) {
          throw new Error("Pocket Runtime screenshot ended before both surfaces were complete");
        }
        const png = combinePocketRuntimeScreens(shot.metadata, shot.top, shot.auxiliary);
        const result: PocketRuntimeScreenshot = {
          frame: frameNumber,
          top: shot.top,
          auxiliary: shot.auxiliary,
          metadata: shot.metadata,
          png,
        };
        this.#screenshot = null;
        this.emit("screenshot", result);
        return;
      }
      default:
        this.emit("unknownFrame", frame);
    }
  }
}

/**
 * Keeps one logical DevTools attachment across replaceable TCP clients.
 * A client still owns exactly one ordered connection; this session owns only
 * desktop-side reconnect policy and never enters the Runtime or guest API.
 */
export class PocketRuntimeSession extends EventEmitter {
  readonly retryDelayMs: number;
  #createClient: PocketRuntimeSessionOptions["createClient"];
  #client: PocketRuntimeClient | null = null;
  #connecting: Promise<PocketRuntimeClient> | null = null;
  #stopped = false;

  constructor(options: PocketRuntimeSessionOptions) {
    super();
    this.#createClient = options.createClient;
    this.retryDelayMs = options.retryDelayMs ?? 750;
  }

  get connected(): boolean {
    return this.#client?.connected ?? false;
  }

  async start(): Promise<PocketRuntimeClient> {
    if (this.#stopped) throw new Error("Pocket Runtime session is closed");
    if (this.#client?.connected) return this.#client;
    return await this.#connectOnce(false);
  }

  async requireClient(): Promise<PocketRuntimeClient> {
    if (this.#stopped) throw new Error("Pocket Runtime session is closed");
    if (this.#client?.connected) return this.#client;
    return await this.#reconnect();
  }

  async sendCtrl(value: string | CtrlValue): Promise<void> {
    const client = await this.requireClient();
    await client.sendCtrl(value);
  }

  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#client?.close();
    this.#client = null;
  }

  async #connectOnce(reconnecting: boolean): Promise<PocketRuntimeClient> {
    const client = await this.#createClient();
    const forward = (event: string) => (...args: unknown[]) => this.emit(event, ...args);
    for (const event of [
      "screenshot",
      "ctrlLine",
      "ctrl",
      "protocolError",
      "unknownFrame",
      "pong",
      "heartbeatTimeout",
      "socketError",
    ]) {
      client.on(event, forward(event));
    }
    client.once("close", () => {
      if (this.#client !== client) return;
      this.#client = null;
      this.emit("disconnect");
      if (!this.#stopped) void this.#reconnect().catch(() => {});
    });

    let ack: PocketRuntimeAck;
    try {
      ack = await client.connect();
    } catch (error) {
      client.close();
      throw error;
    }
    if (this.#stopped) {
      client.close();
      throw new Error("Pocket Runtime session is closed");
    }
    if (!client.connected) {
      client.close();
      throw new Error("Pocket Runtime connection closed during its handshake");
    }
    this.#client = client;
    this.emit(reconnecting ? "reconnect" : "connect", client, ack);
    return client;
  }

  #reconnect(): Promise<PocketRuntimeClient> {
    if (this.#connecting) return this.#connecting;
    const task = (async () => {
      while (!this.#stopped) {
        this.emit("reconnectAttempt");
        try {
          return await this.#connectOnce(true);
        } catch (error) {
          if (this.#stopped) break;
          this.emit("reconnectError", error instanceof Error ? error : new Error(String(error)));
          await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
      throw new Error("Pocket Runtime session is closed");
    })();
    this.#connecting = task;
    void task.finally(() => {
      if (this.#connecting === task) this.#connecting = null;
    }).catch(() => {});
    return task;
  }
}

/** PICA target RGB8 is B,G,R in rotated column-major screen order. */
export function decodePocketRuntimeSurface(
  bytes: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  if (bytes.length !== width * height * 3) {
    throw new Error("Pocket Runtime surface has the wrong RGB8 byte count");
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (x * height + (height - 1 - y)) * 3;
      const destination = (y * width + x) * 4;
      rgba[destination] = bytes[source + 2];
      rgba[destination + 1] = bytes[source + 1];
      rgba[destination + 2] = bytes[source];
      rgba[destination + 3] = 255;
    }
  }
  return rgba;
}

export function combinePocketRuntimeScreens(
  metadata: PocketRuntimeScreenshotBegin,
  top: Uint8Array,
  auxiliary: Uint8Array,
): Buffer {
  const width = Math.max(metadata.topWidth, metadata.auxiliaryWidth);
  const height = metadata.topHeight + metadata.auxiliaryHeight;
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  const copy = (surface: Uint8Array, sourceWidth: number, sourceHeight: number, x: number, y: number) => {
    for (let row = 0; row < sourceHeight; row++) {
      const sourceAt = row * sourceWidth * 4;
      const destinationAt = ((y + row) * width + x) * 4;
      rgba.set(surface.subarray(sourceAt, sourceAt + sourceWidth * 4), destinationAt);
    }
  };
  copy(
    decodePocketRuntimeSurface(top, metadata.topWidth, metadata.topHeight),
    metadata.topWidth,
    metadata.topHeight,
    Math.floor((width - metadata.topWidth) / 2),
    0,
  );
  copy(
    decodePocketRuntimeSurface(
      auxiliary,
      metadata.auxiliaryWidth,
      metadata.auxiliaryHeight,
    ),
    metadata.auxiliaryWidth,
    metadata.auxiliaryHeight,
    Math.floor((width - metadata.auxiliaryWidth) / 2),
    metadata.topHeight,
  );
  return encodePNG(Buffer.from(rgba), width, height);
}

export function parsePocketRuntimeToken(text: string): Uint8Array {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("Pocket Runtime key must contain exactly 64 hexadecimal characters");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
