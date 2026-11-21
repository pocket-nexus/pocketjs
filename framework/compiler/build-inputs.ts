import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Build-time dependency collection. The application graph comes from the
 * bundler; resource bakers explicitly report files they read. */
export class BuildInputs {
  private readonly files = new Set<string>();
  add(path: string): void {
    const absolute = resolve(path);
    if (absolute.endsWith("/framework/src/styles.generated.ts")) return;
    if (existsSync(absolute)) this.files.add(absolute);
  }
  optional(path: string): void {
    if (existsSync(path)) { this.add(path); return; }
    // Creation of a previously missing image/config can change the build
    // without an importer edit. Track the nearest existing directory.
    let parent = dirname(resolve(path));
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    this.add(parent);
  }
  metafile(meta: Bun.BuildMetafile | undefined): void {
    if (!meta) throw new Error("PocketJS dependency tracking requires bundler metafile support");
    for (const file of Object.keys(meta.inputs)) {
      if (!existsSync(file)) continue; // generated helper namespaces
      this.add(file);
      let directory = dirname(resolve(file));
      while (dirname(directory) !== directory) {
        if (existsSync(resolve(directory, "package.json"))) { this.add(resolve(directory, "package.json")); break; }
        directory = dirname(directory);
      }
    }
  }
  async compiler(entrypoints: string[], frameworkRoot: string): Promise<void> {
    const result = await Bun.build({ entrypoints, root: process.cwd(), target: "bun", packages: "external", metafile: true });
    if (!result.success) throw new Error("cannot resolve compiler dependency graph: " + result.logs.join("\n"));
    this.metafile(result.metafile);
    for (const [path, input] of Object.entries(result.metafile!.inputs)) {
      for (const imported of input.imports) {
        if (!imported.external || imported.path.startsWith("node:") || imported.path === "bun") continue;
        try {
          const entry = Bun.resolveSync(imported.path, dirname(resolve(path)));
          if (!existsSync(entry)) continue;
          this.add(entry);
          let dir = dirname(entry);
          while (dirname(dir) !== dir) {
            const receipt = resolve(dir, "package.json");
            if (existsSync(receipt)) { this.add(receipt); break; }
            dir = dirname(dir);
          }
        } catch { /* optional platform-specific compiler dependencies */ }
      }
    }
    this.add(process.execPath);
    for (const name of ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
      this.optional(resolve(frameworkRoot, name));
  }
  paths(): string[] { return [...this.files].sort(); }
}

export function depfile(target: string, inputs: readonly string[]): string {
  const escape = (value: string): string => {
    if (/[\r\n]/.test(value)) throw new Error("newline in build dependency path");
    return value.replace(/\\/g, "\\\\").replace(/\$/g, () => "$$").replace(/[ #:\t]/g, c => "\\" + c);
  };
  return `${escape(resolve(target))}: ${[...new Set(inputs.map(p => resolve(p)))].sort().map(escape).join(" \\\n  ")}\n`;
}
