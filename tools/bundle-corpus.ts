// The committed bundle corpus: a synthetic bundle, valid and malformed
// variations of it that every bundle reader (contracts/spec/bundle.ts,
// engine/package, the ESP-IDF Python tools) accepts or refuses alike, and the
// admission corpus engine and tool admission both read.
//
//   bun tools/bundle-corpus.ts    rewrites tests/fixtures/bundles and the
//                                 copies under engine/package/tests/fixtures
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_HEADER_SIZE, BUNDLE_LAYOUT, BUNDLE_SECTION, BUNDLE_SECTION_SIZE, encodeBundle, encodeIdentity, fnv1a64 } from "../contracts/spec/bundle.ts";
import type { AdmissionHost, AdmissionItem, AdmissionTiming } from "../contracts/spec/admission.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** A deterministic five-section bundle. Its plan carries no admission
 *  facts, so hosts refuse it with the `plan` item. */
export function syntheticBundle(): Uint8Array {
  return encodeBundle({
    hostAbi: 1,
    profileHash: `sha256:${"11".repeat(32)}`,
    sections: [
      { kind: BUNDLE_SECTION.identity, bytes: encodeIdentity({ output: "synthetic-main", id: "dev.pocket-nexus.synthetic", title: "Synthetic" }) },
      { kind: BUNDLE_SECTION.plan, bytes: new TextEncoder().encode('{"target":{"id":"psp"}}') },
      { kind: BUNDLE_SECTION.js, bytes: new TextEncoder().encode("globalThis.frame = () => {};\0") },
      { kind: BUNDLE_SECTION.pak, bytes: new Uint8Array([10, 1, 2, 3, 4, 5, 6, 7]) },
      { kind: BUNDLE_SECTION.icon, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 10]) },
    ],
  });
}

/** Named variations of the synthetic bundle: `ok-` files parse, `bad-`
 *  files do not. Every mutation but the hash cases repairs the footer, so
 *  the layout check, not the hash check, refuses it. */
