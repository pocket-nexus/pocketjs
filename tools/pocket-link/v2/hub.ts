// Pocket Link 2, a minimal Hub side in TypeScript (docs/POCKET-LINK.md): the
// reference peer for the device's C client and the endpoint that drives a
// real device from this repository's tools. Listener and beacon sender (§2),
// the handshake against a store of device records with candidate keys (§3),
// the counted replacement (§2.4), the setup that writes a pairing (§3.2),
// runtime operations as methods under a device mutex (§6.2, §8.3), DevTools
// lines and eval (§6.3), the catalog snapshot and install (§6.4), `net.http`
// through an injected fetch (§6.5), and applet channels handed to an injected
// daemon (§7). Pocket Hub's own endpoint is a separate program; this one
// keeps to what the page specifies.
//
// Time comes from `now()`; `tick()` runs every timed rule.

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { dirname, join } from "node:path";
import {
  LINK2_BEACON_INTERVAL_MS,
  LINK2_CHANNEL_OPEN_MS,
  LINK2_COMPANIONS_DIR,
  LINK2_DEVICE_FILE,
  LINK2_DEVTOOLS_LINE_IN,
  LINK2_FEATURES,
  LINK2_FRAME,
  LINK2_HANDSHAKE_TIMEOUT_MS,
  LINK2_HTTP_HEADERS_BYTES,
  LINK2_HTTP_MAX_BODY,
  LINK2_HTTP_MAX_HEADERS,
  LINK2_HTTP_MAX_OPEN,
  LINK2_HTTP_MAX_RESPONSE,
  LINK2_HTTP_MAX_TIMEOUT_MS,
  LINK2_HTTP_MIN_PAYLOAD,
  LINK2_HTTP_URL_BYTES,
  LINK2_INSTALL_MAX_BYTES,
  LINK2_KEY_SUFFIX,
  LINK2_LAST_SUFFIX,
  LINK2_LAUNCH_HOLD_MS,
  LINK2_MAX_CATALOG_REQUESTS,
  LINK2_MAX_CHANNELS,
  LINK2_MAX_CONNECTIONS,
  LINK2_PORT,
  LINK2_PREAMBLE_BYTES,
  LINK2_REPLACED_COUNT,
  LINK2_REPLACED_PING_MS,
  LINK2_REPLACED_WINDOW_MS,
  LINK2_REQUEST_STALL_MS,
  LINK2_TCP_PAYLOAD,
  LINK2_VERSION,
  LINK2_WINDOW,
  type Link2CatalogApp,
  type Link2Hello,
  type Link2InstalledApp,
  type Link2LogEvent,
  type Link2RuntimeStatus,
  type Link2ScreenshotSurface,
} from "../../../contracts/spec/link2.ts";
import { type Carrier, tcpCarrier } from "./carrier.ts";
import { CatalogPager, RuntimeAppsAssembler } from "./paging.ts";
import { CandidateKeys, type DirectoryEntry, type ReadOutcome, type SetupPlan, type StorageOp, parseDeviceFile, planSetup, settleSetup } from "./pairing.ts";
import { type AppletChannel, type CloseInfo, HUB_CHANNEL, type IncomingCall, type Json, LinkError, Peer, type StreamReader, type StreamWriter } from "./peer.ts";
import {
  Link2FrameDecoder,
  LinkCloseError,
  companionProof,
  consoleProof,
  decodePreamble,
  encodeBeacon,
  encodeClose,
  encodeHandshake,
  encodePreamble,
  encodedBytes,
  jsonBytes,
  newKey,
  newLinkId,
  newNonce,
  parseAuth,
  parseClose,
  parseHello,
  parseJsonPayload,
  payloadLimit,
  proofEquals,
  refused,
  selectVersion,
} from "./protocol.ts";
import { Responder } from "./requests.ts";

// ---------------------------------------------------------------------------
// The store (§3.6)
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  id: string;
  name: string;
  model: string;
  /** The link key; two while a setup is unconfirmed, the newer first (§3.2). */
  keys: string[];
  target: string;
  hostAbi: number;
  lastAddress: string;
  lastSeen: number;
}
export interface HubStore {
  /** Hub's id: 8 random bytes as 16 lowercase hex digits, made once. */
  readonly id: string;
  get(device: string): DeviceRecord | undefined;
  put(record: DeviceRecord): void;
  remove(device: string): void;
  /** One counter for the whole Hub, stored before the value is returned (§7.4). */
  nextGeneration(): number;
}

export class MemoryStore implements HubStore {
  readonly devices = new Map<string, DeviceRecord>();
  lastGeneration = 0;
  constructor(readonly id: string = newLinkId()) {}
  get(device: string) {
    return this.devices.get(device);
  }
  put(record: DeviceRecord) {
    this.devices.set(record.id, { ...record, keys: [...record.keys] });
  }
  remove(device: string) {
    this.devices.delete(device);
  }
  nextGeneration() {
    this.lastGeneration = (this.lastGeneration + 1) >>> 0;
    return this.lastGeneration;
  }
}

/** The records in one JSON file of mode 0600, written whole at each change. */
export class FileStore implements HubStore {
  private state: { id: string; lastGeneration: number; devices: DeviceRecord[] };
  constructor(private readonly path: string) {
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { id: newLinkId(), lastGeneration: 0, devices: [] };
    if (!existsSync(path)) this.save();
  }
  get id() {
    return this.state.id;
  }
  get(device: string) {
    return this.state.devices.find((record) => record.id === device);
  }
  put(record: DeviceRecord) {
    this.state.devices = [...this.state.devices.filter((other) => other.id !== record.id), { ...record, keys: [...record.keys] }];
    this.save();
  }
  remove(device: string) {
    this.state.devices = this.state.devices.filter((record) => record.id !== device);
    this.save();
  }
  nextGeneration() {
    this.state.lastGeneration = (this.state.lastGeneration + 1) >>> 0;
    this.save();
    return this.state.lastGeneration;
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    chmodSync(this.path, 0o600);
  }
}

