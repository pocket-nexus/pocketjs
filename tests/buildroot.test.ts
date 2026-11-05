import { expect, test } from "bun:test";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
test("Buildroot preparation checks release bytes, source paths, vendor closure and profile identity", () => {
  const result = Bun.spawnSync(["python3", "tools/packaging/buildroot/test_prepare.py"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.success, `${result.signalCode}\n${result.stderr}`).toBe(true);
});
