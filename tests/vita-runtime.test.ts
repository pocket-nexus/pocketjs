import { expect, test } from "bun:test";
import { resolve } from "node:path";
test("Vita production composition uses canonical instances and the pinned Bellard engine", async () => {
  const process = Bun.spawn(["bun", resolve(import.meta.dir, "../tools/test-vita-runtime.ts")], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  expect(exit, stderr).toBe(0);
  expect(process.signalCode).toBeNull();
  expect(stdout).toContain("3 passed; 0 failed");
}, 180_000);
