// The Pocket Link companion (contracts/spec/link.ts): a TCP listener consoles
// connect to, a once-a-second UDP beacon that tells paired consoles where it
// is, pairing windows, and per-connection dispatch of net / catalog / install.

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import {
  LINK_BEACON_PORT,
  LINK_FEATURE,
  LINK_HANDSHAKE_TIMEOUT_MS,
  LINK_MAX_DATA,
  LINK_MAX_REQUESTS,
  LINK_PAIR_MAX_HOSTS,
  LINK_PAIR_WINDOW_MS,
  LINK_PORT,
  LINK_REFUSAL,
  LINK_SILENCE_MS,
  LINK_VERSION,
} from "../../contracts/spec/link.ts";
import { NET_ERROR } from "../../contracts/spec/net.ts";
import { AgentService, AGENT_LINK_FEATURE, type AgentLink, type AgentServiceOptions, type AgentSession } from "./agent.ts";
import { AppCatalog, PackageReader } from "./catalog.ts";
import { NetFailure, normalizeNetRequest, performNet, type NetRequest } from "./fetch.ts";
import {
  LinkFrameDecoder,
  LinkProtocolError,
  NONCE_RE,
  buildPairUri,
  companionProof,
  consoleProof,
  encodeBeacon,
  encodeCtrl,
  encodeData,
  encodePong,
  isLinkId,
  maskKey,
  newKey,
  newNonce,
  newPairSecret,
  proofEquals,
  type LinkCtrl,
} from "./protocol.ts";
import { CompanionStore, defaultCompanionName } from "./store.ts";

/** The companion's wall clock for the console (link.ts `clock`): UTC and
 *  local time in epoch milliseconds, so the offset never goes negative on
 *  the wire. */
function linkClock(): { utc: number; local: number } {
  const utc = Date.now();
  return { utc, local: utc - new Date(utc).getTimezoneOffset() * 60_000 };
}

export const LINK_FEATURES = [LINK_FEATURE.net, LINK_FEATURE.catalog, LINK_FEATURE.install];
/** Concurrent net requests one connection may hold open. */
export const LINK_MAX_NET = 8;
/** Failed pairing proofs before a window closes. */
const PAIR_MAX_FAILURES = 5;
const DEFAULT_TARGET = "3ds-dev";

export interface CompanionOptions {
  store: CompanionStore;
  name?: string;
  /** TCP port; LINK_PORT by default, 0 for an ephemeral one. */
  port?: number;
  /** Listen address; all interfaces by default. */
  host?: string;
  /** Apps directories in priority order; the store's apps dir is appended. */
  appsDirs?: string[];
  allowPrivate?: boolean;
  /** Extra beacon unicast targets. */
  unicast?: string[];
  /** false disables beacons; an object tunes them (tests). */
  beacon?: false | { port?: number; intervalMs?: number; broadcast?: boolean };
  /** Addresses for the pairing URI; non-internal IPv4 interfaces by default. */
  pairHosts?: string[];
  pairWindowMs?: number;
  /** Test seam for the net destination check. */
  resolve?: (host: string) => Promise<string[]>;
  log?: (line: string) => void;
  /** The console agent (contracts/spec/agent.ts); absent or false: off. */
  agent?: false | Partial<Omit<AgentServiceOptions, "storeDir" | "catalog" | "log">>;
}

export interface PairingWindow {
  secret: string;
  uri: string;
  expiresAt: number;
  failures: number;
}

export interface ConnectedConsole {
  id: string;
  name: string;
  model: string;
  target: string;
  address: string;
  since: number;
}

/** Non-internal IPv4 interfaces, Ethernet/Wi-Fi (en*) first, tunnels skipped. */
export function lanInterfaces(): { name: string; address: string; broadcast: string }[] {
  const out: { name: string; address: string; broadcast: string }[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/^(utun|awdl|llw|lo|gif|stf|anpi|ap|bridge|vmnet)\d*$/.test(name)) continue; // tunnels, peer links, VM bridges
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const addr = entry.address.split(".").map(Number);
      const mask = entry.netmask.split(".").map(Number);
      const broadcast = addr.map((a, i) => (a | (~mask[i] & 255)) & 255).join(".");
      out.push({ name, address: entry.address, broadcast });
    }
  }
  const rank = (name: string) => (name.startsWith("en") ? 0 : 1);
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "en", { numeric: true }));
}

const shortAddress = (address: string) => address.replace(/^::ffff:/, "");

