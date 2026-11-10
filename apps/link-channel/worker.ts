// apps/link-channel/worker.ts — the demo's worker: HTTP over the Pocket Link
// (`net.http`, docs/POCKET-LINK.md §6.5) against the demo's origin
// (http-fixture.ts), tried once a second until the link carries it. One run is
// five requests, and its outcome is published to the UI as one record:
//
//   200 14 hello from Hub | big 200 100000 <fnv> | post 200 POST 700 <fnv>
//     | cancel <status> | timeout <status>
//
//   1. a small GET: the status and the body's first bytes
//   2. a body of several frames (100,000 bytes): their count and FNV-1a
//   3. a POST with a body: the origin answers the method, length and hash
//   4. a request the worker cancels while the origin is still waiting
//   5. a request that outlives its own timeout
//
// A run whose first request fails publishes why ("failed: …") and the next
// second tries again.

import { FactKind, ResourceStatus, io } from "@pocketjs/framework/io";
import { nowMicros, settle, sleep } from "@pocketjs/framework/worker";

const ORIGIN = "http://link-channel.test";
const BIG_BYTES = 100_000;
const POST_BODY = "p".repeat(700);

const output = io.channel("http");
// The 3DS's QuickJS has no TextEncoder: these records are ASCII.
const text = (value: string) => Uint8Array.from(value, (c) => c.charCodeAt(0) & 0x7f);
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

interface Outcome {
  /** The request's terminal status (ResourceStatus). */
  status: number;
  /** The HTTP status of the head, 0 when none came. */
  http: number;
  bytes: number;
  hash: number;
  head: string;
  ms: number;
}

async function fetchOnce(
  options: { url: string; method?: string; body?: string; timeoutMs: number; maxBytes: number },
  cancelAfterMicros = 0,
): Promise<Outcome> {
  const started = nowMicros() ?? 0;
  const http = io.http("http").open(options);
  const outcome: Outcome = { status: ResourceStatus.failed, http: 0, bytes: 0, hash: 0x811c9dc5, head: "", ms: 0 };
  try {
    const request = http.submit();
    if (request < 0) return outcome;
    const reading = (async () => {
      for await (const fact of http.observe()) {
        if (fact.kind === FactKind.headers) {
          outcome.http = Number((JSON.parse(ascii(fact.data)) as { status?: number }).status ?? 0);
        } else if (fact.kind === FactKind.data) {
          if (outcome.head.length < 32) outcome.head += ascii(fact.data.subarray(0, 32 - outcome.head.length));
          const data = fact.data;
          let hash = outcome.hash;
          for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i]!, 0x01000193);
          outcome.hash = hash >>> 0;
          outcome.bytes += data.length;
        }
      }
    })();
    if (cancelAfterMicros > 0) void sleep(cancelAfterMicros).then(() => http.cancel(request));
    outcome.status = (await settle(request)).status;
    http.close();
    await reading.catch(() => {});
  } finally {
    http.close();
    outcome.ms = Math.round(((nowMicros() ?? 0) - started) / 1000);
  }
  return outcome;
}

async function run(): Promise<string> {
  const hello = await fetchOnce({ url: `${ORIGIN}/hello?from=worker`, timeoutMs: 10_000, maxBytes: 4096 });
  if (hello.status !== ResourceStatus.ok) return `failed: status ${hello.status} after ${hello.bytes} bytes`;
  const big = await fetchOnce({ url: `${ORIGIN}/big?bytes=${BIG_BYTES}`, timeoutMs: 30_000, maxBytes: BIG_BYTES });
  const post = await fetchOnce({ url: `${ORIGIN}/echo`, method: "POST", body: POST_BODY, timeoutMs: 10_000, maxBytes: 4096 });
  const cancelled = await fetchOnce({ url: `${ORIGIN}/slow?ms=20000`, timeoutMs: 30_000, maxBytes: 4096 }, 500_000);
  const late = await fetchOnce({ url: `${ORIGIN}/slow?ms=20000`, timeoutMs: 1500, maxBytes: 4096 });
  return [
    `${hello.http} ${hello.bytes} ${hello.head}`,
    `big ${big.http} ${big.bytes} ${big.hash.toString(16)}`,
    `post ${post.http} ${post.head}`,
    `cancel ${cancelled.status}`,
    `timeout ${late.status}`,
  ].join(" | ");
}

async function main(): Promise<void> {
  for await (const _ of io.timer(1_000_000)) {
    try {
      const result = await run();
      output.publish(text(result.slice(0, 230)));
      if (!result.startsWith("failed")) return;
    } catch (error) {
      output.publish(text(`failed: ${error}`.slice(0, 90)));
    }
  }
}
main();
