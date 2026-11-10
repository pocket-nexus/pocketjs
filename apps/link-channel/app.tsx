// apps/link-channel/app.tsx — acceptance demo for an applet channel
// (`@pocketjs/framework/channel`, docs/POCKET-LINK.md §7).
//
// The applet runs one script against its daemon (daemon.ts) each time the
// channel opens, and shows each step on the top screen:
//
//   1. a request and its reply                      echo
//   2. a response stream behind a head event        blob
//   3. an event with a stream toward the daemon     note
//   4. a request it cancels                         slow
//   5. the daemon's request to the applet           applet.sum
//   6. the daemon's events                          tick
//   7. HTTP requests from its worker (worker.ts)    net.http
//
// It then reports what it saw in one request (`report`), which is what
// tests/e2e/azahar-link2.ts reads. A re-run needs no button: the script
// starts again whenever the channel's generation changes.
//
// `globalThis.linkBench` measures the channel on a device, started from
// outside with an eval (`linkBench.start("down", 1048576)`) and read back the
// same way (`linkBench.result()`): a response stream toward the applet, an
// upload from it, request and reply round trips, and events each way. Each
// result is one short JSON object, also sent to the daemon (`bench.report`),
// which prints it in the serve's log.

import { createSignal, For } from "solid-js";
import { AuxiliarySurface, Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { worker } from "@pocketjs/framework/worker/channels";
import {
  CHANNEL_STATE,
  ChannelError,
  channelState,
  emit,
  emitStream,
  onEvent,
  onRequest,
  request,
  type ChannelArgs,
} from "@pocketjs/framework/channel";

const BLOB_BYTES = 48_000;
const BENCH_CHUNK = 16_384;

type BenchResult = { k: string; n: number; ms: number } & Record<string, string | number | boolean>;

/** FNV-1a over the bytes the daemon streams: both ends compute it. */
function fnv(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i]!, 0x01000193);
  return hash >>> 0;
}