export function bundleCorpus(): Map<string, Uint8Array> {
  const base = syntheticBundle();
  const view = new DataView(base.buffer);
  const count = view.getUint32(BUNDLE_LAYOUT.header.sectionCount, true);
  const entry = (index: number) => BUNDLE_HEADER_SIZE + index * BUNDLE_SECTION_SIZE;
  const footer = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(bytes.length - 8, fnv1a64(bytes.subarray(0, bytes.length - 8)), true);
  const cases = new Map<string, Uint8Array>([["ok-valid.pkb", base]]);
  function mutate(name: string, change: (bytes: Uint8Array, view: DataView) => void, repair = true) {
    const bytes = base.slice();
    change(bytes, new DataView(bytes.buffer));
    if (repair) footer(bytes);
    cases.set(name, bytes);
  }
  const last = entry(count - 1);
  // A kind no reader knows is data.
  mutate("ok-unknown-section.pkb", (_, dv) => dv.setUint32(last, 999, true));
  // Zero-length payloads share an offset.
  cases.set("ok-empty-payloads.pkb", encodeBundle({
    hostAbi: 1, profileHash: `sha256:${"11".repeat(32)}`,
    sections: [{ kind: 1, bytes: new Uint8Array() }, { kind: 2, bytes: new Uint8Array() }, { kind: 3, bytes: new Uint8Array([0]) }],
  }));
  mutate("bad-magic.pkb", (_, dv) => dv.setUint32(BUNDLE_LAYOUT.header.magic, 0x544b4350, true));
  mutate("bad-version.pkb", (_, dv) => dv.setUint32(BUNDLE_LAYOUT.header.version, 2, true));
  mutate("bad-reserved-header.pkb", (_, dv) => dv.setUint32(BUNDLE_LAYOUT.header.reserved, 1, true));
  mutate("bad-reserved-header-high.pkb", (_, dv) => dv.setUint32(BUNDLE_LAYOUT.header.reserved + 4, 1, true));
  mutate("bad-reserved-section.pkb", (_, dv) => dv.setUint32(entry(0) + 4, 1, true));
  mutate("bad-section-count.pkb", (_, dv) => dv.setUint32(BUNDLE_LAYOUT.header.sectionCount, 0xffffffff, true));
  mutate("bad-section-count-low.pkb", (_, dv) => dv.setUint32(BUNDLE_LAYOUT.header.sectionCount, count - 1, true));
  mutate("bad-section-duplicate.pkb", (_, dv) => dv.setUint32(entry(1), dv.getUint32(entry(0), true), true));
  mutate("bad-section-order.pkb", (_, dv) => {
    const first = dv.getUint32(entry(0), true);
    dv.setUint32(entry(0), dv.getUint32(entry(1), true), true);
    dv.setUint32(entry(1), first, true);
  });
  mutate("bad-payload-offset.pkb", (_, dv) => dv.setUint32(entry(0) + BUNDLE_LAYOUT.section.offset, 0xfffffff0, true));
  mutate("bad-payload-length.pkb", (_, dv) => dv.setUint32(entry(0) + BUNDLE_LAYOUT.section.size, 0xffffffff, true));
  mutate("bad-payload-overlap.pkb", (_, dv) =>
    dv.setUint32(entry(1) + BUNDLE_LAYOUT.section.offset, dv.getUint32(entry(0) + BUNDLE_LAYOUT.section.offset, true), true));
  mutate("bad-payload-gap.pkb", (_, dv) =>
    dv.setUint32(entry(0) + BUNDLE_LAYOUT.section.offset, dv.getUint32(entry(0) + BUNDLE_LAYOUT.section.offset, true) + 16, true));
  // The payload hash disagrees with the payloads, the footer with the bytes.
  mutate("bad-payload-hash.pkb", (_, dv) => dv.setUint32(BUNDLE_LAYOUT.header.payloadHash, 0, true));
  mutate("bad-footer-hash.pkb", (bytes) => { bytes[bytes.length - 1] ^= 0xff; }, false);
  // Bytes after the last padded payload; a footer moved into the payloads.
  const trailing = new Uint8Array(base.length + 16);
  trailing.set(base.subarray(0, base.length - 8));
  footer(trailing);
  cases.set("bad-trailing-data.pkb", trailing);
  const short = base.slice(0, base.length - 16);
  footer(short);
  cases.set("bad-truncated-payload.pkb", short);
  cases.set("bad-truncated.pkb", base.slice(0, 20));
  const headerOnly = base.slice(0, BUNDLE_HEADER_SIZE + 8);
  footer(headerOnly);
  cases.set("bad-truncated-table.pkb", headerOnly);
  return cases;
}

/** One admission case: a host and the timing it admits the bundle at, or
 *  the items it fails. */
export interface AdmissionCase {
  readonly name: string;
  readonly host: AdmissionHost;
  readonly admitted?: { readonly timing: AdmissionTiming };
  readonly rejected?: { readonly items: readonly AdmissionItem[]; readonly capability?: string };
}

const HASH_COMPILED = `sha256:${"aa".repeat(32)}`;
const HASH_OTHER = `sha256:${"cc".repeat(32)}`;

/** A bundle compiled for one host contract at 60 Hz with native
 *  presentation, and the hosts that admit or refuse it. Engine and tool
 *  admission both read this bundle and these cases
 *  (engine/package/tests/fixtures/admission). */
