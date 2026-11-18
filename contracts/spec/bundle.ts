// contracts/spec/bundle.ts — the bundle format (docs/PLATFORM.md L2).
//
// A bundle is one compiled application for one host contract: the sections
// `pocket compile` writes for one plan, in one file (`.pkb`). A host that
// keeps applications in a container of its own parses that container itself
// and states where these sections lie through its package source
// (`pocket_package_source_v1.sections`); the section kinds below are the
// numbers it maps its sections onto.
//
// Layout (all integers little-endian; the section table and payloads are
// 16-aligned):
//   header (64 B): magic "PKBD", version=1, hostAbi, sectionCount,
//                  u64 payloadHash, profileHash[32], reserved[2]
//   section table (16 B each, at 64): kind, reserved, absolute offset,
//                  byte length
//   payloads: contiguous in section order, each padded to 16
//   footer (8 B): FNV-1a64 over all preceding bytes
//
// Section kinds are strictly increasing. All reserved words are zero.
// Payload offsets must describe this exact ordering; zero-length payloads
// may share an offset; padding bytes are ignored; no byte follows the last
// padded payload but the footer. payloadHash is FNV-1a64 over the section
// payloads in table order. profileHash is the SHA-256 identity of the host
// contract the plan was resolved against: provenance, not an admission
// condition. hostAbi is the binding generation the code was compiled for.
//
// Section kinds are APPEND-ONLY, like the op table: never renumber, never
// reuse; readers skip kinds they do not know (forward compatibility).

export const BUNDLE_MAGIC = 0x44424b50; // "PKBD" as LE u32
export const BUNDLE_VERSION = 1;
export const BUNDLE_HEADER_SIZE = 64;
export const BUNDLE_SECTION_SIZE = 16;
export const BUNDLE_ALIGN = 16;
export const BUNDLE_FOOTER_SIZE = 8;
/** The file extension `pocket compile` writes. */
export const BUNDLE_EXTENSION = ".pkb";

export const BUNDLE_LAYOUT = {
  header: { magic: 0, version: 4, hostAbi: 8, sectionCount: 12, payloadHash: 16, profileHash: 24, reserved: 56 },
  section: { kind: 0, offset: 8, size: 12 },
  hostInputs: { profileHash: 40, planHash: 72 },
  bytecode: { engineAbi: 16, payload: 48 },
} as const;

export const BUNDLE_SECTION = {
  /** u16-length-prefixed UTF-8 strings: output, id, title. Native hosts
   *  read the application's identity without parsing JSON. */
  identity: 1,
  /** The ResolvedBuildPlan JSON the bundle was built from (admission
   *  evidence; hosts admit it against their own facts before booting). */
  plan: 2,
  /** The compiled IIFE bundle. NUL-TERMINATED — length includes the
   *  terminator — so an embedded bundle evaluates zero-copy from .rodata
   *  (QuickJS requires input[len] == 0; eval with len - 1). */
  js: 3,
  /** The target-flavored asset pack (framework/compiler/pak.ts container). */
  pak: 4,
  /** The application's square PNG icon (`app.icon`), opaque to the engine;
   *  a device packager stamps it into the device's own artwork. */
  icon: 5,
  /** The UI bundle as a serialized QuickJS object: a QJBC envelope naming
   *  the engine ABI (quickjs-bytecode.ts), then the object. Section 3 may
   *  stay beside it as the source a host with another engine evaluates, or
   *  be dropped. */
  bytecode: 6,
  /** Fixed-width ESP-IDF host admission data. Device readers validate this
   * without parsing the JSON build plan. */
  hostInputs: 7,
  /** NUL-terminated classic-script worker bundle, with no outer function
   * wrapper; evaluated only in the worker realm. */
  workerJs: 8,
  /** The worker bundle as a serialized QuickJS object, in the envelope of 6. */
  workerBytecode: 9,
} as const;

/** Section names by kind, for diagnostics. */
export const BUNDLE_SECTION_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(BUNDLE_SECTION).map(([name, kind]) => [kind, name]),
);

export const BUNDLE_HOST_INPUTS_MAGIC = 0x54534850; // "PHST" as LE u32
export const BUNDLE_HOST_INPUTS_VERSION = 1;
export const BUNDLE_HOST_INPUTS_SIZE = 104;