export class Companion {
  readonly store: CompanionStore;
  readonly name: string;
  readonly catalog: AppCatalog;
  readonly agent: AgentService | null;
  private server: Server | undefined;
  private beaconSocket: UdpSocket | undefined;
  private beaconTimer: ReturnType<typeof setInterval> | undefined;
  private connections = new Set<LinkConnection>();
  private pairing: PairingWindow | undefined;
  private pairTimer: ReturnType<typeof setTimeout> | undefined;
  private cliDirs: string[];
  port = 0;

  constructor(readonly options: CompanionOptions) {
    this.store = options.store;
    this.name = options.name || defaultCompanionName();
    this.cliDirs = options.appsDirs ?? [];
    this.catalog = new AppCatalog(this.appsDirs(), () => this.catalogChanged(), (line) => this.log(line));
    this.agent = options.agent
      ? new AgentService({ ...options.agent, storeDir: this.store.dir, catalog: this.catalog, log: (line) => this.log(line) })
      : null;
  }

  /** The features a linked console is offered: the agent only when codex is usable. */
  features(): string[] {
    return this.agent?.available ? [...LINK_FEATURES, AGENT_LINK_FEATURE] : LINK_FEATURES;
  }

  log(line: string) {
    this.options.log?.(line);
  }

  private appsDirs(): string[] {
    return [...this.cliDirs, this.store.appsDir];
  }

  get id(): string {
    return this.store.id;
  }

