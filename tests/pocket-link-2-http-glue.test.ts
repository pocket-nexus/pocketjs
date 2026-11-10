// engine/host-services/link2_http.c (a worker's HTTP requests on `net.http`)
// compiled on the host with a stub of the client: the worker's handle of a
// request is this file's own number, so a response left unread across a
// reconnect cannot take the callbacks of the next connection's request with
// the same wire id.

import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = join(root, `.pocket-build/validation/link2-http-glue/${Date.now()}-${process.pid}`);

test("a response unread across a reconnect keeps its own bytes; the next request with the same wire id gets its own", () => {
  mkdirSync(scratch, { recursive: true });
  const shared = join(root, "engine/host-services");
  const binary = join(scratch, "http");
  const build = Bun.spawnSync(
    ["cc", "-std=gnu11", "-O1", "-g", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined",
      `-I${shared}`, `-I${join(root, "engine/worker/include")}`,
      join(root, "tests/fixtures/link2-http-harness.c"), join(shared, "link2_http.c"), join(shared, "jscan.c"), "-o", binary],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });
  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString().trimEnd().split("\n")).toEqual([
    "handles differ: yes",
    // B is handed B's head, B's 12 bytes and B's clean end.
    "B reads: HEADERS() DATA(BBBBBBBBBBBB) END(0,12)",
    // A keeps what arrived before the link dropped, then the end the drop gave it.
    "A reads: DATA(AAAAAAAA) END(-3,8)",
    // Nothing of A reached the new connection: no credit for its bytes and no CANCEL of its id.
    "consumed on the wire:",
    "cancels sent: 0",
    "cancels after both closed: 0",
  ]);
}, 120_000);
