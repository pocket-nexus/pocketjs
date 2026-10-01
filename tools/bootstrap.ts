// PocketJS-owned, idempotent PSP setup. A fresh clone must not need DreamCart,
// sibling source checkouts, or unpinned tools to produce an EBOOT.

import { $ } from "bun";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  PSP_TOOLCHAIN,
  cachedCargoPspBin,
  cachedCargoPspRoot,
  cachedPspSdk,
  hasPspSdk,
  hasPinnedCargoPspRoot,
  hasPinnedCargoPspTools,
  hasVerifiedCachedPspSdk,
  pocketNexusCacheRoot,
  publishStagedDirectory,
  pspSdkReceipt,
  resolveLlvmBin,
  resolvePspSdk,
  withArtifactLock,
  writePinnedCargoPspReceipt,
} from "./psp-toolchain.ts";

const root = new URL("..", import.meta.url).pathname;
const home = process.env.HOME ?? "";
const cacheRoot = pocketNexusCacheRoot();
const cachedSdk = cachedPspSdk();
const sdkResolution = resolvePspSdk();
const sdk = sdkResolution.path;
const cargoPspRoot = cachedCargoPspRoot();
const cargoPspBin = cachedCargoPspBin();
const archive = join(cacheRoot, "downloads", `psp-sdk-${PSP_TOOLCHAIN.sdk.sha256}.zip`);
const rustup = Bun.which("rustup") ?? (home && existsSync(join(home, ".cargo/bin/rustup"))
  ? join(home, ".cargo/bin/rustup")
  : undefined);

type Status = "ok" | "skip" | "fail";
const results: Array<{ name: string; status: Status; note?: string }> = [];
function record(name: string, status: Status, note?: string): void {
  const icon = status === "ok" ? "✓" : status === "skip" ? "·" : "✗";
  console.log(`  ${icon} ${name}${note ? ` — ${note}` : ""}`);
  results.push({ name, status, note });
}

async function run(command: ReturnType<typeof $>): Promise<boolean> {
  return (await command.nothrow()).exitCode === 0;
}

