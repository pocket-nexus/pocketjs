// apps/link-channel/daemon.ts — the computer side of the Link Channel demo:
// a daemon for the reference Hub endpoint (tools/pocket-link/v2/hub.ts).
//
// It answers the applet's script (app.tsx), sends `tick` events while the
// channel is open, asks the applet one request of its own, and keeps what the
// applet reported for a test to read.

import type { AppletChannel, LinkDaemon } from "../../tools/pocket-link/v2/hub.ts";
import { LinkError } from "../../tools/pocket-link/v2/peer.ts";

export const LINK_CHANNEL_APP = "dev.pocket-nexus.link-channel";

function fnv(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i]!, 0x01000193);
  return hash >>> 0;
}

/** The bytes `blob` streams: a pattern both ends can check. */
export function blobBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

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

export function linkChannelDaemon(): { daemon: LinkDaemon; seen: LinkChannelSeen } {
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
    },
  };
  return { daemon, seen };
}

/** The module form `bun run link2 serve --daemon <applet id>=apps/link-channel/daemon.ts` loads. */
export default function linkChannelModule({ log }: { log(line: string): void }): LinkDaemon {
  const { daemon, seen } = linkChannelDaemon();
  return {
    ...daemon,
    attach(channel, info) {
      log(`channel open: generation ${info.generation}`);
      channel.onClose((reason) => log(`closed (${reason}): report ${JSON.stringify(seen.report)}, note ${JSON.stringify(seen.note)}, http ${seen.http}`));
      daemon.attach(channel, info);
    },
  };
}
