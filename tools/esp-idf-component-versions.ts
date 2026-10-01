import { readFileSync } from "node:fs";
import { join } from "node:path";

export function verifyComponentVersions(root: string): string[] {
  const components = join(root, "hosts/esp-idf/components");
  const releases = JSON.parse(readFileSync(join(components, "versions.json"), "utf8")) as
    Record<string, { version: string; requires: Record<string, string> }>;
  for (const [name, release] of Object.entries(releases)) {
    if (!/^pocketjs_[a-z0-9_]+$/.test(name) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version))
      throw new Error(`invalid component release: ${name}`);
    const manifest = Bun.YAML.parse(readFileSync(join(components, name, "idf_component.yml"), "utf8")) as
      { version: string; dependencies?: Record<string, unknown> };
    if (manifest.version !== release.version) throw new Error(`component version drift: ${name}`);
    const internal = Object.fromEntries(Object.entries(manifest.dependencies ?? {})
      .filter(([key]) => key.startsWith("pocket-nexus/pocketjs_"))
      .map(([key, value]) => [key.slice("pocket-nexus/".length), value]));
    if (Object.keys(internal).length !== Object.keys(release.requires).length)
      throw new Error(`component dependency drift: ${name}`);
    for (const [dependency, range] of Object.entries(release.requires)) {
      if (internal[dependency] !== range || !releases[dependency] ||
          !Bun.semver.satisfies(releases[dependency].version, range))
        throw new Error(`component dependency version drift: ${name} -> ${dependency}`);
    }
  }
  return Object.keys(releases);
}
