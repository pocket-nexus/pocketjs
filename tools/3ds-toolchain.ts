// Native 3DS compiler support shared by PocketJS and standalone hosts.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve as resolvePath } from "node:path";
const repository = fileURLToPath(new URL("..", import.meta.url));
export const THREE_DS_CONTAINER_IMAGE =
  "devkitpro/devkitarm@sha256:116afba8df8453961de2936ffab20dd441edf4d682856c1ec8b0e53d7ed0bbf5";
import { ensureQuickJsCheckout, quickJsCheckout, type QuickJsPin } from "./native-source.ts";

// Pin native C sources without resolving another device's Rust dependencies.
export const THREE_DS_QUICKJS_PIN: QuickJsPin = {
  repository: "https://github.com/pocket-nexus/quickjs-rs.git",
  revision: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
  version: "2026-06-04",
};
const QUICKJS_SOURCES = [
  "quickjs.c",
  "cutils.c",
  "libregexp.c",
  "libunicode.c",
  "dtoa.c",
] as const;
const QUICKJS_HEADERS = [
  "cutils.h",
  "dtoa.h",
  "libregexp-opcode.h",
  "libregexp.h",
  "libunicode-table.h",
  "libunicode.h",
  "list.h",
  "quickjs-atom.h",
  "quickjs-opcode.h",
  "quickjs.h",
] as const;

/** The devkitARM ABI, published by the toolchain itself in 3dsvars.sh. */
const ARM_ARCHITECTURE_FLAGS = [
  "-march=armv6k",
  "-mtune=mpcore",
  "-mfloat-abi=hard",
  "-mtp=soft",
  "-mword-relocations",
  "-ffunction-sections",
  "-fdata-sections",
];

// Verified to build a 1.3 MB libquickjs.a exporting 181 JS_* symbols.
// JS_NO_NAN_BOXING matches libquickjs-sys's own Vita treatment (16-byte
// JSValue on 32-bit ARM). __TM_GMTOFF is how newlib gates struct tm's
// tm_gmtoff, which js_date_getTimezoneOffset reads on every target that is
// neither __PSP__ nor __vita__ — and the same two macros are why malloc.h has
// to be force-included here rather than by quickjs.c itself. devkitARM ships
// GCC 16, which promoted incompatible pointer types to errors; this is the
// same source that builds for PSP.
const QUICKJS_COMPILE_FLAGS = [
  ...ARM_ARCHITECTURE_FLAGS,
  "-O2",
  "-D__3DS__",
  "-DCONFIG_VERSION='\"pocket3ds\"'",
  "-D_GNU_SOURCE",
  "-DJS_NO_NAN_BOXING",
  "-D__TM_GMTOFF=tm_gmtoff",
  "-include",
  "malloc.h",
  "-fno-strict-aliasing",
  "-funsigned-char",
  "-Wno-incompatible-pointer-types",
  "-Wno-implicit-function-declaration",
  "-I.",
];

export interface Mount {
  readonly hostPath: string;
  readonly containerPath: string;
}

/**
 * Translate a macOS path into the container path it is mounted at. Longest
 * mount wins so a nested output directory maps through its own mount.
 */
export function containerPathFor(
  hostPath: string,
  mounts: readonly Mount[],
): string {
  const absolute = resolvePath(hostPath);
  const candidates = [...mounts].sort(
    (a, b) => resolvePath(b.hostPath).length - resolvePath(a.hostPath).length,
  );
  for (const mount of candidates) {
    const base = resolvePath(mount.hostPath);
    if (absolute === base) return mount.containerPath;
    if (absolute.startsWith(`${base}/`)) {
      return `${mount.containerPath}${absolute.slice(base.length)}`;
    }
  }
  throw new Error(
    `PocketJS 3ds: ${absolute} is outside every container mount ` +
      `(${mounts.map((mount) => resolvePath(mount.hostPath)).join(", ")}); ` +
      "keep --outdir/--package-outdir inside the repository or the project root",
  );
}

