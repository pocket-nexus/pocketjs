import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { depfile } from "../framework/compiler/build-inputs.ts";
import type { ResolvedProfile } from "./profile-resolver.ts";
import { POCKET_PROFILE_FILE, type PocketProfile, type ProfileSurface } from "../contracts/spec/profile.ts";
import { inputClassesForCapabilities } from "../contracts/spec/input.ts";
import type { Viewport } from "../contracts/spec/platform-types.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";

const cBytes = (text: string) => `"${[...new TextEncoder().encode(text)].map(byte => `\\x${byte.toString(16).padStart(2, "0")}`).join("")}"`;
const utf8Length = (text: string) => new TextEncoder().encode(text).length;
/** A Rust string literal: JSON escapes differ from Rust's for \u sequences. */
const rustString = (text: string) => `"${[...text].map(char => {
  const code = char.codePointAt(0)!;
  if (char === "\\" || char === '"') return `\\${char}`;
  return code < 0x20 || code > 0x7e ? `\\u{${code.toString(16)}}` : char;
}).join("")}"`;
function writeChanged(path: string, text: string): void {
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
}
const pair = (value: Viewport) => `{${value[0]}u, ${value[1]}u}`;
const hashBytes = (profileHash: string) => profileHash.slice(7).match(/../g)!.map(byte => Number.parseInt(byte, 16));

