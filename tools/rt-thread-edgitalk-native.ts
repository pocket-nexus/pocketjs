#!/usr/bin/env bun
/**
 * Build PocketJS native Rust crates for Edgi-Talk M55 (RT-Thread).
 *
 * Analogous to tools/esp-idf-native.ts, but for a single unofficial target:
 *   thumbv8m.main-none-eabihf  (Cortex-M55 hard-float)
 *
 * Usage:
 *   bun tools/rt-thread-edgitalk-native.ts --help
 *   bun tools/rt-thread-edgitalk-native.ts --dry-run
 *   bun tools/rt-thread-edgitalk-native.ts --check-prereqs
 *   bun tools/rt-thread-edgitalk-native.ts [--component ui-core|render-rgb565]
 *
 * Archives land under hosts/esp-idf/native/<crate>/target/<rustTarget>/release/
 * so hosts/rt-thread-edgitalk/native/SConscript LIBPATH keeps working.
 * Receipts land under hosts/rt-thread-edgitalk/native/receipts/ (gitignored).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOST_NATIVE = join(ROOT, "hosts/rt-thread-edgitalk/native");
const TOOLCHAINS_PATH = join(HOST_NATIVE, "toolchains.json");
const RECEIPTS_DIR = join(HOST_NATIVE, "receipts");
const IDF_NATIVE = join(ROOT, "hosts/esp-idf/native");

const COMPONENTS = [
  {
    component: "pocketjs_ui_core",
    crate: "ui-core",
    archive: "libpocketjs_idf_ui_core.a",
  },
  {
    component: "pocketjs_render_rgb565",
    crate: "render-rgb565",
    archive: "libpocketjs_idf_render_rgb565.a",
  },
] as const;

type ComponentSpec = (typeof COMPONENTS)[number];

const POLICY = {
  profile: "release",
  defaultFeatures: false,
  locked: true,
  codegenUnits: 16,
  lto: false,
  optLevel: 3,
  panic: "abort",
} as const;

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function loadToolchain(): {
  rustTarget: string;
  officialRegistry: boolean;
  recommendedRustc: string;
} {
  const json = JSON.parse(readFileSync(TOOLCHAINS_PATH, "utf8"));
  const entry = json["edgitalk-m55"];
  if (!entry?.rustTarget) {
    throw new Error(`missing edgitalk-m55 in ${TOOLCHAINS_PATH}`);
  }
  return entry;
}

function usage(): string {
  return `usage: rt-thread-edgitalk-native [options]

Build ui-core + render-rgb565 for Edgi-Talk M55 (thumbv8m.main-none-eabihf).

Options:
  --help                 Show this help
  --dry-run              Print planned cargo commands; do not build
  --check-prereqs        Verify cargo/rustc + target; exit 0/1
  --component <name>     ui-core | render-rgb565 (default: both)
  --cargo <path>         cargo binary (default: PATH)
  --skip-locked          Omit --locked (when Cargo.lock drift is expected)

Prerequisites:
  - rustc/cargo that know target thumbv8m.main-none-eabihf
    (typically: rustup target add thumbv8m.main-none-eabihf)
  - Bun (this script)

See hosts/rt-thread-edgitalk/docs/build.md and native/receipts/README.md.
`;
}

function take(args: string[], name: string): string | undefined {
  const i = args.indexOf("--" + name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--" + name + " requires a value");
  }
  args.splice(i, 2);
  return value;
}

function run(
  command: string[],
  env?: Record<string, string | undefined>,
): void {
  const result = Bun.spawnSync(command, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: env as Record<string, string> | undefined,
  });
  if (result.exitCode !== 0) {
    throw new Error("command failed: " + command.join(" "));
  }
}

function rustcBeside(cargo: string): string {
  return join(dirname(cargo), "rustc");
}

function rustcVersion(rustc: string): string {
  const version = Bun.spawnSync([rustc, "-Vv"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (version.exitCode !== 0) {
    throw new Error("rustc beside the supplied cargo is not runnable");
  }
  return version.stdout.toString().trim();
}

function targetKnown(rustc: string, rustTarget: string): boolean {
  const listed = Bun.spawnSync([rustc, "--print", "target-list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) return false;
  return listed.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .includes(rustTarget);
}

function targetCfgOk(rustc: string, rustTarget: string): boolean {
  const cfg = Bun.spawnSync([rustc, "--print", "cfg", "--target", rustTarget], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return cfg.exitCode === 0;
}

function checkPrereqs(
  cargo: string,
  rustTarget: string,
): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  if (!cargo || !existsSync(cargo)) {
    lines.push("FAIL: cargo not found (install Rust / put cargo on PATH)");
    return { ok: false, lines };
  }
  lines.push("OK: cargo = " + cargo);
  const rustc = rustcBeside(cargo);
  if (!existsSync(rustc)) {
    lines.push("FAIL: rustc not found beside cargo at " + rustc);
    return { ok: false, lines };
  }
  let compiler: string;
  try {
    compiler = rustcVersion(rustc);
    lines.push("OK: rustc -Vv:\n" + compiler);
  } catch (e) {
    lines.push("FAIL: " + (e as Error).message);
    return { ok: false, lines };
  }
  if (!targetKnown(rustc, rustTarget)) {
    lines.push(
      `FAIL: rustc does not list target ${rustTarget} (try: rustup target add ${rustTarget})`,
    );
    return { ok: false, lines };
  }
  lines.push(`OK: rustc lists target ${rustTarget}`);
  if (!targetCfgOk(rustc, rustTarget)) {
    lines.push(
      `FAIL: rustc --print cfg --target ${rustTarget} failed (stdlib/sysroot for target may be missing)`,
    );
    return { ok: false, lines };
  }
  lines.push(`OK: rustc can print cfg for ${rustTarget}`);
  const sysroot = Bun.spawnSync([rustc, "--print", "sysroot"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const sysrootPath = sysroot.stdout.toString().trim();
  const rustlib = join(sysrootPath, "lib/rustlib", rustTarget, "lib");
  if (!existsSync(rustlib)) {
    lines.push(
      `FAIL: no prebuilt core/alloc for ${rustTarget} under ${rustlib}`,
    );
    lines.push(
      `      Install with: rustup target add ${rustTarget}  (or use a toolchain that ships that target)`,
    );
    return { ok: false, lines };
  }
  lines.push(`OK: rustlib present for ${rustTarget}`);
  if (!existsSync(TOOLCHAINS_PATH)) {
    lines.push("FAIL: missing " + TOOLCHAINS_PATH);
    return { ok: false, lines };
  }
  lines.push("OK: toolchains.json present");
  for (const spec of COMPONENTS) {
    const manifest = join(IDF_NATIVE, spec.crate, "Cargo.toml");
    if (!existsSync(manifest)) {
      lines.push("FAIL: missing " + manifest);
      return { ok: false, lines };
    }
  }
  lines.push("OK: ui-core + render-rgb565 manifests present under hosts/esp-idf/native/");
  return { ok: true, lines };
}

async function sourceDigest(spec: ComponentSpec): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(POLICY)).update("\0");
  const files = new Set<string>([
    "tools/rt-thread-edgitalk-native.ts",
    "hosts/rt-thread-edgitalk/native/toolchains.json",
    `hosts/esp-idf/native/${spec.crate}/Cargo.toml`,
    `hosts/esp-idf/native/${spec.crate}/Cargo.lock`,
  ]);
  const roots = [
    `hosts/esp-idf/native/${spec.crate}/src`,
    "hosts/esp-idf/native/abi",
    "hosts/esp-idf/native/runtime",
    "engine/core",
  ];
  if (spec.crate === "render-rgb565") roots.push("engine/backends/rgb565");
  for (const path of roots) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) continue;
    for await (const file of new Bun.Glob("**/*.{rs,toml,lock}").scan({
      cwd: abs,
      dot: true,
    })) {
      if (
        file.split("/").some(
          (part) => part === "target" || part.startsWith("target-") || part === ".git",
        )
      ) {
        continue;
      }
      files.add(`${path}/${file}`);
    }
  }
  for (const file of [...files].sort()) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) continue;
    const bytes = readFileSync(abs);
    hash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

