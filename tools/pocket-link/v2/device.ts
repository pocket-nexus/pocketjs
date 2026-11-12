// Pocket Link 2, the device side in TypeScript (docs/POCKET-LINK.md): the
// reference peer for Hub's endpoint and the link of a desktop or sim host.
// Discovery by beacon or a direct address (§2.3), the handshake from the
// pairing files of a directory (§3), keepalive, backoff and holds (§2.4),
// and the device's part of §6 and §7: runtime operations answered by
// injected handlers, the DevTools stream, catalog and install, `net.http`
// and applet channels.
//
// Time comes from `now()`; `tick()` runs every timed rule. `start()` calls it
// on an interval for a host that has no loop of its own.

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join } from "node:path";
import {
  LINK2_APPS_INTERVAL_MS,
  LINK2_BACKOFF_MAX_MS,
  LINK2_BACKOFF_MIN_MS,
  LINK2_BEACON_PORT,
  LINK2_CHANNEL_BUSY_RETRY_MAX_MS,
  LINK2_CHANNEL_BUSY_RETRY_MIN_MS,
  LINK2_CHANNEL_REOPEN_MS,
  LINK2_COMPANIONS_DIR,
  LINK2_CONNECT_TIMEOUT_MS,
  LINK2_DEVICE_FILE,
  LINK2_DEVTOOLS_LINE_OUT,
  LINK2_DEVTOOLS_RING,
  LINK2_FEATURES,
  LINK2_FRAME,
  LINK2_HANDSHAKE_TIMEOUT_MS,
  LINK2_HTTP_HEADERS_BYTES,
  LINK2_HTTP_MAX_BODY,
  LINK2_HTTP_MAX_HEADERS,
  LINK2_HTTP_MIN_PAYLOAD,
  LINK2_HTTP_URL_BYTES,
  LINK2_HUB_REQUESTS,
  LINK2_INSTALL_MAX_BYTES,
  LINK2_LAST_SUFFIX,
  LINK2_LOG_OVERHEAD,
  LINK2_LOG_TEXT_BYTES,
  LINK2_NATIVE_MAX_BYTES,
  LINK2_NATIVE_MIN_BYTES,
  LINK2_PREAMBLE_BYTES,
  LINK2_PUSH_MAX_BYTES,
  LINK2_REFUSED_HOLD_MS,
  LINK2_SEARCH_DIRECT_MS,
  LINK2_TCP_PAYLOAD,
  LINK2_VERSION,
  LINK2_WINDOW,
  type Link2CatalogApp,
  type Link2ChannelCloseReason,
  type Link2Hello,
  type Link2InstalledApp,
  type Link2LogEvent,
  type Link2RuntimeApp,
  type Link2RuntimeStatus,
  type Link2ScreenshotSurface,
} from "../../../contracts/spec/link2.ts";
import { type Carrier, tcpCarrier } from "./carrier.ts";
import { CatalogFetch, pageRuntimeApps } from "./paging.ts";
import { type LoadedCompanion, formatDeviceFile, formatLastFile, lastFileUpdate, loadCompanions } from "./pairing.ts";
import {
  type AppletChannel,
  type AppletEventHandler,
  type AppletHandler,
  type Call,
  type ChannelConfig,
  type CloseInfo,
  DEVICE_CHANNEL,
  type IncomingCall,
  type Json,
  LinkError,
  Peer,
  type StreamReader,
  type StreamWriter,
} from "./peer.ts";
import {
  Link2FrameDecoder,
  LinkCloseError,
  acceptSelection,
  companionProof,
  consoleProof,
  decodeBeacon,
  decodePreamble,
  devicePreamble,
  encodeClose,
  encodeHandshake,
  encodedBytes,
  encodedPrefix,
  jsonBytes,
  newLinkId,
  newNonce,
  parseChallenge,
  parseJsonPayload,
  parseReady,
  parseRefused,
  payloadLimit,
  proofEquals,
} from "./protocol.ts";
import { Responder } from "./requests.ts";

export interface RuntimeHandlers {
  status(): Link2RuntimeStatus;
  /** The whole package arrived; admit it. A LinkError `rejected` refuses it. */
  push?(request: { bytes: number; hash: string }, body: Uint8Array): Promise<{ generation: number; message: string; app: Link2RuntimeApp }>;
  /** The whole `.3dsx` arrived and its CRC-32 matched. */
  nativeInstall?(request: { name: string; launch: boolean }, body: Uint8Array): Promise<{ phase: "installed" | "staged" | "launching"; path: string }>;
  launch?(request: { native?: string; app?: string }): Promise<Json>;
  screenshot?(): { frame: number; surfaces: (Link2ScreenshotSurface & { pixels: Uint8Array })[] };
}

export interface DeviceOptions {
  /** The link directory: `device.txt` and `companions/` (3DS: sdmc:/pocketjs/link). */
  dir: string;
  name: string;
  model: string;
  target: string;
  hostAbi: number;
  /** The groups this device serves or uses (§6.1). Default: every group. */
  features?: string[];
  /** What this device offers as `maxPayload` (§4.4). */
  maxPayload?: number;
  now?: () => number;
  /** UDP port for beacons; null listens for none (the direct try alone). */
  beaconPort?: number | null;
  /** Opens the carrier to a Hub. Default: one TCP connection. */
  connect?: (address: string, port: number) => Promise<Carrier>;
  runtime?: RuntimeHandlers;
  /** The applet host's budgets (§7.3); `auto: false` leaves hand-over to `frame()` calls. */
  channel?: Partial<ChannelConfig>;
  onLinked?: (hub: { id: string; name: string }) => void;
  onUnlinked?: (info: CloseInfo | { by: "handshake"; code: string; reason: string }) => void;
}

type Phase = "idle" | "search" | "connecting" | "handshake" | "linked" | "backoff";

/** The guest's view of one applet's channel across opens (§7.1, §7.5): it
 *  keeps the handlers and opens again by the device's retry rules. */
