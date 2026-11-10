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
  [16, "a link that drops with a screenshot's last bytes or its reply waiting ends the capture"],
  [6, "a push reply that waits for room is not overwritten by a screenshot's head"],
  [14, "a screenshot head over the payload limit is answered, not held for good"],
  [15, "a push committed with the send buffer nearly full keeps its own reply"],
  [9, "a DevTools line longer than a line may be is dropped and the stream keeps its credit"],
  [25, "a device.txt that cannot be read for one reload keeps the device's id"],
  [26, "a key file of 696 bytes loads; a device.txt that holds no id is kept and reported"],
  [32, "a link directory whose parent is missing is created with its device.txt"],
  [11, "forgetting another pairing while linked keeps the linked Hub in the status"],
  [12, "a ready whose clock is past 2^53 ms is refused"],
  [36, "event units past what a u32 holds close the link with flow"],
  [23, "the CANCEL of a dropped group's request leaves before the features event"],
  [28, "a features change that waited for its second is in the next hello after a reconnect"],
  [35, "a features change between hello and ready goes out as a features event"],
  [40, "the agent's streams of a dropped group are RESET ahead of the features event"],
  [4, "an accepting REPLY that crosses the CANCEL of channel.open leaves the channel bytes at 0"],
  [18, "link2_event_stream gives no id when its event fits no frame"],
  [20, "a devtools.open that got no answer is asked for again on the connection"],
  [27, "bytes of a net.http request the worker cancelled do not reach the worker"],
  [29, "a stream the host accepted and the client has no place for gets stream_end"],
  [31, "ids used up: the link closes with going_away and the next one starts at 1"],
  [33, "an applet that exits with channel.open unanswered frees the channel's place at once"],
  [34, "no memory for a channel's queue: the open backs off as after busy"],
  [41, "after its own overflow close the device opens the channel again when the applet uses it"],
  [24, "a RESET that finds the send buffer full leaves when there is room"],
  [30, "a CLOSE whose reason does not fit the reserve leaves with its code alone"],
  [37, "frames of an unknown type count for the 10 s rule"],
  [38, "a beacon socket that fails is opened again"],
  [39, "an apps report that waits for room does not ask the host for its rows at every pump"],
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
