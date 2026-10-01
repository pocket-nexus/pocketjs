import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import manifestJson from "./cli/symbian-toolchain.json";
import { pocketNexusCacheRoot, withArtifactLock } from "./psp-toolchain.ts";

export interface PinnedDownload {
  readonly asset: string;
  readonly url: string;
  readonly sha256: string;
}

export interface SymbianToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly container: {
    readonly platform: "linux/amd64";
    readonly baseImage: string;
    readonly debianSnapshot: string;
    readonly debianSecuritySnapshot: string;
    readonly image: string;
    readonly volume: string;
    readonly signingVolume: string;
  };
  readonly gnupoc: PinnedDownload & {
    readonly repository: string;
    readonly rev: string;
  };
  readonly sdk: PinnedDownload & {
    readonly name: string;
    readonly extractRoot: string;
  };
  readonly gcce: PinnedDownload & {
    readonly version: string;
    readonly linuxArchive: string;
  };
  readonly qtSource: PinnedDownload & {
    readonly version: string;
    readonly extractRoot: string;
  };
  readonly quickjs: PinnedDownload & {
    readonly version: string;
    readonly repository: string;
    readonly rev: string;
  };
  readonly downloadsCachePath: string;
  readonly receipt: string;
  readonly signing: {
    readonly certificate: string;
    readonly privateKey: string;
    readonly legacyCertificate: string;
    readonly legacyPrivateKey: string;
  };
  readonly markers: readonly string[];
  readonly device: {
    readonly usbVendorId: string;
    readonly usbProductId: string;
    readonly mtpName: string;
    readonly deployStorage: string;
    readonly deployFolder: string;
  };
  readonly probe: {
    readonly uid: string;
    readonly output: string;
  };
  readonly runtime: {
    readonly sisVersion: string;
    readonly rustToolchain: string;
    readonly frameRate: number;
  };
}

export const SYMBIAN_TOOLCHAIN = manifestJson as unknown as SymbianToolchainManifest;
export const SYMBIAN_DOWNLOADS = [
  SYMBIAN_TOOLCHAIN.gnupoc,
  SYMBIAN_TOOLCHAIN.sdk,
  SYMBIAN_TOOLCHAIN.gcce,
  SYMBIAN_TOOLCHAIN.qtSource,
] as const;
export const SYMBIAN_RUNTIME_DOWNLOADS = [
  SYMBIAN_TOOLCHAIN.quickjs,
] as const;
export const SYMBIAN_SETUP_DOWNLOADS = [
  ...SYMBIAN_DOWNLOADS,
  ...SYMBIAN_RUNTIME_DOWNLOADS,
] as const;

interface HostCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type HostToolResolver = (tool: string) => string | null | undefined;
export type HostCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<HostCommandResult>;

export interface SymbianRustHostStatus {
  readonly cargo: boolean;
  readonly rustup: boolean;
  readonly pinnedToolchain: boolean;
  readonly rustSrc: boolean;
  readonly rustupPath?: string;
  readonly toolchainName?: string;
}

/**
 * Inspect only locally installed Rust state. Listing the installed toolchains
 * before `rustup run` avoids an implicit network sync when the pinned nightly
 * is absent.
 */
export async function inspectSymbianRustHost(
  resolveTool: HostToolResolver,
  run: HostCommandRunner,
): Promise<SymbianRustHostStatus> {
  const rustupPath = resolveTool("rustup") ?? undefined;
  const unavailable = {
    cargo: false,
    rustup: rustupPath !== undefined,
    pinnedToolchain: false,
    rustSrc: false,
    rustupPath,
  };
  if (!rustupPath) return unavailable;

  const listed = await run(rustupPath, ["toolchain", "list"]);
  if (listed.exitCode !== 0) return unavailable;
  const pin = SYMBIAN_TOOLCHAIN.runtime.rustToolchain;
  const toolchainName = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .find((name) => name === pin || name.startsWith(`${pin}-`));
  if (!toolchainName) return unavailable;

  const [cargo, components] = await Promise.all([
    run(rustupPath, ["run", toolchainName, "cargo", "--version"]),
    run(rustupPath, [
      "component",
      "list",
      "--toolchain",
      toolchainName,
      "--installed",
    ]),
  ]);
  return {
    cargo: cargo.exitCode === 0,
    rustup: true,
    pinnedToolchain: true,
    rustSrc: components.exitCode === 0 &&
      components.stdout.split(/\r?\n/).some((line) => line.trim() === "rust-src"),
    rustupPath,
    toolchainName,
  };
}

