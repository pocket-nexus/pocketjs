/** The C frame layer decodes the shared relay byte vectors.
 *
 * hosts/shared/relay_frame.c is compiled here with -std=c11 -Wall -Wextra
 * -Werror, once with the address and undefined-behaviour sanitizers for the
 * vector runs and once at -O2 for the decode benchmark. Every vector under
 * tests/fixtures/relay/vectors is fed to the C harness and compared against
 * the .json expectation and against the TypeScript codec.
 *
 * The C layer stops at the frame: it checks the header, the length identity,
 * the negotiated limits and UTF-8 over the metadata region, and hands the
 * metadata bytes to the layer above without parsing JSON. The five vectors
 * in UPPER_LAYER_ONLY are rejected by the TS codec on JSON or envelope
 * grounds that this layer does not evaluate; every other vector must produce
 * the same answer in both languages. */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFrame } from "../framework/src/relay/frame.ts";

const root = new URL("..", import.meta.url).pathname;
const fixtures = join(root, "tests/fixtures/relay");
const source = join(root, "hosts/shared/relay_frame.c");
const harness = join(root, "hosts/shared/tests/relay_frame_test.c");
const cc = process.env.CC ?? "cc";
const warnings = ["-std=c11", "-Wall", "-Wextra", "-Werror"];

