// The podcasts service (tools/companion/services.ts): podcast search, feeds,
// artwork and playback for a console, with ffmpeg on the companion's
// computer.
//
//   GET /search?q=<text>                 {items: Show[]}: the iTunes Search API
//   GET /episodes?feed=<url>             the RSS feed as {title, author, artwork,
//                                        episodes: Episode[]}, newest first,
//                                        at most EPISODES
//   GET /art?url=<image url>&size=128|256  an IMG entry (framework/compiler/
//                                        pak.ts): size x size RGB565, the
//                                        picture scaled to cover and cut square
//   GET /play?url=<audio url>&at=<s>&duration=<s>  {source, position, durationS}
//   GET /stop                            {stopped}
//
// `play` publishes a one-use ticket on the companion's media stream server
// (tools/media-stream.ts); the console's media worker connects to it. The
// stream carries 22,050 Hz stereo IMA ADPCM and no pictures: its header
// names the rgb565 codec at 24 frames a second, which a GPU host accepts,
// and no video packet follows, so the host's plane stays black and the app
// draws the artwork. One ffmpeg decodes the episode's audio from `at` and
// writes PCM to a pipe read 4,096 bytes (1,024 stereo frames, one packet)
// at a time, so ffmpeg runs no further ahead than the console's credits.
//
// Every HTTP request goes through the owner's proxy when the environment
// names one (fetch.ts envProxy): the search and the feeds from this
// process, the artwork and the audio from ffmpeg (-http_proxy). Searches
// and feeds are cached ten minutes, artwork ART_CACHE pictures.

