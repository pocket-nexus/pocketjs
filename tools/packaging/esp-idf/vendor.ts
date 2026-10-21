import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

type Table = Record<string, any>;
const parse = (file: string): Table => Bun.TOML.parse(readFileSync(file, "utf8"));
function run(args: string[], cwd: string): string {
  const child = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (!child.success) throw new Error(`${args.join(" ")} failed: ${child.stderr.toString()}`);
  return child.stdout.toString();
}
function toml(value: any): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  return `{ ${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(", ")} }`;
}
function workspace(file: string, manifest: Table): { directory: string; value: Table } {
  let directory = manifest.package?.workspace ? resolve(dirname(file), manifest.package.workspace) : dirname(file);
  for (;;) {
    const path = join(directory, "Cargo.toml");
    if (existsSync(path)) { const value = parse(path); if (value.workspace) return { directory, value: value.workspace }; }
    const parent = dirname(directory); if (parent === directory) return { directory: dirname(file), value: {} }; directory = parent;
  }
}
function dependencies(manifest: Table): Table[] {
  return [manifest, ...Object.values(manifest.target ?? {}) as Table[]]
    .flatMap(table => [table.dependencies, table["build-dependencies"], table["dev-dependencies"]]).filter(Boolean);
}
function explicitManifest(file: string): Table {
  const result = parse(file), owner = workspace(file, result);
  if (result.package) {
    delete result.package.workspace;
    for (const [key, value] of Object.entries(result.package)) {
      if (value && typeof value === "object" && (value as Table).workspace) {
        if (owner.value.package?.[key] === undefined) throw new Error(`unresolved package inheritance ${file}: ${key}`);
        result.package[key] = structuredClone(owner.value.package[key]);
      }
    }
  }
  for (const table of dependencies(result)) for (const [name, original] of Object.entries(table)) {
    if (!original || typeof original !== "object") continue;
    let dep = original as Table, base = dirname(file);
    if (dep.workspace) {
      const shared = owner.value.dependencies?.[name];
      if (!shared) throw new Error(`unresolved dependency inheritance ${file}: ${name}`);
      dep = { ...(typeof shared === "string" ? { version: shared } : shared), ...dep,
        features: [...new Set([...(typeof shared === "object" ? shared.features ?? [] : []), ...dep.features ?? []])] };
      delete dep.workspace; base = owner.directory; table[name] = dep;
    }
    if (dep.path) dep.path = resolve(base, dep.path);
  }
  if (result.lints?.workspace) result.lints = structuredClone(owner.value.lints ?? {});
  delete result.workspace;
  // The standalone exported program owns the release policy below.
  delete result.profile;
  return result;
}

function localManifests(program: string): Map<string, Table> {
  const manifests = new Map<string, Table>();
  const collect = (file: string) => {
    file = resolve(file); if (manifests.has(file)) return;
    const manifest = explicitManifest(file); manifests.set(file, manifest);
    for (const table of dependencies(manifest)) for (const value of Object.values(table))
      if (value && typeof value === "object" && (value as Table).path) collect(join((value as Table).path, "Cargo.toml"));
  };
  collect(program);
  return manifests;
}
/** All local package roots, including optional/target/build dependencies. */
export function idfProgramCrateRoots(root: string, crate = "runtime"): string[] {
  return [...localManifests(resolve(root, `hosts/esp-idf/native/${crate}/Cargo.toml`)).keys()].map(dirname);
}

/** Discover local dependencies from Cargo manifests; Cargo vendors registry/git crates. */
export function vendorIdfProgram(root: string, destination: string, cargo = "cargo"): void {
  destination = resolve(destination);
  const program = resolve(root, "hosts/esp-idf/native/runtime/Cargo.toml");
  const sourceWorkspace = workspace(program, parse(program)).directory;
  const manifests = localManifests(program);
  const directories = new Map([...manifests].map(([file, value]) => [dirname(file), file === program ? "native" : `packages/${value.package.name}`]));
  if (new Set(directories.values()).size !== directories.size) throw new Error("duplicate local package names in IDF program closure");
  const ignored = new Set(["target", ".git", ".pocket-build", "dist", "node_modules", "Cargo.lock"]);
  for (const [file, manifest] of manifests) {
    const output = join(destination, directories.get(dirname(file))!); mkdirSync(output, { recursive: true });
    cpSync(dirname(file), output, { recursive: true, filter: source => !ignored.has(basename(source)) && !basename(source).startsWith("target-") });
    for (const table of dependencies(manifest)) for (const value of Object.values(table)) if (value && typeof value === "object" && (value as Table).path)
      (value as Table).path = relative(output, join(destination, directories.get((value as Table).path)!)).replaceAll("\\", "/");
    writeFileSync(join(output, "Cargo.toml"), Object.entries(manifest).map(([key, value]) => `${JSON.stringify(key)} = ${toml(value)}\n`).join(""));
  }
  const members = [...directories.values()];
  writeFileSync(join(destination, "Cargo.toml"), `workspace = ${toml({ members, resolver: "2" })}\nprofile.release = ${toml({ "codegen-units": 16, lto: false, "opt-level": 3, panic: "abort" })}\n`);
  cpSync(join(sourceWorkspace, "Cargo.lock"), join(destination, "Cargo.lock"));
  // Prune unrelated workspace lock entries without changing existing versions.
  run([cargo, "metadata", "--offline", "--format-version", "1", "--manifest-path", join(destination, "Cargo.toml")], destination);
  const config = run([cargo, "vendor", "--locked", "--versioned-dirs", "crates"], destination);
  mkdirSync(join(destination, ".cargo"), { recursive: true });
  writeFileSync(join(destination, ".cargo/config.toml"), config + "\n[net]\noffline = true\n");
  const sourceFiles: string[] = [];
  const scan = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name); if (entry.isDirectory()) scan(path); else if (entry.isFile()) sourceFiles.push(relative(destination, path).replaceAll("\\", "/"));
  } };
  scan(destination);
  writeFileSync(join(destination, "sources.json"), JSON.stringify(sourceFiles.sort(), null, 2) + "\n");
  run([cargo, "metadata", "--offline", "--locked", "--format-version", "1"], destination);
}
