import { expect, test } from "bun:test";
import { runOutOfTreeRust } from "../tools/test-out-of-tree-rust.ts";

test("a separate Rust product consumes a fixed git revision and exercises driver lifetimes", async () => {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  expect(head.success).toBe(true);
  const revision = head.stdout.toString().trim();
  const receipt = await runOutOfTreeRust();
  expect(receipt.revision).toBe(revision);
  expect(receipt.consumerOutsideRepository).toBe(true);
  expect(receipt.tests).toBe(6);
  expect(receipt.result).toBe("passed");
  expect(receipt.gitCrates.every(pkg => pkg.source.endsWith("#" + revision))).toBe(true);
  expect(receipt.directCrates).not.toContain("pocketjs-core");
}, 180_000);
