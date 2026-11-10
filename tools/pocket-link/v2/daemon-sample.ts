// A sample daemon for `serve --daemon <applet id>=tools/pocket-link/v2/daemon-sample.ts`
// (docs/POCKET-LINK.md §7): the computer side of a test applet. It answers a
// request, pushes events, serves a stream behind a head event, takes a
// request body, and honours cancel. What it expects of the applet is the
// names below and nothing else:
//
//   requests the applet sends
//     echo   {…}                        -> {echo: {…}}
//     time   {}                         -> {utc}
//     blob   {bytes, seed?}             -> progress `blob.head` {bytes}, then
//                                          `bytes` bytes on the request's
//                                          stream, then {bytes, crc32}
//     sink   {} with a body             -> {bytes, crc32} of the body
//     slow   {ms}                       -> {waited} after `ms`, or nothing
//                                          when the applet cancels first
//     ticks  {count, everyMs?}          -> {started}; then `count` events
//                                          `tick` {n, of}
//   events the applet sends
//     note   {text}                     -> the daemon answers with the event
//                                          `note.seen` {text}
//     upload {…} with a stream          -> the event `upload.done` {bytes, crc32}
//
// Byte i of a `blob` is (i * 31 + seed) & 255, which a test can check
// without holding the bytes.

import type { DaemonFactory } from "./daemon.ts";
import type { Json, StreamReader } from "./peer.ts";
import { LinkError } from "./peer.ts";

const BLOB_MAX = 4 * 1024 * 1024;
const CHUNK = 16 * 1024;

export const pattern = (length: number, seed: number, from = 0) => new Uint8Array(length).map((_, i) => ((from + i) * 31 + seed) & 255);

async function drain(stream: StreamReader): Promise<{ bytes: number; crc32: number }> {
  let bytes = 0;
  let crc = 0;
  for (let chunk = await stream.read(); chunk !== null; chunk = await stream.read()) {
    bytes += chunk.length;
    crc = Bun.hash.crc32(chunk, crc);
  }
  return { bytes, crc32: crc >>> 0 };
}

const integer = (value: unknown, least: number, most: number, otherwise: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= least && value <= most ? value : otherwise;

const daemon: DaemonFactory = ({ log }) => ({
  attach(channel, info) {
    log(`device ${info.device} opened generation ${info.generation} (package ${info.hash})`);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    channel.onClose((reason) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      log(`generation ${info.generation} closed: ${reason}`);
    });

    channel.on("echo", (args) => ({ echo: args }));
    channel.on("time", () => ({ utc: Date.now() }));

    channel.on("blob", async (args, call) => {
      const bytes = integer(args.bytes, 0, BLOB_MAX, -1);
      if (bytes < 0) throw new LinkError("invalid", `bytes is 0 to ${BLOB_MAX}`);
      const seed = integer(args.seed, 0, 255, 0);
      // The head event comes before any byte: the applet holds the stream from it (§7.2).
      while (!call.progress("blob.head", { bytes })) {
        if (call.cancelled) return;
        await new Promise((done) => setTimeout(done, 5));
      }
      const out = call.respond();
      let crc = 0;
      for (let at = 0; at < bytes && !call.cancelled; at += CHUNK) {
        const piece = pattern(Math.min(CHUNK, bytes - at), seed, at);
        crc = Bun.hash.crc32(piece, crc);
        await out.writeAll(piece);
      }
      if (call.cancelled) return;
      out.end();
      await out.finished;
      return { bytes, crc32: crc >>> 0 };
    });

    channel.on("sink", async (_args, call) => {
      if (call.body === null) throw new LinkError("invalid", "sink takes a body");
      return drain(call.body);
    });

    channel.on("slow", (args, call) => {
      const ms = integer(args.ms, 0, 25_000, 1000);
      return new Promise<Json | void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve({ waited: ms });
        }, ms);
        timers.add(timer);
        call.onCancel(() => {
          clearTimeout(timer);
          timers.delete(timer);
          log(`slow: cancelled by the applet`);
          resolve();
        });
      });
    });

    channel.on("ticks", (args) => {
      const count = integer(args.count, 1, 1000, 10);
      const everyMs = integer(args.everyMs, 10, 10_000, 100);
      let n = 0;
      const step = () => {
        timers.delete(timer);
        if (channel.state().state !== "open") return;
        // `emit` answers false while the applet's event window is full: the same tick goes again.
        if (channel.emit("tick", { n, of: count })) n += 1;
        if (n < count) {
          timer = setTimeout(step, everyMs);
          timers.add(timer);
        }
      };
      let timer = setTimeout(step, everyMs);
      timers.add(timer);
      return { started: count };
    });

    channel.onEvent("note", (args) => {
      log(`note: ${String(args.text ?? "")}`);
      channel.emit("note.seen", { text: String(args.text ?? "") });
    });
    channel.onEvent("upload", (_args, stream) => {
      if (stream === undefined) return;
      void drain(stream).then(
        (done) => void channel.emit("upload.done", done),
        () => {},
      );
    });
  },
});

export default daemon;