import { closeSync, read } from "node:fs";
import { MEDIA, type MediaSource } from "../../../contracts/spec/media.ts";
import { encodeMediaAudio } from "../../../contracts/spec/media-adpcm.ts";
import { IMG_FLAG_LINEAR, PSM } from "../../../contracts/spec/spec.ts";
import { encodeImageEntry } from "../../../framework/compiler/pak.ts";
import { createMediaStreamServer, mediaHeader, type MediaPacket } from "../../media-stream.ts";
import { envProxy } from "../fetch.ts";
import { bytesResponse, jsonResponse, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../services.ts";
import { COMPUTER } from "../computer.ts";

export interface Show {
  id: string;
  title: string;
  author: string;
  feedUrl: string;
  /** The artwork's URL, for /art. */
  artwork: string;
}

export interface Episode {
  guid: string;
  title: string;
  /** Milliseconds since the epoch; 0 when the feed gives no date. */
  published: number;
  /** Seconds; 0 when the feed gives no duration. */
  durationS: number;
  audioUrl: string;
  /** Plain text, at most DESCRIPTION_CHARS. */
  description: string;
}

export interface Feed {
  title: string;
  author: string;
  artwork: string;
  episodes: Episode[];
}

const RESULTS = 20;
export const EPISODES = 60;
const DESCRIPTION_CHARS = 1000;
const CACHE_MS = 10 * 60_000;
/** Artwork entries kept, newest asked last. */
const ART_CACHE = 40;
export const ART_SIZES = [128, 256] as const;
/** A feed is read up to this many bytes; an item cut at the end is dropped. */
const FEED_MAX_BYTES = 8 * 1024 * 1024;
/** The stream's header names this picture rate; no picture is sent. */
const FPS = 24;
/** Bytes of one audio packet: MEDIA.audioFrames stereo s16 frames. */
const PACKET_BYTES = MEDIA.audioFrames * 4;
const SEARCH_URL = "https://itunes.apple.com/search?media=podcast&limit=" + RESULTS + "&term=";
const USER_AGENT = "PocketCompanion/1.0 (podcasts)";

const isHttp = (url: string) => /^https?:\/\/[^\s/]+/.test(url) && url.length <= 2048;

/** `flag` and the environment's proxy, or nothing without one. */
function proxyArgs(flag: string): string[] {
  const proxy = envProxy();
  return proxy ? [flag, proxy] : [];
}

/** A diagnostic without the URLs ffmpeg prints. */
const scrub = (text: string) => text.replace(/https?:\/\/\S+/g, "[url]").trim().slice(-300);

/** `url` fetched through the owner's proxy; the body is read up to `maxBytes`. */
async function fetchText(url: string, signal: AbortSignal, maxBytes: number): Promise<string> {
  const proxy = envProxy();
  const response = await fetch(url, { signal, redirect: "follow", headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml, application/json, */*" }, ...(proxy ? { proxy } : {}) } as RequestInit);
  if (!response.ok) throw new Error(`the server answered ${response.status}`);
  if (!response.body) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    parts.push(value);
    total += value.length;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

// ---- the feed's XML --------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "...", mdash: "-", ndash: "-", rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"" };

/** Character and entity references as their characters. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** An element's character data: CDATA sections unwrapped, references decoded. */
function text(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner);
  return decodeEntities(unwrapped).trim();
}

const escapeRe = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first `<name>` element's content in `xml`, or "" (no nesting of the
 *  same name is read: a feed's elements are flat). */
export function element(xml: string, name: string): string {
  const match = new RegExp(`<${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(name)}\\s*>`, "i").exec(xml);
  return match ? text(match[1]!) : "";
}

/** The first `<name>` element's `attribute`, or "". */
export function attribute(xml: string, name: string, attributeName: string): string {
  const open = new RegExp(`<${escapeRe(name)}(\\s[^>]*)?/?>`, "i").exec(xml);
  if (!open?.[1]) return "";
  const value = new RegExp(`(?:^|\\s)${escapeRe(attributeName)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(open[1]);
  return value ? decodeEntities(value[1] ?? value[2] ?? "").trim() : "";
}

/** Every `<item>` block of the feed, in document order. */
function items(xml: string): string[] {
  const out: string[] = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
  for (let match = re.exec(xml); match; match = re.exec(xml)) out.push(match[1]!);
  return out;
}

/** HTML show notes as plain text of at most `limit` characters: a block
 *  element starts a line, an inline one leaves no mark. */
export function plainText(html: string, limit = DESCRIPTION_CHARS): string {
  const stripped = html
    .replace(/<\s*\/?\s*(br|p|div|li|ul|ol|h[1-6]|tr|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const flat = decodeEntities(stripped).replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return flat.length > limit ? flat.slice(0, limit - 3).trimEnd() + "..." : flat;
}

/** A title or a name: one line of plain text of at most `limit` characters. */
const line = (value: string, limit: number) => plainText(value, limit).replace(/\s+/g, " ").trim();

/** "1:02:03", "62:03" or "3723" as seconds; 0 when unreadable. */
export function durationSeconds(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed));
  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part)) || parts.length > 3) return 0;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0));
}

const AUDIO_URL = /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|$)/i;

export function parseFeed(xml: string): Feed {
  // The channel's own elements come before its items.
  const firstItem = xml.search(/<item(?:\s|>)/i);
  const channel = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
  const artwork = attribute(channel, "itunes:image", "href") || element(element(channel, "image"), "url");
  const episodes: Episode[] = [];
  for (const item of items(xml)) {
    const audioUrl = attribute(item, "enclosure", "url");
    const type = attribute(item, "enclosure", "type");
    if (!isHttp(audioUrl)) continue;
    if (type && !/^audio\//i.test(type) && !AUDIO_URL.test(audioUrl)) continue;
    const title = line(element(item, "title"), 200);
    if (!title) continue;
    const published = Date.parse(element(item, "pubDate")) || 0;
    const notes = element(item, "content:encoded") || element(item, "description") || element(item, "itunes:summary");
    episodes.push({
      guid: (element(item, "guid") || audioUrl).slice(0, 500),
      title,
      published,
      durationS: durationSeconds(element(item, "itunes:duration")),
      audioUrl,
      description: plainText(notes),
    });
  }
  // Newest first; a feed without dates keeps its order.
  episodes.sort((a, b) => b.published - a.published);
  return {
    title: line(element(channel, "title"), 200),
    author: line(element(channel, "itunes:author") || element(channel, "managingEditor"), 80),
    artwork: isHttp(artwork) ? artwork : "",
    episodes: episodes.slice(0, EPISODES),
  };
}

// ---- the search --------------------------------------------------------------------

function toShow(j: Record<string, unknown>): Show | null {
  const feedUrl = typeof j.feedUrl === "string" ? j.feedUrl : "";
  const title = typeof j.collectionName === "string" ? j.collectionName : "";
  if (!isHttp(feedUrl) || !title) return null;
  const artwork = [j.artworkUrl600, j.artworkUrl100, j.artworkUrl60].find((url): url is string => typeof url === "string" && isHttp(url)) ?? "";
  return {
    id: String(j.collectionId ?? j.trackId ?? feedUrl),
    title: title.slice(0, 200),
    author: (typeof j.artistName === "string" ? j.artistName : "").slice(0, 80),
    feedUrl,
    artwork,
  };
}

// ---- the audio stream ----------------------------------------------------------------

const readInto = (fd: number, buffer: Uint8Array) =>
  new Promise<number>((resolve, reject) => read(fd, buffer, 0, buffer.length, null, (error, n) => (error ? reject(error) : resolve(n))));

/** ffmpeg's pipe as PACKET_BYTES pieces read only when the consumer asks
 *  (the last one shorter): Bun buffers a piped stdout without bound, so a
 *  console slower than ffmpeg would have the companion hold the whole
 *  decoded episode. Reading the descriptor leaves ffmpeg blocked on a full
 *  pipe instead. Bun hands the parent's end over non-blocking, so an empty
 *  pipe is EAGAIN and a short wait. The descriptor is closed at the end. */
async function* packetChunks(fd: number): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(PACKET_BYTES);
  let filled = 0;
  try {
    for (;;) {
      let n: number;
      try {
        n = await readInto(fd, buffer.subarray(filled));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        await Bun.sleep(5);
        continue;
      }
      if (n === 0) break;
      filled += n;
      if (filled === PACKET_BYTES) {
        yield buffer.slice();
        filled = 0;
      }
    }
    if (filled) yield buffer.slice(0, filled);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

/** ADPCM packets of the episode's audio from `seconds`: one ffmpeg decodes
 *  it to 22,050 Hz stereo PCM on fd 3. The stream server appends the END
 *  packet when this generator returns. */
async function* audioPackets(ffmpegPath: string, url: string, seconds: number, signal: AbortSignal): AsyncGenerator<MediaPacket> {
  if (signal.aborted) return;
  const originMs = Math.round(seconds * 1000);
  const ffmpeg = Bun.spawn(
    [ffmpegPath, "-hide_banner", "-loglevel", "error", "-nostdin",
      ...proxyArgs("-http_proxy"), "-user_agent", USER_AGENT,
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      ...(seconds > 0 ? ["-ss", String(seconds)] : []), "-i", url,
      "-vn", "-ac", String(MEDIA.channels), "-ar", String(MEDIA.sampleRate), "-f", "s16le", "pipe:3"],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  const out = packetChunks(ffmpeg.stdio[3] as number);
  const stop = () => ffmpeg.kill();
  signal.addEventListener("abort", stop, { once: true });
  const failure = (async () => {
    let tail = "";
    for await (const chunk of ffmpeg.stderr as unknown as AsyncIterable<Uint8Array>) tail = (tail + new TextDecoder().decode(chunk)).slice(-1000);
    return scrub(tail);
  })();
  let frames = 0;
  let count = 0;
  const indices: [number, number] = [0, 0];
  try {
    for await (const block of out) {
      const bytes = block.subarray(0, block.length - (block.length % 4));
      if (!bytes.length) break;
      yield { kind: 2, ptsMs: originMs + Math.round((frames * 1000) / MEDIA.sampleRate), data: encodeMediaAudio(bytes, indices) };
      frames += bytes.length / 4;
      count++;
    }
    if (((await ffmpeg.exited) || !count) && !signal.aborted) throw new Error(`audio decoder failed: ${await failure}`);
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    await Promise.allSettled([ffmpeg.exited, failure, out.return(undefined)]);
  }
}

/** ffmpeg: the PATH's, else where Homebrew and the usual installers put it. */
export function findFfmpeg(): string | null {
  return Bun.which("ffmpeg") ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((path) => Bun.which(path)) ?? null;
}

export function createPodcastsService(context: ServiceContext): ServiceProvider {
  const searches = new Map<string, { at: number; items: Show[] }>();
  const feeds = new Map<string, { at: number; feed: Feed }>();
  const art = new Map<string, Uint8Array>();
  const probed = new Map<string, number>();
  /** The media stream server, on every interface; a ticket names the
   *  address its console reaches. */
  let media: ReturnType<typeof createMediaStreamServer> | undefined;
  const server = () => (media ??= createMediaStreamServer({ log: context.log }));
  let active: MediaSource | undefined;

  const ffmpeg = (): string => {
    const found = findFfmpeg();
    if (!found) throw new Error(`Podcasts need ffmpeg on the ${COMPUTER}.`);
    return found;
  };

  const search = async (q: string, signal: AbortSignal): Promise<Show[]> => {
    const key = q.toLowerCase();
    const cached = searches.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;
    const body = JSON.parse(await fetchText(SEARCH_URL + encodeURIComponent(q), signal, 2 * 1024 * 1024)) as { results?: unknown[] };
    const items: Show[] = [];
    for (const entry of Array.isArray(body.results) ? body.results : []) {
      const show = entry && typeof entry === "object" ? toShow(entry as Record<string, unknown>) : null;
      if (show) items.push(show);
    }
    if (searches.size > 100) searches.clear();
    searches.set(key, { at: Date.now(), items });
    return items;
  };

  const feed = async (url: string, signal: AbortSignal): Promise<Feed> => {
    const cached = feeds.get(url);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.feed;
    const parsed = parseFeed(await fetchText(url, signal, FEED_MAX_BYTES));
    if (feeds.size > 100) feeds.clear();
    feeds.set(url, { at: Date.now(), feed: parsed });
    return parsed;
  };

  const artwork = async (url: string, size: number, signal: AbortSignal): Promise<Uint8Array> => {
    const key = `${size}:${url}`;
    const cached = art.get(key);
    if (cached) {
      // The newest asked are the last to go.
      art.delete(key);
      art.set(key, cached);
      return cached;
    }
    const child = Bun.spawn(
      [ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", ...proxyArgs("-http_proxy"), "-user_agent", USER_AGENT, "-i", url,
        "-vf", `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=area,crop=${size}:${size}`,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const [rgba, stderr, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0 || rgba.length !== size * size * 4) throw new Error(`artwork failed: ${scrub(stderr) || "no picture"}`);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      const entry = encodeImageEntry({ width: size, height: size, rgba }, PSM.PSM_5650, IMG_FLAG_LINEAR);
      art.set(key, entry);
      while (art.size > ART_CACHE) art.delete(art.keys().next().value as string);
      return entry;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };

  /** The episode's length from its container when the feed gave none;
   *  0 when ffprobe is missing or the file does not say. */
  const probe = async (url: string, signal: AbortSignal): Promise<number> => {
    const known = probed.get(url);
    if (known !== undefined) return known;
    const ffprobe = Bun.which("ffprobe");
    if (!ffprobe) return 0;
    let seconds = 0;
    try {
      const child = Bun.spawn(
        [ffprobe, "-v", "error", ...proxyArgs("-http_proxy"), "-user_agent", USER_AGENT, "-show_entries", "format=duration", "-of", "csv=p=0", url],
        { stdout: "pipe", stderr: "ignore", timeout: 20_000 },
      );
      const stop = () => child.kill();
      signal.addEventListener("abort", stop, { once: true });
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      signal.removeEventListener("abort", stop);
      if (code === 0) seconds = Math.max(0, Math.floor(Number(text.trim()) || 0));
    } catch {
      seconds = 0;
    }
    if (probed.size > 200) probed.clear();
    probed.set(url, seconds);
    return seconds;
  };

  const stop = async () => {
    if (!active) return false;
    const source = active;
    active = undefined;
    (await server()).revoke(source);
    return true;
  };

  const play = async (request: ServiceRequest) => {
    const url = request.query.get("url") ?? "";
    if (!isHttp(url)) return jsonResponse(400, { error: "play needs an audio url" });
    const ffmpegPath = ffmpeg();
    let durationS = Math.max(0, Math.floor(Number(request.query.get("duration")) || 0));
    if (!durationS) durationS = await probe(url, request.signal);
    const at = Math.max(0, Math.min(Math.floor(Number(request.query.get("at")) || 0), durationS ? Math.max(0, durationS - 1) : Number.MAX_SAFE_INTEGER));
    await stop();
    const source = (await server()).publish(
      mediaHeader(at * 1000, durationS * 1000, FPS, "rgb565"),
      (signal) => audioPackets(ffmpegPath, url, at, signal),
      request.console.localAddress,
    );
    active = source;
    context.log(`podcasts: play at ${at}s for ${request.console.name || request.console.address}`);
    return jsonResponse(200, { source, position: at, durationS });
  };

  return {
    name: "podcasts",
    async handle(request) {
      switch (request.path) {
        case "/search": {
          const q = (request.query.get("q") ?? "").trim();
          if (!q || q.length > 200) return jsonResponse(400, { error: "search needs words" });
          return jsonResponse(200, { items: await search(q, request.signal) });
        }
        case "/episodes": {
          const url = request.query.get("feed") ?? "";
          if (!isHttp(url)) return jsonResponse(400, { error: "episodes needs a feed url" });
          return jsonResponse(200, await feed(url, request.signal));
        }
        case "/art": {
          const url = request.query.get("url") ?? "";
          const size = Number(request.query.get("size") ?? ART_SIZES[0]);
          if (!isHttp(url)) return jsonResponse(400, { error: "art needs an image url" });
          if (!(ART_SIZES as readonly number[]).includes(size)) return jsonResponse(400, { error: `art size is one of ${ART_SIZES.join(", ")}` });
          return bytesResponse(await artwork(url, size, request.signal), "application/x-pocket-img");
        }
        case "/play":
          return await play(request);
        case "/stop":
          return jsonResponse(200, { stopped: await stop() });
        default:
          return jsonResponse(404, { error: `no podcasts endpoint ${request.path}` });
      }
    },
    async command(args) {
      const [verb = "status"] = args;
      if (verb !== "status") return "podcasts commands: status";
      const found = findFfmpeg();
      return found ? `ffmpeg: ${found}` : "ffmpeg is missing";
    },
    async state() {
      const found = findFfmpeg();
      return { ready: found !== null, ffmpeg: found };
    },
    close() {
      void media?.then((open) => open.close());
      media = undefined;
    },
  };
}
