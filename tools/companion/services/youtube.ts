// The youtube service (tools/companion/services.ts): YouTube for a console,
// with yt-dlp and ffmpeg on the Mac.
//
//   GET /feed?topic=tech|music|gaming|news   {items: Video[]}
//   GET /search?q=<text>                      {items: Video[]}
//   GET /video?id=<id>                        Video & {description}
//   GET /thumb?id=<id>                        an IMG entry (framework/compiler/
//                                             pak.ts): 128x64 RGB565, the
//                                             thumbnail cut to 2:1
//   GET /play?id=<id>&codec=h264|pal8&at=<s>  {source, codec, fps, frameW,
//                                             frameH, durationS, position}
//   GET /stop                                 {stopped}
//
// `play` publishes a one-use ticket on the companion's media stream server
// (tools/media-stream.ts); the console's media worker connects to it. H.264
// is the 512x256 baseline stream a New 3DS decodes in hardware. PAL8 is
// 240x136 at 12 frames a second on a fixed 252-colour cube with an ordered
// dither, each packet carrying only the pixels that changed, which an Old
// 3DS expands in software: about 75 KB/s against the 200 it took to send
// whole frames. Both carry 22,050 Hz stereo IMA ADPCM, and the console's
// credits pace the producer. When the console falls behind real time (an
// Old 3DS's Wi-Fi carries 100 to 150 KB/s), PAL8 frames are skipped until it
// catches up; the encoder keeps what the console has, so a skip costs no
// correctness. "Behind" is the stream's timestamps against the wall clock
// from its first frame: half a second behind skips frames (at most three in
// a row, so the stream and its audio keep moving). Two seconds behind is a
// console that stopped to rebuffer rather than a slow link, so the clock is
// set to the stream again. A console that is ahead blocks the producer on
// its credits, which is no reason to skip.
//
// YouTube no longer has a trending page that works without signing in, so a
// feed is a search for its topic (News sorted by upload date). Results are cached for ten minutes. Titles
// stay in UTF-8; the app folds what its fonts lack.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEDIA, type MediaCodec, type MediaSource } from "../../../contracts/spec/media.ts";
import { encodeMediaAudio } from "../../../contracts/spec/media-adpcm.ts";
import { IMG_FLAG_LINEAR, PSM } from "../../../contracts/spec/spec.ts";
import { encodeImageEntry } from "../../../framework/compiler/pak.ts";
import { createMediaStreamServer, createPal8Encoder, mediaHeader, quantizeCube, type MediaPacket } from "../../media-stream.ts";
import { envProxy } from "../fetch.ts";
import { ManagedTools } from "../tools.ts";
import { bytesResponse, jsonResponse, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../services.ts";

interface Video {
  id: string;
  title: string;
  channel: string;
  /** Seconds; 0 for a live stream or when unknown. */
  duration: number;
  views: number;
}

interface ResolvedVideo extends Video {
  description: string;
  /** Adaptive tracks, or the same URL for a muxed source. */
  videoUrl: string;
  audioUrl: string;
  width: number;
  height: number;
}

const TOPICS: Record<string, { query: string; recent: boolean }> = {
  tech: { query: "technology", recent: false },
  music: { query: "music video", recent: false },
  gaming: { query: "gaming", recent: false },
  news: { query: "news", recent: true },
};

export const THUMB = { width: 128, height: 64 } as const;
export const PAL8 = { width: 240, height: 136, fps: 12, maxSkips: 3, skipBehindMs: 500, resetBehindMs: 2000 } as const;
const H264 = { fps: 30, bitrate: 650_000, maxrate: 750_000 } as const;
const RESULTS = 20;
const CACHE_MS = 10 * 60_000;
const VIDEO_ID = /^[\w-]{11}$/;

/** The command lines the service runs; a test swaps in fakes. */
interface YoutubeTools {
  ytDlp: string[];
  ffmpeg: string[];
  /** Where a video's 320x180 thumbnail is; YouTube's by default. */
  thumbnailUrl?: (id: string) => string;
}

/** yt-dlp and ffmpeg: the ones the companion fetched (tools.ts), else where
 *  Homebrew and the usual installers put them, since a menu bar app starts
 *  with a short PATH. yt-dlp needs a JavaScript runtime for YouTube's player:
 *  the first of bun, deno and node found, else this program itself when it
 *  is the companion's compiled binary (BUN_BE_BUN makes it the bun CLI). */
export function findYoutubeTools(env: NodeJS.ProcessEnv = process.env, managed?: ManagedTools): YoutubeTools | null {
  const home = homedir();
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".deno", "bin"));
  const nvm = join(home, ".nvm", "versions", "node");
  if (existsSync(nvm)) for (const version of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, version, "bin"));
  const find = (name: string) => dirs.map((dir) => join(dir, name)).find((path) => existsSync(path));
  const ytDlp = managed?.ytDlp ?? find("yt-dlp");
  const ffmpeg = managed?.ffmpeg ?? find("ffmpeg");
  if (!ytDlp || !ffmpeg) return null;
  const runtime = (["bun", "deno", "node"] as const).map((name) => [name, find(name)] as const).find(([, path]) => path);
  const compiled = !runtime && Bun.main.startsWith("/$bunfs/");
  const js = runtime ? ["--js-runtimes", `${runtime[0]}:${runtime[1]}`] : compiled ? ["--js-runtimes", `bun:${process.execPath}`] : [];
  return {
    ytDlp: [...(compiled ? ["/usr/bin/env", "BUN_BE_BUN=1"] : []), ytDlp, "--ignore-config", ...js],
    ffmpeg: [ffmpeg],
  };
}

