import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import manifestJson from "tools/cli/psp-toolchain.json";

export interface PspToolchainManifest {
  readonly schemaVersion: 1;
  readonly rust: {
    readonly toolchain: string;
    readonly components: readonly string[];
  };
  readonly rustPsp: { readonly repository: string; readonly rev: string };
  readonly quickJsRs: { readonly repository: string; readonly rev: string };
  readonly cargoPsp: {
    readonly package: string;
    readonly tools: readonly string[];
    readonly cachePath: string;
  };
  readonly sdk: {
    readonly repository: string;
    readonly tag: string;
    readonly asset: string;
    readonly url: string;
    readonly sha256: string;
    readonly marker: string;
    readonly receipt: string;
    readonly cachePath: string;
  };
}

export const PSP_TOOLCHAIN = manifestJson as PspToolchainManifest;

export const CARGO_PSP_RECEIPT = ".pocket-nexus-cargo-psp.json";

export function cargoHostTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "linux") return `${cpu}-unknown-linux-gnu`;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  return `${cpu}-unknown-${platform}`;
}

export interface ArtifactLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly pollMs?: number;
}

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
}

function lockOwner(lock: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as {
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
        writeFileSync(
          join(lock, "owner.json"),
          JSON.stringify({
            token,
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
          }) + "\n",
        );
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

export function pocketNexusCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKET_NEXUS_CACHE_DIR?.trim()) return resolve(env.POCKET_NEXUS_CACHE_DIR.trim());
  const cacheHome = env.XDG_CACHE_HOME?.trim()
    ? resolve(env.XDG_CACHE_HOME.trim())
    : join(env.HOME || homedir(), ".cache");
  return join(cacheHome, "pocket-nexus");
}

export function cachedPspSdk(env: NodeJS.ProcessEnv = process.env): string {
  return join(pocketNexusCacheRoot(env), PSP_TOOLCHAIN.sdk.cachePath);
}

export function cachedCargoPspRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(pocketNexusCacheRoot(env), PSP_TOOLCHAIN.cargoPsp.cachePath);
}

export function cachedCargoPspBin(env: NodeJS.ProcessEnv = process.env): string {
  return join(cachedCargoPspRoot(env), "bin");
}

function hasPinnedCargoPspMetadata(root: string): boolean {
  const expectedSource =
    `git+${PSP_TOOLCHAIN.rustPsp.repository}?rev=${PSP_TOOLCHAIN.rustPsp.rev}#${PSP_TOOLCHAIN.rustPsp.rev}`;
  try {
    const metadata = JSON.parse(readFileSync(join(root, ".crates2.json"), "utf8")) as {
      installs?: Record<string, { bins?: unknown; target?: unknown }>;
    };
    return Object.entries(metadata.installs ?? {}).some(([id, install]) => {
      const bins = install.bins;
      return id.startsWith(`${PSP_TOOLCHAIN.cargoPsp.package} `) &&
        id.includes(expectedSource) && Array.isArray(bins) &&
        install.target === cargoHostTriple() &&
        PSP_TOOLCHAIN.cargoPsp.tools.every((tool) => bins.includes(tool));
    });
  } catch {
    return false;
  }
}

function hasPinnedCargoPspReceipt(root: string): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(root, CARGO_PSP_RECEIPT), "utf8")) as {
      schemaVersion?: unknown;
      repository?: unknown;
      rev?: unknown;
      package?: unknown;
      tools?: unknown;
      host?: unknown;
    };
    const tools = receipt.tools;
    return receipt.schemaVersion === 1 &&
      receipt.repository === PSP_TOOLCHAIN.rustPsp.repository &&
      receipt.rev === PSP_TOOLCHAIN.rustPsp.rev &&
      receipt.package === PSP_TOOLCHAIN.cargoPsp.package &&
      receipt.host === cargoHostTriple() &&
      Array.isArray(tools) && PSP_TOOLCHAIN.cargoPsp.tools.length === tools.length &&
      PSP_TOOLCHAIN.cargoPsp.tools.every((tool) => tools.includes(tool));
  } catch {
    return false;
  }
}

export function writePinnedCargoPspReceipt(root: string): void {
  writeFileSync(
    join(root, CARGO_PSP_RECEIPT),
    JSON.stringify({
      schemaVersion: 1,
      repository: PSP_TOOLCHAIN.rustPsp.repository,
      rev: PSP_TOOLCHAIN.rustPsp.rev,
      package: PSP_TOOLCHAIN.cargoPsp.package,
      tools: PSP_TOOLCHAIN.cargoPsp.tools,
      host: cargoHostTriple(),
    }, null, 2) + "\n",
  );
}

export function hasPinnedCargoPspRoot(root: string): boolean {
  if (PSP_TOOLCHAIN.cargoPsp.tools.some((tool) => !existsSync(join(root, "bin", tool)))) return false;
  return hasPinnedCargoPspMetadata(root) || hasPinnedCargoPspReceipt(root);
}