// ---------------------------------------------------------------------------
// The setup's storage (§3.2)
// ---------------------------------------------------------------------------

/** The device's link directory as the setup reaches it: over ftpd, or the
 *  mounted SD card. A read tells its three outcomes apart. */
export interface SetupStorage {
  read(path: string): Promise<ReadOutcome>;
  /** File names of a folder; an absent folder lists as empty. Throws when the listing failed. */
  list(dir: string): Promise<string[]>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** A directory on this computer as the device's link directory: the mounted card. */
export function directoryStorage(root: string): SetupStorage {
  return {
    async read(path) {
      try {
        return { kind: "file", text: readFileSync(join(root, path), "utf8") };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "failed" };
      }
    },
    async list(dir) {
      try {
        return readdirSync(join(root, dir));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async write(path, text) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    async remove(path) {
      rmSync(join(root, path), { force: true });
    },
    async rename(from, to) {
      renameSync(join(root, from), join(root, to));
    },
  };
}

export interface SetupResult {
  outcome: SetupPlan["outcome"];
  /** True when the setup has no matching final readback: reported to the owner as failed. */
  failed: boolean;
  failedAt: StorageOp | null;
  deviceId: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** One app of Hub's offer: a catalog row, the targets it has a variant for, and its file. */
export interface HubOffer extends Link2CatalogApp {
  targets?: string[];
  read(): Uint8Array;
}
export interface HttpFetch {
  (request: { app: string; url: string; method: string; headers: Record<string, string>; timeoutMs: number; maxBytes: number }, body: Uint8Array): Promise<{
    status: number;
    url: string;
    /** In the order received; the last received are dropped first when the head does not fit. */
    headers: [string, string][];
    body: Uint8Array;
  }>;
}
export interface DaemonInfo {
  device: string;
  app: string;
  hash: string;
  generation: number;
}
/** The computer side of one applet, as Hub starts and reaches it (§7.7). */
export interface Daemon {
  /** Resolves when the daemon is connected; Hub holds the `channel.open` REPLY meanwhile. */
  ready?: Promise<void>;
  /** One call per accepted channel: the daemon's end of it. */
  attach(channel: AppletChannel, info: DaemonInfo): void;
  /** The open was cancelled or timed out while the daemon was starting. */
  stop?(): void;
}

export interface HubOptions {
  name: string;
  store?: HubStore;
  /** The link port; 0 for an ephemeral one. Default 8628, ephemeral when taken. */
  port?: number;
  host?: string;
  now?: () => number;
  /** The groups Hub serves (§6.1). Default: every group. */
  features?: string[];
  maxPayload?: number;
  /** Where beacons go, once a second; none when empty. */
  beaconTargets?: { address: string; port: number }[];
  catalog?: () => HubOffer[];
  fetch?: HttpFetch;
  /** The daemon of an applet id: null for none, "rejected" when policy refuses the id. */
  daemons?: (app: string, device: string) => Daemon | null | "rejected";
  /** Keep an unsolicited screenshot as the device's latest; false resets its stream `refused`. */
  keepScreenshots?: boolean;
  onDevice?: (device: HubDevice) => void;
}

interface Pending {
  carrier: Carrier;
  since: number;
  decoder: Link2FrameDecoder;
  preamble: Uint8Array | null;
  hello: Link2Hello | null;
  nonce: string;
  key: string;
  done: boolean;
}

export interface Screenshot {
  frame: number;
  format: string;
  surfaces: Link2ScreenshotSurface[];
  pixels: Uint8Array;
}

// ---------------------------------------------------------------------------
// One linked device
// ---------------------------------------------------------------------------

export class HubDevice {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly target: string;
  readonly hostAbi: number;
  /** The last `runtime.status` the device sent. */
  status: Link2RuntimeStatus | null = null;
  /** The device's installed applets, as its last complete report gave them. */
  apps: Link2InstalledApp[] = [];
  /** The last unsolicited screenshot kept. */
  latestScreenshot: Screenshot | null = null;
  /** Channels open on this connection, by channel id. */
  readonly channels = new Map<number, AppletChannel>();
  /** Why the link ended, once it has. */
  closed: CloseInfo | null = null;

  onStatus: ((status: Link2RuntimeStatus) => void) | null = null;
  onApps: ((apps: Link2InstalledApp[]) => void) | null = null;
  onLog: ((event: Link2LogEvent) => void) | null = null;
  /** A DevTools line from the device that Hub does not consume itself. */
  onDevtoolsLine: ((line: string) => void) | null = null;
  onGuestEnd: ((app: string, output: string) => void) | null = null;
  /** A system event with no handler here (the agent's messages). */
  onSystemEvent: ((object: Json) => void) | null = null;
  onClose: ((info: CloseInfo) => void) | null = null;

  private readonly assembler = new RuntimeAppsAssembler();
  /** @internal The catalog of this connection: its revision and snapshot. */
  readonly pager: CatalogPager;
  private readonly catalogBound = new Responder(LINK2_MAX_CATALOG_REQUESTS);
  private readonly httpBound = new Responder(LINK2_HTTP_MAX_OPEN);
  private readonly devtoolsBound = new Responder(1);
  private devtoolsOut: StreamWriter | null = null;
  private devtoolsLines: { bytes: Uint8Array; since: number; evalId: string | null }[] = [];
  private devtoolsPartial = "";
  private evals = new Map<string, { resolve: (value: Json) => void; reject: (error: LinkError) => void; since: number }>();
  private evalCounter = 0;
  private opening = 0;
  private opens: { deadline: number; expire: () => void }[] = [];

  constructor(
    private readonly hub: LinkHub,
    readonly peer: Peer,
    hello: Link2Hello,
    private readonly options: HubOptions,
  ) {
    this.id = hello.device;
    this.name = hello.name;
    this.model = hello.model;
    this.target = hello.target;
    this.hostAbi = hello.hostAbi;
    this.pager = new CatalogPager(() => this.offer(), peer.now);
    this.wire();
  }

  private offer(): HubOffer[] {
    return (this.options.catalog?.() ?? []).filter((app) => app.targets === undefined || app.targets.includes(this.target));
  }

  // --- runtime operations (§6.2), under the device mutex (§8.3) ------------

  runtimeStatus(): Promise<Link2RuntimeStatus> {
    return this.peer.request({ t: "runtime.status" }, { feature: "runtime" }).reply as unknown as Promise<Link2RuntimeStatus>;
  }
  /** Pushes a `.pocket`. `hash` is the package footer hash as 16 hex digits. */
  push(file: Uint8Array, hash: string, onEvent?: (event: Json) => void): Promise<Json> {
    return this.hub.locked(this.id, "runtime.push", async () => {
      const call = this.peer.request({ t: "runtime.push", bytes: file.length, hash }, { feature: "runtime", body: true, onProgress: (_t, event) => onEvent?.(event) });
      void call.body?.writeAll(file).then(() => call.body?.end(), () => {});
      return call.reply;
    });
  }
  nativeInstall(name: string, file: Uint8Array, launch: boolean, onEvent?: (event: Json) => void): Promise<Json> {
    return this.hub.locked(this.id, "runtime.native.install", async () => {
      const call = this.peer.request(
        { t: "runtime.native.install", name, bytes: file.length, crc32: Bun.hash.crc32(file) >>> 0, launch },
        { feature: "runtime.native", body: true, onProgress: (_t, event) => onEvent?.(event) },
      );
      void call.body?.writeAll(file).then(() => call.body?.end(), () => {});
      const reply = await call.reply;
      // The device exits into the file: no state-changing request until it links again or 60 s pass.
      if (reply.phase === "launching") this.hub.launching(this.id);
      return reply;
    });
  }
  launch(request: { native: string } | { app: string }): Promise<Json> {
    return this.hub.locked(this.id, "runtime.launch", async () => {
      const reply = await this.peer.request({ t: "runtime.launch", ...request }, { feature: "runtime" }).reply;
      if (reply.phase === "launching") this.hub.launching(this.id);
      return reply;
    });
  }
  /** Both screens, captured by the host without the guest. Takes no lock. */
  async screenshot(): Promise<Screenshot> {
    let head: Json | null = null;
    const chunks: Uint8Array[] = [];
    const call = this.peer.request({ t: "runtime.screenshot" }, {
      feature: "runtime",
      response: { window: LINK2_WINDOW.hub, onData: (bytes) => void chunks.push(bytes.slice()) },
      onProgress: (t, event) => {
        if (t !== "runtime.screenshot") return;
        head = event;
        call.response?.start(surfaceBytes(event.surfaces));
      },
    });
    const reply = await call.reply;
    return shot(head ?? reply, chunks);
  }
  async logs(on: boolean): Promise<void> {
    await this.peer.request({ t: "runtime.logs", on }, { feature: "runtime" }).reply;
  }

  // --- DevTools (§6.3) -----------------------------------------------------

  /** True while the device's DevTools stream is open. */
  get devtoolsOpen(): boolean {
    return this.devtoolsOut !== null && !this.devtoolsOut.done;
  }
  /** `devtools.listen`: Hub turns it on only while a panel is attached. */
  listen(on: boolean): void {
    if (this.peer.inUse("devtools")) this.peer.event({ t: "devtools.listen", on });
  }
  /** One line toward the device's shim, at most 16 KiB without its newline.
   *  Hub holds a line until credit covers it; a line held 30 s is dropped. */
  sendLine(line: string, evalId: string | null = null): void {
    const bytes = new TextEncoder().encode(`${line}\n`);
    if (bytes.length - 1 > LINK2_DEVTOOLS_LINE_IN) throw new LinkError("too_large", "a line toward the device is at most 16 KiB");
    this.devtoolsLines.push({ bytes, since: this.peer.now(), evalId });
    this.pumpLines();
  }
  /** Evaluates code in the running applet through its DevTools shim, under
   *  the device mutex. Ends at the answer, at `guest.end`, or after 30 s. */
  eval(code: string): Promise<Json> {
    return this.hub.locked(this.id, "eval", () => {
      const id = `hub-${++this.evalCounter}`;
      return new Promise<Json>((resolve, reject) => {
        if (this.devtoolsOut === null) return reject(new LinkError("unsupported", "the device has no DevTools stream"));
        this.evals.set(id, { resolve, reject, since: this.peer.now() });
        try {
          this.sendLine(JSON.stringify({ t: "eval", id, code }), id);
        } catch (error) {
          this.evals.delete(id);
          reject(error as LinkError);
        }
      });
    });
  }
  private pumpLines(): void {
    const out = this.devtoolsOut;
    while (out !== null && this.devtoolsLines.length > 0 && out.creditFree >= this.devtoolsLines[0].bytes.length) {
      out.write(this.devtoolsLines.shift()!.bytes);
    }
  }
  private failEval(id: string, error: LinkError): void {
    const pending = this.evals.get(id);
    if (pending === undefined) return;
    this.evals.delete(id);
    pending.reject(error);
  }
  private devtoolsBytes(bytes: Uint8Array): void {
    const lines = (this.devtoolsPartial + new TextDecoder().decode(bytes)).split("\n");
    this.devtoolsPartial = lines.pop() ?? "";
    for (const line of lines) {
      let object: Json | null = null;
      try {
        object = JSON.parse(line) as Json;
      } catch {
        object = null;
      }
      if (object !== null && object.t === "guest.end") {
        // Hub fails every eval still pending on the device, and does not forward the line.
        for (const id of [...this.evals.keys()]) this.failEval(id, new LinkError("closed", "the guest ended"));
        this.devtoolsLines = this.devtoolsLines.filter((item) => item.evalId === null);
        this.onGuestEnd?.(String(object.app), String(object.output));
        continue;
      }
      if (object !== null && object.t === "evalResult" && typeof object.id === "string" && this.evals.has(object.id)) {
        const pending = this.evals.get(object.id)!;
        this.evals.delete(object.id);
        pending.resolve(object);
        continue;
      }
      this.onDevtoolsLine?.(line);
    }
  }

  // --- events toward the device --------------------------------------------

  /** A system event with id 0 (the agent's messages). */
  event(object: Json & { t: string }): void {
    this.peer.event(object);
  }
  /** A system event that opens a stream toward the device (`agent.screen`, `agent.glyphs`). */
  eventStream(object: Json & { t: string }, feature = "agent"): StreamWriter {
    return this.peer.eventStream(object, { feature });
  }

  /** @internal */
  tick(): void {
    this.peer.tick();
    const now = this.peer.now();
    // A line held 30 s without credit is dropped and its eval fails; the stream stays (§5.5).
    while (this.devtoolsLines.length > 0 && now - this.devtoolsLines[0].since >= LINK2_REQUEST_STALL_MS) {
      const dropped = this.devtoolsLines.shift()!;
      if (dropped.evalId !== null) this.failEval(dropped.evalId, new LinkError("timeout", "no credit for the line in 30 s"));
    }
    for (const [id, pending] of this.evals) if (now - pending.since >= LINK2_REQUEST_STALL_MS) this.failEval(id, new LinkError("timeout", "no answer to the eval in 30 s"));
    for (const open of [...this.opens]) if (now >= open.deadline) open.expire();
  }
  /** @internal */
  ended(info: CloseInfo): void {
    this.closed = info;
    for (const id of [...this.evals.keys()]) this.failEval(id, new LinkError("closed"));
    this.onClose?.(info);
  }

  // --- the device's requests -----------------------------------------------

  private wire(): void {
    const peer = this.peer;
    peer.onEvent("runtime.status", (object) => {
      this.status = object as unknown as Link2RuntimeStatus;
      this.onStatus?.(this.status);
    }, { feature: "runtime" });
    peer.onEvent("runtime.apps", (object) => {
      const set = this.assembler.page(object as never);
      if (set !== null) {
        this.apps = set;
        this.onApps?.(set);
      }
    }, { feature: "apps" });
    peer.onEvent("log", (object) => this.onLog?.(object as unknown as Link2LogEvent), { feature: "runtime" });
    peer.onEvent("runtime.screenshot", (object, open) => {
      // An unsolicited screenshot: kept as the device's latest, or reset `refused`.
      if (open === null || this.options.keepScreenshots === false) return;
      const chunks: Uint8Array[] = [];
      const reader = open({ window: LINK2_WINDOW.hub, total: surfaceBytes(object.surfaces), onData: (bytes) => void chunks.push(bytes.slice()) });
      reader.finished.then(() => {
        this.latestScreenshot = shot(object, chunks);
      }, () => {});
    }, { feature: "runtime" });
    for (const t of ["agent.hello", "agent.turn", "agent.audio.end", "agent.cancel", "agent.reset", "agent.result"]) {
      peer.onEvent(t, (object) => this.onSystemEvent?.(object), { feature: "agent" });
    }

    peer.handle("devtools.open", (call) => {
      // The request id is the DevTools stream id for both directions from here on.
      const id = call.id;
      this.devtoolsPartial = "";
      this.devtoolsOut = peer.newWriter(id, { exempt: true, onGiveUp: () => {}, onCredit: () => this.pumpLines() });
      void call.reply({}).then(() => {
        const reader = peer.newReader(id, { auto: { window: LINK2_WINDOW.hub, onData: (bytes) => this.devtoolsBytes(bytes) } }, "devtools");
        reader.start();
        reader.finished.catch(() => {
          if (this.devtoolsOut?.id === id) this.devtoolsOut = null;
          this.devtoolsBound.reply(id);
        });
      });
      this.devtoolsOut.finished.catch(() => {});
      return new Promise<Json>(() => {});
    }, { feature: "devtools" });

    peer.handle("catalog", (call) => {
      const answer = this.pager.request(call.args, peer.limit);
      if ("error" in answer) throw new LinkError(answer.error);
      return { ...answer.reply };
    }, { feature: "catalog", bound: this.catalogBound });

    peer.handle("install", async (call) => {
      const app = this.offer().find((offer) => offer.id === call.args.app);
      if (app === undefined) throw new LinkError("not_found");
      const file = app.read();
      if (file.length > LINK2_INSTALL_MAX_BYTES) throw new LinkError("too_large");
      call.progress({ t: "install.head", app: app.id, hash: app.hash, bytes: file.length });
      const out = call.respond();
      await out.writeAll(file);
      out.end();
      await out.finished;
      return { bytes: file.length };
    }, { feature: "install", bound: this.catalogBound });

    peer.handle("net.http", (call) => this.http(call), { feature: "net.http", bound: this.httpBound });
    peer.handle("channel.open", (call) => this.channelOpen(call), { feature: "channel" });
  }

  private async http(call: IncomingCall): Promise<Json> {
    const peer = this.peer;
    if (peer.limit < LINK2_HTTP_MIN_PAYLOAD) throw new LinkError("unsupported", "net.http is in use from a payload limit of 12,288");
    const fetch = this.options.fetch;
    if (fetch === undefined) throw new LinkError("unavailable");
    const args = call.args as { app?: unknown; url?: unknown; method?: unknown; headers?: unknown; timeoutMs?: unknown; maxBytes?: unknown; bytes?: unknown };
    const headers = (typeof args.headers === "object" && args.headers !== null ? args.headers : {}) as Record<string, string>;
    const bytes = typeof args.bytes === "number" ? args.bytes : -1;
    const invalid =
      typeof args.app !== "string" ||
      typeof args.url !== "string" ||
      !/^https?:/.test(args.url) ||
      encodedBytes(args.url) > LINK2_HTTP_URL_BYTES ||
      typeof args.method !== "string" ||
      Object.keys(headers).length > LINK2_HTTP_MAX_HEADERS ||
      Object.values(headers).some((value) => typeof value !== "string") ||
      jsonBytes(headers) > LINK2_HTTP_HEADERS_BYTES ||
      !Number.isInteger(bytes) ||
      bytes < 0 ||
      bytes > LINK2_HTTP_MAX_BODY;
    if (invalid) throw new LinkError("invalid_request");
    const body = new Uint8Array(bytes);
    let at = 0;
    // Hub grants credit for `bytes` on receipt.
    await call.readBody({ window: Math.max(bytes, 1), total: bytes, onData: (chunk) => void (body.set(chunk, at), (at += chunk.length)) });
    const maxBytes = Math.min(typeof args.maxBytes === "number" ? args.maxBytes : 128 * 1024, LINK2_HTTP_MAX_RESPONSE);
    const timeoutMs = Math.min(typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000, LINK2_HTTP_MAX_TIMEOUT_MS);
    const response = await fetch({ app: args.app as string, url: args.url as string, method: args.method as string, headers, timeoutMs, maxBytes }, body);
    if (encodedBytes(response.url) > LINK2_HTTP_URL_BYTES || response.body.length > maxBytes) throw new LinkError("response_too_large");
    // Response headers are dropped, the last received first, until the encoded object fits.
    const kept = response.headers.slice(0, LINK2_HTTP_MAX_HEADERS);
    let truncated = kept.length < response.headers.length;
    while (kept.length > 0 && jsonBytes(Object.fromEntries(kept)) > LINK2_HTTP_HEADERS_BYTES) {
      kept.pop();
      truncated = true;
    }
    const head: Json & { t: string } = { t: "net.head", status: response.status, url: response.url, headers: Object.fromEntries(kept) };
    if (truncated) head.truncated = true;
    call.progress(head);
    const out = call.respond();
    await out.writeAll(response.body);
    out.end();
    await out.finished;
    return { bytes: response.body.length };
  }

  private channelOpen(call: IncomingCall): Promise<Json> {
    const { app, hash } = call.args as { app?: unknown; hash?: unknown };
    if (typeof app !== "string" || app.length === 0 || encodedBytes(app) > 128 || typeof hash !== "string" || !/^[0-9a-f]{16}$/.test(hash)) throw new LinkError("malformed");
    if (this.peer.channelCount + this.opening >= LINK2_MAX_CHANNELS) throw new LinkError("busy", "the connection has 4 channels");
    const daemon = this.options.daemons?.(app, this.id) ?? null;
    if (daemon === null) throw new LinkError("no_daemon");
    if (daemon === "rejected") throw new LinkError("rejected");
    this.opening += 1;
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      this.opening -= 1;
      this.opens = this.opens.filter((open) => open !== entry);
      return true;
    };
    // Hub answers within LINK_CHANNEL_OPEN_MS, with `busy` when the daemon is not connected by then.
    const entry = {
      deadline: this.peer.now() + LINK2_CHANNEL_OPEN_MS,
      expire: () => {
        if (!finish()) return;
        daemon.stop?.();
        call.fail(new LinkError("busy", "the daemon did not start in time"));
      },
    };
    this.opens.push(entry);
    call.onCancel(() => {
      if (finish()) daemon.stop?.();
    });
    void (daemon.ready ?? Promise.resolve()).then(
      () => {
        if (!finish() || call.cancelled || !this.peer.open) return;
        // Stored before the REPLY that carries it (§7.4).
        const generation = this.hub.store.nextGeneration();
        void call.reply({ generation });
        const channel = this.peer.addChannel(call.id, app, hash, generation, HUB_CHANNEL);
        // Hub queues its first grant after the REPLY of `channel.open`, never before it.
        channel.grantUnits();
        this.channels.set(channel.id, channel);
        channel.onClose(() => this.channels.delete(channel.id));
        daemon.attach(channel, { device: this.id, app, hash, generation });
      },
      () => {
        if (finish()) call.fail(new LinkError("busy", "the daemon failed to start"));
      },
    );
    return new Promise<Json>(() => {});
  }
}

const surfaceBytes = (surfaces: unknown): number =>
  Array.isArray(surfaces) ? surfaces.reduce((sum: number, surface: { bytes?: unknown }) => sum + (typeof surface.bytes === "number" ? surface.bytes : 0), 0) : 0;
function shot(head: Json, chunks: Uint8Array[]): Screenshot {
  const pixels = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    pixels.set(chunk, at);
    at += chunk.length;
  }
  return { frame: Number(head.frame ?? 0), format: String(head.format ?? ""), surfaces: (head.surfaces ?? []) as Link2ScreenshotSurface[], pixels };
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export class LinkHub {
  readonly now: () => number;
  readonly store: HubStore;
  /** Linked devices by device id. */
  readonly devices = new Map<string, HubDevice>();
  /** Device ids two consoles were seen to share (§2.4). */
  readonly duplicates = new Set<string>();
  /** Device ids whose last setup has no matching final readback. */
  readonly unconfirmed = new Set<string>();
  port = 0;

  private readonly options: HubOptions;
  private features: string[];
  private server: Server | null = null;
  private udp: UdpSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private beaconAt = Number.NEGATIVE_INFINITY;
  private readonly pending = new Set<Pending>();
  private readonly candidates = new Map<string, CandidateKeys>();
  private readonly replaced: { device: HubDevice; at: number }[] = [];
  private readonly counted = new Map<string, number[]>();
  private readonly mutex = new Map<string, { holder: string; until: number | null }>();

  constructor(options: HubOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new MemoryStore();
    this.features = options.features ?? [...LINK2_FEATURES];
  }
  get id(): string {
    return this.store.id;
  }

  /** Binds the link port: 8628, or an ephemeral one when it is taken. */
  listen(): Promise<number> {
    const wanted = this.options.port ?? LINK2_PORT;
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const server = createServer((socket) => this.accept(tcpCarrier(socket, this.options.maxPayload ?? LINK2_TCP_PAYLOAD)));
        server.once("error", reject);
        server.listen(port, this.options.host ?? "0.0.0.0", () => {
          server.removeListener("error", reject);
          this.server = server;
          this.port = (server.address() as { port: number }).port;
          resolve(this.port);
        });
      });
    return bind(wanted).catch((error) => (wanted !== 0 && (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? bind(0) : Promise.reject(error)));
  }
  /** Runs `tick()` on an interval. */
  start(intervalMs = 100): void {
    this.timer = setInterval(() => this.tick(), intervalMs);
  }
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.udp?.close();
    this.udp = null;
    for (const device of this.devices.values()) device.peer.close("going_away", "Hub quits");
    for (const entry of this.replaced) entry.device.peer.close("replaced");
    for (const pending of this.pending) pending.carrier.close();
    this.server?.close();
    this.server = null;
  }

