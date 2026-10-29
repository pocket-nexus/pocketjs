import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const RELEASE_VERSION_FILES = [
  "package.json",
  "tools/cli/package.json",
  "apps/hero/pocket.json",
] as const;

export interface ReleaseVersionCheck {
  version: string;
  files: ReadonlyArray<{ path: string; version: string }>;
}

export function normalizeReleaseVersion(input: string): string {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!SEMVER.test(version)) {
    throw new Error(
      `invalid release version ${JSON.stringify(input)}; expected a SemVer such as 0.4.0 or v0.4.0`,
    );
  }
  return version;
}

async function readVersion(root: string, path: string): Promise<string> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${path}: ${reason}`);
  }

  const version = typeof document === "object" && document !== null
    ? (document as { version?: unknown }).version
    : undefined;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`${path} must contain a valid SemVer string at .version`);
  }
  return version;
}

export async function checkReleaseVersion(
  input: string,
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
): Promise<ReleaseVersionCheck> {
  const version = normalizeReleaseVersion(input);
  const files = await Promise.all(RELEASE_VERSION_FILES.map(async (path) => ({
    path,
    version: await readVersion(root, path),
  })));
  const mismatches = files.filter((file) => file.version !== version);
  if (mismatches.length > 0) {
    throw new Error([
      `release version ${version} does not match every release artifact:`,
      ...mismatches.map((file) => `  ${file.path}: ${file.version}`),
    ].join("\n"));
  }
  return { version, files };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 1) {
      throw new Error("usage: bun tools/release-check.ts <version|v-tag>");
    }
    const checked = await checkReleaseVersion(args[0]!);
    console.log(
      `release ${checked.version} verified across ${checked.files.map((file) => file.path).join(", ")}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