const directory = mkdtempSync(join(tmpdir(), "pocket-relay-frame-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function build(name: string, extra: string[], sources: string[] = [source, harness]) {
  const binary = join(directory, name);
  const result = Bun.spawnSync([cc, ...warnings, ...extra, ...sources, "-o", binary], { stderr: "pipe" });
  expect(result.exitCode, `${name}: ${result.stderr.toString()}`).toBe(0);
  // -Werror turns any diagnostic into a failure; an empty stderr also pins
  // that the build produced no note or remark.
  expect(result.stderr.toString(), name).toBe("");
  return binary;
}

const checked = build("checked", ["-O1", "-g", "-fsanitize=address,undefined"]);
const fast = build("fast", ["-O2"]);

interface VectorSpec {
  name: string;
  kind: "valid" | "invalid";
  file: string;
  wireBytes: number;
  options?: { maxWireBytes?: number; maxMetaBytes?: number; codecs?: number[]; session?: string };
  errorCode?: string;
  expect?: {
    type: number; codec: number; session: string; seq: number; stream: number;
    correlation: number; metaBytes: number; dataBytes: number; metadata: unknown;
    dataFillHex?: string; dataHex?: string;
  };
}

const vectors: string[] = JSON.parse(readFileSync(join(fixtures, "index.json"), "utf8")).vectors;

/** Vectors the C layer accepts and the layer above rejects: duplicate keys,
 * fractional and NaN numbers, a lone surrogate escape (all valid UTF-8, all
 * invalid JSON for v1) and a RESPONSE missing `final`. */
const UPPER_LAYER_ONLY = new Set([
  "meta-duplicate-key", "meta-float-number", "meta-lone-surrogate", "meta-nan",
  "envelope-response-no-final",
]);

function loadVector(name: string) {
  const spec = JSON.parse(readFileSync(join(fixtures, `vectors/${name}.json`), "utf8")) as VectorSpec;
  const bin = new Uint8Array(readFileSync(join(fixtures, spec.file)));
  return { spec, bin };
}

function cliOptions(spec: VectorSpec): string[] {
  const options = spec.options ?? {};
  const argv: string[] = [];
  if (options.maxWireBytes !== undefined) argv.push("--max-wire", String(options.maxWireBytes));
  if (options.maxMetaBytes !== undefined) argv.push("--max-meta", String(options.maxMetaBytes));
  if (options.codecs) argv.push("--codecs", options.codecs.join(","));
  if (options.session) argv.push("--session", options.session);
  return argv;
}

function tsOptions(spec: VectorSpec) {
  const options = spec.options ?? {};
  const decoded: Parameters<typeof decodeFrame>[1] = {};
  if (options.maxWireBytes !== undefined) decoded.maxWireBytes = options.maxWireBytes;
  if (options.maxMetaBytes !== undefined) decoded.maxMetaBytes = options.maxMetaBytes;
  if (options.codecs) decoded.codecs = options.codecs;
  if (options.session) decoded.session = BigInt("0x" + options.session);
  return decoded;
}

type CResult =
  | { ok: false; code: string }
  | { ok: true; fields: Record<string, string>; metaHex: string; dataHex: string };

function runHarness(binary: string, argv: string[]): CResult {
  const run = Bun.spawnSync([binary, ...argv], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, `${argv.join(" ")}: ${run.stderr.toString()}`).toBe(0);
  expect(run.stderr.toString(), argv.join(" ")).toBe("");
  const lines = run.stdout.toString().trim().split("\n");
  if (lines[0].startsWith("err ")) return { ok: false, code: lines[0].slice(4).trim() };
  const fields: Record<string, string> = {};
  for (const pair of lines[0].split(" ").slice(1)) {
    const cut = pair.indexOf("=");
    fields[pair.slice(0, cut)] = pair.slice(cut + 1);
  }
  return { ok: true, fields, metaHex: lines[1].slice(5), dataHex: lines[2].slice(5) };
}

function decodeVector(name: string, spec: VectorSpec, binary = checked) {
  return runHarness(binary, ["decode", join(fixtures, spec.file), ...cliOptions(spec)]);
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("the C frame layer decodes every legal vector to its pinned bytes", () => {
  let decoded = 0;
  for (const name of vectors) {
    const { spec, bin } = loadVector(name);
    if (spec.kind !== "valid") continue;
    const result = decodeVector(name, spec);
    if (!result.ok) throw new Error(`${name}: C rejected ${result.code}`);
    const want = spec.expect!;
    const f = result.fields;
    expect(Number(f.type), name).toBe(want.type);
    expect(Number(f.codec), name).toBe(want.codec);
    expect(f.session, name).toBe(want.session);
    expect(Number(f.seq), name).toBe(want.seq);
    expect(Number(f.stream), name).toBe(want.stream);
    expect(Number(f.correlation), name).toBe(want.correlation);
    expect(Number(f.metaBytes), name).toBe(want.metaBytes);
    expect(Number(f.dataBytes), name).toBe(want.dataBytes);
    // The two views must address the record itself, at the fixed header and
    // straight after the metadata: no copy, no padding.
    expect(Number(f.metaOffset), name).toBe(48);
    expect(Number(f.dataOffset), name).toBe(48 + want.metaBytes);
    expect(result.metaHex, name).toBe(hex(bin.subarray(48, 48 + want.metaBytes)));
    expect(result.dataHex, name).toBe(hex(bin.subarray(48 + want.metaBytes, bin.length)));
    // The bytes C passed through are the metadata the vector pins.
    expect(JSON.stringify(JSON.parse(Buffer.from(result.metaHex, "hex").toString("utf8"))), name)
      .toBe(JSON.stringify(want.metadata));
    if (want.dataHex) expect(result.dataHex, name).toBe(want.dataHex);
    if (want.dataFillHex) {
      expect(result.dataHex, name).toBe(want.dataFillHex.repeat(want.dataBytes));
    }
    decoded++;
  }
  expect(decoded).toBe(23);
}, 120_000);

test("the C frame layer rejects every illegal vector with its fixed code", () => {
  let rejected = 0, deferred = 0;
  for (const name of vectors) {
    const { spec } = loadVector(name);
    if (spec.kind !== "invalid") continue;
    const result = decodeVector(name, spec);
    if (UPPER_LAYER_ONLY.has(name)) {
      // Out of this layer's scope: the frame is well formed and the metadata
      // bytes are valid UTF-8, so C accepts and the JSON layer decides.
      expect(result.ok, `${name} is metadata semantics, not framing`).toBe(true);
      deferred++;
      continue;
    }
    expect(result.ok, `${name}: C accepted a record pinned as ${spec.errorCode}`).toBe(false);
    expect((result as { code: string }).code, name).toBe(spec.errorCode!);
    rejected++;
  }
  expect(rejected).toBe(20);
  expect(deferred).toBe(UPPER_LAYER_ONLY.size);
}, 120_000);

test("C and TypeScript agree on every vector the frame layer decides", () => {
  for (const name of vectors) {
    const { spec, bin } = loadVector(name);
    const c = decodeVector(name, spec);
    const ts = decodeFrame(bin, tsOptions(spec));
    if (!c.ok) {
      // A frame-layer rejection must be the same rejection in both.
      expect(ts.ok, `${name}: C rejected ${c.code}, TS accepted`).toBe(false);
      expect((ts as { code: string }).code, name).toBe(c.code);
      continue;
    }
    if (!ts.ok) {
      expect(UPPER_LAYER_ONLY.has(name), `${name}: TS-only rejection ${ts.code}`).toBe(true);
      expect(["BAD_METADATA", "BAD_ENVELOPE"], name).toContain(ts.code);
      continue;
    }
    expect(Number(c.fields.type), name).toBe(ts.frame.type);
    expect(Number(c.fields.codec), name).toBe(ts.frame.codec);
    expect(BigInt("0x" + c.fields.session), name).toBe(ts.frame.session);
    expect(Number(c.fields.seq), name).toBe(ts.frame.seq);
    expect(Number(c.fields.stream), name).toBe(ts.frame.stream);
    expect(Number(c.fields.correlation), name).toBe(ts.frame.correlation);
    expect(c.dataHex, name).toBe(hex(ts.frame.data));
  }
}, 120_000);

test("the C header carries the same constants as contracts/spec/relay.ts", () => {
  const constants = JSON.parse(readFileSync(join(fixtures, "constants.json"), "utf8"));
  const run = Bun.spawnSync([checked, "constants"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const lines = run.stdout.toString().trim().split("\n");
  const read = (line: string) => Object.fromEntries(
    line.split(" ").filter(part => part.includes("=")).map(part => {
      const cut = part.indexOf("=");
      return [part.slice(0, cut), Number(part.slice(cut + 1))];
    }));

  const frame = read(lines[0]);
  expect(frame.headerBytes).toBe(constants.frame.headerBytes);
  expect(frame.headerBodyBytes).toBe(constants.frame.headerBodyBytes);
  expect(frame.lengthPrefixBytes).toBe(constants.frame.lengthPrefixBytes);
  expect(frame.major).toBe(constants.frame.major);
  expect(frame.minor).toBe(constants.frame.minor);

  const offsets = read(lines[1]);
  for (const [field, entry] of Object.entries(constants.header as Record<string, { offset: number }>)) {
    expect(offsets[field], field).toBe(entry.offset);
  }
  expect(Object.keys(offsets).length).toBe(Object.keys(constants.header).length);

  const defaults = read(lines[2]);
  expect(defaults.maxWireBytes).toBe(constants.limits.defaultMaxWireBytes);
  expect(defaults.maxMetaBytes).toBe(constants.limits.defaultMaxMetaBytes);

  // Every frame-layer code exists in C with the same spelling, except the one
  // the layer above owns.
  const names = lines.slice(3).map(line => line.split(" ")[2]);
  expect(names[0]).toBe("OK");
  const inC = new Set(names.slice(1));
  const inSpec = new Set(Object.keys(constants.frameErrors));
  expect([...inC].filter(name => !inSpec.has(name))).toEqual([]);
  expect([...inSpec].filter(name => !inC.has(name))).toEqual(["BAD_ENVELOPE"]);
});

test("the length prefix is refused before the record is trusted", () => {
  const run = Bun.spawnSync([checked, "prefix"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  expect(run.stdout.toString().trim()).toBe("prefix ok");
});

test("the bounded queue admits before it works and refunds only on release", () => {
  const defaults = Bun.spawnSync([checked, "queue"], { stdout: "pipe", stderr: "pipe" });
  expect(defaults.exitCode, defaults.stdout.toString() + defaults.stderr.toString()).toBe(0);
  const read = Object.fromEntries(defaults.stdout.toString().trim().split(" ").slice(1)
    .map(part => { const cut = part.indexOf("="); return [part.slice(0, cut), Number(part.slice(cut + 1))]; }));
  // [R5-P09] control attachment: 8 frames, 32768 B per direction.
  expect(read.slots).toBe(8);
  expect(read.windowBytes).toBe(32768);
  expect(read.accepted).toBe(8); // slots bind first at this record size

  // Recompiled with a window smaller than the slot budget, the byte window
  // binds instead: the two counters are independent.
  const narrow = build("narrow", ["-O1", "-DRELAY_FRAME_QUEUE_WINDOW_BYTES=200"]);
  const limited = Bun.spawnSync([narrow, "queue"], { stdout: "pipe", stderr: "pipe" });
  expect(limited.exitCode, limited.stdout.toString() + limited.stderr.toString()).toBe(0);
  const narrowRead = Object.fromEntries(limited.stdout.toString().trim().split(" ").slice(1)
    .map(part => { const cut = part.indexOf("="); return [part.slice(0, cut), Number(part.slice(cut + 1))]; }));
  expect(narrowRead.windowBytes).toBe(200);
  expect(narrowRead.accepted).toBe(Math.floor(200 / narrowRead.recordBytes));
  expect(narrowRead.accepted).toBeLessThan(narrowRead.slots);
});

/** Each entry disables exactly one check in relay_frame.c. A mutant must
 * stop producing the code its vector pins; if one still passes, the vector no
 * longer tests that check. The UTF-8 mutant shortens the checked span rather
 * than dropping the call, so the mutant still compiles under -Werror. */
const MUTATIONS: { check: string; vector: string; find: string; replace: string }[] = [
  { check: "magic", vector: "bad-magic", replace: "", find: `  if (record[RELAY_OFF_MAGIC] != 0x50u || record[RELAY_OFF_MAGIC + 1] != 0x52u
      || record[RELAY_OFF_MAGIC + 2] != 0x4cu || record[RELAY_OFF_MAGIC + 3] != 0x59u) {
    return RELAY_FRAME_BAD_MAGIC;
  }
` },
  { check: "reserved", vector: "bad-reserved", replace: "",
    find: "  if (relay_u32le(record + RELAY_OFF_RESERVED) != 0) return RELAY_FRAME_BAD_RESERVED;\n" },
  { check: "seq", vector: "seq-zero", replace: "",
    find: "  if (seq == 0) return RELAY_FRAME_BAD_SEQ;\n" },
  { check: "correlation", vector: "correlation-zero-request", replace: "", find: `  bool correlation_required = type == RELAY_TYPE_REQUEST || type == RELAY_TYPE_RESPONSE
                              || type == RELAY_TYPE_CANCEL;
  if (correlation_required ? correlation == 0 : correlation != 0) return RELAY_FRAME_BAD_CORRELATION;
` },
  { check: "wire limit", vector: "wire-too-large", replace: "", find: `  if (limits->max_wire_bytes != 0 && wire_bytes > (uint64_t)limits->max_wire_bytes) {
    return RELAY_FRAME_WIRE_TOO_LARGE;
  }
` },
  { check: "metadata UTF-8", vector: "meta-not-utf8",
    find: "if (!relay_utf8_ok(metadata, (uint32_t)meta_bytes))",
    replace: "if (!relay_utf8_ok(metadata, 0))" },
  // Scanning past the region makes the cut lead byte and the first data byte
  // one well-formed sequence; the check must stop at metaBytes.
  { check: "metadata UTF-8 span", vector: "meta-utf8-cut-at-data",
    find: "if (!relay_utf8_ok(metadata, (uint32_t)meta_bytes))",
    replace: "if (!relay_utf8_ok(metadata, (uint32_t)(length - RELAY_FRAME_HEADER_BYTES)))" },
  { check: "CANCEL stream", vector: "cancel-nonzero-stream", replace: "",
    find: "  if (type == RELAY_TYPE_CANCEL && stream != 0) return RELAY_FRAME_BAD_CORRELATION;\n" },
];

test("removing any one check turns its vector red", () => {
  const original = readFileSync(source, "utf8");
  for (const mutation of MUTATIONS) {
    expect(original.includes(mutation.find), `${mutation.check}: check text moved`).toBe(true);
    const mutated = join(directory, `mutant-${mutation.check.replace(/\W+/g, "-")}.c`);
    writeFileSync(mutated, original.replace(mutation.find, mutation.replace));
    // The mutant must still compile clean, so the red comes from the missing
    // check rather than from a broken build.
    const binary = build(`mutant-${mutation.check.replace(/\W+/g, "-")}`,
      ["-O1", "-I" + join(root, "hosts/shared")], [mutated, harness]);
    const { spec } = loadVector(mutation.vector);
    const before = decodeVector(mutation.vector, spec);
    expect(before.ok, mutation.vector).toBe(false);
    expect((before as { code: string }).code, mutation.vector).toBe(spec.errorCode!);
    const after = runHarness(binary, ["decode", join(fixtures, spec.file), ...cliOptions(spec)]);
    const code = after.ok ? "OK" : after.code;
    expect(code, `${mutation.check} removed but ${mutation.vector} still reports ${code}`)
      .not.toBe(spec.errorCode!);
  }
}, 120_000);

test("the C frame layer decodes 100000 records", () => {
  for (const name of ["get", "example-map.chunk1"]) {
    const { spec } = loadVector(name);
    const run = Bun.spawnSync([fast, "bench", join(fixtures, spec.file), "100000", ...cliOptions(spec)],
      { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const report = run.stdout.toString().trim();
    expect(report, name).toMatch(/^frames=100000 wireBytes=\d+ ms=\d+\.\d+ checksum=\d+$/);
    console.log(`relay_frame_decode ${name}: ${report}`);
  }
}, 120_000);