export async function withSymbianRuntimeBuildLock<T>(
  outputRoot: string,
  operation: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const output = resolve(outputRoot);
  const outputLockId = createHash("sha256").update(output).digest("hex");
  const outputLock = join(
    pocketNexusCacheRoot(env),
    `symbian/.locks/runtime-output-${outputLockId}.lock`,
  );
  return await withArtifactLock(outputLock, operation, {
    timeoutMs: 60 * 60_000,
    staleMs: 2 * 60 * 60_000,
  });
}

/**
 * Current tools/build.ts injects its STYLE_IDS module per build, but it also
 * keeps an ignored on-disk mirror for docs and older consumers. Serialize
 * Symbian callers so that mirror and any vendored legacy builder stay stable.
 */
export async function withSymbianGuestBuildLock<T>(
  operation: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const lock = join(
    pocketNexusCacheRoot(env),
    "symbian/.locks/guest-build.lock",
  );
  return await withArtifactLock(lock, operation, {
    timeoutMs: 60 * 60_000,
    staleMs: 2 * 60 * 60_000,
  });
}

export function symbianDownloadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POCKETJS_SYMBIAN_DOWNLOADS?.trim();
  if (explicit) return resolve(explicit);
  return join(pocketNexusCacheRoot(env), SYMBIAN_TOOLCHAIN.downloadsCachePath);
}

export function symbianDownloadPath(
  artifact: PinnedDownload,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(symbianDownloadsRoot(env), artifact.asset);
}

export interface SymbianReceipt {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly platform: string;
  readonly gnupocRev: string;
  readonly implementationSha256: string;
  readonly certificateSha256: string;
  readonly downloads: Readonly<Record<string, string>>;
  readonly markersSha256: Readonly<Record<string, string>>;
}

export function receiptMatchesSymbianManifest(
  receipt: unknown,
  implementationSha256?: string,
): receipt is SymbianReceipt {
  if (typeof receipt !== "object" || receipt === null) return false;
  const value = receipt as Partial<SymbianReceipt>;
  if (
    value.schemaVersion !== 1 ||
    value.toolchainVersion !== SYMBIAN_TOOLCHAIN.toolchainVersion ||
    value.platform !== SYMBIAN_TOOLCHAIN.container.platform ||
    value.gnupocRev !== SYMBIAN_TOOLCHAIN.gnupoc.rev ||
    !value.implementationSha256?.match(/^[a-f0-9]{64}$/) ||
    !value.certificateSha256?.match(/^[a-f0-9]{64}$/) ||
    (implementationSha256 !== undefined &&
      value.implementationSha256 !== implementationSha256) ||
    typeof value.downloads !== "object" ||
    value.downloads === null ||
    typeof value.markersSha256 !== "object" ||
    value.markersSha256 === null
  ) return false;
  return SYMBIAN_DOWNLOADS.every(
    (artifact) => value.downloads?.[artifact.asset] === artifact.sha256,
  ) && SYMBIAN_TOOLCHAIN.markers.every(
    (marker) => value.markersSha256?.[marker]?.match(/^[a-f0-9]{64}$/),
  );
}

const SYMBIAN_IMPLEMENTATION_FILES = [
  "tools/cli/symbian-toolchain.json",
  "tools/symbian/Dockerfile",
  "tools/symbian/Dockerfile.dockerignore",
  "tools/symbian/container/pocketjs-symbian-setup",
  "tools/symbian/container/pocketjs-symbian-doctor",
  "tools/symbian/container/pocketjs-symbian-build-probe",
  "tools/symbian/container/pocketjs-symbian-build-app",
  "tools/symbian/container/symbian-gcce-link",
  "tools/symbian/container/patches/makesis-openssl-1.1.patch",
  "tools/symbian/container/patches/makesis-openssl-1.1-pem-eof.patch",
  "tools/symbian/container/patches/quickjs-symbian-gcce.patch",
] as const;

