// The socket-free half of the Pocket Link 2 C client (engine/host-services/
// link2_proto.c, with sha256.c and jscan.c), compiled for the build machine
// under ASan and UBSan and checked against every file of the conformance
// vectors (tests/vectors/pocket-link-2/) and against the reference codec
// (tools/pocket-link/v2/): the device and Hub must read the same bytes, write
// the same frames and compute the same proofs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LINK2_APP_STREAM_WINDOW,
  LINK2_CLOSE,
  LINK2_FLAG,
  LINK2_FRAME,
  LINK2_MAX_HANDSHAKE,
  LINK2_MIN_PAYLOAD,
  LINK2_PAYLOAD_CEILING,
  LINK2_RESET,
  LINK2_TCP_PAYLOAD,
  type Link2InstalledApp,
} from "../contracts/spec/link2.ts";
import { AppletStreamWindow, eventUnits } from "../tools/pocket-link/v2/credit.ts";
import { pageRuntimeApps } from "../tools/pocket-link/v2/paging.ts";
import { formatCompanionFile, formatLastFile, loadCompanions } from "../tools/pocket-link/v2/pairing.ts";
import {
  type Link2Frame,
  Link2FrameDecoder,
  LinkCloseError,
  acceptSelection,
  appMessageLimit,
  checkFrame,
  companionProof,
  consoleProof,
  decodeBeacon,
  decodePreamble,
  encodedBytes,
  encodedPrefix,
  idRange,
  pairConsoleProof,
  pairMaskKey,
  parseChallenge,
  parseCredit,
  parseFeatures,
  parsePairOffer,
  parseReady,
  parseRefused,
  parseReset,
  payloadLimit,
} from "../tools/pocket-link/v2/protocol.ts";
import { type Holdings, readEvent } from "../tools/pocket-link/v2/requests.ts";
import { FIXED, VECTOR_DIR } from "../tools/pocket-link/v2/vectors.ts";

const root = resolve(import.meta.dir, "..");
const shared = join(root, "engine/host-services");

// biome-ignore lint/suspicious/noExplicitAny: the vectors are JSON
const vector = (name: string): any => JSON.parse(readFileSync(join(VECTOR_DIR, name), "utf8"));
const utf8 = new TextEncoder();
const hex = (value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? utf8.encode(value) : value;
  return bytes.length === 0 ? "-" : Buffer.from(bytes).toString("hex");
};
const text = (h: string) => Buffer.from(h, "hex").toString("utf8");

let scratch = "";
let binary = "";