async function output(command: ReturnType<typeof $>): Promise<string> {
  return await command.nothrow().quiet().text();
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function installSdk(): Promise<boolean> {
  if (sdkResolution.source !== "cache") {
    if (hasPspSdk(sdk)) {
      record("PSP SDK", "skip", `${sdkResolution.source}=${sdk}`);
      return true;
    }
    record(
      "PSP SDK",
      "fail",
      `${sdkResolution.source}=${sdk} does not contain ${PSP_TOOLCHAIN.sdk.marker}`,
    );
    return false;
  }
  if (hasVerifiedCachedPspSdk()) {
    record("PSP SDK", "skip", sdk);
    return true;
  }

  try {
    mkdirSync(dirname(archive), { recursive: true });
    await withArtifactLock(
      join(cacheRoot, "psp", ".locks", `sdk-download-${PSP_TOOLCHAIN.sdk.sha256}.lock`),
      async () => {
        if (existsSync(archive) && await sha256File(archive) === PSP_TOOLCHAIN.sdk.sha256) return;
        const temporaryArchive = `${archive}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
        rmSync(temporaryArchive, { force: true });
        console.log(`  downloading ${PSP_TOOLCHAIN.sdk.asset} (${PSP_TOOLCHAIN.sdk.tag})`);
        try {
          if (!await run($`curl -fL --retry 3 -o ${temporaryArchive} ${PSP_TOOLCHAIN.sdk.url}`)) {
            throw new Error("download failed");
          }
          const digest = await sha256File(temporaryArchive);
          if (digest !== PSP_TOOLCHAIN.sdk.sha256) {
            throw new Error(`SHA-256 mismatch (${digest})`);
          }
          // A verified file replaces any corrupt cache entry in one rename.
          renameSync(temporaryArchive, archive);
        } finally {
          rmSync(temporaryArchive, { force: true });
        }
      },
    );

    const installed = await withArtifactLock(
      join(cacheRoot, "psp", ".locks", `sdk-${PSP_TOOLCHAIN.sdk.sha256}.lock`),
      async () => {
        if (hasVerifiedCachedPspSdk()) return false;
        const staging = `${cachedSdk}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`;
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true });
        try {
          if (!await run($`unzip -q -o ${archive} -d ${staging}`)) {
            throw new Error("unzip failed (install `unzip` and retry)");
          }
          const extracted = hasPspSdk(join(staging, "mipsel-sony-psp"))
            ? join(staging, "mipsel-sony-psp")
            : hasPspSdk(staging)
              ? staging
              : undefined;
          if (!extracted) {
            throw new Error(`archive does not contain ${PSP_TOOLCHAIN.sdk.marker}`);
          }
          writeFileSync(
            pspSdkReceipt(extracted),
            JSON.stringify({
              tag: PSP_TOOLCHAIN.sdk.tag,
              asset: PSP_TOOLCHAIN.sdk.asset,
              url: PSP_TOOLCHAIN.sdk.url,
              sha256: PSP_TOOLCHAIN.sdk.sha256,
            }, null, 2) + "\n",
          );
          publishStagedDirectory(extracted, cachedSdk);
          return true;
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      },
    );
    record("PSP SDK", installed ? "ok" : "skip", `${sdk} (SHA-256 verified)`);
    return true;
  } catch (error) {
    record("PSP SDK", "fail", error instanceof Error ? error.message : String(error));
    return false;
  }
}

console.log(`PocketJS PSP bootstrap\n  cache: ${cacheRoot}\n`);

console.log("dependencies:");
record("bun install", await run($`bun install --frozen-lockfile`.cwd(root)) ? "ok" : "fail");

console.log("LLVM:");
let llvmBin: string | undefined;
let invalidLlvmOverride = false;
try {
  llvmBin = resolveLlvmBin();
} catch (error) {
  invalidLlvmOverride = true;
  record("LLVM", "fail", error instanceof Error ? error.message : String(error));
}
if (!invalidLlvmOverride) {
  if (llvmBin) record("LLVM", "skip", llvmBin);
  else if (process.platform === "darwin" && Bun.which("brew")) {
    const installed = await run($`brew install llvm`);
    llvmBin = resolveLlvmBin();
    record("LLVM", installed && llvmBin ? "ok" : "fail", llvmBin ?? "Homebrew install failed");
  } else {
    record("LLVM", "fail", "install clang + llvm-ar, or set POCKETJS_LLVM_BIN");
  }
}

console.log("Rust:");
if (!rustup) {
  record("rustup", "fail", "install from https://rustup.rs, then re-run");
} else {
  let toolchains = await output($`${rustup} toolchain list`);
  const hadStable = /^stable(?:-|\s)/m.test(toolchains);
  const stable = hadStable || await run($`${rustup} toolchain install stable --profile minimal`);
  const installedTargets = stable
    ? await output($`${rustup} target list --installed --toolchain stable`)
    : "";
  const hadWasm = installedTargets.split(/\s+/).includes("wasm32-unknown-unknown");
  const wasm = hadWasm || await run($`${rustup} target add wasm32-unknown-unknown --toolchain stable`);
  record("Rust stable + wasm32-unknown-unknown", stable && wasm ? (hadStable && hadWasm ? "skip" : "ok") : "fail");

  toolchains = await output($`${rustup} toolchain list`);
  const hadNightly = toolchains.includes(PSP_TOOLCHAIN.rust.toolchain);
  const components = hadNightly
    ? await output($`${rustup} component list --toolchain ${PSP_TOOLCHAIN.rust.toolchain}`)
    : "";
  const hadRustSrc = /rust-src.*\(installed\)/.test(components);
  const installed = hadNightly
    ? hadRustSrc || await run(
        $`${rustup} component add rust-src --toolchain ${PSP_TOOLCHAIN.rust.toolchain}`,
      )
    : await run(
        $`${rustup} toolchain install ${PSP_TOOLCHAIN.rust.toolchain} --profile minimal --component rust-src`,
      );
  record(
    `Rust ${PSP_TOOLCHAIN.rust.toolchain} + rust-src`,
    installed ? (hadNightly && hadRustSrc ? "skip" : "ok") : "fail",
  );
}

console.log("cargo-psp tools:");
if (hasPinnedCargoPspTools()) {
  record("pinned cargo-psp tools", "skip", PSP_TOOLCHAIN.rustPsp.rev);
} else if (!rustup) {
  record("pinned cargo-psp tools", "fail", "rustup unavailable");
} else {
  try {
    const installed = await withArtifactLock(
      join(cacheRoot, "psp", ".locks", `cargo-psp-${PSP_TOOLCHAIN.rustPsp.rev}.lock`),
      async () => {
        if (hasPinnedCargoPspTools()) return false;
        const staging = `${cargoPspRoot}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`;
        rmSync(staging, { recursive: true, force: true });
        try {
          const built = await run(
            $`${rustup} run ${PSP_TOOLCHAIN.rust.toolchain} cargo install --git ${PSP_TOOLCHAIN.rustPsp.repository} --rev ${PSP_TOOLCHAIN.rustPsp.rev} --locked --root ${staging} ${PSP_TOOLCHAIN.cargoPsp.package}`,
          );
          if (!built || !hasPinnedCargoPspRoot(staging)) {
            throw new Error("cargo install did not produce the pinned host tools");
          }
          writePinnedCargoPspReceipt(staging);
          publishStagedDirectory(staging, cargoPspRoot);
          return true;
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      },
    );
    record(
      "pinned cargo-psp tools",
      installed ? "ok" : "skip",
      PSP_TOOLCHAIN.rustPsp.rev,
    );
  } catch (error) {
    record(
      "pinned cargo-psp tools",
      "fail",
      error instanceof Error ? error.message : String(error),
    );
  }
}

console.log("SDK:");
await installSdk();

if (hasPspSdk(sdk)) {
  const envFile = join(cacheRoot, "psp", "env.sh");
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(
    envFile,
    `# Generated by PocketJS tools/bootstrap.ts\n` +
      `export PSP_SDK=${JSON.stringify(sdk)}\n` +
      `export PSPDEV=${JSON.stringify(sdk)}\n` +
      `export PATH=${JSON.stringify(`${cargoPspBin}:${llvmBin ?? ""}:$PATH`)}\n`,
  );
  console.log(`\n  shell env (optional): source ${envFile}`);
  console.log(`  PSP_SDK=${sdk}`);
  console.log(`  PSPDEV=${sdk}`);
}

const failed = results.filter((result) => result.status === "fail");
if (failed.length > 0) {
  console.error(`\nPocketJS bootstrap incomplete: ${failed.map((item) => item.name).join(", ")}`);
  process.exit(1);
}
console.log("\nPocketJS PSP toolchain ready. Try: bun run psp hero --release");