export default function LinkChannelDemo() {
  const [status, setStatus] = createSignal("closed");
  const [lines, setLines] = createSignal<string[]>([]);
  const [ticks, setTicks] = createSignal(0);
  let generation = 0;
  let running = false;
  let sums = 0;
  /** What the worker's HTTP request gave: "<status> <bytes> <body>". */
  let http = "";
  const fetched = worker.channel("http");

  const say = (line: string) => setLines((all) => [...all.slice(-12), line]);

  // ---- the bench ------------------------------------------------------------
  const frameWaiters: (() => void)[] = [];
  const nextFrame = () => new Promise<void>((resolve) => frameWaiters.push(resolve));
  let benchRunning = "";
  let benchTicks = 0;
  const BENCH_RESULTS = 32;
  const benchResults: BenchResult[] = [];
  let benchCount = 0;
  onEvent("bench.tick", () => {
    benchTicks += 1;
  });
  /** A request that waits a frame and tries again while the channel has no room. */
  async function ask(t: string, args: ChannelArgs): Promise<ChannelArgs> {
    for (;;) {
      try {
        return (await request(t, args).reply) as ChannelArgs;
      } catch (error) {
        if (!(error instanceof ChannelError) || error.code !== "busy") throw error;
        await nextFrame();
      }
    }
  }
  const benches: Record<string, (n: number) => Promise<BenchResult>> = {
    /** A response stream of `n` bytes toward the applet, read in 16 KiB reads. */
    async down(n) {
      const started = Date.now();
      let received = 0;
      let first = 0;
      let reads = 0;
      let reading: Promise<void> = Promise.resolve();
      const call = request("bench.down", { bytes: n }, {
        onProgress(_t, _args, stream) {
          if (!stream) return;
          reading = (async () => {
            const chunk = new Uint8Array(BENCH_CHUNK);
            for (;;) {
              const count = await stream.read(chunk);
              if (count === null) break;
              if (first === 0) first = Date.now();
              received += count;
              reads += 1;
            }
          })();
        },
      });
      const trailer = (await call.reply) as ChannelArgs;
      await reading;
      const ms = Date.now() - started;
      return { k: "down", n, ms, got: received, reads, firstMs: first - started, hubMs: Number(trailer.ms ?? 0), kbs: Math.round(received / 1024 / (ms / 1000)) };
    },
    /** An event stream of `n` bytes toward the daemon, written in 16 KiB writes. */
    async up(n) {
      const chunk = new Uint8Array(BENCH_CHUNK);
      const started = Date.now();
      const writer = emitStream("bench.up", { bytes: n });
      if (!writer) return { k: "up", n, ms: 0, error: "no stream" } as BenchResult;
      for (let at = 0; at < n; at += chunk.length) {
        const take = Math.min(chunk.length, n - at);
        // The daemon checks the first byte of each chunk it reads against the pattern.
        for (let i = 0; i < take; i += 1024) chunk[i] = ((at + i) * 31 + ((at + i) >> 8)) & 0xff;
        for (let i = 0; i < Math.min(take, 64); i++) chunk[i] = ((at + i) * 31 + ((at + i) >> 8)) & 0xff;
        await writer.write(take === chunk.length ? chunk : chunk.subarray(0, take));
      }
      await writer.end();
      const sent = Date.now() - started;
      const seen = await ask("bench.up.result", {});
      const ms = Date.now() - started;
      return { k: "up", n, ms, sentMs: sent, got: Number(seen.bytes ?? 0), hubMs: Number(seen.ms ?? 0), kbs: Math.round(n / 1024 / (ms / 1000)) };
    },
    /** `n` request and reply round trips, one after the other. */
    async rtt(n) {
      const started = Date.now();
      let worst = 0;
      let over50 = 0;
      let over100 = 0;
      for (let i = 0; i < n; i++) {
        const at = Date.now();
        await ask("echo", { text: "x" });
        const took = Date.now() - at;
        if (took > worst) worst = took;
        if (took > 50) over50 += 1;
        if (took > 100) over100 += 1;
      }
      const ms = Date.now() - started;
      return { k: "rtt", n, ms, mean: Math.round((ms / n) * 10) / 10, worst, over50, over100 };
    },
    /** `n` events toward the daemon, as fast as the channel's units and the send buffer take them. */
    async eventsUp(n) {
      await ask("bench.events.result", {});
      const started = Date.now();
      let waits = 0;
      for (let sent = 0; sent < n; ) {
        if (emit("bench.event", { n: sent })) sent += 1;
        else {
          waits += 1;
          await nextFrame();
        }
      }
      const sentMs = Date.now() - started;
      // The daemon's count is read and cleared by each answer: they add up to `n`.
      let counted = 0;
      for (let tries = 0; tries < 600 && counted < n; tries++) {
        const seen = await ask("bench.events.result", {});
        counted += Number(seen.count ?? 0);
        if (counted < n) await nextFrame();
      }
      const ms = Date.now() - started;
      return { k: "eventsUp", n, ms, sentMs, waits, got: counted, perS: Math.round(counted / (ms / 1000)) };
    },
    /** `n` events from the daemon, counted as the guest takes them. */
    async eventsDown(n) {
      benchTicks = 0;
      const started = Date.now();
      const sent = await ask("bench.events.down", { count: n });
      while (benchTicks < Number(sent.sent ?? 0)) await nextFrame();
      const ms = Date.now() - started;
      return { k: "eventsDown", n, ms, got: benchTicks, hubMs: Number(sent.ms ?? 0), perS: Math.round(benchTicks / (ms / 1000)) };
    },
  };
  (globalThis as unknown as { linkBench: unknown }).linkBench = {
    /** Starts one bench; "busy" while another runs. */
    start(kind: string, n: number): string {
      const bench = benches[kind];
      if (!bench) return `no such bench: ${Object.keys(benches).join(", ")}`;
      if (benchRunning) return `busy: ${benchRunning}`;
      benchRunning = kind;
      bench(n)
        .catch((error) => ({ k: kind, n, ms: 0, error: error instanceof ChannelError ? error.code : String(error).slice(0, 60) }) as BenchResult)
        .then((result) => {
          // The last results only: a soak that starts a bench a second must not grow the heap.
          benchResults.push(result);
          if (benchResults.length > BENCH_RESULTS) benchResults.shift();
          benchCount += 1;
          benchRunning = "";
          say(`bench ${JSON.stringify(result)}`.slice(0, 64));
          request("bench.report", result as unknown as ChannelArgs).reply.catch(() => {});
        });
      return "started";
    },
    running: () => benchRunning,
    /** Benches finished since the applet started. */
    count: () => benchCount,
    /** One result as JSON by its number (0 is the first bench), the last when none is given; null once it has left the list. */
    result: (index?: number) => JSON.stringify(benchResults[index === undefined ? benchResults.length - 1 : index - (benchCount - benchResults.length)] ?? null),
  };

  onEvent("tick", () => setTicks((count) => count + 1));
  onRequest("applet.sum", (args: ChannelArgs) => {
    sums += 1;
    return { sum: Number(args.a ?? 0) + Number(args.b ?? 0) };
  });

  async function script(): Promise<void> {
    const report: ChannelArgs = {};
    const echo = await request("echo", { text: "hello" }).reply;
    report.echo = echo;
    say(`echo ${JSON.stringify(echo)}`);

    let received = 0;
    let hash = 0x811c9dc5;
    let reading: Promise<void> = Promise.resolve();
    const blob = request("blob", { bytes: BLOB_BYTES }, {
      onProgress(_t, _args, stream) {
        if (!stream) return;
        reading = (async () => {
          const chunk = new Uint8Array(8192);
          for (;;) {
            const count = await stream.read(chunk);
            if (count === null) break;
            hash = fnv(chunk.subarray(0, count), hash);
            received += count;
          }
        })();
      },
    });
    const trailer = await blob.reply;
    await reading;
    report.blob = { received, hash, trailer };
    say(`blob ${received} bytes ${hash.toString(16)}`);

    const note = new Uint8Array(3000);
    for (let i = 0; i < note.length; i++) note[i] = (i * 7) & 0xff;
    const writer = emitStream("note", { bytes: note.length });
    if (writer) {
      await writer.write(note);
      await writer.end();
    }
    report.note = { sent: writer ? note.length : 0, hash: fnv(note) };
    say(`note ${note.length} bytes`);

    const slow = request("slow", {});
    slow.cancel();
    let cancelled = "";
    try {
      await slow.reply;
    } catch (error) {
      cancelled = error instanceof ChannelError ? error.code : "error";
    }
    report.cancelled = cancelled;
    say(`slow ${cancelled}`);

    report.ticks = ticks();
    report.sums = sums;
    report.http = http;
    const done = await request("report", report).reply;
    say(`report ${JSON.stringify(done)}`);
  }

  onFrame(() => {
    for (const wake of frameWaiters.splice(0)) wake();
    for (const record of fetched.observe()) {
      const text = String.fromCharCode(...record.copy());
      if (text !== http) {
        http = text;
        // One line per request of the worker's run.
        for (const part of http.split(" | ")) say(`http ${part}`);
        // The worker may finish after the script reported: tell the daemon.
        emit("http", { result: http });
      }
    }
    const now = channelState();
    setStatus(now.reason ? `${now.state} (${now.reason})` : now.state);
    if (now.state !== CHANNEL_STATE.open || now.generation === generation || running) return;
    generation = now.generation;
    running = true;
    say(`generation ${generation}`);
    emit("hello", { generation });
    script()
      .catch((error) => say(`failed ${error instanceof ChannelError ? error.code : String(error)}`))
      .finally(() => {
        running = false;
      });
  });

  return (
    <View class="w-full h-full bg-slate-900 flex-col p-[8]">
      <Text class="text-base text-white">Link channel</Text>
      <Text class="text-sm text-slate-300">{`channel ${status()}  ticks ${ticks()}`}</Text>
      <For each={lines()}>{(line) => <Text class="text-xs text-slate-400">{line}</Text>}</For>
      <AuxiliarySurface>
        <View class="w-full h-full bg-slate-800 items-center justify-center">
          <Text class="text-sm text-slate-300">The script runs when the channel opens.</Text>
        </View>
      </AuxiliarySurface>
    </View>
  );
}