export function symbianImplementationDigest(repository: string): string {
  const root = absoluteMount(repository, "repository");
  const hash = createHash("sha256");
  for (const relative of SYMBIAN_IMPLEMENTATION_FILES) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function localSymbianReceipt(path: string): SymbianReceipt | undefined {
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return receiptMatchesSymbianManifest(receipt) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

export interface SymbianDockerMounts {
  readonly repository: string;
  readonly output: string;
  readonly downloads?: string;
}

function absoluteMount(path: string, name: string): string {
  const value = resolve(path);
  if (!isAbsolute(value)) throw new Error(`${name} must resolve to an absolute path`);
  return value;
}

/**
 * Build one least-privilege Docker invocation. USB stays on the macOS host;
 * the container receives only the named toolchain volume and narrow binds.
 */
export function symbianDockerRunArguments(
  entrypoint: string,
  args: readonly string[],
  mounts: SymbianDockerMounts,
): string[] {
  const repository = absoluteMount(mounts.repository, "repository");
  const output = absoluteMount(mounts.output, "output");
  const implementation = symbianImplementationDigest(repository);
  const result = [
    "run",
    "--rm",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--network=none",
    "--env",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
    "--mount",
    `type=bind,src=${repository},dst=/workspace,readonly`,
    "--mount",
    `type=bind,src=${output},dst=/out`,
  ];
  if (mounts.downloads) {
    result.push(
      "--mount",
      `type=bind,src=${absoluteMount(mounts.downloads, "downloads")},dst=/downloads,readonly`,
    );
  }
  result.push(
    "--entrypoint",
    entrypoint,
    SYMBIAN_TOOLCHAIN.container.image,
    ...args,
  );
  return result;
}

export function symbianDockerBuildArguments(repository: string): string[] {
  const root = absoluteMount(repository, "repository");
  const implementation = symbianImplementationDigest(root);
  return [
    "build",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--progress=plain",
    "--build-arg",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--build-arg",
    `POCKETJS_SYMBIAN_BASE_IMAGE=${SYMBIAN_TOOLCHAIN.container.baseImage}`,
    "--build-arg",
    `POCKETJS_DEBIAN_SNAPSHOT=${SYMBIAN_TOOLCHAIN.container.debianSnapshot}`,
    "--build-arg",
    `POCKETJS_DEBIAN_SECURITY_SNAPSHOT=${SYMBIAN_TOOLCHAIN.container.debianSecuritySnapshot}`,
    "--build-arg",
    `POCKETJS_SYMBIAN_TOOLCHAIN_VERSION=${SYMBIAN_TOOLCHAIN.toolchainVersion}`,
    "--file",
    join(root, "tools/symbian/Dockerfile"),
    "--tag",
    SYMBIAN_TOOLCHAIN.container.image,
    root,
  ];
}

export function symbianDockerSetupArguments(downloads: string, repository: string): string[] {
  const implementation = symbianImplementationDigest(repository);
  return [
    "run",
    "--rm",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--network=none",
    "--env",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing`,
    "--mount",
    `type=bind,src=${absoluteMount(downloads, "downloads")},dst=/downloads,readonly`,
    "--entrypoint",
    "/usr/local/bin/pocketjs-symbian-setup",
    SYMBIAN_TOOLCHAIN.container.image,
  ];
}

export function symbianDockerDoctorArguments(repository: string): string[] {
  const implementation = symbianImplementationDigest(repository);
  return [
    "run",
    "--rm",
    `--platform=${SYMBIAN_TOOLCHAIN.container.platform}`,
    "--network=none",
    "--env",
    `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
    "--mount",
    `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
    "--entrypoint",
    "/usr/local/bin/pocketjs-symbian-doctor",
    SYMBIAN_TOOLCHAIN.container.image,
  ];
}

export function hasSymbianDownloads(env: NodeJS.ProcessEnv = process.env): boolean {
  return SYMBIAN_DOWNLOADS.every((artifact) => existsSync(symbianDownloadPath(artifact, env)));
}
