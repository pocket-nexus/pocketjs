// The reddit service (tools/companion/services.ts): Reddit's public JSON for
// a console app, read without an account, with ffmpeg on the companion's
// computer for the pictures.
//
//   GET /feed?sub=<name|popular>&sort=hot|new|top&after=<id>
//                                  {items: Post[], after}: one page of r/<sub>
//   GET /post?id=<id>              {post: Post, comments: Comment[]}: the post
//                                  and its comment tree flattened in reading
//                                  order, each comment with its depth
//   GET /subs?q=<text>             {items: Subreddit[]}: subreddit search
//   GET /thumb?id=<id>             an IMG entry (framework/compiler/pak.ts):
//                                  the post's thumbnail scaled to cover
//                                  128x80 and cut, in the top-left of a
//                                  128x128 RGB565 texture (IMG dims are pow2)
//   GET /image?id=<id>             an IMG entry: the post's preview picture
//                                  fit in 480x300 and centred on a dark
//                                  field, in the top-left of a 512x512
//                                  RGB565 texture
//
//   GET  /setup                   {ready, mode}: "app" (a client id), "account"
//                                  (a script app with the owner's login), "none"
//   POST /setup                   {clientId, clientSecret?, username?,
//                                  password?} -> {ok, message}: a token is
//                                  fetched to check the app, then the fields
//                                  are kept (<store>/services/reddit/setup.json,
//                                  0600); they never reach a console
//   POST /forget                  -> {ok}
//
// Reddit answers its public JSON to home networks and refuses it (403) or
// rate-limits it (429) from the addresses proxies and data centres use. With
// a setup the requests go to oauth.reddit.com with an app token instead: an
// "installed app" from reddit.com/prefs/apps needs only its client id (the
// installed_client grant, one device id kept with the setup); a "script"
// app takes the secret and the owner's login (the password grant). A token
// lasts an hour and is fetched again when it expires or Reddit answers 401.
//
// Every request to Reddit carries the User-Agent pocket-reddit/0.1 and goes
// through the owner's proxy when the environment names one (fetch.ts
// envProxy): the JSON from this process, the pictures from ffmpeg
// (-http_proxy). Pages, posts and searches are cached CACHE_MS; decoded
// pictures IMAGE_CACHE entries. Bodies arrive as the HTML Reddit renders
// from the markdown (raw_json=1 leaves it unescaped) and leave as plain
// text: paragraphs, list items, quotes and code blocks, no markup. The
// console folds what its fonts lack.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IMG_FLAG_LINEAR, PSM } from "../../../contracts/spec/spec.ts";
import { encodeImageEntry } from "../../../framework/compiler/pak.ts";
import { envProxy } from "../fetch.ts";
import { jsonResponse, bytesResponse, readJson, ServiceError, type ServiceContext, type ServiceProvider } from "../services.ts";
import { writeSecret } from "../store.ts";
import { COMPUTER } from "../computer.ts";
import { createJobQueue, LEAN } from "./youtube.ts";

export interface Post {
  id: string;
  title: string;
  author: string;
  /** The subreddit's name without r/. */
  sub: string;
  score: number;
  comments: number;
  /** Seconds since the epoch. */
  created: number;
  url: string;
  domain: string;
  isSelf: boolean;
  /** Plain text, at most SELFTEXT_CHARS. */
  selftext: string;
  /** The post has a thumbnail for /thumb. */
  thumb: boolean;
  /** The preview picture's URL (for /image), or null. */
  preview: string | null;
}

export interface Comment {
  id: string;
  depth: number;
  author: string;
  score: number;
  created: number;
  /** Plain text, at most BODY_CHARS. */
  body: string;
}

export interface Subreddit {
  name: string;
  title: string;
  subscribers: number;
  description: string;
}

