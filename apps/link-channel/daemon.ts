// apps/link-channel/daemon.ts — the computer side of the Link Channel demo:
// a daemon for the reference Hub endpoint (tools/pocket-link/v2/hub.ts).
//
// It answers the applet's script (app.tsx), sends `tick` events while the
// channel is open, asks the applet one request of its own, and keeps what the
// applet reported for a test to read. It also holds the other end of the
// applet's bench (`linkBench` in app.tsx): streams of a given size each way,
// events each way, and the result lines the applet reports.
//
// As a module of `bun run link2 serve` (the default export) it starts the
// HTTP origin of the applet's worker (http-fixture.ts) on this computer; the
// serve sends the worker's requests there with
// `--resolve link-channel.test=127.0.0.1:9742`.

import type { AppletChannel, LinkDaemon } from "../../tools/pocket-link/v2/hub.ts";
import { LinkError } from "../../tools/pocket-link/v2/peer.ts";
import { LINK_CHANNEL_HTTP_HOST, LINK_CHANNEL_HTTP_PORT, fnv, patternBytes, serveHttpFixture } from "./http-fixture.ts";

export const LINK_CHANNEL_APP = "dev.pocket-nexus.link-channel";

/** The bytes `blob` streams: a pattern both ends can check. */
export const blobBytes = patternBytes;

/** The largest stream the bench sends one way. */
const BENCH_MAX_BYTES = 8 * 1024 * 1024;

export interface LinkChannelSeen {
  channels: number;
  generation: number;
  hello: unknown;
  note: { bytes: number; hash: number } | null;
  report: Record<string, unknown> | null;
  sum: unknown;
  blobHash: number;
  /** The worker's HTTP outcome, "<status> <bytes> <body>". */
  http: string | null;
}