/** `flag` and the environment's proxy, or nothing without one. */
function proxyArgs(flag: string): string[] {
  const proxy = envProxy();
  return proxy ? [flag, proxy] : [];
}

async function run(command: string[], signal?: AbortSignal): Promise<{ ok: boolean; stdout: Uint8Array; stderr: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const stop = () => child.kill();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/** A process pipe as chunks (Bun's streams iterate; the DOM types say not). */
const chunks = (stream: ReadableStream<Uint8Array>) => stream as unknown as AsyncIterable<Uint8Array>;

/** A diagnostic without the signed media URLs ffmpeg and yt-dlp print. */
const scrub = (text: string) => text.replace(/https?:\/\/\S+/g, "[url]").trim().slice(-300);

function toVideo(j: Record<string, unknown>): Video | null {
  const id = typeof j.id === "string" ? j.id : "";
  const title = typeof j.title === "string" ? j.title : "";
  if (!VIDEO_ID.test(id) || !title) return null;
  return {
    id,
    title: title.slice(0, 200),
    channel: ((typeof j.channel === "string" && j.channel) || (typeof j.uploader === "string" && j.uploader) || "").slice(0, 80),
    duration: typeof j.duration === "number" ? Math.round(j.duration) : 0,
    views: typeof j.view_count === "number" ? j.view_count : 0,
  };
}

/** Fit a source in the 512x256 decoder plane for a box of `boxW` x `boxH`
 *  (the plane is shown stretched to the box). */
export function planeFit(width: number, height: number, boxW = 320, boxH = 180): { w: number; h: number } {
  const ratio = (width || 16) / (height || 9), box = boxW / boxH;
  return {
    w: Math.max(2, Math.floor((MEDIA.width * Math.min(1, ratio / box)) / 2) * 2),
    h: Math.max(2, Math.floor((MEDIA.height * Math.min(1, box / ratio)) / 2) * 2),
  };
}

/** Annex B access units, split at AUD NALs whatever the pipe's chunking. */
export async function* accessUnits(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let buffer = Buffer.alloc(0), scan = 0, first = -1;
  for await (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    for (; scan + 4 < buffer.length; scan++) {
      if (buffer[scan] || buffer[scan + 1]) continue;
      const prefix = buffer[scan + 2] === 1 ? 3 : buffer[scan + 2] === 0 && buffer[scan + 3] === 1 ? 4 : 0;
      if (!prefix || (buffer[scan + prefix]! & 31) !== 9) continue;
      if (first >= 0) {
        if (scan > MEDIA.packetBytes) throw new Error("encoded frame exceeds the decoder's packet");
        yield buffer.subarray(0, scan);
        buffer = buffer.subarray(scan);
        scan = 0;
      }
      first = 0;
      scan += prefix;
    }
    if (buffer.length > MEDIA.packetBytes * 2) throw new Error("no access unit delimiter within bounds");
  }
  if (buffer.length) {
    if (first < 0 || buffer.length > MEDIA.packetBytes) throw new Error("incomplete encoded video");
    yield buffer;
  }
}

/** `size`-byte pieces of a pipe whatever its chunking (RGB24 frames,
 *  PCM blocks); with `tail`, the bytes left at its end as well. */
export async function* fixedChunks(chunks: AsyncIterable<Uint8Array>, size: number, tail = false): AsyncGenerator<Uint8Array> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= size) {
      yield buffer.subarray(0, size);
      buffer = buffer.subarray(size);
    }
  }
  if (tail && buffer.length) yield buffer;
}

