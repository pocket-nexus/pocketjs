// Native Pocket Runtime E2E: a valid pending `.pocket` becomes active only
// after a frame retires; a second package that throws during eval is retained
// as an immutable blob but the previously accepted package boots again.

import { $ } from "bun";
import { evidenceDirectory } from "./build.ts";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  POCKET_SECTION,
  decodePocketPackage,
  encodePocketPackage,
} from "../../contracts/spec/pocket-package.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = evidenceDirectory(ROOT, "azahar-runtime");
const FIXTURE_HOME = join(OUT, "home");
const USER_DIR = join(FIXTURE_HOME, "Library/Application Support/Azahar");
const CONFIG = join(USER_DIR, "config/qt-config.ini");
const RUNTIME_DIR = join(USER_DIR, "sdmc/pocketjs/runtime");
const PENDING = join(RUNTIME_DIR, "pending.pocket");
const STATUS = join(RUNTIME_DIR, "status.txt");
const LAST_ERROR = join(RUNTIME_DIR, "last-error.txt");
const STATE_DIR = join(RUNTIME_DIR, "state");
const PACKAGES_DIR = join(RUNTIME_DIR, "packages");
const CONSOLE_LOG = join(OUT, "azahar-console.log");
const azaharApp = process.env.AZAHAR || "/Applications/Azahar.app";
const azaharBinary = join(azaharApp, "Contents/MacOS/azahar");
const sourceConfig =
  process.env.AZAHAR_CONFIG ||
  join(homedir(), "Library/Application Support/Azahar/config/qt-config.ini");
const sourceUserDir = sourceConfig.replace(/\/config\/[^/]+$/, "");
const timeoutMs = Number(process.env.E2E_AZAHAR_TIMEOUT_MS ?? 60_000);

function fail(message: string): never {
  console.error(`FAIL 3DS Pocket Runtime: ${message}`);
  process.exit(1);
}

if (process.platform !== "darwin") fail("Azahar runtime E2E is macOS-only");
if (!existsSync(azaharBinary)) fail(`Azahar not found at ${azaharApp}`);
if (!existsSync(sourceConfig)) fail(`Azahar config not found at ${sourceConfig}`);

function setConfig(config: string, key: string, value: string): string {
  const assignment = new RegExp(`^${key}=.*$`, "gm");
  if ((config.match(assignment)?.length ?? 0) !== 1) {
    throw new Error(`qt-config.ini does not carry exactly one ${key}`);
  }
  let next = config.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}`);
  next = new RegExp(`^${key}\\\\default=.*$`, "m").test(next)
    ? next.replace(new RegExp(`^${key}\\\\default=.*$`, "m"), () => `${key}\\default=false`)
    : next.replace(
        new RegExp(`^${key}=.*$`, "m"),
        () => `${key}=${value}\n${key}\\default=false`,
      );
  return next;
}

function writeFixture(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(USER_DIR, "config"), { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const directory of ["nand", "sysdata"]) {
    const source = join(sourceUserDir, directory);
    if (existsSync(source)) cpSync(source, join(USER_DIR, directory), { recursive: true });
  }
  let config = readFileSync(sourceConfig, "utf8");
  config = setConfig(config, "graphics_api", "0");
  config = setConfig(config, "resolution_factor", "1");
  config = setConfig(config, "use_vsync", "false");
  config = setConfig(config, "frame_limit", "1000");
  config = setConfig(config, "check_for_update_on_start", "false");
  writeFileSync(CONFIG, config);
}

function killEmulator(): void {
  Bun.spawnSync(["pkill", "-9", "-f", azaharBinary], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function launchUntil(rom: string, accept: () => boolean): Promise<void> {
  rmSync(STATUS, { force: true });
  rmSync(LAST_ERROR, { force: true });
  killEmulator();
  const launch = Bun.spawnSync(
    [
      "open",
      "-n",
      "-a",
      azaharApp,
      "--env",
      `HOME=${FIXTURE_HOME}`,
      "--stdout",
      CONSOLE_LOG,
      "--stderr",
      CONSOLE_LOG,
      "--args",
      rom,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (launch.exitCode !== 0) throw new Error(launch.stderr.toString().trim());
  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      if (accept()) return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out after ${timeoutMs} ms; status=${
      existsSync(STATUS) ? readFileSync(STATUS, "utf8").trim() : "missing"
    }`);
  } finally {
    killEmulator();
  }
}

function packageHash(bytes: Uint8Array): string {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getBigUint64(bytes.byteLength - 8, true)
    .toString(16)
    .padStart(16, "0");
}

function badEvalPackage(good: Uint8Array): Uint8Array {
  const packageValue = decodePocketPackage(good);
  const javascript = new TextEncoder().encode(
    'throw new Error("Pocket Runtime rollback probe");\0',
  );
  return encodePocketPackage({
    manifest: packageValue.manifest,
    variants: packageValue.variants.map((variant) => ({
      ...variant,
      sections: variant.sections.map((section) =>
        section.kind === POCKET_SECTION.js ? { ...section, bytes: javascript } : section,
      ),
    })),
  });
}

try {
  const build = await $`bun tools/3ds.ts 3ds-demo`.cwd(ROOT).quiet().nothrow();
  if (build.exitCode !== 0) fail(`build failed\n${build.stdout}${build.stderr}`);
  const rom = join(ROOT, "dist/3ds/pocket3ds-demo-main.3dsx");
  const pocket = join(ROOT, "dist/3ds/pocket3ds-demo-main.pocket");
  writeFixture();

  const good = new Uint8Array(readFileSync(pocket));
  const goodHash = packageHash(good);
  writeFileSync(PENDING, good);
  await launchUntil(rom, () => {
    if (!existsSync(STATUS)) return false;
    const status = readFileSync(STATUS, "utf8");
    return status.includes("phase=accepted") &&
      status.includes(`active=${goodHash}`) && status.includes(`running=${goodHash}`);
  });
  if (existsSync(PENDING)) throw new Error("accepted pending package was not consumed");
  if (!existsSync(join(PACKAGES_DIR, `${goodHash}.pocket`))) {
    throw new Error("accepted immutable package blob is missing");
  }
  const firstStates = readdirSync(STATE_DIR).filter((name) => name.endsWith(".commit"));
  if (firstStates.length !== 1) throw new Error(`expected one state generation, got ${firstStates}`);
  console.log(`PASS accepted ${goodHash} after a retired frame`);

  const bad = badEvalPackage(good);
  const badHash = packageHash(bad);
  writeFileSync(PENDING, bad);
  await launchUntil(rom, () => {
    if (!existsSync(STATUS) || !existsSync(LAST_ERROR)) return false;
    const status = readFileSync(STATUS, "utf8");
    const error = readFileSync(LAST_ERROR, "utf8");
    return status.includes("phase=booted") && status.includes(`active=${goodHash}`) &&
      status.includes(`running=${goodHash}`) && error.includes("Pocket Runtime rollback probe");
  });
  if (!existsSync(join(PACKAGES_DIR, `${badHash}.pocket`))) {
    throw new Error("rejected package was not retained as an immutable blob");
  }
  const finalStates = readdirSync(STATE_DIR).filter((name) => name.endsWith(".commit"));
  if (finalStates.length !== 1) {
    throw new Error(`failed candidate changed active generation: ${finalStates}`);
  }
  console.log(`PASS rejected ${badHash} and restored ${goodHash}`);
  console.log("Azahar Pocket Runtime E2E: 2 passed, 0 failed");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
