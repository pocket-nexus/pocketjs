import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest source mtime, excluding generated build outputs and caches. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path));
    } else if (/\.(tsx?|rs|json|svg|toml)$/.test(entry.name) && !entry.name.endsWith(".generated.ts")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/** A cached PRX includes the guest, compiler, shared contracts, and native host. */
export function psplinkPrxStale(root: string, name: string, prx: string): boolean {
  if (!existsSync(prx)) return true;
  const built = statSync(prx).mtimeMs;
  const inputs = [
    join(root, "apps", name),
    join(root, "apps", `${name}-main.tsx`),
    join(root, "framework/src"),
    join(root, "framework/compiler"),
    join(root, "contracts/spec"),
    ...["core", "spec", "drivers", "raster", "present", "package", "modules/media"].flatMap(crate => [
      join(root, "engine", crate, "src"),
      join(root, "engine", crate, "Cargo.toml"),
    ]),
    join(root, "hosts/psp/src"),
    join(root, "hosts/psp/build.rs"),
    join(root, "hosts/psp/Cargo.toml"),
    join(root, "hosts/psp/Cargo.lock"),
    join(root, "pocket.config.ts"),
  ];
  return inputs.some(input => {
    const newest = existsSync(input) && statSync(input).isFile()
      ? statSync(input).mtimeMs
      : newestMtime(input);
    return newest > built;
  });
}
