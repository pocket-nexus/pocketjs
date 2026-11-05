import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startBridge } from "../tools/devtools-bridge.ts";

function directory() {
  const base = resolve(import.meta.dir, "../.pocket-build/validation/devtools-package");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, "run-"));
}
test("invalid explicit inputs fail before mailbox creation and both CLIs require the package argument", () => {
  const dir = directory(), missing = resolve(dir, "missing.pocket");
  expect(() => startBridge({ dir, port: 1, packagePath: missing })).toThrow();
  expect(existsSync(resolve(dir, "pocketjs-dbg/enable"))).toBe(false);
  writeFileSync(missing, "not a package");
  expect(() => startBridge({ dir, port: 1, packagePath: missing })).toThrow();
  for (const script of ["tools/devtools.ts", "tools/devtools-psp.ts"]) {
    const result = Bun.spawnSync([process.execPath, script, "--pocket"],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(result.success).toBe(false);
    expect(result.stderr.toString()).toContain("--pocket requires");
  }
});
