// apps/link-channel/worker.ts — the demo's worker: one HTTP request over the
// Pocket Link (`net.http`, docs/POCKET-LINK.md §6.5), tried once a second
// until the link carries it, and its outcome published to the UI as one
// record: "<status> <bytes> <first bytes of the body>". A try that fails
// publishes why ("failed: …") and the next second tries again.

import { FactKind, ResourceStatus, io } from "@pocketjs/framework/io";
import { settle } from "@pocketjs/framework/worker";

const output = io.channel("http");
// The 3DS's QuickJS has no TextEncoder: these records are ASCII.
const text = (value: string) => Uint8Array.from(value, (c) => c.charCodeAt(0) & 0x7f);
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

async function fetchOnce(): Promise<string> {
  const http = io.http("http").open({ url: "http://link-channel.test/hello?from=worker", timeoutMs: 10_000, maxBytes: 4096 });
  try {
    const request = http.submit();
    if (request < 0) return "failed: the host accepted no request";
    let status = 0;
    let bytes = 0;
    let head = "";
    const reading = (async () => {
      for await (const fact of http.observe()) {
        if (fact.kind === FactKind.headers) {
          status = Number((JSON.parse(ascii(fact.data)) as { status?: number }).status ?? 0);
        } else if (fact.kind === FactKind.data) {
          if (head.length < 32) head += ascii(fact.data.subarray(0, 32 - head.length));
          bytes += fact.data.length;
        }
      }
    })();
    const outcome = await settle(request);
    http.close();
    await reading.catch(() => {});
    return outcome.status === ResourceStatus.ok ? `${status} ${bytes} ${head}` : `failed: status ${outcome.status} after ${bytes} bytes`;
  } finally {
    http.close();
  }
}

async function main(): Promise<void> {
  for await (const _ of io.timer(1_000_000)) {
    try {
      const result = await fetchOnce();
      output.publish(text(result));
      if (!result.startsWith("failed")) return;
    } catch (error) {
      output.publish(text(`failed: ${error}`.slice(0, 90)));
    }
  }
}
main();
