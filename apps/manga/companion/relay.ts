import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { RELAY_CODEC, RELAY_EFFECT, RELAY_ERROR, type RelayResourceRef } from "@pocketjs/framework/relay/spec";
import type { RelayEndpoint, RelayIncomingRequest } from "@pocketjs/framework/relay/endpoint";
import type { RelayPeerContext } from "@pocketjs/framework/relay/session";
import { serveRelayTcp, type RelayProviderHooks, type RelayProviderConnection } from "@pocketjs/framework/relay/wire";
import { CATALOG_NS, RECORDS_NS, MANGA_RELAY, MANGA_PRIVATE_OPS, PROGRESS_OP, catalogRef, mangaRead, mangaRelayLimits, utf8 } from "../relay-profile.ts";
import { workerBackend, type MangaBackend, type MangaReply } from "./backend.ts";

interface Connection { endpoint?: RelayEndpoint; streams: Map<string, number>; announced: Map<number, string>; closed: boolean }
export class MangaRelayAuthority {
  private connections = new Set<Connection>();
  private catalog?: { payload: string; revision: string };
  private refreshing?: Promise<void>;
  private closed = false;
  readonly stats = { gets: 0, objects: 0, notModified: 0, pushes: 0, cancellations: 0 };
  constructor(private readonly backend: MangaBackend, private readonly log?: (message: string) => void) {}
  private async call(method: string, payload: string, ifRevision?: string): Promise<MangaReply> {
    try { return await this.backend.call(method, payload, ifRevision); }
    catch (error) { this.log?.(String(error)); return { error: { code: RELAY_ERROR.BUSY, message: "Manga worker unavailable" } }; }
  }

