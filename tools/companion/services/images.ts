// The images service (tools/companion/services.ts): a picture from the network
// for a console, whose guest has no image decoder.
//
//   GET /fetch?url=<https url>&w=<pow2>&h=<pow2>[&alpha=1][&round=1]
//
// answers an IMG entry (framework/compiler/pak.ts) scaled to cover the box and
// cropped at its centre: RGB565, or RGBA with `alpha`. `round` cuts a circle
// with a soft edge, for an avatar, and implies `alpha`. A picture is decoded
// once: the entry is kept under `<storeDir>/services/images/<sha256>.img`.
// ffmpeg decodes (JPEG, PNG, WebP), found as the maps service finds it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMG_FLAG_LINEAR, PSM } from "../../../contracts/spec/spec.ts";
import { encodeImageEntry } from "../../../framework/compiler/pak.ts";
import { envProxy } from "../fetch.ts";
import { bytesResponse, jsonResponse, type ServiceContext, type ServiceProvider } from "../services.ts";
import { ManagedTools } from "../tools.ts";
import { findFfmpeg, USER_AGENT } from "./maps.ts";

const SIDES = new Set([8, 16, 32, 64, 128, 256, 512]);
const FETCH_TIMEOUT_MS = 30_000;
const SOURCE_MAX = 8 * 1024 * 1024;
const IMG = "application/x-pocket-img";

/** A picture's bytes as `w` x `h` RGBA, scaled to cover and cropped at its centre. */
export async function decodeCover(ffmpeg: string, bytes: Uint8Array, w: number, h: number): Promise<Uint8Array | null> {
  const filter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const child = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { stdin: bytes, stdout: "pipe", stderr: "ignore" });
  const [rgba, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited]);
  return code === 0 && rgba.length === w * h * 4 ? rgba : null;
}

/** The alpha of a circle filling the square, with a one-pixel soft edge. */
export function cutCircle(rgba: Uint8Array, side: number): void {
  const r = side / 2;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const edge = r - Math.hypot(x + 0.5 - r, y + 0.5 - r);
      rgba[(y * side + x) * 4 + 3] = Math.max(0, Math.min(255, Math.round((edge + 0.5) * 255)));
    }
  }
}

export function createImagesService(context: ServiceContext): ServiceProvider {
  const dir = join(context.storeDir, "services", "images");
  const managed = new ManagedTools(context.storeDir);
  return {
    name: "images",
    async handle(request) {
      if (request.path !== "/fetch") return jsonResponse(404, { error: `no images endpoint ${request.path}` });
      const url = request.query.get("url") ?? "";
      const w = Number(request.query.get("w"));
      const h = Number(request.query.get("h"));
      if (!url.startsWith("https://")) return jsonResponse(400, { error: "fetch needs an https url" });
      if (!SIDES.has(w) || !SIDES.has(h)) return jsonResponse(400, { error: "w and h are powers of two from 8 to 512" });
      const round = request.query.get("round") === "1" && w === h;
      const file = join(dir, `${createHash("sha256").update(request.query.toString()).digest("hex")}.img`);
      if (existsSync(file)) return bytesResponse(new Uint8Array(readFileSync(file)), IMG);
      const ffmpeg = findFfmpeg(managed);
      if (!ffmpeg) return jsonResponse(503, { error: "Pictures need ffmpeg on this computer." });
      const proxy = envProxy();
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow", ...(proxy ? { proxy } : {}) } as RequestInit);
      if (!response.ok) return jsonResponse(502, { error: `the image's server answered ${response.status}` });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > SOURCE_MAX) return jsonResponse(413, { error: "that image is too large" });
      const rgba = await decodeCover(ffmpeg, bytes, w, h);
      if (!rgba) return jsonResponse(415, { error: "that image cannot be read" });
      if (round) cutCircle(rgba, w);
      const alpha = round || request.query.get("alpha") === "1";
      const entry = encodeImageEntry({ width: w, height: h, rgba }, alpha ? PSM.PSM_8888 : PSM.PSM_5650, IMG_FLAG_LINEAR);
      if (entry.length > request.maxBytes) return jsonResponse(413, { error: `the picture is ${entry.length} bytes, limit ${request.maxBytes}` });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, entry, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      return bytesResponse(entry, IMG);
    },
  };
}
