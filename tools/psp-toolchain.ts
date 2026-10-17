// tools/psp-toolchain.ts — the PSP build environment, read from the toolchain
// `pocket target add psp` installed for this framework's pins
// (tools/targets/psp.toolchain.json). No path comes from anywhere else.
//
// QuickJS is the PSP host's one C dependency. libquickjs-sys links the
// prebuilt archive QUICKJS_PREBUILT_LIB names, which pocket-nexus/quickjs-rs
// publishes from the revision hosts/psp/Cargo.toml pins, so a PSP build runs
// no C compiler.

import { dirname, join } from "node:path";
import { catalogEntry } from "./targets/index.ts";
import { requireToolchain, ToolchainError } from "./targets/store.ts";
import type { FileComponent } from "./targets/toolchain.ts";

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
      QUICKJS_PREBUILT_LIB: quickjs,
      RUSTUP_TOOLCHAIN: rustToolchain,
      // A rust-toolchain.toml cannot install a toolchain behind the record.
      RUSTUP_AUTO_INSTALL: "0",
      PATH: [cargoPspBin, dirname(toolchain.rustup), env.PATH].filter(Boolean).join(":"),
    },
  };
}
