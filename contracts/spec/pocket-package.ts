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
// Layout (all integers little-endian; payloads 16-aligned):
//
//   header (16 B): magic "PCKT", u32 version = 1,
//                  u32 manifestLen, u32 variantCount
//   manifest     : pocket.json bytes, verbatim (the SAME file the build
//                  resolver admitted), padded to 16
//   variant table: variantCount × 40 B entries
//                  { target[16] NUL-padded, u32 hostAbi, u32 sectionCount,
//                    u32 sectionsOff (absolute), u32 reserved,
//                    u64 variantHash }
//   section table: per variant, sectionCount × 16 B entries
//                  { u32 kind, u32 reserved, u32 off (absolute), u32 len }
//   payloads     : section bytes, 16-aligned
//   footer (8 B) : FNV-1a64 over file[0 .. len-8] (tools/bundle-hash.ts
//                  algorithm — the stale-embed tripwire, now a file format)
//
// Determinism: variants sort by target id, sections by kind, and the
// manifest travels verbatim — identical inputs produce identical bytes
// (tests/pocket-package.test.ts byte-compares a committed fixture, and
// engine/core/src/package.rs parses the SAME fixture: one format, two readers,
// one contract).
//
// Section kinds are APPEND-ONLY, like the op table: never renumber, never
// reuse; readers skip kinds they do not know (forward compatibility).

export const POCKET_PACKAGE_MAGIC = 0x544b4350; // "PCKT" as LE u32
export const POCKET_PACKAGE_VERSION = 1;
export const POCKET_PACKAGE_HEADER_SIZE = 16;
export const POCKET_PACKAGE_VARIANT_SIZE = 40;
export const POCKET_PACKAGE_SECTION_SIZE = 16;
export const POCKET_PACKAGE_ALIGN = 16;
export const POCKET_PACKAGE_TARGET_BYTES = 16;
export const POCKET_PACKAGE_FOOTER_SIZE = 8;

export const POCKET_LAYOUT = {
  header: { magic: 0, version: 4, manifestSize: 8, variantCount: 12 },
  variant: { hostAbi: 16, sectionCount: 20, sectionsOffset: 24, hash: 32 },
  section: { kind: 0, offset: 8, size: 12 },
  bytecode: { engineAbi: 16, payload: 48 },
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
  /** Versioned QuickJS bytecode envelope. Source remains in section 3 so a
   * host can fall back when the engine ABI differs or the envelope is invalid. */
  bytecode: 6,
  /** Fixed-width ESP-IDF host admission data. Device readers validate this
   * without parsing the JSON build plan. */
  hostInputs: 7,
} as const;

export const POCKET_BYTECODE_MAGIC = 0x43424a51; // "QJBC" as LE u32
export const POCKET_BYTECODE_VERSION = 1;
export const POCKET_BYTECODE_HEADER_SIZE = 48;
export const POCKET_BYTECODE_FLAGS = 0;

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

export interface PocketBytecodeEnvelope {
  /** SHA-256 digest of the exact QuickJS source, bytecode format and build ABI. */
  readonly engineAbi: string;
  /** Raw output accepted by the matching engine's JS_ReadObject. */
  readonly bytecode: Uint8Array;
}

/** Encode the section-6 envelope. The raw bytecode must come from the engine
 * build identified by `engineAbi`; this function validates the wire shape. */
export function encodeBytecodeEnvelope(input: PocketBytecodeEnvelope): Uint8Array {
  if (input.bytecode.length === 0) {
    throw new Error("pocket package: bytecode payload must not be empty");
  }
  const bytes = new Uint8Array(POCKET_BYTECODE_HEADER_SIZE + input.bytecode.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, POCKET_BYTECODE_MAGIC, true);
  view.setUint32(4, POCKET_BYTECODE_VERSION, true);
  view.setUint32(8, POCKET_BYTECODE_HEADER_SIZE, true);
  view.setUint32(12, POCKET_BYTECODE_FLAGS, true);
  bytes.set(hashBytes(input.engineAbi, "bytecode engine ABI"), POCKET_LAYOUT.bytecode.engineAbi);
  bytes.set(input.bytecode, POCKET_LAYOUT.bytecode.payload);
  return bytes;
}

/** Decode and validate a section-6 envelope without interpreting its QuickJS
 * payload. Hosts compare `engineAbi` before passing `bytecode` to QuickJS. */
