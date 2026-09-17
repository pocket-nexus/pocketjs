#!/usr/bin/env bun
// micro/compiler/cli.ts — Pocket Micro: compile a PocketJS Solid app to native Rust.
//
//   bun micro/compiler/cli.ts ir <app>                 print the Micro IR (JSON)
//   bun micro/compiler/cli.ts check <app>              subset diagnostics + plan
//   bun micro/compiler/cli.ts build <app> [options]    IR + Rust + pak (+ PSP EBOOT)
//
//   <app>            apps/<app>/main.tsx, or a path to a mounting entry
//   --out <dir>      build directory (default dist/micro/<app>): app.rs,
//                    app.ir.json, the pak, styles.bin and manifest.json.
//                    Nothing here is committed; every artifact is a pure
//                    function of the app sources and this compiler.
//   --psp            build hosts/psp-micro into a PRX + EBOOT.PBP (cargo psp)
//   --release        cargo --release for --psp
//   --tape "<f:m,…>" bake a button tape into the EBOOT (frame:mask, as the
//                    PSP capture builds do); the pad takes over after it ends
//   --receipt <n>    frame at which the EBOOT writes its receipt (default 240)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { resolvePspBuildToolchain } from "../../tools/psp-toolchain.ts";
import { buildAssets } from "./assets.ts";
import { emitRust, planSummary } from "./emit-rust.ts";
import { compileMicro, MicroCompileError } from "./frontend.ts";
import type { Program } from "./ir.ts";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

function usage(): never {
  console.error(
    "usage: bun micro/compiler/cli.ts <ir|check|build> <app> [--out <dir>] [--psp] [--release] [--tape <frame:mask,…>] [--receipt <frame>]",
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || !["ir", "check", "build"].includes(command)) usage();
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && ["--out", "--tape", "--receipt"].includes(all[i - 1])));
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);
const appArg = positional[0];
if (!appArg) usage();

function resolveEntry(arg: string): string {
  const tries = [resolve(arg), resolve(ROOT, arg), resolve(ROOT, "apps", arg, "main.tsx"), resolve(ROOT, "apps", `${arg}-main.tsx`)];
  for (const t of tries) if (/\.tsx?$/.test(t) && existsSync(t) && statSync(t).isFile()) return t;
  console.error(`Pocket Micro: cannot resolve app "${arg}" (tried ${tries.join(", ")})`);
  process.exit(1);
}

const entry = resolveEntry(appArg);
const appDir = dirname(entry);
const appName = basename(appDir) === "apps" ? basename(entry).replace(/(-main)?\.tsx?$/, "") : basename(appDir);

