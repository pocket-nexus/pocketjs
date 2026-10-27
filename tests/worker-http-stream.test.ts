import { expect, test } from "bun:test";
import { StreamCredit } from "../tools/companion/stream-credit.ts";
import { performNet } from "../tools/companion/fetch.ts";

test("stream credit blocks at capacity and cancellation releases its waiter", async () => {
  const abort = new AbortController();
  const window = new StreamCredit(1024, abort.signal);
  expect(await window.take(1024)).toBe(1024);
  let resumed = false;
  const pending = window.take(512).then(n => { resumed = true; return n; });
  await Promise.resolve();
  expect(resumed).toBe(false);
  expect(window.grant(1025)).toBe(false);
  expect(window.grant(128)).toBe(true);
  expect(await pending).toBe(128);
  const blocked = window.take(1);
  abort.abort(new Error("closed"));
  await expect(blocked).rejects.toThrow("closed");
});

test("HTTP headers arrive before EOF and the consumer controls body progress", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      await gate;
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  })) });
  let headed = false;
  const chunks: number[] = [];
  try {
    const response = await performNet({ url: `http://127.0.0.1:${web.port}/`, method: "GET", headers: {}, body: new Uint8Array(), timeoutMs: 3000, maxBytes: 100 }, { allowPrivate: true }, {
      head: () => { headed = true; },
      chunk: async (bytes) => { expect(headed).toBe(true); chunks.push(...bytes); finish(); },
    });
    expect(chunks).toEqual([1, 2, 3, 4, 5]);
    expect(response.body.length).toBe(0);
  } finally { finish(); web.stop(true); }
});

test("native Link stream preserves a full byte window and its disconnect terminal", () => {
  const root = new URL("..", import.meta.url).pathname;
  const directory = `${root}.pocket-build/validation/worker/network`;
  const mkdir = Bun.spawnSync(["mkdir", "-p", directory]);
  expect(mkdir.exitCode).toBe(0);
  const compile = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
    `-I${root}engine/host-services`, `${root}tests/fixtures/worker-link-http.c`,
    `${root}engine/host-services/link_http.c`, `${root}engine/host-services/jscan.c`, "-o", `${directory}/link-http-test`]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  const run = Bun.spawnSync([`${directory}/link-http-test`]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
});