export const THUMB = { width: 128, height: 80, texture: 128 } as const;
export const IMAGE = { width: 480, height: 300, texture: 512 } as const;
const PAGE = 25;
const COMMENTS_LIMIT = 120;
const COMMENTS_DEPTH = 6;
const COMMENTS_MAX = 200;
const SUBS = 12;
const SELFTEXT_CHARS = 2000;
const BODY_CHARS = 3000;
const CACHE_MS = 2 * 60_000;
/** Decoded pictures kept, newest asked last. */
const IMAGE_CACHE = 40;
/** Posts whose picture URLs are kept for /thumb and /image. */
const PICTURES = 3000;
/** The largest JSON read from Reddit; a comments page with 120 bodies is a few hundred KB. */
const JSON_MAX_BYTES = 4 * 1024 * 1024;
const USER_AGENT = "pocket-reddit/0.1";
const ORIGIN = "https://www.reddit.com";
const OAUTH_ORIGIN = "https://oauth.reddit.com";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
/** A token is fetched again this long before Reddit's expiry. */
const TOKEN_SLACK_MS = 60_000;
export const REDDIT_SETUP_HINT = "Make an installed app at reddit.com/prefs/apps and enter its client id in Setup.";

/** What the owner set up: an app's client id, with the secret and the
 *  owner's login for a script app; `deviceId` names this device to Reddit
 *  for the installed_client grant. */
export interface RedditSetup {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  deviceId: string;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{10,64}$/;

/** The fields of a setup as a request or a command gives them; a
 *  ServiceError names what is wrong. */
export function setupFrom(fields: Record<string, unknown>, deviceId: string): RedditSetup {
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const clientId = text(fields.clientId, 64);
  if (!CLIENT_ID.test(clientId)) throw new ServiceError(400, { ok: false, error: "The client id is the short code under the app's name at reddit.com/prefs/apps." });
  const username = text(fields.username, 40);
  const password = text(fields.password, 200);
  const clientSecret = text(fields.clientSecret, 100);
  if ((username && !password) || (!username && password)) throw new ServiceError(400, { ok: false, error: "A login needs both the username and the password." });
  if (username && !clientSecret) throw new ServiceError(400, { ok: false, error: "A login goes with a script app, which has a secret." });
  return { clientId, clientSecret, username, password, deviceId };
}

/** A device id for the installed_client grant: 24 letters and digits. */
export function newDeviceId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
const ID = /^[a-z0-9]{1,12}$/;
const SUB = /^[A-Za-z0-9_]{1,24}$/;
const SORTS = new Set(["hot", "new", "top"]);
/** The preview rendition asked for: the smallest at least this wide. */
const PREVIEW_MIN_WIDTH = 480;

const isHttp = (url: string) => /^https?:\/\/[^\s/]+/.test(url) && url.length <= 2048;

/** `flag` and the environment's proxy, or nothing without one. */
function proxyArgs(flag: string): string[] {
  const proxy = envProxy();
  return proxy ? [flag, proxy] : [];
}

/** A fetch failure's message without Bun's advice about `verbose: true`. */
const reason = (error: unknown) => ((error as Error).message ?? String(error)).split(". For more information")[0];

/** A diagnostic without the URLs ffmpeg prints. */
const scrub = (text: string) => text.replace(/https?:\/\/\S+/g, "[url]").trim().slice(-300);

/** ffmpeg: the PATH's, else where Homebrew and the usual installers put it. */
export function findFfmpeg(): string | null {
  return Bun.which("ffmpeg") ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((path) => Bun.which(path)) ?? null;
}

// ---- HTML to text -------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", times: "×", copy: "©",
};

/** Character and entity references as their characters; unknown names stay. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? whole;
  });
}

/** Reddit's rendered markdown as text: paragraphs one blank line apart,
 *  list items as "- " lines, quoted paragraphs as "> " lines, code blocks
 *  with their line breaks, table rows as " | " lines, links as their
 *  text, every other tag dropped. */
