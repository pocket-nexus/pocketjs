// Scenarios against the Pocket Link 2 C client (engine/host-services/link2.c)
// on an in-process socket and clock (tests/fixtures/link2-sim.h), built under
// ASan and UBSan. Each came from a finding of the independent review of the
// client; a scenario fails when the client still shows the defect.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const shared = join(root, "engine/host-services");

let scratch = "";
let binary = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "link2-scenarios-"));
  binary = join(scratch, "link2-scenarios");
  const build = Bun.spawnSync(
    [
      "cc", "-std=gnu11", "-O1", "-g", "-Wall", "-Wextra", "-Wno-unused-function", "-Wno-unused-variable",
      "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined",
      `-I${shared}`, `-I${join(root, "tests/fixtures")}`,
      join(root, "tests/fixtures/link2-scenarios.c"), join(shared, "link2_proto.c"), join(shared, "sha256.c"), join(shared, "jscan.c"),
      "-o", binary,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode, build.stderr.toString()).toBe(0);
}, 120_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A scenario's number in link2-scenarios.c and the finding it guards. */
const SCENARIOS: [number, string][] = [
  [7, "a host callback inside an open frame logs: the stream stays well formed"],
  [107, "the same with the send buffer nearly full: the tail stays inside the buffer"],
  [8, "a worker that retries from http_end at a teardown leaves no request behind"],
  [1, "requests of 8,000 bytes withdrawn by CANCEL leave a paused guest's queue: no overflow"],
  [101, "the same with 3,000 requests of 9 bytes"],
  [2, "an empty response whose END comes before the guest takes the head event: its read ends"],
  [3, "48 progress events without a name return their units"],
  [5, "a request stalled 30 s whose CANCEL Hub answers before the guest polls still reports timeout"],
  [10, "a request the guest cancelled and Hub never answered reports cancelled after the grace"],
  [13, "replies over LINK_APP_MSG are not kept whole: the guest gets too_large"],
];

describe("the C client under the review's scenarios", () => {
  for (const [number, name] of SCENARIOS) {
    test(`${number}: ${name}`, () => {
      const run = Bun.spawnSync([binary, String(number)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LINK2_SIM_DIR: scratch } });
      const out = run.stdout.toString() + run.stderr.toString();
      expect(run.exitCode, out).toBe(0);
      expect(out).not.toContain("REPRODUCED");
      expect(out).not.toContain("FINDING");
      expect(out).toContain("not reproduced");
    }, 60_000);
  }
});
