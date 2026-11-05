import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeIdentity, encodePocketPackage, fnv1a64, POCKET_LAYOUT, POCKET_PACKAGE_HEADER_SIZE, POCKET_PACKAGE_VARIANT_SIZE, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import type { AdmissionHost, AdmissionItem, AdmissionTiming } from "../contracts/spec/admission.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function packageCorpus(): Map<string, Uint8Array> {
  const base = new Uint8Array(readFileSync(resolve(root, "tests/fixtures/packages/synthetic.pocket")));
  const view = new DataView(base.buffer);
  const table = Math.ceil((POCKET_PACKAGE_HEADER_SIZE + view.getUint32(8, true)) / 16) * 16;
  const sections = view.getUint32(table + POCKET_LAYOUT.variant.sectionsOffset, true);
  const cases = new Map<string, Uint8Array>([["ok-valid.pocket", base]]);
  function mutate(name: string, change: (bytes: Uint8Array, view: DataView) => void) {
    const bytes = base.slice();
    const dv = new DataView(bytes.buffer);
    change(bytes, dv);
    dv.setBigUint64(bytes.length - 8, fnv1a64(bytes.subarray(0, bytes.length - 8)), true);
    cases.set(name, bytes);
  }
  mutate("bad-magic.pocket", (_, dv) => dv.setUint32(0, 0, true));
  mutate("bad-version.pocket", (_, dv) => dv.setUint32(4, 99, true));
  mutate("bad-manifest.pocket", (_, dv) => dv.setUint32(8, 0xffffffff, true));
  mutate("bad-variant-count.pocket", (_, dv) => dv.setUint32(12, 0xffffffff, true));
  mutate("bad-empty-target.pocket", (_, dv) => dv.setUint32(table + POCKET_LAYOUT.variant.targetSize, 0, true));
  mutate("bad-target-terminator.pocket", (bytes, dv) => { bytes[dv.getUint32(table, true)] = 0; });
  mutate("bad-section-count.pocket", (_, dv) => dv.setUint32(table + POCKET_LAYOUT.variant.sectionCount, 0xffffffff, true));
  mutate("bad-section-table.pocket", (_, dv) => dv.setUint32(table + POCKET_LAYOUT.variant.sectionsOffset, 0xfffffff0, true));
  mutate("bad-payload-offset.pocket", (_, dv) => dv.setUint32(sections + 8, 0xfffffff0, true));
  mutate("bad-payload-length.pocket", (_, dv) => dv.setUint32(sections + 12, 0xffffffff, true));
  const lastSection = sections + (view.getUint32(table + POCKET_LAYOUT.variant.sectionCount, true) - 1) * 16;
  mutate("ok-unknown-section.pocket", (_, dv) => dv.setUint32(lastSection, 999, true));
  mutate("bad-v1.pocket", (_, dv) => dv.setUint32(4, 1, true));
  mutate("bad-string-table.pocket", (_, dv) => dv.setUint32(POCKET_LAYOUT.header.stringTableOffset, 0xffffffff, true));
  mutate("bad-string-length.pocket", (_, dv) => dv.setUint32(POCKET_LAYOUT.header.stringTableSize, 0xffffffff, true));
  mutate("bad-target-utf8.pocket", (bytes, dv) => { bytes[dv.getUint32(table, true)] = 0xff; });
  mutate("bad-target-overlap.pocket", (_, dv) => dv.setUint32(table + POCKET_PACKAGE_VARIANT_SIZE, dv.getUint32(table, true), true));
  mutate("bad-section-duplicate.pocket", (_, dv) => dv.setUint32(sections + 16, dv.getUint32(sections, true), true));
  mutate("bad-reserved-header.pocket", (_, dv) => dv.setUint32(24, 1, true));
  mutate("bad-reserved-variant.pocket", (_, dv) => dv.setUint32(table + 20, 1, true));
  mutate("bad-reserved-section.pocket", (_, dv) => dv.setUint32(sections + 4, 1, true));
  cases.set("bad-truncated.pocket", base.slice(0, 20));
  return cases;
}

/** One admission case: a host and the variant it admits, or the closest
 * variant and the items it fails. */
export interface AdmissionCase {
  readonly name: string;
  readonly host: AdmissionHost;
  readonly admitted?: { readonly variant: number; readonly timing: AdmissionTiming };
  readonly rejected?: { readonly variant: number; readonly items: readonly AdmissionItem[]; readonly capability?: string };
}

const HASH_A = `sha256:${"aa".repeat(32)}`;
const HASH_B = `sha256:${"bb".repeat(32)}`;
const HASH_OTHER = `sha256:${"cc".repeat(32)}`;

/** Two variants: `a` compiled for profile A at 60 Hz, `b` for profile B at
 * 30 Hz with net.http and integer-fit presentation. Engine and tool
 * admission both read this package and these cases
 * (engine/package/tests/fixtures/admission). */
