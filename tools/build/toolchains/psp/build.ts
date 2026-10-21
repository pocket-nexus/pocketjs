// tools/build/toolchains/psp/build.ts — the PSP build environment, read from the toolchain
// `pocket target add psp` installed for this framework's pins
// (tools/build/toolchains/psp.ts). The generated C guest also needs an LLVM
// host compiler with a MIPS backend, selected through POCKETJS_LLVM_BIN.
//
// QuickJS is the PSP host's one C dependency. libquickjs-sys links the
// prebuilt archive QUICKJS_PREBUILT_LIB names, which pocket-nexus/quickjs-rs
// publishes from the revision hosts/psp/Cargo.toml pins. The generated guest
// bridge compiles against that revision's header.

import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { catalogEntry } from "../../../targets/index.ts";
import { requireToolchain, ToolchainError } from "../../../targets/store.ts";
import type { FileComponent } from "../../../targets/toolchain.ts";

export interface PspBuildToolchain {
  /** The rustup toolchain cargo-psp builds with. */
  readonly rustToolchain: string;
  readonly rustup: string;
  /** The PSP SDK: headers and the libraries the EBOOT links. */
  readonly sdk: string;
  readonly cargoPspBin: string;
  /** The prebuilt QuickJS archive. */
  readonly quickjs: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function resolvePspBuildToolchain(env: NodeJS.ProcessEnv = process.env): PspBuildToolchain {
  const descriptor = catalogEntry("psp")!;
  const toolchain = requireToolchain(descriptor, { env })!;
  if (!toolchain.rustup) throw new ToolchainError("the PSP build needs rustup; install it from https://rustup.rs");
  const quickjsFile = descriptor.toolchain!.components.find((component): component is FileComponent =>
    component.name === "quickjs" && component.kind === "file")!.file;
  const sdk = toolchain.path("sdk");
  const cargoPspBin = join(toolchain.path("cargo-psp"), "bin");
  const quickjs = join(toolchain.path("quickjs"), quickjsFile);
  const rustToolchain = toolchain.toolchain("rust");
  const metadata = Bun.spawnSync([toolchain.rustup, "run", rustToolchain, "cargo", "metadata", "--locked", "--format-version=1", "--manifest-path", resolve(import.meta.dir, "../../../../hosts/psp/Cargo.toml")], { env, stdout: "pipe", stderr: "pipe" });
  if (!metadata.success) throw new ToolchainError(`PSP QuickJS source lookup failed: ${metadata.stderr.toString()}`);
  const packages = JSON.parse(metadata.stdout.toString()).packages as {name: string; manifest_path: string; source: string | null; dependencies: { name: string; source: string | null }[]}[];
  const source = packages.find(p => p.name === "pocketjs-psp")?.dependencies.find(d => d.name === "libquickjs-sys")?.source;
  const dependency = source ? packages.find(p => p.name === "libquickjs-sys" && p.source?.startsWith(`${source}#`)) : undefined;
  if (!dependency) throw new ToolchainError("PSP's pinned QuickJS source is absent from cargo metadata");
  // The SDK's compiler binary is host-specific and dynamically linked. Use
  // Clang's MIPS backend with the pinned PSP headers on each build host.
  const llvmBin = env.POCKETJS_LLVM_BIN ?? (existsSync("/opt/homebrew/opt/llvm/bin/clang") ? "/opt/homebrew/opt/llvm/bin" : "");
  const compiler = llvmBin ? join(llvmBin,"clang") : Bun.which("clang", { PATH: env.PATH });
  const archiver = llvmBin ? join(llvmBin,"llvm-ar") : Bun.which("llvm-ar", { PATH: env.PATH });
  if (!compiler || !archiver || !existsSync(compiler) || !existsSync(archiver)) throw new ToolchainError("PSP guest build requires LLVM clang and llvm-ar (set POCKETJS_LLVM_BIN)");
  const targets = Bun.spawnSync([compiler,"--print-targets"],{stdout:"pipe",stderr:"pipe"});
  if (!targets.success || !targets.stdout.toString().includes("mipsel")) throw new ToolchainError("PSP guest build requires Clang with the MIPS backend (set POCKETJS_LLVM_BIN)");
  const rustLib = Bun.spawnSync([toolchain.rustup, "run", rustToolchain, "rustc", "--print", "target-libdir"], { env, stdout: "pipe", stderr: "pipe" });
  if (!rustLib.success) throw new ToolchainError(`PSP linker lookup failed: ${rustLib.stderr.toString()}`);
  const linker = join(dirname(rustLib.stdout.toString().trim()), "bin/rust-lld");
  if (!existsSync(linker)) throw new ToolchainError(`PSP Rust linker is absent: ${linker}`);
  const sysroot = Bun.spawnSync([toolchain.rustup, "run", rustToolchain, "rustc", "--print", "sysroot"], { env, stdout: "pipe", stderr: "pipe" });
  if (!sysroot.success) throw new ToolchainError(`PSP compiler library lookup failed: ${sysroot.stderr.toString()}`);
  return {
    rustToolchain,
    rustup: toolchain.rustup,
    sdk,
    cargoPspBin,
    quickjs,
    environment: {
      ...env,
      PSP_SDK: sdk,
      PSPDEV: sdk,
      POCKET_QJS_SOURCE: join(dirname(dependency.manifest_path), "embed/quickjs"),
      POCKET_PSP_CC: compiler,
      POCKET_PSP_AR: archiver,
      POCKET_PSP_LLD: linker,
      POCKET_PSP_LLVM_LIB: join(sysroot.stdout.toString().trim(), "lib"),
      CARGO_TARGET_MIPSEL_SONY_PSP_LINKER: resolve(import.meta.dir, "../../../psp-linker.ts"),
      QUICKJS_PREBUILT_LIB: quickjs,
      RUSTUP_TOOLCHAIN: rustToolchain,
      // A rust-toolchain.toml cannot install a toolchain behind the record.
      RUSTUP_AUTO_INSTALL: "0",
      PATH: [cargoPspBin, dirname(toolchain.rustup), env.PATH].filter(Boolean).join(":"),
    },
  };
}
