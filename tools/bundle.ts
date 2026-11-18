#!/usr/bin/env bun

// Bundle assembly, inspection and verification (docs/PLATFORM.md L2; format
// in contracts/spec/bundle.ts). `pocket compile` writes bundles with
// `makeBundle`; this tool reads them back:
//
//   bun tools/bundle.ts inspect <file.pkb>
//   bun tools/bundle.ts verify <file.pkb>

import { readFileSync } from "node:fs";
import {
  canonicalJson,
  verifyPlanHash,
  verifyPlanProfile,
  type ResolvedBuildPlan,
} from "../framework/compiler/plan.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import {
  BUNDLE_SECTION,
  BUNDLE_SECTION_NAMES,
  bundlePayloadHash,
  decodeBundle,
  decodeBytecodeEnvelope,
  decodeHostInputs,
  decodeIdentity,
  encodeHostInputs,
  encodeIdentity,
  findSection,
  type Bundle,
  type BundleSection,
} from "../contracts/spec/bundle.ts";

function usage(message?: string): never {
  if (message) console.error(`bundle: ${message}`);
  console.error("usage:\n  bun tools/bundle.ts inspect <file.pkb>\n  bun tools/bundle.ts verify <file.pkb>");
  process.exit(1);
}

/** Assemble one bundle from compiler outputs. */
export function makeBundle(input: {
  plan: ResolvedBuildPlan;
  js: Uint8Array;
  workerJs?: Uint8Array;
  pak: Uint8Array;
  /** The application's square PNG icon (`app.icon`). */
  icon?: Uint8Array;
}): Bundle {
  const { plan } = input;
  if (plan.target.hostAbi !== POCKET_BINDING_GENERATION) {
    throw new Error(`bundle: binding generation ${plan.target.hostAbi} is unsupported; rebuild for ${POCKET_BINDING_GENERATION}`);
  }
  if (!verifyPlanHash(plan) || !verifyPlanProfile(plan)) {
    throw new Error(`bundle: the ${plan.target.id} plan does not verify its own hash and host contract`);
  }
  // The js section carries the QuickJS NUL (zero-copy device eval rule).
  const js = new Uint8Array(input.js.length + 1);
  js.set(input.js, 0);
  const sections: BundleSection[] = [
    { kind: BUNDLE_SECTION.identity, bytes: encodeIdentity({ output: plan.app.output, id: plan.app.id, title: plan.app.title }) },
    { kind: BUNDLE_SECTION.plan, bytes: new TextEncoder().encode(canonicalJson(plan)) },
    { kind: BUNDLE_SECTION.js, bytes: js },
    { kind: BUNDLE_SECTION.pak, bytes: input.pak },
  ];
  if (input.icon) sections.push({ kind: BUNDLE_SECTION.icon, bytes: input.icon });
  if (!!plan.domains?.worker !== !!input.workerJs) throw new Error("bundle: worker declaration and worker bundle must both be present");
  if (input.workerJs) {
    if (!input.workerJs.length) throw new Error("bundle: worker bundle is empty");
    const worker = new Uint8Array(input.workerJs.length + 1);
    worker.set(input.workerJs);
    sections.push({ kind: BUNDLE_SECTION.workerJs, bytes: worker });
  }
  if (plan.profile.platform === "esp-idf") {
    sections.push({
      kind: BUNDLE_SECTION.hostInputs,
      bytes: encodeHostInputs({
        hostAbi: plan.target.hostAbi,
        tickHz: plan.profile.tickHz,
        logicalWidth: plan.viewport.logical[0],
        logicalHeight: plan.viewport.logical[1],
        physicalWidth: plan.viewport.physical[0],
        physicalHeight: plan.viewport.physical[1],
        rasterDensity: plan.viewport.rasterDensity,
        presentation: plan.viewport.presentation,
        profileHash: plan.profileHash,
        planHash: plan.planHash,
      }),
    });
  }
  return { hostAbi: plan.target.hostAbi, profileHash: plan.profileHash, sections };
}

