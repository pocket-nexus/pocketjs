import { describe, expect, test } from "bun:test";
import { parsePocketProfile, validatePocketProfile } from "../framework/src/profile.ts";
import { compiledProfile } from "../contracts/spec/profile.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { extractHostBuildInputs, hostBuildEnvironment } from "../framework/compiler/host-build-inputs.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { canonicalJson } from "../framework/compiler/plan.ts";
import { decodeHostInputs, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";

const profile = parsePocketProfile({
  format: "pocket-host/2", id: "product-idf-screen-profile", platform: "esp-idf", form: "takeover", cadences: [60, 30],
  display: { logicalViewports: [[480, 272]], presentations: ["native", "integer-fit"], rasterDensity: 1, animation: "repaint" },
  panel: { primary: [480, 272] },
  capabilities: ["input.analog.left", "input.buttons", "text.glyphs.baked"],
});

describe("ESP-IDF software profile", () => {
  test("uses the common profile identity and projects host inputs without a legacy extension", async () => {
    const app = {
      id: "dev.pocket-nexus.telemetry", title: "Pocket Telemetry", version: "0.1.0", entry: "app/main.tsx", framework: "solid",
      viewport: { logical: [480, 272], presentation: "integer-fit" }, features: ["text.glyphs.baked", "input.analog.left", "input.buttons"],
    } as const;
    const result = resolveAppPlan(app, { target: profile.id }, profileRegistry(profile));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.plan;
    expect(plan.profile).toEqual({ ...compiledProfile(profile), tickHz: 60 });
    expect(plan.hostExtension).toBeUndefined();
    const env = hostBuildEnvironment(extractHostBuildInputs(plan), {outputDirectory:"/tmp/idf-profile-fixture",embedApp:true});
    expect(env.POCKETJS_TICK_HZ).toBe("60");
    const variant = makeVariant({target:profile.id, hostAbi:plan.target.hostAbi, planJson:canonicalJson(plan), identity:{output:plan.app.output,id:plan.app.id,title:plan.app.title},js:new TextEncoder().encode("globalThis.frame=()=>{};"),pak:new Uint8Array()});
    const binary = decodeHostInputs(variant.sections.find(section => section.kind === POCKET_SECTION.hostInputs)!.bytes);
    expect(binary.tickHz).toBe(plan.profile.tickHz);
  });

  test("accepts string-table ids and applies the shared touch/dynamic constraints", () => {
    expect(validatePocketProfile(profile).ok).toBe(true);
    expect(validatePocketProfile({...profile,cadences:[0]}).ok).toBe(false);
    const touch = {...profile,capabilities:[...profile.capabilities,"input.touch"]};
    expect(validatePocketProfile({...touch,display:{...profile.display,logicalViewports:[[1024,272]]}}).ok).toBe(true);
    expect(validatePocketProfile({...touch,display:{...profile.display,logicalViewports:[[1025,272]]}}).ok).toBe(false);
    expect(validatePocketProfile({...profile,form:"window",display:{...profile.display,dynamicViewport:{min:[240,180],max:[800,600]}}}).ok).toBe(false);
    expect(validatePocketProfile({...profile,form:"window",capabilities:[...profile.capabilities,"display.viewport.live"],display:{...profile.display,dynamicViewport:{min:[240,180],max:[800,600]}}}).ok).toBe(true);
  });
});