  /** The catalog pointer is replaced after its immutable records are on disk. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    return this.refreshing = (async () => {
      const reply = await this.call("manga.read", "manga-index/0");
      if (this.closed) return;
      if (reply.error || !reply.payload) throw Error(reply.error?.message ?? "Manga catalog unavailable");
      const pointer = JSON.parse(reply.payload);
      if (!/^mc-[a-f0-9]+$/.test(pointer.catalog)) throw Error("Invalid published manga catalog");
      this.catalog = { payload: reply.payload, revision: pointer.catalog };
      this.pushCatalog();
    })().finally(() => { this.refreshing = undefined; });
  }
  private pushCatalog() {
    if (!this.catalog) return;
    for (const c of this.connections) {
      const stream = c.streams.get(CATALOG_NS);
      if (!stream || c.closed) continue;
      const active = c.endpoint?.authority?.subscriptionsOn(stream) ?? [];
      for (const id of c.announced.keys()) if (!active.some(s => s.id === id)) c.announced.delete(id);
      for (const subscription of active) {
        if (c.announced.get(subscription.id) === this.catalog.revision) continue;
        const sent = c.endpoint!.pushObject({ stream, subscription: subscription.id,
          ref: { ...catalogRef(), revision: this.catalog.revision }, codec: RELAY_CODEC.JSON, data: utf8(this.catalog.payload) });
        if (sent.ok) { this.stats.pushes++; c.announced.set(subscription.id, this.catalog.revision); }
      }
    }
  }
  connection(_peer: RelayPeerContext) {
    const c: Connection = { streams: new Map(), announced: new Map(), closed: false };
    const hooks: RelayProviderHooks = {
      authorizeOpen: request => {
        if (request.app !== MANGA_RELAY.app) return RELAY_ERROR.UNAUTHORIZED;
        if (request.profile.name !== MANGA_RELAY.profile.name || request.profile.version !== MANGA_RELAY.profile.version) return RELAY_ERROR.UNSUPPORTED;
        if (![CATALOG_NS, RECORDS_NS].includes(request.namespace)) return RELAY_ERROR.NOT_FOUND;
        return c.streams.has(request.namespace) ? RELAY_ERROR.BUSY : null;
      },
      onStreamOpened: value => { c.streams.set(value.namespace, value.stream); },
      onStreamReset: stream => { for (const [ns, id] of c.streams) if (id === stream) c.streams.delete(ns); },
      onGet: request => { void this.get(c, request); },
      onRequest: request => {
        if (request.op !== PROGRESS_OP) return false;
        void this.progress(c, request); return true;
      },
      onProtocolError: (code, detail) => this.log?.(`Relay ${code}: ${detail}`),
      onPhase: (phase, detail) => { if (phase === "closed") this.log?.(`Relay closed: ${detail?.reason ?? "closed"}`); if (phase === "closed" || phase === "idle") { c.closed = true; this.connections.delete(c); } },
    };
    this.connections.add(c);
    return { hooks, bind: (endpoint: RelayEndpoint) => { c.endpoint = endpoint; } };
  }
  private async get(c: Connection, request: RelayIncomingRequest) {
    const endpoint = c.endpoint;
    if (!endpoint || c.closed) return;
    const ref = request.metadata.resource as RelayResourceRef, read = mangaRead(ref);
    if (!read || c.streams.get(ref.ns) !== request.stream) { endpoint.replyError(request, RELAY_ERROR.INVALID, "Invalid manga resource binding"); return; }
    this.stats.gets++;
    const catalog = ref.ns === CATALOG_NS ? this.catalog : undefined;
    const ifRevision = (request.metadata.args as { ifRevision?: string }).ifRevision;
    const reply: MangaReply = catalog ? { payload: catalog.payload } : await this.call(read.method, read.payload, ifRevision);
    const revision = catalog?.revision ?? reply.revision ?? ref.key.split("/")[0]!;
    if (c.closed || endpoint.session.sessionId !== request.session) return;
    if (request.cancelRequested()) {
      this.stats.cancellations++; endpoint.replyError(request, RELAY_ERROR.CANCELLED, "Cancelled", RELAY_EFFECT.NONE); return;
    }
    if (reply.error) { endpoint.replyError(request, reply.error.code, reply.error.message); return; }
    const stamped = { ...ref, revision };
    if (ifRevision === revision) {
      endpoint.replyNotModified(request, stamped); this.stats.notModified++; return;
    }
    let sent;
    if (read.image && reply.image?.format === "r5g6b5") {
      const { pixels, width, height } = reply.image;
      sent = endpoint.replyObject(request, { ref: stamped, codec: RELAY_CODEC.R5G6B5LE, data: pixels, value: { width, height } });
    } else if (!read.image && typeof reply.payload === "string") {
      // Pack records are JSON strings: escaping them preserves document chunks
      // without asking the protocol's integer-only JSON codec to parse the book.
      const content = ref.ns === CATALOG_NS || read.method === "manga.describe" ? reply.payload : JSON.stringify(reply.payload);
      sent = endpoint.replyObject(request, { ref: stamped, codec: RELAY_CODEC.JSON, data: utf8(content) });
    } else { endpoint.replyError(request, RELAY_ERROR.INVALID, "Invalid manga worker response"); return; }
    if (sent.ok) this.stats.objects++;
  }
  private async progress(c: Connection, request: RelayIncomingRequest) {
    if (!c.endpoint || c.closed) return;
    if (c.streams.get(RECORDS_NS) !== request.stream) { c.endpoint.replyError(request, RELAY_ERROR.UNAUTHORIZED, "Progress needs the records stream"); return; }
    if (request.cancelRequested()) { c.endpoint.replyError(request, RELAY_ERROR.CANCELLED, "Cancelled", RELAY_EFFECT.NONE); return; }
    const reply = await this.call("manga.progress-part", JSON.stringify(request.metadata.args));
    if (c.closed || c.endpoint.session.sessionId !== request.session) return;
    if (reply.error) c.endpoint.replyError(request, reply.error.code, reply.error.message);
    else c.endpoint.replyValue(request, JSON.parse(reply.payload!));
  }
  async close() {
    this.closed = true;
    for (const c of [...this.connections]) { c.closed = true; c.endpoint?.close(); }
    this.connections.clear(); await this.backend.close();
  }
}

/** Pairing precedes HELLO. Only the adapter grants access to this app. */
export function authenticateManga(socket: Socket, key: string, timeoutMs = 5000): Promise<RelayPeerContext | null> {
  return new Promise(resolve => {
    const presented = Buffer.alloc(64); let length = 0, done = false;
    const finish = (accepted: boolean) => {
      if (done) return; done = true;
      clearTimeout(timer); socket.off("data", receive); socket.off("close", reject); socket.off("error", reject);
      resolve(accepted ? { id: `device:${socket.remoteAddress}:${socket.remotePort}`, grants: [MANGA_RELAY.app] } : null);
    };
    const reject = () => finish(false);
    const receive = (chunk: Buffer) => {
      const used = Math.min(64 - length, chunk.length); chunk.copy(presented, length, 0, used); length += used;
      if (length < 64) return;
      socket.pause();
      const accepted = timingSafeEqual(presented, Buffer.from(key));
      if (accepted && chunk.length > used) socket.unshift(chunk.subarray(used));
      finish(accepted);
      if (accepted) setTimeout(() => { if (!socket.destroyed) socket.resume(); }, 0);
    };
    const timer = setTimeout(reject, timeoutMs);
    socket.on("data", receive); socket.once("close", reject); socket.once("error", reject);
  });
}

export async function serveMangaRelay(options: { root: string; key: string; port?: number; host?: string; backend?: MangaBackend; pollMs?: number; log?: (message: string) => void }) {
  if (!/^[0-9a-f]{64}$/i.test(options.key)) throw Error("Pairing key must contain 64 hexadecimal characters");
  const authority = new MangaRelayAuthority(options.backend ?? workerBackend(options.root), options.log);
  const pending = new Map<string, ReturnType<MangaRelayAuthority["connection"]>>();
  const sockets = new Set<Socket>(), connections = new Set<RelayProviderConnection>();
  try {
    await authority.refresh();
    const wire = await serveRelayTcp({ host: options.host ?? "127.0.0.1", port: options.port ?? MANGA_RELAY.port,
      local: { versions: [[1, 0]], profiles: [MANGA_RELAY.profile], codecs: MANGA_RELAY.codecs, kinds: MANGA_RELAY.kinds, rxLimits: mangaRelayLimits() },
      privateOps: MANGA_PRIVATE_OPS,
      authenticate: socket => {
        if (sockets.size >= 4) return null;
        sockets.add(socket); socket.once("close", () => { sockets.delete(socket); });
        return authenticateManga(socket, options.key);
      },
      hooks: peer => { const binding = authority.connection(peer); pending.set(peer.id, binding); return binding.hooks; },
      onConnection: connection => {
        pending.get(connection.peer.id)!.bind(connection.endpoint); pending.delete(connection.peer.id);
        connections.add(connection);
        // The authority drops session state on teardown; the server owns sockets.
        for (const socket of sockets) if (`device:${socket.remoteAddress}:${socket.remotePort}` === connection.peer.id)
          socket.once("close", () => { connections.delete(connection); });
      },
    });
    const timer = setInterval(() => { void authority.refresh().catch(error => options.log?.(String(error))); }, options.pollMs ?? 1000);
    timer.unref();
    return { authority, port: wire.port, async close() {
      clearInterval(timer);
      for (const c of connections) c.close();
      for (const socket of sockets) socket.destroy();
      await authority.close(); await wire.close();
    } };
  } catch (error) { await authority.close(); throw error; }
}