/** PAL8 packets from RGB24 frames, skipping frames while the stream is
 *  more than `skipBehindMs` behind the clock `now` (see the top comment). */
export async function* pal8Packets(frames: AsyncIterable<Uint8Array>, originMs: number, now: () => number = Date.now): AsyncGenerator<MediaPacket> {
  const encoder = createPal8Encoder(PAL8.width, PAL8.height);
  let frame = 0, started = -1, skips = 0;
  for await (const rgb of frames) {
    const ptsMs = originMs + Math.round((frame++ * 1000) / PAL8.fps);
    const at = now();
    if (started < 0) started = at;
    const behind = at - started - (ptsMs - originMs);
    if (behind > PAL8.resetBehindMs) started = at - (ptsMs - originMs);
    else if (behind > PAL8.skipBehindMs && skips < PAL8.maxSkips) {
      skips++;
      continue;
    }
    skips = 0;
    yield { kind: 1, ptsMs, data: encoder.encode(quantizeCube(rgb, PAL8.width, PAL8.height)) };
  }
}

/** ADPCM packets of MEDIA.audioFrames stereo s16 frames, the last one
 *  shorter. */
async function* pcmPackets(chunks: AsyncIterable<Uint8Array>, originMs: number): AsyncGenerator<MediaPacket> {
  let frames = 0;
  const indices: [number, number] = [0, 0];
  for await (const block of fixedChunks(chunks, MEDIA.audioFrames * 4, true)) {
    const bytes = block.subarray(0, block.length - (block.length % 4));
    if (!bytes.length) return;
    yield { kind: 2, ptsMs: originMs + Math.round((frames * 1000) / MEDIA.sampleRate), data: encodeMediaAudio(bytes, indices) };
    frames += bytes.length / 4;
  }
}

