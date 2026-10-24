// tests/companion-discord.test.ts — the companion's discord service
// (tools/companion/services/discord.ts) against a fake Discord: REST v10, the
// CDN and a gateway on one local Bun.serve. Covers the owner commands, token
// storage, permissions, message normalization, rate limits, the gateway's
// live messages and pictures.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { PSM } from "../contracts/spec/spec.ts";
import { encodePNG } from "../tools/png.ts";
import type { ServiceProvider } from "../tools/companion/services.ts";
import { createDiscordService, DISCORD_INVITE_PERMISSIONS, DISCORD_SETUP, DISCORD_SETUP_HINT } from "../tools/companion/services/discord.ts";
import { call, expectImg, serviceContext } from "./helpers/companion-service.ts";

const TOKEN = "MTIz.fake-bot-token.zzz";
const BOT = { id: "900000000000000001", username: "pocketbot", bot: true, avatar: null };
const GUILD = "100000000000000001";
const ROLE_MEMBER = "100000000000000050";
const CATEGORY = "200000000000000010";
const GENERAL = "200000000000000011";
const SECRET = "200000000000000012";
const NEWS = "200000000000000013";
const LOBBY = "200000000000000014";
const ALICE = { id: "300000000000000001", username: "alice", global_name: "Alice", avatar: "abc123" };

/** A 64x64 opaque red PNG. */
const RED_PNG = encodePNG(new Uint8Array(64 * 64 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)), 64, 64);

interface Fake {
  server: Server<unknown>;
  sockets: Set<ServerWebSocket<unknown>>;
  requests: { method: string; path: string; auth: string | null; body?: unknown }[];
  /** Answer the next N requests to `path` with 429. */
  limit: Map<string, number>;
  messages: Map<string, unknown[]>;
  identified: { intents: number }[];
  resumed: { session_id: string; seq: number }[];
  /** Events the gateway replays to the next RESUME. */
  missed: unknown[];
}

let fake: Fake;
let store: string;
const logs: string[] = [];

function message(id: string, channel: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, channel_id: channel, type: 0, author: ALICE, content, timestamp: new Date(Date.UTC(2026, 9, 20, 6, 3)).toISOString(), ...extra };
}

beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), "pocket-discord-"));
  const sockets = new Set<ServerWebSocket<unknown>>();
  const requests: Fake["requests"] = [];
  const limit = new Map<string, number>();
  const messages = new Map<string, unknown[]>([
    [GENERAL, [
      message("400000000000000003", GENERAL, "hi <@900000000000000001>, see <#200000000000000013> and <@&100000000000000050> <:wave:55> at <t:1792476000:t>", {
        mentions: [BOT],
      }),
      message("400000000000000002", GENERAL, "", { attachments: [{ filename: "cat.png", content_type: "image/png" }] }),
      message("400000000000000001", GENERAL, "first", { type: 7 }),
    ]],
  ]);
  const identified: Fake["identified"] = [];
  const resumed: Fake["resumed"] = [];
  const missed: unknown[] = [];
  const server: Server<unknown> = Bun.serve({
    port: 0,
    fetch(request, srv): Response | undefined | Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/gateway") return srv.upgrade(request, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      if (url.pathname.startsWith("/avatars/") || url.pathname.startsWith("/icons/")) {
        return new Response(new Uint8Array(RED_PNG), { headers: { "content-type": "image/png" } });
      }
      const path = url.pathname.replace(/^\/api\/v10/, "");
      const auth = request.headers.get("authorization");
      return (async (): Promise<Response> => {
        const body = request.method === "POST" ? await request.json() : undefined;
        requests.push({ method: request.method, path: path + url.search, auth, body });
        if (auth !== `Bot ${TOKEN}`) return Response.json({ message: "401: Unauthorized" }, { status: 401 });
        const left = limit.get(path) ?? 0;
        if (left > 0) {
          limit.set(path, left - 1);
          return Response.json({ message: "You are being rate limited.", retry_after: 0.05 }, { status: 429 });
        }
        if (path === "/users/@me") return Response.json(BOT);
        if (path === "/oauth2/applications/@me") return Response.json({ id: "900000000000000099" });
        if (path === "/users/@me/guilds") return Response.json([{ id: GUILD, name: "Pocket Lab", icon: "def456" }]);
        if (path === "/gateway/bot") return Response.json({ url: `ws://127.0.0.1:${server.port}/gateway` });
        if (path === `/guilds/${GUILD}`) {
          return Response.json({
            owner_id: ALICE.id,
            roles: [
              { id: GUILD, name: "@everyone", permissions: String((1n << 10n) | (1n << 16n) | (1n << 11n)) },
              { id: ROLE_MEMBER, name: "members", permissions: "0" },
            ],
          });
        }
        if (path === `/guilds/${GUILD}/members/${BOT.id}`) return Response.json({ roles: [ROLE_MEMBER] });
        if (path === `/guilds/${GUILD}/channels`) {
          return Response.json([
            { id: CATEGORY, type: 4, name: "Text Channels", position: 0 },
            { id: NEWS, type: 5, name: "news", position: 1, parent_id: CATEGORY },
            { id: GENERAL, type: 0, name: "general", position: 0, parent_id: CATEGORY, topic: "say hi" },
            { id: SECRET, type: 0, name: "secret", position: 2, parent_id: CATEGORY, permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: String(1n << 10n) }] },
            { id: LOBBY, type: 0, name: "lobby", position: 0 },
            { id: "200000000000000020", type: 2, name: "Voice", position: 3 },
          ]);
        }
        const channel = path.match(/^\/channels\/(\d+)\/messages$/);
        if (channel) {
          const list = messages.get(channel[1]!) ?? [];
          if (request.method === "POST") {
            const sent = message(String(400000000000000100n + BigInt(list.length)), channel[1]!, (body as { content: string }).content, { author: BOT });
            list.unshift(sent);
            messages.set(channel[1]!, list);
            return Response.json(sent);
          }
          const after = url.searchParams.get("after");
          const before = url.searchParams.get("before");
          let found = list as { id: string }[];
          if (after) found = found.filter((m) => BigInt(m.id) > BigInt(after));
          if (before) found = found.filter((m) => BigInt(m.id) < BigInt(before));
          return Response.json(found);
        }
        return Response.json({ message: "Unknown" }, { status: 404 });
      })();
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 }, s: null, t: null }));
      },
      message(ws, data) {
        const packet = JSON.parse(String(data));
        if (packet.op === 2) {
          identified.push({ intents: packet.d.intents });
          if (packet.d.token !== TOKEN) return ws.close(4004, "Authentication failed");
          ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: BOT, session_id: "s" } }));
        }
        if (packet.op === 6) {
          resumed.push({ session_id: packet.d.session_id, seq: packet.d.seq });
          let seq = packet.d.seq as number;
          for (const event of missed.splice(0)) ws.send(JSON.stringify({ op: 0, s: ++seq, t: "MESSAGE_CREATE", d: event }));
          ws.send(JSON.stringify({ op: 0, s: ++seq, t: "RESUMED", d: null }));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  fake = { server, sockets, requests, limit, messages, identified, resumed, missed };
});

afterAll(() => {
  fake.server.stop(true);
  rmSync(store, { recursive: true, force: true });
});

function service(): ServiceProvider {
  const base = `http://127.0.0.1:${fake.server.port}`;
  return createDiscordService(serviceContext(store, (line) => logs.push(line)), { api: `${base}/api/v10`, cdn: base, now: () => Date.UTC(2026, 9, 20, 12) });
}

function get(provider: ServiceProvider, path: string) {
  const [pathname, query = ""] = path.split("?");
  return call(provider, pathname!, { query });
}

/** A message id of `ms` (Discord's snowflake: milliseconds since 2015 << 22). */
const snowflake = (ms: number) => String(BigInt(ms - 1_420_070_400_000) << 22n);

