// tools/targets/lock.ts — directory locks shared by every tool that writes the
// pocket-nexus cache, and publication by rename.
//
// A lock is a directory created with mkdir, holding owner.json. The owner
// refreshes its mtime while it runs; a lock whose owner process is gone on this
// host, or whose mtime is older than `staleMs`, is recovered.
//
// withSharedLock and withExclusiveLock add readers to a lock: a reader registers
// a file under `<lock>.readers/` while it holds the lock for a moment, and an
// exclusive holder waits until no live reader is registered. Builds hold an
// install record shared; `pocket target remove` holds it exclusive and waits.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface ArtifactLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly pollMs?: number;
}

export function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
}

function readOwner(file: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as {
      token?: unknown;
      pid?: unknown;
      hostname?: unknown;
    };
    return typeof value.token === "string" && Number.isInteger(value.pid) &&
        typeof value.hostname === "string"
      ? { token: value.token, pid: value.pid as number, hostname: value.hostname }
      : undefined;
  } catch {
    return undefined;
  }
}

function lockOwner(lock: string): LockOwner | undefined {
  return readOwner(join(lock, "owner.json"));
}

function ownerRecord(token: string): string {
  return JSON.stringify({ token, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }) + "\n";
}

function sameOwner(left: LockOwner | undefined, right: LockOwner | undefined): boolean {
  return !!left && !!right && left.token === right.token && left.pid === right.pid &&
    left.hostname === right.hostname;
}

function ownerCanBeRecovered(owner: LockOwner | undefined): boolean {
  if (!owner) return true;
  if (owner.hostname !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Serialize installers for one cached artifact. The heartbeat prevents a slow
 * cargo build from looking stale; abandoned locks are recovered after a bounded
 * age, and waiters always time out instead of hanging forever.
 */
export async function withArtifactLock<T>(
  lock: string,
  operation: () => Promise<T>,
  options: ArtifactLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const staleMs = options.staleMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 100;
  const started = Date.now();
  const token = uniqueSuffix();
  mkdirSync(dirname(lock), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(join(lock, "owner.json"), ownerRecord(token));
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const candidateOwner = lockOwner(lock);
        const ownerDiedOnThisHost = !!candidateOwner &&
          candidateOwner.hostname === hostname() &&
          ownerCanBeRecovered(candidateOwner);
        const ageExceeded = Date.now() - statSync(lock).mtimeMs > staleMs;
        if (ownerDiedOnThisHost || ageExceeded) {
          const quarantine = `${lock}.stale-${uniqueSuffix()}`;
          if ((ownerCanBeRecovered(candidateOwner) &&
              sameOwner(candidateOwner, lockOwner(lock))) ||
              (!candidateOwner && !lockOwner(lock))) {
            renameSync(lock, quarantine);
            rmSync(quarantine, { recursive: true, force: true });
            continue;
          }
        }
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") {
          // A competing waiter may have recovered it; retry until the deadline.
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`timed out waiting for artifact lock ${lock}`);
      }
      await Bun.sleep(pollMs);
    }
  }

  const heartbeatMs = Math.max(10, Math.min(30_000, Math.floor(staleMs / 3)));
  const heartbeat = setInterval(() => {
    if (lockOwner(lock)?.token !== token) return;
    const now = new Date();
    try {
      utimesSync(lock, now, now);
    } catch {
      // The finally block owns cleanup; a missing lock is handled there.
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    if (lockOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}

/** Holds `lock` shared for `operation`: other readers run alongside, an
 *  exclusive holder waits for it. */
export async function withSharedLock<T>(
  lock: string,
  operation: () => Promise<T>,
  options: ArtifactLockOptions = {},
): Promise<T> {
  const readers = `${lock}.readers`;
  const token = uniqueSuffix();
  const reader = join(readers, `${token}.json`);
  await withArtifactLock(lock, async () => {
    mkdirSync(readers, { recursive: true });
    writeFileSync(reader, ownerRecord(token));
  }, options);
  try {
    return await operation();
  } finally {
    rmSync(reader, { force: true });
  }
}

/** Holds `lock` exclusive for `operation`, after every live reader has left. */
export async function withExclusiveLock<T>(
  lock: string,
  operation: () => Promise<T>,
  options: ArtifactLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 100;
  return await withArtifactLock(lock, async () => {
    const readers = `${lock}.readers`;
    const started = Date.now();
    for (;;) {
      const live = existsSync(readers)
        ? readdirSync(readers).filter((name) => {
          const owner = readOwner(join(readers, name));
          if (owner && owner.hostname === hostname() && ownerCanBeRecovered(owner)) {
            rmSync(join(readers, name), { force: true });
            return false;
          }
          return true;
        })
        : [];
      if (live.length === 0) break;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`timed out waiting for ${live.length} reader(s) of ${lock}`);
      }
      await Bun.sleep(pollMs);
    }
    return await operation();
  }, options);
}

/** Publish a fully prepared directory without ever building inside the live root. */
export function publishStagedDirectory(staging: string, destination: string): void {
  if (!existsSync(staging)) throw new Error(`staged artifact is missing: ${staging}`);
  mkdirSync(dirname(destination), { recursive: true });
  const previous = `${destination}.previous-${uniqueSuffix()}`;
  const hadPrevious = existsSync(destination);
  if (hadPrevious) renameSync(destination, previous);
  try {
    renameSync(staging, destination);
  } catch (error) {
    if (hadPrevious && existsSync(previous) && !existsSync(destination)) {
      renameSync(previous, destination);
    }
    throw error;
  }
  if (hadPrevious) rmSync(previous, { recursive: true, force: true });
}
