// The discord service (tools/companion/services.ts): a Discord bot the owner
// creates and invites to their servers, run by the companion. The console's
// Discord app reads and sends through it; the bot token stays in the
// companion's store and never reaches a console.
//
// Owner commands (`bun tools/companion.ts service discord …`):
//   token <bot-token>   check the token with GET /users/@me, keep it (0600)
//   status              the bot's name, its servers and the invite link
//   logout              forget the token and close the gateway
//
// Endpoints (https://companion.pocket/discord/…), JSON unless noted:
//   GET  /status                          {ready, bot, guilds, contentIntent}
//   GET  /guilds                          {guilds: [Guild]}
//   GET  /guilds/<id>/channels            {channels: [Channel]} text channels
//                                         the bot can read, in position order
//   GET  /channels/<id>/messages          {messages: [Message], more}
//        ?before=<id>  older page (MESSAGE_PAGE, oldest first)
//        ?after=<id>   newer messages; &wait=<s> holds the request up to
//                      MAX_WAIT_S for one to arrive through the gateway
//   POST /channels/<id>/messages          {content} -> {message}
//   GET  /avatar/<user>/<hash>            IMG entry, 32x32 PSM_4444 circle
//   GET  /icon/<guild>/<hash>             IMG entry, 32x32 PSM_4444 circle
//
// A data endpoint answers 409 {error, setup} until a token is set. REST calls
// follow Discord's rate-limit headers: a bucket at zero waits for its reset,
// and a 429 waits retry_after and tries again (MAX_RETRIES).
//
// The gateway connection (intents GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT)
// keeps the last messages of every channel it sees, so a waiting request
// returns the moment a message arrives. `after` answers from memory when
// every message after that id arrived in the current session: the id is
// newer than the session's start (with CLOCK_MARGIN_MS for the Mac's clock)
// and newer than any message the channel's list dropped. Otherwise it reads
// REST. A dropped connection resumes its session (op 6), and Discord replays
// the events it missed; a session Discord will not resume starts over with
// IDENTIFY, and its start moves to then. Without
// the Message Content intent (a switch in the developer portal) the gateway
// refuses the connection; the service then connects without it, and message
// text is empty except where the bot is mentioned.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../../../framework/compiler/pak.ts";
import { PSM } from "../../../contracts/spec/spec.ts";
import { envProxy } from "../fetch.ts";
import { discImage } from "../images.ts";
import { bytesResponse, jsonResponse, readJson, ServiceError, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../services.ts";
import { writeSecret } from "../store.ts";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_CDN = "https://cdn.discordapp.com";

const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_VIEW_CHANNEL = 1n << 10n;
const PERM_SEND_MESSAGES = 1n << 11n;
const PERM_READ_HISTORY = 1n << 16n;
const ALL_PERMISSIONS = (1n << 64n) - 1n;
/** View Channels, Send Messages, Read Message History. */
export const DISCORD_INVITE_PERMISSIONS = PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY;

const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

const MESSAGE_PAGE = 30;
const MAX_WAIT_S = 10;
const MAX_RETRIES = 3;
const CHANNEL_KEEP = 50;
/** Discord's snowflake epoch, and how far the Mac's clock may run behind
 *  Discord's before the cache would claim a message it never saw. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;
const CLOCK_MARGIN_MS = 10_000;
const snowflakeAt = (ms: number) => BigInt(Math.max(0, Math.floor(ms - DISCORD_EPOCH_MS))) << 22n;
const GUILD_TTL_MS = 60_000;
const AVATAR = 32;
const AVATAR_CIRCLE = 28;

export const DISCORD_SETUP = "bun tools/companion.ts service discord token <bot-token>";
/** The 409 a data endpoint answers until a token is set. */
const NOT_SET_UP = { error: "Discord is not set up on the Mac.", setup: DISCORD_SETUP };

// ---------------------------------------------------------------------------
// What the console gets
// ---------------------------------------------------------------------------

interface DiscordGuild {
  id: string;
  name: string;
  /** The icon's hash for /icon/<id>/<hash>, or null. */
  icon: string | null;
}

interface DiscordChannel {
  id: string;
  name: string;
  /** The category's name, or null for a channel outside every category. */
  category: string | null;
  topic: string;
}

interface DiscordAuthor {
  id: string;
  name: string;
  /** The avatar's hash for /avatar/<id>/<hash>, or null. */
  avatar: string | null;
  bot: boolean;
}

interface DiscordMessage {
  id: string;
  author: DiscordAuthor;
  /** Plain text: mentions, channels, roles, custom emoji and timestamps
   *  spelled out; attachments, stickers and embeds named in brackets. */
  content: string;
  /** Milliseconds since the epoch. */
  time: number;
  /** The time as Discord shows it, in the Mac's time zone: "Today at 14:03". */
  when: string;
  edited: boolean;
  attachments: number;
  replyTo: { author: string; content: string } | null;
  /** A system message (a member joined, a pin), drawn without an author. */
  system: boolean;
}

// ---------------------------------------------------------------------------
// Discord's objects (the fields this service reads)
// ---------------------------------------------------------------------------

interface RawUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

interface RawMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  author: RawUser;
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  mentions?: (RawUser & { member?: { nick?: string | null } })[];
  attachments?: { filename: string; content_type?: string }[];
  embeds?: { title?: string; description?: string }[];
  sticker_items?: { name: string }[];
  referenced_message?: RawMessage | null;
}