export const BUNDLE_BYTECODE_MAGIC = 0x43424a51; // "QJBC" as LE u32
export const BUNDLE_BYTECODE_VERSION = 1;
export const BUNDLE_BYTECODE_HEADER_SIZE = 48;
export const BUNDLE_BYTECODE_FLAGS = 0;

/** A bytecode section: the engine ABI the payload was serialized by and the
 *  serialized QuickJS object. */
export interface BytecodeEnvelope {
  /** SHA-256 of the canonical engine-ABI descriptor (quickjs-bytecode.ts). */
  readonly engineAbi: string;
  readonly bytecode: Uint8Array;
}

/** Encode a bytecode section. The payload must come from the engine build
 *  `engineAbi` names; this checks the wire shape only. */
export function encodeBytecodeEnvelope(input: BytecodeEnvelope): Uint8Array {
  if (input.bytecode.length === 0) throw new Error("bundle: bytecode payload must not be empty");
  const bytes = new Uint8Array(BUNDLE_BYTECODE_HEADER_SIZE + input.bytecode.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, BUNDLE_BYTECODE_MAGIC, true);
  view.setUint32(4, BUNDLE_BYTECODE_VERSION, true);
  view.setUint32(8, BUNDLE_BYTECODE_HEADER_SIZE, true);
  view.setUint32(12, BUNDLE_BYTECODE_FLAGS, true);
  bytes.set(hashBytes(input.engineAbi, "bytecode engine ABI"), BUNDLE_LAYOUT.bytecode.engineAbi);
  bytes.set(input.bytecode, BUNDLE_LAYOUT.bytecode.payload);
  return bytes;
}

/** Decode a bytecode section without interpreting its payload. A host
 *  compares `engineAbi` with its own before QuickJS reads `bytecode`. */
export function decodeBytecodeEnvelope(bytes: Uint8Array): BytecodeEnvelope {
  if (bytes.length <= BUNDLE_BYTECODE_HEADER_SIZE) throw new Error("bundle: truncated bytecode envelope");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BUNDLE_BYTECODE_MAGIC) throw new Error("bundle: invalid bytecode envelope magic");
  const version = view.getUint32(4, true);
  if (version !== BUNDLE_BYTECODE_VERSION) throw new Error(`bundle: unsupported bytecode envelope version ${version}`);
  const headerSize = view.getUint32(8, true);
  if (headerSize !== BUNDLE_BYTECODE_HEADER_SIZE) throw new Error(`bundle: invalid bytecode envelope header size ${headerSize}`);
  const flags = view.getUint32(12, true);
  if (flags !== BUNDLE_BYTECODE_FLAGS) throw new Error(`bundle: unsupported bytecode envelope flags 0x${flags.toString(16)}`);
  return {
    engineAbi: readHash(bytes, BUNDLE_LAYOUT.bytecode.engineAbi),
    bytecode: bytes.subarray(BUNDLE_LAYOUT.bytecode.payload),
  };
}