function inspectCommand(file: string): void {
  const bytes = new Uint8Array(readFileSync(file));
  const bundle = decodeBundle(bytes);
  const identitySection = findSection(bundle, BUNDLE_SECTION.identity);
  const identity = identitySection ? decodeIdentity(identitySection) : undefined;
  const hash = bundlePayloadHash(bundle).toString(16).padStart(16, "0");
  console.log(`${file}: ${bytes.length}B, binding generation ${bundle.hostAbi}, payload hash ${hash}${identity ? ` — ${identity.id} ${JSON.stringify(identity.title)}` : ""}`);
  console.log(`  host contract ${bundle.profileHash}`);
  for (const section of bundle.sections) {
    console.log(`  ${(BUNDLE_SECTION_NAMES[section.kind] ?? `kind${section.kind}`).padEnd(14)} ${section.bytes.length}B`);
  }
}

/** The plan section verifies its own checksum and host contract and agrees
 *  with the header, the identity and the host inputs; the code sections have
 *  their wire shape. This checks internal consistency; a host compares the
 *  plan with its own facts before loading the bundle. */
export function verifyBundle(bytes: Uint8Array): Bundle {
  const bundle = decodeBundle(bytes); // footer and payload hashes checked here
  const embeddedPlan = findSection(bundle, BUNDLE_SECTION.plan);
  if (!embeddedPlan) throw new Error("verify: plan section is missing");
  let plan: ResolvedBuildPlan;
  try { plan = JSON.parse(new TextDecoder().decode(embeddedPlan)) as ResolvedBuildPlan; }
  catch { throw new Error("verify: plan section is not JSON"); }
  if (!verifyPlanHash(plan) || !verifyPlanProfile(plan) || plan.target.hostAbi !== bundle.hostAbi || plan.profileHash !== bundle.profileHash) {
    throw new Error("verify: the plan disagrees with itself or with the bundle header");
  }
  const identitySection = findSection(bundle, BUNDLE_SECTION.identity);
  if (!identitySection) throw new Error("verify: identity section is missing");
  const identity = decodeIdentity(identitySection);
  if (identity.id !== plan.app.id || identity.title !== plan.app.title || identity.output !== plan.app.output) {
    throw new Error("verify: identity differs from the plan");
  }
  const hostInputs = findSection(bundle, BUNDLE_SECTION.hostInputs);
  if (Boolean(hostInputs) !== (plan.profile.platform === "esp-idf")) {
    throw new Error("verify: host inputs do not match the plan's platform");
  }
  if (hostInputs) {
    const inputs = decodeHostInputs(hostInputs);
    if (inputs.hostAbi !== bundle.hostAbi || inputs.tickHz !== plan.profile.tickHz ||
      inputs.logicalWidth !== plan.viewport.logical[0] || inputs.logicalHeight !== plan.viewport.logical[1] ||
      inputs.physicalWidth !== plan.viewport.physical[0] || inputs.physicalHeight !== plan.viewport.physical[1] ||
      inputs.rasterDensity !== plan.viewport.rasterDensity || inputs.presentation !== plan.viewport.presentation ||
      inputs.profileHash !== plan.profileHash || inputs.planHash !== plan.planHash) {
      throw new Error("verify: ESP-IDF host inputs drifted from the plan");
    }
  }
  const js = findSection(bundle, BUNDLE_SECTION.js);
  if (js && js[js.length - 1] !== 0) throw new Error("verify: js section is not NUL-terminated");
  const bytecode = findSection(bundle, BUNDLE_SECTION.bytecode);
  if (!js && !bytecode) throw new Error("verify: neither a js nor a bytecode section");
  for (const [kind, name] of [[BUNDLE_SECTION.bytecode, "bytecode"], [BUNDLE_SECTION.workerBytecode, "worker bytecode"]] as const) {
    const section = findSection(bundle, kind);
    if (!section) continue;
    try { decodeBytecodeEnvelope(section); }
    catch (error) { throw new Error(`verify: ${name} section: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return bundle;
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const command = argv.shift();
  try {
    if (command === "inspect") inspectCommand(argv.shift() ?? usage("inspect needs a file"));
    else if (command === "verify") {
      verifyBundle(new Uint8Array(readFileSync(argv.shift() ?? usage("verify needs a file"))));
      console.log("verify: OK — footer and payload hashes, sections consistent with the plan");
    } else usage(`unknown command ${command ?? "<missing>"}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