export function admissionCorpus(): { package: Uint8Array; cases: AdmissionCase[] } {
  const plan = (target: string, tickHz: number, presentation: string, features: Record<string, boolean>) => new TextEncoder().encode(JSON.stringify({
    animation: "composited", features, profile: { id: target, tickHz },
    target: { hostAbi: POCKET_BINDING_GENERATION, id: target },
    viewport: { logical: [480, 272], physical: [480, 272], policy: "fixed", presentation, rasterDensity: 1 },
  }));
  const variant = (target: string, profileHash: string, tickHz: number, presentation: string, features: Record<string, boolean>) => ({
    target, hostAbi: POCKET_BINDING_GENERATION, profileHash,
    sections: [
      { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "admission", id: "dev.pocketjs.admission", title: "Admission" }) },
      { kind: POCKET_SECTION.plan, bytes: plan(target, tickHz, presentation, features) },
      { kind: POCKET_SECTION.js, bytes: new TextEncoder().encode("globalThis.frame=()=>{};\0") },
    ],
  });
  const bytes = encodePocketPackage({ manifest: new TextEncoder().encode("{}"), variants: [
    variant("a", HASH_A, 60, "native", { "input.buttons": true, "io.offload": false, "text.glyphs.baked": true }),
    variant("b", HASH_B, 30, "integer-fit", { "input.buttons": true, "net.http": true, "text.glyphs.baked": true }),
  ] });
  const host: AdmissionHost = {
    bindingGeneration: POCKET_BINDING_GENERATION, profileHash: HASH_A, rasterDensity: 1, animation: "composited",
    cadences: [60], logicalViewports: [[480, 272]], presentations: ["native", "integer-fit"],
    capabilities: ["input.buttons", "text.glyphs.baked"], auxiliaryLogical: [],
  };
  const a = (cadenceHz = 60) => ({ variant: 0, timing: { tickHz: 60, cadenceHz } });
  const cases: AdmissionCase[] = [
    { name: "compiled-profile", host, admitted: a() },
    { name: "added-capability", host: { ...host, profileHash: HASH_OTHER, capabilities: [...host.capabilities, "audio.pcm"] }, admitted: a() },
    { name: "added-viewport", host: { ...host, profileHash: HASH_OTHER, logicalViewports: [[960, 544], [480, 272]] }, admitted: a() },
    { name: "changed-id", host: { ...host, profileHash: HASH_OTHER }, admitted: a() },
    { name: "reordered-capabilities", host: { ...host, profileHash: HASH_OTHER, capabilities: [...host.capabilities].reverse() }, admitted: a() },
    { name: "dynamic-range", host: { ...host, profileHash: HASH_OTHER, logicalViewports: [[720, 480]], dynamicViewport: { min: [320, 240], max: [1024, 768] } }, admitted: a() },
    { name: "slower-cadence", host: { ...host, profileHash: HASH_OTHER, cadences: [30, 20] }, admitted: a(30) },
    { name: "equal-hash-first", host: { ...host, profileHash: HASH_B, cadences: [60, 30], capabilities: [...host.capabilities, "net.http"] },
      admitted: { variant: 1, timing: { tickHz: 30, cadenceHz: 30 } } },
    { name: "equal-hash-not-admitted", host: { ...host, profileHash: HASH_B, cadences: [60, 30] }, admitted: a() },
    { name: "missing-capability", host: { ...host, profileHash: HASH_OTHER, capabilities: ["input.buttons"] },
      rejected: { variant: 0, items: ["capability"], capability: "text.glyphs.baked" } },
    { name: "raster-density", host: { ...host, profileHash: HASH_OTHER, rasterDensity: 2 }, rejected: { variant: 0, items: ["rasterDensity"] } },
    { name: "rate-not-divisible", host: { ...host, profileHash: HASH_OTHER, cadences: [25] }, rejected: { variant: 0, items: ["rate"] } },
    { name: "binding-generation", host: { ...host, profileHash: HASH_OTHER, bindingGeneration: POCKET_BINDING_GENERATION + 1 },
      rejected: { variant: 0, items: ["bindingGeneration"] } },
    { name: "animation", host: { ...host, profileHash: HASH_OTHER, animation: "repaint" }, rejected: { variant: 0, items: ["animation"] } },
    { name: "presentation", host: { ...host, profileHash: HASH_OTHER, presentations: ["integer-fit"] }, rejected: { variant: 0, items: ["presentation"] } },
    { name: "viewport", host: { ...host, profileHash: HASH_OTHER, logicalViewports: [[400, 240]] }, rejected: { variant: 0, items: ["viewport"] } },
    { name: "closest-variant", host: { ...host, profileHash: HASH_OTHER, cadences: [30], presentations: ["integer-fit"], capabilities: ["input.buttons"] },
      rejected: { variant: 1, items: ["capability"], capability: "net.http" } },
  ];
  return { package: bytes, cases };
}

if (import.meta.main) {
  for (const [name, bytes] of packageCorpus())
    await Bun.write(resolve(root, "tests/fixtures/packages/corpus", name), bytes);
  const admission = admissionCorpus();
  await Bun.write(resolve(root, "engine/package/tests/fixtures/admission/package.pocket"), admission.package);
  await Bun.write(resolve(root, "engine/package/tests/fixtures/admission/cases.json"), JSON.stringify(admission.cases, null, 2) + "\n");
}
