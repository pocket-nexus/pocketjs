// tests/companion-x.test.ts — the companion's X service
// (tools/companion/services/x.ts) against a local stand-in for x.com and
// api.x.com: operations read from the client's scripts (Relay and classic),
// the session's headers and its storage, ct0 rotation, a stale operation
// read again, posts found by shape (reposts, quotes, promoted entries,
// visibility wrappers, long text), threads, avatars as IMG entries, and that
// no output carries the session.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PSM } from "../contracts/spec/spec.ts";
import type { ServiceProvider, ServiceRequest } from "../tools/companion/services.ts";
import { collect, createXService, operationsIn, X_AVATAR_SIZE, type XPost, webpackChunks } from "../tools/companion/services/x.ts";

const AUTH = "auth-secret-0123456789";
const CT0 = "csrf-secret-abcdef";
const ROTATED = "csrf-rotated-fedcba";

const user = (name: string, handle: string) => ({
  result: { __typename: "User", core: { name, screen_name: handle }, avatar: { image_url: `https://pbs.twimg.com/profile_images/1/${handle}_normal.jpg` } },
});
const tweet = (id: string, text: string, extra: Record<string, unknown> = {}, legacy: Record<string, unknown> = {}) => ({
  __typename: "Tweet",
  rest_id: id,
  core: { user_results: user(`Name ${id}`, `user${id}`) },
  views: { count: "1200" },
  legacy: {
    full_text: text,
    created_at: "Mon Oct 19 01:00:00 +0000 2026",
    reply_count: 2,
    retweet_count: 3,
    quote_count: 1,
    favorite_count: 10,
    entities: { urls: [], media: [] },
    ...legacy,
  },
  ...extra,
});
const item = (result: unknown, extra: Record<string, unknown> = {}) => ({
  entryId: `tweet-${(result as { rest_id?: string }).rest_id ?? "x"}`,
  content: { entryType: "TimelineTimelineItem", itemContent: { itemType: "TimelineTweet", tweet_results: { result }, ...extra } },
});

function homeTimeline() {
  return {
    home: {
      home_timeline_urt: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              item(tweet("101", "Hello from the 3DS &amp; friends https://t.co/abc", {}, { favorited: true, entities: { urls: [{ url: "https://t.co/abc", display_url: "pocket.dev/x" }], media: [] } })),
              item(tweet("999", "Buy this"), { promotedMetadata: { advertiser: "ad" } }),
              item(tweet("102", "RT @user103: original", {}, { retweeted_status_result: { result: tweet("103", "original words") } })),
              item({ __typename: "TweetWithVisibilityResults", tweet: tweet("104", "wrapped post", { quoted_status_result: { result: tweet("105", "the quoted one") } }) }),
              item(tweet("106", "short", { note_tweet: { note_tweet_results: { result: { text: "a long note that replaces the short text" } } } }, { in_reply_to_screen_name: "someone", extended_entities: { media: [{ type: "video", url: "https://t.co/v" }] } })),
              { entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "CURSOR-2" } },
            ],
          },
        ],
      },
    },
  };
}

