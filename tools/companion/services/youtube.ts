// The youtube service (tools/companion/services.ts): YouTube for a console,
// with yt-dlp and ffmpeg on the companion's computer.
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

import { closeSync, existsSync, read, readdirSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { MEDIA, type MediaCodec, type MediaSource } from "../../../contracts/spec/media.ts";
import { encodeMediaAudio } from "../../../contracts/spec/media-adpcm.ts";
import { IMG_FLAG_LINEAR, PSM } from "../../../contracts/spec/spec.ts";
import { encodeImageEntry } from "../../../framework/compiler/pak.ts";
import { createMediaStreamServer, createPal8Encoder, mediaHeader, quantizeCube, type MediaPacket } from "../../media-stream.ts";
import { envProxy } from "../fetch.ts";
import { ManagedTools } from "../tools.ts";
import { bytesResponse, jsonResponse, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../services.ts";
import { COMPUTER, INSTALL_MEDIA_TOOLS } from "../computer.ts";

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
/** How long a yt-dlp resolve may run: under the 90 s the app gives /play. */
const RESOLVE_TIMEOUT_MS = 80_000;
const VIDEO_ID = /^[\w-]{11}$/;

/** A companion with under 1 GiB of memory (a CardputerZero has 227 MiB)
 *  runs one yt-dlp or ffmpeg job at a time, a video's resolve ahead of the
 *  thumbnails, and gives yt-dlp no JavaScript runtime: a second Bun for
 *  YouTube's player challenge was the heaviest process of a resolve there
 *  (yt-dlp alone peaked at 62 MB and took 23 s; with Bun beside it the
 *  machine ran out of memory). */
export const LEAN = totalmem() < 1024 ** 3;

/** At most `slots` jobs at once, in order, except that a job asked `first`
 *  starts before the queued ones. A job whose signal aborts while it waits
 *  never starts. */
export function createJobQueue(slots: number) {
  let running = 0;
  const queue: { first: boolean; start: () => void }[] = [];
  const next = () => {
    while (running < slots && queue.length) {
      const at = queue.findIndex((job) => job.first);
      const [job] = queue.splice(at >= 0 ? at : 0, 1);
      running++;
      job!.start();
    }
  };
  return async <T>(work: () => Promise<T>, options: { first?: boolean; signal?: AbortSignal } = {}): Promise<T> => {
    // A request cancelled before its turn takes no slot.
    if (options.signal?.aborted) throw new Error("aborted");
    await new Promise<void>((resolve, reject) => {
      const job = { first: !!options.first, start: resolve };
      queue.push(job);
      options.signal?.addEventListener(
        "abort",
        () => {
          const at = queue.indexOf(job);
          if (at < 0) return;
          queue.splice(at, 1);
          reject(new Error("aborted"));
        },
        { once: true },
      );
      next();
    });
    try {
      if (options.signal?.aborted) throw new Error("aborted");
      return await work();
    } finally {
      running--;
      next();
    }
  };
}

/** ffmpeg 8's ranged HTTP requests (-request_size, -initial_request_size);
 *  ffmpeg 7.1 (Debian 13's) refuses the options. Asked once per binary, and
 *  without blocking: a synchronous ffmpeg start right after a yt-dlp
 *  resolve held a CardputerZero's event loop (and the USB carrier's beat)
 *  for 11 s. */
const rangedRequests = new Map<string, Promise<boolean>>();
function hasRangedRequests(ffmpeg: string): Promise<boolean> {
  let known = rangedRequests.get(ffmpeg);
  if (!known) {
    known = (async () => {
      try {
        const help = Bun.spawn([ffmpeg, "-hide_banner", "-h", "protocol=http"], { stdout: "pipe", stderr: "ignore" });
        const text = await new Response(help.stdout).text();
        await help.exited;
        return text.includes("-request_size");
      } catch {
        return false;
      }
    })();
    rangedRequests.set(ffmpeg, known);
  }
  return known;
}

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
export function findYoutubeTools(env: NodeJS.ProcessEnv = process.env, managed?: ManagedTools, lean = LEAN): YoutubeTools | null {
  const home = homedir();
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".deno", "bin"));
  const nvm = join(home, ".nvm", "versions", "node");
  if (existsSync(nvm)) for (const version of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, version, "bin"));
  const find = (name: string) => dirs.map((dir) => join(dir, name)).find((path) => existsSync(path));
  const ytDlp = managed?.ytDlp ?? find("yt-dlp");
  const ffmpeg = managed?.ffmpeg ?? find("ffmpeg");
  if (!ytDlp || !ffmpeg) return null;
  const runtime = lean ? undefined : (["bun", "deno", "node"] as const).map((name) => [name, find(name)] as const).find(([, path]) => path);
  const compiled = !lean && !runtime && Bun.main.startsWith("/$bunfs/");
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