export class GuestChannel {
  private current: AppletChannel | null = null;
  private opening: Call | null = null;
  private wanted = true;
  private blocked: string | null = null;
  private nextOpenAt = 0;
  private busyWait = 0;
  private lastReason: string | null = null;
  private readonly handlers = new Map<string, AppletHandler>();
  private readonly eventHandlers = new Map<string, AppletEventHandler>();
  private ended = false;
  /** Generations this run of the applet was given, oldest first. */
  readonly generations: number[] = [];
  /** Called when a channel opens. */
  onOpen: ((generation: number) => void) | null = null;

  constructor(private readonly device: LinkDevice, readonly app: string, readonly hash: string) {}

  state(): { state: "closed" | "opening" | "open"; reason: string | null } {
    if (this.current !== null) return { state: "open", reason: null };
    return { state: this.opening !== null ? "opening" : "closed", reason: this.lastReason };
  }
  /** The open channel, for stream handles, units and `frame()`. */
  get channel(): AppletChannel | null {
    return this.current;
  }
  request(t: string, args: Json = {}, options: Parameters<AppletChannel["request"]>[2] = {}): Call {
    if (this.current === null) {
      this.use();
      const reply = Promise.reject(new LinkError("no_channel"));
      reply.catch(() => {});
      return { id: 0, reply, cancel() {}, body: null, response: null };
    }
    return this.current.request(t, args, options);
  }
  on(t: string, handler: AppletHandler): void {
    this.handlers.set(t, handler);
    this.current?.on(t, handler);
  }
  emit(t: string, args: Json = {}): boolean {
    if (this.current === null) {
      this.use();
      return false;
    }
    return this.current.emit(t, args);
  }
  emitStream(t: string, args: Json = {}): StreamWriter | null {
    return this.current?.emitStream(t, args) ?? null;
  }
  onEvent(t: string, handler: AppletEventHandler): void {
    this.eventHandlers.set(t, handler);
    this.current?.onEvent(t, handler);
  }
  /** One frame of the guest's loop, when the host does not run frames itself. */
  frame(): { messages: number; bytes: number } {
    return this.current?.frame() ?? { messages: 0, bytes: 0 };
  }
  /** The applet exits or is switched away: `channel.close` `exit`, and no reopen. */
  exit(): void {
    this.ended = true;
    this.shut("exit");
    this.device.forgetChannel(this);
  }
  /** The applet's realm was reset: `channel.close` `reset`, then a new `channel.open`. */
  reset(): void {
    this.shut("reset");
    this.blocked = null;
    this.busyWait = 0;
    this.nextOpenAt = 0;
    this.wanted = true;
    this.pump();
  }

  /** @internal The applet used the channel while it was closed. */
  private use(): void {
    this.wanted = true;
    this.pump();
  }
  private shut(reason: Link2ChannelCloseReason): void {
    if (this.opening !== null) {
      // The accepting REPLY may cross this CANCEL: `opened` then closes at once (§7.1).
      this.opening.cancel();
      this.opening = null;
    }
    const channel = this.current;
    this.current = null;
    channel?.close(reason);
  }
  /** @internal A new connection is `ready`, or `channel` came into use again. */
  relinked(): void {
    this.current = null;
    this.opening = null;
    this.blocked = null;
    this.busyWait = 0;
    this.nextOpenAt = 0;
    this.wanted = true;
  }
  /** @internal */
  unlinked(): void {
    this.current = null;
    this.opening = null;
    this.lastReason = "connection";
  }
  /** @internal Opens when the rules allow it. */
  pump(): void {
    const peer = this.device.peer;
    if (this.ended || this.current !== null || this.opening !== null || !this.wanted || this.blocked !== null) return;
    if (peer === null || !peer.inUse("channel")) return;
    const now = this.device.now();
    if (now < this.nextOpenAt) return;
    this.nextOpenAt = now + LINK2_CHANNEL_REOPEN_MS;
    const opened = (reply: Json) => {
      const mine = this.opening === call;
      if (mine) this.opening = null;
      const generation = typeof reply.generation === "number" ? reply.generation : 0;
      const channel = peer.addChannel(call.id, this.app, this.hash, generation, { ...DEVICE_CHANNEL, ...this.device.channelConfig });
      // The accepting REPLY crossed this side's CANCEL: the new channel closes at once (§7.1).
      if (!mine || this.ended) return channel.close("exit");
      // The device sends its own grant right after it reads that REPLY.
      channel.grantUnits();
      for (const [t, handler] of this.handlers) channel.on(t, handler);
      for (const [t, handler] of this.eventHandlers) channel.onEvent(t, handler);
      channel.onClose((reason) => {
        if (this.current !== channel) return;
        this.current = null;
        this.lastReason = reason;
        // A close that leaves the applet running: open again when the applet uses the channel.
        this.wanted = false;
      });
      this.current = channel;
      this.busyWait = 0;
      this.generations.push(generation);
      this.onOpen?.(generation);
    };
    const call: Call = peer.request({ t: "channel.open", app: this.app, hash: this.hash }, { feature: "channel", outlives: true, onReply: opened });
    this.opening = call;
    call.reply.then(
      () => {},
      (error: LinkError) => {
        if (this.opening !== call) return;
        this.opening = null;
        this.lastReason = error.code;
        if (error.code === "busy") {
          this.busyWait = this.busyWait === 0 ? LINK2_CHANNEL_BUSY_RETRY_MIN_MS : Math.min(this.busyWait * 2, LINK2_CHANNEL_BUSY_RETRY_MAX_MS);
          this.nextOpenAt = this.device.now() + this.busyWait;
        } else if (error.code === "closed" || error.code === "cancelled" || error.code === "timeout") {
          // The connection or the attempt ended; the next `ready` or the next use opens again.
        } else {
          // no_daemon, rejected, malformed: not during this applet run. unsupported: until `channel` is in use again.
          this.blocked = error.code;
        }
      },
    );
  }
}