function conversation() {
  return {
    threaded_conversation_with_injections_v2: {
      instructions: [
        {
          type: "TimelineAddEntries",
          entries: [
            item(tweet("200", "the question")),
            item(tweet("201", "the focal answer")),
            { entryId: "conversationthread-1", content: { items: [{ item: { itemContent: { tweet_results: { result: tweet("202", "a reply") } } } }] } },
            { entryId: "cursor-bottom-2", content: { cursorType: "Bottom", value: "MORE-REPLIES" } },
          ],
        },
      ],
    },
  };
}

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let store = "";
const logs: string[] = [];
const seen: { path: string; headers: Headers }[] = [];
/** Mutations the stand-in received: their operation name and JSON body. */
const mutations: { name: string; body: Record<string, unknown> }[] = [];
/** The Relay id the scripts name for the following timeline; the API knows only `liveId`. */
let scriptId = "RELAY-OLD";
let liveId = "RELAY-OLD";
let rotate = false;

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "pocket-x-"));
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname, headers: request.headers });
      if (url.pathname === "/home") {
        return new Response(`<html><script type="module" src="${origin}/assets/entry.js"></script></html>`, { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/assets/entry.js") return new Response(`import "./chunk-home.js";import("./chunk-post.js");`);
      if (url.pathname === "/assets/chunk-home.js") {
        return new Response(
          `var a={params:{id:\`${scriptId}\`,metadata:{},name:\`HomeLatestTimelineQuery\`,operationKind:\`query\`,text:null}};` +
            `var b={params:{id:\`RELAY-FY\`,metadata:{},name:\`HomeTimelineQuery\`,operationKind:\`query\`,text:null}};` +
            `var c={params:{id:\`ANALYTICS\`,metadata:{},name:\`postDetailsProviderQuery\`,operationKind:\`query\`,text:null}};`,
        );
      }
      if (url.pathname === "/assets/chunk-post.js") {
        return new Response(
          `e.exports={queryId:"CLASSIC-TD",operationName:"TweetDetail",operationType:"query",metadata:{featureSwitches:["view_counts_everywhere_api_enabled","longform_notetweets_consumption_enabled"],fieldToggles:["withArticleRichContentState"]}}` +
            `f.exports={queryId:"FAV",operationName:"FavoriteTweet",operationType:"mutation",metadata:{featureSwitches:[],fieldToggles:[]}}` +
            `g.exports={queryId:"UNFAV",operationName:"UnfavoriteTweet",operationType:"mutation",metadata:{featureSwitches:[],fieldToggles:[]}}` +
            `h.exports={queryId:"RT",operationName:"CreateRetweet",operationType:"mutation",metadata:{featureSwitches:[],fieldToggles:[]}}` +
            `i.exports={queryId:"UNRT",operationName:"DeleteRetweet",operationType:"mutation",metadata:{featureSwitches:[],fieldToggles:[]}}` +
            `j.exports={queryId:"POST",operationName:"CreateTweet",operationType:"mutation",metadata:{featureSwitches:["view_counts_everywhere_api_enabled"],fieldToggles:[]}}`,
        );
      }
      const auth = request.headers.get("authorization") ?? "";
      const cookie = request.headers.get("cookie") ?? "";
      const csrf = request.headers.get("x-csrf-token");
      const signed = auth.startsWith("Bearer AAAA") && cookie.includes(`auth_token=${AUTH}`) && (csrf === CT0 || csrf === ROTATED) && cookie.includes(`ct0=${csrf}`);
      if (url.pathname.startsWith("/graphql/")) {
        if (!signed) return Response.json({ errors: [{ code: 32, message: "Could not authenticate you." }] }, { status: 401 });
        const [, , id, name] = url.pathname.split("/");
        if (name === "HomeLatestTimelineQuery" && id !== liveId) return Response.json({ errors: [{ message: "PersistedQueryNotFound" }] }, { status: 404 });
        const headers = new Headers({ "content-type": "application/json" });
        if (rotate) headers.append("set-cookie", `ct0=${ROTATED}; Path=/; Domain=.x.com; Secure`);
        return new Response(JSON.stringify({ data: homeTimeline() }), { headers });
      }
      if (url.pathname === "/i/api/graphql/CLASSIC-TD/TweetDetail") {
        if (!signed) return Response.json({ errors: [{ code: 32, message: "Could not authenticate you." }] }, { status: 401 });
        const variables = JSON.parse(url.searchParams.get("variables") ?? "{}");
        const features = JSON.parse(url.searchParams.get("features") ?? "{}");
        if (variables.focalTweetId !== "201" || features.view_counts_everywhere_api_enabled !== true) return Response.json({ errors: [{ message: "bad variables" }] }, { status: 400 });
        return Response.json({ data: conversation() });
      }
      const mutation = url.pathname.match(/^\/i\/api\/graphql\/(FAV|UNFAV|RT|UNRT|POST)\/(\w+)$/);
      if (mutation && request.method === "POST") {
        if (!signed) return Response.json({ errors: [{ code: 32, message: "Could not authenticate you." }] }, { status: 401 });
        return request.json().then((body: Record<string, unknown>) => {
          mutations.push({ name: mutation[2]!, body });
          if (mutation[2] === "CreateTweet") return Response.json({ data: { create_tweet: { tweet_results: { result: tweet("300", String((body.variables as { tweet_text: string }).tweet_text)) } } } });
          return Response.json({ data: { ok: "Done" } });
        });
      }
      if (url.pathname.startsWith("/profile_images/")) return new Response(new Uint8Array([1, 2, 3]));
      return new Response("not here", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(store, { recursive: true, force: true });
});

function service(): ServiceProvider {
  return createXService(
    { storeDir: store, log: (line) => logs.push(line), advertiseHost: () => "127.0.0.1" },
    {
      origin,
      apiOrigin: origin,
      // The avatar host is twimg.com; route it to the stand-in.
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === "pbs.twimg.com") return fetch(`${origin}${url.pathname}`, init);
        return fetch(input, init);
      }) as typeof fetch,
      // A 48x48 red square stands in for the decoded JPEG.
      decodeAvatar: async () => ({ width: 48, height: 48, rgba: new Uint8Array(48 * 48 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 40)) }),
    },
  );
}