export interface HostInputs {
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
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`bundle: invalid ${field}`);
  return Uint8Array.from(hash.slice("sha256:".length).match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function readHash(bytes: Uint8Array, offset: number): string {
  return `sha256:${[...bytes.subarray(offset, offset + 32)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function encodeHostInputs(input: HostInputs): Uint8Array {
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
    throw new Error("bundle: invalid host inputs dimensions");
  }
  const presentation = HOST_PRESENTATIONS.indexOf(input.presentation);
  if (presentation < 0) throw new Error("bundle: invalid host inputs presentation");
  const bytes = new Uint8Array(BUNDLE_HOST_INPUTS_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, BUNDLE_HOST_INPUTS_MAGIC, true);
  view.setUint32(4, BUNDLE_HOST_INPUTS_VERSION, true);
  dimensions.forEach((value, index) => view.setUint32(8 + index * 4, value, true));
  view.setUint32(36, presentation, true);
  bytes.set(hashBytes(input.profileHash, "profile hash"), BUNDLE_LAYOUT.hostInputs.profileHash);
  bytes.set(hashBytes(input.planHash, "plan hash"), BUNDLE_LAYOUT.hostInputs.planHash);
  return bytes;
}

export function decodeHostInputs(bytes: Uint8Array): HostInputs {
  if (bytes.length !== BUNDLE_HOST_INPUTS_SIZE) throw new Error("bundle: invalid host inputs size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BUNDLE_HOST_INPUTS_MAGIC) {
    throw new Error("bundle: invalid host inputs magic");
  }
  if (view.getUint32(4, true) !== BUNDLE_HOST_INPUTS_VERSION) {
    throw new Error("bundle: unsupported host inputs version");
  }
  const presentation = HOST_PRESENTATIONS[view.getUint32(36, true)];
  if (!presentation) throw new Error("bundle: invalid host inputs presentation");
  return {
    hostAbi: view.getUint32(8, true),
    tickHz: view.getUint32(12, true),
    logicalWidth: view.getUint32(16, true),
    logicalHeight: view.getUint32(20, true),
    physicalWidth: view.getUint32(24, true),
    physicalHeight: view.getUint32(28, true),
    rasterDensity: view.getUint32(32, true),
    presentation,
    profileHash: readHash(bytes, BUNDLE_LAYOUT.hostInputs.profileHash),
    planHash: readHash(bytes, BUNDLE_LAYOUT.hostInputs.planHash),
  };
}

export interface BundleSection {
  kind: number;
  bytes: Uint8Array;
}

export interface Bundle {
  /** The binding generation the code was compiled for. */
  hostAbi: number;
  /** `sha256:` identity of the host contract the plan was resolved against. */
  profileHash: string;
  sections: BundleSection[];
}

export interface BundleIdentity {
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

/** FNV-1a64 over a bundle's section payloads in kind order: the header's
 *  payloadHash. */
export function bundlePayloadHash(bundle: Bundle): bigint {
  return fnv1a64(...[...bundle.sections].sort((a, b) => a.kind - b.kind).map((section) => section.bytes));
}

// --- encode ---------------------------------------------------------------

const align = (n: number) => Math.ceil(n / BUNDLE_ALIGN) * BUNDLE_ALIGN;

export function encodeIdentity(identity: BundleIdentity): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const value of [identity.output, identity.id, identity.title]) {
    const utf8 = new TextEncoder().encode(value);
    if (utf8.length > 0xffff) throw new Error("bundle: identity string too long");
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

export function decodeIdentity(bytes: Uint8Array): BundleIdentity {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: string[] = [];
  let off = 0;
  for (let i = 0; i < 3; i++) {
    if (off + 2 > bytes.length) throw new Error("bundle: truncated identity");
    const len = dv.getUint16(off, true);
    off += 2;
    if (off + len > bytes.length) throw new Error("bundle: truncated identity");
    fields.push(new TextDecoder().decode(bytes.subarray(off, off + len)));
    off += len;
  }
  return { output: fields[0], id: fields[1], title: fields[2] };
}

function u32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`bundle: invalid ${name}`);
  return value;
}

/** Serialize a bundle. Sections sort by kind — the encoding is
 *  deterministic by construction. */
export function encodeBundle(bundle: Bundle): Uint8Array {
  u32(bundle.hostAbi, "host ABI");
  const profileBytes = hashBytes(bundle.profileHash, "profile hash");
  const sections = [...bundle.sections].sort((a, b) => a.kind - b.kind);
  for (const section of sections) u32(section.kind, "section kind");
  if (new Set(sections.map(section => section.kind)).size !== sections.length) throw new Error("bundle: duplicate section kind");
  const tableOffset = BUNDLE_HEADER_SIZE;
  let cursor = u32(align(tableOffset + sections.length * BUNDLE_SECTION_SIZE), "section table size");
  const payloadOffsets = sections.map(section => {
    const offset = cursor;
    cursor = u32(align(cursor + section.bytes.length), "payload end");
    return offset;
  });
  const total = u32(cursor + BUNDLE_FOOTER_SIZE, "bundle size");
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(BUNDLE_LAYOUT.header.magic, BUNDLE_MAGIC, true);
  dv.setUint32(BUNDLE_LAYOUT.header.version, BUNDLE_VERSION, true);
  dv.setUint32(BUNDLE_LAYOUT.header.hostAbi, bundle.hostAbi, true);
  dv.setUint32(BUNDLE_LAYOUT.header.sectionCount, sections.length, true);
  dv.setBigUint64(BUNDLE_LAYOUT.header.payloadHash, fnv1a64(...sections.map(section => section.bytes)), true);
  out.set(profileBytes, BUNDLE_LAYOUT.header.profileHash);
  sections.forEach((section, index) => {
    const entry = tableOffset + index * BUNDLE_SECTION_SIZE;
    dv.setUint32(entry + BUNDLE_LAYOUT.section.kind, section.kind, true);
    dv.setUint32(entry + BUNDLE_LAYOUT.section.offset, payloadOffsets[index], true);
    dv.setUint32(entry + BUNDLE_LAYOUT.section.size, section.bytes.length, true);
    out.set(section.bytes, payloadOffsets[index]);
  });
  dv.setBigUint64(total - BUNDLE_FOOTER_SIZE, fnv1a64(out.subarray(0, total - BUNDLE_FOOTER_SIZE)), true);
  return out;
}

// --- decode ---------------------------------------------------------------

export interface DecodeOptions {
  /** Skip the footer and payload hashes (already verified). Layout checks still apply. */
  skipHashCheck?: boolean;
}

export function decodeBundle(bytes: Uint8Array, opts: DecodeOptions = {}): Bundle {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error("bundle: truncated");
  if (dv.getUint32(BUNDLE_LAYOUT.header.magic, true) !== BUNDLE_MAGIC) throw new Error("bundle: bad magic");
  const version = dv.getUint32(BUNDLE_LAYOUT.header.version, true);
  if (version !== BUNDLE_VERSION) throw new Error(`bundle: unsupported version ${version}`);
  if (bytes.length < BUNDLE_HEADER_SIZE + BUNDLE_FOOTER_SIZE) throw new Error("bundle: truncated");
  const payloadEnd = bytes.length - BUNDLE_FOOTER_SIZE;
  if (!opts.skipHashCheck && dv.getBigUint64(payloadEnd, true) !== fnv1a64(bytes.subarray(0, payloadEnd))) throw new Error("bundle: hash mismatch");
  const layout = (condition: boolean, detail: string) => {
    if (!condition) throw new Error(`bundle: invalid layout (${detail})`);
  };
  const reserved = BUNDLE_LAYOUT.header.reserved;
  layout(dv.getUint32(reserved, true) === 0 && dv.getUint32(reserved + 4, true) === 0, "reserved header words");
  const sectionCount = dv.getUint32(BUNDLE_LAYOUT.header.sectionCount, true);
  layout(sectionCount <= (payloadEnd - BUNDLE_HEADER_SIZE) / BUNDLE_SECTION_SIZE, "section table bounds");
  let payloadCursor = align(BUNDLE_HEADER_SIZE + sectionCount * BUNDLE_SECTION_SIZE);
  const sections: BundleSection[] = [];
  let previousKind = -1;
  for (let index = 0; index < sectionCount; index++) {
    const entry = BUNDLE_HEADER_SIZE + index * BUNDLE_SECTION_SIZE;
    const kind = dv.getUint32(entry + BUNDLE_LAYOUT.section.kind, true);
    layout(kind > previousKind && dv.getUint32(entry + 4, true) === 0, "section order or reserved word");
    previousKind = kind;
    const offset = dv.getUint32(entry + BUNDLE_LAYOUT.section.offset, true);
    const size = dv.getUint32(entry + BUNDLE_LAYOUT.section.size, true);
    layout(offset === payloadCursor && size <= payloadEnd - offset, "section payload bounds");
    sections.push({ kind, bytes: bytes.subarray(offset, offset + size) });
    payloadCursor = align(offset + size);
  }
  layout(payloadCursor === payloadEnd, "trailing bytes");
  if (!opts.skipHashCheck && dv.getBigUint64(BUNDLE_LAYOUT.header.payloadHash, true) !== fnv1a64(...sections.map(section => section.bytes))) {
    throw new Error("bundle: payload hash mismatch");
  }
  return {
    hostAbi: dv.getUint32(BUNDLE_LAYOUT.header.hostAbi, true),
    profileHash: readHash(bytes, BUNDLE_LAYOUT.header.profileHash),
    sections,
  };
}

/** A section payload by kind, or null (unknown kinds are data — callers
 *  skip what they do not consume; forward compatible). */
export function findSection(bundle: Bundle, kind: number): Uint8Array | null {
  return bundle.sections.find((s) => s.kind === kind)?.bytes ?? null;
}
