// The homeassistant service (tools/companion/services.ts): the owner's Home
// Assistant instance, read and driven for a console's Home app with a
// long-lived access token the owner pastes into the app once. The URL and
// the token stay in the companion's store (<store>/services/homeassistant/
// setup.json, 0600) and never reach a console: a response carries the URL
// alone.
//
// The home's URL is a LAN or Tailscale address, so a request goes to it
// directly, through node:http and node:https, which read no proxy variable:
// Bun's fetch honours HTTPS_PROXY, which the owner may point at a proxy for
// the services that need one, and fetch.ts refuses private destinations,
// which is the policy for a console's arbitrary URLs, not the owner's home.
//
// Owner commands (`bun tools/companion.ts service homeassistant …`):
//   setup <url> <token>   check the pair with GET /api/ and keep it (0600)
//   status                the URL and whether the instance answers
//   forget                delete the pair
//
// Endpoints (https://companion.pocket/homeassistant/…), JSON:
//   GET  /setup           {url, ready}
//   POST /setup           {url, token} -> {ok, message}: the instance's
//                         answer to GET /api/ ("API running."), saved on ok
//   POST /forget          -> {ok}
//   GET  /states          {entities: [Entity]}: GET /api/states reduced to
//                         id, domain, name, state, unit, icon and the
//                         attributes in ATTRIBUTES, sorted by domain, then
//                         name; ?domains=light,switch keeps those domains
//   POST /call            {domain, service, entity_id, data?} ->
//                         POST /api/services/<domain>/<service> -> {ok}
//
// A data endpoint answers 409 {error, setup} until the pair is set. One the
// instance refuses answers 401 {error, setup}; one the instance does not
// answer, or answers with something other than JSON, 502 {error}.

import { existsSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { COMPUTER } from "../computer.ts";
import { jsonResponse, readJson, ServiceError, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../services.ts";
import { writeSecret } from "../store.ts";

/** The attributes an entity carries to the console. */
export const ATTRIBUTES = [
  "brightness",
  "temperature",
  "current_temperature",
  "hvac_modes",
  "hvac_mode",
  "percentage",
  "media_title",
  "media_artist",
  "battery_level",
  "device_class",
] as const;

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOKEN_MAX = 4096;
const STRING_MAX = 200;
const LIST_MAX = 16;
const DATA_KEYS_MAX = 16;
/** The largest answer read from the instance: /api/states of a large home. */
const BODY_MAX = 8 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 10_000;
const STATES_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;

export const HOMEASSISTANT_SETUP = "bun tools/companion.ts service homeassistant setup <url> <token>";
/** What the console shows until the pair is set: the owner sets it in the app. */
export const HOMEASSISTANT_SETUP_HINT = "Open Home on the console and enter the Home Assistant URL and a long-lived access token.";
const NOT_SET_UP = { error: `Home Assistant is not set up on this ${COMPUTER}.`, setup: HOMEASSISTANT_SETUP_HINT };

// ---------------------------------------------------------------------------
// What the console gets
// ---------------------------------------------------------------------------

export interface HaEntity {
  /** "light.kitchen" */
  id: string;
  /** "light" */
  domain: string;
  /** friendly_name, else the id's object part. */
  name: string;
  state: string;
  /** unit_of_measurement, or "". */
  unit: string;
  /** "mdi:lightbulb", when set. */
  icon?: string;
  /** The ATTRIBUTES the entity has, bounded (small()). */
  attributes: Record<string, unknown>;
}

interface Setup {
  url: string;
  token: string;
}

interface HaAnswer {
  status: number;
  body: string;
}

export interface HaRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One request to the instance; the default goes through node:http(s). */
export type HaRequest = (url: string, init: HaRequestInit) => Promise<HaAnswer>;

interface HaOptions {
  /** Test seam: the request to the instance. */
  request?: HaRequest;
}

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

function nodeRequest(url: string, init: HaRequestInit): Promise<HaAnswer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, { method: init.method, headers: init.headers, timeout: init.timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_MAX) {
          request.destroy(new Error(`the answer is over ${BODY_MAX} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    const abort = () => request.destroy(new Error("cancelled"));
    request.on("timeout", () => request.destroy(new Error(`no answer within ${init.timeoutMs} ms`)));
    request.on("error", reject);
    request.on("close", () => init.signal?.removeEventListener("abort", abort));
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

/** `url` as the instance's origin: http or https, no path, no trailing slash. */
export function normalizeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

/** A value small enough to carry: a short string, a finite number, a
 *  boolean, or a list of at most LIST_MAX short strings; else undefined. */
function small(value: unknown): unknown {
  if (typeof value === "string") return value.length > STRING_MAX ? value.slice(0, STRING_MAX) : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").slice(0, LIST_MAX).map((item) => (item as string).slice(0, STRING_MAX));
  return undefined;
}

/** The instance's /api/states, reduced to what the console draws. */
export function reduceStates(raw: unknown, domains: ReadonlySet<string> | null = null): HaEntity[] {
  if (!Array.isArray(raw)) throw new ServiceError(502, { error: "Home Assistant's state list was not a list." });
  const out: HaEntity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { entity_id, state, attributes } = item as { entity_id?: unknown; state?: unknown; attributes?: unknown };
    if (typeof entity_id !== "string" || !ENTITY_ID.test(entity_id)) continue;
    const domain = entity_id.slice(0, entity_id.indexOf("."));
    if (domains && !domains.has(domain)) continue;
    const source = attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
    const picked: Record<string, unknown> = {};
    for (const key of ATTRIBUTES) {
      const value = small(source[key]);
      if (value !== undefined) picked[key] = value;
    }
    const friendly = typeof source.friendly_name === "string" ? source.friendly_name.trim().slice(0, STRING_MAX) : "";
    const entity: HaEntity = {
      id: entity_id,
      domain,
      name: friendly || entity_id.slice(domain.length + 1).replace(/_/g, " "),
      state: typeof state === "string" ? state.slice(0, STRING_MAX) : String(state ?? ""),
      unit: typeof source.unit_of_measurement === "string" ? source.unit_of_measurement.slice(0, 16) : "",
      attributes: picked,
    };
    if (typeof source.icon === "string") entity.icon = source.icon.slice(0, 64);
    out.push(entity);
  }
  out.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
  return out;
}

export function createHomeAssistantService(context: ServiceContext, options: HaOptions = {}): ServiceProvider {
  const file = join(context.storeDir, "services", "homeassistant", "setup.json");
  const request = options.request ?? nodeRequest;

  const load = (): Setup | null => {
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Setup>;
      const url = typeof raw.url === "string" ? normalizeUrl(raw.url) : null;
      return url && typeof raw.token === "string" && raw.token ? { url, token: raw.token } : null;
    } catch {
      return null;
    }
  };
  let setup: Setup | null = load();

  /** `path` on the instance as JSON; a refusal, an unreachable instance and
   *  an answer that is not JSON are ServiceErrors. */
  const api = async <T>(pair: Setup, path: string, method: "GET" | "POST", timeoutMs: number, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const host = new URL(pair.url).host;
    let answer: HaAnswer;
    try {
      answer = await request(`${pair.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${pair.token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs,
        signal,
      });
    } catch (error) {
      throw new ServiceError(502, { error: `Could not reach Home Assistant at ${host}: ${(error as Error).message}` });
    }
    if (answer.status === 401 || answer.status === 403) {
      throw new ServiceError(401, { error: "Home Assistant refused the access token.", setup: HOMEASSISTANT_SETUP_HINT });
    }
    let value: unknown;
    try {
      value = JSON.parse(answer.body);
    } catch {
      throw new ServiceError(502, { error: `${host} answered ${answer.status} with something other than JSON; is that Home Assistant's URL?` });
    }
    if (answer.status < 200 || answer.status >= 300) {
      const message = value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string" ? (value as { message: string }).message : "";
      throw new ServiceError(502, { error: `Home Assistant answered ${answer.status}${message ? `: ${message}` : ""}` });
    }
    return value as T;
  };

  /** GET /api/ with the pair: the instance's message ("API running."). */
  const check = async (pair: Setup, signal?: AbortSignal): Promise<string> => {
    const answer = await api<{ message?: unknown }>(pair, "/api/", "GET", CHECK_TIMEOUT_MS, undefined, signal);
    return typeof answer?.message === "string" ? answer.message : "API running.";
  };

  const ready = (): Setup => {
    if (!setup) throw new ServiceError(409, NOT_SET_UP);
    return setup;
  };

  const save = (pair: Setup) => {
    writeSecret(file, `${JSON.stringify({ url: pair.url, token: pair.token })}\n`);
    setup = pair;
  };

  const forget = () => {
    rmSync(file, { force: true });
    setup = null;
  };

  const pairFrom = (url: unknown, token: unknown): Setup => {
    const normalized = typeof url === "string" ? normalizeUrl(url) : null;
    if (!normalized) throw new ServiceError(400, { ok: false, error: "The URL must start with http:// or https://, like http://homeassistant.local:8123." });
    if (typeof token !== "string" || !token.trim()) throw new ServiceError(400, { ok: false, error: "Paste a long-lived access token from your Home Assistant profile." });
    if (token.length > TOKEN_MAX) throw new ServiceError(400, { ok: false, error: "That is longer than a long-lived access token." });
    return { url: normalized, token: token.trim() };
  };

  const entities = async (pair: Setup, domains: ReadonlySet<string> | null, signal: AbortSignal) =>
    reduceStates(await api<unknown>(pair, "/api/states", "GET", STATES_TIMEOUT_MS, undefined, signal), domains);

  const call = async (pair: Setup, body: { domain?: unknown; service?: unknown; entity_id?: unknown; data?: unknown }, signal: AbortSignal) => {
    const { domain, service, entity_id, data } = body;
    if (typeof domain !== "string" || !NAME.test(domain) || typeof service !== "string" || !NAME.test(service)) {
      throw new ServiceError(400, { error: "call needs a domain and a service, like light and turn_on" });
    }
    if (typeof entity_id !== "string" || !ENTITY_ID.test(entity_id)) throw new ServiceError(400, { error: "call needs an entity_id, like light.kitchen" });
    const payload: Record<string, unknown> = { entity_id };
    if (data !== undefined) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ServiceError(400, { error: "call's data must be an object" });
      const entries = Object.entries(data as Record<string, unknown>);
      if (entries.length > DATA_KEYS_MAX) throw new ServiceError(400, { error: `call's data takes at most ${DATA_KEYS_MAX} fields` });
      for (const [key, value] of entries) {
        if (!NAME.test(key)) throw new ServiceError(400, { error: `call's data has a field it cannot carry: ${key.slice(0, 32)}` });
        const kept = small(value);
        if (kept === undefined) throw new ServiceError(400, { error: `call's data field ${key} must be a string, a number, a boolean or a list of strings` });
        payload[key] = kept;
      }
    }
    await api<unknown>(pair, `/api/services/${domain}/${service}`, "POST", CALL_TIMEOUT_MS, payload, signal);
  };

  return {
    name: "homeassistant",

    async handle(request: ServiceRequest) {
      switch (request.path) {
        case "/setup": {
          if (request.method === "GET") return jsonResponse(200, { url: setup?.url ?? "", ready: setup !== null });
          if (request.method !== "POST") return jsonResponse(405, { error: "setup takes GET or POST" });
          const body = readJson<{ url?: unknown; token?: unknown }>(request, { ok: false, error: "setup needs JSON {url, token}" });
          const pair = pairFrom(body.url, body.token);
          let message: string;
          try {
            message = await check(pair, request.signal);
          } catch (error) {
            if (error instanceof ServiceError) throw new ServiceError(error.status, { ok: false, ...error.body, message: error.body.error });
            throw error;
          }
          save(pair);
          context.log(`homeassistant: set up for ${new URL(pair.url).host}`);
          return jsonResponse(200, { ok: true, message });
        }
        case "/forget": {
          if (request.method !== "POST") return jsonResponse(405, { error: "forget takes POST" });
          forget();
          context.log("homeassistant: the setup is forgotten");
          return jsonResponse(200, { ok: true });
        }
        case "/states": {
          const pair = ready();
          const wanted = request.query.get("domains");
          const domains = wanted ? new Set(wanted.split(",").map((name) => name.trim()).filter((name) => NAME.test(name))) : null;
          return jsonResponse(200, { entities: await entities(pair, domains && domains.size ? domains : null, request.signal) });
        }
        case "/call": {
          if (request.method !== "POST") return jsonResponse(405, { error: "call takes POST" });
          const pair = ready();
          await call(pair, readJson(request, { error: "call needs JSON {domain, service, entity_id, data?}" }), request.signal);
          return jsonResponse(200, { ok: true });
        }
        default:
          return jsonResponse(404, { error: `no homeassistant endpoint ${request.path}` });
      }
    },

    async command(args: string[]) {
      const [verb = "status", ...rest] = args;
      switch (verb) {
        case "setup": {
          const pair = pairFrom(rest[0], rest[1]);
          const message = await check(pair);
          save(pair);
          return `Home Assistant at ${pair.url} answers "${message}". The console's Home app reads it now.`;
        }
        case "status": {
          if (!setup) return `Home Assistant is not set up. ${HOMEASSISTANT_SETUP_HINT} Or run:\n  ${HOMEASSISTANT_SETUP}`;
          try {
            const list = await entities(setup, null, AbortSignal.timeout(STATES_TIMEOUT_MS));
            return `Home Assistant at ${setup.url} answers with ${list.length} entities.`;
          } catch (error) {
            return `Home Assistant at ${setup.url}: ${(error as Error).message}`;
          }
        }
        case "forget":
          forget();
          return `The Home Assistant URL and token are deleted from this ${COMPUTER}.`;
        default:
          throw new Error("homeassistant commands: setup <url> <token>, status, forget");
      }
    },

    /** The setup screen's view: the URL and whether a token is kept; never the token. */
    async state() {
      return { ready: setup !== null, url: setup?.url ?? null };
    },
  };
}