const request = (path: string, query = "", method = "GET", body = ""): ServiceRequest => ({
  method,
  path,
  query: new URLSearchParams(query),
  headers: {},
  body: new TextEncoder().encode(body),
  console: { id: "c", name: "3DS", model: "3ds", target: "3ds-dev", address: "127.0.0.1" },
  signal: AbortSignal.timeout(10_000),
});
const json = async (provider: ServiceProvider, path: string, query = "", method = "GET") => {
  const response = await provider.handle(request(path, query, method));
  return { status: response.status, body: JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown> };
};

describe("operations in x.com's scripts", () => {
  test("Relay params and classic queryIds are both read, with features", () => {
    const ops = operationsIn(
      `x={params:{id:\`ID1\`,metadata:{},name:\`HomeTimelineQuery\`,operationKind:\`query\`,text:null}};` +
        `y={queryId:"Q2",operationName:"TweetDetail",operationType:"query",metadata:{featureSwitches:["a_b","c"],fieldToggles:["d"]}}`,
    );
    expect(ops).toEqual([
      { kind: "relay", id: "ID1", name: "HomeTimelineQuery", type: "query" },
      { kind: "classic", id: "Q2", name: "TweetDetail", type: "query", features: ["a_b", "c"], toggles: ["d"] },
    ]);
  });
});

