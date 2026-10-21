import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
test("Buildroot preparation checks release bytes, source paths, vendor closure and profile identity", () => {
  const result = Bun.spawnSync(["python3", "tools/packaging/buildroot/test_prepare.py"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.success, `${result.signalCode}\n${result.stderr}`).toBe(true);
});
test("Buildroot compiles native Cargo and installs an independently compiled application", () => {
  const runtime = readFileSync(resolve(root, "tools/packaging/buildroot/package/pocketjs/pocketjs.mk"), "utf8");
  const app = readFileSync(resolve(root, "tools/packaging/buildroot/package/pocketjs-app/pocketjs-app.mk"), "utf8");
  expect(runtime).toContain("$(eval $(cargo-package))");
  expect(runtime).toContain("--package $(POCKETJS_PROGRAM)");
  expect(runtime).toContain("--features alsa");
  expect(runtime).not.toContain("bun ");
  expect(app).toContain("$(eval $(generic-package))");
  expect(app).toContain("$(TARGET_DIR)/usr/share/pocketjs/app.pocket");
});