/** The device end of Pocket Link 2. */
export class LinkDevice {
  readonly now: () => number;
  readonly id: string;
  readonly channelConfig: Partial<ChannelConfig>;
  /** The link, while one is up. */
  peer: Peer | null = null;
  /** The Hub this device is linked to. */
  hub: { id: string; name: string; clock: { utc: number; local: number } } | null = null;
  /** Counters and the last errors, as `link_status_json` reports them. */
  readonly status = { phase: "idle" as Phase, links: 0, refusals: [] as string[], closes: [] as string[], error: null as string | null };

  private readonly options: DeviceOptions;
  private companions: LoadedCompanion[] = [];
  private features: string[];
  private udp: UdpSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private phaseSince = 0;
  private backoff = LINK2_BACKOFF_MIN_MS;
  private backoffUntil = 0;
  private readonly holds = new Map<string, number>();
  private directTurn = 0;
  private attempt = 0;
  private carrier: Carrier | null = null;
  private stopped = false;

  private readonly channels = new Set<GuestChannel>();
  private readonly hubRequests = new Responder(LINK2_HUB_REQUESTS);
  private stateBusy = false;
  private shotBusy = false;
  private logsOn = false;
  private logsDropped = 0;
  private apps: Link2InstalledApp[] | null = null;
  private appsSet = 0;
  private appsSentAt = Number.NEGATIVE_INFINITY;
  private appsDirty = false;
  private readonly catalogFetch = new CatalogFetch();
  private catalogWaiters: { resolve: (rows: Link2CatalogApp[]) => void; reject: (error: LinkError) => void }[] = [];
  private catalogNext: typeof this.catalogWaiters = [];

  /** The DevTools stream of §6.3, as the shim's transport sees it. */
  readonly devtools: {
    /** Hand lines to `onLine` as they arrive; false leaves them in the ring for `poll()`. */
    autoPoll: boolean;
    /** `devtools.listen`: the shim's `listening()`. */
    listening: boolean;
    onLine: ((line: string) => void) | null;
    /** The next whole line of the ring, or null: `ui.__dbgPoll`. */
    poll(): string | null;
    /** One line toward Hub: `ui.__dbgSend`. */
    send(line: string): void;
    /** Bytes the line ring holds. */
    readonly ringBytes: number;
    /** True while the stream toward Hub is open. */
    readonly open: boolean;
    /** @internal Bytes of the Hub-to-device stream, as the stream's reader hands them in. */
    feed(bytes: Uint8Array): Promise<void>;
  };
  private devtoolsCall: Call | null = null;
  private devtoolsOut: StreamWriter | null = null;
  private ring: { bytes: Uint8Array; taken: () => void }[] = [];
  private ringPartial: Uint8Array[] = [];
  private ringSkipToNewline = false;
  private devtoolsHello: string | null = null;

  /** `catalog.changed` arrived. */
  onCatalogChanged: (() => void) | null = null;
  /** A system event with no handler of its own here (the agent's messages). */
  onSystemEvent: ((object: Json) => void) | null = null;

  constructor(options: DeviceOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.channelConfig = options.channel ?? {};
    this.features = options.features ?? [...LINK2_FEATURES];
    this.id = this.loadDeviceId();
    const device = this;
    this.devtools = {
      autoPoll: true,
      listening: false,
      onLine: null,
      poll: () => device.devtoolsPoll(),
      send: (line) => device.devtoolsSend(line),
      get ringBytes() {
        return device.ring.reduce((sum, item) => sum + item.bytes.length, 0) + device.ringPartial.reduce((sum, item) => sum + item.length, 0);
      },
      get open() {
        return device.devtoolsOut !== null && !device.devtoolsOut.done;
      },
      feed: (bytes: Uint8Array) => device.devtoolsBytes(bytes),
    } as LinkDevice["devtools"];
    this.reload();
  }