  tick(): void {
    const now = this.now();
    if ((this.options.beaconTargets?.length ?? 0) > 0 && this.port !== 0 && now - this.beaconAt >= LINK2_BEACON_INTERVAL_MS) {
      this.beaconAt = now;
      this.udp ??= createSocket("udp4").on("error", () => {});
      const beacon = encodeBeacon({ port: this.port, companion: this.id, name: this.options.name });
      for (const target of this.options.beaconTargets!) this.udp.send(beacon, target.port, target.address);
    }
    for (const pending of [...this.pending]) {
      if (now - pending.since < LINK2_HANDSHAKE_TIMEOUT_MS) continue;
      pending.carrier.write(encodeClose("handshake_timeout"));
      this.drop(pending);
    }
    // A replaced connection that answered nothing in 2 s was half open: closed and not counted.
    for (const entry of [...this.replaced]) {
      if (now - entry.at < LINK2_REPLACED_PING_MS) continue;
      this.replaced.splice(this.replaced.indexOf(entry), 1);
      entry.device.peer.close("replaced");
    }
    for (const [id, lock] of this.mutex) if (lock.until !== null && now >= lock.until) this.mutex.delete(id);
    for (const device of this.devices.values()) device.tick();
  }

  // --- features, catalog, forgetting ---------------------------------------

