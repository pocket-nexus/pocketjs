// The seam a program outside this repository uses to add a product extension to the
// 3DS product: its build arguments and its C interface. The link side of an
// extension (LinkExtensionFactory) is tested in Pocket Hub.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse3dsArguments } from "../products/3ds/build.ts";

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
});
