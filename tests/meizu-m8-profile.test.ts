import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { MEIZU_M8_DEV_HOST_ABI, MEIZU_M8_DEV_TARGET_ID, MEIZU_M8_LOGICAL_VIEWPORT, MEIZU_M8_PHYSICAL_VIEWPORT, resolveMeizuM8BuildPlan } from "../tools/meizu-m8-profile.ts";
import { validateMeizuM8FramebufferBmp } from "../tools/meizu-m8/validation.ts";

const repository = join(import.meta.dir, "..");
const manifestPath = join(repository, "apps/meizu-m8-demo/pocket.json");

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function framebufferBmp(width = 480, height = 720): Buffer {
  const pixelBytes = width * height * 4;
  const bytes = Buffer.alloc(54 + pixelBytes);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(-height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(32, 28);
  bytes.writeUInt32LE(0, 30);
  bytes.writeUInt32LE(pixelBytes, 34);
  return bytes;
}

describe("private Meizu M8 build profile", () => {

  test("resolves the demo to the exact hardware plan", () => {
    const plan = resolveMeizuM8BuildPlan(manifest());
    expect(plan.target).toEqual({
      id: MEIZU_M8_DEV_TARGET_ID,
      hostAbi: MEIZU_M8_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: MEIZU_M8_LOGICAL_VIEWPORT,
      physical: MEIZU_M8_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "text.glyphs.baked": true,
    });
  });

  test("rejects unsupported buttons and a non-native logical viewport", () => {
    const needsButtons = manifest();
    needsButtons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveMeizuM8BuildPlan(needsButtons)).toThrow("input.buttons");

    const stretched = manifest();
    stretched.app.viewport.fixed.logical = [320, 480];
    expect(() => resolveMeizuM8BuildPlan(stretched)).toThrow("320x480");
  });

  test("type-checks explicit PocketJS imports in the Solid demo", () => {
    const result = checkAppTypes({
      entry: join(repository, "apps/meizu-m8-demo/main.tsx"),
      tsconfigPath: join(repository, "tsconfig.json"),
      declarationFiles: [join(repository, "framework/src/jsx.d.ts")],
    });
    expect(
      result.diagnostics
        .filter((diagnostic) => diagnostic.category === "error")
        .map((diagnostic) => diagnostic.message),
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("accepts only a complete native BGRA framebuffer capture", () => {
    const complete = framebufferBmp();
    expect(() => validateMeizuM8FramebufferBmp(complete, 480, 720)).not.toThrow();
    expect(() => validateMeizuM8FramebufferBmp(
      complete.subarray(0, complete.length - 1),
      480,
      720,
    )).toThrow("payload is incomplete");

    const wrongOffset = Buffer.from(complete);
    wrongOffset.writeUInt32LE(122, 10);
    expect(() => validateMeizuM8FramebufferBmp(wrongOffset, 480, 720)).toThrow(
      "unsupported BMP layout",
    );

    const wrongPixelSize = Buffer.from(complete);
    wrongPixelSize.writeUInt32LE(1, 34);
    expect(() => validateMeizuM8FramebufferBmp(wrongPixelSize, 480, 720)).toThrow(
      "payload is incomplete",
    );
  });
});
