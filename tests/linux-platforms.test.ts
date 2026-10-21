import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runLinuxPlatformsTests } from "../tools/linux-platforms-test.ts";
import { loadRuntimeConfig } from "../tools/profile-resolver.ts";
const root = resolve(import.meta.dir, "..");
test("Linux program composition declares an external product profile and native Cargo artifact", async () => {
  const config = await loadRuntimeConfig(resolve(root, "programs/linux-kms/pocket.runtime-config.ts"));
  expect(config.profiles[0]!.id).toBe("product-linux-kms");
  expect(config.profiles[0]!.capabilities).not.toContain("audio.pcm");
  expect(config.value.build!.hosts).toEqual(["linux-arm64", "linux-x64"]);
  expect(config.value.build!.artifact).toBe("{outdir}/runtime");
  expect(config.value.build!.sourceInputs).toContain("../../engine/modules/media/src");
});
test("Linux drivers and file runtime honor buffers, events, profile identity and teardown", () => {
  const receipt = runLinuxPlatformsTests(resolve(root, ".pocket-build/validation/linux-build/test-" + process.pid));
  expect(receipt.commands.length).toBeGreaterThan(4);
}, 240_000);
