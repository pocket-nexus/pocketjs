import { expect, test } from "bun:test";
import { assertDeviceIdentity, DeviceEvidence } from "../tools/device-evidence";
const expected = { device: "3ds:unit", runtimeBuild: "build-a", assets: { place: "a".repeat(64) } };
test("device, runtime and pack swaps invalidate the entire measurement window", () => {
  const record = new DeviceEvidence<{ frame: number }>(expected);
  record.observe(expected, { frame: 100 });
  for (const changed of [ { ...expected, device: "3ds:other" }, { ...expected, runtimeBuild: "build-b" }, { ...expected, assets: { place: "b".repeat(64) } } ])
    expect(() => record.observe(changed, { frame: 200 })).toThrow("changed");
  expect(record.receipt().observations).toHaveLength(1);
  const receipt = record.receipt(); receipt.observations[0].value.frame = 0;
  expect(record.receipt().observations[0].value.frame).toBe(100);
});
test("identity comparison normalizes resource order and rejects missing or malformed hashes", () => {
  const a = { ...expected, assets: { a: "a".repeat(64), b: "b".repeat(64) } };
  assertDeviceIdentity(a, { ...expected, assets: { b: "b".repeat(64), a: "a".repeat(64) } });
  expect(() => new DeviceEvidence({ ...expected, assets: {} })).toThrow("identities");
  expect(() => new DeviceEvidence({ ...expected, assets: { place: "not-a-hash" } })).toThrow("Invalid asset");
});