  /** Reads `device.txt`, making one when the directory holds none (§3.6). */
  private loadDeviceId(): string {
    const path = join(this.options.dir, LINK2_DEVICE_FILE);
    try {
      const id = readFileSync(path, "utf8").replace(/[\n\r ]+$/, "");
      if (/^[0-9a-f]{16}$/.test(id)) return id;
    } catch {
      // No file: make one below.
    }
    const id = newLinkId();
    mkdirSync(join(this.options.dir, LINK2_COMPANIONS_DIR), { recursive: true });
    writeFileSync(path, formatDeviceFile(id));
    return id;
  }
  /** Reads the pairing files again, as the program does when it starts. */
  reload(): void {
    const dir = join(this.options.dir, LINK2_COMPANIONS_DIR);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    const entries = names.map((name) => {
      let text = "";
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        text = "";
      }
      return { name, text };
    });
    const loaded = loadCompanions(entries);
    this.companions = loaded.companions;
    this.status.error = loaded.error;
    if (this.status.phase === "idle" && this.companions.length > 0) this.enter("search");
  }
  get paired(): LoadedCompanion[] {
    return this.companions;
  }

  /** Listens for beacons and runs `tick()` on an interval. */
  start(intervalMs = 100): void {
    this.listen();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }
  /** Opens the beacon socket alone, for a host that calls `tick()` itself. */
  listen(): void {
    const port = this.options.beaconPort === undefined ? LINK2_BEACON_PORT : this.options.beaconPort;
    if (port === null || this.udp !== null) return;
    const udp = createSocket({ type: "udp4", reuseAddr: true });
    udp.on("error", () => {});
    udp.on("message", (message, from) => this.beacon(new Uint8Array(message), from.address));
    udp.bind(port);
    this.udp = udp;
  }
  /** Ends the link with `going_away` and stops searching. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.udp?.close();
    this.udp = null;
    this.peer?.close("going_away", "the device stops");
    this.carrier?.close();
  }

  // --- discovery, backoff and holds (§2.3, §2.4) ---------------------------

  private enter(phase: Phase): void {
    this.status.phase = phase;
    this.phaseSince = this.now();
  }
  private held(hubId: string): boolean {
    const until = this.holds.get(hubId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.holds.delete(hubId);
    return false;
  }
  private beacon(bytes: Uint8Array, address: string): void {
    const beacon = decodeBeacon(bytes);
    // While linked or backing off the socket is drained and beacons are not followed.
    if (beacon === null || this.status.phase !== "search") return;
    const companion = this.companions.find((c) => c.id === beacon.companion);
    if (companion === undefined || this.held(companion.id)) return;
    this.dial(companion, address, beacon.port);
  }
  /** Connects to a paired Hub at an address now, as a beacon would make it. */
  connectTo(hubId: string, address: string, port: number): void {
    const companion = this.companions.find((c) => c.id === hubId);
    if (companion !== undefined && this.status.phase === "search") this.dial(companion, address, port);
  }

  /** Runs the timed rules of the device and of its link. */
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    switch (this.status.phase) {
      case "idle":
        break;
      case "search": {
        // The direct try: a paired Hub's last address, one pairing per attempt in turn.
        if (now - this.phaseSince < LINK2_SEARCH_DIRECT_MS) break;
        const candidates = this.companions.filter((c) => c.address !== "" && !this.held(c.id));
        if (candidates.length === 0) break;
        const companion = candidates[this.directTurn++ % candidates.length];
        this.dial(companion, companion.address, companion.port);
        break;
      }
      case "connecting":
        if (now - this.phaseSince >= LINK2_CONNECT_TIMEOUT_MS) this.dropped("connect timeout");
        break;
      case "handshake":
        if (now - this.phaseSince >= LINK2_HANDSHAKE_TIMEOUT_MS) {
          this.carrier?.write(encodeClose("handshake_timeout"));
          this.dropped("handshake timeout");
        }
        break;
      case "backoff":
        if (now >= this.backoffUntil) this.enter(this.companions.length === 0 ? "idle" : "search");
        break;
      case "linked":
        this.peer?.tick();
        this.linkedTick();
        break;
    }
  }
  private dropped(why: string): void {
    this.attempt += 1;
    const carrier = this.carrier;
    this.carrier = null;
    carrier?.close();
    this.status.closes.push(why);
    this.backoffUntil = this.now() + this.backoff;
    this.backoff = Math.min(this.backoff * 2, LINK2_BACKOFF_MAX_MS);
    this.enter("backoff");
  }

  private dial(companion: LoadedCompanion, address: string, port: number): void {
    const attempt = ++this.attempt;
    this.enter("connecting");
    const open = this.options.connect ?? defaultConnect;
    open(address, port).then(
      (carrier) => {
        if (attempt !== this.attempt || this.stopped) return carrier.close();
        this.handshake(companion, carrier, address, port);
      },
      () => {
        if (attempt === this.attempt) this.dropped("connect failed");
      },
    );
  }

  // --- the handshake (§3.3) ------------------------------------------------

  private handshake(companion: LoadedCompanion, carrier: Carrier, address: string, port: number): void {
    const attempt = this.attempt;
    this.carrier = carrier;
    this.enter("handshake");
    const hello: Link2Hello = {
      t: "hello",
      device: this.id,
      companion: companion.id,
      nonce: newNonce(),
      name: encodedPrefix(this.options.name, 64),
      model: encodedPrefix(this.options.model, 32),
      target: this.options.target,
      hostAbi: this.options.hostAbi,
      features: this.features,
      maxPayload: this.options.maxPayload ?? carrier.maxPayload ?? LINK2_TCP_PAYLOAD,
    };
    const decoder = new Link2FrameDecoder();
    let preamble: Uint8Array | null = new Uint8Array(0);
    let proved = false;
    const hold = (code: string, reason: string) => {
      this.holds.set(companion.id, this.now() + LINK2_REFUSED_HOLD_MS);
      this.options.onUnlinked?.({ by: "handshake", code, reason });
    };
    carrier.onClose = () => {
      if (attempt === this.attempt && this.status.phase === "handshake") this.dropped("closed in the handshake");
    };
    carrier.onData = (chunk) => {
      if (attempt !== this.attempt) return;
      let bytes = chunk;
      if (preamble !== null) {
        const joined = new Uint8Array(preamble.length + bytes.length);
        joined.set(preamble);
        joined.set(bytes, preamble.length);
        if (joined.length < LINK2_PREAMBLE_BYTES) {
          preamble = joined;
          return;
        }
        const theirs = decodePreamble(joined.subarray(0, LINK2_PREAMBLE_BYTES));
        if (theirs === null || acceptSelection({ highest: LINK2_VERSION, lowest: LINK2_VERSION }, theirs) === null) {
          this.status.error = theirs === null ? "not a Pocket Link preamble" : `Hub speaks Pocket Link ${theirs.lowest}–${theirs.highest}`;
          return this.dropped("no common version");
        }
        preamble = null;
        bytes = joined.subarray(LINK2_PREAMBLE_BYTES);
      }
      decoder.write(bytes);
      // One frame at a time: `ready` puts the negotiated limit in force before the
      // bytes behind it are read, also when Hub's first frame came in the same read (§3.3).
      for (;;) {
        let frame;
        try {
          frame = decoder.next();
        } catch (error) {
          carrier.write(encodeClose(error instanceof LinkCloseError ? error.code : "protocol"));
          return this.dropped("a bad frame in the handshake");
        }
        if (frame === null) return;
        if (frame.type === LINK2_FRAME.close) return this.dropped("Hub closed the handshake");
        if (frame.type !== LINK2_FRAME.handshake) continue;
        const object = parseJsonPayload(frame).object;
        const refusal = parseRefused(object);
        if (refusal !== null) {
          this.status.refusals.push(refusal.code);
          hold(refusal.code, refusal.message);
          return this.dropped(`refused: ${refusal.code}`);
        }
        const challenge = parseChallenge(object);
        if (challenge !== null && !proved) {
          const expected = companionProof(companion.key, hello.nonce, challenge.nonce, this.id, companion.id);
          if (!proofEquals(expected, challenge.proof)) {
            // The Hub at that address does not hold this device's key, or tried its other candidate (§3.8).
            carrier.write(encodeClose("auth"));
            hold("auth", "the Hub's proof did not verify");
            return this.dropped("auth");
          }
          proved = true;
          carrier.write(encodeHandshake({ t: "auth", proof: consoleProof(companion.key, hello.nonce, challenge.nonce, this.id, companion.id) }));
          continue;
        }
        if (object !== null && object.t === "ready" && proved) {
          let ready;
          try {
            ready = parseReady(object);
          } catch {
            carrier.write(encodeClose("protocol"));
            return this.dropped("a bad ready");
          }
          const limit = payloadLimit(hello.maxPayload, ready.maxPayload);
          decoder.ready(limit);
          return this.linked(companion, carrier, decoder, limit, ready, address, port);
        }
        carrier.write(encodeClose("protocol"));
        return this.dropped("an unexpected handshake message");
      }
    };
    // A device whose range is one version sends its preamble and its hello in the same write (§4.1).
    const first = devicePreamble();
    const frame = encodeHandshake(hello);
    const both = new Uint8Array(first.length + frame.length);
    both.set(first);
    both.set(frame, first.length);
    carrier.write(both);
  }

  private linked(companion: LoadedCompanion, carrier: Carrier, decoder: Link2FrameDecoder, limit: number, ready: ReturnType<typeof parseReady>, address: string, port: number): void {
    this.backoff = LINK2_BACKOFF_MIN_MS;
    this.status.links += 1;
    this.hub = { id: companion.id, name: ready.name, clock: ready.clock };
    // What changed at this `ready` goes to the `.last` file; the key file is never written (§3.6).
    const update = lastFileUpdate(companion, { name: ready.name, address, port });
    if (update !== null) {
      const path = join(this.options.dir, LINK2_COMPANIONS_DIR, companion.id + LINK2_LAST_SUFFIX);
      writeFileSync(`${path}.tmp`, update);
      renameSync(`${path}.tmp`, path);
      companion.name = ready.name;
      companion.address = address;
      companion.port = port;
    }
    const peer = new Peer({
      side: "device",
      carrier,
      decoder,
      limit,
      now: this.now,
      features: this.features,
      peerFeatures: ready.features,
      onClose: (info) => this.unlinked(peer, info),
      onFeatures: (came) => this.groupsCame(came),
    });
    this.peer = peer;
    this.carrier = null;
    this.enter("linked");
    this.wire(peer);
    this.options.onLinked?.({ id: companion.id, name: ready.name });
    this.groupsCame(this.features.filter((f) => peer.inUse(f)), true);
    // Bytes behind `ready` that came in its read: Hub may send as soon as it has written `ready`.
    peer.readBuffered();
  }

  private unlinked(peer: Peer, info: CloseInfo): void {
    if (this.peer !== peer) return;
    this.peer = null;
    this.hub = null;
    this.devtoolsCall = null;
    this.devtoolsOut = null;
    this.ring = [];
    this.ringPartial = [];
    this.stateBusy = false;
    this.shotBusy = false;
    this.logsOn = false;
    for (const channel of this.channels) channel.unlinked();
    const waiters = [...this.catalogWaiters, ...this.catalogNext];
    this.catalogWaiters = [];
    this.catalogNext = [];
    for (const waiter of waiters) waiter.reject(new LinkError("closed"));
    this.status.closes.push(info.code ?? info.by);
    this.options.onUnlinked?.(info);
    if (this.stopped) return;
    if (info.by === "local" && info.code === "restart") return this.enter("search");
    this.backoffUntil = this.now() + this.backoff;
    this.backoff = Math.min(this.backoff * 2, LINK2_BACKOFF_MAX_MS);
    this.enter("backoff");
  }

  /** A group came into use: its connection-start steps run (§6.1). */
  private groupsCame(groups: string[], atReady = false): void {
    const peer = this.peer;
    if (peer === null) return;
    if (atReady && groups.includes("runtime") && this.options.runtime) peer.event({ t: "runtime.status", ...this.options.runtime.status() });
    if (groups.includes("apps")) {
      this.appsDirty = this.apps !== null;
      this.appsSentAt = Number.NEGATIVE_INFINITY;
      this.reportApps();
    }
    if (groups.includes("devtools")) this.devtoolsOpen();
    if (groups.includes("channel")) {
      for (const channel of this.channels) {
        channel.relinked();
        channel.pump();
      }
    }
  }
  private linkedTick(): void {
    this.reportApps();
    for (const channel of this.channels) channel.pump();
  }

  // --- features ------------------------------------------------------------

  /** This device's list changes on a live link (§6.1), for instance when a
   *  guest switch brings a guest with or without the DevTools shim. */
  setFeatures(list: string[]): void {
    this.features = [...list];
    this.peer?.setFeatures(list);
  }

  // --- runtime operations (§6.2) -------------------------------------------

  private wire(peer: Peer): void {
    const runtime = this.options.runtime;
    const stateSlot = async <T>(work: () => Promise<T>): Promise<T> => {
      if (this.stateBusy) throw new LinkError("busy", "a state-changing request is open");
      this.stateBusy = true;
      try {
        return await work();
      } finally {
        this.stateBusy = false;
      }
    };
    const collect = async (call: IncomingCall, total: number) => {
      const body = new Uint8Array(total);
      let at = 0;
      await call.readBody({
        window: LINK2_WINDOW.bulk,
        total,
        onData: (bytes) => {
          if (at + bytes.length <= total) body.set(bytes, at);
          at += bytes.length;
        },
      });
      return body;
    };
    const restart = (call: IncomingCall, reply: Json) => {
      // The REPLY, then CLOSE `restart`; the device exits into the file (§6.2).
      void call.reply(reply).then(() => peer.close("restart", "starting a .3dsx"));
    };
    const bound = { feature: "runtime", bound: this.hubRequests };

    peer.handle("runtime.status", () => {
      if (!runtime) throw new LinkError("unsupported");
      return { ...runtime.status() };
    }, bound);

    peer.handle("runtime.push", (call) => stateSlot(async () => {
      if (!runtime?.push) throw new LinkError("unsupported", "this device accepts no package");
      const { bytes, hash } = call.args as { bytes?: unknown; hash?: unknown };
      if (typeof bytes !== "number" || !Number.isInteger(bytes) || typeof hash !== "string" || !/^[0-9a-f]{16}$/.test(hash)) throw new LinkError("malformed");
      if (bytes < 1 || bytes > LINK2_PUSH_MAX_BYTES) throw new LinkError("too_large");
      const event = (phase: string) => call.progress({ t: "runtime.install", phase, hash, generation: runtime.status().generation, message: "" });
      event("receiving");
      const body = await collect(call, bytes);
      event("received");
      const done = await runtime.push({ bytes, hash }, body);
      event("staged");
      return { phase: "accepted", hash, generation: done.generation, message: done.message, app: done.app };
    }), bound);

    peer.handle("runtime.native.install", (call) => stateSlot(async () => {
      if (!runtime?.nativeInstall) throw new LinkError("unsupported");
      const { name, bytes, crc32, launch } = call.args as { name?: unknown; bytes?: unknown; crc32?: unknown; launch?: unknown };
      if (typeof name !== "string" || !validNativeName(name) || typeof bytes !== "number" || !Number.isInteger(bytes) || typeof crc32 !== "number") throw new LinkError("malformed");
      if (bytes < LINK2_NATIVE_MIN_BYTES || bytes > LINK2_NATIVE_MAX_BYTES) throw new LinkError("too_large");
      call.progress({ t: "runtime.native", phase: "receiving", name });
      const body = await collect(call, bytes);
      if (Bun.hash.crc32(body) >>> 0 !== crc32 >>> 0) throw new LinkError("rejected", "the CRC-32 does not match");
      if (body[0] !== 0x33 || body[1] !== 0x44 || body[2] !== 0x53 || body[3] !== 0x58) throw new LinkError("rejected", "not a 3DSX file");
      const done = await runtime.nativeInstall({ name, launch: launch === true }, body);
      const reply = { phase: done.phase, name, path: done.path };
      if (done.phase !== "launching") return reply;
      restart(call, reply);
      return new Promise<Json>(() => {});
    }), { feature: "runtime.native", bound: this.hubRequests });

    peer.handle("runtime.launch", (call) => stateSlot(async () => {
      if (!runtime?.launch) throw new LinkError("unsupported");
      const { native, app } = call.args as { native?: unknown; app?: unknown };
      if ((typeof native === "string") === (typeof app === "string")) throw new LinkError("malformed", "one of native and app");
      if (typeof native === "string" && (!peer.inUse("runtime.native") || !validNativeName(native))) throw new LinkError(peer.inUse("runtime.native") ? "malformed" : "unsupported");
      const reply = await runtime.launch(typeof native === "string" ? { native } : { app: app as string });
      if (reply.phase !== "launching") return reply;
      restart(call, reply);
      return new Promise<Json>(() => {});
    }), bound);

    peer.handle("runtime.screenshot", async (call) => {
      if (!runtime?.screenshot) throw new LinkError("unsupported");
      if (this.shotBusy) throw new LinkError("busy", "one screenshot at a time");
      this.shotBusy = true;
      try {
        const shot = runtime.screenshot();
        call.progress({ t: "runtime.screenshot", frame: shot.frame, format: "bgr8-rotated", surfaces: shot.surfaces.map(({ pixels: _pixels, ...surface }) => surface) });
        const out = call.respond();
        for (const surface of shot.surfaces) await out.writeAll(surface.pixels);
        out.end();
        await out.finished;
        return { frame: shot.frame };
      } finally {
        this.shotBusy = false;
      }
    }, bound);

    peer.handle("runtime.logs", (call) => {
      this.logsOn = call.args.on === true;
      return {};
    }, bound);

    peer.onEvent("devtools.listen", (object) => {
      this.devtools.listening = object.on === true;
    }, { feature: "devtools" });
    peer.onEvent("catalog.changed", () => this.onCatalogChanged?.(), { feature: "catalog" });
    for (const t of ["agent.state", "agent.transcript", "agent.request", "agent.delta", "agent.step", "agent.tool", "agent.usage", "agent.done", "agent.error"]) {
      peer.onEvent(t, (object) => this.onSystemEvent?.(object), { feature: "agent" });
    }
    for (const entry of this.streamEvents) peer.onEvent(entry.t, (object, open) => entry.handler(object, open), { feature: entry.feature });
  }

  /** The dev menu's screenshot: the same event unsolicited, with a fresh stream id (§6.2). */
  sendScreenshot(): StreamWriter | null {
    const peer = this.peer;
    const shot = this.options.runtime?.screenshot?.();
    if (peer === null || !shot || !peer.inUse("runtime")) return null;
    const out = peer.eventStream({ t: "runtime.screenshot", frame: shot.frame, format: "bgr8-rotated", surfaces: shot.surfaces.map(({ pixels: _pixels, ...surface }) => surface) }, { feature: "runtime" });
    void (async () => {
      try {
        for (const surface of shot.surfaces) await out.writeAll(surface.pixels);
        out.end();
      } catch {
        // Hub refused the stream: the buffers are free again.
      }
    })();
    return out;
  }

  /** One log line, sent while `runtime.logs` is on. The text is cut to 1 KiB
   *  and to the payload limit minus 96 bytes, on a code point. */
  log(level: Link2LogEvent["level"], source: Link2LogEvent["source"], text: string, frame: number): boolean {
    const peer = this.peer;
    if (peer === null || !this.logsOn || !peer.inUse("runtime")) return false;
    const event: Json & { t: string } = { t: "log", level, source, text: encodedPrefix(text, Math.min(LINK2_LOG_TEXT_BYTES, peer.limit - LINK2_LOG_OVERHEAD)), frame: frame >>> 0 };
    if (this.logsDropped > 0) event.dropped = this.logsDropped;
    this.logsDropped = 0;
    peer.event(event);
    return true;
  }
  /** The runtime's phase changed: the unsolicited `runtime.status` event. */
  statusChanged(): void {
    if (this.peer?.inUse("runtime") && this.options.runtime) this.peer.event({ t: "runtime.status", ...this.options.runtime.status() });
  }

  /** The installed set, reported when `apps` is in use and after every change (§6.2). */
  setApps(apps: Link2InstalledApp[]): void {
    this.apps = apps;
    this.appsDirty = true;
    this.reportApps();
  }
  private reportApps(): void {
    const peer = this.peer;
    if (peer === null || !this.appsDirty || this.apps === null || !peer.inUse("apps")) return;
    // At most one report a second; a change inside the second goes out at its end.
    if (this.now() - this.appsSentAt < LINK2_APPS_INTERVAL_MS) return;
    this.appsDirty = false;
    this.appsSentAt = this.now();
    this.appsSet += 1;
    for (const page of pageRuntimeApps(this.apps, this.appsSet, peer.limit)) peer.event({ ...page });
  }

  // --- DevTools (§6.3) -----------------------------------------------------

  private devtoolsOpen(): void {
    const peer = this.peer;
    if (peer === null || this.devtoolsCall !== null) return;
    const call = peer.request({ t: "devtools.open" }, {
      feature: "devtools",
      outlives: true,
      // The device grants credit for the free bytes of its line ring.
      response: { window: LINK2_DEVTOOLS_RING, onData: (bytes) => this.devtoolsBytes(bytes) },
      grantNow: true,
    });
    this.devtoolsCall = call;
    call.reply.then(
      () => {
        if (this.devtoolsCall !== call) return;
        this.devtoolsOut = peer.newWriter(call.id, { exempt: true, onGiveUp: () => {} });
        // The first line on a new stream is the shim's last `hello` line.
        if (this.devtoolsHello !== null) this.devtoolsOut.write(new TextEncoder().encode(`${this.devtoolsHello}\n`));
      },
      () => {
        if (this.devtoolsCall === call) this.devtoolsCall = null;
      },
    );
    call.response?.finished.catch(() => {
      if (this.devtoolsCall === call) {
        this.devtoolsCall = null;
        this.devtoolsOut = null;
      }
    });
  }
  /** Bytes of the Hub-to-device stream: whole lines go to the ring, and the
   *  credit of a line returns when the shim has taken it. */
  private devtoolsBytes(bytes: Uint8Array): Promise<void> {
    const waits: Promise<void>[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0x0a) continue;
      const piece = bytes.subarray(start, i + 1);
      start = i + 1;
      if (this.ringSkipToNewline) {
        // The tail of a line meant for the old guest: discarded up to its newline.
        this.ringSkipToNewline = false;
        continue;
      }
      const parts = [...this.ringPartial, piece];
      this.ringPartial = [];
      const line = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        line.set(part, at);
        at += part.length;
      }
      waits.push(new Promise<void>((taken) => this.ring.push({ bytes: line, taken })));
    }
    if (start < bytes.length && !this.ringSkipToNewline) this.ringPartial.push(bytes.slice(start));
    if (this.devtools.autoPoll) {
      for (let line = this.devtoolsPoll(); line !== null; line = this.devtoolsPoll()) this.devtools.onLine?.(line);
    }
    return Promise.all(waits).then(() => {});
  }
  private devtoolsPoll(): string | null {
    const item = this.ring.shift();
    if (item === undefined) return null;
    item.taken();
    return new TextDecoder().decode(item.bytes.subarray(0, item.bytes.length - 1));
  }
  private devtoolsSend(line: string): void {
    let text = line;
    const bytes = new TextEncoder().encode(line).length;
    if (bytes > LINK2_DEVTOOLS_LINE_OUT) text = JSON.stringify({ t: "ctrlDropped", bytes, cap: LINK2_DEVTOOLS_LINE_OUT });
    try {
      if ((JSON.parse(text) as Json).t === "hello") this.devtoolsHello = text;
    } catch {
      // Not JSON: sent as it is.
    }
    this.devtoolsOut?.write(new TextEncoder().encode(`${text}\n`));
  }
  /** The host tears a guest down (§6.3): the `guest.end` line goes out after
   *  the old guest's lines, undelivered Hub-to-device lines are dropped, and
   *  a line cut by the switch is discarded up to its newline. */
  guestSwitch(app: string, output: string): void {
    this.devtoolsOut?.write(new TextEncoder().encode(`${JSON.stringify({ t: "guest.end", app, output })}\n`));
    for (const item of this.ring.splice(0)) item.taken();
    if (this.ringPartial.length > 0) {
      this.ringPartial = [];
      this.ringSkipToNewline = true;
    }
    this.devtoolsHello = null;
  }

  // --- catalog and install (§6.4) ------------------------------------------

  /** Hub's offer for this device's target. One fetch runs at a time: a call
   *  made while one runs is served by the fetch that starts after it. */
  catalog(): Promise<Link2CatalogApp[]> {
    return new Promise((resolve, reject) => {
      const peer = this.peer;
      if (peer === null || !peer.inUse("catalog")) return reject(new LinkError(peer === null ? "closed" : "unsupported"));
      const step = this.catalogFetch.start();
      if (step === null) return void this.catalogNext.push({ resolve, reject });
      this.catalogWaiters.push({ resolve, reject });
      this.catalogStep(step);
    });
  }
  private catalogStep(step: ReturnType<CatalogFetch["reply"]>): void {
    const peer = this.peer;
    if ("send" in step) {
      if (peer === null) return;
      peer.request(step.send, { feature: "catalog" }).reply.then(
        (reply) => this.catalogStep(this.catalogFetch.reply(reply as never)),
        (error: LinkError) => this.catalogStep(this.catalogFetch.error(error.code)),
      );
      return;
    }
    const waiters = this.catalogWaiters;
    this.catalogWaiters = this.catalogNext;
    this.catalogNext = [];
    for (const waiter of waiters) "done" in step ? waiter.resolve(step.done) : waiter.reject(new LinkError(step.failed));
    const next = this.catalogFetch.next() ?? (this.catalogWaiters.length > 0 ? this.catalogFetch.start() : null);
    if (next !== null) this.catalogStep(next);
  }

  /** Streams one app of the offer under the device's 64 KiB window. */
  async install(app: string, onChunk?: (bytes: number) => void): Promise<{ hash: string; file: Uint8Array }> {
    const peer = this.peer;
    if (peer === null || !peer.inUse("install")) throw new LinkError(peer === null ? "closed" : "unsupported");
    let file = new Uint8Array(0);
    let at = 0;
    let hash = "";
    const call = peer.request({ t: "install", app }, {
      feature: "install",
      response: {
        window: LINK2_WINDOW.bulk,
        onData: (bytes) => {
          if (at + bytes.length <= file.length) file.set(bytes, at);
          at += bytes.length;
          onChunk?.(at);
        },
      },
      onProgress: (t, head) => {
        if (t !== "install.head" || typeof head.bytes !== "number" || head.bytes > LINK2_INSTALL_MAX_BYTES) return call.cancel();
        hash = String(head.hash);
        file = new Uint8Array(head.bytes);
        call.response?.start(head.bytes);
      },
    });
    await call.reply;
    if (at !== file.length) throw new LinkError("transfer");
    return { hash, file };
  }

  // --- net.http (§6.5) -----------------------------------------------------

  /** An applet worker's request, performed by Hub. `app` is the runtime's assertion. */
  async http(request: { app: string; url: string; method?: string; headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number; maxBytes?: number }): Promise<{ status: number; url: string; headers: Record<string, string>; truncated: boolean; body: Uint8Array }> {
    const peer = this.peer;
    // In use on a connection whose payload limit is at least 12,288 bytes.
    if (peer === null || !peer.inUse("net.http") || peer.limit < LINK2_HTTP_MIN_PAYLOAD) throw new LinkError("unavailable");
    const headers = request.headers ?? {};
    const body = request.body ?? new Uint8Array(0);
    if (encodedBytes(request.url) > LINK2_HTTP_URL_BYTES || Object.keys(headers).length > LINK2_HTTP_MAX_HEADERS || jsonBytes(headers) > LINK2_HTTP_HEADERS_BYTES || body.length > LINK2_HTTP_MAX_BODY) {
      throw new LinkError("invalid_request");
    }
    const chunks: Uint8Array[] = [];
    let head: Json | null = null;
    const object: Json & { t: string } = { t: "net.http", app: request.app, url: request.url, method: request.method ?? "GET", headers, bytes: body.length };
    if (request.timeoutMs !== undefined) object.timeoutMs = request.timeoutMs;
    if (request.maxBytes !== undefined) object.maxBytes = request.maxBytes;
    const call = peer.request(object, {
      feature: "net.http",
      body: true,
      // The device grants its window in the same write as the request.
      response: { window: LINK2_WINDOW.http, onData: (bytes) => void chunks.push(bytes.slice()) },
      grantNow: true,
      onProgress: (t, args) => {
        if (t === "net.head") head = args;
      },
    });
    if (body.length > 0) void call.body?.writeAll(body).then(() => call.body?.end(), () => {});
    else call.body?.end();
    const joined = () => {
      const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    };
    try {
      await call.reply;
    } catch (error) {
      // The device keeps the body prefix received before an error.
      throw new LinkError((error as LinkError).code, (error as LinkError).message, { ...(error as LinkError).extra, head, body: joined() });
    }
    const got = (head ?? {}) as { status?: number; url?: string; headers?: Record<string, string>; truncated?: boolean };
    return { status: got.status ?? 0, url: got.url ?? "", headers: got.headers ?? {}, truncated: got.truncated === true, body: joined() };
  }

  // --- applet channels (§7) ------------------------------------------------

  /** The running applet's channel: opened now when the link is up, and again
   *  after every `ready` while the applet runs. */
  openChannel(app: string, hash: string): GuestChannel {
    const channel = new GuestChannel(this, app, hash);
    this.channels.add(channel);
    channel.pump();
    return channel;
  }
  /** @internal */
  forgetChannel(channel: GuestChannel): void {
    this.channels.delete(channel);
  }
  /** A reader for a stream a system event opened (`agent.screen`, `agent.glyphs`). */
  onStreamEvent(t: string, feature: string, handler: (object: Json, open: Parameters<Parameters<Peer["onEvent"]>[1]>[1]) => void): void {
    this.streamEvents.push({ t, feature, handler });
    this.peer?.onEvent(t, (object, open) => handler(object, open), { feature });
  }
  private streamEvents: { t: string; feature: string; handler: (object: Json, open: Parameters<Parameters<Peer["onEvent"]>[1]>[1]) => void }[] = [];
}

const NATIVE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.3dsx$/;
/** 6 to 64 bytes of [A-Za-z0-9._-], ending in `.3dsx`, not starting with `.` (§6.2). */
export const validNativeName = (name: string) => name.length >= 6 && name.length <= 64 && NATIVE_NAME.test(name);

function defaultConnect(address: string, port: number): Promise<Carrier> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: address, port });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(tcpCarrier(socket));
    });
    socket.once("error", reject);
  });
}

export type { StreamReader, StreamWriter, AppletChannel };
export { formatLastFile };