const live = async (provider: ServiceProvider) => {
  let up = false;
  await until(() => {
    void get(provider, "/status").then((status) => (up = status.json().gateway));
    return up;
  });
};

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("the discord service", () => {
  test("without a token every data endpoint asks for setup", async () => {
    const provider = service();
    const guilds = await get(provider, "/guilds");
    expect(guilds.status).toBe(409);
    expect(guilds.json().setup).toBe(DISCORD_SETUP_HINT);
    expect((await get(provider, "/status")).json()).toEqual({ ready: false, setup: DISCORD_SETUP_HINT });
    expect(await provider.state!()).toEqual({ configured: false });
    expect(await provider.command!(["status"])).toContain(DISCORD_SETUP);
    provider.close?.();
  });

  test("a wrong token is refused; a bot token is kept 0600 and never echoed", async () => {
    const provider = service();
    await expect(provider.command!(["token", "nope"])).rejects.toThrow("did not accept");
    const output = await provider.command!(["token", TOKEN]);
    expect(output).toContain("pocketbot");
    expect(output).toContain(`permissions=${DISCORD_INVITE_PERMISSIONS}`);
    expect(output).toContain("client_id=900000000000000099");
    expect(output).toContain("Message Content");
    expect(output).not.toContain(TOKEN);
    const file = join(store, "services", "discord", "token");
    expect(readFileSync(file, "utf8")).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(store, "services", "discord")).mode & 0o777).toBe(0o700);
    expect(logs.join("\n")).not.toContain(TOKEN);
    provider.close?.();
  });

  test("guilds, readable text channels in category order, and pictures", async () => {
    const provider = service();
    expect((await get(provider, "/guilds")).json()).toEqual({ guilds: [{ id: GUILD, name: "Pocket Lab", icon: "def456" }] });
    const { channels } = (await get(provider, `/guilds/${GUILD}/channels`)).json();
    expect(channels.map((c: { name: string }) => c.name)).toEqual(["lobby", "general", "news"]);
    expect(channels[1]).toEqual({ id: GENERAL, name: "general", category: "Text Channels", topic: "say hi" });
    const icon = await get(provider, `/icon/${GUILD}/def456`);
    expect(icon.status).toBe(200);
    const pixels = expectImg(icon.body, 32, 32, PSM.PSM_4444);
    // A corner outside the circle is transparent; the centre is opaque red.
    expect(pixels.getUint16(0, true) >> 12).toBe(0);
    expect(pixels.getUint16((16 * 32 + 16) * 2, true)).toBe(0xf00f);
    provider.close?.();
  });

  test("messages come oldest first with mentions, attachments and system lines spelled out", async () => {
    const provider = service();
    await get(provider, `/guilds/${GUILD}/channels`);
    const { messages, more } = (await get(provider, `/channels/${GENERAL}/messages`)).json();
    expect(more).toBe(false);
    expect(messages.map((m: { id: string }) => m.id)).toEqual(["400000000000000001", "400000000000000002", "400000000000000003"]);
    expect(messages[0].content).toBe("Alice joined the server.");
    expect(messages[0].system).toBe(true);
    expect(messages[1].content).toBe("[image]");
    expect(messages[1].attachments).toBe(1);
    expect(messages[2].content).toMatch(/^hi @pocketbot, see #news and @members :wave: at \d\d:\d\d$/);
    expect(messages[2].author).toEqual({ id: ALICE.id, name: "Alice", avatar: "abc123", bot: false });
    expect(messages[2].when).toMatch(/^Today at \d\d:\d\d$/);
    provider.close?.();
  });

  test("a 429 waits retry_after and tries again", async () => {
    const provider = service();
    fake.limit.set("/users/@me/guilds", 2);
    const before = fake.requests.length;
    const guilds = await get(provider, "/guilds");
    expect(guilds.status).toBe(200);
    expect(fake.requests.slice(before).filter((r) => r.path === "/users/@me/guilds")).toHaveLength(3);
    expect(logs.some((line) => line.includes("rate limited"))).toBe(true);
    provider.close?.();
  });

  test("a message body that is not JSON answers 400", async () => {
    const provider = service();
    const refused = await call(provider, `/channels/${GENERAL}/messages`, { method: "POST", body: "not json" });
    expect(refused.status).toBe(400);
    expect(refused.json().error).toContain("JSON");
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    provider.close?.();
  });

  test("a waiting poll returns the message the gateway delivers; sending posts it", async () => {
    const provider = service();
    await get(provider, `/channels/${GENERAL}/messages`);
    await live(provider);
    expect(fake.identified.at(-1)!.intents).toBe(1 | 512 | 32768);
    const poll = get(provider, `/channels/${GENERAL}/messages?after=400000000000000003&wait=5`);
    await Bun.sleep(50);
    for (const ws of fake.sockets) {
      ws.send(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d: message("400000000000000004", GENERAL, "live!", { member: { nick: "Al" } }) }));
    }
    const started = Date.now();
    const arrived = (await poll).json();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(arrived.messages.map((m: { content: string; author: { name: string } }) => [m.author.name, m.content])).toEqual([["Al", "live!"]]);

    const response = await call(provider, `/channels/${GENERAL}/messages`, { method: "POST", body: JSON.stringify({ content: "hello from a 3DS" }) });
    expect(response.status).toBe(200);
    const sent = response.json().message;
    expect(sent.content).toBe("hello from a 3DS");
    const posted = fake.requests.filter((r) => r.method === "POST").at(-1)!;
    expect(posted.body).toEqual({ content: "hello from a 3DS", allowed_mentions: { parse: [] } });
    provider.close?.();
  });

  test("an empty wait times out with no messages; logout forgets the token", async () => {
    const provider = service();
    await get(provider, `/channels/${GENERAL}/messages`);
    await live(provider);
    const started = Date.now();
    const empty = (await get(provider, `/channels/${LOBBY}/messages?after=1&wait=1`)).json();
    expect(empty.messages).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(await provider.command!(["logout"])).toContain("logged out");
    expect((await get(provider, "/guilds")).status).toBe(409);
    provider.close?.();
  });
  test("requests that arrive together open one gateway", async () => {
    const setup = service();
    await setup.command!(["token", TOKEN]);
    setup.close?.();
    await Bun.sleep(100);
    const before = fake.identified.length;
    const open = fake.sockets.size;
    const provider = service();
    await Promise.all([get(provider, "/guilds"), get(provider, "/status"), get(provider, `/channels/${GENERAL}/messages`)]);
    await live(provider);
    await Bun.sleep(100);
    expect(fake.identified.length - before).toBe(1);
    expect(fake.sockets.size - open).toBe(1);
    provider.close?.();
  });

  test("a dropped gateway resumes its session, and `after` gets what it missed from the replay", async () => {
    const provider = service();
    await live(provider);
    const identified = fake.identified.length;
    // Ids from after the session started: the list holds every message past them.
    const seen = snowflake(Date.now() + 20_000);
    const replayed = snowflake(Date.now() + 21_000);
    fake.missed.push(message(replayed, GENERAL, "sent while the Mac was offline"));
    for (const ws of fake.sockets) ws.close(4000, "dropped");
    await until(() => fake.resumed.length > 0, 5_000);
    await live(provider);
    expect(fake.resumed.at(-1)).toEqual({ session_id: "s", seq: 1 });
    expect(fake.identified.length).toBe(identified);
    const rest = fake.requests.length;
    const answer = (await get(provider, `/channels/${GENERAL}/messages?after=${seen}`)).json();
    expect(answer.messages.map((m: { content: string }) => m.content)).toEqual(["sent while the Mac was offline"]);
    expect(fake.requests.length).toBe(rest);
    provider.close?.();
  });

  test("`after` older than the session reads REST, since the list may have missed it", async () => {
    const provider = service();
    await live(provider);
    const rest = fake.requests.length;
    const answer = (await get(provider, `/channels/${GENERAL}/messages?after=400000000000000001`)).json();
    expect(answer.messages.map((m: { id: string }) => m.id).slice(0, 2)).toEqual(["400000000000000002", "400000000000000003"]);
    expect(fake.requests.slice(rest).map((r) => r.path)).toEqual([`/channels/${GENERAL}/messages?after=400000000000000001&limit=30`]);
    provider.close?.();
  });
});
