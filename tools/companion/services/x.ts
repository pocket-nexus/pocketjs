// The X service (tools/companion/services.ts): the owner's X timeline and
// threads for a console app, read with the session of a sign-in on this Mac.
//
// Sign-in. `bun tools/companion.ts service x login` opens a window on the Mac
// (macos/WebSignIn.swift) at x.com's login, in a private WebKit store. When
// the auth_token and ct0 cookies appear the helper hands them to the provider
// and quits; the provider keeps them 0600 in <store>/services/x/session.json.
// `service x cookies <auth_token> <ct0>` stores a pair copied from a browser
// instead. No response, log line or command output carries either value.
//
// The API is x.com's own web client's, which is not a public interface and
// changes. The provider reads its operations from the client's scripts
// instead of pinning them: it loads x.com/home with the session, follows the
// scripts it names (a bounded crawl of their imports) and collects
//   - Relay persisted operations, `params:{id,…,name,operationKind}`, sent as
//     GET https://api.x.com/graphql/<id>/<name>?variables=… (the current
//     client), and
//   - classic operations, `queryId:"…",operationName:"…",…featureSwitches`,
//     sent to https://x.com/i/api/graphql/<id>/<name> with the feature list.
// The result is cached in operations.json and read again when a request
// answers that the operation is unknown. Posts are found in a response by
// shape (an object with rest_id, a legacy text and a user), not by path, so
// a reshaped timeline still reads.
//
// Endpoints (JSON unless noted):
//   GET /x/status                 {signedIn}
//   GET /x/timeline?kind=following|foryou&cursor=…   {posts, cursor}
//   GET /x/post/<id>[?cursor=…]   {post, before, replies, cursor}
//   GET /x/avatar?u=<image url>   an IMG entry (32x32 RGB565, round on white)
//   POST /x/like?id=<post id>     {ok}
// A failure is {error, message}: error "signed-out" (status 401) when there
// is no session or X refused it, "api" (502) when X answered with an error.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PSM } from "../../../contracts/spec/spec.ts";
import { decodePng, encodeImageEntry, type DecodedImage } from "../../../framework/compiler/pak.ts";
import { bytesResponse, jsonResponse, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../services.ts";
import { helperCommand } from "../swift-helper.ts";

/** The web client's public bearer token (the same for every visitor). */
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
export const WEB_SIGN_IN_SOURCE = join(import.meta.dir, "..", "macos", "WebSignIn.swift");
export const X_AVATAR_SIZE = 32;
/** Scripts the operation crawl reads at most, and at once. */
const CRAWL_MAX = 1500;
const CRAWL_PARALLEL = 8;
const OPERATIONS_MAX_AGE_MS = 24 * 3600 * 1000;
/** A request that finds an operation unknown reads the scripts again at
 *  most this often. */
const REDISCOVER_MS = 10 * 60 * 1000;
/** Scripts read past the one that named the timeline before the crawl gives
 *  up on a conversation operation (the classic fallback covers it). */
const CRAWL_PAST_TIMELINE = 300;
const PAGE = 20;
const TEXT_MAX = 1200;

export interface XPost {
  id: string;
  name: string;
  handle: string;
  text: string;
  /** ms since the epoch */
  time: number;
  replies: number;
  reposts: number;
  likes: number;
  views?: number;
  /** The handle this post answers. */
  replyTo?: string;
  /** The name of who reposted it into the timeline. */
  repostedBy?: string;
  quote?: { name: string; handle: string; text: string };
  media?: { count: number; kind: "photo" | "video" | "gif" };
  avatar?: string;
}

export interface XOperation {
  kind: "relay" | "classic";
  id: string;
  name: string;
  type: string;
  features?: string[];
  toggles?: string[];
}

export interface XOptions {
  origin?: string;
  apiOrigin?: string;
  fetch?: typeof fetch;
  /** Image bytes (JPEG, PNG) to a square of `size` pixels; null when the
   *  image cannot be read. Default: `sips` and the pak PNG decoder. */
  decodeAvatar?: (bytes: Uint8Array, size: number) => Promise<DecodedImage | null>;
  /** The sign-in helper's command; default: macos/WebSignIn.swift. */
  signInCommand?: () => Promise<string[] | null>;
}

interface Session {
  auth_token: string;
  ct0: string;
  savedAt: number;
}

class XFailure extends Error {
  constructor(readonly status: number, readonly code: "signed-out" | "api" | "bad-request", message: string) {
    super(message);
  }
}

export function createXService(context: ServiceContext, options: XOptions = {}): ServiceProvider {
  return new XService(context, options);
}

class XService implements ServiceProvider {
  readonly name = "x";
  private readonly dir: string;
  private readonly origin: string;
  private readonly apiOrigin: string;
  private readonly fetcher: typeof fetch;
  private operations: Map<string, XOperation> | null = null;
  private operationsAt = 0;
  private discovering: Promise<Map<string, XOperation>> | null = null;
  private rediscoveredAt = 0;
  private signIn: ReturnType<typeof spawn> | null = null;
  private lastError = "";

  constructor(
    private readonly context: ServiceContext,
    private readonly options: XOptions,
  ) {
    this.dir = join(context.storeDir, "services", "x");
    this.origin = options.origin ?? "https://x.com";
    this.apiOrigin = options.apiOrigin ?? "https://api.x.com";
    this.fetcher = options.fetch ?? fetch;
  }

  // ---- owner commands ---------------------------------------------------------

  async command(args: string[]): Promise<string> {
    const [verb = "status", ...rest] = args;
    switch (verb) {
      case "login":
        return await this.login();
      case "cookies": {
        const [auth, ct0] = rest;
        if (!auth || !ct0) throw new Error("usage: service x cookies <auth_token> <ct0>");
        this.saveSession({ auth_token: auth, ct0, savedAt: Date.now() });
        this.warm();
        return "Saved the X session. The console's X app reads with it now.";
      }
      case "logout":
        rmSync(this.sessionPath(), { force: true });
        return "Signed out of X on this Mac.";
      case "status": {
        const session = this.session();
        if (!session) return "Not signed in to X. Run: bun tools/companion.ts service x login";
        const ops = this.operations ? ` Operations known: ${[...this.operations.keys()].length}.` : "";
        const last = this.lastError ? ` Last error: ${this.lastError}` : "";
        return `Signed in to X since ${new Date(session.savedAt).toISOString()}.${ops}${last}`;
      }
      case "probe": {
        const ops = await this.discover(true);
        const pick = (names: string[]) => names.map((name) => ops.get(name)).find(Boolean);
        const timeline = pick(TIMELINE_NAMES.following);
        const thread = pick(THREAD_NAMES) ?? findByPattern(ops, THREAD_PATTERN) ?? FALLBACK_THREAD;
        const lines = [
          `${ops.size} operations from x.com's scripts.`,
          `timeline: ${timeline ? `${timeline.kind} ${timeline.name}` : "not found"}`,
          `thread: ${thread ? `${thread.kind} ${thread.name}` : "not found"}`,
        ];
        if (this.session()) {
          try {
            const page = await this.timeline("following", undefined, AbortSignal.timeout(30_000));
            lines.push(`timeline read: ${page.posts.length} posts${page.cursor ? ", more after a cursor" : ""}`);
          } catch (error) {
            lines.push(`timeline read failed: ${(error as Error).message}`);
          }
        }
        return lines.join("\n");
      }
      default:
        throw new Error("x commands: login, cookies <auth_token> <ct0>, status, logout, probe");
    }
  }

  private async login(): Promise<string> {
    if (this.signIn) return "The X sign-in window is already open on this Mac.";
    const command = await (this.options.signInCommand?.() ??
      helperCommand({ name: "pocket-websignin", source: WEB_SIGN_IN_SOURCE, env: "POCKET_WEB_SIGN_IN" }, this.context.storeDir, this.context.log));
    if (!command) throw new Error("this Mac cannot open the sign-in window (no swiftc); use: service x cookies <auth_token> <ct0>");
    const child = spawn(
      command[0]!,
      [...command.slice(1), "--url", `${this.origin}/i/flow/login`, "--domain", new URL(this.origin).hostname, "--cookies", "auth_token,ct0", "--title", "Sign in to X for Pocket", "--timeout", "900"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.signIn = child;
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("exit", () => {
      this.signIn = null;
      try {
        const result = JSON.parse(out.trim().split("\n").pop() || "{}") as { cookies?: Record<string, string>; closed?: boolean };
        if (result.cookies?.auth_token && result.cookies.ct0) {
          this.saveSession({ auth_token: result.cookies.auth_token, ct0: result.cookies.ct0, savedAt: Date.now() });
          this.context.log("x: signed in");
          this.warm();
          return;
        }
        this.context.log(result.closed ? "x: the sign-in window was closed" : "x: sign-in ended without a session");
      } catch {
        this.context.log("x: the sign-in helper answered nothing");
      }
    });
    child.on("error", (error) => {
      this.signIn = null;
      this.context.log(`x: sign-in helper failed: ${error.message}`);
    });
    return "A sign-in window for X opened on this Mac. Sign in there; it closes by itself. Then: bun tools/companion.ts service x status";
  }

  /** Read the operations with the new session ahead of the first request. */
  private warm() {
    void this.discover(true).catch((error: Error) => this.context.log(`x: reading x.com's operations failed: ${error.message}`));
  }

  // ---- console requests ---------------------------------------------------------

  async handle(request: ServiceRequest) {
    try {
      const path = request.path;
      if (path === "/status") return jsonResponse(200, { signedIn: this.session() !== null });
      if (path === "/timeline") {
        const kind = request.query.get("kind") === "foryou" ? "foryou" : "following";
        return jsonResponse(200, await this.timeline(kind, request.query.get("cursor") ?? undefined, request.signal));
      }
      const post = path.match(/^\/post\/(\d{1,25})$/);
      if (post) return jsonResponse(200, await this.thread(post[1]!, request.query.get("cursor") ?? undefined, request.signal));
      if (path === "/avatar") return await this.avatar(request.query.get("u") ?? "", request.signal);
      if (path === "/like" && request.method === "POST") {
        const id = request.query.get("id") ?? "";
        if (!/^\d{1,25}$/.test(id)) throw new XFailure(400, "bad-request", "like needs a post id");
        await this.like(id, request.signal);
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, { error: "bad-request", message: `no X endpoint ${path}` });
    } catch (error) {
      if (error instanceof XFailure) {
        if (error.code !== "bad-request") this.lastError = error.message;
        return jsonResponse(error.status, { error: error.code, message: error.message });
      }
      throw error;
    }
  }

  // ---- session ---------------------------------------------------------------------

  private sessionPath() {
    return join(this.dir, "session.json");
  }

  private session(): Session | null {
    try {
      const value = JSON.parse(readFileSync(this.sessionPath(), "utf8")) as Session;
      return value.auth_token && value.ct0 ? value : null;
    } catch {
      return null;
    }
  }

  private saveSession(session: Session) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    writeFileSync(this.sessionPath(), JSON.stringify(session), { mode: 0o600 });
    chmodSync(this.sessionPath(), 0o600);
  }

  private requireSession(): Session {
    const session = this.session();
    if (!session) throw new XFailure(401, "signed-out", "Not signed in to X on the Mac. Run: bun tools/companion.ts service x login");
    return session;
  }

  private headers(session: Session): Record<string, string> {
    return {
      authorization: `Bearer ${BEARER}`,
      "x-csrf-token": session.ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      "content-type": "application/json",
      cookie: `auth_token=${session.auth_token}; ct0=${session.ct0}`,
      "user-agent": USER_AGENT,
      origin: this.origin,
      referer: `${this.origin}/home`,
    };
  }

  /** X rotates ct0 with Set-Cookie; keep the new one. */
  private keepCsrf(session: Session, response: Response) {
    const set = response.headers.getSetCookie?.() ?? [];
    for (const line of set) {
      const match = line.match(/^ct0=([^;]+)/);
      if (match && match[1] !== session.ct0) {
        session.ct0 = match[1]!;
        this.saveSession(session);
      }
    }
  }

  // ---- operations ------------------------------------------------------------------

  private operationsPath() {
    return join(this.dir, "operations.json");
  }

  private async discover(force = false): Promise<Map<string, XOperation>> {
    if (!force && this.operations && Date.now() - this.operationsAt < OPERATIONS_MAX_AGE_MS) return this.operations;
    if (!force && !this.operations) {
      try {
        const cached = JSON.parse(readFileSync(this.operationsPath(), "utf8")) as { at: number; operations: XOperation[] };
        if (Date.now() - cached.at < OPERATIONS_MAX_AGE_MS && cached.operations.length > 0) {
          this.operations = new Map(cached.operations.map((op) => [op.name, op]));
          this.operationsAt = cached.at;
          return this.operations;
        }
      } catch {
        // no cache yet
      }
    }
    this.discovering ??= this.crawl().finally(() => (this.discovering = null));
    const operations = await this.discovering;
    this.operations = operations;
    this.operationsAt = Date.now();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.operationsPath(), JSON.stringify({ at: this.operationsAt, operations: [...operations.values()] }));
    return operations;
  }

  /** Read x.com's operations from the scripts its home page loads. */
  private async crawl(): Promise<Map<string, XOperation>> {
    const session = this.session();
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (session) headers.cookie = `auth_token=${session.auth_token}; ct0=${session.ct0}`;
    const page = await this.fetcher(`${this.origin}/home`, { headers, redirect: "follow" });
    if (!page.ok) throw new XFailure(502, "api", `x.com answered ${page.status} for its home page`);
    const html = await page.text();
    const queue = [...new Set([...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => new URL(m[1]!, page.url || `${this.origin}/home`).href))];
    // Signed in, x.com serves its webpack client, whose operations sit in
    // chunks only the inline runtime's table names. Likely ones go first.
    queue.push(...webpackChunks(html, page.url || `${this.origin}/home`));
    const seen = new Set<string>();
    const operations = new Map<string, XOperation>();
    let timelineAt = 0;
    const done = () => {
      if (!findTimeline(operations, "following")) return false;
      if (THREAD_NAMES.some((n) => operations.has(n)) || findByPattern(operations, THREAD_PATTERN)) return true;
      timelineAt ||= seen.size;
      return seen.size - timelineAt > CRAWL_PAST_TIMELINE;
    };
    const read = async (url: string) => {
      const response = await this.fetcher(url, { headers: { "user-agent": USER_AGENT } }).catch(() => null);
      if (!response?.ok) return;
      const source = await response.text();
      for (const op of operationsIn(source)) if (!operations.has(op.name)) operations.set(op.name, op);
      const base = url.slice(0, url.lastIndexOf("/") + 1);
      for (const match of source.matchAll(/["'`](\.{1,2}\/[A-Za-z0-9_\-./]+\.js)["'`]/g)) {
        const next = new URL(match[1]!, base).href;
        if (!seen.has(next)) queue.push(next);
      }
    };
    while (queue.length > 0 && seen.size < CRAWL_MAX && !done()) {
      const batch: string[] = [];
      while (batch.length < CRAWL_PARALLEL && queue.length > 0) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        batch.push(next);
      }
      await Promise.all(batch.map(read));
    }
    this.context.log(`x: read ${operations.size} operations from ${seen.size} scripts`);
    if (operations.size === 0) throw new XFailure(502, "api", "x.com's scripts named no API operations; its web client changed");
    return operations;
  }

  /** Run an operation; on "unknown operation" read the scripts again once. */
  private async run(pick: (ops: Map<string, XOperation>) => XOperation | undefined, variables: (op: XOperation) => Record<string, unknown>, signal: AbortSignal, what: string): Promise<unknown> {
    const session = this.requireSession();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = attempt > 0 && Date.now() - this.rediscoveredAt > REDISCOVER_MS;
      if (attempt > 0 && !again) throw new XFailure(502, "api", `X does not know the ${what} operation in use; x.com's client changed. Try again in a few minutes.`);
      if (again) this.rediscoveredAt = Date.now();
      const ops = await this.discover(again);
      const op = pick(ops);
      if (!op) {
        if (attempt === 0) continue;
        throw new XFailure(502, "api", `x.com's client has no ${what} operation this provider knows`);
      }
      const response = await this.send(op, variables(op), session, signal);
      this.keepCsrf(session, response);
      const text = await response.text();
      let body: { data?: unknown; errors?: { message?: string; code?: number }[] } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const message = body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || text.slice(0, 160);
      if (response.status === 401 || body?.errors?.some((e) => e.code === 32 || e.code === 89 || e.code === 239)) {
        throw new XFailure(401, "signed-out", `X refused the session (${response.status}); sign in again on the Mac`);
      }
      const unknown = response.status === 404 || /persisted|not found|unknown operation|query: unspecified/i.test(message);
      if (!response.ok || !body?.data) {
        if (unknown && attempt === 0) continue;
        throw new XFailure(502, "api", `X answered ${response.status} for ${op.name}: ${message}`);
      }
      return body.data;
    }
    throw new XFailure(502, "api", `X did not answer ${what}`);
  }

  private send(op: XOperation, variables: Record<string, unknown>, session: Session, signal: AbortSignal): Promise<Response> {
    const headers = this.headers(session);
    if (op.kind === "relay") {
      const url = new URL(`${this.apiOrigin}/graphql/${op.id}/${op.name}`);
      if (op.type === "mutation") {
        return this.fetcher(url, { method: "POST", headers, body: JSON.stringify({ queryId: op.id, variables }), signal });
      }
      url.searchParams.set("variables", JSON.stringify(variables));
      return this.fetcher(url, { headers, signal });
    }
    const features = Object.fromEntries((op.features?.length ? op.features : CLASSIC_FEATURES).map((name) => [name, true]));
    const toggles = Object.fromEntries((op.toggles ?? []).map((name) => [name, false]));
    const url = new URL(`${this.origin}/i/api/graphql/${op.id}/${op.name}`);
    if (op.type === "mutation" || op.name.startsWith("Home")) {
      return this.fetcher(url, { method: "POST", headers, body: JSON.stringify({ variables, features, fieldToggles: toggles, queryId: op.id }), signal });
    }
    url.searchParams.set("variables", JSON.stringify(variables));
    url.searchParams.set("features", JSON.stringify(features));
    if (op.toggles?.length) url.searchParams.set("fieldToggles", JSON.stringify(toggles));
    return this.fetcher(url, { headers, signal });
  }

  // ---- reads -----------------------------------------------------------------------

  async timeline(kind: "following" | "foryou", cursor: string | undefined, signal: AbortSignal): Promise<{ posts: XPost[]; cursor: string | null }> {
    const data = await this.run(
      (ops) => findTimeline(ops, kind),
      () => ({
        count: PAGE,
        ...(cursor ? { cursor } : {}),
        includePromotedContent: false,
        latestControlAvailable: true,
        requestContext: cursor ? undefined : "launch",
        withCommunity: true,
      }),
      signal,
      "home timeline",
    );
    const found = collect(data);
    return { posts: found.posts, cursor: found.bottom };
  }

  async thread(id: string, cursor: string | undefined, signal: AbortSignal): Promise<{ post: XPost | null; before: XPost[]; replies: XPost[]; cursor: string | null }> {
    const data = await this.run(
      (ops) => THREAD_NAMES.map((name) => ops.get(name)).find(Boolean) ?? findByPattern(ops, THREAD_PATTERN) ?? FALLBACK_THREAD,
      () => ({
        focalTweetId: id,
        postId: id,
        tweetId: id,
        restId: id,
        ...(cursor ? { cursor } : {}),
        referrer: "home",
        with_rux_injections: false,
        rankingMode: "Relevance",
        includePromotedContent: false,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: false,
        withBirdwatchNotes: false,
        withVoice: false,
      }),
      signal,
      "thread",
    );
    const found = collect(data);
    const at = found.posts.findIndex((post) => post.id === id);
    if (at < 0) return { post: null, before: [], replies: found.posts, cursor: found.bottom };
    return { post: found.posts[at]!, before: found.posts.slice(0, at), replies: found.posts.slice(at + 1), cursor: found.bottom };
  }

  private async like(id: string, signal: AbortSignal) {
    await this.run(
      (ops) => ops.get("FavoriteTweet") ?? findByPattern(ops, /^(use)?favoriteTweet\w*Mutation$/i),
      () => ({ tweet_id: id, tweetId: id }),
      signal,
      "like",
    );
  }

  private async avatar(url: string, signal: AbortSignal) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new XFailure(400, "bad-request", "avatar needs an image url");
    }
    if (parsed.protocol !== "https:" || !/(^|\.)twimg\.com$/.test(parsed.hostname)) {
      throw new XFailure(400, "bad-request", "avatars come from twimg.com only");
    }
    const dir = join(this.dir, "avatars");
    const file = join(dir, `${createHash("sha1").update(url).digest("hex")}.img`);
    if (existsSync(file)) return bytesResponse(new Uint8Array(readFileSync(file)), "application/x-pocket-img");
    const response = await this.fetcher(url, { headers: { "user-agent": USER_AGENT }, signal });
    if (!response.ok) throw new XFailure(502, "api", `the avatar answered ${response.status}`);
    const decoded = await (this.options.decodeAvatar ?? decodeWithSips)(new Uint8Array(await response.arrayBuffer()), X_AVATAR_SIZE);
    if (!decoded) throw new XFailure(502, "api", "the avatar could not be read");
    const entry = encodeImageEntry(roundOnWhite(decoded), PSM.PSM_5650);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, entry);
    return bytesResponse(entry, "application/x-pocket-img");
  }
}

