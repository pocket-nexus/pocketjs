import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ipodBundleFiles,
  stageIPodAssets,
} from "../tools/ipodtouch4-resources.ts";

test("nested assets are copied and every byte appears in the receipt file list", () => {
  const root = mkdtempSync(join(tmpdir(), "ipod-assets-"));
  try {
    const source = join(root, "assets"),
      bundle = join(root, "App.app");
    mkdirSync(join(source, "maps"), { recursive: true });
    mkdirSync(bundle);
    writeFileSync(join(source, "maps/dust.p3d"), Buffer.from([0, 1, 255]));
    writeFileSync(join(bundle, "Info.plist"), "generated");
    stageIPodAssets(source, bundle, "App");
    expect(ipodBundleFiles(bundle)).toEqual(["Info.plist", "maps/dust.p3d"]);
    expect(readFileSync(join(bundle, "maps/dust.p3d"))).toEqual(
      Buffer.from([0, 1, 255]),
    );
    for (const name of ["Info.plist", "App", "CodeResources"]) {
      writeFileSync(join(source, name), "replacement");
      expect(() => stageIPodAssets(source, bundle, "App")).toThrow(
        "replace generated",
      );
      rmSync(join(source, name));
    }
    expect(readFileSync(join(bundle, "Info.plist"), "utf8")).toBe("generated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("asset links and unsafe filenames fail before packaging", () => {
  const root = mkdtempSync(join(tmpdir(), "ipod-assets-"));
  try {
    writeFileSync(join(root, "texture"), "pixels");
    symlinkSync(join(root, "texture"), join(root, "linked"));
    expect(() => ipodBundleFiles(root)).toThrow("regular files");
    rmSync(join(root, "linked"));
    writeFileSync(join(root, "bad name"), "pixels");
    expect(() => ipodBundleFiles(root)).toThrow("invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
