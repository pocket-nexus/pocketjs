import { expect,test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { resolveRuntimeProgram } from "../tools/build/programs.ts";
import { test3dsMinimal } from "../tools/test-3ds-minimal.ts";
const root = resolve(import.meta.dir, "..");
test("the 3ds alias and the 3ds-runtime profile id select the file-loaded program", async () => {
  const minimal = await resolveRuntimeProgram({ from: root, target: "3ds", generic: true });
  for (const target of ["3ds", "3ds-runtime"]) {
    const selected = await resolveRuntimeProgram({ from: root, target });
    expect(selected.config?.path).toBe(resolve(root, "programs/3ds/pocket.host.config.ts"));
    expect(selected.profile.id).toBe("3ds-runtime");
  }
  expect(minimal.config?.path).toBe(resolve(root, "programs/3ds/pocket.host.config.ts"));
  expect(minimal.profile.id).toBe("3ds-runtime");
  const declared = minimal.config?.value.build?.sourceInputs;
  const sources = typeof declared === "function" ? declared({ profile: minimal.profile,
    profileHash: minimal.profileHash, configDirectory: dirname(minimal.config!.path),
    invocationDirectory: root, outdir: root, output: minimal.profile.id, args: [] }) : declared ?? [];
  // Every declared source input is a path inside this repository that exists.
  for (const path of sources) expect(existsSync(path), path).toBe(true);
});
test.skipIf(!Bun.which("cc"))("minimal file program uses actual Runtime and generated guest through terminal destruction", () => {
  const out = resolve(root, `.pocket-build/validation/3ds-minimal/${Date.now()}-${process.pid}`);
  expect(test3dsMinimal(out)).toContain("terminal teardown and zero leaks passed");
}, 240_000);
