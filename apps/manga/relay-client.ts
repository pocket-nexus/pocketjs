import { RelayEndpoint, relayControlSlice } from "@pocketjs/framework/relay/endpoint";
import type { RelayRandomBytes, RelayScheduler, RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import { parseRelayJson } from "@pocketjs/framework/relay/frame";
import { RELAY_CODEC, RELAY_DELIVERY, RELAY_ERROR, type RelayRxLimits } from "@pocketjs/framework/relay/spec";
import { getOps } from "@pocketjs/framework/host";
import type { OffloadResult } from "@pocketjs/framework/offload";
import { CATALOG_NS, RECORDS_NS, MANGA_RELAY, MANGA_PRIVATE_OPS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, PROGRESS_OP, mangaRef, mangaRelayLimits } from "./relay-profile.ts";

/** QuickJS timers are not wall-clock timers. Drive relay liveness at the
 * frame boundary and run only the jobs that were due when the frame began. */
export function frameScheduler(clock = () => Date.now()) {
  let next = 1;
  const jobs = new Map<number, { due: number; run(): void }>();
  const scheduler: RelayScheduler = {
    now: clock,
    setTimeout(run, delay) { const id = next++; jobs.set(id, { due: clock() + delay, run }); return id; },
    clearTimeout(id) { jobs.delete(id); },
  };
  return { scheduler, step() {
    const now = clock();
    for (const [id, job] of [...jobs]) if (job.due <= now && jobs.delete(id)) job.run();
  } };
}
interface Image { pixels: Uint8Array; width: number; height: number }
interface Pending { image: boolean; callback(result: OffloadResult): void; cancel?(): void }
export function createRelayMangaClient(options: {
  transport: RelayTransportAdapter; rxLimits?: RelayRxLimits; scheduler?: RelayScheduler;
  randomBytes?: RelayRandomBytes; upload?: (image: Image) => number;
}) {
  const limits = options.rxLimits ?? mangaRelayLimits(), clock = frameScheduler();
  const streams = new Map<string, number>(), binding = new Set<string>(), refused = new Map<string, string>();
  const held = new Map<string, { raw: string; revision: string }>(), staging = new Map<number, Image>();
  const pending = new Map<number, Pending>();
  let ready = false, epoch = 0, generation = 0, nextRequest = 1, nextToken = 1, catalogRevision = "";
  const acceptCatalog = (data: Uint8Array, revision: string) => {
    const pointer = parseRelayJson(data) as { catalog?: string };
    if (!pointer || typeof pointer.catalog !== "string" || pointer.catalog !== revision || !/^mc-[a-f0-9]+$/.test(pointer.catalog)) throw Error("Invalid catalog pointer");
    if (catalogRevision && revision !== catalogRevision) generation++;
    catalogRevision = revision;
    return JSON.stringify(pointer);
  };
  const endpoint = new RelayEndpoint({
    role: "guest", transport: options.transport,
    local: { app: MANGA_RELAY.app, versions: [[1, 0]], profiles: [MANGA_RELAY.profile], codecs: MANGA_RELAY.codecs, kinds: MANGA_RELAY.kinds, rxLimits: limits },
    privateOps: MANGA_PRIVATE_OPS, requestReserve: 1,
    scheduler: options.scheduler ?? clock.scheduler,
    // Guest nonces distinguish boots; authentication is provided by the L0
    // pairing key. The companion generates cryptographic session identities.
    randomBytes: options.randomBytes ?? (n => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256))),
    hooks: {
      onPhase(phase) {
        if (phase === "ready") { ready = true; generation++; }
        if (phase === "idle" || phase === "closed") {
          ready = false; epoch++; streams.clear(); binding.clear(); refused.clear();
          for (const [id, item] of [...pending]) { pending.delete(id); item.callback({ ok: false, error: "Companion disconnected" }); }
        }
      },
      onStreamReset(stream) { for (const [ns, id] of streams) if (id === stream) { streams.delete(ns); binding.delete(ns); } },
    },
  });
  function streamFor(ns: string): number | undefined {
    if (!ready) return;
    if (refused.has(ns)) throw Error(`Relay namespace refused: ${refused.get(ns)}`);
    if (streams.has(ns)) return streams.get(ns);
    if (binding.has(ns)) return;
    binding.add(ns);
    const start = epoch, current = () => epoch === start && ready && endpoint.phase === "ready";
    const attachment = endpoint.negotiation!.rxLimits;
    const control = relayControlSlice(attachment), catalogBytes = MAX_TEXT_BYTES * 2;
    const windowBytes = ns === CATALOG_NS ? catalogBytes : attachment.windowBytes - control.bytes - catalogBytes;
    const rxLimits = { ...attachment, windowFrames: ns === CATALOG_NS ? 1 : attachment.windowFrames - control.frames - 1,
      windowBytes, maxWireBytes: Math.min(attachment.maxWireBytes, windowBytes) };
    const fail = (code: string, stream?: number) => {
      if (!current()) return;
      binding.delete(ns);
      if (stream) endpoint.resetStream(stream, "Manga subscription failed");
      if (![RELAY_ERROR.BUSY, "BAD_STATE", "NOT_READY"].includes(code)) refused.set(ns, code);
    };
    endpoint.open({ app: MANGA_RELAY.app, namespace: ns, profile: MANGA_RELAY.profile, rxLimits }).then(opened => {
      if (!current()) return;
      if (ns !== CATALOG_NS) { streams.set(ns, opened.stream); binding.delete(ns); return; }
      const subscribed = endpoint.subscribe(opened.stream, { ns }, RELAY_DELIVERY.LATEST_SNAPSHOT, {
        onObject(object) {
          if (!current()) return;
          try { acceptCatalog(object.data, object.ref.revision ?? ""); held.delete(JSON.stringify(mangaRef("manga.read", "manga-index/0"))); }
          catch { endpoint.resetStream(opened.stream, "Invalid catalog push"); }
        },
        onEnd() { if (current()) { streams.delete(ns); binding.delete(ns); } },
      }, result => {
        if (!current()) return;
        if (result.ok && "value" in result) { streams.set(ns, opened.stream); binding.delete(ns); }
        else fail(!result.ok ? (result.error as { code?: string }).code ?? RELAY_ERROR.BUSY : RELAY_ERROR.INVALID, opened.stream);
      }, { maxObjectBytes: MAX_TEXT_BYTES });
      if (!("correlation" in subscribed)) fail(subscribed.code, opened.stream);
    }, error => fail(String(error instanceof Error ? error.message : error)));
    return;
  }
  function finish(id: number, result: OffloadResult) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); item.callback(result);
  }
  function request(method: string, payload: string, callback: (result: OffloadResult) => void, image = false): number {
    if (!ready || pending.size >= 8) return 0;
    if (image && staging.size + [...pending.values()].filter(p => p.image).length >= 4) return 0;
    const progress = method === "manga.progress-part";
    const ref = progress ? undefined : mangaRef(method, payload);
    if (image !== (method === "manga.image")) throw Error("Manga response kind mismatch");
    const stream = streamFor(ref?.ns ?? RECORDS_NS);
    if (!stream) return 0;
    const progressArgs: unknown = progress ? JSON.parse(payload) : undefined;
    const id = nextRequest++, item: Pending = { image, callback };
    pending.set(id, item);
    if (progress) {
      const call = endpoint.request(stream, PROGRESS_OP, progressArgs);
      // A refused operation resolves with its protocol error. It does not
      // poison the records stream used by ordinary page reads.
      item.cancel = () => call.cancel();
      void call.then(result => finish(id, result.ok ? { ok: true, value: JSON.stringify(result.value) } : { ok: false, error: result.error.message }));
      return id;
    }
    const key = JSON.stringify(ref), previous = held.get(key);
    if (previous) { held.delete(key); held.set(key, previous); }
    const started = endpoint.get(stream, ref!, { accept: [image ? RELAY_CODEC.R5G6B5LE : RELAY_CODEC.JSON], maxObjectBytes: image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES,
      ...(!image && previous ? { ifRevision: previous.revision } : {}) }, result => {
      if (!pending.has(id)) return;
      if (!result.ok) { finish(id, { ok: false, error: String((result.error as { message?: string; code?: string }).message ?? (result.error as { code?: string }).code ?? result.error) }); return; }
      let ticket: number | undefined;
      try {
        if (!("value" in result)) throw Error("Missing manga resource");
        const object = result.value;
        if ("notModified" in object) {
          if (!previous || previous.revision !== object.revision) throw Error("Manga revision has no held value");
          finish(id, { ok: true, value: previous.raw }); return;
        }
        if (image) {
          const { width, height } = object.value as { width: number; height: number };
          if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 256 && !(n & (n - 1))) || object.data.length !== width * height * 2)
            throw Error("Invalid manga image envelope");
          ticket = nextToken++; staging.set(ticket, { pixels: object.data, width, height });
          finish(id, { ok: true, value: JSON.stringify({ token: ticket, width, height }) });
        } else {
          const decoded = parseRelayJson(object.data);
          const raw = ref!.ns === CATALOG_NS ? acceptCatalog(object.data, object.ref.revision ?? "")
            : method === "manga.describe" ? JSON.stringify(decoded) : decoded;
          if (typeof raw !== "string") throw Error("Invalid manga text record");
          if (held.size >= 8 && !held.has(key)) held.delete(held.keys().next().value!);
          if (object.ref.revision) { held.delete(key); held.set(key, { raw, revision: object.ref.revision }); }
          finish(id, { ok: true, value: raw });
        }
      } catch (error) {
        if (ticket) staging.delete(ticket);
        finish(id, { ok: false, error: String(error) });
      }
    });
    if (!("correlation" in started)) { pending.delete(id); if (started.code !== RELAY_ERROR.BUSY) throw Error(`Manga request refused: ${started.code}`); return 0; }
    item.cancel = () => endpoint.cancel(started.correlation, "reader");
    return id;
  }
  function pixels(raw: string): Image {
    const ticket = JSON.parse(raw), image = staging.get(ticket.token);
    if (!image || image.width !== ticket.width || image.height !== ticket.height) throw Error("Manga image ticket expired");
    return image;
  }
  return {
    endpoint, pixels, staged: () => staging.size,
    connected: () => ready, session: () => ready ? generation : 0,
    connect() { if (endpoint.phase === "idle") endpoint.hello(); },
    disconnect(reason: string) { endpoint.handleDisconnect(reason); },
    handleRecord(record: Uint8Array) { endpoint.handleRecord(record); },
    step() { if (!options.scheduler) clock.step(); endpoint.flush(); },
    request,
    requestImage: (method: string, payload: string, callback: (result: OffloadResult) => void) => request(method, payload, callback, true),
    cancel(id: number) { const item = pending.get(id); pending.delete(id); item?.cancel?.(); },
    uploadImage(ticket: string) {
      const image = pixels(ticket), { width, height } = image;
      let handle: number;
      if (options.upload) handle = options.upload(image);
      else {
        const blob = new Uint8Array(8 + image.pixels.length), header = new DataView(blob.buffer);
        header.setUint16(0, width, true); header.setUint16(2, height, true); blob[5] = 2; blob.set(image.pixels, 8);
        handle = getOps().uploadImgEntry?.(blob) ?? -1;
      }
      if (handle < 0) throw Error("Image upload credit unavailable");
      return { handle, width, height };
    },
    releaseImage(ticket: string) { staging.delete(JSON.parse(ticket).token); },
    close() { endpoint.close(); staging.clear(); held.clear(); },
  };
}
