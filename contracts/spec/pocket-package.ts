// contracts/spec/pocket-package.ts — the `.pocket` package format (docs/PLATFORM.md L2).
//
// One file = one app: its target-neutral manifest plus any subset of TARGET
// VARIANTS. A variant is the target-flavored build — dist bundles are baked
// per target (PSP rasters at density 1, Vita at 2, a desktop widget with a
// live viewport…), so "the app" is modeled as manifest × variants, never as
// one blob. A store can hold the universal file; a memory stick carries a
// thinned single-variant one; both are the same format and hash-stable
// (thinning never changes a variant's identity hash).
//
// Layout (all integers little-endian; directories and payloads 16-aligned):
//   header (32 B): magic, version=2, manifestLen, variantCount,
//                 stringTableOffset, stringTableSize, reserved[2]
//   manifest: pocket.json as read (a theme module reference replaced by its
//             export), padded to 16
//   variants (64 B each): targetOffset, targetSize, hostAbi, sectionCount,
//                 sectionsOffset, reserved, u64 variantHash, profileHash[32]
//   strings: target ids as UTF-8, contiguous in variant order, no terminators
//   section tables (16 B each): kind, reserved, absolute offset, byte length
//   payloads: contiguous in variant/section order, each padded to 16
//   footer (8 B): FNV-1a64 over all preceding bytes
//
// Variants sort by UTF-8 bytes; section kinds are strictly increasing. Target
// ids occupy 1..65535 bytes. All reserved words are zero. Directory and payload
// offsets must describe this exact ordering; unknown section kinds remain data.
// Zero-length payloads may share the same offset. Padding bytes are ignored.
// FNV variant identity covers section payloads only, so thinning preserves it.
// Profile identity is the independent SHA-256 of the seven profile fields.
// Version 1 packages are rejected; there is no implicit format conversion.
//
// Section kinds are APPEND-ONLY, like the op table: never renumber, never
// reuse; readers skip kinds they do not know (forward compatibility).

export const POCKET_PACKAGE_MAGIC = 0x544b4350; // "PCKT" as LE u32
export const POCKET_PACKAGE_VERSION = 2;
export const POCKET_PACKAGE_HEADER_SIZE = 32;
export const POCKET_PACKAGE_VARIANT_SIZE = 64;
export const POCKET_PACKAGE_SECTION_SIZE = 16;
export const POCKET_PACKAGE_ALIGN = 16;
export const POCKET_PACKAGE_TARGET_MAX_BYTES = 65535;
export const POCKET_PACKAGE_FOOTER_SIZE = 8;

export const POCKET_LAYOUT = {
  header: { magic: 0, version: 4, manifestSize: 8, variantCount: 12, stringTableOffset: 16, stringTableSize: 20 },
  variant: { targetOffset: 0, targetSize: 4, hostAbi: 8, sectionCount: 12, sectionsOffset: 16, hash: 24, profileHash: 32 },
  section: { kind: 0, offset: 8, size: 12 },
  hostInputs: { profileHash: 40, planHash: 72 },
} as const;

export const POCKET_SECTION = {
  /** u16-length-prefixed UTF-8 strings: output, id, title. The device-side
   *  registry line — native hosts never parse JSON. */
  identity: 1,
  /** The ResolvedBuildPlan JSON this variant was built from (admission
   *  evidence; devices re-verify target/abi/viewport against their own
   *  profile before booting). */
  plan: 2,
  /** The compiled IIFE bundle. NUL-TERMINATED — length includes the
   *  terminator — so an embedded package evals zero-copy from .rodata
   *  (QuickJS requires input[len] == 0; eval with len - 1). */
  js: 3,
  /** The target-flavored asset pack (framework/compiler/pak.ts container). */
  pak: 4,
  /** Cover PNG for launcher decks (256×128 full-frame, docs/LAUNCHER.md). */
  cover: 5,
  // 6 = qjsc bytecode (docs/PLATFORM.md roadmap) — reserved, not yet emitted.
  /** Fixed-width ESP-IDF host admission data. Device readers validate this
   * without parsing the JSON build plan. */
  hostInputs: 7,
  /** NUL-terminated independent worker realm IIFE; never evaluated by UI. */
  workerJs: 8,
} as const;