/** One video and one audio ffmpeg, interleaved by timestamp. */
async function* mediaPackets(tools: YoutubeTools, video: ResolvedVideo, codec: MediaCodec, seconds: number, signal: AbortSignal): AsyncGenerator<MediaPacket> {
  if (signal.aborted) return;
  const originMs = Math.round(seconds * 1000);
  const network = (url: string) =>
    /^https?:\/\//.test(url)
      ? [...proxyArgs("-http_proxy"), "-rw_timeout", "10000000",
          // googlevideo throttles one open-ended GET to a fraction of real
          // time; 1 MB ranges come at full speed (30 s of video in 0.75 s).
          "-request_size", "1048576", "-initial_request_size", "1048576", "-short_seek_size", "1048576", "-multiple_requests", "1"]
      : [];
  const common = [...tools.ffmpeg, "-hide_banner", "-loglevel", "error", "-xerror"];
  const seek = seconds > 0 ? ["-ss", String(seconds)] : [];
  const encode =
    codec === "pal8"
      ? ["-an", "-vf",
          `fps=${PAL8.fps},scale=${PAL8.width}:${PAL8.height}:flags=area:force_original_aspect_ratio=decrease,` +
          `pad=${PAL8.width}:${PAL8.height}:(ow-iw)/2:(oh-ih)/2:black`,
          "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
      : (() => {
          const fit = planeFit(video.width, video.height);
          // zerolatency turns on sliced threading, and MVD takes one slice a frame.
          return ["-an", "-vf", `fps=${H264.fps},scale=${fit.w}:${fit.h}:flags=lanczos,pad=${MEDIA.width}:${MEDIA.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-threads:v", "1", "-profile:v", "baseline", "-level:v", "3.0",
            "-pix_fmt", "yuv420p", "-b:v", String(H264.bitrate), "-maxrate", String(H264.maxrate), "-bufsize", "750000",
            "-g", "30", "-keyint_min", "30", "-bf", "0",
            "-x264-params", "aud=1:repeat-headers=1:scenecut=0:slices=1:sliced-threads=0", "-f", "h264", "pipe:1"];
        })();
  const videoProcess = Bun.spawn([...common, ...network(video.videoUrl), ...seek, "-i", video.videoUrl, ...encode], { stdout: "pipe", stderr: "pipe" });
  const audioProcess = Bun.spawn(
    [...common, ...network(video.audioUrl), ...seek, "-i", video.audioUrl, "-vn", "-ac", "2", "-ar", String(MEDIA.sampleRate), "-f", "s16le", "pipe:1"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stop = () => {
    videoProcess.kill();
    audioProcess.kill();
  };
  signal.addEventListener("abort", stop, { once: true });
  const tail = async (stream: ReadableStream<Uint8Array>) => {
    let text = "";
    for await (const chunk of chunks(stream)) text = (text + new TextDecoder().decode(chunk)).slice(-1000);
    return scrub(text);
  };
  const videoError = tail(videoProcess.stderr), audioError = tail(audioProcess.stderr);
  async function* videoPackets(): AsyncGenerator<MediaPacket> {
    let frame = 0;
    if (codec === "pal8") {
      for await (const packet of pal8Packets(fixedChunks(chunks(videoProcess.stdout), PAL8.width * PAL8.height * 3), originMs)) {
        frame++;
        yield packet;
      }
    } else {
      for await (const data of accessUnits(chunks(videoProcess.stdout))) yield { kind: 1, ptsMs: originMs + Math.round((frame++ * 1000) / H264.fps), data };
    }
    if ((await videoProcess.exited) || !frame) {
      if (!signal.aborted) throw new Error(`video encoder failed: ${await videoError}`);
    }
  }
  async function* audioPackets(): AsyncGenerator<MediaPacket> {
    let count = 0;
    for await (const packet of pcmPackets(chunks(audioProcess.stdout), originMs)) {
      count++;
      yield packet;
    }
    if ((await audioProcess.exited) || !count) {
      if (!signal.aborted) throw new Error(`audio encoder failed: ${await audioError}`);
    }
  }
  const v = videoPackets(), a = audioPackets();
  try {
    let [vp, ap] = await Promise.all([v.next(), a.next()]);
    while ((!vp.done || !ap.done) && !signal.aborted) {
      if (!vp.done && (ap.done || vp.value.ptsMs <= ap.value.ptsMs)) {
        yield vp.value;
        vp = await v.next();
      } else if (!ap.done) {
        yield ap.value;
        ap = await a.next();
      }
    }
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    await Promise.allSettled([videoProcess.exited, audioProcess.exited, videoError, audioError]);
  }
}

/** The program a command line runs: past an `env VAR=value` prefix. */
const program = (command: string[]): string => command.find((part, index) => !(index === 0 && part === "/usr/bin/env") && !/^\w+=/.test(part)) ?? command[0]!;

/** `tools` names the programs, or looks them up on each use (the default:
 *  the companion's own copies, else the Mac's), so a fetch takes effect at
 *  once. */
export function createYoutubeService(context: ServiceContext, tools?: YoutubeTools | null | (() => YoutubeTools | null)): ServiceProvider {
  const managed = new ManagedTools(context.storeDir, context.log);
  const lookup = typeof tools === "function" ? tools : tools === undefined ? () => findYoutubeTools(process.env, managed) : () => tools;
  const lists = new Map<string, { at: number; items: Video[] }>();
  const resolved = new Map<string, { at: number; video: ResolvedVideo }>();
  /** The media stream server, on every interface; a ticket names the
   *  address its console reaches. */
  let media: ReturnType<typeof createMediaStreamServer> | undefined;
  const server = () => (media ??= createMediaStreamServer({ log: context.log }));
  let active: MediaSource | undefined;

  const need = (): YoutubeTools => {
    const found = lookup();
    if (!found) throw new Error("YouTube is not set up on the Mac. Open Pocket Companion and set up YouTube.");
    return found;
  };

  /** `source`: a ytsearchN: query or a results page URL. */
  const list = async (key: string, source: string, signal: AbortSignal): Promise<Video[]> => {
    const cached = lists.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;
    const result = await run(
      [...need().ytDlp, ...proxyArgs("--proxy"), "--dump-json", "--flat-playlist", "--no-warnings", "--playlist-end", String(RESULTS), source],
      signal,
    );
    if (!result.ok) throw new Error(`yt-dlp search failed: ${scrub(result.stderr)}`);
    const items: Video[] = [];
    for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
      if (!line.trim()) continue;
      try {
        const video = toVideo(JSON.parse(line) as Record<string, unknown>);
        if (video) items.push(video);
      } catch {
        // yt-dlp interleaves notices with its JSON lines.
      }
    }
    lists.set(key, { at: Date.now(), items });
    return items;
  };

  const resolve = async (id: string, signal: AbortSignal): Promise<ResolvedVideo> => {
    const cached = resolved.get(id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.video;
    const result = await run(
      [...need().ytDlp, ...proxyArgs("--proxy"), "--dump-json", "--no-playlist", "--no-warnings",
        "-f", "bv[height<=480]+ba/b[height<=480]/bv+ba/b", `https://www.youtube.com/watch?v=${id}`],
      signal,
    );
    if (!result.ok) throw new Error(`yt-dlp could not open the video: ${scrub(result.stderr)}`);
    const j = JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, unknown>;
    const formats = Array.isArray(j.requested_formats) ? (j.requested_formats as Record<string, unknown>[]) : [j];
    const video = formats.find((f) => typeof f.url === "string" && f.vcodec !== "none");
    const audio = formats.find((f) => typeof f.url === "string" && f.acodec !== "none");
    const base = toVideo(j);
    if (!video || !audio || !base) throw new Error("yt-dlp gave no playable video and audio");
    const out: ResolvedVideo = {
      ...base,
      description: typeof j.description === "string" ? j.description.slice(0, 2000) : "",
      videoUrl: video.url as string,
      audioUrl: audio.url as string,
      width: typeof video.width === "number" ? video.width : 0,
      height: typeof video.height === "number" ? video.height : 0,
    };
    resolved.set(id, { at: Date.now(), video: out });
    return out;
  };

  const thumbnail = async (id: string, signal: AbortSignal): Promise<Uint8Array> => {
    // mqdefault is 320x180; the middle 320x160 scales to 128x64.
    const url = need().thumbnailUrl?.(id) ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    const result = await run(
      [...need().ffmpeg, "-hide_banner", "-loglevel", "error", ...(/^https?:\/\//.test(url) ? proxyArgs("-http_proxy") : []), "-i", url,
        "-vf", `crop=iw:iw/2,scale=${THUMB.width}:${THUMB.height}:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
      signal,
    );
    if (!result.ok || result.stdout.length !== THUMB.width * THUMB.height * 4) throw new Error(`thumbnail failed: ${scrub(result.stderr)}`);
    const rgba = result.stdout;
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return encodeImageEntry({ width: THUMB.width, height: THUMB.height, rgba }, PSM.PSM_5650, IMG_FLAG_LINEAR);
  };

  const stop = async () => {
    if (!active) return false;
    const source = active;
    active = undefined;
    (await server()).revoke(source);
    return true;
  };

  const play = async (request: ServiceRequest) => {
    const id = request.query.get("id") ?? "";
    const codec: MediaCodec = request.query.get("codec") === "pal8" ? "pal8" : "h264";
    if (!VIDEO_ID.test(id)) return jsonResponse(400, { error: "play needs a video id" });
    const video = await resolve(id, request.signal);
    const at = Math.max(0, Math.min(Number(request.query.get("at")) || 0, Math.max(0, video.duration - 1)));
    await stop();
    const fps = codec === "pal8" ? PAL8.fps : H264.fps;
    const toolset = need();
    const source = (await server()).publish(
      mediaHeader(Math.round(at * 1000), Math.max(0, video.duration) * 1000, fps, codec),
      (signal) => mediaPackets(toolset, video, codec, at, signal),
      request.console.localAddress,
    );
    active = source;
    context.log(`youtube: play ${id} ${codec} at ${at}s for ${request.console.name || request.console.address}`);
    return jsonResponse(200, {
      source,
      codec,
      fps,
      frameW: codec === "pal8" ? PAL8.width : MEDIA.width,
      frameH: codec === "pal8" ? PAL8.height : MEDIA.height,
      durationS: video.duration,
      position: at,
      title: video.title,
    });
  };

  return {
    name: "youtube",
    async handle(request) {
      switch (request.path) {
        case "/feed": {
          const topic = TOPICS[request.query.get("topic") ?? "tech"];
          if (!topic) return jsonResponse(400, { error: "unknown topic" });
          const key = `feed:${request.query.get("topic") ?? "tech"}`;
          // The newest first: the results page sorted by upload date (sp=CAI=).
          const source = topic.recent
            ? `https://www.youtube.com/results?search_query=${encodeURIComponent(topic.query)}&sp=CAI%253D`
            : `ytsearch${RESULTS}:${topic.query}`;
          return jsonResponse(200, { items: await list(key, source, request.signal) });
        }
        case "/search": {
          const q = (request.query.get("q") ?? "").trim();
          if (!q || q.length > 200) return jsonResponse(400, { error: "search needs words" });
          return jsonResponse(200, { items: await list(`search:${q.toLowerCase()}`, `ytsearch${RESULTS}:${q}`, request.signal) });
        }
        case "/video": {
          const id = request.query.get("id") ?? "";
          if (!VIDEO_ID.test(id)) return jsonResponse(400, { error: "video needs an id" });
          const { videoUrl: _v, audioUrl: _a, ...video } = await resolve(id, request.signal);
          return jsonResponse(200, video);
        }
        case "/thumb": {
          const id = request.query.get("id") ?? "";
          if (!VIDEO_ID.test(id)) return jsonResponse(400, { error: "thumb needs an id" });
          return bytesResponse(await thumbnail(id, request.signal), "application/x-pocket-img");
        }
        case "/play":
          return await play(request);
        case "/stop":
          return jsonResponse(200, { stopped: await stop() });
        default:
          return jsonResponse(404, { error: `no youtube endpoint ${request.path}` });
      }
    },
    async command(args) {
      const [verb = "status"] = args;
      if (verb === "install") {
        void managed.start().catch(() => {});
        return "Fetching yt-dlp and ffmpeg into the companion's tools folder.";
      }
      if (verb !== "status") return "youtube commands: status, install";
      const found = lookup();
      return found ? `yt-dlp: ${program(found.ytDlp)}\nffmpeg: ${found.ffmpeg[0]}` : "yt-dlp or ffmpeg is missing: bun tools/companion.ts service youtube install";
    },
    async state() {
      const found = lookup();
      return {
        ready: found !== null,
        ytDlp: found ? program(found.ytDlp) : null,
        ffmpeg: found?.ffmpeg[0] ?? null,
        managed: managed.ytDlp !== null,
        install: managed.install,
      };
    },
    close() {
      void media?.then((open) => open.close());
      media = undefined;
    },
  };
}