interface RawChannel {
  id: string;
  type: number;
  name?: string;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  guild_id?: string;
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[];
}

interface RawRole {
  id: string;
  name: string;
  permissions: string;
}

interface GuildCache {
  at: number;
  ownerId: string;
  roles: Map<string, RawRole>;
  memberRoles: string[];
  channels: RawChannel[];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Discord's own wording for a message time, against `now`, in the local
 *  time zone of the process (the Mac's). */
function discordWhen(time: number, now = Date.now()): string {
  const at = new Date(time);
  const today = new Date(now);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d: Date) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000);
  const days = day(today) - day(at);
  if (days === 0) return `Today at ${clock}`;
  if (days === 1) return `Yesterday at ${clock}`;
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())}/${at.getFullYear()}`;
}

function shortTime(seconds: number, style: string): string {
  const at = new Date(seconds * 1000);
  const date = `${MONTHS[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}`;
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (style === "t") return clock;
  if (style === "d" || style === "D") return date;
  return `${date} ${clock}`;
}

const displayName = (user: RawUser, nick?: string | null) => nick || user.global_name || user.username;

const SYSTEM_TEXT: Record<number, (name: string) => string> = {
  1: (name) => `${name} added someone to the group.`,
  6: (name) => `${name} pinned a message to this channel.`,
  7: (name) => `${name} joined the server.`,
  8: (name) => `${name} boosted the server.`,
  18: (name) => `${name} started a thread.`,
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** What the bot may do in `channel`: the guild's @everyone role and the
 *  bot's roles, then the channel's overwrites for @everyone, the bot's
 *  roles and the bot itself (Discord's documented order). */
function channelPermissions(guildId: string, botId: string, guild: GuildCache, channel: RawChannel): bigint {
  if (guild.ownerId === botId) return ALL_PERMISSIONS;
  let base = BigInt(guild.roles.get(guildId)?.permissions ?? "0");
  for (const id of guild.memberRoles) base |= BigInt(guild.roles.get(id)?.permissions ?? "0");
  if (base & PERM_ADMINISTRATOR) return ALL_PERMISSIONS;
  let permissions = base;
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((entry) => entry.id === guildId);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const entry of overwrites) {
    if (entry.type === 0 && guild.memberRoles.includes(entry.id)) {
      allow |= BigInt(entry.allow);
      deny |= BigInt(entry.deny);
    }
  }
  permissions = (permissions & ~deny) | allow;
  const member = overwrites.find((entry) => entry.type === 1 && entry.id === botId);
  if (member) permissions = (permissions & ~BigInt(member.deny)) | BigInt(member.allow);
  return permissions;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

interface DiscordServiceOptions {
  /** REST base, default DISCORD_API (tests point it at a fake). */
  api?: string;
  cdn?: string;
  /** Milliseconds for "now" (message times). */
  now?: () => number;
}

interface Waiter {
  channel: string;
  resolve: () => void;
}

export function createDiscordService(context: ServiceContext, options: DiscordServiceOptions = {}): ServiceProvider {
  const api = options.api ?? DISCORD_API;
  const cdn = options.cdn ?? DISCORD_CDN;
  const now = options.now ?? Date.now;
  const tokenFile = join(context.storeDir, "services", "discord", "token");

  let token: string | null = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() || null : null;
  let bot: RawUser | null = null;
  const guildCache = new Map<string, GuildCache>();
  const channelGuild = new Map<string, string>();
  /** Recent messages per channel from the gateway, oldest first. */
  const recent = new Map<string, RawMessage[]>();
  /** Per channel, the newest id its list dropped to stay at CHANNEL_KEEP. */
  const trimmed = new Map<string, bigint>();
  const waiters = new Set<Waiter>();
  const images = new Map<string, Uint8Array>();
  /** Rate-limit buckets: route key -> the time its window resets. */
  const blocked = new Map<string, number>();

  // -- REST --------------------------------------------------------------------

  // A route's bucket follows its major parameter (the channel or guild id),
  // which is in the path; the query is not part of it.
  const routeKey = (method: string, path: string) => `${method} ${path.split("?")[0]}`;

  async function rest<T>(method: string, path: string, body?: unknown, auth = token): Promise<T> {
    if (!auth) throw new ServiceError(409, NOT_SET_UP);
    const key = routeKey(method, path);
    for (let attempt = 0; ; attempt++) {
      const until = blocked.get(key) ?? 0;
      if (until > Date.now()) await Bun.sleep(until - Date.now());
      const response = await fetch(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bot ${auth}`,
          "user-agent": "DiscordBot (https://pocketjs.dev, 1) PocketCompanion",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const remaining = response.headers.get("x-ratelimit-remaining");
      const resetAfter = Number(response.headers.get("x-ratelimit-reset-after") ?? "0");
      if (remaining === "0" && resetAfter > 0) blocked.set(key, Date.now() + resetAfter * 1000);
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const payload = (await response.json().catch(() => ({}))) as { retry_after?: number };
        const wait = Number(payload.retry_after ?? response.headers.get("retry-after") ?? 1);
        context.log(`discord: rate limited on ${key}, waiting ${wait}s`);
        await Bun.sleep(Math.max(0, wait) * 1000);
        continue;
      }
      if (response.status === 401) throw new ServiceError(409, { error: "Discord no longer accepts the bot token.", setup: DISCORD_SETUP });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        const status = response.status === 403 || response.status === 404 ? response.status : 502;
        throw new ServiceError(status, { error: payload.message ?? `Discord answered ${response.status}` });
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  async function me(): Promise<RawUser> {
    bot ??= await rest<RawUser>("GET", "/users/@me");
    return bot;
  }

  async function guild(id: string): Promise<GuildCache> {
    const cached = guildCache.get(id);
    if (cached && Date.now() - cached.at < GUILD_TTL_MS) return cached;
    const self = await me();
    const [info, member, channels] = await Promise.all([
      rest<{ owner_id: string; roles: RawRole[] }>("GET", `/guilds/${id}`),
      rest<{ roles: string[] }>("GET", `/guilds/${id}/members/${self.id}`),
      rest<RawChannel[]>("GET", `/guilds/${id}/channels`),
    ]);
    const entry: GuildCache = {
      at: Date.now(),
      ownerId: info.owner_id,
      roles: new Map(info.roles.map((role) => [role.id, role])),
      memberRoles: member.roles ?? [],
      channels,
    };
    for (const channel of channels) channelGuild.set(channel.id, id);
    guildCache.set(id, entry);
    return entry;
  }

  // -- messages ------------------------------------------------------------------

  function plainContent(raw: RawMessage): string {
    const users = new Map<string, string>();
    for (const user of raw.mentions ?? []) users.set(user.id, displayName(user, user.member?.nick));
    const guildId = raw.guild_id ?? channelGuild.get(raw.channel_id);
    const cached = guildId ? guildCache.get(guildId) : undefined;
    let text = raw.content
      .replace(/<@!?(\d+)>/g, (_, id: string) => `@${users.get(id) ?? "unknown"}`)
      .replace(/<@&(\d+)>/g, (_, id: string) => `@${cached?.roles.get(id)?.name ?? "role"}`)
      .replace(/<#(\d+)>/g, (_, id: string) => `#${cached?.channels.find((channel) => channel.id === id)?.name ?? "channel"}`)
      .replace(/<a?:(\w+):\d+>/g, ":$1:")
      .replace(/<t:(-?\d+)(?::([tTdDfFR]))?>/g, (_, seconds: string, style = "f") => shortTime(Number(seconds), style));
    const extras: string[] = [];
    for (const file of raw.attachments ?? []) extras.push(file.content_type?.startsWith("image/") ? "[image]" : `[file ${file.filename}]`);
    for (const sticker of raw.sticker_items ?? []) extras.push(`[sticker ${sticker.name}]`);
    if (!text && raw.embeds?.length) extras.push(`[${raw.embeds[0]!.title || "embed"}]`);
    if (extras.length) text = text ? `${text}\n${extras.join(" ")}` : extras.join(" ");
    return text;
  }

  function normalize(raw: RawMessage): DiscordMessage {
    const name = displayName(raw.author, raw.member?.nick);
    const system = SYSTEM_TEXT[raw.type];
    const reply = raw.referenced_message;
    const time = Date.parse(raw.timestamp);
    return {
      id: raw.id,
      author: { id: raw.author.id, name, avatar: raw.author.avatar ?? null, bot: !!raw.author.bot },
      content: system ? system(name) : plainContent(raw),
      time,
      when: discordWhen(time, now()),
      edited: !!raw.edited_timestamp,
      attachments: raw.attachments?.length ?? 0,
      replyTo: reply ? { author: displayName(reply.author, reply.member?.nick), content: plainContent(reply).slice(0, 120) } : null,
      system: !!system,
    };
  }

  const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

  function remember(message: RawMessage) {
    const list = recent.get(message.channel_id) ?? [];
    const at = list.findIndex((entry) => entry.id === message.id);
    if (at >= 0) list[at] = message;
    else {
      list.push(message);
      list.sort(byId);
      if (list.length > CHANNEL_KEEP) {
        const dropped = list.splice(0, list.length - CHANNEL_KEEP);
        const newest = BigInt(dropped.at(-1)!.id);
        if (newest > (trimmed.get(message.channel_id) ?? 0n)) trimmed.set(message.channel_id, newest);
      }
    }
    recent.set(message.channel_id, list);
    for (const waiter of [...waiters]) {
      if (waiter.channel === message.channel_id) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  /** Every message of `channel` after `after` reached the list. */
  function covered(channel: string, after: string): boolean {
    if (!gatewayLive() || liveSince === null) return false;
    const id = BigInt(after);
    return id >= liveSince && id >= (trimmed.get(channel) ?? 0n);
  }

  async function newer(channel: string, after: string, waitS: number, signal: AbortSignal): Promise<{ messages: RawMessage[]; more: boolean }> {
    const fromCache = () => (recent.get(channel) ?? []).filter((message) => BigInt(message.id) > BigInt(after));
    let found: RawMessage[];
    let more = false;
    if (covered(channel, after)) found = fromCache();
    else {
      found = (await rest<RawMessage[]>("GET", `/channels/${channel}/messages?after=${after}&limit=${MESSAGE_PAGE}`)).sort(byId);
      more = found.length === MESSAGE_PAGE;
    }
    if (found.length === 0 && waitS > 0 && gatewayLive()) {
      await new Promise<void>((resolve) => {
        const waiter: Waiter = { channel, resolve };
        waiters.add(waiter);
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve();
        }, Math.min(waitS, MAX_WAIT_S) * 1000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve();
        }, { once: true });
      });
      found = fromCache();
    }
    return { messages: found, more };
  }

  // -- the gateway -----------------------------------------------------------------

  let socket: WebSocket | null = null;
  /** A start is past its checks and waiting for the gateway URL; `attempt`
   *  numbers starts, so one that stopGateway overtook does not connect. */
  let starting = false;
  let attempt = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let sequence: number | null = null;
  /** The session a dropped connection resumes, from READY. */
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  /** The snowflake the current session's messages start from. */
  let liveSince: bigint | null = null;
  let acked = true;
  let ready = false;
  let contentIntent = true;
  let closing = false;
  let backoff = 1000;

  const gatewayLive = () => ready && socket !== null;

  function forgetSession() {
    sessionId = null;
    resumeUrl = null;
    sequence = null;
    liveSince = null;
  }

  function stopGateway() {
    closing = true;
    starting = false;
    attempt += 1;
    // A close with 1000 ends the session on Discord's side too.
    forgetSession();
    clearInterval(heartbeat);
    clearTimeout(reconnect);
    heartbeat = undefined;
    ready = false;
    const open = socket;
    socket = null;
    open?.close(1000);
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  }

  function scheduleReconnect() {
    if (closing || !token) return;
    clearTimeout(reconnect);
    reconnect = setTimeout(() => void startGateway(), backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }

  async function startGateway() {
    if (!token || socket || starting) return;
    starting = true;
    closing = false;
    const mine = ++attempt;
    const resuming = sessionId !== null && sequence !== null;
    let url = resuming ? resumeUrl : null;
    try {
      url ??= (await rest<{ url: string }>("GET", "/gateway/bot")).url;
    } catch (error) {
      if (mine !== attempt) return;
      context.log(`discord: no gateway URL (${(error as Error).message})`);
      starting = false;
      scheduleReconnect();
      return;
    }
    if (mine !== attempt) return;
    starting = false;
    if (closing || !token || socket) return;
    const target = `${url}${url.includes("?") ? "&" : "?"}v=10&encoding=json`;
    const host = new URL(target).hostname;
    const proxy = envProxy();
    const local = host === "127.0.0.1" || host === "localhost";
    const ws = new WebSocket(target, proxy && !local ? ({ proxy } as never) : undefined);
    socket = ws;
    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      let packet: { op: number; d: unknown; s: number | null; t: string | null };
      try {
        packet = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (packet.s !== null && packet.s !== undefined) sequence = packet.s;
      switch (packet.op) {
        case 10: {
          const interval = (packet.d as { heartbeat_interval: number }).heartbeat_interval;
          acked = true;
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (!acked) {
              context.log("discord: gateway missed a heartbeat ack, reconnecting");
              ws.close(4000);
              return;
            }
            acked = false;
            send({ op: 1, d: sequence });
          }, interval);
          if (sessionId !== null && sequence !== null) {
            send({ op: 6, d: { token, session_id: sessionId, seq: sequence } });
            return;
          }
          liveSince = snowflakeAt(Date.now() + CLOCK_MARGIN_MS);
          send({
            op: 2,
            d: {
              token,
              intents: INTENT_GUILDS | INTENT_GUILD_MESSAGES | (contentIntent ? INTENT_MESSAGE_CONTENT : 0),
              properties: { os: "macos", browser: "pocket-companion", device: "pocket-companion" },
            },
          });
          return;
        }
        case 11:
          acked = true;
          return;
        case 1:
          send({ op: 1, d: sequence });
          return;
        case 7:
          ws.close(4000);
          return;
        case 9:
          // Invalid session: `d` says whether it can still be resumed.
          if (packet.d !== true) forgetSession();
          ws.close(4000);
          return;
        case 0:
          dispatch(packet.t ?? "", packet.d);
          return;
      }
    };
    ws.onclose = (event) => {
      // A socket stopGateway replaced or closed: nothing of it is current.
      if (socket !== ws) return;
      socket = null;
      ready = false;
      clearInterval(heartbeat);
      for (const waiter of waiters) waiter.resolve();
      waiters.clear();
      if (event.code === 4004) {
        context.log("discord: the gateway refused the token");
        return;
      }
      // Invalid sequence, session timed out, or new intents: identify again.
      if (event.code === 4007 || event.code === 4009 || event.code === 4014) forgetSession();
      if (event.code === 4014 && contentIntent) {
        contentIntent = false;
        context.log("discord: the Message Content intent is off for this bot; connecting without it");
        backoff = 1000;
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and reconnects.
    };
  }

  function dispatch(type: string, data: unknown) {
    switch (type) {
      case "READY": {
        const session = data as { user: RawUser; session_id?: string; resume_gateway_url?: string };
        ready = true;
        backoff = 1000;
        bot = session.user;
        sessionId = session.session_id ?? null;
        resumeUrl = session.resume_gateway_url ?? null;
        context.log(`discord: gateway ready as ${bot.username}`);
        return;
      }
      case "RESUMED":
        ready = true;
        backoff = 1000;
        context.log("discord: gateway resumed");
        return;
      case "MESSAGE_CREATE":
      case "MESSAGE_UPDATE": {
        const message = data as RawMessage;
        if (type === "MESSAGE_UPDATE") {
          const list = recent.get(message.channel_id);
          const known = list?.find((entry) => entry.id === message.id);
          if (!known) return;
          remember({ ...known, ...message });
          return;
        }
        remember(message);
        return;
      }
      case "MESSAGE_DELETE": {
        const { id, channel_id } = data as { id: string; channel_id: string };
        const list = recent.get(channel_id);
        if (list) recent.set(channel_id, list.filter((entry) => entry.id !== id));
        return;
      }
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "CHANNEL_DELETE":
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE":
      case "GUILD_ROLE_DELETE":
      case "GUILD_MEMBER_UPDATE":
      case "GUILD_UPDATE": {
        const guildId = (data as { guild_id?: string; id?: string }).guild_id ?? (data as { id?: string }).id;
        if (guildId) guildCache.delete(guildId);
        return;
      }
    }
  }

  // -- pictures ------------------------------------------------------------------

  async function picture(kind: "avatars" | "icons", owner: string, hash: string): Promise<Uint8Array> {
    const key = `${kind}/${owner}/${hash}`;
    const cached = images.get(key);
    if (cached) return cached;
    const response = await fetch(`${cdn}/${kind}/${owner}/${hash}.png?size=64`);
    if (!response.ok) throw new ServiceError(404, { error: `no picture ${hash}` });
    // Box-filtered to the circle's size and cut to a circle with an
    // antialiased edge, centred in the texture.
    const entry = discImage(decodePng(new Uint8Array(await response.arrayBuffer())), { size: AVATAR, circle: AVATAR_CIRCLE, background: null, psm: PSM.PSM_4444 });
    if (images.size > 400) images.clear();
    images.set(key, entry);
    return entry;
  }

  // -- owner commands ----------------------------------------------------------------

  async function setToken(candidate: string): Promise<string> {
    const value = candidate.trim().replace(/^Bot\s+/i, "");
    if (!value) throw new Error(`usage: ${DISCORD_SETUP}`);
    let user: RawUser;
    try {
      user = await rest<RawUser>("GET", "/users/@me", undefined, value);
    } catch (error) {
      // rest() answers Discord's 401 as the console's 409.
      const status = error instanceof ServiceError ? error.status : 0;
      throw new Error(status === 409 ? "Discord did not accept that token." : `Could not check the token: ${(error as Error).message}`);
    }
    if (!user.bot) throw new Error("That is not a bot token. Create a bot in the Discord developer portal and copy its token.");
    stopGateway();
    writeSecret(tokenFile, value);
    token = value;
    bot = user;
    guildCache.clear();
    recent.clear();
    trimmed.clear();
    contentIntent = true;
    backoff = 1000;
    void startGateway();
    context.log(`discord: token set for ${user.username}`);
    return `Discord bot ${user.username} is set up.\n${await statusText()}`;
  }

  async function statusText(): Promise<string> {
    if (!token) return `Discord is not set up. Create a bot at https://discord.com/developers/applications, then run:\n  ${DISCORD_SETUP}`;
    const user = await me();
    const guilds = await rest<{ id: string }[]>("GET", "/users/@me/guilds");
    const application = await rest<{ id: string }>("GET", "/oauth2/applications/@me").catch(() => ({ id: user.id }));
    const invite = `https://discord.com/oauth2/authorize?client_id=${application.id}&scope=bot&permissions=${DISCORD_INVITE_PERMISSIONS}`;
    return [
      `Bot: ${user.username}`,
      `Servers: ${guilds.length}`,
      `Gateway: ${gatewayLive() ? "connected" : "not connected"}${contentIntent ? "" : " (without message content)"}`,
      `Invite it to a server: ${invite}`,
      "It needs View Channels, Read Message History and Send Messages.",
      "Turn on the Message Content intent under Bot in the developer portal, or messages read empty.",
    ].join("\n");
  }

  function logout(): string {
    stopGateway();
    rmSync(tokenFile, { force: true });
    token = null;
    bot = null;
    guildCache.clear();
    recent.clear();
    trimmed.clear();
    images.clear();
    context.log("discord: token forgotten");
    return "Discord is logged out; the token is deleted from this Mac.";
  }

  // -- requests ------------------------------------------------------------------

  async function route(request: ServiceRequest) {
    const parts = request.path.split("/").filter(Boolean);
    const [head, id, tail] = parts;
    if (request.method === "GET" && head === "status") {
      if (!token) return jsonResponse(200, { ready: false, setup: DISCORD_SETUP });
      const user = await me();
      void startGateway();
      return jsonResponse(200, { ready: true, bot: displayName(user), gateway: gatewayLive(), contentIntent });
    }
    if (!token) return jsonResponse(409, NOT_SET_UP);
    void startGateway();
    if (request.method === "GET" && head === "guilds" && !id) {
      const list = await rest<{ id: string; name: string; icon: string | null }[]>("GET", "/users/@me/guilds");
      const guilds: DiscordGuild[] = list.map((entry) => ({ id: entry.id, name: entry.name, icon: entry.icon ?? null }));
      return jsonResponse(200, { guilds });
    }
    if (request.method === "GET" && head === "guilds" && id && tail === "channels") {
      const self = await me();
      const cache = await guild(id);
      const categories = new Map(cache.channels.filter((channel) => channel.type === 4).map((channel) => [channel.id, channel]));
      const readable = cache.channels.filter((channel) => {
        if (channel.type !== 0 && channel.type !== 5) return false;
        const permissions = channelPermissions(id, self.id, cache, channel);
        return (permissions & PERM_VIEW_CHANNEL) !== 0n && (permissions & PERM_READ_HISTORY) !== 0n;
      });
      // Channels outside a category first, then each category in its position.
      const order = (channel: RawChannel) => {
        const parent = channel.parent_id ? categories.get(channel.parent_id) : undefined;
        return [parent ? 1 + (parent.position ?? 0) : 0, channel.position ?? 0];
      };
      readable.sort((a, b) => {
        const [ga, pa] = order(a);
        const [gb, pb] = order(b);
        return ga! - gb! || pa! - pb! || byId(a, b);
      });
      const channels: DiscordChannel[] = readable.map((channel) => ({
        id: channel.id,
        name: channel.name ?? "",
        category: channel.parent_id ? categories.get(channel.parent_id)?.name ?? null : null,
        topic: channel.topic ?? "",
      }));
      return jsonResponse(200, { channels });
    }
    if (head === "channels" && id && tail === "messages") {
      if (request.method === "POST") {
        const body = readJson<{ content?: unknown }>(request, { error: "A message needs JSON {content}." });
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) return jsonResponse(400, { error: "A message needs text." });
        if (content.length > 2000) return jsonResponse(400, { error: "A message is at most 2000 characters." });
        const sent = await rest<RawMessage>("POST", `/channels/${id}/messages`, { content, allowed_mentions: { parse: [] } });
        remember(sent);
        return jsonResponse(200, { message: normalize(sent) });
      }
      const after = request.query.get("after");
      if (after) {
        const wait = Math.max(0, Math.min(MAX_WAIT_S, Number(request.query.get("wait") ?? "0") || 0));
        const found = await newer(id, after, wait, request.signal);
        return jsonResponse(200, { messages: found.messages.map(normalize), more: found.more });
      }
      const before = request.query.get("before");
      const raw = await rest<RawMessage[]>("GET", `/channels/${id}/messages?limit=${MESSAGE_PAGE}${before ? `&before=${before}` : ""}`);
      raw.sort(byId);
      if (!before) for (const message of raw) remember(message);
      return jsonResponse(200, { messages: raw.map(normalize), more: raw.length === MESSAGE_PAGE });
    }
    if (request.method === "GET" && (head === "avatar" || head === "icon") && id && tail) {
      return bytesResponse(await picture(head === "avatar" ? "avatars" : "icons", id, tail.replace(/\.png$/, "")), "application/x-pocket-img");
    }
    return jsonResponse(404, { error: `no discord endpoint ${request.method} ${request.path}` });
  }

  return {
    name: "discord",
    handle: route,
    async command(args) {
      const [verb, ...rest] = args;
      if (verb === "token") return await setToken(rest.join(" "));
      if (verb === "status" || verb === undefined) return await statusText();
      if (verb === "logout") return logout();
      throw new Error(`unknown discord command ${verb}: use token <bot-token>, status or logout`);
    },
    close() {
      stopGateway();
    },
  };
}
