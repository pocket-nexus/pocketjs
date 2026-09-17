import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSymbianNavigation } from "../tools/symbian-navigation.ts";

const shell = { uid: "0xEA360236", id: "shell", output: "shell", title: "Pocket Shell" };
const clear = { uid: "0xE16ACD8E", id: "clear", output: "clear", title: "Pocket Clear", orientation: "portrait" };
test("native navigation is bounded, unique and includes the current package", () => {
  const config = { shell: shell.uid, apps: [clear, shell] };
  expect(encodeSymbianNavigation(config, clear.uid).split("\n")[0]).toBe("0xEA360236\tshell\tshell\tPocket Shell\tauto");
  for (const apps of [[shell, shell], [shell, { ...clear, title: "bad\nrow" }], [shell, { ...clear, uid: "0x10000000" }],
    [shell, { ...clear, output: shell.output }], [shell, { ...clear, orientation: "sideways" }], [shell, { ...clear, id: undefined }], [shell, { ...clear, output: undefined }]]) {
    expect(() => encodeSymbianNavigation({ ...config, apps }, shell.uid)).toThrow();
  }
  expect(() => encodeSymbianNavigation(config, "0xE1234567")).toThrow();
  expect(() => encodeSymbianNavigation({ ...config, shell: "0xE1234567" }, shell.uid)).toThrow();
});

test("native return contacts reserve the bar and distinguish a swipe from a hold", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-nav-"));
  try {
    const header = new URL("../hosts/nokia-e7/runtime/pocketjs_navigation_gesture.h", import.meta.url).pathname;
    writeFileSync(join(root, "test.cpp"), `#include <assert.h>
#include "${header}"
int main() {
  for (int h = 360; h <= 640; h += 280) {
    PocketJsNavigationGesture g;
    assert(!g.begin(1, 180, h - 40, h, 0));
    assert(g.begin(1, 180, h - 12, h, 0));
    g.move(180, h - 100, 100);
    assert(g.release(110) == 1);
    assert(g.release(340) == 2);
    g.cancelled = true; assert(g.release(400) == 0);
    g.begin(2, 180, h - 12, h, 0);
    g.move(260, h - 25, 100); assert(g.release(500) == 0);
    g.begin(2, 180, h - 12, h, 0); assert(g.release(100) == 1);
    g.move(180, h - 25, 200); assert(g.release(500) == 0);
    g.reset(); assert(!g.owned && g.lift() == 0);
  }
}`);
    const build = Bun.spawnSync(["c++", "-std=c++98", "-Wall", "-Wextra", "-Werror", join(root, "test.cpp"), "-o", join(root, "test")]);
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([join(root, "test")]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
