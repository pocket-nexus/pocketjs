// The maps service (tools/companion/services.ts): OpenStreetMap for a
// console, with ffmpeg on the companion's computer.
//
//   GET /tile?z=<0..19>&x=<n>&y=<n>   one OpenStreetMap raster tile as an IMG
//                                     entry (framework/compiler/pak.ts):
//                                     256x256 RGB565, bilinear
//   GET /geocode?q=<text>             {items: [{name, lat, lon}]}: Nominatim's
//                                     first RESULTS matches
//   GET /locate                       {lat, lon, city}: where ip-api.com puts
//                                     this computer's public address (the
//                                     proxy's exit when one is set)
//
// A tile is fetched once: the IMG entry is kept under
// `<storeDir>/services/maps/tiles/<z>/<x>/<y>.img` and answered from there
// after. The fetches follow the OSM tile usage policy: one User-Agent that
// names this program, at most TILE_FETCHES requests open at once, and the
// cache. Nominatim takes one request a second, so geocodes wait
// NOMINATIM_GAP_MS apart; a query's answer is kept CACHE_MS. Every request
// goes through the environment's proxy (HTTPS_PROXY, fetch.ts envProxy).
//
// ffmpeg decodes the tile's PNG (an 8-bit palette, which pak.ts's decoder
// does not read): the copy the companion fetched (tools.ts), else the one on
// the PATH or where Homebrew and the usual installers put it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { IMG_FLAG_LINEAR, PSM } from "../../../contracts/spec/spec.ts";
import { encodeImageEntry } from "../../../framework/compiler/pak.ts";
import { envProxy } from "../fetch.ts";
import { bytesResponse, jsonResponse, type ServiceContext, type ServiceProvider } from "../services.ts";
import { ManagedTools } from "../tools.ts";

export const TILE = 256;
export const USER_AGENT = "pocket-maps/0.1 (pocket-nexus)";
const TILE_ORIGIN = "https://tile.openstreetmap.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const LOCATE_URL = "http://ip-api.com/json/?fields=lat,lon,city";
/** Tile requests open at once (the OSM tile usage policy allows two). */
export const TILE_FETCHES = 2;
const MAX_ZOOM = 19;
const RESULTS = 8;
const CACHE_MS = 10 * 60_000;
const NOMINATIM_GAP_MS = 1000;
const QUERY_MAX = 200;
const FETCH_TIMEOUT_MS = 20_000;
const DECODE_TIMEOUT_MS = 30_000;

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

export interface Location {
  lat: number;
  lon: number;
  city: string;
}

/** At most `slots` pieces of work at once, in the order asked. */
function createGate(slots: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= slots) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** The ffmpeg this service runs: the companion's own copy, else the first
 *  on the PATH or in the usual install folders (a menu bar app starts with
 *  a short PATH). */
export function findFfmpeg(managed?: ManagedTools, env: NodeJS.ProcessEnv = process.env): string | null {
  if (managed?.ffmpeg) return managed.ffmpeg;
  const home = homedir();
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join(home, ".local", "bin")];
  return Bun.which("ffmpeg", { PATH: dirs.join(":") }) ?? null;
}

/** The request options every upstream fetch shares: the User-Agent and the
 *  environment's proxy. */
function upstream(signal: AbortSignal, accept: string): RequestInit & { proxy?: string } {
  const proxy = envProxy();
  return { headers: { "user-agent": USER_AGENT, accept }, signal, redirect: "follow", ...(proxy ? { proxy } : {}) };
}

/** A tile's PNG as a 256x256 RGB565 IMG entry: ffmpeg writes RGBA pixels,
 *  which the entry packs. */