async function run(command: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<{ ok: boolean; stdout: Uint8Array; stderr: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const stop = () => child.kill();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

const readInto = (fd: number, buffer: Uint8Array) =>
  new Promise<number>((resolve, reject) => read(fd, buffer, 0, buffer.length, null, (error, n) => (error ? reject(error) : resolve(n))));

/** A subprocess's extra pipe as chunks, read only when the consumer asks:
 *  Bun buffers a piped stdout without bound (1 GB in 3 s from a fast
 *  writer), so a console slower than ffmpeg had the companion hold the
 *  whole decoded stream; a CardputerZero ran out of memory in three
 *  minutes. Reading the descriptor leaves the writer blocked on a full
 *  pipe. Bun hands the parent's end over non-blocking, so an empty pipe is
 *  EAGAIN and a short wait. The descriptor is closed at the end. */
export async function* pipeChunks(fd: number, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  // One buffer waits through every EAGAIN; a short read is copied out, so
  // only a full buffer goes to the consumer and is replaced.
  let buffer = new Uint8Array(size);
  try {
    for (;;) {
      let n: number;
      try {
        n = await readInto(fd, buffer);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        await Bun.sleep(5);
        continue;
      }
      if (n === 0) return;
      if (n < size) yield buffer.slice(0, n);
      else {
        yield buffer;
        buffer = new Uint8Array(size);
      }
    }
  } finally {
    try {
      closeSync(fd);
    } catch {}
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

/** A packet stream read ahead by up to `ahead` packets while the consumer
 *  takes from the other: one process writes both pipes, and a pipe nobody
 *  reads blocks it. `stop()` ends the reading and the source. */
export function lookahead<T>(source: AsyncGenerator<T>, ahead: number) {
  const items: T[] = [];
  let done = false;
  let stopped = false;
  let error: unknown;
  let wake: (() => void) | null = null;
  let room: (() => void) | null = null;
  const signal = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const pump = (async () => {
    try {
      for await (const item of source) {
        items.push(item);
        signal();
        while (items.length >= ahead && !stopped) await new Promise<void>((resolve) => (room = resolve));
        if (stopped) break;
      }
    } catch (cause) {
      error = cause;
    } finally {
      done = true;
      signal();
    }
  })();
  const free = () => {
    const resolve = room;
    room = null;
    resolve?.();
  };
  return {
    pump,
    head: (): T | undefined => items[0],
    take: (): T => {
      const item = items.shift()!;
      free();
      return item;
    },
    full: () => items.length >= ahead,
    done: () => done && items.length === 0,
    error: () => error,
    /** Resolves when a packet arrives or the source ends. */
    changed: () => new Promise<void>((resolve) => (wake = resolve)),
    stop: () => {
      stopped = true;
      free();
    },
  };
}

/** Packets of two lookahead streams in timestamp order. A side with nothing
 *  read yet holds the other back until the other's lookahead is full: then
 *  the full side goes first, because its writer may be blocked on that pipe
 *  (a track that ends early, a large frame). */
export async function* mergeByTime(
  v: ReturnType<typeof lookahead<MediaPacket>>,
  a: ReturnType<typeof lookahead<MediaPacket>>,
  signal: AbortSignal,
): AsyncGenerator<MediaPacket> {
  while (!signal.aborted) {
    // A side that failed has its packets taken first.
    const failed = (v.head() ? undefined : v.error()) ?? (a.head() ? undefined : a.error());
    if (failed) throw failed;
    const vh = v.head(), ah = a.head();
    if (vh && ah) yield vh.ptsMs <= ah.ptsMs ? v.take() : a.take();
    else if (vh && (a.done() || v.full())) yield v.take();
    else if (ah && (v.done() || a.full())) yield a.take();
    else if (v.done() && a.done()) return;
    else await Promise.race([v.changed(), a.changed()]);
  }
}

/** Video and audio packets each side reads ahead (a few pictures, about 1.5 s
 *  of sound). */
const VIDEO_AHEAD = 4;
const AUDIO_AHEAD = 32;

/** One ffmpeg for the picture (fd 3) and the sound (fd 4), interleaved by
 *  timestamp: two processes held about 43 MB each on a CardputerZero, most
 *  of it the same libraries. Each pipe is read a few packets ahead
 *  (pipeChunks, lookahead), so ffmpeg runs no further ahead than the
 *  console and never waits on a pipe the merge is not reading. */
async function* mediaPackets(tools: YoutubeTools, video: ResolvedVideo, codec: MediaCodec, seconds: number, signal: AbortSignal): AsyncGenerator<MediaPacket> {
  if (signal.aborted) return;
  const originMs = Math.round(seconds * 1000);
  const ranged = await hasRangedRequests(tools.ffmpeg[0]!);
  const network = (url: string) =>
    /^https?:\/\//.test(url)
      ? [...proxyArgs("-http_proxy"), "-rw_timeout", "10000000",
          // googlevideo throttles one open-ended GET to a fraction of real
          // time; 1 MB ranges come at full speed (30 s of video in 0.75 s).
          ...(ranged ? ["-request_size", "1048576", "-initial_request_size", "1048576"] : []),
          "-short_seek_size", "1048576", "-multiple_requests", "1",
          // A DASH format's parameters are in its first bytes; the default
          // 5 MB probe cost a CardputerZero 3 to 4 s before the first frame.
          "-probesize", "262144", "-analyzeduration", "500000"]
      : [];
  const common = [...tools.ffmpeg, "-hide_banner", "-loglevel", "error", "-xerror"];
  const seek = seconds > 0 ? ["-ss", String(seconds)] : [];
  const encode =
    codec === "pal8"
      ? ["-vf",
          `fps=${PAL8.fps},scale=${PAL8.width}:${PAL8.height}:flags=area:force_original_aspect_ratio=decrease,` +
          `pad=${PAL8.width}:${PAL8.height}:(ow-iw)/2:(oh-ih)/2:black`,
          "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:3"]
      : (() => {
          const fit = planeFit(video.width, video.height);
          // zerolatency turns on sliced threading, and MVD takes one slice a frame.
          return ["-vf", `fps=${H264.fps},scale=${fit.w}:${fit.h}:flags=lanczos,pad=${MEDIA.width}:${MEDIA.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-threads:v", "1", "-profile:v", "baseline", "-level:v", "3.0",
            "-pix_fmt", "yuv420p", "-b:v", String(H264.bitrate), "-maxrate", String(H264.maxrate), "-bufsize", "750000",
            "-g", "30", "-keyint_min", "30", "-bf", "0",
            "-x264-params", "aud=1:repeat-headers=1:scenecut=0:slices=1:sliced-threads=0", "-f", "h264", "pipe:3"];
        })();
  // A combined format names one URL for both.
  const inputs = video.audioUrl === video.videoUrl
    ? [...network(video.videoUrl), ...seek, "-i", video.videoUrl]
    : [...network(video.videoUrl), ...seek, "-i", video.videoUrl, ...network(video.audioUrl), ...seek, "-i", video.audioUrl];
  const audioInput = video.audioUrl === video.videoUrl ? 0 : 1;
  const ffmpeg = Bun.spawn(
    [...common, ...inputs, "-map", "0:v:0", ...encode,
      "-map", `${audioInput}:a:0`, "-ac", "2", "-ar", String(MEDIA.sampleRate), "-f", "s16le", "pipe:4"],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  const videoOut = pipeChunks(ffmpeg.stdio[3] as number), audioOut = pipeChunks(ffmpeg.stdio[4] as number);
  const stop = () => ffmpeg.kill();
  signal.addEventListener("abort", stop, { once: true });
  const tail = async (stream: ReadableStream<Uint8Array>) => {
    let text = "";
    for await (const chunk of chunks(stream)) text = (text + new TextDecoder().decode(chunk)).slice(-1000);
    return scrub(text);
  };
  const failure = tail(ffmpeg.stderr as ReadableStream<Uint8Array>);
  async function* videoPackets(): AsyncGenerator<MediaPacket> {
    let frame = 0;
    if (codec === "pal8") {
      for await (const packet of pal8Packets(fixedChunks(videoOut, PAL8.width * PAL8.height * 3), originMs)) {
        frame++;
        yield packet;
      }
    } else {
      for await (const data of accessUnits(videoOut)) yield { kind: 1, ptsMs: originMs + Math.round((frame++ * 1000) / H264.fps), data };
    }
    if ((await ffmpeg.exited) || !frame) {
      if (!signal.aborted) throw new Error(`video encoder failed: ${await failure}`);
    }
  }
  async function* audioPackets(): AsyncGenerator<MediaPacket> {
    let count = 0;
    for await (const packet of pcmPackets(audioOut, originMs)) {
      count++;
      yield packet;
    }
    if ((await ffmpeg.exited) || !count) {
      if (!signal.aborted) throw new Error(`audio encoder failed: ${await failure}`);
    }
  }
  const v = lookahead(videoPackets(), VIDEO_AHEAD), a = lookahead(audioPackets(), AUDIO_AHEAD);
  try {
    yield* mergeByTime(v, a, signal);
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    v.stop();
    a.stop();
    await Promise.allSettled([ffmpeg.exited, failure, v.pump, a.pump, videoOut.return(undefined), audioOut.return(undefined)]);
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
  const jobs = createJobQueue(LEAN ? 1 : 4);

  const need = (): YoutubeTools => {
    const found = lookup();
    if (!found) throw new Error(`YouTube is not set up on the ${COMPUTER}. Open Pocket Companion and set up YouTube.`);
    return found;
  };

  /** `source`: a ytsearchN: query or a results page URL. */
  const list = async (key: string, source: string, signal: AbortSignal): Promise<Video[]> => {
    const cached = lists.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;
    const result = await jobs(
      () =>
        run(
          [...need().ytDlp, ...proxyArgs("--proxy"), "--dump-json", "--flat-playlist", "--no-warnings", "--playlist-end", String(RESULTS), source],
          signal,
        ),
      { signal },
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
    const result = await jobs(
      () =>
        run(
          [...need().ytDlp, ...proxyArgs("--proxy"), "--no-playlist", "--no-warnings", "--skip-download",
            // H.264 at 360p first: both planes are at most 512x256, and a small
            // companion (a CardputerZero) decodes AVC at a fraction of VP9's or
            // AV1's cost.
            "-f", "bv[height<=360][vcodec^=avc1]+ba/bv[height<=480]+ba/b[height<=480]/bv+ba/b",
            // The fields this service reads, about 6 KB: the whole info JSON is
            // 11 MB (every format and caption track) for a companion to parse.
            "--print", "%(.{id,title,channel,uploader,duration,view_count,description,url,vcodec,acodec,width,height})j",
            "--print", "%(requested_formats.:.{url,vcodec,acodec,width,height})j",
            `https://www.youtube.com/watch?v=${id}`],
          signal,
          // A small companion resolves in 25 to 55 s; the app waits 90 s for /play.
          RESOLVE_TIMEOUT_MS,
        ),
      { signal, first: true },
    );
    if (!result.ok) throw new Error(`yt-dlp could not open the video: ${scrub(result.stderr)}`);
    const [info, requested] = new TextDecoder().decode(result.stdout).split("\n").filter((line) => line.startsWith("{") || line.startsWith("["));
    const j = JSON.parse(info ?? "{}") as Record<string, unknown>;
    // A single combined format prints NA for requested_formats.
    const picked = requested ? (JSON.parse(requested) as unknown) : null;
    const formats = Array.isArray(picked) ? (picked as Record<string, unknown>[]) : [j];
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
    const result = await jobs(
      () =>
        run(
          [...need().ffmpeg, "-hide_banner", "-loglevel", "error", ...(/^https?:\/\//.test(url) ? proxyArgs("-http_proxy") : []), "-i", url,
            "-vf", `crop=iw:iw/2,scale=${THUMB.width}:${THUMB.height}:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
          signal,
        ),
      { signal },
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
