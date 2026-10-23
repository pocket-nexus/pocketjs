// Companion services: work the companion does for a console's app that a
// plain web request cannot — signing in with the owner's accounts, running
// yt-dlp and ffmpeg, rendering pictures into the console's image format.
//
// An app reaches a service through the link's NET module at
// `https://companion.pocket/<service>/<path>` (LINK_SERVICES_ORIGIN in
// contracts/spec/link.ts). The companion answers that host itself, before the
// destination check and before any network hop, so the console sends nothing
// new and the sim's NET routes can stand in for a service in tests. Every
// other URL is fetched as before.
//
// A provider gets the request with the console that sent it and answers an
// ordinary NET response, or throws a ServiceError, which answers its status
// and JSON body. Credentials stay in the companion's store; a response
// never carries one.
//
// The console names the app behind every request (the `app` member, filled
// by its runtime, not the guest). A service answers only an app this
// companion offers whose manifest lists the service in `applet.services`
// (contracts/spec/applet.ts); any other gets 403. The request's timeoutMs
// and maxBytes hold as they do for a fetched URL.

import { LINK_SERVICES_HOST } from "../../contracts/spec/link.ts";
import { NET_ERROR } from "../../contracts/spec/net.ts";
import { NetFailure, type NetRequest, type NetResponse } from "./fetch.ts";
import { createDiscordService } from "./services/discord.ts";
import { createGlyphsService } from "./services/glyphs.ts";
import { createXService } from "./services/x.ts";
import { createYoutubeService } from "./services/youtube.ts";

export interface ServiceConsole {
  name: string;
  /** The console's address on the LAN. */
  address: string;
  /** This Mac's address on the console's link connection, which the console
   *  reaches for a stream it opens back. */
  localAddress: string;
}

export interface ServiceRequest {
  method: string;
  /** The path after the service's name, from "/". */
  path: string;
  query: URLSearchParams;
  body: Uint8Array;
  /** The largest response the app takes; a larger one fails the request
   *  with response_too_large. */
  maxBytes: number;
  console: ServiceConsole;
  signal: AbortSignal;
}

/** The app behind a request and the services its manifest declares. */
interface ServiceCaller {
  app: string;
  services: readonly string[];
}

export interface ServiceContext {
  /** The companion's store directory; a service keeps its files under
   *  `<storeDir>/services/<name>/`. */
  storeDir: string;
  log: (line: string) => void;
}

export interface ServiceProvider {
  readonly name: string;
  handle(request: ServiceRequest): Promise<Omit<NetResponse, "url">>;
  /** An owner command from the Mac (`bun tools/companion.ts service <name>
   *  <args>`, or the menu bar app): sign in, set a token, report status.
   *  Returns the text to show. */
  command?(args: string[]): Promise<string>;
  close?(): void;
}

const encoder = new TextEncoder();

export function jsonResponse(status: number, value: unknown): Omit<NetResponse, "url"> {
  return { status, headers: { "content-type": "application/json" }, body: encoder.encode(JSON.stringify(value)) };
}

export function bytesResponse(body: Uint8Array, contentType: string): Omit<NetResponse, "url"> {
  return { status: 200, headers: { "content-type": contentType }, body };
}

/** A failure a provider throws; the request answers `status` with the JSON
 *  `body`. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? body.error ?? `status ${status}`));
  }
}

/** The request's body as JSON. A body that does not parse fails the request
 *  with 400 and `refusal`. */
export function readJson<T>(request: ServiceRequest, refusal: Record<string, unknown>): T {
  try {
    return JSON.parse(new TextDecoder().decode(request.body)) as T;
  } catch {
    throw new ServiceError(400, refusal);
  }
}

/** `provider`'s response to `request`, a ServiceError answered as its JSON. */
export async function serve(provider: ServiceProvider, request: ServiceRequest): Promise<Omit<NetResponse, "url">> {
  try {
    return await provider.handle(request);
  } catch (error) {
    if (error instanceof ServiceError) return jsonResponse(error.status, error.body);
    throw error;
  }
}

export const SERVICE_FACTORIES: Record<string, (context: ServiceContext) => ServiceProvider> = {
  youtube: createYoutubeService,
  x: createXService,
  discord: createDiscordService,
  glyphs: createGlyphsService,
};

export class ServiceHost {
  private providers = new Map<string, ServiceProvider>();

  constructor(private readonly context: ServiceContext) {}

  private provider(name: string): ServiceProvider | undefined {
    const factory = SERVICE_FACTORIES[name];
    if (!factory) return undefined;
    let provider = this.providers.get(name);
    if (!provider) {
      provider = factory(this.context);
      this.providers.set(name, provider);
    }
    return provider;
  }

  /** Run an owner command of service `name`. */
  async command(name: string, args: string[]): Promise<string> {
    const provider = this.provider(name);
    if (!provider) throw new Error(`no service named ${name}`);
    if (!provider.command) throw new Error(`the ${name} service takes no commands`);
    return await provider.command(args);
  }

  /** The response when `request` names a service, else null. Throws a
   *  NetFailure on a timeout or a response past maxBytes. */
  async handle(
    request: Pick<NetRequest, "url" | "method" | "timeoutMs" | "maxBytes"> & { body: Uint8Array },
    console: ServiceConsole,
    caller: ServiceCaller,
    signal: AbortSignal,
  ): Promise<NetResponse | null> {
    const url = new URL(request.url);
    if (url.hostname !== LINK_SERVICES_HOST) return null;
    const [, name = "", ...rest] = url.pathname.split("/");
    if (!SERVICE_FACTORIES[name]) return { ...jsonResponse(404, { error: `no service named ${name}` }), url: request.url };
    if (!caller.services.includes(name)) {
      this.context.log(`service ${name}: refused ${caller.app || "an unnamed app"}`);
      return { ...jsonResponse(403, { error: `${caller.app || "this app"} does not declare the ${name} service in applet.services of an app this companion offers` }), url: request.url };
    }
    const provider = this.provider(name)!;
    const deadline = AbortSignal.timeout(request.timeoutMs);
    const done = AbortSignal.any([signal, deadline]);
    let response: Omit<NetResponse, "url">;
    try {
      response = await Promise.race([
        serve(provider, {
          method: request.method,
          path: `/${rest.join("/")}`,
          query: url.searchParams,
          body: request.body,
          maxBytes: request.maxBytes,
          console,
          signal: done,
        }),
        new Promise<never>((_, reject) => {
          const stop = () => reject(deadline.aborted ? new NetFailure(NET_ERROR.timeout, `the ${name} service took more than ${request.timeoutMs} ms`) : new NetFailure(NET_ERROR.cancelled, "cancelled"));
          if (done.aborted) stop();
          else done.addEventListener("abort", stop, { once: true });
        }),
      ]);
    } catch (error) {
      if (error instanceof NetFailure) throw error;
      this.context.log(`service ${name}: ${(error as Error).message}`);
      return { ...jsonResponse(502, { error: (error as Error).message }), url: request.url };
    }
    if (response.body.length > request.maxBytes) {
      throw new NetFailure(NET_ERROR.responseTooLarge, `the ${name} service answered ${response.body.length} bytes, limit ${request.maxBytes}`);
    }
    return { ...response, url: request.url };
  }

  close() {
    for (const provider of this.providers.values()) provider.close?.();
    this.providers.clear();
  }
}
