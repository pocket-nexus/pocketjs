// The seam a program outside this repository uses to add a product extension to the
// 3DS product: its build arguments, its C interface, and its link features.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse3dsArguments } from "../products/3ds/build.ts";
import { Companion, type LinkExtensionSession } from "../tools/companion/server.ts";
import { CompanionStore } from "../tools/companion/store.ts";

const product = resolve(import.meta.dir, "../products/3ds");

describe("3DS product extensions", () => {
  test("the build takes the extension's directories", () => {
    const args = parse3dsArguments(["an-app", "--extension=/a/extension", "--extension-romfs=/a/romfs"]);
    expect(args.extensionDir).toBe("/a/extension");
    expect(args.extensionRomfs).toBe("/a/romfs");
    expect(args.cargoArgs).toEqual([]);
    expect(parse3dsArguments(["an-app"]).extensionDir).toBeUndefined();
  });

  test("every function the product calls is in the interface", () => {
    const header = readFileSync(join(product, "include/pocket_extension.h"), "utf8");
    for (const file of ["main.c", "gfx.c", "qjs.c", "services_host.c"]) {
      const called = readFileSync(join(product, "src", file), "utf8").match(/pocket_extension_\w+(?=\()/g) ?? [];
      expect(called.length).toBeGreaterThan(0);
      for (const name of called) expect(header).toContain(`${name}(`);
    }
  });

  test("a link extension adds its feature and stops with the companion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "link-extension-"));
    let stops = 0;
    const session: LinkExtensionSession = { handle() {}, data: () => false, detach() {} };
    const companion = new Companion({
      store: new CompanionStore(dir),
      appsDirs: [],
      agent: false,
      extensions: [({ storeDir }) => {
        expect(storeDir).toBe(dir);
        return { feature: "a-feature", attach: () => session, stop: () => { stops += 1; } };
      }],
      log() {},
    } as any);
    expect(companion.features()).toContain("a-feature");
    await companion.stop();
    expect(stops).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