  /** Hub's list changes: every linked device gets a `features` event (§6.1). */
  setFeatures(list: string[]): void {
    this.features = [...list];
    for (const device of this.devices.values()) device.peer.setFeatures(list);
  }
  /** The offer changed: the revision rises and `catalog.changed` goes to every device that reads it. */
  catalogChanged(): void {
    for (const device of this.devices.values()) {
      device.pager.changed();
      if (device.peer.inUse("catalog")) device.peer.event({ t: "catalog.changed" });
    }
  }
  /** The owner forgets a device: the record goes, and its link closes with `forgotten`. */
  forget(device: string): void {
    this.store.remove(device);
    this.candidates.delete(device);
    this.devices.get(device)?.peer.close("forgotten");
  }

  // --- the device mutex (§8.3) ---------------------------------------------

  /** Runs one state-changing request of a device; a second one meanwhile is
   *  refused with `busy` and the holder. */
  async locked<T>(device: string, holder: string, work: () => Promise<T>): Promise<T> {
    const lock = this.mutex.get(device);
    if (lock !== undefined) throw new LinkError("busy", `the device is held by ${lock.holder}`, { holder: lock.holder });
    const mine = { holder, until: null as number | null };
    this.mutex.set(device, mine);
    try {
      return await work();
    } finally {
      if (this.mutex.get(device) === mine && mine.until === null) this.mutex.delete(device);
    }
  }
  /** After a reply with `phase: "launching"`: held until the device links again or 60 s pass. */
  launching(device: string): void {
    const lock = this.mutex.get(device);
    if (lock !== undefined) lock.until = this.now() + LINK2_LAUNCH_HOLD_MS;
  }