// ---- webpack chunks ----------------------------------------------------------------

const LIKELY_CHUNK = /Home|Timeline|Tweet|Conversation|Follower|Trial/i;

/** The chunk URLs an inline webpack runtime names: `t.u=e=>(({id:"name"…})[e]
 *  …)+"."+({id:"hash"…})[e]+"a.js"`, under the main script's folder. Named
 *  bundles that look like timelines or posts first; locale data skipped. */
export function webpackChunks(html: string, pageUrl: string): string[] {
  const at = html.indexOf("t.u=e=>");
  if (at < 0) return [];
  const tables = [...html.slice(at, at + 400_000).matchAll(/\(\{([^}]*)\}\)\[e\]/g)].map((m) => m[1]!);
  if (tables.length < 2) return [];
  const read = (body: string) => new Map([...body.matchAll(/(\d+):"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  const names = read(tables[0]!);
  const hashes = read(tables[1]!);
  const main = html.match(/src="([^"]*\/client-web\/)main\.[^"]+\.js"/)?.[1];
  if (!main) return [];
  const base = new URL(main, pageUrl).href;
  const urls: { url: string; likely: boolean }[] = [];
  for (const [id, hash] of hashes) {
    const name = names.get(id);
    if (!name || /^i18n|emoji|countries/.test(name)) continue;
    urls.push({ url: `${base}${name}.${hash}a.js`, likely: LIKELY_CHUNK.test(name) });
  }
  return [...urls.filter((u) => u.likely), ...urls.filter((u) => !u.likely)].map((u) => u.url);
}

// ---- operations in a script -------------------------------------------------------

const TIMELINE_NAMES = {
  following: ["HomeLatestTimelineQuery", "HomeLatestTimeline"],
  foryou: ["HomeTimelineQuery", "HomeTimeline"],
};
const THREAD_NAMES = ["TweetDetail", "TweetDetailQuery", "ConversationTimelineQuery", "PostDetailQuery", "TweetDetailPageQuery"];
/** A post page's conversation: tweetDetailQuery, postDetailPageQuery,
 *  conversationTimelineQuery — not the analytics providers
 *  (postDetailsProviderQuery) or the participants sheet. */
const THREAD_PATTERN = /^(tweet|post)?(Detail|Conversation)(Page|Timeline|Screen)?Query$/i;

/** Features the classic endpoints have required; sent when an operation's
 *  own list could not be read. */
const CLASSIC_FEATURES = [
  "rweb_video_screen_enabled", "profile_label_improvements_pcf_label_in_post_enabled", "responsive_web_profile_redirect_enabled",
  "rweb_tipjar_consumption_enabled", "verified_phone_label_enabled", "creator_subscriptions_tweet_preview_api_enabled",
  "responsive_web_graphql_timeline_navigation_enabled", "responsive_web_graphql_skip_user_profile_image_extensions_enabled",
  "premium_content_api_read_enabled", "communities_web_enable_tweet_community_results_fetch", "c9s_tweet_anatomy_moderator_badge_enabled",
  "responsive_web_grok_analyze_button_fetch_trends_enabled", "responsive_web_grok_analyze_post_followups_enabled",
  "responsive_web_jetfuel_frame", "responsive_web_grok_share_attachment_enabled", "articles_preview_enabled",
  "responsive_web_edit_tweet_api_enabled", "graphql_is_translatable_rweb_tweet_is_translatable_enabled", "view_counts_everywhere_api_enabled",
  "longform_notetweets_consumption_enabled", "responsive_web_twitter_article_tweet_consumption_enabled", "tweet_awards_web_tipping_enabled",
  "responsive_web_grok_show_grok_translated_post", "responsive_web_grok_analysis_button_from_backend", "creator_subscriptions_quote_tweet_preview_enabled",
  "freedom_of_speech_not_reach_fetch_enabled", "standardized_nudges_misinfo", "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled",
  "longform_notetweets_rich_text_read_enabled", "longform_notetweets_inline_media_enabled", "responsive_web_grok_image_annotation_enabled",
  "responsive_web_enhance_cards_enabled",
];
/** The last classic TweetDetail operation known to this provider: used when
 *  the scripts name no conversation operation. X may have retired it. */
const FALLBACK_THREAD: XOperation = { kind: "classic", id: "nBS-WpgA6ZG0CyNHD517JQ", name: "TweetDetail", type: "query", features: CLASSIC_FEATURES, toggles: ["withArticleRichContentState", "withArticlePlainText", "withGrokAnalyze", "withDisallowedReplyControls"] };

function findTimeline(ops: Map<string, XOperation>, kind: "following" | "foryou"): XOperation | undefined {
  return [...TIMELINE_NAMES[kind], ...TIMELINE_NAMES[kind === "following" ? "foryou" : "following"]].map((name) => ops.get(name)).find(Boolean);
}

function findByPattern(ops: Map<string, XOperation>, pattern: RegExp): XOperation | undefined {
  for (const op of ops.values()) if (pattern.test(op.name)) return op;
  return undefined;
}

const RELAY = /params:\{id:[`"']([^`"']+)[`"'],metadata:\{[^}]*\},name:[`"']([A-Za-z0-9_]+)[`"'],operationKind:[`"'](\w+)[`"']/g;
const CLASSIC = /queryId:[`"']([^`"']+)[`"'],operationName:[`"']([A-Za-z0-9_]+)[`"'],operationType:[`"'](\w+)[`"'](?:,metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\])?/g;

/** Every Relay and classic operation a script defines. */
export function operationsIn(source: string): XOperation[] {
  const out: XOperation[] = [];
  const names = (list: string | undefined) => [...(list ?? "").matchAll(/[`"']([A-Za-z0-9_]+)[`"']/g)].map((m) => m[1]!);
  for (const m of source.matchAll(RELAY)) out.push({ kind: "relay", id: m[1]!, name: m[2]!, type: m[3]! });
  for (const m of source.matchAll(CLASSIC)) {
    out.push({ kind: "classic", id: m[1]!, name: m[2]!, type: m[3]!, features: names(m[4]), toggles: names(m[5]) });
  }
  return out;
}

// ---- posts in a response ------------------------------------------------------------

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number => (typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0);

/** The tweet inside a result (TweetWithVisibilityResults wraps one). */
function unwrap(value: unknown): Json | undefined {
  const result = object(value);
  if (!result) return undefined;
  const inner = object(result.tweet);
  return inner && typeof inner.rest_id === "string" ? inner : result;
}

function isPost(value: Json): boolean {
  if (typeof value.rest_id !== "string" || !/^\d+$/.test(value.rest_id)) return false;
  const legacy = object(value.legacy);
  return !!legacy && typeof legacy.full_text === "string" && (!!object(value.core) || typeof legacy.user_id_str === "string");
}

function user(post: Json): { name: string; handle: string; avatar?: string } {
  const result = object(object(object(post.core)?.user_results)?.result);
  const core = object(result?.core);
  const legacy = object(result?.legacy);
  const avatar = text(object(result?.avatar)?.image_url) ?? text(legacy?.profile_image_url_https);
  return {
    name: text(core?.name) ?? text(legacy?.name) ?? "",
    handle: text(core?.screen_name) ?? text(legacy?.screen_name) ?? "",
    ...(avatar ? { avatar } : {}),
  };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

function postText(post: Json): string {
  const legacy = object(post.legacy)!;
  const note = text(object(object(object(post.note_tweet)?.note_tweet_results)?.result)?.text);
  let body = note ?? text(legacy.full_text) ?? "";
  const entities = object(legacy.entities);
  for (const url of (entities?.urls as Json[] | undefined) ?? []) {
    const short = text(url.url);
    if (short) body = body.split(short).join(text(url.display_url) ?? text(url.expanded_url) ?? short);
  }
  for (const media of (entities?.media as Json[] | undefined) ?? []) {
    const short = text(media.url);
    if (short) body = body.split(short).join("");
  }
  body = body.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity).trim();
  return body.length > TEXT_MAX ? `${body.slice(0, TEXT_MAX - 1)}…` : body;
}

export function normalize(raw: Json): XPost {
  const legacy = object(raw.legacy)!;
  const retweeted = unwrap(object(legacy.retweeted_status_result)?.result);
  if (retweeted && isPost(retweeted)) {
    return { ...normalize(retweeted), repostedBy: user(raw).name || user(raw).handle };
  }
  const author = user(raw);
  const media = ((object(legacy.extended_entities)?.media ?? object(legacy.entities)?.media) as Json[] | undefined) ?? [];
  const quoted = unwrap(object(raw.quoted_status_result)?.result);
  const views = count(object(raw.views)?.count);
  const created = Date.parse(text(legacy.created_at) ?? "");
  const post: XPost = {
    id: raw.rest_id as string,
    name: author.name,
    handle: author.handle,
    text: postText(raw),
    time: Number.isFinite(created) ? created : 0,
    replies: count(legacy.reply_count),
    reposts: count(legacy.retweet_count) + count(legacy.quote_count),
    likes: count(legacy.favorite_count),
  };
  if (views) post.views = views;
  const replyTo = text(legacy.in_reply_to_screen_name);
  if (replyTo) post.replyTo = replyTo;
  if (quoted && isPost(quoted)) {
    const q = user(quoted);
    const body = postText(quoted);
    post.quote = { name: q.name, handle: q.handle, text: body.length > 280 ? `${body.slice(0, 279)}…` : body };
  }
  if (media.length > 0) {
    const type = text(media[0]!.type);
    post.media = { count: media.length, kind: type === "video" ? "video" : type === "animated_gif" ? "gif" : "photo" };
  }
  if (author.avatar) post.avatar = author.avatar.replace("_normal.", "_bigger.");
  return post;
}

/** Posts in document order, and the bottom cursor. A promoted entry is
 *  skipped; a post's own quoted or reposted post is not listed again. */
export function collect(data: unknown): { posts: XPost[]; bottom: string | null } {
  const posts: XPost[] = [];
  const seen = new Set<string>();
  let bottom: string | null = null;
  const walk = (value: unknown, depth: number) => {
    if (depth > 60 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const node = value as Json;
    if (node.promotedMetadata || node.promoted_metadata) return;
    const cursorType = text(node.cursorType) ?? text(node.cursor_type);
    if (cursorType && /bottom/i.test(cursorType) && typeof node.value === "string") bottom = node.value;
    if (isPost(node)) {
      const id = node.rest_id as string;
      if (!seen.has(id)) {
        seen.add(id);
        posts.push(normalize(node));
      }
      return;
    }
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  walk(data, 0);
  return { posts, bottom };
}

// ---- avatars --------------------------------------------------------------------------

async function decodeWithSips(bytes: Uint8Array, size: number): Promise<DecodedImage | null> {
  const dir = mkdtempSync(join(tmpdir(), "pocket-x-avatar-"));
  try {
    writeFileSync(join(dir, "in"), bytes);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("sips", ["-s", "format", "png", "-z", String(size), String(size), join(dir, "in"), "--out", join(dir, "out.png")], { stdio: "ignore" });
      child.on("exit", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
    if (!ok) return null;
    return decodePng(new Uint8Array(readFileSync(join(dir, "out.png"))));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The image as a disc on white (the list's background), so it can be a
 *  5650 texture: 2 KiB a face. */
export function roundOnWhite(image: DecodedImage): DecodedImage {
  const size = X_AVATAR_SIZE;
  const out = new Uint8Array(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / size));
      const sy = Math.min(image.height - 1, Math.floor((y * image.height) / size));
      const s = (sy * image.width + sx) * 4;
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const cover = Math.max(0, Math.min(1, r - d + 0.5)) * ((image.rgba[s + 3] ?? 255) / 255);
      for (let c = 0; c < 3; c += 1) out[(y * size + x) * 4 + c] = Math.round((image.rgba[s + c] ?? 255) * cover + 255 * (1 - cover));
      out[(y * size + x) * 4 + 3] = 255;
    }
  }
  return { width: size, height: size, rgba: out };
}
