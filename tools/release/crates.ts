import { resolve } from "node:path";
import { STABLE_RUST_TOOLCHAIN } from "../build/toolchains/rust.ts";

interface Dependency { name: string; path?: string; source?: string | null; req: string; kind: string | null; }
interface Package { id: string; name: string; version: string; publish: string[] | null; manifest_path: string; dependencies: Dependency[]; }
export interface CrateRelease { name: string; version: string; manifest: string; dependencies: string[]; gitDependencies: string[]; }
/** A publication plan is separate from uploads and registry availability. */
export function crateReleasePlan(root = resolve(import.meta.dir, "../..")): CrateRelease[] {
  const result = Bun.spawnSync(["cargo", "+" + STABLE_RUST_TOOLCHAIN, "metadata", "--locked", "--no-deps", "--format-version=1", "--manifest-path", resolve(root, "Cargo.toml")], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error("Cargo release metadata failed: " + result.stderr);
  const metadata = JSON.parse(result.stdout.toString()) as { packages: Package[]; workspace_members: string[] };
  const packages = new Map(metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id) && pkg.publish?.length !== 0).map(pkg => [pkg.name, pkg]));
  const output: CrateRelease[] = [], visited = new Set<string>(), active = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (active.has(name)) throw new Error("crate release dependency cycle: " + name);
    active.add(name);
    const pkg = packages.get(name)!;
    const dependencies = pkg.dependencies.filter(dep => dep.kind !== "dev" && dep.path && packages.has(dep.name)).map(dep => dep.name).sort();
    dependencies.forEach(visit);
    output.push({ name, version: pkg.version, manifest: pkg.manifest_path, dependencies,
      gitDependencies: pkg.dependencies.filter(dep => dep.source?.startsWith("git+")).map(dep => dep.name + " " + dep.source).sort() });
    active.delete(name); visited.add(name);
  };
  [...packages.keys()].sort().forEach(visit); return output;
}
if (import.meta.main) console.log(JSON.stringify(crateReleasePlan(), null, 2));
