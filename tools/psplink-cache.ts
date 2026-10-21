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
    } else if (/\.(tsx?|rs|c|h|json|svg|toml)$/.test(entry.name) && !entry.name.endsWith(".generated.ts")) {
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
    ...["core", "spec", "drivers", "runtime", "runtime-cabi", "raster", "present", "package", "modules/media", "render/draw-ops", "render/glyph-pages"].flatMap(crate => [
      join(root, "engine", crate, "src"),
      join(root, "engine", crate, "Cargo.toml"),
    ]),
    join(root, "engine/guest-quickjs/src"),
    join(root, "engine/guest-quickjs/include"),
    join(root, "contracts/generated"),
    join(root, "devices/psp/pocket-psp-render/src"),
    join(root, "devices/psp/pocket-psp-render/Cargo.toml"),
    join(root, "devices/psp/pocket-psp-ge/src"),
    join(root, "devices/psp/pocket-psp-ge/Cargo.toml"),
    join(root, "tools/psp.ts"),
    join(root, "tools/build/psp/embed.rs"),
    join(root, "tools/build/toolchains/psp"),
    join(root, "tools/build/toolchains/psp.ts"),
    join(root, "tools/build/toolchains/rust.ts"),
    join(root, "tools/psp-linker.ts"),
    join(root, "platforms/psp"),
    join(root, "programs/psp/src"),
    join(root, "programs/psp/build.rs"),
    join(root, "programs/psp/Cargo.toml"),
    join(root, "Cargo.lock"),
    join(root, "profiles/psp.ts"),
  ];
  return inputs.some(input => {
    const newest = existsSync(input) && statSync(input).isFile()
      ? statSync(input).mtimeMs
      : newestMtime(input);
    return newest > built;
  });
}