function plannedCommand(
  cargo: string,
  rustTarget: string,
  spec: ComponentSpec,
  locked: boolean,
): string[] {
  return [
    cargo,
    "build",
    "--release",
    ...(locked ? ["--locked"] : []),
    "--no-default-features",
    "--target",
    rustTarget,
    "--manifest-path",
    join(IDF_NATIVE, spec.crate, "Cargo.toml"),
  ];
}

async function buildOne(
  cargo: string,
  rustTarget: string,
  spec: ComponentSpec,
  locked: boolean,
  dryRun: boolean,
  compiler: string,
): Promise<void> {
  const cmd = plannedCommand(cargo, rustTarget, spec, locked);
  console.log("$ " + cmd.join(" "));
  if (dryRun) return;

  const before = await sourceDigest(spec);
  run(cmd, { ...process.env });
  const after = await sourceDigest(spec);
  if (before !== after) {
    throw new Error("native sources changed while building " + spec.crate);
  }

  const archivePath = join(
    IDF_NATIVE,
    spec.crate,
    "target",
    rustTarget,
    "release",
    spec.archive,
  );
  if (!existsSync(archivePath)) {
    throw new Error("expected archive missing: " + archivePath);
  }
  const archive = readFileSync(archivePath);
  mkdirSync(RECEIPTS_DIR, { recursive: true });
  const receipt = {
    schemaVersion: 2 as const,
    component: spec.component,
    crate: spec.crate,
    target: "edgitalk-m55",
    rustTarget,
    archive: spec.archive,
    archivePath: archivePath.slice(ROOT.length + 1),
    compiler,
    archiver: null,
    sourceSha256: after,
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    policy: POLICY,
    officialRegistry: false,
  };
  const receiptPath = join(
    RECEIPTS_DIR,
    `${spec.crate}.edgitalk-m55.build-receipt.json`,
  );
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    `${spec.component}: ${archive.length} bytes, sha256 ${receipt.archiveSha256}`,
  );
  console.log("receipt: " + receiptPath.slice(ROOT.length + 1));
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const dryRun = args.includes("--dry-run");
  const checkOnly = args.includes("--check-prereqs");
  const skipLocked = args.includes("--skip-locked");
  for (const flag of ["--dry-run", "--check-prereqs", "--skip-locked", "--help", "-h"]) {
    const i = args.indexOf(flag);
    if (i >= 0) args.splice(i, 1);
  }
  const component = take(args, "component");
  const cargo = resolve(take(args, "cargo") ?? Bun.which("cargo") ?? "");
  if (args.length) {
    throw new Error("unexpected args: " + args.join(" ") + "\n" + usage());
  }

  const toolchain = loadToolchain();
  const rustTarget = toolchain.rustTarget as string;

  const prereq = checkPrereqs(cargo, rustTarget);
  for (const line of prereq.lines) console.log(line);
  if (checkOnly) {
    process.exit(prereq.ok ? 0 : 1);
  }
  if (!prereq.ok) {
    if (dryRun) {
      console.warn(
        "\nPrerequisites incomplete; continuing --dry-run with planned cargo commands only.",
      );
    } else {
      console.error(
        "\nPrerequisites missing. Fix the FAIL lines above, or run with --dry-run / --help.",
      );
      console.error(
        `Hint: rustup target add ${rustTarget}  (if using rustup)`,
      );
      process.exit(1);
    }
  }

  const rustc = rustcBeside(cargo);
  let compiler = "(unavailable)";
  try {
    compiler = rustcVersion(rustc);
  } catch {
    if (!dryRun) throw new Error("rustc not runnable");
  }
  const specs = COMPONENTS.filter(
    (spec) => !component || spec.crate === component,
  );
  if (!specs.length) {
    throw new Error("unknown native component " + component);
  }

  console.log(
    `\nBuilding for edgitalk-m55 / ${rustTarget}` +
      (dryRun ? " (dry-run)" : "") +
      "…\n",
  );
  for (const spec of specs) {
    await buildOne(cargo, rustTarget, spec, !skipLocked, dryRun, compiler);
  }
  if (dryRun) {
    console.log("\nDry-run complete; no archives written.");
  }
}

await main();