  // --- the setup that writes a pairing (§3.2) ------------------------------

  /**
   * One procedure against the device's storage, over ftpd or on the mounted
   * card. The candidate key is stored in Hub's record before anything is
   * written; a setup without a matching final readback is reported as failed
   * and leaves two candidates for the first `ready` to settle.
   */
  async setup(storage: SetupStorage, via: { kind: "ftp"; localAddress: string } | { kind: "card"; addresses: string[] }, port: number = this.port || LINK2_PORT): Promise<SetupResult> {
    const own = this.id + LINK2_KEY_SUFFIX;
    const device = await storage.read(LINK2_DEVICE_FILE);
    let listing: DirectoryEntry[];
    try {
      const names = await storage.list(LINK2_COMPANIONS_DIR);
      listing = [];
      for (const name of names) {
        const read = name.endsWith(LINK2_KEY_SUFFIX) && name !== own ? await storage.read(`${LINK2_COMPANIONS_DIR}/${name}`) : null;
        listing.push({ name, text: read !== null && read.kind === "file" ? read.text : "" });
      }
    } catch {
      return { outcome: "failed-read", failed: true, failedAt: null, deviceId: null, message: "companions/ could not be listed" };
    }
    const companion = await storage.read(`${LINK2_COMPANIONS_DIR}/${own}`);
    const last = await storage.read(`${LINK2_COMPANIONS_DIR}/${this.id}${LINK2_LAST_SUFFIX}`);
    if (companion.kind === "file") listing = listing.map((entry) => (entry.name === own ? { name: own, text: companion.text } : entry));
    const known = device.kind === "file" ? parseDeviceFile(device.text) : null;
    const record = known !== null ? this.store.get(known) : undefined;
    const plan = planSetup({
      hubId: this.id,
      keys: record?.keys ?? [],
      hub: { name: this.options.name, port },
      via,
      device,
      listing,
      companion,
      last,
      mintDeviceId: newLinkId,
      mintKey: newKey,
    });
    if (plan.outcome === "failed-read" || plan.outcome === "eight-computers" || plan.deviceId === null) {
      return { outcome: plan.outcome, failed: true, failedAt: null, deviceId: plan.deviceId, message: plan.message };
    }
    const id = plan.deviceId;
    const save = (keys: string[]) => {
      const before = this.store.get(id);
      this.store.put({ id, name: before?.name ?? "", model: before?.model ?? "", keys, target: before?.target ?? "", hostAbi: before?.hostAbi ?? 0, lastAddress: before?.lastAddress ?? "", lastSeen: before?.lastSeen ?? 0 });
      this.candidates.set(id, new CandidateKeys([...keys]));
    };
    // The candidate is in the record before the first write.
    save(plan.keys);
    let completed = 0;
    for (const op of plan.ops) {
      try {
        if (op.op === "write") await storage.write(op.path, op.text);
        else if (op.op === "delete") await storage.remove(op.path);
        else if (op.op === "rename") await storage.rename(op.from, op.to);
        else {
          const back = await storage.read(op.path);
          if (back.kind !== "file" || back.text !== op.text) break;
        }
      } catch {
        break;
      }
      completed += 1;
    }
    const settled = settleSetup(plan, completed);
    save(settled.keys);
    if (settled.failed) this.unconfirmed.add(id);
    else this.unconfirmed.delete(id);
    return { outcome: plan.outcome, failed: settled.failed, failedAt: settled.failedAt, deviceId: id, message: settled.failed ? `the setup failed at ${settled.failedAt?.op ?? "a read"}` : plan.message };
  }

