// tests/companion-youtube.test.ts — the companion's youtube service
// (tools/companion/services/youtube.ts) with a fake yt-dlp (a Bun script
// that answers searches and resolves to a local clip) and the real ffmpeg,
// so the PAL8 and H.264 streams and the thumbnail are the bytes a console
// would get. The ffmpeg tests skip on a machine without ffmpeg.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEDIA } from "../contracts/spec/media.ts";
import { PSM } from "../contracts/spec/spec.ts";
import type { ServiceProvider } from "../tools/companion/services.ts";
import { accessUnits, createYoutubeService, fixedChunks, PAL8, pal8Packets, planeFit } from "../tools/companion/services/youtube.ts";
import { call, expectImg, serviceContext } from "./helpers/companion-service.ts";

const DIR = mkdtempSync(join(tmpdir(), "pocket-youtube-"));
const FFMPEG = Bun.which("ffmpeg");
const CLIP = join(DIR, "clip.mp4");
const THUMB = join(DIR, "thumb.jpg");
const CALLS = join(DIR, "calls.txt");
const YT_DLP = join(DIR, "yt-dlp.ts");

writeFileSync(
  YT_DLP,
  `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(CALLS)}, args.join(" ") + "\\n");
const target = args[args.length - 1];
if (target.startsWith("ytsearch") || target.includes("/results?")) {
  const words = target.startsWith("ytsearch") ? target.slice(target.indexOf(":") + 1) : new URL(target).searchParams.get("search_query");
  if (words === "broken") { console.error("ERROR: https://example.invalid/secret?sig=1 failed"); process.exit(1); }
  console.log("[youtube:search] notice line");
  for (let i = 0; i < 3; i++) console.log(JSON.stringify({ id: "vid" + i + "abcdefg", title: words + " " + i, channel: "Chan " + i, duration: 61 + i, view_count: 1000 * (i + 1) }));
  console.log(JSON.stringify({ id: "short", title: "a playlist, not a video" }));
} else {
  console.log(JSON.stringify({ id: "vid0abcdefg", title: "Clip", channel: "Chan", duration: 4, view_count: 7, description: "About the clip",
    requested_formats: [{ url: ${JSON.stringify(CLIP)}, vcodec: "avc1", acodec: "none", width: 640, height: 360 }, { url: ${JSON.stringify(CLIP)}, vcodec: "none", acodec: "mp4a" }] }));
}
`,
);

let service: ServiceProvider;