export function htmlToText(html: string): string {
  if (!html) return "";
  const blocks: string[] = [];
  // Code blocks first, so their newlines survive the whitespace collapse.
  let source = html.replace(/<pre>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_, code: string) => {
    blocks.push(decodeEntities(code.replace(/<[^>]*>/g, "")).replace(/\s+$/, ""));
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });
  // Quotes: each paragraph inside gets the "> " mark after the split below.
  source = source.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) =>
    `\n\n${inner.replace(/<\/?p\s*\/?>/gi, "\n\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `\u0001${p}`).join("\n\n")}\n\n`,
  );
  source = source
    .replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    // Items and table rows are lines of one paragraph: the list or the table.
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/?(?:p|h[1-6]|ul|ol|div|table)[^>]*>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]*>/g, "");
  const paragraphs = source
    .split(/\n{2,}/)
    .map((paragraph) => decodeEntities(paragraph.replace(/[ \t\r]+/g, " ").replace(/ ?\n ?/g, "\n").trim()).replace(/^\u0001/, "> "))
    .filter((paragraph) => paragraph !== "");
  return paragraphs
    .join("\n\n")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => blocks[Number(index)] ?? "")
    .trim();
}

/** `text` cut at `max` characters, with "..." when it was. */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text);

// ---- Reddit's JSON --------------------------------------------------------------------

