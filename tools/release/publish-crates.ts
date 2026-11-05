import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { STABLE_RUST_TOOLCHAIN } from "../build/toolchains/rust.ts";

const CRATES = [
  "pocket-spec", "pocket-drivers", "pocket-render", "pocket-draw-ops",
  "pocket-glyph-pages", "pocket-tex-cache", "pocket-media", "pocket-package", "pocket-raster",
  "pocket-present", "pocketjs-core", "pocket-runtime", "pocket-guest-rquickjs",
  "pocket-driver-kit", "pocket-sim",
];
const REPOSITORY = "https://github.com/pocket-nexus/pocketjs";
const root = resolve(import.meta.dir, "../..");
const cargo = ["rustup", "run", STABLE_RUST_TOOLCHAIN, "cargo"];

interface Package {
  id: string;
  name: string;
  version: string;
  publish: string[] | null;
  dependencies: { name: string; path?: string; source?: string | null }[];
}

function output(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`${command.slice(0, 4).join(" ")} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

async function published(pkg: Package): Promise<boolean> {
  const response = await fetch(`https://crates.io/api/v1/crates/${pkg.name}`, {
    headers: { "User-Agent": `PocketJS-crate-release (${REPOSITORY})` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Registry lookup for ${pkg.name}: HTTP ${response.status}`);
  const data = await response.json() as {
    crate: { repository: string | null };
    versions: { num: string; yanked: boolean }[];
  };
  if (data.crate.repository?.replace(/\.git\/?$/, "").replace(/\/$/, "") !== REPOSITORY) {
    throw new Error(`${pkg.name} is registered to another repository`);
  }
  const version = data.versions.find(item => item.num === pkg.version);
  if (version?.yanked) throw new Error(`${pkg.name}@${pkg.version} is yanked; choose a new version`);
  return version !== undefined;
}

async function main() {
  const [mode, version, ...extra] = Bun.argv.slice(2);
  if (!["plan", "dry-run", "publish"].includes(mode ?? "") || extra.length) {
    throw new Error("Usage: bun tools/release/publish-crates.ts <plan|dry-run|publish> [version]");
  }
  const metadata = JSON.parse(output([...cargo, "metadata", "--locked", "--no-deps", "--format-version=1"])) as {
    packages: Package[]; workspace_members: string[];
  };
  const packages = new Map(metadata.packages
    .filter(pkg => metadata.workspace_members.includes(pkg.id) && CRATES.includes(pkg.name))
    .map(pkg => [pkg.name, pkg]));
  for (const name of CRATES) {
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`Missing workspace crate: ${name}`);
    if (version !== undefined && pkg.version !== version) throw new Error(`${name} must have version ${version}`);
    if (pkg.publish !== null && !pkg.publish.includes("crates-io")) {
      throw new Error(`${name} does not permit publication to crates.io`);
    }
    for (const dep of pkg.dependencies) {
      if (dep.source?.startsWith("git+")) throw new Error(`${name} has a git dependency: ${dep.name}`);
      if (dep.path && !packages.has(dep.name)) throw new Error(`${name} depends on an unselected crate: ${dep.name}`);
    }
  }
  // Include development dependencies: Cargo retains them in packaged manifests.
  const ordered: Package[] = [], visited = new Set<string>(), active = new Set<string>();
  function visit(name: string) {
    if (visited.has(name)) return;
    if (active.has(name)) throw new Error(`Publication dependency cycle: ${name}`);
    active.add(name);
    const pkg = packages.get(name)!;
    for (const dep of pkg.dependencies) if (dep.path) visit(dep.name);
    active.delete(name);
    visited.add(name);
    ordered.push(pkg);
  }
  CRATES.forEach(visit);

  const pending: Package[] = [];
  for (const pkg of ordered) {
    const exists = await published(pkg);
    console.log(`${pkg.name}@${pkg.version}: ${exists ? "already published" : "pending"}`);
    if (!exists) pending.push(pkg);
  }
  if (mode === "plan") {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending.length}\n`);
    return;
  }
  if (pending.length === 0) {
    console.log("All 15 crate versions are already published.");
    return;
  }
  if (output(["git", "status", "--porcelain"])) throw new Error("Publish from a clean working tree");
  const command = [...cargo, "publish", "--registry", "crates-io",
    ...pending.flatMap(pkg => ["-p", pkg.name])];
  if (mode === "dry-run") command.push("--dry-run");
  // Cargo orders workspace uploads and waits for dependencies to reach the index.
  const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Cargo publication failed; rerun to resume unpublished versions");
  if (mode === "publish") {
    for (const pkg of ordered) {
      if (!await published(pkg)) throw new Error(`${pkg.name}@${pkg.version} is not visible on crates.io`);
    }
    console.log("All 15 selected crate versions are available on crates.io.");
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
