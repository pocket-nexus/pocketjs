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
// ordinary NET response. Credentials stay in the companion's store; a
// response never carries one.

import { LINK_SERVICES_HOST } from "../../contracts/spec/link.ts";
import type { NetRequest, NetResponse } from "./fetch.ts";
import { createDiscordService } from "./services/discord.ts";
import { createXService } from "./services/x.ts";
import { createYoutubeService } from "./services/youtube.ts";

export interface ServiceConsole {
  id: string;
  name: string;
  model: string;
  target: string;
  /** The console's address on the LAN, for streams it opens back. */
  address: string;
}

export interface ServiceRequest {
  method: string;
  /** The path after the service's name, from "/". */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Uint8Array;
  console: ServiceConsole;
  signal: AbortSignal;
}

export interface ServiceContext {
  /** The companion's store directory; a service keeps its files under
   *  `<storeDir>/services/<name>/`. */
  storeDir: string;
  log: (line: string) => void;
  /** The address the console reaches this companion at. */
  advertiseHost: () => string;
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

export const SERVICE_FACTORIES: Record<string, (context: ServiceContext) => ServiceProvider> = {
  youtube: createYoutubeService,
  x: createXService,
  discord: createDiscordService,
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

  /** The response when `request` names a service, else null. */
  async handle(request: Pick<NetRequest, "url" | "method" | "headers"> & { body: Uint8Array }, console: ServiceConsole, signal: AbortSignal): Promise<NetResponse | null> {
    const url = new URL(request.url);
    if (url.hostname !== LINK_SERVICES_HOST) return null;
    const [, name = "", ...rest] = url.pathname.split("/");
    const provider = this.provider(name);
    if (!provider) return { ...jsonResponse(404, { error: `no service named ${name}` }), url: request.url };
    try {
      const response = await provider.handle({
        method: request.method,
        path: `/${rest.join("/")}`,
        query: url.searchParams,
        headers: request.headers,
        body: request.body,
        console,
        signal,
      });
      return { ...response, url: request.url };
    } catch (error) {
      this.context.log(`service ${name}: ${(error as Error).message}`);
      return { ...jsonResponse(502, { error: (error as Error).message }), url: request.url };
    }
  }

  close() {
    for (const provider of this.providers.values()) provider.close?.();
    this.providers.clear();
  }
}
