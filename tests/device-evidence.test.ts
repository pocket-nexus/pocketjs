import { expect, test } from "bun:test";
import { DeviceEvidence } from "../tools/device-evidence";
const expected = { device: "3ds:unit", runtimeBuild: "build-a", assets: { place: "a".repeat(64) } };
test("device and runtime swaps invalidate the entire measurement window", () => {
  const record = new DeviceEvidence<{ frame: number }>(expected);
  record.observe(expected, { frame: 100 });
  for (const changed of [ { ...expected, device: "3ds:other" }, { ...expected, runtimeBuild: "build-b" } ])
    expect(() => record.observe(changed, { frame: 200 })).toThrow("changed");
  expect(record.receipt().observations).toHaveLength(1);
  const receipt = record.receipt(); receipt.observations[0].value.frame = 0;
  expect(record.receipt().observations[0].value.frame).toBe(100);
});
