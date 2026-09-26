import { createOffloadClient, type OffloadResult } from "@pocketjs/framework/offload";
import { registerServicePump } from "../../framework/src/services.ts";
import { getOps } from "@pocketjs/framework/host";
import type {
  createResourceRuntime,
  ResourceCollectionOptions,
} from "@pocketjs/framework/resource-view";
import type { TextureResource } from "@pocketjs/framework/resource";

interface PackOps {
  session(): number;
  enqueue(id: number, pack: string, entry: number): boolean;
  take(): string | undefined;
  uploadImage(token: number): number;
  releaseImage(token: number): void;
  stats(): string;
  removeCache?(id: number, pack: string): boolean;
  cacheText?(id: number, pack: string, entry: number, text: string): boolean;
  cacheImage?(id: number, pack: string, entry: number, token: number): boolean;
  cachePixels?(id: number, pack: string, entry: number, pixels: Uint8Array, width: number, height: number): boolean;
}
type ImageClient = Pick<
  ReturnType<typeof createOffloadClient>,
  "requestImage" | "cancel" | "uploadImage" | "releaseImage"
> & { connected?(): boolean };
let client: ReturnType<typeof createOffloadClient> | undefined;
const pixelWrites = new Map<number, { pixels: Uint8Array; width: number; height: number }>();
const native = () =>
  (globalThis as unknown as { resourcePacks?: PackOps }).resourcePacks;

/** A realm service, with native IO on a worker. Missing support is explicit;
 * callers can retain the same collection contract through a desktop fallback. */
export function resourcePacks() {
  if (client) return client;
  const ops = native();
  if (!ops) return undefined;
  client = createOffloadClient({
    session: () => ops.session(),
    take: () => ops.take(),
    uploadImage: (token) => ops.uploadImage(token),
    releaseImage: (token) => ops.releaseImage(token),
    submit(record) {
      const request = JSON.parse(record);
      if (request.method === "pack.cache-pixels") {
        const image = pixelWrites.get(request.id);
        if (!image) return false;
        const [pack, entry] = JSON.parse(request.payload);
        const accepted = ops.cachePixels?.(request.id, pack, entry, image.pixels, image.width, image.height) ?? false;
        // Native admission copies into its fixed worker slot. No JS pixels
        // remain owned by this queue after admission or cancellation.
        if (accepted) pixelWrites.delete(request.id);
        return accepted;
      }
      if (request.method === "pack.cache-remove") return ops.removeCache?.(request.id, request.payload) ?? false;
      if (request.method === "pack.cache-text" || request.method === "pack.cache-image") {
        const [pack, entry, value] = JSON.parse(request.payload);
        return request.method === "pack.cache-text"
          ? ops.cacheText?.(request.id, pack, entry, value) ?? false
          : ops.cacheImage?.(request.id, pack, entry, value) ?? false;
      }
      const
        parts = String(request.payload).split("/");
      if (parts.length !== 2 || !/^[a-z0-9-]{1,48}$/.test(parts[0]!))
        return false;
      const entry = Number(parts[1]);
      return (
        Number.isInteger(entry) &&
        entry >= 0 &&
        entry < 65536 &&
        ops.enqueue(request.id, parts[0]!, entry)
      );
    },
  });
  const cancel = client.cancel, dispose = client.dispose;
  client.cancel = id => { pixelWrites.delete(id); cancel(id); };
  client.dispose = () => { pixelWrites.clear(); dispose(); };
  registerServicePump(() => client!.step());
  return client;
}
export function resourcePackStats() {
  return native()?.stats();
}

/** Optional persistent record cache. The native worker copies and writes the
 * record before acknowledging it; the caller retains an image ticket until
 * that acknowledgement. Older hosts still read installed packs. */
export function resourcePackCache() {
  const ops = native(), packs = resourcePacks();
  if (!ops?.cacheText || !ops.cacheImage || !packs) return undefined;
  return {
    remove: ops.removeCache ? (pack: string, callback: (result: OffloadResult) => void) => packs.request("pack.cache-remove", pack, callback) : undefined,
    text(pack: string, entry: number, text: string, callback: (result: OffloadResult) => void) {
      return packs.request("pack.cache-text", JSON.stringify([pack, entry, text]), callback);
    },
    image(pack: string, entry: number, ticket: string, callback: (result: OffloadResult) => void) {
      return packs.request("pack.cache-image", JSON.stringify([pack, entry, JSON.parse(ticket).token]), callback);
    },
    pixels: ops.cachePixels ? (pack: string, entry: number, pixels: Uint8Array, width: number, height: number, callback: (result: OffloadResult) => void) => {
      if (!/^[a-z0-9-]{1,48}$/.test(pack) || !Number.isInteger(entry) || entry < 0 || entry >= 65536 ||
          ![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 256 && !(n & (n - 1))) ||
          pixels.length !== width * height * 2) throw Error("Invalid cached image");
      if (pixelWrites.size >= 4) return 0;
      const id = packs.request("pack.cache-pixels", JSON.stringify([pack, entry]), result => { pixelWrites.delete(id); callback(result); });
      if (id) pixelWrites.set(id, { pixels, width, height });
      return id;
    } : undefined,
  };
}