/** One command per row; each row's fields are joined by tabs. Returns one result line per row. */
function run(rows: (string | number)[][]): string[] {
  const input = rows.map((row) => row.join("\t")).join("\n") + "\n";
  const done = Bun.spawnSync([binary], { stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  expect(done.exitCode, done.stderr.toString()).toBe(0);
  const lines = done.stdout.toString().split("\n");
  lines.pop();
  expect(lines.length).toBe(rows.length);
  return lines;
}
const one = (...row: (string | number)[]) => run([row])[0];

/** What the reference decoder makes of bytes: the frames, then "ok" or the close code. */
function reference(bytesHex: string, limit: number, linked: boolean): string {
  const decoder = new Link2FrameDecoder();
  if (linked) decoder.ready(limit);
  const show = (frame: Link2Frame) => `${frame.type}:${frame.flags}:${frame.id >>> 0}:${frame.payload.length === 0 ? "-" : Buffer.from(frame.payload).toString("hex")}`;
  try {
    const frames = decoder.push(new Uint8Array(Buffer.from(bytesHex, "hex")));
    return [...frames.map(show), "ok"].join(" ");
  } catch (error) {
    // The reference throws at the first bad frame and gives none before it back; the C reader hands
    // frames over one at a time. Decode the good prefix again to compare both.
    const good: string[] = [];
    const again = new Link2FrameDecoder();
    if (linked) again.ready(limit);
    const bytes = new Uint8Array(Buffer.from(bytesHex, "hex"));
    for (let at = 0; at < bytes.length; at++) {
      try {
        good.push(...again.push(bytes.subarray(at, at + 1)).map(show));
      } catch {
        break;
      }
    }
    return [...good, (error as LinkCloseError).code].join(" ");
  }
}

/** A transcript step's bytes: `hex`, or a bulk DATA frame stored as header, fill and count. */
function stepHex(step: { hex?: string; header?: string; fill?: string; bytes?: number }): string {
  if (step.hex !== undefined) return step.hex;
  return `${step.header}${(step.fill as string).repeat(step.bytes as number)}`;
}
/** Every transcript step ({from, what, hex | header}) under a value. */
function steps(value: unknown, out: { from: string; what: string; hex: string }[] = []): { from: string; what: string; hex: string }[] {
  if (Array.isArray(value)) for (const entry of value) steps(entry, out);
  else if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    if (typeof object.from === "string" && typeof object.what === "string" && (typeof object.hex === "string" || typeof object.header === "string")) {
      out.push({ from: object.from, what: object.what, hex: stepHex(object as never) });
    } else for (const entry of Object.values(object)) steps(entry, out);
  }
  return out;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pocket-link-2-c-"));
  binary = join(scratch, "harness");
  const compile = Bun.spawnSync([
    "cc", "-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined",
    `-I${shared}`, join(root, "tests/fixtures/link2-proto-harness.c"),
    join(shared, "link2_proto.c"), join(shared, "sha256.c"), join(shared, "jscan.c"), "-o", binary,
  ]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("Pocket Link 2 C wire layer: the vectors", () => {
  test("beacon.json", () => {
    const v = vector("beacon.json");
    const got = run([...v.accepted, ...v.refused].map((c: { hex: string }) => ["beacon", c.hex]));
    v.accepted.forEach((c: { name: string; port: number; companion: string; text: string }, i: number) => {
      expect(`${c.name}: ${got[i]}`).toBe(`${c.name}: ${c.port}|${c.companion}|${hex(c.text)}`);
    });
    v.refused.forEach((c: { name: string; hex: string }, i: number) => {
      expect(`${c.name}: ${got[v.accepted.length + i]}`).toBe(`${c.name}: refused`);
      expect(decodeBeacon(new Uint8Array(Buffer.from(c.hex, "hex")))).toBeNull();
    });
  });

  test("preamble.json", () => {
    const v = vector("preamble.json");
    expect(one("preamble")).toBe(v.device);
    for (const c of v.deviceAccepts) expect(`${c.name}: ${one("accept", c.hubHex)}`).toBe(`${c.name}: ${c.version ?? 0}`);
    expect(one("accept", v.wrongMagic)).toBe("0");
    for (const c of v.selection) {
      const hub = decodePreamble(new Uint8Array(Buffer.from(c.hubHex, "hex")));
      const expected = hub === null ? 0 : (acceptSelection({ highest: 2, lowest: 2 }, hub) ?? 0);
      expect(`${c.name}: ${one("accept", c.hubHex)}`).toBe(`${c.name}: ${expected}`);
    }
    // Hub's rule for a frame that arrives before its preamble is read is not the device's to apply;
    // the frame itself decodes as the handshake frame it is.
    expect(one("frames", LINK2_TCP_PAYLOAD, 0, 4096, v.notWaiting.hex)).toBe(reference(v.notWaiting.hex, LINK2_TCP_PAYLOAD, false));
  });

  test("frames.json, fed whole, a byte at a time and 7 bytes at a time", () => {
    const v = vector("frames.json");
    const cases = [...v.valid, ...v.refused] as { name: string; hex: string; limit: number; linked: boolean; close?: string }[];
    for (const chunk of [1 << 20, 1, 7]) {
      const got = run(cases.map((c) => ["frames", c.limit, c.linked ? 1 : 0, chunk, c.hex]));
      cases.forEach((c, i) => {
        expect(`${c.name}: ${got[i]}`).toBe(`${c.name}: ${reference(c.hex, c.limit, c.linked)}`);
        if (c.close !== undefined) expect(got[i].endsWith(c.close)).toBe(true);
        else expect(got[i].endsWith("ok")).toBe(true);
      });
    }
  });

  test("every frame of every transcript decodes as the reference decodes it, and its header and control frames encode to the same bytes", () => {
    const all: { file: string; from: string; what: string; hex: string }[] = [];
    for (const file of ["channel.json", "requests.json", "streams.json", "handshake.json", "features.json", "handshake-refusals.json", "keepalive.json"]) {
      for (const step of steps(vector(file))) all.push({ file, ...step });
    }
    expect(all.length).toBeGreaterThan(60);
    const frames = all.filter((step) => !step.what.includes("preamble"));
    const linkedOf = (step: { file: string; hex: string }) => !(step.file.startsWith("handshake") && Number.parseInt(step.hex.slice(0, 2), 16) === LINK2_FRAME.handshake);
    const decoded = run(frames.map((step) => ["frames", LINK2_TCP_PAYLOAD, linkedOf(step) ? 1 : 0, 4096, step.hex]));
    const rows: (string | number)[][] = [];
    const expected: string[] = [];
    frames.forEach((step, i) => {
      expect(`${step.file} ${step.what}: ${decoded[i]}`).toBe(`${step.file} ${step.what}: ${reference(step.hex, LINK2_TCP_PAYLOAD, linkedOf(step))}`);
      const bytes = new Uint8Array(Buffer.from(step.hex, "hex"));
      const view = new DataView(bytes.buffer);
      const frame: Link2Frame = { type: bytes[0], flags: bytes[1], id: view.getUint32(8, true), payload: bytes.subarray(12) };
      rows.push(["header", frame.type, frame.flags, frame.payload.length, frame.id]);
      expected.push(step.hex.slice(0, 24));
      if (frame.type === LINK2_FRAME.credit) {
        rows.push(["credit", frame.id, parseCredit(frame)]);
        expected.push(step.hex);
      } else if (frame.type === LINK2_FRAME.reset) {
        rows.push(["reset", frame.id, parseReset(frame).number]);
        expected.push(step.hex);
      } else if (frame.type === LINK2_FRAME.cancel) {
        rows.push(["cancel", frame.id]);
        expected.push(step.hex);
      } else if (frame.type === LINK2_FRAME.close) {
        rows.push(["close", view.getUint16(12, true), hex(bytes.subarray(16))]);
        expected.push(step.hex);
      }
    });
    expect(run(rows)).toEqual(expected);
  });

  test("handshake.json: proofs, hello, auth, challenge, ready and the payload limit", () => {
    const v = vector("handshake.json");
    const [, nD, nC, device, companion] = v.companionMessage.split("\n");
    expect(one("proof", v.key, "companion", nD, nC, device, companion)).toBe(v.companionProof);
    expect(one("proof", v.key, "console", nD, nC, device, companion)).toBe(v.consoleProof);
    expect(v.companionProof).toBe(companionProof(v.key, nD, nC, device, companion));
    expect(v.consoleProof).toBe(consoleProof(v.key, nD, nC, device, companion));

    const payload = (what: string) => text(v.transcript.find((step: { from: string; what: string }) => `${step.from} ${step.what}` === what).hex.slice(24));
    const hello = JSON.parse(payload("device hello"));
    expect(text(one("hello", hello.device, hello.companion, hello.nonce, hex(hello.name), hex(hello.model), hex(hello.target), hello.hostAbi, hello.maxPayload, ...hello.features))).toBe(payload("device hello"));
    expect(text(one("auth", JSON.parse(payload("device auth")).proof))).toBe(payload("device auth"));

    const challenge = parseChallenge(JSON.parse(payload("hub challenge")));
    expect(one("challenge", hex(payload("hub challenge")))).toBe(`${challenge?.nonce}|${challenge?.proof}`);
    const ready = parseReady(JSON.parse(payload("hub ready")));
    expect(one("ready", hex(payload("hub ready")))).toBe(`${hex(ready.name)}|${ready.maxPayload}|${ready.clock.utc}|${ready.clock.local}|${ready.features.join(",")}`);
    for (const c of v.limits) expect(one("limit", c.hello, c.ready)).toBe(String(c.limit));
    expect(one("limit", 512, 16384)).toBe("0");
    expect(one("limit", 16384, 32769)).toBe("0");
    expect(() => payloadLimit(512, 16384)).toThrow();
  });

  test("pair-by-code.json: the code's HMACs, pair, the offer, the accept, the key file and the device's CLOSE auth", () => {
    const v = vector("pair-by-code.json");
    const [, nD, nC, device, companion] = v.companionMessage.split("\n");
    const step = (what: string) => v.transcript.find((s: { from: string; what: string }) => `${s.from} ${s.what}` === what);
    const payload = (what: string) => text(step(what).hex.slice(24));

    // The device's three HMACs against the fixed values.
    expect(one("pair-hmac", v.code, "companion", nD, nC, device, companion)).toBe(v.companionProof);
    expect(one("pair-hmac", v.code, "key", nD, nC, device, companion)).toBe(v.keyMask);
    expect(one("pair-console", v.key, nD, nC, device, companion)).toBe(v.consoleProof);
    expect(v.consoleProof).toBe(pairConsoleProof(v.key, nD, nC, device, companion));

    // What it writes: `pair` and `pair.accept`, byte for byte.
    const pair = step("device pair").json;
    expect(text(one("pair", pair.device, pair.nonce, hex(pair.name), hex(pair.model), hex(pair.target)))).toBe(payload("device pair"));
    expect(text(one("pair-accept", v.consoleProof))).toBe(payload("device pair.accept"));
    expect(one("frames", LINK2_TCP_PAYLOAD, 0, 7, step("device pair").hex)).toBe(reference(step("device pair").hex, LINK2_TCP_PAYLOAD, false));

    // What it reads: the offer's fields, with the key still masked, and `pair.done`.
    const offer = step("hub pair.offer").json;
    expect(one("pair-offer", hex(payload("hub pair.offer")))).toBe(`${offer.companion}|${hex(offer.name)}|${offer.nonce}|${offer.proof}|${offer.key}`);
    expect(one("pair-done", hex(payload("hub pair.done")))).toBe("1");
    expect(one("pair-done", hex(payload("hub pair.offer")))).toBe("0");
    for (const c of v.malformedOffer) {
      expect(`${c.name}: ${one("pair-offer", hex(JSON.stringify(c.json)))}`).toBe(`${c.name}: null`);
      expect(parsePairOffer(c.json)).toBeNull();
    }

    // The key file: the unmasked key, the offer's name, the address the connection reached.
    const key = pairMaskKey(v.code, offer.key, nD, nC, device, companion);
    expect(text(one("key-file", key, hex(offer.name), v.keyFile.address, v.keyFile.port))).toBe(v.keyFile.text);
    expect(v.keyFile.text).toBe(formatCompanionFile({ key, name: offer.name, address: v.keyFile.address, port: v.keyFile.port }));
    expect(loadCompanions([{ name: `${companion}.txt`, text: v.keyFile.text }]).companions).toMatchObject([{ id: companion, key: v.key }]);

    // Another code at Hub: the device's own proof differs, and it answers CLOSE auth with no reason.
    const wrong = v.wrongCode.offer.json;
    expect(one("pair-hmac", v.code, "companion", nD, wrong.nonce, device, wrong.companion)).toBe(v.wrongCode.expectedProof);
    expect(wrong.proof).not.toBe(v.wrongCode.expectedProof);
    expect(one("close", LINK2_CLOSE.auth, hex(""))).toBe(v.wrongCode.close);
    expect(one("refused", hex(JSON.stringify(v.declined.json)))).toBe("declined");
  });

  test("handshake-refusals.json: the refusals a device reads, its CLOSE auth, a ready out of range, DATA before ready", () => {
    const v = vector("handshake-refusals.json");
    for (const c of v.refusals) {
      expect(one("refused", hex(JSON.stringify(c.json)))).toBe(c.code);
      expect(parseRefused(c.json)?.code).toBe(c.code);
      expect(one("frames", LINK2_TCP_PAYLOAD, 0, 4096, c.hex)).toBe(reference(c.hex, LINK2_TCP_PAYLOAD, false));
    }
    expect(one("refused", hex('{"t":"refused","code":"pairing_closed","message":""}'))).toBe("null");
    // Hub's proof made with another key: the device's own proof differs, and it answers CLOSE auth.
    const challenge = v.deviceCloseAuth.challenge;
    const mine = one("proof", FIXED.key, "companion", FIXED.deviceNonce, challenge.nonce, FIXED.device, FIXED.hub);
    expect(mine).not.toBe(challenge.proof);
    expect(one("challenge", hex(JSON.stringify(challenge)))).toBe(`${challenge.nonce}|${challenge.proof}`);
    expect(one("close", LINK2_CLOSE.auth, hex("the proof does not verify"))).toBe(v.deviceCloseAuth.close);
    expect(one("ready", hex(JSON.stringify(v.readyOutOfRange.json)))).toBe("close");
    expect(one("frames", LINK2_TCP_PAYLOAD, 0, 4096, v.dataBeforeReady.hex)).toBe(v.dataBeforeReady.close);
    // The device's side of the other cases is the refusal it reads; Hub decides them.
    for (const c of [...v.malformedHello, ...v.unknownDevice]) expect(typeof c.refused).toBe("string");
    expect(v.badProof.refused).toBe("bad_proof");
  });

  test("features.json: lists within and past their limits", () => {
    const v = vector("features.json");
    for (const c of v.valid) expect(one("features", hex(JSON.stringify(c.list)))).toBe(["ok", c.list.length, ...c.list].join(":"));
    for (const c of v.protocol) {
      const list = c.json.features;
      expect(`${c.name}: ${one("features", hex(list === undefined ? "null" : JSON.stringify(list)))}`).toBe(`${c.name}: protocol`);
      expect(parseFeatures(list)).toBeNull();
    }
    expect(one("features", hex("[]"))).toBe("ok:0");
    expect(one("features", hex('["a",]'))).toBe("protocol");
    expect(one("features", hex('[""]'))).toBe("protocol");
    for (const c of v.inUse) expect(c.device.filter((f: string) => c.hub.includes(f))).toEqual(c.inUse);
    expect(v.dropOrder.length).toBe(5);
  });

  test("keepalive.json: PING, PONG and the timelines", () => {
    const v = vector("keepalive.json");
    const counter = new DataView(new Uint8Array(Buffer.from(v.ping, "hex")).buffer).getUint32(12, true);
    expect(one("ping", counter)).toBe(v.ping);
    expect(one("pong", v.ping.slice(24))).toBe(v.pong);
    for (const c of v.timelines) {
      const [silence, pings] = one("keepalive", c.until, ...c.received).split("|");
      expect(`${c.name}: ${silence}`).toBe(`${c.name}: ${c.silenceAt ?? -1}`);
      if (c.silenceAt === null) expect(Number(pings)).toBe(Math.floor(c.until / v.pingMs));
    }
  });

  test("messages.json: hello at every limit, ready, the log event at the floor, runtime.apps pages", () => {
    const v = vector("messages.json");
    const hello = v.handshake.hello.json;
    const built = text(one("hello", hello.device, hello.companion, hello.nonce, hex(hello.name), hex(hello.model), hex(hello.target), hello.hostAbi, hello.maxPayload, ...hello.features));
    expect(built).toBe(JSON.stringify(hello));
    expect(utf8.encode(built).length).toBe(v.handshake.hello.bytes);
    expect(v.handshake.hello.bytes).toBeLessThanOrEqual(LINK2_MAX_HANDSHAKE);
    const ready = parseReady(v.handshake.ready.json);
    expect(one("ready", hex(JSON.stringify(v.handshake.ready.json)))).toBe(`${hex(ready.name)}|${ready.maxPayload}|${ready.clock.utc}|${ready.clock.local}|${ready.features.join(",")}`);

    const log = v.log.json;
    const line = text(one("log", v.log.limit, log.level, log.source, hex(`${log.text}tail that is cut`), log.frame, log.dropped));
    expect(line).toBe(JSON.stringify(log));
    expect(utf8.encode(line).length).toBe(v.log.bytes);
    expect(JSON.parse(text(one("log", LINK2_TCP_PAYLOAD, "info", "host", hex("é".repeat(600)), 7, 0)))).toEqual({ t: "log", level: "info", source: "host", text: "é".repeat(512), frame: 7 });

    // The rows of the generator (tools/pocket-link/v2/vectors.ts), paged by the C writer and by the reference.
    const fill = (n: number) => "x".repeat(n);
    const ordinary: Link2InstalledApp[] = Array.from({ length: 64 }, (_, i) => ({ id: `dev.pocket-nexus.applet-${i.toString().padStart(2, "0")}`, output: `applet-${i.toString().padStart(2, "0")}`, version: "1.0.0", hash: i.toString(16).padStart(16, "0") }));
    const atLimits: Link2InstalledApp[] = Array.from({ length: 64 }, (_, i) => ({ id: `${i.toString().padStart(2, "0")}${fill(126)}`, output: fill(64), version: fill(32), hash: i.toString(16).padStart(16, "0"), home: true }));
    const pages = (rows: Link2InstalledApp[], set: number, limit: number) =>
      one("apps", limit, set, ...rows.flatMap((row) => [row.id, row.output, row.version, row.hash, row.home ? 1 : 0])).trim().split(" ").filter((page) => page !== "").map(text);
    const check = (rows: Link2InstalledApp[], set: number, limit: number, summary: { at: number; rows: number; more: boolean; bytes: number }[]) => {
      const got = pages(rows, set, limit);
      expect(got).toEqual(pageRuntimeApps(rows, set, limit).map((page) => JSON.stringify(page)));
      expect(got.map((page) => ({ at: JSON.parse(page).at, rows: JSON.parse(page).apps.length, more: JSON.parse(page).more, bytes: utf8.encode(page).length }))).toEqual(summary);
    };
    check(ordinary, 1, LINK2_TCP_PAYLOAD, v.runtimeApps.ordinary.tcp);
    check(atLimits, 2, LINK2_TCP_PAYLOAD, v.runtimeApps.atLimits.tcp);
    check(atLimits, 3, LINK2_MIN_PAYLOAD, v.runtimeApps.atLimits.floor);
    expect(pages(ordinary.slice(0, 2), 1, LINK2_TCP_PAYLOAD)).toEqual([JSON.stringify(v.runtimeApps.first)]);
    expect(pages([], 9, LINK2_TCP_PAYLOAD)).toEqual(['{"t":"runtime.apps","set":9,"at":0,"apps":[],"more":false}']);
    // The catalog, net.http and the assembler are the client's and Hub's; tests/pocket-link-2-client.test.ts runs them over a socket.
    expect(v.http.minPayload).toBe(12288);
    expect(v.catalog.served).toBe(64);
  });

  test("pairing-files.json: the files Hub writes and the files a device accepts or refuses", () => {
    const v = vector("pairing-files.json");
    expect(one("devicefile", v.deviceFile.hex)).toBe(v.deviceFile.id);
    for (const c of v.deviceFileReads) expect(`${c.name}: ${one("devicefile", hex(c.text))}`).toBe(`${c.name}: ${c.id ?? "null"}`);
    const show = (c: { id: string; key: string; name: string; address: string; port: number }) => `${c.id}|${c.key}|${hex(c.name)}|${c.address}|${c.port}`;
    const hub = FIXED.hub;
    expect(one("load", `${hub}.txt`, v.companionFile.hex)).toBe(`ok ${show({ id: hub, ...v.companionFile.parsed })}`);
    for (const c of v.companionFileReads) {
      expect(`${c.name}: ${one("load", `${hub}.txt`, hex(c.text))}`).toBe(`${c.name}: ${c.parsed === null ? "ok" : `ok ${show({ id: hub, ...c.parsed })}`}`);
    }
    expect(one("load", `${hub}.txt`, v.companionFile.hex, `${hub}.last`, hex(v.lastFile.text))).toBe(`ok ${show({ id: hub, key: v.companionFile.parsed.key, ...v.lastFile.parsed })}`);
    expect(text(one("formatlast", hex(v.lastFile.parsed.name), v.lastFile.parsed.address, v.lastFile.parsed.port))).toBe(v.lastFile.text);
    expect(text(one("formatlast", hex("Two\nLines"), "10.0.0.2", 8628))).toBe(formatLastFile({ name: "Two\nLines", address: "10.0.0.2", port: 8628 }));
    for (const c of v.load) {
      const got = one("load", ...c.entries.flatMap((entry: { name: string; text: string }) => [entry.name, hex(entry.text)]));
      expect(`${c.name}: ${got}`).toBe(`${c.name}: ${[c.error === null ? "ok" : "overflow", ...c.companions.map(show)].join(" ")}`);
      expect(loadCompanions(c.entries)).toEqual({ companions: c.companions, error: c.error });
    }
    // The setups and the power-cut table are Hub's procedure; the device's part is that it reads what they write.
    for (const c of v.setups) {
      const write = c.plan.ops.find((op: { op: string; path: string }) => op.op === "write" && op.path.endsWith(".new"));
      if (write === undefined) continue;
      expect(one("load", `${hub}.txt`, hex(write.text)).startsWith(`ok ${hub}|${c.plan.minted}|`)).toBe(true);
      expect(one("load", `${hub}.new`, hex(write.text))).toBe("ok");
    }
    expect(v.powerCut.cuts.length).toBe(4);
  });

  test("requests.json: id ranges, and error replies as frames", () => {
    const v = vector("requests.json");
    for (const c of v.ids) {
      expect(one("range", c.id)).toBe(c.range ?? "none");
      expect(idRange(c.id) ?? "none").toBe(c.range ?? "none");
    }
    const got = run(v.errors.map((c: { hex: string }) => ["frames", LINK2_TCP_PAYLOAD, 1, 4096, c.hex]));
    v.errors.forEach((c: { code: string; hex: string }, i: number) => {
      expect(got[i]).toBe(reference(c.hex, LINK2_TCP_PAYLOAD, true));
      expect(text(got[i].split(":")[3].split(" ")[0])).toContain(`"code":"${c.code}"`);
      expect(Number(got[i].split(":")[1]) & LINK2_FLAG.error).toBe(LINK2_FLAG.error);
    });
  });

  test("channel.json: LINK_APP_MSG, event units, and a late progress event read by its id's range", () => {
    const v = vector("channel.json");
    for (const c of v.sizes) {
      expect(one("appmsg", c.payloadLimit)).toBe(String(c.appMessage));
      expect(appMessageLimit(c.payloadLimit)).toBe(c.appMessage);
    }
    for (const c of v.eventWindow.costs) {
      expect(one("units", c.jsonBytes)).toBe(String(c.units));
      expect(eventUnits(c.jsonBytes)).toBe(c.units);
    }
    const late = new Uint8Array(Buffer.from(v.lateProgress.frame.hex, "hex"));
    const id = new DataView(late.buffer).getUint32(8, true);
    expect(one("event", id, 0, JSON.parse(text(v.lateProgress.frame.hex.slice(24))).t, 0, 0, 0, 0)).toBe(v.lateProgress.reading);
    expect(v.response.window).toBe(LINK2_APP_STREAM_WINDOW);
  });

  test("streams.json: DATA past credit, a grant over 16 MiB, an unknown event on a fresh id", () => {
    const v = vector("streams.json");
    expect(one("received", v.pastCredit.granted, v.pastCredit.data)).toBe(v.pastCredit.close);
    expect(one("received", v.pastCredit.granted, v.pastCredit.granted)).toBe("ok");
    expect(one("grant", ...v.grantOver16MiB.grants)).toBe(v.grantOver16MiB.close);
    expect(one("grant", ...v.grantAt16MiB.grants)).toBe("ok");
    const unknown = new Uint8Array(Buffer.from(v.unknownEventWithFreshId[0].hex, "hex"));
    const id = new DataView(unknown.buffer).getUint32(8, true);
    expect(one("event", id, 0, JSON.parse(text(v.unknownEventWithFreshId[0].hex.slice(24))).t, 0, 0, 0, 0)).toBe("reset-refused");
    expect(one("reset", id, LINK2_RESET.refused)).toBe(v.unknownEventWithFreshId[1].hex);
    expect(one("reset", 33, LINK2_RESET.cancelled)).toBe(v.senderWithoutCredit.eventStream);
    expect(v.shortOfDeclared.eventStream).toBe("length");
  });
});

describe("Pocket Link 2 C wire layer against the reference codec", () => {
  test("the four steps of reading an EVENT, for every id, flag, name and holding", () => {
    const ids = [0, 1, 9, 0x7fff_ffff, 0x8000_0000, 0x8000_0001, 0x8000_0007, 0xffff_ffff];
    const names = [null, "features", "log", "runtime.install", "net.head", "channel.close", "agent.screen", "runtime.screenshot", "tile.stale", "agent.hologram"];
    const rows: (string | number)[][] = [];
    const expected: string[] = [];
    for (const id of ids) for (const app of [false, true]) for (const t of names) for (let bits = 0; bits < 16; bits++) {
      const flag = (bit: number) => (bits & bit) !== 0;
      const holds: Holdings = { channelRequest: () => flag(1), ownRequest: () => flag(2), channel: () => flag(4), inUse: () => flag(8) };
      const reading = readEvent("device", id, app, t, holds);
      const opens = (reading.read === "app" || reading.read === "system") && reading.opensStream;
      rows.push(["event", id, app ? 1 : 0, t ?? "-", flag(1) ? 1 : 0, flag(2) ? 1 : 0, flag(4) ? 1 : 0, flag(8) ? 1 : 0]);
      expected.push(`${reading.read}${opens ? ":stream" : ""}`);
    }
    expect(run(rows)).toEqual(expected);
  });

  test("the header checks of every frame type", () => {
    const rows: (string | number)[][] = [];
    const expected: string[] = [];
    for (const type of [...Object.values(LINK2_FRAME), 0x30]) for (const flags of [0, 1, 2, 4, 6, 7, 0x80]) for (const id of [0, 5, 0x8000_0000, 0x8000_0005]) for (const length of [0, 3, 4, 5, 124, 125, 1024, 1025]) {
      rows.push(["check", type, flags, id, length]);
      try {
        checkFrame(type, flags, id, length);
        expected.push("ok");
      } catch (error) {
        expected.push((error as LinkCloseError).code);
      }
    }
    expect(run(rows)).toEqual(expected);
  });

  test("a frame over the limit is refused at its header; an unknown type is skipped by length", () => {
    const header = (type: number, length: number, id = 0x8000_0001) => one("header", type, 0, length, id);
    expect(one("frames", 1024, 1, 4096, header(LINK2_FRAME.data, 1025))).toBe("too_large");
    expect(one("frames", LINK2_PAYLOAD_CEILING, 1, 4096, header(LINK2_FRAME.data, 32769))).toBe("too_large");
    const unknown = `${header(0x30, 3)}aabbcc${one("ping", 1)}`;
    expect(one("frames", LINK2_TCP_PAYLOAD, 1, 5, unknown)).toBe(reference(unknown, LINK2_TCP_PAYLOAD, true));
    expect(one("frames", 512, 1, 4096, one("ping", 1))).toStartWith("badlimit");
    for (const [code, name] of Object.entries(LINK2_CLOSE).map(([n, c]) => [c, n] as const)) expect(one("closename", code)).toBe(name);
    expect(one("closename", 10)).toBe("going_away");
    expect(one("close", LINK2_CLOSE.protocol, hex("é".repeat(80))).length).toBe((12 + 4 + 120) * 2);
  });

  test("JSON strings, their encoded size and their prefix, as JSON.stringify writes them", () => {
    const samples = ['plain', 'quote " slash \\ newline \n tab \t bell \u0007 cr \r ff \f bs \b', "é😀☃", "\u0000\u001f\u007f", "", "a".repeat(300), "😀".repeat(40), 'x"'.repeat(50)];
    const strings = run(samples.map((s) => ["string", hex(s)]));
    samples.forEach((s, i) => expect(strings[i] === "-" ? "" : text(strings[i])).toBe(JSON.stringify(s)));
    for (const max of [0, 1, 5, 24, 64, 120]) {
      const got = run(samples.map((s) => ["encoded", hex(s), max]));
      samples.forEach((s, i) => expect(got[i]).toBe(`${encodedBytes(s)}|${utf8.encode(encodedPrefix(s, max)).length}`));
    }
  });

  test("the applet stream window grants only against a pending read, as the reference does", () => {
    let seed = 12345;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) >>> 0) % n;
    for (let round = 0; round < 40; round++) {
      const window = new AppletStreamWindow(LINK2_APP_STREAM_WINDOW);
      const ops: string[] = [];
      const expected: string[] = [];
      let outstanding = 0;
      for (let step = 0; step < 60; step++) {
        const kind = random(4);
        if (kind === 0) {
          const n = random(20000);
          window.read(n);
          ops.push(`r${n}`);
        } else if (kind === 1) {
          const due = window.grant();
          outstanding += due;
          ops.push("g");
          expected.push(`g${due}`);
        } else if (kind === 2) {
          if (outstanding === 0) continue;
          const n = 1 + random(outstanding);
          window.received(n);
          outstanding -= n;
          ops.push(`d${n}`);
        } else {
          const budget = random(20000);
          ops.push(`t${budget}`);
          expected.push(`t${Math.max(0, window.take(budget))}`);
        }
        expect(window.occupied).toBeLessThanOrEqual(LINK2_APP_STREAM_WINDOW);
      }
      expected.push(`o${window.occupied}`);
      expect(one("window", LINK2_APP_STREAM_WINDOW, ...ops)).toBe(expected.join(" "));
    }
    expect(one("window", 16384, "r16384", "g", "d16385")).toBe("g16384 flow o16384");
  });

  test("CRC-32, native names and applet names", () => {
    const bytes = new Uint8Array(5000).map((_, i) => (i * 31 + 7) & 255);
    expect(one("crc", hex(bytes))).toBe(String(Bun.hash.crc32(bytes) >>> 0));
    const native = ["app.3dsx", "a.3dsx", ".x.3dsx", "pocket-shell-v2026.11.02.3dsx", "bad name.3dsx", "x.3dsX", `${"n".repeat(59)}.3dsx`, `${"n".repeat(60)}.3dsx`];
    const NATIVE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.3dsx$/;
    expect(run(native.map((n) => ["nativename", hex(n)]))).toEqual(native.map((n) => (n.length >= 6 && n.length <= 64 && NATIVE.test(n) ? "1" : "0")));
    const app = ["tile.get", "Tile", "", "a".repeat(64), "a".repeat(65), "x y", "log", "a_b-c.9"];
    expect(run(app.map((n) => ["appname", hex(n)]))).toEqual(app.map((n) => (n.length > 0 && n.length <= 64 && /^[a-z0-9._-]+$/.test(n) ? "1" : "0")));
  });
});