export const POCKET_HOST_INPUTS_MAGIC = 0x54534850; // "PHST" as LE u32
export const POCKET_HOST_INPUTS_VERSION = 1;
export const POCKET_HOST_INPUTS_SIZE = 104;

export interface PocketHostInputs {
  readonly hostAbi: number;
  readonly tickHz: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly rasterDensity: number;
  readonly presentation: "fill" | "fit" | "integer-fit" | "native" | "stretch";
  readonly profileHash: string;
  readonly planHash: string;
}

export const HOST_PRESENTATIONS = ["fill", "fit", "integer-fit", "native", "stretch"] as const;

function hashBytes(hash: string, field: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`pocket package: invalid ${field}`);
  return Uint8Array.from(hash.slice("sha256:".length).match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function readHash(bytes: Uint8Array, offset: number): string {
  return `sha256:${[...bytes.subarray(offset, offset + 32)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function encodeHostInputs(input: PocketHostInputs): Uint8Array {
  const dimensions = [
    input.hostAbi,
    input.tickHz,
    input.logicalWidth,
    input.logicalHeight,
    input.physicalWidth,
    input.physicalHeight,
    input.rasterDensity,
  ];
  if (dimensions.some((value) => !Number.isInteger(value) || value < 1 || value > 0xffff_ffff)) {
    throw new Error("pocket package: invalid host inputs dimensions");
  }
  const presentation = HOST_PRESENTATIONS.indexOf(input.presentation);
  if (presentation < 0) throw new Error("pocket package: invalid host inputs presentation");
  const bytes = new Uint8Array(POCKET_HOST_INPUTS_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, POCKET_HOST_INPUTS_MAGIC, true);
  view.setUint32(4, POCKET_HOST_INPUTS_VERSION, true);
  dimensions.forEach((value, index) => view.setUint32(8 + index * 4, value, true));
  view.setUint32(36, presentation, true);
  bytes.set(hashBytes(input.profileHash, "profile hash"), POCKET_LAYOUT.hostInputs.profileHash);
  bytes.set(hashBytes(input.planHash, "plan hash"), POCKET_LAYOUT.hostInputs.planHash);
  return bytes;
}

export function decodeHostInputs(bytes: Uint8Array): PocketHostInputs {
  if (bytes.length !== POCKET_HOST_INPUTS_SIZE) throw new Error("pocket package: invalid host inputs size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== POCKET_HOST_INPUTS_MAGIC) {
    throw new Error("pocket package: invalid host inputs magic");
  }
  if (view.getUint32(4, true) !== POCKET_HOST_INPUTS_VERSION) {
    throw new Error("pocket package: unsupported host inputs version");
  }
  const presentation = HOST_PRESENTATIONS[view.getUint32(36, true)];
  if (!presentation) throw new Error("pocket package: invalid host inputs presentation");
  return {
    hostAbi: view.getUint32(8, true),
    tickHz: view.getUint32(12, true),
    logicalWidth: view.getUint32(16, true),
    logicalHeight: view.getUint32(20, true),
    physicalWidth: view.getUint32(24, true),
    physicalHeight: view.getUint32(28, true),
    rasterDensity: view.getUint32(32, true),
    presentation,
    profileHash: readHash(bytes, POCKET_LAYOUT.hostInputs.profileHash),
    planHash: readHash(bytes, POCKET_LAYOUT.hostInputs.planHash),
  };
}

export interface PocketPackageSection {
  kind: number;
  bytes: Uint8Array;
}

export interface PocketPackageVariant {
  /** Profile id, 1..65535 UTF-8 bytes. */
  target: string;
  hostAbi: number;
  /** Exact software profile identity, independent of the binding generation. */
  profileHash: string;
  sections: PocketPackageSection[];
}

export interface PocketPackage {
  /** pocket.json bytes, verbatim. */
  manifest: Uint8Array;
  variants: PocketPackageVariant[];
}

export interface PocketPackageIdentity {
  output: string;
  id: string;
  title: string;
}

// --- FNV-1a64 (lockstep with tools/bundle-hash.ts + programs/psp/build.rs) ----

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

export function fnv1a64(...chunks: Uint8Array[]): bigint {
  let h = FNV_OFFSET;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      h ^= BigInt(chunk[i]);
      h = (h * FNV_PRIME) & FNV_MASK;
    }
  }
  return h;
}

// --- encode ---------------------------------------------------------------

const align = (n: number) => Math.ceil(n / POCKET_PACKAGE_ALIGN) * POCKET_PACKAGE_ALIGN;

export function encodeIdentity(identity: PocketPackageIdentity): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const value of [identity.output, identity.id, identity.title]) {
    const utf8 = new TextEncoder().encode(value);
    if (utf8.length > 0xffff) throw new Error("pocket package: identity string too long");
    const len = new Uint8Array(2);
    new DataView(len.buffer).setUint16(0, utf8.length, true);
    parts.push(len, utf8);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function decodeIdentity(bytes: Uint8Array): PocketPackageIdentity {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: string[] = [];
  let off = 0;
  for (let i = 0; i < 3; i++) {
    if (off + 2 > bytes.length) throw new Error("pocket package: truncated identity");
    const len = dv.getUint16(off, true);
    off += 2;
    if (off + len > bytes.length) throw new Error("pocket package: truncated identity");
    fields.push(new TextDecoder().decode(bytes.subarray(off, off + len)));
    off += len;
  }
  return { output: fields[0], id: fields[1], title: fields[2] };
}

/** Serialize a package. Variants sort by target, sections by kind — the
 *  encoding is deterministic by construction. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function u32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`pocket package: invalid ${name}`);
  return value;
}

export function encodePocketPackage(pkg: PocketPackage): Uint8Array {
  const encoder = new TextEncoder();
  const variants = pkg.variants.map(variant => {
    const targetBytes = encoder.encode(variant.target);
    if (!variant.target || variant.target.includes("\0") || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(targetBytes) !== variant.target) throw new Error("pocket package: invalid target id");
    if (targetBytes.length > POCKET_PACKAGE_TARGET_MAX_BYTES) throw new Error("pocket package: target id too long");
    u32(variant.hostAbi, "host ABI");
    const profileBytes = hashBytes(variant.profileHash, "profile hash");
    const sections = [...variant.sections].sort((a, b) => a.kind - b.kind);
    for (const section of sections) u32(section.kind, "section kind");
    if (new Set(sections.map(section => section.kind)).size !== sections.length) throw new Error("pocket package: duplicate section kind");
    return { ...variant, targetBytes, profileBytes, sections };
  }).sort((a, b) => compareBytes(a.targetBytes, b.targetBytes));
  if (new Set(variants.map(variant => variant.target)).size !== variants.length) throw new Error("pocket package: duplicate variant target");
  const manifestOff = POCKET_PACKAGE_HEADER_SIZE;
  const tableOff = align(manifestOff + pkg.manifest.length);
  const stringTableOffset = u32(tableOff + variants.length * POCKET_PACKAGE_VARIANT_SIZE, "variant table size");
  const stringTableSize = variants.reduce((total, variant) => u32(total + variant.targetBytes.length, "string table size"), 0);
  let cursor = u32(align(stringTableOffset + stringTableSize), "string table end");
  const sectionTableOffs = variants.map(variant => {
    const offset = cursor;
    cursor = u32(cursor + variant.sections.length * POCKET_PACKAGE_SECTION_SIZE, "section table size");
    return offset;
  });
  cursor = align(cursor);
  const payloadOffs = variants.map(variant => variant.sections.map(section => {
    const offset = cursor;
    cursor = u32(align(cursor + section.bytes.length), "payload end");
    return offset;
  }));
  const total = u32(cursor + POCKET_PACKAGE_FOOTER_SIZE, "package size");
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, POCKET_PACKAGE_MAGIC, true);
  dv.setUint32(4, POCKET_PACKAGE_VERSION, true);
  dv.setUint32(8, pkg.manifest.length, true);
  dv.setUint32(12, variants.length, true);
  dv.setUint32(POCKET_LAYOUT.header.stringTableOffset, stringTableOffset, true);
  dv.setUint32(POCKET_LAYOUT.header.stringTableSize, stringTableSize, true);
  out.set(pkg.manifest, manifestOff);
  let targetCursor = stringTableOffset;
  variants.forEach((variant, vi) => {
    const entry = tableOff + vi * POCKET_PACKAGE_VARIANT_SIZE;
    dv.setUint32(entry + POCKET_LAYOUT.variant.targetOffset, targetCursor, true);
    dv.setUint32(entry + POCKET_LAYOUT.variant.targetSize, variant.targetBytes.length, true);
    out.set(variant.targetBytes, targetCursor);
    targetCursor += variant.targetBytes.length;
    dv.setUint32(entry + POCKET_LAYOUT.variant.hostAbi, variant.hostAbi, true);
    dv.setUint32(entry + POCKET_LAYOUT.variant.sectionCount, variant.sections.length, true);
    dv.setUint32(entry + POCKET_LAYOUT.variant.sectionsOffset, sectionTableOffs[vi], true);
    dv.setBigUint64(entry + POCKET_LAYOUT.variant.hash, fnv1a64(...variant.sections.map(section => section.bytes)), true);
    out.set(variant.profileBytes, entry + POCKET_LAYOUT.variant.profileHash);
    variant.sections.forEach((section, si) => {
      const se = sectionTableOffs[vi] + si * POCKET_PACKAGE_SECTION_SIZE;
      dv.setUint32(se, section.kind, true);
      dv.setUint32(se + POCKET_LAYOUT.section.offset, payloadOffs[vi][si], true);
      dv.setUint32(se + POCKET_LAYOUT.section.size, section.bytes.length, true);
      out.set(section.bytes, payloadOffs[vi][si]);
    });
  });
  dv.setBigUint64(total - POCKET_PACKAGE_FOOTER_SIZE, fnv1a64(out.subarray(0, total - POCKET_PACKAGE_FOOTER_SIZE)), true);
  return out;
}

// --- decode ---------------------------------------------------------------

export interface DecodeOptions {
  /** Skip footer and variant hashes (already verified). Layout checks still apply. */
  skipHashCheck?: boolean;
}

export function decodePocketPackage(bytes: Uint8Array, opts: DecodeOptions = {}): PocketPackage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error("pocket package: truncated");
  if (dv.getUint32(0, true) !== POCKET_PACKAGE_MAGIC) throw new Error("pocket package: bad magic");
  const version = dv.getUint32(4, true);
  if (version !== POCKET_PACKAGE_VERSION) throw new Error(`pocket package: unsupported version ${version}`);
  if (bytes.length < POCKET_PACKAGE_HEADER_SIZE + POCKET_PACKAGE_FOOTER_SIZE) throw new Error("pocket package: truncated");
  const payloadEnd = bytes.length - POCKET_PACKAGE_FOOTER_SIZE;
  if (!opts.skipHashCheck && dv.getBigUint64(payloadEnd, true) !== fnv1a64(bytes.subarray(0, payloadEnd))) throw new Error("pocket package: hash mismatch");
  const layout = (condition: boolean, detail: string) => {
    if (!condition) throw new Error(`pocket package: invalid layout (${detail})`);
  };
  layout(dv.getUint32(24, true) === 0 && dv.getUint32(28, true) === 0, "reserved header words");
  const manifestLen = dv.getUint32(8, true);
  const variantCount = dv.getUint32(12, true);
  layout(POCKET_PACKAGE_HEADER_SIZE + manifestLen <= payloadEnd, "manifest bounds");
  const manifest = bytes.subarray(POCKET_PACKAGE_HEADER_SIZE, POCKET_PACKAGE_HEADER_SIZE + manifestLen);
  const tableOff = align(POCKET_PACKAGE_HEADER_SIZE + manifestLen);
  const stringOffset = dv.getUint32(POCKET_LAYOUT.header.stringTableOffset, true);
  const stringSize = dv.getUint32(POCKET_LAYOUT.header.stringTableSize, true);
  layout(stringOffset === tableOff + variantCount * POCKET_PACKAGE_VARIANT_SIZE && stringOffset + stringSize <= payloadEnd, "string table bounds");
  let stringCursor = stringOffset;
  let tableCursor = align(stringOffset + stringSize);
  let previousName: Uint8Array = new Uint8Array();
  const metadata: { target: string; hostAbi: number; profileHash: string; sectionCount: number; sectionsOff: number; hash: bigint }[] = [];
  for (let vi = 0; vi < variantCount; vi++) {
    const entry = tableOff + vi * POCKET_PACKAGE_VARIANT_SIZE;
    layout(dv.getUint32(entry + 20, true) === 0, "reserved variant word");
    const offset = dv.getUint32(entry + POCKET_LAYOUT.variant.targetOffset, true);
    const size = dv.getUint32(entry + POCKET_LAYOUT.variant.targetSize, true);
    layout(offset === stringCursor && size > 0 && size <= POCKET_PACKAGE_TARGET_MAX_BYTES && size <= stringOffset + stringSize - offset, "target bounds");
    const name = bytes.subarray(offset, offset + size);
    layout(!name.includes(0) && compareBytes(previousName, name) < 0, "target order or duplicate target");
    let target: string;
    try { target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(name); }
    catch { throw new Error("pocket package: invalid UTF-8 target"); }
    previousName = name;
    stringCursor += size;
    const sectionCount = dv.getUint32(entry + POCKET_LAYOUT.variant.sectionCount, true);
    const sectionsOff = dv.getUint32(entry + POCKET_LAYOUT.variant.sectionsOffset, true);
    layout(sectionsOff === tableCursor && sectionCount * POCKET_PACKAGE_SECTION_SIZE <= payloadEnd - tableCursor, "section table bounds");
    tableCursor += sectionCount * POCKET_PACKAGE_SECTION_SIZE;
    metadata.push({ target, hostAbi: dv.getUint32(entry + POCKET_LAYOUT.variant.hostAbi, true), profileHash: readHash(bytes, entry + POCKET_LAYOUT.variant.profileHash), sectionCount, sectionsOff, hash: dv.getBigUint64(entry + POCKET_LAYOUT.variant.hash, true) });
  }
  layout(stringCursor === stringOffset + stringSize, "unused target strings");
  let payloadCursor = align(tableCursor);
  const variants = metadata.map(variant => {
    const sections: PocketPackageSection[] = [];
    let previousKind = -1;
    for (let si = 0; si < variant.sectionCount; si++) {
      const se = variant.sectionsOff + si * POCKET_PACKAGE_SECTION_SIZE;
      const kind = dv.getUint32(se, true);
      layout(kind > previousKind && dv.getUint32(se + 4, true) === 0, "section order or reserved word");
      previousKind = kind;
      const offset = dv.getUint32(se + POCKET_LAYOUT.section.offset, true);
      const size = dv.getUint32(se + POCKET_LAYOUT.section.size, true);
      layout(offset === payloadCursor && size <= payloadEnd - offset, "section payload bounds");
      sections.push({ kind, bytes: bytes.subarray(offset, offset + size) });
      payloadCursor = align(offset + size);
    }
    if (!opts.skipHashCheck && variant.hash !== fnv1a64(...sections.map(section => section.bytes))) throw new Error("pocket package: variant hash mismatch");
    return { target: variant.target, hostAbi: variant.hostAbi, profileHash: variant.profileHash, sections };
  });
  layout(payloadCursor === payloadEnd, "trailing bytes");
  return { manifest, variants };
}

/** The variant for a target, or null. */
export function findVariant(pkg: PocketPackage, target: string): PocketPackageVariant | null {
  return pkg.variants.find((v) => v.target === target) ?? null;
}

/** A variant's section payload by kind, or null (unknown kinds are data —
 *  callers skip what they do not consume; forward compatible). */
export function findSection(variant: PocketPackageVariant, kind: number): Uint8Array | null {
  return variant.sections.find((s) => s.kind === kind)?.bytes ?? null;
}

/** Re-encode with only the requested targets — the store-to-device "lipo".
 *  Variant hashes are unchanged by construction (payload bytes travel
 *  verbatim); only the container around them shrinks. */
export function thinPocketPackage(pkg: PocketPackage, targets: readonly string[]): PocketPackage {
  const kept = pkg.variants.filter((v) => targets.includes(v.target));
  if (kept.length === 0) {
    throw new Error(`pocket package: no variant for target(s) ${targets.join(", ")}`);
  }
  return { manifest: pkg.manifest, variants: kept };
}
