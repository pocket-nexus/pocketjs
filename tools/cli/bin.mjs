#!/usr/bin/env node
// @pocketjs/cli — the PocketJS toolchain CLI (flutter/react-native doctor
// style). Zero dependencies; plain Node >= 18.
//
//   pocket doctor          diagnose the local toolchain
//   pocket setup [--yes]   run the checkout's pinned, idempotent bootstrap
//   pocket create <name>   scaffold a manifest-first demo app
//   pocket check|compile|build --target <psp|vita> [...args]
//                            resolve pocket.json once, then build from its plan
//   pocket play vita <demo> build, install and launch a demo in Vita3K
//   pocket play ios <demo>  build, stage and launch a demo on the iOS simulator
//   pocket dev|psp|vita|hw|psplink|devtools|tape [...args]
//                            low-level passthrough to the checkout's bun scripts
//   pocket symbian <cmd>      Nokia E7 toolchain doctor/setup/build/deploy
//   pocket ios <cmd>          Apple iOS doctor/setup/build/play on the simulator
//
// The published CLI ships the same manifest consumed by PocketJS build scripts.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const TOOLCHAIN = JSON.parse(readFileSync(new URL("./psp-toolchain.json", import.meta.url), "utf8"));
const NIGHTLY = TOOLCHAIN.rust.toolchain;
const C = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const which = (bin) => {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
};
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

// ---------------------------------------------------------------------------
// Checkout discovery
// ---------------------------------------------------------------------------

