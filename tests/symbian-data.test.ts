import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYMBIAN_MASS_STORAGE_FILES,
  SYMBIAN_MASS_STORAGE_MANIFEST,
  SYMBIAN_MASS_STORAGE_STAGE,
  assertSymbianMassStorageDataStageSeparation,
  resolveSymbianMassStorageDataRoot,
  stageSymbianMassStorageData,
  validateSymbianMassStorageRelativePath,
} from "../tools/symbian-data.ts";

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), `pocketjs-symbian-data-${name}-`));
}

describe("Symbian custom-core mass-storage data", () => {
  test("stages a deterministic regular-file tree without leaking its source", () => {
    const root = scratch("stage");
    const source = join(root, "private source");
    const payload = join(root, "payload");
    try {
      mkdirSync(join(source, "models", "player 1"), { recursive: true });
      mkdirSync(join(source, "config"), { recursive: true });
      writeFileSync(
        join(source, "models", "player 1", "body.bin"),
        Buffer.from([1, 2, 3]),
      );
      writeFileSync(join(source, "config", "runtime.json"), "{}\n");

      const manifest = stageSymbianMassStorageData(source, payload);
      expect(manifest).toEqual({
        schemaVersion: 1,
        data: [
          {
            path: "config/runtime.json",
            bytes: 3,
            sha256: createHash("sha256").update("{}\n").digest("hex"),
          },
          {
            path: "models/player 1/body.bin",
            bytes: 3,
            sha256: createHash("sha256")
              .update(new Uint8Array([1, 2, 3]))
              .digest("hex"),
          },
        ],
      });
      const stage = join(payload, SYMBIAN_MASS_STORAGE_STAGE);
      const encoded = readFileSync(
        join(stage, SYMBIAN_MASS_STORAGE_MANIFEST),
        "utf8",
      );
      expect(JSON.parse(encoded)).toEqual(manifest);
      expect(encoded).not.toContain(source);
      expect(
        readFileSync(
          join(
            stage,
            SYMBIAN_MASS_STORAGE_FILES,
            "models",
            "player 1",
            "body.bin",
          ),
        ),
      ).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinks, unsafe paths, empty roots, and staging overlap", () => {
    const root = scratch("reject");
    try {
      const symlinks = join(root, "symlinks");
      mkdirSync(symlinks);
      writeFileSync(join(symlinks, "target.bin"), "target");
      symlinkSync("target.bin", join(symlinks, "alias.bin"));
      expect(() =>
        stageSymbianMassStorageData(symlinks, join(root, "payload-link"))
      ).toThrow("cannot contain symlinks");
      expect(existsSync(join(root, "payload-link"))).toBe(false);
      symlinkSync(symlinks, join(root, "source-root-alias"));
      expect(() =>
        stageSymbianMassStorageData(
          join(root, "source-root-alias"),
          join(root, "payload-root-link"),
        )
      ).toThrow("root must be a real directory");

      const unsafe = join(root, "unsafe");
      mkdirSync(unsafe);
      writeFileSync(join(unsafe, "bad:name.bin"), "bad");
      expect(() =>
        stageSymbianMassStorageData(unsafe, join(root, "payload-unsafe"))
      ).toThrow("unsafe Symbian mass-storage data path");

      const empty = join(root, "empty");
      mkdirSync(empty);
      expect(() =>
        stageSymbianMassStorageData(empty, join(root, "payload-empty"))
      ).toThrow("contains no regular files");

      expect(() =>
        stageSymbianMassStorageData(symlinks, join(symlinks, "payload"))
      ).toThrow("must not overlap");
      mkdirSync(join(root, "payload", "source"), { recursive: true });
      expect(() =>
        assertSymbianMassStorageDataStageSeparation(
          join(root, "payload", "source"),
          join(root, "payload"),
        )
      ).toThrow("must not overlap");
      expect(() =>
        assertSymbianMassStorageDataStageSeparation(
          root,
          join(root, "payload"),
        )
      ).toThrow("must not overlap");

      const aliases = join(root, "aliases");
      const real = join(aliases, "real");
      mkdirSync(join(real, "source"), { recursive: true });
      symlinkSync(real, join(aliases, "alias"));
      expect(() =>
        assertSymbianMassStorageDataStageSeparation(
          join(aliases, "alias", "source"),
          join(real, "source", "payload"),
        )
      ).toThrow("must not overlap");

      mkdirSync(join(real, "payload", "source"), { recursive: true });
      expect(() =>
        assertSymbianMassStorageDataStageSeparation(
          join(real, "payload", "source"),
          join(aliases, "alias", "payload"),
        )
      ).toThrow("must not overlap");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pins portable relative paths and the custom-core-only boundary", () => {
    expect(
      validateSymbianMassStorageRelativePath(
        "models/player 1/body-v2.bin",
      ),
    ).toBe("models/player 1/body-v2.bin");
    for (const path of [
      "",
      "../escape",
      "/absolute",
      "nested/../escape",
      "nested\\escape",
      "nested//file",
      ".hidden",
      "bad:name",
      `a/${"x".repeat(65)}`,
      `${"x".repeat(201)}`,
    ]) {
      expect(() =>
        validateSymbianMassStorageRelativePath(path)
      ).toThrow("unsafe Symbian mass-storage data path");
    }
    expect(
      resolveSymbianMassStorageDataRoot("/data", "/core.a"),
    ).toBe("/data");
    expect(resolveSymbianMassStorageDataRoot(undefined, undefined))
      .toBeUndefined();
    expect(() =>
      resolveSymbianMassStorageDataRoot("/data", undefined)
    ).toThrow("requires an application-specific --core-library");
  });
});
