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
//   7. an HTTP request from its worker (worker.ts)  net.http
//
// It then reports what it saw in one request (`report`), which is what
// tests/e2e/azahar-link2.ts reads. A re-run needs no button: the script
// starts again whenever the channel's generation changes.

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

  const say = (line: string) => setLines((all) => [...all.slice(-9), line]);

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
    for (const record of fetched.observe()) {
      const text = String.fromCharCode(...record.copy());
      if (text !== http) {
        http = text;
        say(`http ${http}`);
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