let program: Program;
try {
  program = compileMicro(entry);
} catch (e) {
  if (e instanceof MicroCompileError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

if (command === "ir") {
  console.log(JSON.stringify(program, null, 2));
  process.exit(0);
}

const outDir = resolve(flag("--out") ?? join(ROOT, "dist/micro", appName));
console.log(`Pocket Micro: ${appName} (${program.entry})`);
const assets = await buildAssets(program, appDir, ROOT, (line) => {
  if (command === "build") console.log(line);
});
console.log(planSummary(program, assets.styles.records.length, assets.styles.usedFontSlots));
if (command === "check") process.exit(0);

const rust = emitRust(program, { styleIds: assets.styles.ids, fontSlots: assets.styles.usedFontSlots });
mkdirSync(outDir, { recursive: true });
const rustPath = join(outDir, "app.rs");
const irPath = join(outDir, "app.ir.json");
await Bun.write(rustPath, rust);
await Bun.write(irPath, JSON.stringify(program, null, 2) + "\n");
const pakPath = join(outDir, `${appName}.pak`);
await Bun.write(pakPath, assets.pak);
await Bun.write(join(outDir, "styles.bin"), assets.styles.bin);
const buildHash = createHash("sha256").update(rust).update(assets.pak).digest("hex").slice(0, 16);
await Bun.write(
  join(outDir, "manifest.json"),
  JSON.stringify(
    {
      app: appName,
      title: program.title,
      entry: program.entry,
      buildHash,
      rust: rustPath,
      ir: irPath,
      pak: pakPath,
      pakEntries: assets.entries,
      styleIds: assets.styles.ids,
      fontSlots: assets.styles.usedFontSlots,
    },
    null,
    2,
  ) + "\n",
);
console.log(`  rust: ${rustPath} (${rust.length} bytes)`);
console.log(`  ir:   ${irPath}`);
console.log(`  pak:  ${pakPath} (${assets.pak.length} bytes), build ${buildHash}`);

if (!has("--psp")) process.exit(0);

// ---------------------------------------------------------------------------
// PSP EBOOT: hosts/psp-micro with the generated module and pak baked in.
// ---------------------------------------------------------------------------

const hostDir = join(ROOT, "hosts/psp-micro/");
const toolchain = resolvePspBuildToolchain();
const sdk = toolchain.sdk.path;
const release = has("--release");
const tape = flag("--tape") ?? "";
const receipt = flag("--receipt") ?? "240";

// XMB metadata: the app's psp/Psp.toml with asset paths made absolute; the
// generated file is build output (ignored).
const fragment = join(appDir, "psp/Psp.toml");
const generatedToml = join(hostDir, "Psp.toml");
if (existsSync(fragment)) {
  const text = await Bun.file(fragment).text();
  const rewritten = text
    .replace(/^(\s*\w+_(?:png|pmf|at3))(\s*=\s*")(?!\/)([^"]+)(")/gm, (_m, key, eq, rel, close) => `${key}${eq}${join(appDir, "psp", rel)}${close}`)
    .replace(/^(\s*title\s*=\s*")([^"]*)(")/m, (_m, a, title, c) => `${a}${title} (Micro)${c}`);
  await Bun.write(generatedToml, `# GENERATED by micro/compiler/cli.ts from ${fragment} — do not edit.\n${rewritten}`);
}

const rustflags = [process.env.RUSTFLAGS, process.env.PSPJS_SHOW_LINKER_MESSAGES === "1" ? undefined : "-A linker-messages", "-A unexpected-cfgs", "-A unstable-name-collisions"]
  .filter(Boolean)
  .join(" ");
const env: Record<string, string> = {
  ...(toolchain.environment as Record<string, string>),
  RUSTFLAGS: rustflags,
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${toolchain.llvmBin}/llvm-ar`,
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -O2 -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  AR_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ranlib`,
  RUST_PSP_TARGET: join(ROOT, "hosts/psp/targets/mipsel-sony-psp.json"),
  RUST_PSP_ABORT_ONLY: "1",
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
  // The pocketjs-psp library's build script (a dependency here) embeds no
  // JS bundle: this EBOOT carries a compiled app, not a guest.
  POCKETJS_EMBED_APP: "0",
  POCKETJS_APP_OUTPUT: "",
  POCKETJS_TARGET: "psp",
  POCKETJS_HOST_ABI: "1",
  POCKETJS_OUTPUT_DIR: outDir,
  POCKETJS_LAUNCHER_REGISTRY: "",
  POCKETJS_VEIL_LOGO: "",
  POCKETJS_CAPTURE_INPUT: "",
  POCKETJS_TRACE: "",
  POCKETJS_CAP_START: "",
  POCKETJS_CAP_N: "",
  POCKETJS_ARENA_BYTES: "",
  POCKETJS_BENCH_DUMP_FRAMES: "",
  POCKETJS_OFFLOAD_SLOT: "",
  // The compiled app.
  POCKET_MICRO_APP_RS: rustPath,
  POCKET_MICRO_PAK: pakPath,
  POCKET_MICRO_APP: appName,
  POCKET_MICRO_TITLE: program.title,
  POCKET_MICRO_BUILD: buildHash,
  POCKET_MICRO_TAPE: tape,
  POCKET_MICRO_RECEIPT_FRAME: receipt,
};
const cargoArgs = ["--bin", "pocket-micro-psp", ...(release ? ["--release"] : [])];
console.log(`Pocket Micro: cargo psp (${release ? "release" : "debug"}${tape ? `, tape ${JSON.stringify(tape)}` : ""})`);
await $`${toolchain.rustup} run ${toolchain.manifest.rust.toolchain} cargo psp ${cargoArgs}`.cwd(hostDir).env(env);
const profile = release ? "release" : "debug";
const targetDir = join(hostDir, "target/mipsel-sony-psp", profile);
const prx = join(targetDir, "pocket-micro-psp.prx");
const binEboot = join(targetDir, "pocket-micro-psp.EBOOT.PBP");
const eboot = join(targetDir, "EBOOT.PBP");
if (existsSync(binEboot)) await Bun.write(eboot, await Bun.file(binEboot).arrayBuffer());
console.log(`  prx:   ${prx}${existsSync(prx) ? ` (${statSync(prx).size} bytes)` : " (missing)"}`);
console.log(`  eboot: ${eboot}${existsSync(eboot) ? ` (${statSync(eboot).size} bytes)` : " (missing)"}`);