beforeAll(() => {
  if (FFMPEG) {
    Bun.spawnSync([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", CLIP]);
    Bun.spawnSync([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180", "-frames:v", "1", THUMB]);
  }
  service = createYoutubeService(
    serviceContext(DIR),
    { ytDlp: [process.execPath, YT_DLP], ffmpeg: [FFMPEG ?? "ffmpeg"], thumbnailUrl: () => THUMB },
  );
}, 60_000);

afterAll(() => {
  service.close?.();
  rmSync(DIR, { recursive: true, force: true });
});

const get = (path: string, query: Record<string, string> = {}) => call(service, path, { query, signal: new AbortController().signal });
const json = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n") : []);

describe("lists", () => {
  test("a search keeps the video rows yt-dlp printed and drops notices and non-videos; a second ask is cached", async () => {
    const first = await get("/search", { q: "pocket" });
    expect(first.status).toBe(200);
    const { items } = json(first.body);
    expect(items.map((item: { id: string }) => item.id)).toEqual(["vid0abcdefg", "vid1abcdefg", "vid2abcdefg"]);
    expect(items[1]).toEqual({ id: "vid1abcdefg", title: "pocket 1", channel: "Chan 1", duration: 62, views: 2000 });
    const before = calls().length;
    await get("/search", { q: "Pocket" });
    expect(calls().length).toBe(before);
  });

  test("a topic feed is a search for its words; news asks for the newest", async () => {
    await get("/feed", { topic: "news" });
    expect(calls().at(-1)).toContain("results?search_query=news&sp=CAI%253D");
    await get("/feed", { topic: "tech" });
    expect(calls().at(-1)).toContain("ytsearch20:technology");
    expect((await get("/feed", { topic: "cooking" })).status).toBe(400);
  });

  test("a failure reaches the console without the URLs yt-dlp printed", async () => {
    const failed = await get("/search", { q: "broken" }).catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).not.toContain("example.invalid");
  });

  test("video details carry no stream URLs", async () => {
    const detail = json((await get("/video", { id: "vid0abcdefg" })).body);
    expect(detail.description).toBe("About the clip");
    expect(JSON.stringify(detail)).not.toContain(CLIP);
    expect((await get("/video", { id: "../etc" })).status).toBe(400);
  });
});

describe.skipIf(!FFMPEG)("pictures and streams", () => {
  test("a thumbnail is a 128x64 RGB565 IMG entry", async () => {
    const thumb = await get("/thumb", { id: "vid0abcdefg" });
    expect(thumb.status).toBe(200);
    expectImg(thumb.body, 128, 64, PSM.PSM_5650);
  });

  /** Read a published stream as a console does: the token, then the header
   *  and packets, a credit back for each. */
  async function receive(source: { host: string; port: number; token: string }, packets: number) {
    return await new Promise<{ codec: number; fps: number; video: Uint8Array[]; audio: number }>((resolve, reject) => {
      const socket = createConnection(source.port, source.host, () => socket.write(source.token));
      let buffer = Buffer.alloc(0), header: Buffer | null = null, audio = 0;
      const video: Uint8Array[] = [];
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!header && buffer.length >= MEDIA.headerBytes) {
          header = buffer.subarray(0, MEDIA.headerBytes);
          buffer = buffer.subarray(MEDIA.headerBytes);
        }
        while (header && buffer.length >= MEDIA.packetHeaderBytes) {
          const size = buffer.readUInt32LE(4);
          if (buffer.length < MEDIA.packetHeaderBytes + size) break;
          if (buffer[0] === 1) video.push(buffer.subarray(16, 16 + size));
          if (buffer[0] === 2) audio++;
          buffer = buffer.subarray(16 + size);
          socket.write(Buffer.of(1));
          if (video.length + audio >= packets) {
            socket.destroy();
            return resolve({ codec: header.readUInt16LE(14), fps: header.readUInt16LE(12), video, audio });
          }
        }
      });
    });
  }

  test("PAL8: 240x136 delta frames at 12 a second, the palette in the first, and ADPCM audio", async () => {
    const play = json((await get("/play", { id: "vid0abcdefg", codec: "pal8" })).body);
    expect(play).toMatchObject({ codec: "pal8", fps: 12, frameW: 240, frameH: 136, durationS: 4, position: 0 });
    const stream = await receive(play.source, 30);
    expect([stream.codec, stream.fps]).toEqual([2, 12]);
    expect(stream.video.length).toBeGreaterThan(3);
    expect(stream.audio).toBeGreaterThan(3);
    const frame = stream.video[0]!, view = new DataView(frame.buffer, frame.byteOffset);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([240, 136, 252]);
    const next = stream.video[1]!;
    expect(new DataView(next.buffer, next.byteOffset).getUint16(4, true)).toBe(0);
    expect(next.length).toBeLessThan(8 + 240 * 136);
    expect(json((await get("/stop")).body).stopped).toBe(true);
  }, 60_000);

  test("H.264: baseline access units, each starting at an access unit delimiter", async () => {
    const play = json((await get("/play", { id: "vid0abcdefg", codec: "h264", at: "1" })).body);
    expect(play).toMatchObject({ codec: "h264", fps: 30, frameW: 512, frameH: 256, position: 1 });
    const stream = await receive(play.source, 20);
    expect(stream.codec).toBe(1);
    for (const unit of stream.video) expect(unit[0] === 0 && unit[1] === 0 && (unit[2] === 1 ? unit[3]! & 31 : unit[4]! & 31)).toBe(9);
    await get("/stop");
  }, 60_000);
});

describe("pure parts", () => {
  test("fixedChunks cuts a pipe into frames; pal8Packets skips frames only while the stream is behind", async () => {
    const frame = new Uint8Array(PAL8.width * PAL8.height * 3);
    async function* pipe() {
      yield frame.subarray(0, 1000);
      yield frame.subarray(1000);
    }
    let cut = 0;
    for await (const one of fixedChunks(pipe(), frame.length)) cut += one.length;
    expect(cut).toBe(frame.length);
    // Frames are due every 83 ms. The clock runs 10 ms a frame (the
    // producer is ahead: nothing skipped), then jumps 880 ms (more than half
    // a second behind: three frames skipped, then one sent as the limit is
    // reached), then 3 s (a rebuffer: the clock is reset to the stream and
    // nothing more is skipped).
    const ticks = [0, 10, 20, 900, 910, 920, 930, 940, 3940, 3950, 3960, 3970];
    let call = 0;
    const consumed: number[] = [];
    async function* twelve() {
      for (let i = 0; i < 12; i++) yield frame;
    }
    for await (const packet of pal8Packets(twelve(), 0, () => ticks[call++]!)) consumed.push(packet.ptsMs);
    expect(consumed).toEqual([0, 83, 167, 500, 583, 667, 750, 833, 917]);
  });

  test("accessUnits splits at AUD NALs across chunk boundaries", async () => {
    const aud = [0, 0, 0, 1, 9, 0xf0], slice = [0, 0, 1, 0x65, 1, 2, 3];
    const stream = Uint8Array.from([...aud, ...slice, ...aud, ...slice]);
    async function* chunks() {
      for (let i = 0; i < stream.length; i += 5) yield stream.subarray(i, i + 5);
    }
    const units: number[] = [];
    for await (const unit of accessUnits(chunks())) units.push(unit.length);
    expect(units).toEqual([13, 13]);
  });

  test("a 16:9 source fills the plane for a 16:9 box; a 4:3 one is pillarboxed", () => {
    expect(planeFit(1280, 720)).toEqual({ w: 512, h: 256 });
    expect(planeFit(640, 480).w).toBeLessThan(512);
  });
});