type Json = Record<string, unknown>;
const str = (value: unknown, max = 400) => (typeof value === "string" ? value.slice(0, max) : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The children of a Listing, or none. */
const children = (listing: unknown): Json[] => arr(obj(listing)?.data && (obj(listing)!.data as Json).children).map(obj).filter((c): c is Json => c !== null);

/** Where a post's pictures are: its thumbnail (a URL; Reddit's words "self",
 *  "default", "nsfw", "spoiler" and "image" name none) and the preview
 *  rendition /image fetches. */
interface Pictures {
  thumb: string | null;
  preview: string | null;
}

function picturesOf(d: Json): Pictures {
  const thumb = str(d.thumbnail, 2048);
  const images = arr(obj(d.preview)?.images);
  const first = obj(images[0]);
  let preview: string | null = null;
  if (first) {
    const renditions = arr(first.resolutions).map(obj).filter((r): r is Json => r !== null);
    const fit = renditions.find((r) => num(r.width) >= PREVIEW_MIN_WIDTH) ?? obj(first.source);
    const url = str(fit?.url, 2048);
    if (isHttp(url)) preview = url;
  }
  return { thumb: isHttp(thumb) ? thumb : null, preview };
}

function toPost(d: Json): Post | null {
  const id = str(d.id, 12);
  const title = str(d.title, 300);
  if (!ID.test(id) || !title) return null;
  const html = str(d.selftext_html, 20_000);
  const selftext = html ? htmlToText(html) : str(d.selftext, 20_000);
  const pictures = picturesOf(d);
  return {
    id,
    title,
    author: str(d.author, 40),
    sub: str(d.subreddit, 24),
    score: Math.round(num(d.score)),
    comments: Math.round(num(d.num_comments)),
    created: Math.round(num(d.created_utc)),
    url: str(d.url, 2048),
    domain: str(d.domain, 80),
    isSelf: d.is_self === true,
    selftext: clip(selftext, SELFTEXT_CHARS),
    thumb: pictures.thumb !== null,
    preview: pictures.preview,
  };
}

function toSubreddit(d: Json): Subreddit | null {
  const name = str(d.display_name, 24);
  if (!SUB.test(name)) return null;
  return {
    name,
    title: str(d.title, 100),
    subscribers: Math.round(num(d.subscribers)),
    description: clip(str(d.public_description, 2000).replace(/\s+/g, " ").trim(), 200),
  };
}

/** The comment tree in reading order, each with its depth; "more" stubs
 *  are left out, as are deleted comments with no replies. */
export function flattenComments(listing: unknown, depth = 0, out: Comment[] = []): Comment[] {
  for (const child of children(listing)) {
    if (out.length >= COMMENTS_MAX) break;
    if (child.kind !== "t1") continue;
    const d = obj(child.data);
    if (!d) continue;
    const id = str(d.id, 12);
    if (!ID.test(id)) continue;
    const html = str(d.body_html, 40_000);
    const text = html ? htmlToText(html) : str(d.body, 40_000);
    const replies = d.replies;
    const deleted = text === "[deleted]" || text === "[removed]" || d.author === "[deleted]";
    if (deleted && children(replies).length === 0) continue;
    out.push({
      id,
      depth,
      author: str(d.author, 40) || "[deleted]",
      score: Math.round(num(d.score)),
      created: Math.round(num(d.created_utc)),
      body: clip(text, BODY_CHARS),
    });
    if (replies && typeof replies === "object") flattenComments(replies, depth + 1, out);
  }
  return out;
}

export function createRedditService(context: ServiceContext): ServiceProvider {
  const setupFile = join(context.storeDir, "services", "reddit", "setup.json");
  const loadSetup = (): RedditSetup | null => {
    if (!existsSync(setupFile)) return null;
    try {
      const raw = JSON.parse(readFileSync(setupFile, "utf8")) as Partial<RedditSetup>;
      return setupFrom(raw, typeof raw.deviceId === "string" && raw.deviceId ? raw.deviceId : newDeviceId());
    } catch {
      return null;
    }
  };
  let setup: RedditSetup | null = loadSetup();
  let token: { value: string; expires: number; for: RedditSetup } | null = null;
  const saveSetup = (next: RedditSetup) => {
    writeSecret(setupFile, JSON.stringify(next));
    setup = next;
    token = null;
  };
  const forgetSetup = () => {
    rmSync(setupFile, { force: true });
    setup = null;
    token = null;
  };
  const mode = (): "app" | "account" | "none" => (setup ? (setup.username ? "account" : "app") : "none");

  /** An app token for `pair` from Reddit, through the proxy. */
  const fetchToken = async (pair: RedditSetup, signal?: AbortSignal): Promise<{ value: string; expires: number }> => {
    const proxy = envProxy();
    const body = new URLSearchParams(
      pair.username
        ? { grant_type: "password", username: pair.username, password: pair.password }
        : { grant_type: "https://oauth.reddit.com/grants/installed_client", device_id: pair.deviceId },
    );
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        signal,
        headers: {
          "user-agent": USER_AGENT,
          authorization: `Basic ${Buffer.from(`${pair.clientId}:${pair.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        ...(proxy ? { proxy } : {}),
      } as RequestInit);
    } catch (error) {
      if (signal?.aborted) throw new Error("cancelled");
      throw new ServiceError(502, { error: `Reddit could not be reached for a token: ${reason(error)}` });
    }
    let answer: { access_token?: unknown; expires_in?: unknown; error?: unknown } = {};
    try {
      answer = (await response.json()) as typeof answer;
    } catch {
      // Not JSON: the status says enough.
    }
    if (response.status === 401) throw new ServiceError(401, { error: "Reddit refused the app's client id (or its secret).", setup: REDDIT_SETUP_HINT });
    if (!response.ok || typeof answer.access_token !== "string") {
      const why = typeof answer.error === "string" ? answer.error : `HTTP ${response.status}`;
      throw new ServiceError(401, { error: `Reddit gave no token: ${why}.`, setup: REDDIT_SETUP_HINT });
    }
    const seconds = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
    return { value: answer.access_token, expires: Date.now() + seconds * 1000 - TOKEN_SLACK_MS };
  };

  const bearer = async (force: boolean, signal: AbortSignal): Promise<string> => {
    const pair = setup!;
    if (!force && token && token.for === pair && token.expires > Date.now()) return token.value;
    const fresh = await fetchToken(pair, signal);
    token = { ...fresh, for: pair };
    return fresh.value;
  };

  const feeds = new Map<string, { at: number; items: Post[]; after: string | null }>();
  const posts = new Map<string, { at: number; post: Post; comments: Comment[] }>();
  const searches = new Map<string, { at: number; items: Subreddit[] }>();
  /** Picture URLs by post id, from every page read. */
  const pictures = new Map<string, Pictures>();
  const images = new Map<string, Uint8Array>();
  const pending = new Map<string, Promise<Uint8Array>>();
  const jobs = createJobQueue(LEAN ? 1 : 3);

  const ffmpeg = (): string => {
    const found = findFfmpeg();
    if (!found) throw new Error(`Reddit's pictures need ffmpeg on the ${COMPUTER}.`);
    return found;
  };

  const remember = (post: Post, d: Json) => {
    pictures.delete(post.id);
    pictures.set(post.id, picturesOf(d));
    while (pictures.size > PICTURES) pictures.delete(pictures.keys().next().value as string);
  };

  /** Reddit's JSON at `path` (under ORIGIN, raw_json=1 added), through the
   *  proxy; with a setup, the same path on oauth.reddit.com with the app's
   *  token, fetched again once when Reddit answers 401. */
  const getJson = async (path: string, signal: AbortSignal, retried = false): Promise<unknown> => {
    const proxy = envProxy();
    const withApp = setup !== null;
    const url = withApp
      ? `${OAUTH_ORIGIN}${path.replace(/\.json(?=\?|$)/, "")}${path.includes("?") ? "&" : "?"}raw_json=1`
      : `${ORIGIN}${path}${path.includes("?") ? "&" : "?"}raw_json=1`;
    const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
    if (withApp) headers.authorization = `bearer ${await bearer(retried, signal)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        signal,
        redirect: "follow",
        headers,
        ...(proxy ? { proxy } : {}),
      } as RequestInit);
    } catch (error) {
      if (signal.aborted) throw new Error("cancelled");
      throw new Error(`Reddit could not be reached: ${reason(error)}`);
    }
    if (withApp && response.status === 401 && !retried) return getJson(path, signal, true);
    if (response.status === 429) throw new ServiceError(503, { error: withApp ? "Reddit is rate limiting the app. Try again in a minute." : "Reddit is rate limiting this address. An app of your own gets its own allowance.", ...(withApp ? {} : { setup: REDDIT_SETUP_HINT }) });
    if (response.status === 403) {
      throw new ServiceError(502, withApp
        ? { error: "Reddit refused the app's request (403)." }
        : { error: "Reddit refuses anonymous requests from this network's address.", setup: REDDIT_SETUP_HINT });
    }
    if (response.status === 404) throw new ServiceError(404, { error: "Reddit has no such page." });
    if (!response.ok) throw new ServiceError(502, { error: `Reddit answered ${response.status}.` });
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > JSON_MAX_BYTES) throw new ServiceError(502, { error: "Reddit's answer was too large." });
    const bytes = await response.bytes();
    if (bytes.length > JSON_MAX_BYTES) throw new ServiceError(502, { error: "Reddit's answer was too large." });
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ServiceError(502, { error: "Reddit's answer was not JSON." });
    }
  };

  const feed = async (sub: string, sort: string, after: string, signal: AbortSignal) => {
    const key = `${sub.toLowerCase()}:${sort}:${after}`;
    const cached = feeds.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached;
    const query = `limit=${PAGE}${after ? `&after=t3_${after}` : ""}${sort === "top" ? "&t=day" : ""}`;
    const listing = await getJson(`/r/${sub}/${sort}.json?${query}`, signal);
    const items: Post[] = [];
    for (const child of children(listing)) {
      const d = obj(child.data);
      const post = child.kind === "t3" && d ? toPost(d) : null;
      if (!post) continue;
      items.push(post);
      remember(post, d!);
    }
    const next = str(obj(obj(listing)?.data)?.after, 20).replace(/^t3_/, "");
    const page = { at: Date.now(), items, after: ID.test(next) ? next : null };
    if (feeds.size > 100) feeds.clear();
    feeds.set(key, page);
    return page;
  };

  const thread = async (id: string, signal: AbortSignal) => {
    const cached = posts.get(id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached;
    const listings = arr(await getJson(`/comments/${id}.json?limit=${COMMENTS_LIMIT}&depth=${COMMENTS_DEPTH}`, signal));
    const head = children(listings[0])[0];
    const d = head && head.kind === "t3" ? obj(head.data) : null;
    const post = d ? toPost(d) : null;
    if (!post) throw new ServiceError(404, { error: "Reddit has no such post." });
    remember(post, d!);
    const page = { at: Date.now(), post, comments: flattenComments(listings[1]) };
    if (posts.size > 100) posts.clear();
    posts.set(id, page);
    return page;
  };

  const subs = async (q: string, signal: AbortSignal): Promise<Subreddit[]> => {
    const key = q.toLowerCase();
    const cached = searches.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS * 5) return cached.items;
    const listing = await getJson(`/subreddits/search.json?q=${encodeURIComponent(q)}&limit=${SUBS}`, signal);
    const items: Subreddit[] = [];
    for (const child of children(listing)) {
      const d = obj(child.data);
      const sub = child.kind === "t5" && d ? toSubreddit(d) : null;
      if (sub) items.push(sub);
    }
    if (searches.size > 100) searches.clear();
    searches.set(key, { at: Date.now(), items });
    return items;
  };

  /** A post's picture URLs: from a page read, else from Reddit (the
   *  companion restarted since the page was listed). */
  const picturesFor = async (id: string, signal: AbortSignal): Promise<Pictures> => {
    const known = pictures.get(id);
    if (known) return known;
    const listing = await getJson(`/api/info.json?id=t3_${id}`, signal);
    const d = obj(children(listing)[0]?.data);
    const post = d ? toPost(d) : null;
    if (!post) throw new ServiceError(404, { error: "Reddit has no such post." });
    remember(post, d!);
    return pictures.get(id)!;
  };

  /** `url` decoded by ffmpeg through `filter` to a `texture` square RGBA
   *  frame, as an RGB565 IMG entry. */
  const picture = async (url: string, filter: string, texture: number, signal: AbortSignal): Promise<Uint8Array> => {
    const result = await jobs(
      async () => {
        const child = Bun.spawn(
          [ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", ...proxyArgs("-http_proxy"), "-user_agent", USER_AGENT, "-i", url,
            "-vf", filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
          { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
        );
        const stop = () => child.kill();
        signal.addEventListener("abort", stop, { once: true });
        try {
          const [rgba, stderr, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
          return { rgba, stderr, code };
        } finally {
          signal.removeEventListener("abort", stop);
        }
      },
      { signal },
    );
    if (result.code !== 0 || result.rgba.length !== texture * texture * 4) throw new Error(`picture failed: ${scrub(result.stderr) || "no picture"}`);
    const rgba = result.rgba;
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return encodeImageEntry({ width: texture, height: texture, rgba }, PSM.PSM_5650, IMG_FLAG_LINEAR);
  };

  /** The cached entry for `key`, else `make` it once however many ask. */
  const cachedImage = async (key: string, make: () => Promise<Uint8Array>): Promise<Uint8Array> => {
    const cached = images.get(key);
    if (cached) {
      // The newest asked are the last to go.
      images.delete(key);
      images.set(key, cached);
      return cached;
    }
    let inFlight = pending.get(key);
    if (!inFlight) {
      inFlight = make().then((entry) => {
        images.set(key, entry);
        while (images.size > IMAGE_CACHE) images.delete(images.keys().next().value as string);
        return entry;
      }).finally(() => pending.delete(key));
      pending.set(key, inFlight);
    }
    return inFlight;
  };

  const thumbFilter = `scale=${THUMB.width}:${THUMB.height}:force_original_aspect_ratio=increase:flags=area,crop=${THUMB.width}:${THUMB.height},pad=${THUMB.texture}:${THUMB.texture}:0:0:0x141414`;
  const imageFilter = `scale=${IMAGE.width}:${IMAGE.height}:force_original_aspect_ratio=decrease:flags=area,pad=${IMAGE.width}:${IMAGE.height}:(ow-iw)/2:(oh-ih)/2:0x141414,pad=${IMAGE.texture}:${IMAGE.texture}:0:0:0x141414`;

  return {
    name: "reddit",
    async handle(request) {
      switch (request.path) {
        case "/setup": {
          if (request.method === "GET") return jsonResponse(200, { ready: setup !== null, mode: mode() });
          if (request.method !== "POST") return jsonResponse(405, { error: "setup takes GET or POST" });
          const body = readJson<Record<string, unknown>>(request, { ok: false, error: "setup needs JSON {clientId, clientSecret?, username?, password?}" });
          const next = setupFrom(body, setup?.deviceId ?? newDeviceId());
          let fresh: { value: string; expires: number };
          try {
            fresh = await fetchToken(next, request.signal);
          } catch (error) {
            if (error instanceof ServiceError) throw new ServiceError(error.status, { ok: false, ...error.body, message: error.body.error });
            throw error;
          }
          saveSetup(next);
          token = { ...fresh, for: next };
          context.log(`reddit: set up with ${next.username ? "a script app and a login" : "an installed app"}`);
          return jsonResponse(200, { ok: true, message: next.username ? `Signed in as ${next.username}.` : "The app answers; Reddit reads through it now." });
        }
        case "/forget": {
          if (request.method !== "POST") return jsonResponse(405, { error: "forget takes POST" });
          forgetSetup();
          context.log("reddit: the setup is forgotten");
          return jsonResponse(200, { ok: true });
        }
        case "/feed": {
          const sub = request.query.get("sub") || "popular";
          const sort = request.query.get("sort") || "hot";
          const after = request.query.get("after") ?? "";
          if (!SUB.test(sub)) return jsonResponse(400, { error: "feed needs a subreddit name" });
          if (!SORTS.has(sort)) return jsonResponse(400, { error: "sort is hot, new or top" });
          if (after && !ID.test(after)) return jsonResponse(400, { error: "after is a post id" });
          const page = await feed(sub, sort, after, request.signal);
          return jsonResponse(200, { items: page.items, after: page.after });
        }
        case "/post": {
          const id = request.query.get("id") ?? "";
          if (!ID.test(id)) return jsonResponse(400, { error: "post needs an id" });
          const page = await thread(id, request.signal);
          return jsonResponse(200, { post: page.post, comments: page.comments });
        }
        case "/subs": {
          const q = (request.query.get("q") ?? "").trim();
          if (!q || q.length > 100) return jsonResponse(400, { error: "subs needs words" });
          return jsonResponse(200, { items: await subs(q, request.signal) });
        }
        case "/thumb": {
          const id = request.query.get("id") ?? "";
          if (!ID.test(id)) return jsonResponse(400, { error: "thumb needs a post id" });
          const url = (await picturesFor(id, request.signal)).thumb;
          if (!url) return jsonResponse(404, { error: "the post has no thumbnail" });
          return bytesResponse(await cachedImage(`thumb:${id}`, () => picture(url, thumbFilter, THUMB.texture, request.signal)), "application/x-pocket-img");
        }
        case "/image": {
          const id = request.query.get("id") ?? "";
          if (!ID.test(id)) return jsonResponse(400, { error: "image needs a post id" });
          const url = (await picturesFor(id, request.signal)).preview;
          if (!url) return jsonResponse(404, { error: "the post has no preview picture" });
          return bytesResponse(await cachedImage(`image:${id}`, () => picture(url, imageFilter, IMAGE.texture, request.signal)), "application/x-pocket-img");
        }
        default:
          return jsonResponse(404, { error: `no reddit endpoint ${request.path}` });
      }
    },
    async command(args) {
      const [verb, ...rest] = args;
      switch (verb) {
        case "setup": {
          const [clientId, clientSecret = "", username = "", password = ""] = rest;
          const next = setupFrom({ clientId, clientSecret, username, password }, setup?.deviceId ?? newDeviceId());
          const fresh = await fetchToken(next);
          saveSetup(next);
          token = { ...fresh, for: next };
          return `reddit: set up with ${next.username ? `a script app as ${next.username}` : "an installed app"}`;
        }
        case "status":
          return setup ? `reddit: ${mode()} (client id ${setup.clientId.slice(0, 4)}...)` : "reddit: no app set up; public JSON from this address";
        case "forget":
          forgetSetup();
          return "reddit: the setup is forgotten";
        default:
          throw new Error("usage: reddit setup <clientId> [clientSecret] [username] [password] | status | forget");
      }
    },
    async state() {
      const found = findFfmpeg();
      return { ready: true, ffmpeg: found, pictures: images.size, setup: mode() };
    },
  };
}
