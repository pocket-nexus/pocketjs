import { RELAY_CODEC, RELAY_KIND, type RelayResourceRef, type RelayRxLimits } from "@pocketjs/framework/relay/spec";
import { RELAY_CHANNEL } from "@pocketjs/framework/relay/channel";
import type { RelayPrivateOp } from "../../framework/src/relay/private-op.ts";

export const MANGA_RELAY = {
  app: "pocket-manga", profile: { name: "manga.library", version: 1 },
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON, RELAY_CODEC.R5G6B5LE],
  kinds: [RELAY_KIND.FILE, RELAY_KIND.TEXTURE, RELAY_KIND.EVENT],
  port: RELAY_CHANNEL.port,
};
export const CATALOG_NS = "manga/catalog", RECORDS_NS = "manga/records";
export const PROGRESS_OP = "x.manga.library.progress";
export const MAX_IMAGE_BYTES = 256 * 256 * 2;
export const MAX_TEXT_BYTES = 4096;
export function mangaRelayLimits(lane = false): RelayRxLimits {
  return {
    maxWireBytes: lane ? RELAY_CHANNEL.recordBytes : 65536, maxMetaBytes: 2048,
    windowFrames: 8, windowBytes: 65536, maxPending: 8,
    maxObjectBytes: MAX_IMAGE_BYTES, maxAssemblies: 5, maxScratchBytes: MAX_IMAGE_BYTES * 4 + MAX_TEXT_BYTES,
  };
}
export const catalogRef = (): RelayResourceRef => ({ kind: RELAY_KIND.EVENT, ns: CATALOG_NS, key: "library", rendition: "catalog-v1" });
export function mangaRef(method: string, payload: string): RelayResourceRef {
  if (method === "manga.read" && payload === "manga-index/0") return catalogRef();
  const describe = method === "manga.describe", image = method === "manga.image";
  if (!describe && !image && method !== "manga.read") throw Error("Unknown manga read");
  if (!(describe ? /^[a-z0-9-]{1,48}$/ : /^[a-z0-9-]{1,48}\/(0|[1-9][0-9]{0,4})$/).test(payload) ||
      payload.split("/")[0] === "manga-index" || (!describe && Number(payload.split("/")[1]) >= 65536)) throw Error("Invalid manga resource address");
  return { kind: image ? RELAY_KIND.TEXTURE : RELAY_KIND.FILE, ns: RECORDS_NS, key: payload,
    rendition: describe ? "pack-v1" : image ? "rgb565-v1" : "record-v1" };
}
export function mangaRead(ref: RelayResourceRef): { method: string; payload: string; image: boolean } | undefined {
  if (ref.ns === CATALOG_NS && ref.kind === RELAY_KIND.EVENT && ref.key === "library" && ref.rendition === "catalog-v1")
    return { method: "manga.read", payload: "manga-index/0", image: false };
  const method = ref.rendition === "pack-v1" ? "manga.describe" : ref.rendition === "record-v1" ? "manga.read" : ref.rendition === "rgb565-v1" ? "manga.image" : "";
  try {
    const expected = mangaRef(method, ref.key);
    if (expected.ns === ref.ns && expected.kind === ref.kind) return { method, payload: ref.key, image: method === "manga.image" };
  } catch { /* A malformed key is a protocol error, never a filesystem path. */ }
  return undefined;
}

const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
export const MANGA_PRIVATE_OPS: RelayPrivateOp[] = [{
  profile: MANGA_RELAY.profile, name: PROGRESS_OP, direction: "guest-to-provider", recovery: "idempotent",
  maxWireBytes: 4096, maxObjectBytes: 4096,
  args: { type: "object", required: ["device", "slug", "updated", "part", "total", "data"], additionalProperties: false,
    properties: { device: { type: "string", minLength: 1, maxBytes: 64 }, slug: { type: "string", minLength: 1, maxBytes: 42 },
      updated: integer, part: { type: "integer", minimum: 0, maximum: 163 }, total: { type: "integer", minimum: 1, maximum: 164 },
      data: { type: "string", maxBytes: 1600 } } },
  value: { type: "object", additionalProperties: false, properties: { saved: integer, accepted: integer } },
}];

/** Small guest-safe encoding; native QuickJS has no browser TextEncoder. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    let n = ch.codePointAt(0)!;
    if (n >= 0xd800 && n <= 0xdfff) n = 0xfffd;
    if (n < 0x80) out.push(n);
    else if (n < 0x800) out.push(0xc0 | n >> 6, 0x80 | n & 63);
    else if (n < 0x10000) out.push(0xe0 | n >> 12, 0x80 | n >> 6 & 63, 0x80 | n & 63);
    else out.push(0xf0 | n >> 18, 0x80 | n >> 12 & 63, 0x80 | n >> 6 & 63, 0x80 | n & 63);
  }
  return new Uint8Array(out);
}
