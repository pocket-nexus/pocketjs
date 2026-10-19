import { describe, expect, test } from "bun:test";
import {
  STAGE_HOST_ABI,
  STAGE_TARGET_ID,
  parseWidgetArgs,
  resolveStageBuildPlan,
  stageDisplayFacts,
  stagePlanPath,
  validateWidgetArgs,
  widgetStageConfig,
} from "../tools/widget.ts";

describe("widget wrapper arguments", () => {
  test("defaults to the hero app", () => {
    expect(parseWidgetArgs([])).toEqual({
      stage: "psp",
      app: "hero-main",
      proof: false,
      pass: [],
    });
  });

  test("uses only a leading positional token as the app", () => {
    expect(
      parseWidgetArgs([
        "im",
        "--auto-quit",
        "5",
        "--profile",
        "/tmp/psp profile.json",
        "--orbit",
        "35,-12",
      ]),
    ).toEqual({
      stage: "psp",
      app: "im-main",
      proof: false,
      pass: [
        "--auto-quit",
        "5",
        "--profile",
        "/tmp/psp profile.json",
        "--orbit",
        "35,-12",
      ],
    });
  });

  test("does not mistake flag values for an app", () => {
    expect(parseWidgetArgs(["--auto-quit", "5", "--profile", "im", "--orbit", "0,15"])).toEqual({
      stage: "psp",
      app: "hero-main",
      proof: false,
      pass: ["--auto-quit", "5", "--profile", "im", "--orbit", "0,15"],
    });
  });

  test("consumes only the wrapper proof flag", () => {
    expect(parseWidgetArgs(["hero", "--proof", "--auto-quit", "5"])).toEqual({
      stage: "psp",
      app: "hero-main",
      proof: true,
      pass: ["--auto-quit", "5"],
    });
  });

  test("keeps proof deterministic by rejecting forwarded stage flags", () => {
    expect(() =>
      validateWidgetArgs(parseWidgetArgs(["--proof", "--orbit", "10,20"])),
    ).toThrow("fixed bundled-stage acceptance");
  });

  test("rejects runtime overrides that could diverge from the admitted stage", () => {
    for (const flag of ["--app", "--js", "--pak", "--profile"]) {
      expect(() =>
        validateWidgetArgs(parseWidgetArgs([flag, "/tmp/override"])),
      ).toThrow("launcher-owned");
      expect(() =>
        validateWidgetArgs(parseWidgetArgs([`${flag}=/tmp/override`])),
      ).toThrow("launcher-owned");
    }
  });

  test("keeps proof on the app whose screen state it asserts", () => {
    expect(() => validateWidgetArgs(parseWidgetArgs(["im", "--proof"]))).toThrow(
      "bundled hero-main",
    );
  });

  test("ignores bun option separators while preserving argument order", () => {
    expect(parseWidgetArgs(["--", "--profile", "/tmp/model.json", "--orbit", "10,20"])).toEqual({
      stage: "psp",
      app: "hero-main",
      proof: false,
      pass: ["--profile", "/tmp/model.json", "--orbit", "10,20"],
    });
  });

  test("selects the iPod stage defaults and consumes only its wrapper flag", () => {
    expect(parseWidgetArgs(["--stage", "ipod", "--auto-quit", "5"])).toEqual({
      stage: "ipod",
      app: "ipodnano-hero-main",
      proof: false,
      pass: ["--auto-quit", "5"],
    });
    expect(parseWidgetArgs(["im", "--stage=ipod", "--orbit", "0,15"])).toEqual({
      stage: "ipod",
      app: "im-main",
      proof: false,
      pass: ["--orbit", "0,15"],
    });
  });

  test("keeps profile admission within the native density contract", () => {
    expect(
      stageDisplayFacts({ display: { logical_size: [176, 132], raster_density: 4 } }),
    ).toEqual({ logicalSize: [176, 132], rasterDensity: 4 });
    expect(() =>
      stageDisplayFacts({ display: { logical_size: [176, 132], raster_density: 5 } }),
    ).toThrow("invalid display");
  });

  test("isolates concurrent build plans by stage and app", () => {
    const psp = stagePlanPath("psp", "hero-main");
    const ipod = stagePlanPath("ipod", "ipodnano-hero-main");
    expect(psp).not.toBe(ipod);
    expect(psp.endsWith("/psp-hero-main.plan.json")).toBe(true);
    expect(ipod.endsWith("/ipod-ipodnano-hero-main.plan.json")).toBe(true);
    expect(stagePlanPath("ipod", "nested/demo-main").endsWith("/ipod-nested_demo-main.plan.json"))
      .toBe(true);
  });

  test("rejects unsupported or repeated stage selectors", () => {
    expect(() => parseWidgetArgs(["--stage", "phone"])).toThrow("psp or ipod");
    expect(() => parseWidgetArgs(["--stage", "ipod", "--stage=psp"])).toThrow(
      "only be specified once",
    );
  });

  test("keeps the fixed proof on the PSP stage", () => {
    expect(() => validateWidgetArgs(parseWidgetArgs(["--stage", "ipod", "--proof"]))).toThrow(
      "bundled PSP stage",
    );
  });
});

describe("Pocket Stage manifest admission", () => {
  test("resolves a fixed PSP-shaped app as an embedded target", async () => {
    const manifest = await Bun.file(new URL("../pocket.json", import.meta.url)).json();
    const plan = resolveStageBuildPlan(manifest);
    expect(plan.target).toEqual({ id: STAGE_TARGET_ID, hostAbi: STAGE_HOST_ABI });
    expect(plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
      rasterDensity: 1,
      policy: "fixed",
    });
  });

  test("rejects a dynamic-only app before the native host starts", async () => {
    const manifest = await Bun.file(
      new URL("../apps/note/pocket.json", import.meta.url),
    ).json();
    expect(() => resolveStageBuildPlan(manifest)).toThrow("fixed screen");
  });

  test("reads the iPod profile display and admits its 176x132 app", async () => {
    const stage = widgetStageConfig("ipod");
    expect(stage.defaultApp).toBe("ipodnano-hero-main");
    expect(stage.profile?.endsWith("/assets/ipod-nano-2/profile.json")).toBe(true);
    expect(stage.display).toEqual({ logicalSize: [176, 132], rasterDensity: 1 });

    const manifest = await Bun.file(
      new URL("../apps/ipodnano-hero/pocket.json", import.meta.url),
    ).json();
    const plan = resolveStageBuildPlan(manifest, stage.display);
    expect(plan.target).toEqual({ id: STAGE_TARGET_ID, hostAbi: STAGE_HOST_ABI });
    expect(plan.viewport).toEqual({
      logical: [176, 132],
      physical: [176, 132],
      presentation: "native",
      rasterDensity: 1,
      policy: "fixed",
    });
  });
});