export async function decodeTile(ffmpeg: string, png: Uint8Array): Promise<Uint8Array> {
  const child = Bun.spawn(
    [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", `scale=${TILE}:${TILE}:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { stdin: png, stdout: "pipe", stderr: "pipe", timeout: DECODE_TIMEOUT_MS },
  );
  const [rgba, stderr, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 || rgba.length !== TILE * TILE * 4) throw new Error(`ffmpeg could not decode the tile: ${stderr.trim().slice(-200) || `exit ${code}`}`);
  // The map is opaque; a palette PNG's alpha channel comes out 255 already.
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return encodeImageEntry({ width: TILE, height: TILE, rgba }, PSM.PSM_5650, IMG_FLAG_LINEAR);
}

/** A whole number in `min`..`max` from a query value, else null. */
function integer(value: string | null, min: number, max: number): number | null {
  if (value === null || !/^-?\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

export function createMapsService(context: ServiceContext): ServiceProvider {
  const dir = join(context.storeDir, "services", "maps");
  const tiles = join(dir, "tiles");
  const managed = new ManagedTools(context.storeDir, context.log);
  const fetchGate = createGate(TILE_FETCHES);
  const geocodeGate = createGate(1);
  /** Tiles on their way, by "z/x/y": a second request for one waits on the first. */
  const inflight = new Map<string, Promise<Uint8Array>>();
  const geocodes = new Map<string, { at: number; items: Place[] }>();
  let located: { at: number; location: Location } | null = null;
  let lastGeocodeAt = 0;

  const tileFile = (z: number, x: number, y: number) => join(tiles, String(z), String(x), `${y}.img`);

  const fetchTile = async (z: number, x: number, y: number): Promise<Uint8Array> => {
    const file = tileFile(z, x, y);
    if (existsSync(file)) return new Uint8Array(readFileSync(file));
    const key = `${z}/${x}/${y}`;
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const ffmpeg = findFfmpeg(managed);
        if (!ffmpeg) throw new Error("Maps needs ffmpeg on this computer to decode tiles.");
        // On its own clock, not the first asker's: a second request waits on
        // this fetch too.
        const response = await fetchGate(() => fetch(`${TILE_ORIGIN}/${key}.png`, upstream(AbortSignal.timeout(FETCH_TIMEOUT_MS), "image/png")));
        if (!response.ok) throw new Error(`the tile server answered ${response.status}`);
        const entry = await decodeTile(ffmpeg, new Uint8Array(await response.arrayBuffer()));
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        // Written whole: a reader never sees a half tile.
        writeFileSync(`${file}.tmp`, entry, { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
        return entry;
      })();
      inflight.set(key, pending);
      void pending.catch(() => {}).finally(() => inflight.delete(key));
    }
    return await pending;
  };

  const geocode = async (q: string, signal: AbortSignal): Promise<Place[]> => {
    const cacheKey = q.toLowerCase();
    const cached = geocodes.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;
    return await geocodeGate(async () => {
      const again = geocodes.get(cacheKey);
      if (again && Date.now() - again.at < CACHE_MS) return again.items;
      const wait = lastGeocodeAt + NOMINATIM_GAP_MS - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      lastGeocodeAt = Date.now();
      const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=${RESULTS}`;
      const response = await fetch(url, upstream(signal, "application/json"));
      if (!response.ok) throw new Error(`Nominatim answered ${response.status}`);
      const raw = (await response.json()) as unknown;
      const items: Place[] = [];
      for (const entry of Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []) {
        const name = typeof entry.display_name === "string" ? entry.display_name : "";
        const lat = Number(entry.lat), lon = Number(entry.lon);
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        items.push({ name: name.slice(0, 200), lat, lon });
      }
      geocodes.set(cacheKey, { at: Date.now(), items });
      return items;
    });
  };

  const locate = async (signal: AbortSignal): Promise<Location> => {
    if (located && Date.now() - located.at < CACHE_MS) return located.location;
    const response = await fetch(LOCATE_URL, upstream(signal, "application/json"));
    if (!response.ok) throw new Error(`ip-api.com answered ${response.status}`);
    const raw = (await response.json()) as Record<string, unknown>;
    if (typeof raw.lat !== "number" || typeof raw.lon !== "number") throw new Error("ip-api.com gave no position");
    const location: Location = { lat: raw.lat, lon: raw.lon, city: typeof raw.city === "string" ? raw.city : "" };
    located = { at: Date.now(), location };
    return location;
  };

  return {
    name: "maps",
    async handle(request) {
      switch (request.path) {
        case "/tile": {
          const z = integer(request.query.get("z"), 0, MAX_ZOOM);
          if (z === null) return jsonResponse(400, { error: `tile needs z in 0..${MAX_ZOOM}` });
          const n = 2 ** z;
          const x = integer(request.query.get("x"), 0, n - 1);
          const y = integer(request.query.get("y"), 0, n - 1);
          if (x === null || y === null) return jsonResponse(400, { error: `tile needs x and y in 0..${n - 1} at zoom ${z}` });
          try {
            return bytesResponse(await fetchTile(z, x, y), "application/x-pocket-img");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            context.log(`maps: tile ${z}/${x}/${y} failed: ${message}`);
            return jsonResponse(502, { error: message });
          }
        }
        case "/geocode": {
          const q = (request.query.get("q") ?? "").trim();
          if (!q || q.length > QUERY_MAX) return jsonResponse(400, { error: "geocode needs words" });
          try {
            return jsonResponse(200, { items: await geocode(q, request.signal) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            context.log(`maps: geocode failed: ${message}`);
            return jsonResponse(502, { error: message });
          }
        }
        case "/locate": {
          try {
            return jsonResponse(200, await locate(request.signal));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            context.log(`maps: locate failed: ${message}`);
            return jsonResponse(502, { error: message });
          }
        }
        default:
          return jsonResponse(404, { error: `no maps endpoint ${request.path}` });
      }
    },
    async command(args) {
      const [verb = "status"] = args;
      if (verb !== "status") return "maps commands: status";
      const ffmpeg = findFfmpeg(managed);
      return `${ffmpeg ? `ffmpeg: ${ffmpeg}` : "ffmpeg is missing: install it, or bun tools/companion.ts service youtube install"}\ntiles: ${tiles}`;
    },
    async state() {
      const ffmpeg = findFfmpeg(managed);
      return { ready: ffmpeg !== null, ffmpeg, tiles };
    },
  };
}