/** One cache owns either a prepared local image or the desktop fallback.
 * The application chooses identity and demand. The pack path stays below
 * the host's app-specific asset directory; no guest filesystem call exists. */
export function createPackedImageCollection<I>(
  runtime: ReturnType<typeof createResourceRuntime>,
  options: Omit<
    ResourceCollectionOptions<I, string, TextureResource>,
    | "load"
    | "materialize"
    | "dispose"
    | "releaseResponse"
    | "maxResponseBytes"
    | "cost"
    | "maxCost"
  > & {
    pack(input: I): { name: string; entry: number } | undefined;
    width: number;
    height: number;
    fallback?: {
      client: ImageClient;
      method: string;
      payload(input: I): string;
    };
    materialized?(storage: "local" | "desktop"): void;
  },
) {
  for (const n of [options.width, options.height])
    if (!Number.isInteger(n) || n < 16 || n > 256 || n & (n - 1))
      throw Error("Invalid image envelope");
  const local = resourcePacks(),
    fallback = options.fallback;
  // Installed names are immutable. An absent pack stays absent until the
  // native realm changes; avoid probing SD on every desktop-only tile miss.
  const absent = new Set<string>();
  let generation = local?.session() ?? 0;
  const source = (raw: string) => {
    const record = JSON.parse(raw) as { local: boolean; ticket: string };
    const owner = record.local ? local : fallback?.client;
    if (!owner || typeof record.ticket !== "string")
      throw Error("Invalid pack response owner");
    return { owner, record };
  };
  // Reserve the larger remote fallback representation, including transient
  // staging and GPU retirement. Local GPU-owned images need no core pixels.
  const cost = options.width * options.height * 18 + 512;
  return runtime.createCollection<I, string, TextureResource>({
    ...options,
    maxResponseBytes: 512,
    cost: () => cost,
    maxCost: options.maxEntries * cost,
    load(input, complete) {
      const pack = options.pack(input);
      if ((local?.session() ?? 0) !== generation) {
        generation = local?.session() ?? 0;
        absent.clear();
      }
      let owner: ImageClient | undefined,
        id = 0,
        cancelled = false;
      const finish = (isLocal: boolean, result: OffloadResult) => {
        if (cancelled) return;
        complete(
          result.ok
            ? {
                ok: true,
                value: JSON.stringify({ local: isLocal, ticket: result.value }),
              }
            : result,
        );
      };
      const remote = () => {
        if (!fallback || fallback.client.connected?.() === false) return false;
        owner = fallback.client;
        id = owner.requestImage(
          fallback.method,
          fallback.payload(input),
          (result) => finish(false, result),
        );
        return !!id;
      };
      if (local?.connected() && pack && !absent.has(pack.name)) {
        if (
          !/^[a-z0-9-]{1,48}$/.test(pack.name) ||
          !Number.isInteger(pack.entry) ||
          pack.entry < 0 ||
          pack.entry >= 65536
        )
          throw Error("Invalid resource pack address");
        owner = local;
        id = local.requestImage(
          "pack.read",
          `${pack.name}/${pack.entry}`,
          (result) => {
            if (cancelled) return;
            if (!result.ok && fallback) {
              if (result.error === "Resource pack not installed" && !resourcePackCache()) {
                if (absent.size === 4)
                  absent.delete(absent.values().next().value!);
                absent.add(pack.name);
              }
              if (!remote()) finish(true, result);
            } else finish(true, result);
          },
        );
        if (!id) return false;
      } else if (!remote()) return false;
      return {
        cancel() {
          cancelled = true;
          owner?.cancel(id);
        },
      };
    },
    materialize(raw) {
      const { owner, record } = source(raw),
        ticket = JSON.parse(record.ticket);
      if (ticket.width > options.width || ticket.height > options.height)
        throw Error("Image exceeds collection envelope");
      const value = owner.uploadImage(record.ticket);
      try {
        options.materialized?.(record.local ? "local" : "desktop");
      } catch (error) {
        getOps().freeTexture?.(value.handle);
        throw error;
      }
      return value;
    },
    releaseResponse(raw) {
      const { owner, record } = source(raw);
      owner.releaseImage(record.ticket);
    },
    dispose(value) {
      getOps().freeTexture?.(value.handle);
    },
  });
}
