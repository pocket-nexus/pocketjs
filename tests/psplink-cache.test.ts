import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { psplinkPrxStale } from "../tools/psplink-cache.ts";

test("cached PSP PRXs rebuild when extracted contract sources or dependencies change", () => {
  const root = mkdtempSync(join(tmpdir(), "pocketjs-prx-cache-"));
  const built = new Date("2026-01-02T00:00:00Z");
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-01-03T00:00:00Z");
  const file = (path: string, time: Date) => {
    const output = join(root, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, "fixture\n");
    utimesSync(output, time, time);
    return output;
  };
  try {
    const prx = join(root, "cached.prx");
    expect(psplinkPrxStale(root, "demo", prx)).toBe(true);
    file("cached.prx", built);
    file("apps/demo/main.tsx", older);
    expect(psplinkPrxStale(root, "demo", prx)).toBe(false);
    for (const source of [
      "engine/spec/src/lib.rs", "engine/spec/Cargo.toml",
      "engine/drivers/src/draw.rs", "engine/drivers/src/resources.rs", "engine/drivers/Cargo.toml",
      "engine/raster/src/lib.rs", "engine/raster/Cargo.toml",
      "engine/present/src/lib.rs", "engine/present/Cargo.toml",
      "engine/package/src/lib.rs", "engine/package/Cargo.toml",
      "engine/modules/media/src/lib.rs", "engine/modules/media/Cargo.toml",
      "engine/render/draw-ops/src/lib.rs", "engine/render/draw-ops/Cargo.toml",
      "engine/render/glyph-pages/src/lib.rs", "engine/render/glyph-pages/Cargo.toml",
      "engine/runtime/src/lib.rs", "engine/runtime/Cargo.toml",
      "engine/runtime-cabi/src/guest.rs", "engine/runtime-cabi/Cargo.toml",
      "engine/profile-build/src/lib.rs", "engine/profile-build/Cargo.toml", "tools/profile-export.ts",
      "engine/guest-quickjs/src/guest.c", "engine/guest-quickjs/src/generated_ops.h",
      "engine/guest-quickjs/include/pocket_guest_quickjs.h", "contracts/generated/pocket_runtime.h",
      "devices/psp/pocket-psp-render/src/encode.rs", "devices/psp/pocket-psp-render/Cargo.toml",
      "devices/psp/pocket-psp-ge/src/lib.rs", "devices/psp/pocket-psp-ge/Cargo.toml",
      "platforms/psp/alloc/src/arena.rs", "platforms/psp/io/src/local.rs", "platforms/psp/system/fpu.c",
      "platforms/psp/audio/Cargo.toml", "platforms/psp/system/build.rs",
      "programs/psp/src/quickjs_bridge.c", "tools/build/toolchains/psp/build.ts", "tools/psp-linker.ts", "tools/psp.ts",
      "tools/build/embedded-apps.rs",
      "tools/build/toolchains/psp.ts", "tools/build/toolchains/rust.ts",
      "tools/build/toolchains/psp/mipsel-sony-psp.json",
      "engine/core/Cargo.toml", "programs/psp/Cargo.toml", "Cargo.lock",
    ]) {
      const changed = file(source, newer);
      expect(psplinkPrxStale(root, "demo", prx), source).toBe(true);
      utimesSync(changed, older, older);
      expect(psplinkPrxStale(root, "demo", prx), source).toBe(false);
    }
    file("engine/drivers/target/build/metadata.json", newer);
    expect(psplinkPrxStale(root, "demo", prx)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
