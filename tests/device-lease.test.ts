import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { withDeviceLease } from "../tools/device-lease";
const directory = mkdtempSync(join(tmpdir(), "pocket-lease-"));
const fixture = join(import.meta.dir, "fixtures/device-lease-child.ts");
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("independent processes contend; nested child inherits ownership; exceptions release it", async () => {
  await expect(withDeviceLease("psp:usb", async lease => {
    const blocked = Bun.spawnSync(["bun", fixture, directory, "psp:usb", "probe"], { env: { ...process.env, POCKET_DEVICE_LEASES: "{}" } });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString()).toContain("Device busy");
    const nested = Bun.spawnSync(["bun", fixture, directory, "psp:usb", "probe"], { env: lease.environment });
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout.toString()).toContain("held");
    lease.assertHeld();
    throw new Error("test interruption");
  }, { directory })).rejects.toThrow("test interruption");
  await withDeviceLease("psp:usb", async lease => lease.assertHeld(), { directory });
});

test("a killed owner releases the kernel lock without deleting an inode or stealing another lease", async () => {
  const child = Bun.spawn(["bun", fixture, directory, "vita:usb", "hold"], { env: { ...process.env, POCKET_DEVICE_LEASES: "{}" }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("held");
    reader.releaseLock();
    await expect(withDeviceLease("vita:usb", async () => {}, { directory })).rejects.toThrow("Device busy");
  } finally { child.kill("SIGKILL"); await child.exited; }
  await withDeviceLease("vita:usb", async lease => lease.assertHeld(), { directory });
});

test("parallel callers cannot adopt each other's async context", async () => {
  let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const first = withDeviceLease("3ds:test", async () => wait, { directory });
  try { await expect(withDeviceLease("3ds:test", async () => {}, { directory })).rejects.toThrow("Device busy"); }
  finally { release(); await first; }
});

test("captured child tokens expire at end of the enclosing run", async () => {
  let environment: NodeJS.ProcessEnv = {};
  await withDeviceLease("psp:usb", async lease => { environment = lease.environment; }, { directory });
  const expired = Bun.spawnSync(["bun", fixture, directory, "psp:usb", "probe"], { env: environment });
  expect(expired.exitCode).not.toBe(0);
  expect(expired.stderr.toString()).toContain("expired");
});

test("guarded CLIs terminate when their owning wrapper is killed", async () => {
  const key = `test:guard:${randomUUID()}`;
  const tool = join(import.meta.dir, "../tools/device-lease.ts");
  const child = Bun.spawn([process.execPath, tool, key, "--", process.execPath, fixture, "unused", key, "guard"],
    { env: { ...process.env, POCKET_DEVICE_LEASES: "{}" }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("guarded");
    reader.releaseLock();
    child.kill("SIGKILL"); await child.exited;
    // The inherited child keeps stderr open until its watchdog rejects the dead owner.
    const error = await Promise.race([new Response(child.stderr).text(), Bun.sleep(3000).then(() => "timeout")]);
    expect(error).not.toBe("timeout");
    expect(error).toMatch(/parent exited|no live OS owner/);
    await withDeviceLease(key, async lease => lease.assertHeld());
  } finally { child.kill("SIGKILL"); await child.exited; }
});
