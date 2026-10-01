import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type PinnedDownload,
  SYMBIAN_SETUP_DOWNLOADS,
  SYMBIAN_TOOLCHAIN,
  symbianDockerBuildArguments,
  symbianDockerSetupArguments,
  symbianDownloadPath,
  symbianDownloadsRoot,
  symbianImplementationDigest,
} from "./symbian-toolchain.ts";
import { pocketNexusCacheRoot, withArtifactLock } from "./psp-toolchain.ts";

const root = new URL("..", import.meta.url).pathname;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; quiet?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn({
    cmd: [command, ...args],
    cwd: options.cwd,
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    options.quiet ? new Response(process.stdout).text() : Promise.resolve(""),
    options.quiet ? new Response(process.stderr).text() : Promise.resolve(""),
  ]);
  return { exitCode, stdout, stderr };
}

async function verified(path: string, expected: string): Promise<boolean> {
  return existsSync(path) && await sha256File(path) === expected;
}

async function installDownload(artifact: PinnedDownload): Promise<"installed" | "cached"> {
  const destination = symbianDownloadPath(artifact);
  if (await verified(destination, artifact.sha256)) return "cached";
  const locks = join(symbianDownloadsRoot(), ".locks");
  return await withArtifactLock(
    join(locks, `${artifact.sha256}.lock`),
    async () => {
      if (await verified(destination, artifact.sha256)) return "cached";
      mkdirSync(dirname(destination), { recursive: true });
      const partial = `${destination}.partial-${artifact.sha256}`;
      console.log(`  downloading ${artifact.asset}`);
      const downloaded = await run("curl", [
        "-fL",
        "--retry",
        "3",
        "--continue-at",
        "-",
        "--output",
        partial,
        artifact.url,
      ]);
      if (downloaded.exitCode !== 0) throw new Error(`download failed: ${artifact.asset}`);
      const digest = await sha256File(partial);
      if (digest !== artifact.sha256) {
        rmSync(partial, { force: true });
        throw new Error(
          `${artifact.asset} SHA-256 mismatch: expected ${artifact.sha256}, got ${digest}`,
        );
      }
      renameSync(partial, destination);
      return "installed";
    },
    { timeoutMs: 30 * 60_000, staleMs: 2 * 60 * 60_000 },
  );
}

async function imageReady(): Promise<boolean> {
  const implementation = symbianImplementationDigest(root);
  const inspected = await run("docker", [
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.pocketjs.symbian.toolchain"}} {{index .Config.Labels "org.pocketjs.symbian.implementation"}}',
    SYMBIAN_TOOLCHAIN.container.image,
  ], { quiet: true });
  return inspected.exitCode === 0 &&
    inspected.stdout.trim() ===
      `${SYMBIAN_TOOLCHAIN.toolchainVersion} ${implementation}`;
}

export async function setupSymbianToolchain(): Promise<void> {
  if (!Bun.which("docker")) {
    throw new Error("Docker is required (OrbStack or Docker Desktop on macOS)");
  }
  if (!Bun.which("curl")) throw new Error("curl is required to fetch the pinned SDK inputs");
  if (!Bun.which("rustup")) {
    throw new Error("rustup is required to build the PocketJS Symbian core");
  }

  console.log(`PocketJS Symbian setup (${SYMBIAN_TOOLCHAIN.toolchainVersion})`);
  console.log(`  downloads: ${symbianDownloadsRoot()}`);
  console.log(`  platform: ${SYMBIAN_TOOLCHAIN.container.platform}\n`);

  const rust = await run("rustup", [
    "toolchain",
    "install",
    SYMBIAN_TOOLCHAIN.runtime.rustToolchain,
    "--profile",
    "minimal",
    "--component",
    "rust-src",
  ]);
  if (rust.exitCode !== 0) {
    throw new Error(
      `failed to install ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain} with rust-src`,
    );
  }
  console.log(
    `  ✓ Rust ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain} + rust-src`,
  );

  for (const artifact of SYMBIAN_SETUP_DOWNLOADS) {
    const status = await installDownload(artifact);
    console.log(`  ${status === "cached" ? "·" : "✓"} ${artifact.asset} (${status})`);
  }

  const setupLock = join(
    pocketNexusCacheRoot(),
    `symbian/.locks/toolchain-${SYMBIAN_TOOLCHAIN.toolchainVersion}.lock`,
  );
  await withArtifactLock(setupLock, async () => {
    if (await imageReady()) {
      console.log(`  · Docker image ${SYMBIAN_TOOLCHAIN.container.image} (cached)`);
    } else {
      const built = await run("docker", symbianDockerBuildArguments(root), { cwd: root });
      if (built.exitCode !== 0) {
        throw new Error("failed to build the pinned Symbian container");
      }
      console.log(`  ✓ Docker image ${SYMBIAN_TOOLCHAIN.container.image}`);
    }

    for (const volumeName of [
      SYMBIAN_TOOLCHAIN.container.volume,
      SYMBIAN_TOOLCHAIN.container.signingVolume,
    ]) {
      const volume = await run("docker", [
        "volume",
        "inspect",
        volumeName,
      ], { quiet: true });
      if (volume.exitCode !== 0) {
        const created = await run("docker", [
          "volume",
          "create",
          volumeName,
        ], { quiet: true });
        if (created.exitCode !== 0) {
          throw new Error(`failed to create the Symbian volume ${volumeName}`);
        }
        console.log(`  ✓ Docker volume ${volumeName}`);
      } else {
        console.log(`  · Docker volume ${volumeName} (cached)`);
      }
    }

    const installed = await run(
      "docker",
      symbianDockerSetupArguments(symbianDownloadsRoot(), root),
      { cwd: root },
    );
    if (installed.exitCode !== 0) {
      throw new Error("containerized Symbian SDK setup failed");
    }
  }, { timeoutMs: 3 * 60 * 60_000, staleMs: 4 * 60 * 60_000 });
}

if (import.meta.main) {
  try {
    await setupSymbianToolchain();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
