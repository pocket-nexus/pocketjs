import { expect, test } from "bun:test";
import { superviseCompanion, childRunning } from "../tools/ime/supervisor.ts";

test("USB supervisor retries absence and failed repair without overlapping or exiting", async () => {
  let passes = 0, active = 0, peak = 0;
  const statuses: string[] = [];
  await superviseCompanion({ stopped: () => passes === 5, wait: () => Promise.resolve(), status: s => statuses.push(s),
    async reconcile() {
      passes++; peak = Math.max(peak, ++active);
      await Promise.resolve(); active--;
      if (passes <= 2) throw new Error("disconnected");
      if (passes === 3) throw new Error("pairing unavailable");
    },
  });
  expect(passes).toBe(5); expect(peak).toBe(1);
  expect(statuses).toEqual(["Waiting for USB companion: disconnected", "Waiting for USB companion: pairing unavailable", "USB companion ready"]);
});


test("normal exits and signal exits both release a supervised child", async () => {
  expect(childRunning(undefined)).toBe(false);
  const normal = Bun.spawn([process.execPath, "-e", "process.exit(1)"]);
  await normal.exited; expect(childRunning(normal)).toBe(false);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    try {
      expect(childRunning(child)).toBe(true);
      child.kill(signal); await child.exited;
      expect(childRunning(child)).toBe(false);
    } finally { child.kill(); }
  }
});
