import { describe, expect, test } from "bun:test";
import { deriveModality } from "../contracts/spec/modality.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { SYMBIAN_E7_DEV_CONTRACTS, SYMBIAN_E7_DEV_TARGET_ID } from "../tools/symbian-profile.ts";
import {
  symbianDataBaseForEmbeddedBytes,
  symbianExecutableName,
  symbianPackageIdentity,
  symbianUidForAppId,
  validateSymbianDevelopmentUid,
} from "../tools/symbian-package.ts";

function plan(
  id: string,
  title: string,
  output: string,
): ResolvedBuildPlan {
  return {
    app: {
      id,
      title,
      version: "0.1.0",
      entry: "app/main.tsx",
      output,
      framework: "solid",
    },
    presentation: { id: "default", entry: "app/main.tsx" },
    target: { id: "symbian-e7-dev", hostAbi: 4 },
    viewport: {
      logical: [640, 360],
      physical: [640, 360],
      presentation: "native",
      rasterDensity: 1,
      policy: "dynamic",
    },
    modality: deriveModality(SYMBIAN_E7_DEV_CONTRACTS.targets[SYMBIAN_E7_DEV_TARGET_ID]),
    features: {},
    companions: [],
    planHash: `sha256:${"0".repeat(64)}`,
  };
}

describe("independent Symbian package identity", () => {
  test("moves writable data above large embedded qrc payloads", () => {
    expect(symbianDataBaseForEmbeddedBytes(0)).toBe("0x400000");
    expect(symbianDataBaseForEmbeddedBytes(1)).toBe("0x500000");
    expect(symbianDataBaseForEmbeddedBytes(6 * 1024 * 1024)).toBe(
      "0xa00000",
    );
    expect(() => symbianDataBaseForEmbeddedBytes(-1)).toThrow(
      "non-negative safe integer",
    );
    expect(() => symbianDataBaseForEmbeddedBytes(0x10000000)).toThrow(
      "above the E7 limit",
    );
  });

  test("derives stable private UIDs from Pocket ids", () => {
    expect(symbianUidForAppId("dev.pocket-nexus.openstrike")).toBe(
      "0xEE3D66AB",
    );
    expect(symbianUidForAppId("dev.pocket-nexus.figma")).toBe("0xEEC5BADE");
    expect(symbianUidForAppId("dev.pocket-nexus.launcher")).toBe(
      "0xEDF4EB85",
    );
  });

  test("keeps every installed path unique and Symbian-safe", () => {
    const identity = symbianPackageIdentity(
      plan("dev.pocket-nexus.figma", "Pocket Figma", "pocket-figma"),
    );
    expect(identity).toEqual({
      appId: "dev.pocket-nexus.figma",
      appOutput: "pocket-figma",
      title: "Pocket Figma",
      uid: "0xEEC5BADE",
      executable: "PocketJsPocketFigmaEEC5BADE",
      sisFile: "pocket-figma.sis",
      receiptFile: "pocket-figma.receipt.json",
    });
    expect(identity.executable.length).toBeLessThanOrEqual(31);

    expect(
      symbianPackageIdentity(
        plan(
          "dev.pocket-nexus.launcher",
          "PocketJS: Launcher",
          "launcher-main",
        ),
      ).title,
    ).toBe("PocketJS: Launcher");
  });

  test("truncates long target names before the collision-resistant UID", () => {
    const executable = symbianExecutableName(
      "this-is-a-very-long-pocket-application-output",
      "0xE1234567",
    );
    expect(executable).toBe("PocketJsThisIsAVeryLongE1234567");
    expect(executable.length).toBe(31);
  });

  test("allows an explicit development UID but rejects protected UIDs", () => {
    expect(
      symbianPackageIdentity(
        plan("dev.pocket-nexus.app", "App", "app"),
        "0xe1234567",
      ).uid,
    ).toBe("0xE1234567");
    expect(() => validateSymbianDevelopmentUid("0x20012345")).toThrow(
      "unprotected development range",
    );
  });

  test("rejects package metadata that can break the generated PKG", () => {
    expect(() =>
      symbianPackageIdentity(
        plan("dev.pocket-nexus.app", 'Bad "caption"', "app"),
      )
    ).toThrow("safe ASCII");
    expect(() =>
      symbianPackageIdentity(
        plan("dev.pocket-nexus.app", "Bad $$system(id)", "app"),
      )
    ).toThrow("safe ASCII");
  });
});
