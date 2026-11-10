// apps/link-channel/http-fixture.ts — the HTTP origin the Link Channel demo's
// worker fetches from (worker.ts). The worker names it by a host that does
// not resolve, `link-channel.test`; whoever runs Hub's side answers it:
//
//   - tests/e2e/azahar-link2.ts hands the reference Hub `fixtureFetch` as its
//     fetch, so no socket is opened;
//   - `bun run link2 serve --resolve link-channel.test=127.0.0.1:<port>` sends
//     the requests to `serveHttpFixture(port)`, a real HTTP server on this
//     computer, which the demo's daemon module starts (daemon.ts). That path
//     is the one a real device exercises: Hub performs a real request.
//
// Paths: /hello, /big?bytes=N (a pattern both ends can check), /echo (the
// method, the body's length and its FNV-1a), /slow?ms=N (answers after N ms),
// /status?code=N.

export const LINK_CHANNEL_HTTP_HOST = "link-channel.test";
export const LINK_CHANNEL_HTTP_PORT = 9742;
/** The largest /big answers: the link carries at most 256 KiB of response. */
export const FIXTURE_MAX_BYTES = 256 * 1024;

export function fnv(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i]!, 0x01000193);
  return hash >>> 0;
}

/** The bytes of /big and of the daemon's streams: a pattern both ends compute. */
export function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

export interface FixtureAnswer {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

const text = (status: number, body: string, more: [string, string][] = []): FixtureAnswer => ({
  status,
  headers: [["content-type", "text/plain"], ...more],
  body: new TextEncoder().encode(body),
});

/** What the origin answers to one request. `/slow` waits; an aborted signal ends the wait. */
export async function answerHttp(method: string, url: string, body: Uint8Array, signal?: AbortSignal): Promise<FixtureAnswer> {
  const at = new URL(url);
  switch (at.pathname) {
    case "/hello":
      return text(200, "hello from Hub", [["x-from", at.searchParams.get("from") ?? ""]]);
    case "/big": {
      const bytes = Math.max(0, Math.min(FIXTURE_MAX_BYTES, Number(at.searchParams.get("bytes") ?? 0) | 0));
      return { status: 200, headers: [["content-type", "application/octet-stream"], ["x-bytes", String(bytes)]], body: patternBytes(bytes) };
    }
    case "/echo":
      return text(200, `${method} ${body.length} ${fnv(body).toString(16)}`);
    case "/slow": {
      const ms = Math.max(0, Math.min(120_000, Number(at.searchParams.get("ms") ?? 0) | 0));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
      return text(200, "slow done");
    }
    case "/status":
      return text(Math.max(200, Math.min(599, Number(at.searchParams.get("code") ?? 200) | 0)), "status");
    default:
      return text(404, "no such path");
  }
}

/** The origin as the reference Hub's fetch: no socket, the answers above. */
export function fixtureFetch(seen?: (line: string) => void) {
  return async (request: { app: string; url: string; method: string }, body: Uint8Array) => {
    seen?.(`${request.app} ${request.method} ${request.url}`);
    const answer = await answerHttp(request.method, request.url, body);
    return { status: answer.status, url: request.url, headers: answer.headers, body: answer.body };
  };
}

/** The origin as an HTTP server on this computer, for `serve --resolve`. */
export function serveHttpFixture(port = LINK_CHANNEL_HTTP_PORT, log?: (line: string) => void): { port: number; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 180,
    async fetch(request) {
      const body = new Uint8Array(await request.arrayBuffer());
      const answer = await answerHttp(request.method, request.url, body, request.signal);
      log?.(`http fixture: ${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} -> ${answer.status}, ${answer.body.length} bytes`);
      return new Response(answer.body as unknown as BodyInit, { status: answer.status, headers: answer.headers });
    },
  });
  return { port: server.port ?? port, stop: () => void server.stop(true) };
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? LINK_CHANNEL_HTTP_PORT);
  const server = serveHttpFixture(port, console.log);
  console.log(`http fixture on 127.0.0.1:${server.port}; run serve with --resolve ${LINK_CHANNEL_HTTP_HOST}=127.0.0.1:${server.port}`);
}