export function hasPinnedCargoPspTools(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasPinnedCargoPspRoot(cachedCargoPspRoot(env));
}

export interface ResolvedPspSdk {
  readonly path: string;
  readonly source: "PSP_SDK" | "PSPDEV" | "cache";
}

/**
 * Resolve one SDK authority. An explicit override is never silently ignored:
 * a typo in PSP_SDK/PSPDEV must fail instead of falling through to a cache and
 * making the build appear to use a different SDK than the user requested.
 */
export function resolvePspSdk(env: NodeJS.ProcessEnv = process.env): ResolvedPspSdk {
  const explicit = env.PSP_SDK?.trim()
    ? { path: resolve(env.PSP_SDK.trim()), source: "PSP_SDK" as const }
    : env.PSPDEV?.trim()
      ? { path: resolve(env.PSPDEV.trim()), source: "PSPDEV" as const }
      : undefined;
  return explicit ?? { path: cachedPspSdk(env), source: "cache" };
}

export function pspSdkMarker(sdk: string): string {
  return join(sdk, PSP_TOOLCHAIN.sdk.marker);
}

export function hasPspSdk(sdk: string): boolean {
  return existsSync(pspSdkMarker(sdk));
}

export function pspSdkReceipt(sdk: string): string {
  return join(sdk, PSP_TOOLCHAIN.sdk.receipt);
}

export function hasVerifiedCachedPspSdk(env: NodeJS.ProcessEnv = process.env): boolean {
  const sdk = cachedPspSdk(env);
  if (!hasPspSdk(sdk)) return false;
  try {
    const receipt = JSON.parse(readFileSync(pspSdkReceipt(sdk), "utf8")) as Record<string, unknown>;
    return receipt.tag === PSP_TOOLCHAIN.sdk.tag &&
      receipt.asset === PSP_TOOLCHAIN.sdk.asset &&
      receipt.sha256 === PSP_TOOLCHAIN.sdk.sha256 &&
      receipt.url === PSP_TOOLCHAIN.sdk.url;
  } catch {
    return false;
  }
}

export function resolveLlvmBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.POCKETJS_LLVM_BIN?.trim()) {
    const explicit = resolve(env.POCKETJS_LLVM_BIN.trim());
    if (!existsSync(join(explicit, "clang")) || !existsSync(join(explicit, "llvm-ar"))) {
      throw new Error(
        `POCKETJS_LLVM_BIN points to ${explicit}, but clang and llvm-ar are required there`,
      );
    }
    return explicit;
  }
  for (const bin of ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"]) {
    if (existsSync(join(bin, "clang")) && existsSync(join(bin, "llvm-ar"))) return bin;
  }
  const clang = Bun.which("clang");
  const llvmAr = Bun.which("llvm-ar");
  if (clang && llvmAr && dirname(clang) === dirname(llvmAr)) return dirname(clang);
  return undefined;
}

export interface PspBuildToolchain {
  readonly manifest: PspToolchainManifest;
  readonly sdk: ResolvedPspSdk;
  readonly llvmBin: string;
  readonly rustup: string;
  readonly cargoPspBin: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function resolvePspBuildToolchain(env: NodeJS.ProcessEnv = process.env): PspBuildToolchain {
  const sdk = resolvePspSdk(env);
  const sdkReady = sdk.source === "cache" ? hasVerifiedCachedPspSdk(env) : hasPspSdk(sdk.path);
  if (!sdkReady) {
    const detail = sdk.source === "cache"
      ? `run \`bun run bootstrap\` to install and verify the pinned SDK at ${sdk.path}`
      : `${sdk.source} points to ${sdk.path}, but ${PSP_TOOLCHAIN.sdk.marker} is missing`;
    throw new Error(`PocketJS PSP SDK unavailable: ${detail}`);
  }

  const llvmBin = resolveLlvmBin(env);
  if (!llvmBin) {
    throw new Error(
      "PocketJS PSP LLVM unavailable: run `bun run bootstrap` (or set POCKETJS_LLVM_BIN)",
    );
  }

  const home = env.HOME || homedir();
  const rustup = Bun.which("rustup") ?? join(home, ".cargo", "bin", "rustup");
  if (!existsSync(rustup)) {
    throw new Error("PocketJS PSP rustup unavailable: install rustup, then run `bun run bootstrap`");
  }

  const cargoPspBin = cachedCargoPspBin(env);
  if (!hasPinnedCargoPspTools(env)) {
    throw new Error(
      "PocketJS PSP tools unavailable or not pinned to the manifest revision; run `bun run bootstrap`",
    );
  }

  return {
    manifest: PSP_TOOLCHAIN,
    sdk,
    llvmBin,
    rustup,
    cargoPspBin,
    environment: {
      ...env,
      PSP_SDK: sdk.path,
      PSPDEV: sdk.path,
      PATH: [cargoPspBin, llvmBin, join(home, ".cargo", "bin"), env.PATH]
        .filter(Boolean)
        .join(":"),
    },
  };
}