export function decodeBytecodeEnvelope(bytes: Uint8Array): PocketBytecodeEnvelope {
  if (bytes.length < 16) {
    throw new Error("pocket package: truncated bytecode envelope header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== POCKET_BYTECODE_MAGIC) {
    throw new Error("pocket package: invalid bytecode envelope magic");
  }
  const version = view.getUint32(4, true);
  if (version !== POCKET_BYTECODE_VERSION) {
    throw new Error(`pocket package: unsupported bytecode envelope version ${version}`);
  }
  const headerSize = view.getUint32(8, true);
  if (headerSize !== POCKET_BYTECODE_HEADER_SIZE) {
    throw new Error(
      `pocket package: invalid bytecode envelope header size ${headerSize} (expected ${POCKET_BYTECODE_HEADER_SIZE})`,
    );
  }
  const flags = view.getUint32(12, true);
  if (flags !== POCKET_BYTECODE_FLAGS) {
    throw new Error(`pocket package: unsupported bytecode envelope flags 0x${flags.toString(16)}`);
  }
  if (bytes.length < POCKET_BYTECODE_HEADER_SIZE) {
    throw new Error("pocket package: truncated bytecode envelope header");
  }
  if (bytes.length === POCKET_BYTECODE_HEADER_SIZE) {
    throw new Error("pocket package: bytecode envelope payload is empty");
  }
  return {
    engineAbi: readHash(bytes, POCKET_LAYOUT.bytecode.engineAbi),
    bytecode: bytes.subarray(POCKET_LAYOUT.bytecode.payload),
  };
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
  /** Target id (contracts/spec/platforms.ts POCKET_TARGETS key, ≤ 15 bytes UTF-8). */
  target: string;
  hostAbi: number;
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

// --- FNV-1a64 (lockstep with tools/bundle-hash.ts + hosts/psp/build.rs) ----

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
export function encodePocketPackage(pkg: PocketPackage): Uint8Array {
  const variants = [...pkg.variants].sort((a, b) => (a.target < b.target ? -1 : 1));
  for (const v of variants) {
    if (!v.target || v.target.includes("\0")) throw new Error("pocket package: invalid target id");
    if (new TextEncoder().encode(v.target).length >= POCKET_PACKAGE_TARGET_BYTES) {
      throw new Error(`pocket package: target id too long: ${v.target}`);
    }
    if (new Set(v.sections.map((s) => s.kind)).size !== v.sections.length) {
      throw new Error(`pocket package: duplicate section kind in ${v.target}`);
    }
    v.sections = [...v.sections].sort((a, b) => a.kind - b.kind);
  }
  if (new Set(variants.map((v) => v.target)).size !== variants.length) {
    throw new Error("pocket package: duplicate variant target");
  }

  const manifestOff = POCKET_PACKAGE_HEADER_SIZE;
  const tableOff = align(manifestOff + pkg.manifest.length);
  const sectionTablesOff = tableOff + variants.length * POCKET_PACKAGE_VARIANT_SIZE;
  let cursor = sectionTablesOff;
  const sectionTableOffs: number[] = [];
  for (const v of variants) {
    sectionTableOffs.push(cursor);
    cursor += v.sections.length * POCKET_PACKAGE_SECTION_SIZE;
  }
  cursor = align(cursor);
  const payloadOffs: number[][] = variants.map((v) =>
    v.sections.map((s) => {
      const off = cursor;
      cursor = align(cursor + s.bytes.length);
      return off;
    }),
  );
  const total = cursor + 8; // footer

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, POCKET_PACKAGE_MAGIC, true);
  dv.setUint32(4, POCKET_PACKAGE_VERSION, true);
  dv.setUint32(8, pkg.manifest.length, true);
  dv.setUint32(12, variants.length, true);
  out.set(pkg.manifest, manifestOff);

  variants.forEach((v, vi) => {
    const entry = tableOff + vi * POCKET_PACKAGE_VARIANT_SIZE;
    out.set(new TextEncoder().encode(v.target), entry); // NUL-padded by zero-init
    dv.setUint32(entry + POCKET_LAYOUT.variant.hostAbi, v.hostAbi, true);
    dv.setUint32(entry + POCKET_LAYOUT.variant.sectionCount, v.sections.length, true);
    dv.setUint32(entry + POCKET_LAYOUT.variant.sectionsOffset, sectionTableOffs[vi], true);
    dv.setBigUint64(entry + POCKET_LAYOUT.variant.hash, fnv1a64(...v.sections.map((s) => s.bytes)), true);
    v.sections.forEach((s, si) => {
      const se = sectionTableOffs[vi] + si * POCKET_PACKAGE_SECTION_SIZE;
      dv.setUint32(se, s.kind, true);
      dv.setUint32(se + POCKET_LAYOUT.section.offset, payloadOffs[vi][si], true);
      dv.setUint32(se + POCKET_LAYOUT.section.size, s.bytes.length, true);
      out.set(s.bytes, payloadOffs[vi][si]);
    });
  });

  dv.setBigUint64(total - 8, fnv1a64(out.subarray(0, total - 8)), true);
  return out;
}

// --- decode ---------------------------------------------------------------

export interface DecodeOptions {
  /** Skip the footer hash (already verified, or streaming). Default false. */
  skipHashCheck?: boolean;
}

export function decodePocketPackage(bytes: Uint8Array, opts: DecodeOptions = {}): PocketPackage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < POCKET_PACKAGE_HEADER_SIZE + 8) throw new Error("pocket package: truncated");
  if (dv.getUint32(0, true) !== POCKET_PACKAGE_MAGIC) throw new Error("pocket package: bad magic");
  const version = dv.getUint32(4, true);
  if (version !== POCKET_PACKAGE_VERSION) {
    throw new Error(`pocket package: unsupported version ${version}`);
  }
  if (!opts.skipHashCheck) {
    const stored = dv.getBigUint64(bytes.length - 8, true);
    const actual = fnv1a64(bytes.subarray(0, bytes.length - 8));
    if (stored !== actual) {
      throw new Error(
        `pocket package: hash mismatch (stored ${stored.toString(16)}, actual ${actual.toString(16)})`,
      );
    }
  }
  const manifestLen = dv.getUint32(8, true);
  const variantCount = dv.getUint32(12, true);
  const payloadEnd = bytes.length - POCKET_PACKAGE_FOOTER_SIZE;
  if (POCKET_PACKAGE_HEADER_SIZE + manifestLen > payloadEnd) throw new Error("pocket package: truncated manifest");
  const manifest = bytes.subarray(
    POCKET_PACKAGE_HEADER_SIZE,
    POCKET_PACKAGE_HEADER_SIZE + manifestLen,
  );
  const tableOff = align(POCKET_PACKAGE_HEADER_SIZE + manifestLen);
  if (tableOff + variantCount * POCKET_PACKAGE_VARIANT_SIZE > payloadEnd) throw new Error("pocket package: truncated variant table");
  const variants: PocketPackageVariant[] = [];
  for (let vi = 0; vi < variantCount; vi++) {
    const entry = tableOff + vi * POCKET_PACKAGE_VARIANT_SIZE;
    if (entry + POCKET_PACKAGE_VARIANT_SIZE > payloadEnd) {
      throw new Error("pocket package: truncated variant table");
    }
    let end = entry;
    while (end < entry + POCKET_PACKAGE_TARGET_BYTES && bytes[end] !== 0) end++;
    if (end === entry || end === entry + POCKET_PACKAGE_TARGET_BYTES) throw new Error("pocket package: invalid target name");
    const target = new TextDecoder().decode(bytes.subarray(entry, end));
    const hostAbi = dv.getUint32(entry + POCKET_LAYOUT.variant.hostAbi, true);
    const sectionCount = dv.getUint32(entry + POCKET_LAYOUT.variant.sectionCount, true);
    const sectionsOff = dv.getUint32(entry + POCKET_LAYOUT.variant.sectionsOffset, true);
    if (sectionsOff + sectionCount * POCKET_PACKAGE_SECTION_SIZE > payloadEnd) throw new Error("pocket package: truncated section table");
    const sections: PocketPackageSection[] = [];
    for (let si = 0; si < sectionCount; si++) {
      const se = sectionsOff + si * POCKET_PACKAGE_SECTION_SIZE;
      if (se + POCKET_PACKAGE_SECTION_SIZE > payloadEnd) {
        throw new Error("pocket package: truncated section table");
      }
      const kind = dv.getUint32(se, true);
      const off = dv.getUint32(se + POCKET_LAYOUT.section.offset, true);
      const len = dv.getUint32(se + POCKET_LAYOUT.section.size, true);
      if (off + len > payloadEnd) throw new Error("pocket package: section out of bounds");
      sections.push({ kind, bytes: bytes.subarray(off, off + len) });
    }
    variants.push({ target, hostAbi, sections });
  }
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