describe("the X service", () => {
  test("without a session every read says signed-out, and status says how to sign in", async () => {
    const x = service();
    expect(await json(x, "/status")).toEqual({ status: 200, body: { signedIn: false } });
    const timeline = await json(x, "/timeline");
    expect(timeline.status).toBe(401);
    expect(timeline.body.error).toBe("signed-out");
    expect(await x.command!(["status"])).toContain("service x login");
  });

  test("cookies are kept 0600 in a 0700 folder, and no output carries them", async () => {
    const x = service();
    const said = await x.command!(["cookies", AUTH, CT0]);
    const file = join(store, "services", "x", "session.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(store, "services", "x")).mode & 0o777).toBe(0o700);
    const status = await x.command!(["status"]);
    for (const text of [said, status]) {
      expect(text).not.toContain(AUTH);
      expect(text).not.toContain(CT0);
    }
    expect(await json(x, "/status")).toEqual({ status: 200, body: { signedIn: true } });
  });

  test("the timeline: posts by shape, with reposts, quotes, long text and the cursor; no promoted post", async () => {
    const x = service();
    const { status, body } = await json(x, "/timeline", "kind=following");
    expect(status).toBe(200);
    const posts = body.posts as XPost[];
    expect(posts.map((post) => post.id)).toEqual(["101", "103", "104", "106"]);
    expect(posts[0]!.text).toBe("Hello from the 3DS & friends pocket.dev/x");
    expect(posts[0]).toMatchObject({ name: "Name 101", handle: "user101", replies: 2, reposts: 4, likes: 10, views: 1200, liked: true, reposted: false });
    expect(posts[0]!.time).toBe(Date.parse("Mon Oct 19 01:00:00 +0000 2026"));
    expect(posts[0]!.avatar).toBe("https://pbs.twimg.com/profile_images/1/user101_bigger.jpg");
    expect(posts[1]).toMatchObject({ id: "103", text: "original words", repostedBy: "Name 102" });
    expect(posts[2]!.quote).toEqual({ name: "Name 105", handle: "user105", text: "the quoted one" });
    expect(posts[3]).toMatchObject({ text: "a long note that replaces the short text", replyTo: "someone", media: { count: 1, kind: "video" } });
    expect(body.cursor).toBe("CURSOR-2");
    // The request carried the web client's headers and the session.
    const call = seen.findLast((entry) => entry.path.startsWith("/graphql/"))!;
    expect(call.path).toBe("/graphql/RELAY-OLD/HomeLatestTimelineQuery");
    expect(call.headers.get("x-twitter-auth-type")).toBe("OAuth2Session");
    expect(call.headers.get("x-csrf-token")).toBe(CT0);
  });

  test("like, unlike, repost and unrepost send the web client's mutations with their variables alone", async () => {
    const x = service();
    mutations.length = 0;
    for (const [path, id] of [["/like", "101"], ["/unlike", "101"], ["/repost", "103"], ["/unrepost", "103"]] as const) {
      expect(await json(x, path, `id=${id}`, "POST")).toEqual({ status: 200, body: { ok: true } });
    }
    expect(mutations).toEqual([
      { name: "FavoriteTweet", body: { variables: { tweet_id: "101" }, queryId: "FAV" } },
      { name: "UnfavoriteTweet", body: { variables: { tweet_id: "101" }, queryId: "UNFAV" } },
      { name: "CreateRetweet", body: { variables: { tweet_id: "103", dark_request: false }, queryId: "RT" } },
      { name: "DeleteRetweet", body: { variables: { source_tweet_id: "103", dark_request: false }, queryId: "UNRT" } },
    ]);
    expect((await json(x, "/like", "id=abc", "POST")).status).toBe(400);
    // A read is not an action.
    expect((await json(x, "/like", "id=101", "GET")).status).toBe(404);
  });

  test("a reply sends CreateTweet aimed at the post and answers the new post", async () => {
    const x = service();
    mutations.length = 0;
    const response = await x.handle(request("/reply", "", "POST", JSON.stringify({ id: "101", text: "hello from a 3DS" })));
    const body = JSON.parse(new TextDecoder().decode(response.body)) as { ok: boolean; post: XPost };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.post).toMatchObject({ id: "300", text: "hello from a 3DS" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.name).toBe("CreateTweet");
    expect(mutations[0]!.body.variables).toMatchObject({ tweet_text: "hello from a 3DS", reply: { in_reply_to_tweet_id: "101", exclude_reply_user_ids: [] }, dark_request: false });
    expect(mutations[0]!.body.features).toEqual({ view_counts_everywhere_api_enabled: true });
    for (const bad of [{ id: "101", text: "  " }, { id: "x", text: "hi" }, { id: "101", text: "y".repeat(281) }]) {
      expect((await x.handle(request("/reply", "", "POST", JSON.stringify(bad)))).status).toBe(400);
    }
  });

  test("a thread through the classic operation: before, the post, replies and the cursor", async () => {
    const x = service();
    const { status, body } = await json(x, "/post/201");
    expect(status).toBe(200);
    expect((body.post as XPost).text).toBe("the focal answer");
    expect((body.before as XPost[]).map((post) => post.id)).toEqual(["200"]);
    expect((body.replies as XPost[]).map((post) => post.id)).toEqual(["202"]);
    expect(body.cursor).toBe("MORE-REPLIES");
  });

  test("a rotated ct0 is kept; an operation the API no longer knows is read again from the scripts", async () => {
    const x = service();
    rotate = true;
    expect((await json(x, "/timeline")).status).toBe(200);
    rotate = false;
    const session = JSON.parse(readFileSync(join(store, "services", "x", "session.json"), "utf8"));
    expect(session.ct0).toBe(ROTATED);
    // The client moved on: the API refuses the cached id, the scripts name a new one.
    liveId = scriptId = "RELAY-NEW";
    const again = await json(x, "/timeline");
    expect(again.status).toBe(200);
    expect(seen.findLast((entry) => entry.path.startsWith("/graphql/"))!.path).toBe("/graphql/RELAY-NEW/HomeLatestTimelineQuery");
  });

  test("avatars: twimg.com only, a 32x32 5650 IMG entry", async () => {
    const x = service();
    const response = await x.handle(request("/avatar", `u=${encodeURIComponent("https://pbs.twimg.com/profile_images/1/user101_bigger.jpg")}`));
    expect(response.status).toBe(200);
    const dv = new DataView(response.body.buffer, response.body.byteOffset);
    expect([dv.getUint16(0, true), dv.getUint16(2, true), response.body[4]]).toEqual([X_AVATAR_SIZE, X_AVATAR_SIZE, PSM.PSM_5650]);
    expect(response.body.length).toBe(8 + X_AVATAR_SIZE * X_AVATAR_SIZE * 2);
    // The corner is outside the disc: white.
    expect(dv.getUint16(8, true)).toBe(0xffff);
    const refused = await x.handle(request("/avatar", `u=${encodeURIComponent(`${origin}/x.png`)}`));
    expect(refused.status).toBe(400);
  });

  test("a refused session reads as signed-out; logout forgets it; logs never hold the cookies", async () => {
    const x = service();
    writeFileSync(join(store, "services", "x", "session.json"), JSON.stringify({ auth_token: "wrong", ct0: "wrong", savedAt: 1 }));
    const refused = await json(x, "/timeline");
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("signed-out");
    await x.command!(["logout"]);
    expect(existsSync(join(store, "services", "x", "session.json"))).toBe(false);
    for (const line of logs) {
      expect(line).not.toContain(AUTH);
      expect(line).not.toContain(CT0);
    }
  });

  test("login runs the sign-in helper and keeps the cookies it prints", async () => {
    const helper = join(store, "helper.ts");
    writeFileSync(helper, `console.log(JSON.stringify({ cookies: { auth_token: ${JSON.stringify(AUTH)}, ct0: ${JSON.stringify(CT0)} } }));`);
    const x = createXService({ storeDir: store, log: (line) => logs.push(line), advertiseHost: () => "127.0.0.1" }, { origin, apiOrigin: origin, signInCommand: async () => [process.execPath, helper] });
    expect(await x.command!(["login"])).toContain("sign-in window");
    for (let i = 0; i < 100 && !existsSync(join(store, "services", "x", "session.json")); i += 1) await Bun.sleep(30);
    expect(JSON.parse(readFileSync(join(store, "services", "x", "session.json"), "utf8")).auth_token).toBe(AUTH);
    expect(logs).toContain("x: signed in");
  });
});

describe("collect", () => {
  test("an unknown wrapper around posts still reads, in document order", () => {
    const found = collect({ data: { something: [{ deep: tweet("1", "one") }, { deeper: { list: [tweet("2", "two")] } }], cursor_type: "Bottom", value: "C" } });
    expect(found.posts.map((post) => post.id)).toEqual(["1", "2"]);
  });
});

describe("the signed-in webpack client", () => {
  test("chunks come from the inline runtime's table, likely ones first, locale data skipped", () => {
    const html = `<script src="https://abs.twimg.com/responsive-web/client-web/main.abc.js"></script><script>t.u=e=>(({1:"bundle.Settings",2:"bundle.FollowerRequests",3:"i18n/emoji-bn"})[e]||e)+"."+({1:"aaa",2:"bbb",3:"ccc"})[e]+"a.js",t.hmd=1</script>`;
    expect(webpackChunks(html, "https://x.com/home")).toEqual([
      "https://abs.twimg.com/responsive-web/client-web/bundle.FollowerRequests.bbba.js",
      "https://abs.twimg.com/responsive-web/client-web/bundle.Settings.aaaa.js",
    ]);
    expect(webpackChunks("<html></html>", "https://x.com/home")).toEqual([]);
  });
});