/** Preamble every container script needs: the tools are not on PATH. */
const CONTAINER_PREAMBLE = [
  "set -euo pipefail",
  'export DEVKITPRO="${DEVKITPRO:-/opt/devkitpro}"',
  'export DEVKITARM="${DEVKITARM:-/opt/devkitpro/devkitARM}"',
  'export PATH="$DEVKITARM/bin:$DEVKITPRO/tools/bin:$PATH"',
].join("\n");

export async function runContainer(
  script: string,
  mounts: readonly Mount[],
  workingDirectory: string,
  environment: Readonly<Record<string, string>>,
  label: string,
  image = THREE_DS_CONTAINER_IMAGE,
): Promise<void> {
  const args = ["run", "--rm", "--network=none"];
  for (const mount of mounts) {
    args.push("-v", `${resolvePath(mount.hostPath)}:${mount.containerPath}`);
  }
  args.push("-w", workingDirectory);
  for (const [key, value] of Object.entries(environment)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(image, "bash", "-c", `${CONTAINER_PREAMBLE}\n${script}`);
  const child = Bun.spawn({
    cmd: ["docker", ...args],
    cwd: repository,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(
      `PocketJS 3ds: ${label} failed in ${image} (${exitCode})`,
    );
  }
}

/** Prepare the same verified checkout mechanism used by other native hosts. */
export function ensureQuickJsSources(
  checkout = join(homedir(), ".cache", "pocketjs", "sources", `quickjs-${THREE_DS_QUICKJS_PIN.revision}`),
): string {
  const root = resolvePath(checkout);
  ensureQuickJsCheckout("PocketJS 3ds", root, THREE_DS_QUICKJS_PIN);
  return quickJsCheckout(root).source;
}

/**
 * Compile QuickJS for the 3DS in the container and cache the archive. The
 * stamp covers the sources, the flag set and the container image, so a new
 * devkitARM release or an edited flag rebuilds and nothing else does.
 */
export async function ensureQuickJs(
  cacheDirectory: string,
  imageId: string,
  mounts: readonly Mount[],
): Promise<void> {
  const sources = ensureQuickJsSources();
  const files = [...QUICKJS_SOURCES, ...QUICKJS_HEADERS];
  const digest = createHash("sha256");
  digest.update(imageId);
  digest.update(QUICKJS_COMPILE_FLAGS.join(" "));
  for (const name of files) {
    const path = join(sources, name);
    if (!existsSync(path)) {
      throw new Error(`PocketJS 3ds: QuickJS source ${name} is missing from ${sources}`);
    }
    digest.update(name);
    digest.update(readFileSync(path));
  }
  const stamp = digest.digest("hex");
  const stampPath = join(cacheDirectory, ".stamp");
  const archive = join(cacheDirectory, "libquickjs.a");
  if (
    existsSync(archive) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp
  ) {
    console.log(`PocketJS 3ds: QuickJS cached (${archive})`);
    return;
  }

  mkdirSync(cacheDirectory, { recursive: true });
  for (const name of files) copyFileSync(join(sources, name), join(cacheDirectory, name));
  const objects = QUICKJS_SOURCES.map((name) => name.replace(/\.c$/, ".o"));
  const script = [
    "rm -f *.o libquickjs.a",
    `for src in ${QUICKJS_SOURCES.join(" ")}; do`,
    '  echo "cc $src"',
    `  arm-none-eabi-gcc ${QUICKJS_COMPILE_FLAGS.join(" ")} -c "$src" -o "\${src%.c}.o"`,
    "done",
    // D: deterministic archive (zeroed mtime/uid/gid), so the cache stamp and
    // the archive agree run to run.
    `arm-none-eabi-ar rcsD libquickjs.a ${objects.join(" ")}`,
  ].join("\n");
  console.log("PocketJS 3ds: compiling QuickJS for armv6k-nintendo-3ds …");
  await runContainer(
    script,
    mounts,
    containerPathFor(cacheDirectory, mounts),
    {},
    "QuickJS compile",
    imageId,
  );
  if (!existsSync(archive)) {
    throw new Error(`PocketJS 3ds: QuickJS compile did not produce ${archive}`);
  }
  writeFileSync(stampPath, `${stamp}\n`);
}
