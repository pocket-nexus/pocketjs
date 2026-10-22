import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import profile from "../profiles/vita.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { DeviceEvidence, fileSha256 } from "../tools/device-evidence.ts";
import { inspectDeviceLease, withDeviceLease } from "../tools/device-lease.ts";
import { inspectProgram, verifyBuildReceipt } from "../tools/doctor.ts";

const root = resolve(import.meta.dir, ".."), base = join(root, ".pocket-build/validation/doctor/tests");
mkdirSync(base, { recursive: true });
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(base, "case-")); temporary.push(path); return path; }
const selected = { profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION };

test("doctor refuses failed build receipts and mismatched targets or ABIs", () => {
  const directory = scratch(), artifact = join(directory, "app.self"), path = join(directory, "build-receipt.json");
  writeFileSync(artifact, "native fixture");
  const receipt = { schema: "pocket-runtime-build/1", success: true, target: profile.id,
    profileHash: selected.profileHash, hostAbi: selected.hostAbi, artifact,
    files: { "app.self": { bytes: 14, sha256: fileSha256(artifact) } } };
  const write = (change = {}) => writeFileSync(path, JSON.stringify({ ...receipt, ...change }));
  write(); verifyBuildReceipt(path, selected);
  for (const change of [{ success: false }, { target: "another-program" }, { hostAbi: 1 }]) {
    write(change); expect(() => verifyBuildReceipt(path, selected)).toThrow("unsuccessful or belongs");
  }
});

test("doctor reports unverified hardware, validates supplied identity, and detects a device swap", async () => {
  const directory = scratch(), expected = { device: "vita:fixture", runtimeBuild: "fixture-build", assets: { app: "a".repeat(64) } };
  const evidence = join(directory, "evidence.json"), identity = join(directory, "identity.json");
  const record = new DeviceEvidence(expected); record.observe(expected, { frames: 120 });
  writeFileSync(evidence, JSON.stringify(record.receipt())); writeFileSync(identity, JSON.stringify(expected));
  const absent = await inspectProgram({ target: "vita", from: root });
  expect(absent.checks.find(check => check.name === "device evidence")?.status).toBe("unverified");
  const accepted = await inspectProgram({ target: "vita", from: root, evidence, identity });
  expect(accepted.checks.find(check => check.name === "device evidence")?.status).toBe("ok");
  writeFileSync(identity, JSON.stringify({ ...expected, device: "vita:changed" }));
  expect((await inspectProgram({ target: "vita", from: root, evidence, identity })).ok).toBe(false);
  const invocation = Bun.spawnSync([process.execPath, "tools/cli/bin.mjs", "doctor", "--target", "vita", "--evidence", evidence, "--identity", identity, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(invocation.exitCode).toBe(1);
  expect(JSON.parse(invocation.stdout.toString()).checks.find((check: {name: string}) => check.name === "device evidence").status).toBe("fail");
});

test("lease inspection is read-only and observes the actual held OS lock", async () => {
  const directory = scratch(), device = "vita:doctor-fixture";
  expect(inspectDeviceLease(device, { directory })).toEqual({ state: "available", owner: null });
  await withDeviceLease(device, async lease => {
    const before = readFileSync(lease.environment.POCKET_DEVICE_LEASES ? JSON.parse(lease.environment.POCKET_DEVICE_LEASES)[device].path : "", "utf8");
    expect(inspectDeviceLease(device, { directory }).state).toBe("busy");
    expect(readFileSync(JSON.parse(lease.environment.POCKET_DEVICE_LEASES!)[device].path, "utf8")).toBe(before);
  }, { directory });
  expect(inspectDeviceLease(device, { directory }).state).toBe("available");
});
