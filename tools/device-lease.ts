/** Cooperative device ownership across repositories/worktrees on one host. Bun on macOS/Linux. */
import { dlopen, FFIType } from "bun:ffi";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ENV = "POCKET_DEVICE_LEASES";
type Owner = { device: string; token: string; pid: number; cwd: string; startedAt: string; active: boolean };
type Inherited = Record<string, { token: string; path: string }>;
const contexts = new AsyncLocalStorage<Inherited>();
export interface DeviceLease {
  device: string;
  owner: Owner;
  environment: NodeJS.ProcessEnv;
  /** Call before mutations/observations; detects replaced lock files and expired parent sessions. */
  assertHeld(): void;
}
let native: ReturnType<typeof openNative> | undefined;
function openNative() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Device leases require macOS/Linux flock; this host cannot claim exclusive ownership");
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}
function readOwner(path: string): Owner | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function inherited(): Inherited {
  const local = contexts.getStore();
  if (local) return local;
  try { return JSON.parse(process.env[ENV] ?? "{}"); } catch { throw new Error("Invalid inherited device lease context"); }
}

export async function withDeviceLease<T>(device: string, run: (lease: DeviceLease) => Promise<T>, options: { directory?: string } = {}): Promise<T> {
  if (!/^[a-z0-9][a-z0-9:._-]{0,199}$/.test(device)) throw new Error("Invalid canonical device key");
  const directory = resolve(options.directory ?? join(homedir(), ".pocketjs/device-leases"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, createHash("sha256").update(device).digest("hex") + ".json");
  const context = inherited();
  const parent = context[device];
  if (parent) {
    if (parent.path !== path) throw new Error("Inherited device lease directory mismatch");
    const owner = readOwner(path);
    const assertHeld = () => {
      const current = readOwner(path);
      if (!current?.active || current.token !== parent.token || current.device !== device || current.pid !== owner?.pid)
        throw new Error(`Device lease expired or changed: ${device}`);
      try { process.kill(current.pid, 0); } catch { throw new Error(`Device lease parent exited: ${device}`); }
      native ??= openNative();
      const probe = openSync(path, "a+", 0o600);
      const unlocked = native.symbols.flock(probe, 2 | 4) === 0;
      if (unlocked) native.symbols.flock(probe, 8);
      closeSync(probe);
      if (unlocked) throw new Error(`Device lease has no live OS owner: ${device}`);
    };
    assertHeld();
    return run({ device, owner: owner!, environment: { ...process.env, [ENV]: JSON.stringify(context) }, assertHeld });
  }
  native ??= openNative();
  // Never unlink this file: flock is tied to the inode. A crash releases the OS lock.
  const fd = openSync(path, "a+", 0o600);
  if (native.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    const held = readOwner(path);
    throw new Error(`Device busy: ${device}; owner pid=${held?.pid ?? "starting"} cwd=${held?.cwd ?? "unknown"}`);
  }
  const owner: Owner = { device, token: randomUUID(), pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString(), active: true };
  const writeOwner = () => { ftruncateSync(fd, 0); writeSync(fd, JSON.stringify(owner) + "\n"); };
  const inode = fstatSync(fd);
  const assertHeld = () => {
    const current = readOwner(path);
    const stat = statSync(path);
    if (!current?.active || current.token !== owner.token || stat.ino !== inode.ino || stat.dev !== inode.dev)
      throw new Error(`Device lease replaced: ${device}`);
  };
  try {
    writeOwner();
    const active = { ...context, [device]: { token: owner.token, path } };
    assertHeld();
    return await contexts.run(active, () => run({ device, owner, environment: { ...process.env, [ENV]: JSON.stringify(active) }, assertHeld }));
  } finally {
    owner.active = false;
    try { writeOwner(); } finally { native.symbols.flock(fd, 8); closeSync(fd); }
  }
}

/** At a CLI entry, re-exec under an owning parent; its existing child commands inherit the lease. */
export async function guardDeviceCommand(device: string): Promise<DeviceLease> {
  if (inherited()[device]) return withDeviceLease(device, async lease => {
    // A killed owning wrapper must not leave its CLI running indefinitely.
    // Mutating call sites should also assert immediately before each operation.
    setInterval(() => {
      try { lease.assertHeld(); }
      catch (error) { console.error(String(error)); process.exit(70); }
    }, 250).unref();
    return lease;
  });
  let code = 1;
  await withDeviceLease(device, async lease => {
    const child = Bun.spawn(Bun.argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: lease.environment });
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try { code = await child.exited; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  });
  process.exit(code);
}

/** Wrap a whole acceptance run, including its child CLI commands, under one lease. */
if (import.meta.main) {
  const [device, separator, ...command] = process.argv.slice(2);
  if (!device || separator !== "--" || !command.length) throw new Error("usage: bun tools/device-lease.ts <device-key> -- <command> [args]");
  await withDeviceLease(device, async lease => {
    const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: lease.environment });
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    try { process.exitCode = await child.exited; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  });
}