/** The facts device admission compares, in the form the exporters write. */
export interface ExportedFacts {
  readonly cadences: readonly number[];
  readonly animation: string;
  readonly presentations: readonly string[];
  /** Sorted: admission compares sets. */
  readonly capabilities: readonly string[];
  readonly systemUICapabilities: readonly string[];
}
const sorted = (names: readonly string[]) => [...new Set(names)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
export function exportedFacts(profile: PocketProfile): ExportedFacts {
  return {
    cadences: [...profile.cadences].sort((left, right) => right - left),
    animation: profile.display.animation,
    presentations: [...profile.display.presentations],
    capabilities: sorted(profile.capabilities),
    systemUICapabilities: sorted(profile.roleCapabilities?.systemUI ?? []),
  };
}
/** A C string literal: printable ASCII as written, other bytes escaped. */
const cText = (text: string) => /^[\x20-\x7e]*$/.test(text) && !/["\\?]/.test(text) ? `"${text}"` : cBytes(text);
/** Names terminated by NUL, as adjacent C string literals and their byte
 * length. Each literal ends at its own NUL, so no escape absorbs the next
 * name's first character. */
const nameList = (names: readonly string[]) => ({
  literal: names.length ? names.map(name => cText(name).replace(/"$/, '\\0"')).join(" ") : '""',
  length: names.reduce((total, name) => total + utf8Length(name) + 1, 0),
});

/** The runtime's profile facts as C definitions; `symbol` names the
 * `pocket_profile_facts` value. Positional initializers keep C++98 consumers. */
export function profileFactsC(profile: PocketProfile, symbol: string): string {
  const { display } = profile;
  const facts = exportedFacts(profile);
  const flat = (viewports: readonly Viewport[]) => viewports.flatMap(value => [`${value[0]}u`, `${value[1]}u`]).join(", ");
  const panel = (name: string, surface: ProfileSurface, physical: Viewport) =>
    `static const uint32_t ${name}_logical[] = {${flat(surface.logicalViewports)}};\n` +
    `/* struct_size, physical, logical, logical_count, raster_density */\n` +
    `static const pocket_profile_display ${name} = {sizeof(pocket_profile_display), ${pair(physical)}, ${name}_logical, ${surface.logicalViewports.length}u, ${surface.rasterDensity}u};\n`;
  let out = panel(`${symbol}_display`, display, profile.panel.primary);
  if (display.auxiliary) out += panel(`${symbol}_auxiliary`, display.auxiliary, profile.panel.auxiliary!);
  const dynamic = display.dynamicViewport;
  if (dynamic) out += `static const pocket_profile_range ${symbol}_dynamic = {sizeof(pocket_profile_range), ${pair(dynamic.min)}, ${pair(dynamic.max)}};\n`;
  const capabilities = nameList(facts.capabilities), presentations = nameList(facts.presentations);
  out += `static const uint32_t ${symbol}_cadences[] = {${facts.cadences.map(value => `${value}u`).join(", ")}};\n`;
  out += "/* struct_size, id, id_length, tick_hz (highest cadence), input_classes, display, auxiliary, dynamic_viewport,\n" +
    " * cadences, cadence_count, capabilities, capabilities_length, presentations, presentations_length, animation, animation_length */\n";
  out += `static const pocket_profile_facts ${symbol} = {sizeof(pocket_profile_facts), (const uint8_t *)${cBytes(profile.id)}, ${utf8Length(profile.id)}u, ` +
    `${Math.max(...facts.cadences)}u, ${inputClassesForCapabilities(profile.capabilities)}u, &${symbol}_display, ${display.auxiliary ? `&${symbol}_auxiliary` : "NULL"}, ${dynamic ? `&${symbol}_dynamic` : "NULL"},\n` +
    `    ${symbol}_cadences, ${facts.cadences.length}u, (const uint8_t *)${capabilities.literal}, ${capabilities.length}u, ` +
    `(const uint8_t *)${presentations.literal}, ${presentations.length}u, (const uint8_t *)${cText(facts.animation)}, ${utf8Length(facts.animation)}u};\n`;
  return out;
}

/** The same facts as a Rust module for `pocket_profile_build::emit`. */
export function profileFactsRust(profile: PocketProfile, profileHash: string, hostAbi: number): string {
  const { display } = profile;
  const facts = exportedFacts(profile);
  const auxiliary = display.auxiliary;
  const dynamic = display.dynamicViewport;
  const pairs = (viewports: readonly Viewport[]) => `&[${viewports.map(value => `[${value[0]}, ${value[1]}]`).join(", ")}]`;
  const names = (values: readonly string[]) => `[${values.map(value => `::pocket_runtime::Cow::Borrowed(${rustString(value)})`).join(", ")}]`;
  return `// Generated by pocket host export; do not edit.
pub const EXPORTED: bool = true;
pub const ID: &str = ${rustString(profile.id)};
pub const HOST_ABI: u32 = ${hostAbi};
/// Presented frames per second this program can drive.
pub const CADENCES: &[u32] = &[${facts.cadences.join(", ")}];
pub const PROFILE_HASH: [u8; 32] = [${hashBytes(profileHash).join(", ")}];
/// The guest heap and the largest package the profile budgets, when stated.
pub const HEAP_BYTES: Option<usize> = ${profile.limits?.heapBytes === undefined ? "None" : `Some(${profile.limits.heapBytes})`};
pub const PACKAGE_BYTES: Option<usize> = ${profile.limits?.packageBytes === undefined ? "None" : `Some(${profile.limits.packageBytes})`};
static PRESENTATIONS: [::pocket_runtime::Cow<'static, str>; ${facts.presentations.length}] = ${names(facts.presentations)};
static CAPABILITIES: [::pocket_runtime::Cow<'static, str>; ${facts.capabilities.length}] = ${names(facts.capabilities)};
/// The facts the runtime admits packages against.
pub fn profile() -> Option<::pocket_runtime::Profile> {
    Some(::pocket_runtime::Profile {
        id: ::pocket_runtime::Cow::Borrowed(ID),
        cadences: ::pocket_runtime::Cow::Borrowed(CADENCES),
        viewport: [${profile.panel.primary[0]}, ${profile.panel.primary[1]}],
        logical_viewports: ::pocket_runtime::Cow::Borrowed(${pairs(display.logicalViewports)}),
        dynamic_viewport: ${dynamic ? `Some([[${dynamic.min[0]}, ${dynamic.min[1]}], [${dynamic.max[0]}, ${dynamic.max[1]}]])` : "None"},
        presentations: ::pocket_runtime::Cow::Borrowed(&PRESENTATIONS),
        auxiliary: ${auxiliary && profile.panel.auxiliary ? `Some([${profile.panel.auxiliary[0]}, ${profile.panel.auxiliary[1]}])` : "None"},
        auxiliary_logical: ::pocket_runtime::Cow::Borrowed(${auxiliary ? pairs(auxiliary.logicalViewports) : "&[]"}),
        density: ${display.rasterDensity},
        animation: ::pocket_runtime::Cow::Borrowed(${rustString(facts.animation)}),
        capabilities: ::pocket_runtime::Cow::Borrowed(&CAPABILITIES),
        required_inputs: ::pocket_runtime::InputClasses::from_bits(${inputClassesForCapabilities(profile.capabilities)}),
    })
}
`;
}

/** The text of pocket_profile.h: the facts record and the compiled
 * `pocket_profile` wrapper with the profile hash. It includes
 * pocket_runtime.h. Names stay strings; no bit table is exported. */
export function compiledProfileHeader(profile: PocketProfile, profileHash: string, hostAbi: number): string {
  const { display } = profile;
  const facts = exportedFacts(profile);
  const strings = (name: string, values: readonly string[]) => values.length
    ? `static const char *const ${name}[] = {${values.map(cText).join(", ")}};\n`
    : `static const char *const *const ${name} = NULL;\n`;
  return `/* Generated by pocket host export; do not edit. */
#ifndef POCKET_COMPILED_PROFILE_H
#define POCKET_COMPILED_PROFILE_H
#include <stddef.h>
#include <stdint.h>
#include "pocket_runtime.h"
/* Physical primary panel; logicalViewports may offer several sizes. */
#define POCKET_PROFILE_WIDTH ${profile.panel.primary[0]}u
#define POCKET_PROFILE_HEIGHT ${profile.panel.primary[1]}u
${profile.limits?.heapBytes === undefined ? "" : `#define POCKET_PROFILE_HEAP_BYTES ${profile.limits.heapBytes}u\n`}${profile.limits?.packageBytes === undefined ? "" : `#define POCKET_PROFILE_PACKAGE_BYTES ${profile.limits.packageBytes}u\n`}
/* The facts pocket_runtime_config.profile points at, with the hash and the
 * metadata a program passes beside them. tick_hz is the highest cadence. */
typedef struct pocket_compiled_profile {
    uint32_t struct_size;
    const pocket_profile_facts *facts;
    uint8_t profile_hash[32];
    uint32_t host_abi;
    uint32_t tick_hz;
    const char *id;
    const char *platform;
    const char *form;
    const char *animation;
    const uint32_t *cadences;
    size_t cadence_count;
    const char *const *presentations;
    size_t presentation_count;
    const char *const *capabilities;
    size_t capability_count;
    /* Additional grants for systemUI; application capabilities still apply. */
    const char *const *system_ui_capabilities;
    size_t system_ui_capability_count;
} pocket_compiled_profile;
${profileFactsC(profile, "pocket_profile_facts_data")}static const char pocket_profile_id_data[] = ${cBytes(profile.id)};
static const char pocket_profile_platform_data[] = ${cBytes(profile.platform)};
static const char pocket_profile_form_data[] = ${cBytes(profile.form)};
static const char pocket_profile_animation_data[] = ${cText(facts.animation)};
${strings("pocket_profile_presentation_names", facts.presentations)}${strings("pocket_profile_capability_names", facts.capabilities)}${strings("pocket_profile_system_ui_capability_names", facts.systemUICapabilities)}static const pocket_compiled_profile pocket_profile = {
    sizeof(pocket_compiled_profile), &pocket_profile_facts_data, {${hashBytes(profileHash).join(",")}},
    ${hostAbi}u, ${Math.max(...facts.cadences)}u, pocket_profile_id_data,
    pocket_profile_platform_data, pocket_profile_form_data, pocket_profile_animation_data,
    pocket_profile_facts_data_cadences, ${facts.cadences.length}u,
    pocket_profile_presentation_names, ${facts.presentations.length}u,
    pocket_profile_capability_names, ${facts.capabilities.length}u,
    pocket_profile_system_ui_capability_names, ${facts.systemUICapabilities.length}u
};
#endif
`;
}

/** The document a release ships beside its firmware: the profile as read,
 * stamped with the binding generation it was built for. Consumers compute
 * the canonical text and hash themselves. */
export function releasedProfileDocument(profile: PocketProfile, hostAbi: number): PocketProfile {
  return { ...profile, hostAbi };
}

/** Export the program's profile before any application is loaded:
 * pocket_profile.h (the facts record and the hash), pocket_profile.rs (the
 * same for Rust programs) and pocket.host.json (the stamped document). */
export function exportProfile(resolved: ResolvedProfile, outdir: string, dependencyFile?: string) {
  const { profile, profileHash, hostAbi } = resolved;
  if (hostAbi !== POCKET_BINDING_GENERATION) throw new Error(`host export: unsupported binding generation ${hostAbi}`);
  mkdirSync(outdir, { recursive: true });
  const header = join(outdir, "pocket_profile.h");
  const module = join(outdir, "pocket_profile.rs");
  const sidecar = join(outdir, POCKET_PROFILE_FILE);
  writeChanged(header, compiledProfileHeader(profile, profileHash, hostAbi));
  writeChanged(module, profileFactsRust(profile, profileHash, hostAbi));
  writeChanged(sidecar, JSON.stringify(releasedProfileDocument(profile, hostAbi), null, 2) + "\n");
  if (dependencyFile) {
    mkdirSync(dirname(dependencyFile), { recursive: true });
    writeFileSync(dependencyFile, depfile(header, resolved.dependencies) + depfile(module, resolved.dependencies) + depfile(sidecar, resolved.dependencies));
  }
  return { header, module, sidecar };
}