function findCheckout(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === "@pocketjs/framework") return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve a project-local published framework when no source checkout owns cwd. */
function findFrameworkInstallation(from = process.cwd()) {
  if (process.env.POCKETJS_FRAMEWORK_ROOT?.trim()) {
    const explicit = resolve(process.env.POCKETJS_FRAMEWORK_ROOT.trim());
    return existsSync(join(explicit, "tools", "pocket.ts")) ? explicit : null;
  }
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", "@pocketjs", "framework");
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "tools", "pocket.ts"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Canonical cache + doctor
// ---------------------------------------------------------------------------

function cacheRoot() {
  if (process.env.POCKET_NEXUS_CACHE_DIR?.trim()) {
    return resolve(process.env.POCKET_NEXUS_CACHE_DIR.trim());
  }
  return join(resolve(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache")), "pocket-nexus");
}

function sdkResolution() {
  if (process.env.PSP_SDK?.trim()) {
    return { path: resolve(process.env.PSP_SDK.trim()), source: "PSP_SDK" };
  }
  if (process.env.PSPDEV?.trim()) {
    return { path: resolve(process.env.PSPDEV.trim()), source: "PSPDEV" };
  }
  return { path: join(cacheRoot(), TOOLCHAIN.sdk.cachePath), source: "cache" };
}

function hasVerifiedSdkReceipt(sdk) {
  try {
    const receipt = JSON.parse(readFileSync(join(sdk, TOOLCHAIN.sdk.receipt), "utf8"));
    return receipt.tag === TOOLCHAIN.sdk.tag && receipt.asset === TOOLCHAIN.sdk.asset &&
      receipt.url === TOOLCHAIN.sdk.url && receipt.sha256 === TOOLCHAIN.sdk.sha256;
  } catch {
    return false;
  }
}

function hasPinnedCargoPspTools(root) {
  if (!TOOLCHAIN.cargoPsp.tools.every((tool) => existsSync(join(root, "bin", tool)))) return false;
  const host = hostTriple();
  try {
    const metadata = JSON.parse(readFileSync(join(root, ".crates2.json"), "utf8"));
    const source = `git+${TOOLCHAIN.rustPsp.repository}?rev=${TOOLCHAIN.rustPsp.rev}#${TOOLCHAIN.rustPsp.rev}`;
    if (Object.entries(metadata.installs || {}).some(([id, install]) =>
      id.startsWith(`${TOOLCHAIN.cargoPsp.package} `) && id.includes(source) &&
      install.target === host &&
      Array.isArray(install.bins) && TOOLCHAIN.cargoPsp.tools.every((tool) => install.bins.includes(tool))
    )) return true;
  } catch {}
  try {
    const receipt = JSON.parse(readFileSync(join(root, ".pocket-nexus-cargo-psp.json"), "utf8"));
    return receipt.schemaVersion === 1 && receipt.repository === TOOLCHAIN.rustPsp.repository &&
      receipt.rev === TOOLCHAIN.rustPsp.rev && receipt.package === TOOLCHAIN.cargoPsp.package &&
      receipt.host === host && Array.isArray(receipt.tools) &&
      receipt.tools.length === TOOLCHAIN.cargoPsp.tools.length &&
      TOOLCHAIN.cargoPsp.tools.every((tool) => receipt.tools.includes(tool));
  } catch {}
  return false;
}

function hostTriple() {
  const cpu = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (platform() === "darwin") return `${cpu}-apple-darwin`;
  if (platform() === "linux") return `${cpu}-unknown-linux-gnu`;
  if (platform() === "win32") return `${cpu}-pc-windows-msvc`;
  return `${cpu}-unknown-${platform()}`;
}

function llvmResolution() {
  if (process.env.POCKETJS_LLVM_BIN?.trim()) {
    const bin = resolve(process.env.POCKETJS_LLVM_BIN.trim());
    const ok = existsSync(join(bin, "clang")) && existsSync(join(bin, "llvm-ar"));
    return { bin, ok, source: "POCKETJS_LLVM_BIN" };
  }
  const candidates = ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"];
  for (const bin of candidates) {
    if (existsSync(join(bin, "clang")) && existsSync(join(bin, "llvm-ar"))) {
      return { bin, ok: true, source: "auto" };
    }
  }
  const clang = which("clang");
  const llvmAr = which("llvm-ar");
  const bin = clang && llvmAr && dirname(clang) === dirname(llvmAr) ? dirname(clang) : null;
  return { bin, ok: !!bin, source: "auto" };
}

function checks() {
  const root = findCheckout();
  const isMac = platform() === "darwin";
  const llvm = llvmResolution();
  const toolchains = run("rustup", ["toolchain", "list"]) ?? "";
  const targets = run("rustup", ["target", "list", "--installed", "--toolchain", "stable"]) ?? "";
  const components = run("rustup", ["component", "list", "--toolchain", NIGHTLY]) ?? "";
  const sdk = sdkResolution();
  const sdkMarkerOk = existsSync(join(sdk.path, TOOLCHAIN.sdk.marker));
  const sdkOk = sdkMarkerOk && (sdk.source !== "cache" || hasVerifiedSdkReceipt(sdk.path));
  const cargoPspRoot = join(cacheRoot(), TOOLCHAIN.cargoPsp.cachePath);
  const cargoPspBin = join(cargoPspRoot, "bin");
  const cargoToolsOk = hasPinnedCargoPspTools(cargoPspRoot);
  return {
    root,
    isMac,
    core: [
      { name: "bun", ok: !!which("bun"), hint: "curl -fsSL https://bun.sh/install | bash" },
      { name: "rustup", ok: !!which("rustup"), hint: "curl https://sh.rustup.rs -sSf | sh" },
      {
        name: "Rust stable + wasm32-unknown-unknown (web host)",
        ok: targets.includes("wasm32-unknown-unknown"),
        fix: ["rustup", ["target", "add", "wasm32-unknown-unknown"]],
      },
      {
        name: "PocketJS checkout",
        ok: !!root,
        hint: "git clone https://github.com/pocket-nexus/pocketjs && cd pocketjs",
        detail: root ?? undefined,
      },
    ],
    psp: [
      {
        name: `Rust ${NIGHTLY} + rust-src`,
        ok: toolchains.includes(NIGHTLY) && /rust-src.*\(installed\)/.test(components),
        hint: "run `pocket setup` (or `bun run bootstrap` in the checkout)",
      },
      {
        name: `cargo-psp tools (${TOOLCHAIN.rustPsp.rev.slice(0, 12)})`,
        ok: cargoToolsOk,
        hint: "run `pocket setup` (unversioned cargo installs are not used)",
        detail: cargoPspBin,
      },
      {
        name: llvm.source === "POCKETJS_LLVM_BIN"
          ? "LLVM override (POCKETJS_LLVM_BIN)"
          : "LLVM (TARGET_CFLAGS clang)",
        ok: llvm.ok,
        fix: llvm.source === "auto" && isMac ? ["brew", ["install", "llvm"]] : null,
        hint: llvm.source === "POCKETJS_LLVM_BIN"
          ? "explicit override must contain both clang and llvm-ar; fix or unset POCKETJS_LLVM_BIN"
          : isMac ? undefined : "install clang/llvm via your distro's package manager",
        detail: llvm.bin ? (llvm.ok ? join(llvm.bin, "clang") : llvm.bin) : undefined,
      },
      {
        name: sdk.source === "cache"
          ? `verified PSP SDK (${TOOLCHAIN.sdk.tag})`
          : `PSP SDK override (${sdk.source})`,
        ok: sdkOk,
        hint: sdk.source === "cache"
          ? "run `pocket setup` to download and verify the pinned SDK"
          : `${sdk.source} is explicit but ${TOOLCHAIN.sdk.marker} is missing`,
        detail: `${sdk.path} via ${sdk.source}`,
      },
    ],
    optional: [
      {
        name: "PSPLINK host tools (real-hardware hot reload only)",
        ok: !!which("usbhostfs_pc") && !!which("pspsh"),
        hint: "needed by pocket hw/psplink, not by PSP builds; see pspdev/psplinkusb",
      },
      {
        name: "PPSSPPHeadless (emulator E2E)",
        ok: existsSync(join(homedir(), "ppsspp-src", "build", "PPSSPPHeadless")) || !!process.env.PPSSPP_HEADLESS,
        hint: "source-build PPSSPP with headless, or set PPSSPP_HEADLESS",
      },
      { name: "ImageMagick (frame decoding)", ok: !!which("magick"), fix: isMac ? ["brew", ["install", "imagemagick"]] : null },
    ],
  };
}

function doctor() {
  const c = checks();
  const section = (title, items) => {
    console.log("\n" + C.bold(title));
    for (const it of items) {
      const line = it.ok ? C.ok(it.name) : title === "Optional" ? C.warn(it.name) : C.bad(it.name);
      console.log("  " + line + (it.detail ? C.dim(`  (${it.detail})`) : ""));
      if (!it.ok && (it.hint || it.fix)) {
        console.log("      " + C.dim(it.fix ? `fix: ${it.fix[0]} ${it.fix[1].join(" ")}` : it.hint));
      }
    }
  };
  console.log(C.bold("PocketJS doctor"));
  section("Core (web/desktop development)", c.core);
  section("PSP builds", c.psp);
  section("Optional", c.optional);
  const missing = [...c.core, ...c.psp].filter((i) => !i.ok).length;
  console.log(
    "\n" +
      (missing === 0
        ? C.ok("Everything looks good.")
        : C.warn(`${missing} issue(s) found — run ${C.bold("pocket setup")} to fix the installable ones.`)),
  );
  process.exitCode = missing === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// setup — one implementation lives in the PocketJS checkout
// ---------------------------------------------------------------------------

async function confirm(question) {
  if (process.argv.includes("--yes") || process.argv.includes("-y")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function setup() {
  const root = findCheckout();
  if (!root) {
    console.error(C.bad("`pocket setup` must run inside a PocketJS checkout"));
    console.error(C.dim("git clone https://github.com/pocket-nexus/pocketjs && cd pocketjs"));
    process.exitCode = 1;
    return;
  }
  if (!which("bun")) {
    console.error(C.bad("bun not found — install from https://bun.sh, then retry"));
    process.exitCode = 1;
    return;
  }
  if (!(await confirm(`Install the pinned PocketJS toolchain into ${C.bold(cacheRoot())}?`))) return;
  const result = spawnSync("bun", [join(root, "tools/bootstrap.ts")], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(C.bad(`PocketJS bootstrap failed (exit ${result.status})`));
    process.exitCode = result.status ?? 1;
    return;
  }
  doctor();
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const APP_TSX = (title) => `// ${title} — scaffolded by \`pocket create\`.
import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

export default function App() {
  const [count, setCount] = createSignal(0);
  onButtonPress(BTN.CROSS, () => setCount((n) => n + 1));
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-4 bg-slate-950">
      <View class="w-[48] h-[48] rounded-[12px] bg-indigo-500 animate-spin" />
      <Text class="text-xl text-white font-bold">{\`Count: \${count()}\`}</Text>
      <Text class="text-sm text-slate-400">Press CROSS (Z / Enter) to count</Text>
    </View>
  );
}
`;

const MAIN_TSX = (title) => `// @title PocketJS: ${title}
import App from "./app.tsx";
import { mount } from "@pocketjs/framework/solid";

mount(() => <App />);
`;

const MANIFEST = (name, title) => ({
  $schema: "https://pocketjs.dev/schema/pocket-2.json",
  pocket: 2,
  id: `dev.example.${name.replace(/-/g, ".")}`,
  name,
  title,
  version: "0.1.0",
  engine: {
    capabilities: {
      requires: ["text.glyphs.baked", "input.buttons"],
    },
  },
  app: {
    entry: "main.tsx",
    output: `${name}-main`,
    framework: "solid",
    viewport: {
      logical: [480, 272],
      presentation: "integer-fit",
    },
  },
});

function create(name) {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(C.bad("usage: pocket create <kebab-case-name>"));
    process.exit(1);
  }
  const root = findCheckout();
  if (!root) {
    console.error(C.bad("not inside a PocketJS checkout — clone https://github.com/pocket-nexus/pocketjs first"));
    process.exit(1);
  }
  const dir = join(root, "apps", name);
  if (existsSync(dir)) {
    console.error(C.bad(`apps/${name} already exists`));
    process.exit(1);
  }
  const title = name.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.tsx"), APP_TSX(title));
  writeFileSync(join(dir, "main.tsx"), MAIN_TSX(title));
  writeFileSync(join(dir, "pocket.json"), JSON.stringify(MANIFEST(name, title), null, 2) + "\n");
  console.log(C.ok(`apps/${name} scaffolded`));
  console.log(C.dim(`  pocket check --target psp --manifest apps/${name}/pocket.json`));
  console.log(C.dim(`  pocket build --target psp --manifest apps/${name}/pocket.json -- --release`));
  console.log(C.dim(`  pocket build --target vita --manifest apps/${name}/pocket.json -- --release`));
}

// ---------------------------------------------------------------------------
// passthrough
// ---------------------------------------------------------------------------

const SCRIPTS = {
  dev: "tools/dev.ts",
  psp: "tools/psp.ts",
  vita: "tools/vita.ts",
  symbian: "tools/symbian.ts",
  ios: "tools/ios.ts",
  hw: "tools/hw.ts",
  psplink: "tools/psplink.ts",
  devtools: "tools/devtools.ts",
  tape: "tools/tape.ts",
  play: "tools/play.ts",
};

function manifestCommand(cmd, args) {
  const root = process.env.POCKETJS_FRAMEWORK_ROOT?.trim()
    ? findFrameworkInstallation()
    : findCheckout() ?? findFrameworkInstallation();
  if (!root) {
    console.error(C.bad(
      "PocketJS framework not found — install @pocketjs/framework in this project or set POCKETJS_FRAMEWORK_ROOT",
    ));
    process.exit(1);
  }
  if (!which("bun")) {
    console.error(C.bad("bun not found — install Bun to compile an application package"));
    process.exit(1);
  }
  const r = spawnSync("bun", [join(root, "tools/pocket.ts"), cmd, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  process.exit(r.status ?? 1);
}

function passthrough(cmd, args) {
  passthroughScript(cmd, SCRIPTS[cmd], args);
}

function passthroughScript(cmd, script, args) {
  const root = findCheckout();
  if (!root) {
    console.error(C.bad(`\`pocket ${cmd}\` must run inside a PocketJS checkout`));
    process.exit(1);
  }
  if (!which("bun")) {
    console.error(C.bad("bun not found — run `pocket setup`"));
    process.exit(1);
  }
  const r = spawnSync("bun", [join(root, script), ...args], { stdio: "inherit", cwd: root });
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;
const HELP = `${C.bold("pocket")} — the PocketJS toolchain CLI

  pocket doctor            diagnose bun / Rust / PSP toolchain / PSPLINK
  pocket setup [--yes]     install what doctor found missing
  pocket create <name>     scaffold a pocket.json v2 app under apps/<name>
  pocket check --target T  validate pocket.json, target APIs and app types
  pocket check --host-profile FILE
                           validate against an ESP-IDF product host
  pocket compile --target T
                           check + emit JS/pak from one resolved build plan
  pocket build --target T  check + compile + package PSP or Vita artifacts
  pocket build --host-profile FILE
                           build a .pocket for an ESP-IDF product host
  pocket play vita <app>   build, install and launch a demo in Vita3K
  pocket play ios <app>    build, stage and launch a demo on the iOS simulator
  pocket dev <app>-main    build + serve an app in the browser
  pocket psp <app>         build the PSP EBOOT
  pocket vita <app>        build the PS Vita VPK
  pocket symbian <cmd>      Nokia E7 doctor/setup/build-probe/deploy
  pocket ios <cmd>         Apple iOS doctor/setup/build/play on the simulator
  pocket hw <app>          build + run on a real PSP over PSPLINK
  pocket psplink           interactive multi-app switcher on a real PSP
  pocket devtools [app]    DevTools panel + USB debug bridge (one command)
  pocket tape <cmd> …      record / replay / inspect input tapes headlessly
`;

switch (cmd) {
  case "doctor":
    doctor();
    break;
  case "setup":
    await setup();
    break;
  case "create":
    create(rest[0]);
    break;
  case "check":
  case "compile":
  case "build":
    manifestCommand(cmd, rest);
    break;
  case "dev":
  case "psp":
  case "vita":
  case "symbian":
  case "ios":
  case "hw":
  case "psplink":
  case "devtools":
  case "tape":
  case "play":
    passthrough(cmd, rest);
    break;
  case "--version":
  case "-v":
    console.log(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version);
    break;
  default:
    console.log(HELP);
    process.exitCode = cmd && cmd !== "--help" && cmd !== "help" ? 1 : 0;
}