  // --- a connection (§3.3) -------------------------------------------------

  /** Takes one carrier a device opened: the preamble exchange, then the handshake. */
  accept(carrier: Carrier): void {
    const pending: Pending = { carrier, since: this.now(), decoder: new Link2FrameDecoder(), preamble: new Uint8Array(0), hello: null, nonce: "", key: "", done: false };
    this.pending.add(pending);
    carrier.onClose = () => this.drop(pending, false);
    carrier.onData = (bytes) => this.handshake(pending, bytes);
  }
  private drop(pending: Pending, close = true): void {
    if (pending.done) return;
    pending.done = true;
    this.pending.delete(pending);
    if (close) pending.carrier.close();
  }
  private refuse(pending: Pending, code: Parameters<typeof refused>[0], message: string): void {
    pending.carrier.write(encodeHandshake(refused(code, message)));
    this.drop(pending);
  }

  private handshake(pending: Pending, chunk: Uint8Array): void {
    if (pending.done) return;
    const { carrier } = pending;
    let bytes = chunk;
    if (pending.preamble !== null) {
      const joined = new Uint8Array(pending.preamble.length + bytes.length);
      joined.set(pending.preamble);
      joined.set(bytes, pending.preamble.length);
      if (joined.length < LINK2_PREAMBLE_BYTES) {
        pending.preamble = joined;
        return;
      }
      const theirs = decodePreamble(joined.subarray(0, LINK2_PREAMBLE_BYTES));
      if (theirs === null) return this.drop(pending);
      const selected = selectVersion({ highest: LINK2_VERSION, lowest: LINK2_VERSION }, theirs);
      // Hub reads nothing after the device's preamble until it has sent its own (§4.1).
      carrier.write(encodePreamble({ highest: LINK2_VERSION, lowest: LINK2_VERSION, selected }));
      if (selected === 0) return this.drop(pending);
      pending.preamble = null;
      bytes = joined.subarray(LINK2_PREAMBLE_BYTES);
    }
    let frames;
    try {
      frames = pending.decoder.push(bytes);
    } catch (error) {
      carrier.write(encodeClose(error instanceof LinkCloseError ? error.code : "protocol"));
      return this.drop(pending);
    }
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      if (frame.type === LINK2_FRAME.close) {
        // The device's own CLOSE `auth`: with two candidates, Hub proves with the other one next (§3.2).
        if (pending.hello !== null && parseClose(frame).code === "auth") this.candidates.get(pending.hello.device)?.closedAuth();
        return this.drop(pending);
      }
      if (frame.type !== LINK2_FRAME.handshake) continue;
      const object = parseJsonPayload(frame).object;
      if (pending.hello === null) {
        const hello = parseHello(object);
        if ("refused" in hello) return this.refuse(pending, "malformed", `hello: ${hello.why}`);
        if (this.devices.size + this.pending.size > LINK2_MAX_CONNECTIONS) return this.refuse(pending, "busy", "Hub is at its connection limit");
        const now = this.now();
        const counted = (this.counted.get(hello.device) ?? []).filter((at) => now - at < LINK2_REPLACED_WINDOW_MS);
        if (counted.length >= LINK2_REPLACED_COUNT) {
          // Two consoles share this device id; the count starts again after the hold.
          this.counted.delete(hello.device);
          this.duplicates.add(hello.device);
          return this.refuse(pending, "busy", "two consoles use this device id");
        }
        const record = this.store.get(hello.device);
        let keys = this.candidates.get(hello.device);
        if (keys === undefined && record !== undefined) {
          keys = new CandidateKeys([...record.keys]);
          this.candidates.set(hello.device, keys);
        }
        const key = keys?.toProve() ?? null;
        if (hello.companion !== this.id || record === undefined || key === null) return this.refuse(pending, "unknown_device", "this computer has to set the device up");
        pending.hello = hello;
        pending.nonce = newNonce();
        pending.key = key;
        carrier.write(encodeHandshake({ t: "challenge", nonce: pending.nonce, proof: companionProof(key, hello.nonce, pending.nonce, hello.device, this.id) }));
        continue;
      }
      const auth = parseAuth(object);
      const hello = pending.hello;
      if (auth === null || !proofEquals(consoleProof(pending.key, hello.nonce, pending.nonce, hello.device, this.id), auth.proof)) {
        return this.refuse(pending, "bad_proof", "the proof did not verify");
      }
      return this.ready(pending, frames.slice(index + 1));
    }
  }

  private ready(pending: Pending, rest: Parameters<Peer["replay"]>[0]): void {
    const hello = pending.hello as Link2Hello;
    const { carrier } = pending;
    pending.done = true;
    this.pending.delete(pending);
    // The first `ready` settles the candidates: the key that passed is the record's key.
    const keys = this.candidates.get(hello.device) ?? new CandidateKeys([pending.key]);
    keys.keys = [pending.key];
    keys.ready();
    this.candidates.set(hello.device, keys);
    this.unconfirmed.delete(hello.device);
    this.store.put({ id: hello.device, name: hello.name, model: hello.model, keys: [pending.key], target: hello.target, hostAbi: hello.hostAbi, lastAddress: carrier.remoteAddress, lastSeen: this.now() });
    const wall = Date.now();
    const offer = this.options.maxPayload ?? carrier.maxPayload;
    carrier.write(encodeHandshake({ t: "ready", name: this.options.name, features: this.features, maxPayload: offer, clock: { utc: wall, local: wall - new Date(wall).getTimezoneOffset() * 60_000 } }));
    const limit = payloadLimit(hello.maxPayload, offer);
    pending.decoder.ready(limit);
    const peer: Peer = new Peer({
      side: "hub",
      carrier,
      decoder: pending.decoder,
      limit,
      now: this.now,
      features: this.features,
      peerFeatures: hello.features,
      onClose: (info) => {
        device.ended(info);
        if (this.devices.get(device.id) === device) this.devices.delete(device.id);
        const lock = this.mutex.get(device.id);
        if (lock !== undefined && lock.until === null) this.mutex.delete(device.id);
      },
    });
    const device = new HubDevice(this, peer, hello, this.options);
    // One link per device: the older connection's requests, streams and channels end now,
    // and only its socket stays open, for the PONG that tells a live console from a half-open one.
    const older = this.devices.get(device.id);
    if (older !== undefined) {
      older.peer.retire();
      const entry = { device: older, at: this.now() };
      this.replaced.push(entry);
      older.peer.onPong = () => {
        const index = this.replaced.indexOf(entry);
        if (index < 0) return;
        this.replaced.splice(index, 1);
        const list = this.counted.get(device.id) ?? [];
        list.push(this.now());
        this.counted.set(device.id, list);
        older.peer.close("replaced");
      };
      older.peer.ping();
    }
    this.devices.set(device.id, device);
    // The device linked again: the hold after a `launching` reply ends.
    const lock = this.mutex.get(device.id);
    if (lock !== undefined && lock.until !== null) this.mutex.delete(device.id);
    this.options.onDevice?.(device);
    peer.replay(rest);
  }
}

export type { StreamReader, StreamWriter, AppletChannel, Daemon as LinkDaemon };
