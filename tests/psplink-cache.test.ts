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
      "engine/core/Cargo.toml", "hosts/psp/Cargo.toml", "hosts/psp/Cargo.lock",
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
