import { expect, test } from "bun:test";
import { runDriverKitConsumer } from "../tools/test-driver-kit.ts";

test("an independent Rust consumer exercises the candidate driver kit through public crates", async () => {
  const result = await runDriverKitConsumer();
  expect(result.consumerOutsideRepository).toBe(true);
  expect(result.tests).toBe(8);
  expect(result.result).toBe("passed");
}, 180_000);