export function linkChannelDaemon(options: { log?: (line: string) => void } = {}): { daemon: LinkDaemon; seen: LinkChannelSeen } {
  const log = options.log ?? (() => {});
  const seen: LinkChannelSeen = { channels: 0, generation: 0, hello: null, note: null, report: null, sum: null, blobHash: 0, http: null };
  const daemon: LinkDaemon = {
    attach(channel: AppletChannel, info) {
      seen.channels += 1;
      seen.generation = info.generation;
      let ticks = 0;
      const timer = setInterval(() => {
        if (channel.state().state !== "open") return;
        if (channel.emit("tick", { n: ticks })) ticks += 1;
      }, 100);
      channel.onClose(() => clearInterval(timer));

      channel.onEvent("hello", (args) => {
        seen.hello = args;
        // The daemon's own request, answered by the applet's `onRequest`.
        channel.request("applet.sum", { a: 19, b: 23 }).reply.then(
          (value) => (seen.sum = value),
          (error) => (seen.sum = { error: String(error) }),
        );
      });
      channel.onEvent("http", (args) => {
        seen.http = typeof args.result === "string" ? args.result : null;
      });
      channel.onEvent("note", (_args, stream) => {
        if (!stream) return;
        void (async () => {
          let bytes = 0;
          let hash = 0x811c9dc5;
          for (;;) {
            const chunk = await stream.read();
            if (chunk === null) break;
            bytes += chunk.length;
            hash = fnv(chunk, hash);
          }
          seen.note = { bytes, hash };
        })();
      });

      channel.on("echo", (args) => ({ echo: args.text ?? null }));
      channel.on("blob", async (args, call) => {
        const bytes = blobBytes(Number(args.bytes ?? 0));
        seen.blobHash = fnv(bytes);
        // The head step: the applet gets the stream before any byte (§7.2).
        while (!call.progress("blob.head", { bytes: bytes.length })) await new Promise((resolve) => setTimeout(resolve, 10));
        const stream = call.respond();
        await stream.writeAll(bytes);
        stream.end();
        return { bytes: bytes.length, hash: seen.blobHash };
      });
      channel.on("slow", (_args, call) => new Promise((_resolve, reject) => call.onCancel(() => reject(new LinkError("cancelled")))));
      channel.on("report", (args) => {
        seen.report = args as Record<string, unknown>;
        return { ok: true };
      });

      // --- the bench (app.tsx `linkBench`) ---------------------------------
      // A response stream of `bytes`: how long this side took to hand them all to the link.
      channel.on("bench.down", async (args, call) => {
        const bytes = patternBytes(Math.max(0, Math.min(BENCH_MAX_BYTES, Number(args.bytes ?? 0) | 0)));
        while (!call.progress("bench.head", { bytes: bytes.length })) await new Promise((resolve) => setTimeout(resolve, 5));
        const stream = call.respond();
        const started = performance.now();
        await stream.writeAll(bytes);
        stream.end();
        await stream.finished;
        return { bytes: bytes.length, ms: Math.round(performance.now() - started) };
      });
      // An upload stream from the applet: its bytes, and the time from the first to the last.
      let upload: Promise<{ bytes: number; ms: number; ok: boolean }> | null = null;
      channel.onEvent("bench.up", (_args, stream) => {
        if (!stream) return;
        upload = (async () => {
          let bytes = 0;
          let ok = true;
          let first = 0;
          for (;;) {
            const chunk = await stream.read();
            if (chunk === null) break;
            if (first === 0) first = performance.now();
            // One byte of each chunk against the pattern: a slip in the stream shows without hashing 4 MiB.
            if (chunk[0] !== ((bytes * 31 + (bytes >> 8)) & 0xff)) ok = false;
            bytes += chunk.length;
          }
          return { bytes, ms: Math.round(performance.now() - first), ok };
        })();
      });
      channel.on("bench.up.result", async () => (upload === null ? { bytes: 0, ms: 0, ok: false } : await upload));
      // Events from the applet, counted; and events toward it, as fast as its window takes them.
      let events = { count: 0, first: 0, last: 0 };
      channel.onEvent("bench.event", () => {
        const now = performance.now();
        if (events.count === 0) events.first = now;
        events.count += 1;
        events.last = now;
      });
      channel.on("bench.events.result", () => {
        const result = { count: events.count, ms: Math.round(events.last - events.first) };
        events = { count: 0, first: 0, last: 0 };
        return result;
      });
      channel.on("bench.events.down", async (args) => {
        const count = Math.max(0, Math.min(100_000, Number(args.count ?? 0) | 0));
        const started = performance.now();
        for (let n = 0; n < count; n++) {
          while (!channel.emit("bench.tick", { n })) {
            if (channel.state().state !== "open") return { sent: n, ms: Math.round(performance.now() - started) };
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
        return { sent: count, ms: Math.round(performance.now() - started) };
      });
      channel.on("bench.report", (args) => {
        log(`bench ${JSON.stringify(args)}`);
        return { ok: true };
      });
    },
  };
  return { daemon, seen };
}

/** The module form `bun run link2 serve --daemon <applet id>=apps/link-channel/daemon.ts` loads. */
export default function linkChannelModule({ log }: { log(line: string): void }): LinkDaemon {
  const { daemon, seen } = linkChannelDaemon({ log });
  // The worker's HTTP origin, when the port is free: a second serve on this computer finds it taken.
  let fixture: { port: number; stop(): void } | null = null;
  try {
    fixture = serveHttpFixture(Number(process.env.LINK_CHANNEL_HTTP_PORT ?? LINK_CHANNEL_HTTP_PORT), log);
    log(`http fixture on 127.0.0.1:${fixture.port}; the worker reaches it with --resolve ${LINK_CHANNEL_HTTP_HOST}=127.0.0.1:${fixture.port}`);
  } catch (error) {
    log(`http fixture not started: ${error instanceof Error ? error.message : error}`);
  }
  return {
    ...daemon,
    stop() {
      daemon.stop?.();
    },
    attach(channel, info) {
      log(`channel open: generation ${info.generation}`);
      channel.onClose((reason) => log(`closed (${reason}): report ${JSON.stringify(seen.report)}, note ${JSON.stringify(seen.note)}, http ${seen.http}`));
      daemon.attach(channel, info);
    },
  };
}