export function admissionCorpus(): { bundle: Uint8Array; cases: AdmissionCase[] } {
  const plan = new TextEncoder().encode(JSON.stringify({
    animation: "composited", features: { "input.buttons": true, "io.offload": false, "text.glyphs.baked": true },
    profile: { id: "a", tickHz: 60 },
    target: { hostAbi: POCKET_BINDING_GENERATION, id: "a" },
    viewport: { logical: [480, 272], physical: [480, 272], policy: "fixed", presentation: "native", rasterDensity: 1 },
  }));
  const bundle = encodeBundle({
    hostAbi: POCKET_BINDING_GENERATION, profileHash: HASH_COMPILED,
    sections: [
      { kind: BUNDLE_SECTION.identity, bytes: encodeIdentity({ output: "admission", id: "dev.pocketjs.admission", title: "Admission" }) },
      { kind: BUNDLE_SECTION.plan, bytes: plan },
      { kind: BUNDLE_SECTION.js, bytes: new TextEncoder().encode("globalThis.frame=()=>{};\0") },
    ],
  });
  const host: AdmissionHost = {
    bindingGeneration: POCKET_BINDING_GENERATION, profileHash: HASH_COMPILED, rasterDensity: 1, animation: "composited",
    cadences: [60], logicalViewports: [[480, 272]], presentations: ["native", "integer-fit"],
    capabilities: ["input.buttons", "text.glyphs.baked"], auxiliaryLogical: [],
  };
  const at = (cadenceHz = 60) => ({ timing: { tickHz: 60, cadenceHz } });
  const cases: AdmissionCase[] = [
    { name: "compiled-profile", host, admitted: at() },
    { name: "added-capability", host: { ...host, profileHash: HASH_OTHER, capabilities: [...host.capabilities, "audio.pcm"] }, admitted: at() },
    { name: "added-viewport", host: { ...host, profileHash: HASH_OTHER, logicalViewports: [[960, 544], [480, 272]] }, admitted: at() },
    { name: "changed-id", host: { ...host, profileHash: HASH_OTHER }, admitted: at() },
    { name: "reordered-capabilities", host: { ...host, profileHash: HASH_OTHER, capabilities: [...host.capabilities].reverse() }, admitted: at() },
    { name: "dynamic-range", host: { ...host, profileHash: HASH_OTHER, logicalViewports: [[720, 480]], dynamicViewport: { min: [320, 240], max: [1024, 768] } }, admitted: at() },
    { name: "slower-cadence", host: { ...host, profileHash: HASH_OTHER, cadences: [30, 20] }, admitted: at(30) },
    { name: "unstated-animation-and-presentations", host: { ...host, profileHash: HASH_OTHER, animation: undefined, presentations: undefined }, admitted: at() },
    { name: "missing-capability", host: { ...host, profileHash: HASH_OTHER, capabilities: ["input.buttons"] },
      rejected: { items: ["capability"], capability: "text.glyphs.baked" } },
    { name: "compiled-profile-missing-capability", host: { ...host, capabilities: ["input.buttons"] },
      rejected: { items: ["capability"], capability: "text.glyphs.baked" } },
    { name: "raster-density", host: { ...host, profileHash: HASH_OTHER, rasterDensity: 2 }, rejected: { items: ["rasterDensity"] } },
    { name: "rate-not-divisible", host: { ...host, profileHash: HASH_OTHER, cadences: [25] }, rejected: { items: ["rate"] } },
    { name: "binding-generation", host: { ...host, profileHash: HASH_OTHER, bindingGeneration: POCKET_BINDING_GENERATION + 1 },
      rejected: { items: ["bindingGeneration"] } },
    { name: "animation", host: { ...host, profileHash: HASH_OTHER, animation: "repaint" }, rejected: { items: ["animation"] } },
    { name: "presentation", host: { ...host, profileHash: HASH_OTHER, presentations: ["integer-fit"] }, rejected: { items: ["presentation"] } },
    { name: "viewport", host: { ...host, profileHash: HASH_OTHER, logicalViewports: [[400, 240]] }, rejected: { items: ["viewport"] } },
    { name: "every-failed-item", host: { ...host, profileHash: HASH_OTHER, cadences: [25], presentations: ["integer-fit"], capabilities: ["input.buttons"] },
      rejected: { items: ["rate", "presentation", "capability"], capability: "text.glyphs.baked" } },
  ];
  return { bundle, cases: cases.map(item => JSON.parse(JSON.stringify(item)) as AdmissionCase) };
}

if (import.meta.main) {
  const corpusDirectories = ["tests/fixtures/bundles/corpus", "engine/package/tests/fixtures/corpus"];
  for (const directory of corpusDirectories) {
    rmSync(resolve(root, directory), { recursive: true, force: true });
    mkdirSync(resolve(root, directory), { recursive: true });
    for (const [name, bytes] of bundleCorpus()) await Bun.write(resolve(root, directory, name), bytes);
  }
  for (const file of ["tests/fixtures/bundles/synthetic.pkb", "engine/package/tests/fixtures/synthetic.pkb"])
    await Bun.write(resolve(root, file), syntheticBundle());
  const admission = admissionCorpus();
  await Bun.write(resolve(root, "engine/package/tests/fixtures/admission/bundle.pkb"), admission.bundle);
  await Bun.write(resolve(root, "engine/package/tests/fixtures/admission/cases.json"), JSON.stringify(admission.cases, null, 2) + "\n");
}