  async start(): Promise<void> {
    const host = this.options.host ?? "0.0.0.0";
    const wanted = this.options.port ?? LINK_PORT;
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 32;
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const server = this.server!;
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host, port, exclusive: true });
      });
    try {
      this.port = await listen(wanted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || wanted === 0) throw error;
      this.log(`link: port ${wanted} in use, listening on an ephemeral port`);
      this.port = await listen(0);
    }
    this.log(`link: listening ${host}:${this.port} as ${this.id} "${this.name}"`);
    this.catalog.watch();
    if (this.options.beacon !== false) await this.startBeacons();
  }

  async stop(): Promise<void> {
    clearInterval(this.beaconTimer);
    clearTimeout(this.pairTimer);
    this.catalog.close();
    for (const connection of this.connections) connection.close("companion stopping");
    this.agent?.stop();
    this.beaconSocket?.close();
    this.beaconSocket = undefined;
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  // -------------------------------------------------------------------------
  // Beacons
  // -------------------------------------------------------------------------

  private async startBeacons() {
    const tuning = this.options.beacon || {};
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.beaconSocket = socket;
    socket.on("error", (error) => this.log(`beacon: ${error.message}`));
    await new Promise<void>((resolve) => socket.bind(0, () => resolve()));
    socket.setBroadcast(true);
    const send = () => this.sendBeacon(tuning.port ?? LINK_BEACON_PORT, tuning.broadcast ?? true);
    send();
    this.beaconTimer = setInterval(send, tuning.intervalMs ?? 1_000);
  }

  /** Every address one beacon goes to this second. */
  beaconTargets(broadcast = true): string[] {
    const targets = new Set<string>();
    if (broadcast) {
      targets.add("255.255.255.255");
      for (const iface of lanInterfaces()) targets.add(iface.broadcast);
    }
    for (const entry of this.store.consoles()) if (entry.lastAddress) targets.add(entry.lastAddress);
    for (const address of this.options.unicast ?? []) targets.add(address);
    return [...targets];
  }

  private sendBeacon(port: number, broadcast: boolean) {
    const socket = this.beaconSocket;
    if (!socket) return;
    const datagram = encodeBeacon({ pairing: this.pairingOpen(), port: this.port, companion: this.id, name: this.name });
    for (const target of this.beaconTargets(broadcast)) {
      try {
        socket.send(datagram, port, target, () => {});
      } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  pairHosts(): string[] {
    if (this.options.pairHosts?.length) return this.options.pairHosts.slice(0, LINK_PAIR_MAX_HOSTS);
    const hosts = [...new Set(lanInterfaces().map((iface) => iface.address))].slice(0, LINK_PAIR_MAX_HOSTS);
    return hosts.length ? hosts : ["127.0.0.1"];
  }

  pairingOpen(): boolean {
    return !!this.pairing && this.pairing.expiresAt > Date.now();
  }

  pairingWindow(): PairingWindow | undefined {
    return this.pairingOpen() ? this.pairing : undefined;
  }

  /** Open (or replace) a pairing window: a fresh single-use secret. */
  openPairing(): { uri: string; expiresAt: number } {
    const secret = newPairSecret();
    const windowMs = this.options.pairWindowMs ?? LINK_PAIR_WINDOW_MS;
    const uri = buildPairUri({ companion: this.id, hosts: this.pairHosts(), port: this.port, secret, name: this.name });
    this.pairing = { secret, uri, expiresAt: Date.now() + windowMs, failures: 0 };
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => this.closePairing("expired"), windowMs);
    this.pairTimer.unref?.();
    this.log(`pair: window open until ${new Date(this.pairing.expiresAt).toISOString()}`);
    return { uri, expiresAt: this.pairing.expiresAt };
  }

  closePairing(reason = "closed"): boolean {
    clearTimeout(this.pairTimer);
    if (!this.pairing) return false;
    this.pairing = undefined;
    this.log(`pair: window ${reason}`);
    return true;
  }

  /** The secret for a pair-mode hello, or null when no window is usable. */
  pairSecret(): string | null {
    return this.pairingOpen() ? this.pairing!.secret : null;
  }

  /** Consume the window's secret; false when it was used or expired meanwhile. */
  consumePairing(secret: string): boolean {
    if (!this.pairingOpen() || this.pairing!.secret !== secret) return false;
    this.closePairing("used");
    return true;
  }

  pairFailed(secret: string) {
    if (!this.pairing || this.pairing.secret !== secret) return;
    if (++this.pairing.failures >= PAIR_MAX_FAILURES) this.closePairing(`closed after ${PAIR_MAX_FAILURES} failed proofs`);
  }

  // -------------------------------------------------------------------------
  // Consoles
  // -------------------------------------------------------------------------

  forget(id: string): boolean {
    const removed = this.store.forget(id);
    for (const connection of this.connections) if (connection.device?.id === id) connection.close("forgotten");
    if (removed) this.log(`console ${id} forgotten`);
    return removed;
  }

  connected(): ConnectedConsole[] {
    const out: ConnectedConsole[] = [];
    for (const connection of this.connections) {
      if (!connection.ready || !connection.device) continue;
      out.push({ ...connection.device, address: connection.address, since: connection.since });
    }
    return out;
  }

  /** A console holds one link: a newer connection replaces an older one. */
  linked(connection: LinkConnection) {
    for (const other of this.connections) {
      if (other !== connection && other.ready && other.device?.id === connection.device?.id) other.close("replaced by a newer connection");
    }
  }

  setAppsDir(path: string) {
    this.store.setAppsDir(path);
    this.catalog.setDirectories(this.appsDirs());
    this.log(`catalog: apps dir ${path}`);
  }

  private catalogChanged() {
    this.log(`catalog: ${this.catalog.apps(DEFAULT_TARGET).length} apps for ${DEFAULT_TARGET}`);
    for (const connection of this.connections) if (connection.ready) connection.send({ t: "catalog.changed" });
  }

  private accept(socket: Socket) {
    const connection = new LinkConnection(this, socket);
    this.connections.add(connection);
    socket.on("close", () => this.connections.delete(connection));
  }

  status() {
    const window = this.pairingWindow();
    return {
      companion: {
        id: this.id,
        name: this.name,
        port: this.port,
        version: LINK_VERSION,
        addresses: lanInterfaces().map((iface) => iface.address),
        allowPrivate: !!this.options.allowPrivate,
      },
      consoles: this.connected(),
      paired: this.store.consoles().map(({ key: _key, ...entry }) => entry),
      apps: this.catalog.apps(DEFAULT_TARGET),
      appsDirs: this.catalog.directories,
      appsDir: this.store.appsDir,
      pairing: window ? { open: true, uri: window.uri, expiresAt: window.expiresAt } : { open: false },
    };
  }
}

// ---------------------------------------------------------------------------
// One console connection
// ---------------------------------------------------------------------------

interface NetPending {
  meta: Omit<NetRequest, "body">;
  expected: number;
  chunks: Uint8Array[];
  received: number;
  abort: AbortController;
  started: boolean;
}

class LinkConnection {
  readonly address: string;
  readonly since = Date.now();
  device: { id: string; name: string; model: string; target: string } | undefined;
  ready = false;
  private decoder: LinkFrameDecoder;
  private stage: "preamble" | "hello" | "auth" | "ready" | "closed" = "preamble";
  private preambleVersion = LINK_VERSION;
  private handshake: { mode: "connect" | "pair"; secret: string; nD: string; nC: string } | undefined;
  private lastRx = Date.now();
  private handshakeTimer: ReturnType<typeof setTimeout>;
  private silenceTimer: ReturnType<typeof setInterval> | undefined;
  private net = new Map<number, NetPending>();
  private installs = new Map<number, { cancelled: boolean }>();
  private drainWaiters: (() => void)[] = [];
  private agentSession: AgentSession | undefined;
  private agentLink: AgentLink | undefined;

  constructor(
    private readonly companion: Companion,
    private readonly socket: Socket,
  ) {
    this.address = shortAddress(socket.remoteAddress ?? "");
    socket.setNoDelay(true);
    this.decoder = new LinkFrameDecoder({
      preamble: true,
      onPreamble: (version) => {
        this.preambleVersion = version;
        this.stage = "hello";
      },
    });
    this.handshakeTimer = setTimeout(() => this.close("handshake timeout"), LINK_HANDSHAKE_TIMEOUT_MS);
    socket.on("data", (chunk) => this.receive(chunk as Buffer));
    socket.on("drain", () => {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const wake of waiters) wake();
    });
    socket.on("error", () => {});
    socket.on("close", () => this.closed());
  }

  send(message: LinkCtrl) {
    if (this.stage === "closed") return;
    this.socket.write(encodeCtrl(message));
  }

  /** Bytes on a data stream in LINK_MAX_DATA chunks, waiting on the socket. */
  async sendData(stream: number, bytes: Uint8Array): Promise<boolean> {
    for (let at = 0; at < bytes.length; at += LINK_MAX_DATA) {
      if (!(await this.write(encodeData(stream, bytes.subarray(at, at + LINK_MAX_DATA))))) return false;
    }
    return true;
  }

  /** Write a frame and wait while the socket buffer is full. */
  private async write(frame: Uint8Array): Promise<boolean> {
    if (this.stage === "closed") return false;
    if (this.socket.write(frame)) return true;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    return !this.isClosed();
  }

  /** Read through a method: the stage changes inside awaits and callbacks. */
  private isClosed(): boolean {
    return this.stage === "closed";
  }

  close(reason: string) {
    if (this.stage === "closed") return;
    if (this.ready) this.companion.log(`link: ${this.address} ${this.device?.name ?? ""} closed: ${reason}`);
    else this.companion.log(`link: ${this.address} dropped during handshake: ${reason}`);
    this.closed();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref?.();
  }

  private closed() {
    if (this.stage === "closed") return;
    this.stage = "closed";
    this.ready = false;
    clearTimeout(this.handshakeTimer);
    clearInterval(this.silenceTimer);
    for (const pending of this.net.values()) pending.abort.abort();
    this.net.clear();
    for (const install of this.installs.values()) install.cancelled = true;
    this.installs.clear();
    if (this.agentLink) this.agentSession?.detach(this.agentLink);
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const wake of waiters) wake();
  }

  private refuse(code: string, message: string) {
    this.send({ t: "refused", code, message });
    this.close(`refused ${code}: ${message}`);
  }

  private receive(chunk: Buffer) {
    if (this.stage === "closed") return;
    this.lastRx = Date.now();
    let frames;
    try {
      frames = this.decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (error) {
      this.close(error instanceof LinkProtocolError ? error.message : String(error));
      return;
    }
    for (const frame of frames) {
      if (this.isClosed()) return;
      if (frame.type === "ping") {
        this.socket.write(encodePong());
        continue;
      }
      if (frame.type === "pong" || frame.type === "unknown") continue;
      if (this.stage === "hello" || this.stage === "auth") {
        if (frame.type !== "ctrl") return this.close("data frame before the handshake finished");
        if (this.stage === "hello") this.hello(frame.message);
        else this.auth(frame.message);
        continue;
      }
      if (frame.type === "ctrl") this.request(frame.message);
      else this.data(frame.stream, frame.bytes);
    }
  }

  // --- handshake -------------------------------------------------------------

  private hello(message: LinkCtrl) {
    if (message.t !== "hello") return this.close(`expected hello, got ${message.t}`);
    if (this.preambleVersion !== LINK_VERSION || message.v !== LINK_VERSION) {
      return this.refuse(LINK_REFUSAL.version, `this companion speaks Pocket Link ${LINK_VERSION}`);
    }
    const { mode, device, companion, nonce } = message;
    if ((mode !== "connect" && mode !== "pair") || !isLinkId(device) || !isLinkId(companion) || typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      return this.close("malformed hello");
    }
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
    this.device = {
      id: device,
      name: text(message.name, 64),
      model: text(message.model, 32),
      target: text(message.target, 15) || DEFAULT_TARGET,
    };
    let secret: string | null;
    if (mode === "connect") {
      if (companion !== this.companion.id) return this.refuse(LINK_REFUSAL.unknownDevice, "this console is paired with another companion");
      secret = this.companion.store.console(device)?.key ?? null;
      if (!secret) return this.refuse(LINK_REFUSAL.unknownDevice, "this companion holds no key for the console; pair again");
    } else {
      secret = companion === this.companion.id ? this.companion.pairSecret() : null;
      if (!secret) return this.refuse(LINK_REFUSAL.pairingClosed, "no pairing window is open on this companion");
    }
    const nC = newNonce();
    this.handshake = { mode, secret, nD: nonce, nC };
    const inputs = { nD: nonce, nC, device, companion: this.companion.id };
    this.stage = "auth";
    this.send({ t: "challenge", nonce: nC, proof: companionProof(secret, inputs) });
  }

  private auth(message: LinkCtrl) {
    if (message.t !== "auth" || !this.handshake || !this.device) return this.close(`expected auth, got ${message.t}`);
    const { mode, secret, nD, nC } = this.handshake;
    const expected = consoleProof(secret, { nD, nC, device: this.device.id, companion: this.companion.id });
    if (!proofEquals(message.proof, expected)) {
      if (mode === "pair") this.companion.pairFailed(secret);
      return this.refuse(LINK_REFUSAL.badProof, "the console's proof did not verify");
    }
    const { store } = this.companion;
    if (mode === "connect") {
      store.touch(this.device.id, this.address, { name: this.device.name, model: this.device.model });
      this.becomeReady();
      this.send({ t: "ready", name: this.companion.name, features: this.companion.features(), clock: linkClock() });
      this.companion.log(`link: ${this.address} "${this.device.name}" (${this.device.model} ${this.device.id}) linked`);
    } else {
      if (!this.companion.consumePairing(secret)) return this.refuse(LINK_REFUSAL.pairingClosed, "the pairing secret expired or was used");
      const key = newKey();
      store.upsert({ id: this.device.id, name: this.device.name, model: this.device.model, key, lastAddress: this.address, lastSeen: Date.now() });
      this.becomeReady();
      this.send({ t: "paired", name: this.companion.name, key: maskKey(key, secret, nD, nC), features: this.companion.features(), clock: linkClock() });
      this.companion.log(`pair: ${this.address} "${this.device.name}" (${this.device.model} ${this.device.id}) paired`);
    }
    this.handshake = undefined;
  }

  private becomeReady() {
    clearTimeout(this.handshakeTimer);
    this.stage = "ready";
    this.ready = true;
    this.companion.linked(this);
    const device = this.device!;
    const link: AgentLink = { device, send: (message) => this.send(message), sendData: (stream, bytes) => this.sendData(stream, bytes) };
    this.agentLink = link;
    this.agentSession = this.companion.agent?.attach(link);
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastRx > LINK_SILENCE_MS) this.close(`silent for ${LINK_SILENCE_MS} ms`);
    }, 1_000);
  }

  // --- requests --------------------------------------------------------------

  private request(message: LinkCtrl) {
    const id = message.id;
    const validId = typeof id === "number" && Number.isInteger(id) && id >= 0 && id <= 0xffffffff;
    switch (message.t) {
      case "net":
        if (!validId) return;
        return this.netStart(id as number, message);
      case "net.cancel": {
        if (!validId) return;
        const pending = this.net.get(id as number);
        if (pending) {
          pending.abort.abort();
          this.net.delete(id as number);
        }
        return;
      }
      case "catalog":
        if (!validId) return;
        return this.send({ t: "catalog", id, apps: this.companion.catalog.apps(this.device!.target) });
      case "install":
        if (!validId) return;
        return void this.install(id as number, message.app);
      default:
        if (typeof message.t === "string" && message.t.startsWith("agent.")) this.agentSession?.handle(message);
        return; // other unknown ctrl types are ignored
    }
  }

  private netStart(id: number, message: LinkCtrl) {
    const error = (code: string, text: string) => this.send({ t: "net.error", id, code, message: text });
    if (this.net.has(id)) return error(NET_ERROR.invalidRequest, `request ${id} is already open`);
    if (this.net.size >= LINK_MAX_NET) return error(NET_ERROR.busy, `more than ${LINK_MAX_NET} requests open`);
    let meta;
    try {
      meta = normalizeNetRequest(message);
    } catch (failure) {
      const f = failure as NetFailure;
      return error(f.code ?? NET_ERROR.invalidRequest, f.message);
    }
    const { bytes, ...rest } = meta;
    const pending: NetPending = { meta: rest, expected: bytes, chunks: [], received: 0, abort: new AbortController(), started: false };
    this.net.set(id, pending);
    if (bytes === 0) void this.netRun(id, pending);
  }

  private data(stream: number, bytes: Uint8Array) {
    if (!this.net.has(stream) && this.agentSession?.data(stream, bytes)) return;
    const pending = this.net.get(stream);
    if (!pending || pending.started) return; // a cancelled or unknown stream
    pending.received += bytes.length;
    if (pending.received > pending.expected) return this.close(`request ${stream} sent more body than it declared`);
    pending.chunks.push(bytes);
    if (pending.received === pending.expected) void this.netRun(stream, pending);
  }

  private async netRun(id: number, pending: NetPending) {
    pending.started = true;
    const body = new Uint8Array(pending.received);
    let off = 0;
    for (const chunk of pending.chunks) {
      body.set(chunk, off);
      off += chunk.length;
    }
    pending.chunks = [];
    const started = Date.now();
    const label = `net ${pending.meta.method} ${pending.meta.url}`;
    try {
      const response = await performNet(
        { ...pending.meta, body },
        { allowPrivate: this.companion.options.allowPrivate, signal: pending.abort.signal, resolve: this.companion.options.resolve },
      );
      if (this.net.get(id) !== pending) return;
      this.companion.log(`${label} ${response.status} ${response.body.length}B ${Date.now() - started}ms`);
      this.send({ t: "net.head", id, status: response.status, url: response.url, headers: response.headers, bytes: response.body.length });
      for (let at = 0; at < response.body.length; at += LINK_MAX_DATA) {
        if (this.net.get(id) !== pending) return; // cancelled mid-stream: the console dropped the stream
        if (!(await this.write(encodeData(id, response.body.subarray(at, at + LINK_MAX_DATA))))) return;
      }
    } catch (failure) {
      if (this.net.get(id) !== pending) return;
      const f = failure instanceof NetFailure ? failure : new NetFailure(NET_ERROR.other, String(failure));
      this.companion.log(`${label} ${f.code}: ${f.message}`);
      this.send({ t: "net.error", id, code: f.code, message: f.message.slice(0, 200) });
    } finally {
      if (this.net.get(id) === pending) this.net.delete(id);
    }
  }

  private async install(id: number, app: unknown) {
    const error = (text: string) => this.send({ t: "install.error", id, message: text });
    if (typeof app !== "string") return error("install needs an app id");
    if (this.installs.has(id)) return error(`request ${id} is already open`);
    if (this.installs.size >= LINK_MAX_REQUESTS) return error(`more than ${LINK_MAX_REQUESTS} installs open`);
    const entry = this.companion.catalog.find(this.device!.target, app);
    if (!entry) return error(`${app} is not offered for ${this.device!.target}`);
    let reader: PackageReader;
    try {
      reader = new PackageReader(entry.path);
    } catch (failure) {
      return error(`cannot read ${app}: ${(failure as Error).message}`);
    }
    const state = { cancelled: false };
    this.installs.set(id, state);
    const started = Date.now();
    try {
      this.send({ t: "install.head", id, app, hash: reader.hash, bytes: reader.size });
      for (let chunk = reader.next(LINK_MAX_DATA); chunk; chunk = reader.next(LINK_MAX_DATA)) {
        if (state.cancelled || !(await this.write(encodeData(id, chunk)))) return;
      }
      this.companion.log(`install ${app} ${reader.size}B to "${this.device!.name}" ${Date.now() - started}ms`);
    } catch (failure) {
      // After install.head the stream length is promised; a read failure mid-stream leaves the
      // console's stream short, so the connection closes and the console fails the request.
      this.close(`install ${app} failed: ${(failure as Error).message}`);
    } finally {
      reader.close();
      this.installs.delete(id);
    }
  }
}
