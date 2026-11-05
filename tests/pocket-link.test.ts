// The Pocket Link reference implementation (tools/pocket-link/*) against
// contracts/spec/link.ts: protocol vectors, the destination policy, and the
// pairing QR encoder. The companion's live-link tests run in Pocket Hub, which
// drives its daemon with tools/pocket-link/console-client.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
LINK_BEACON_BYTES,
LINK_FRAME,
LINK_MAX_DATA,
LINK_MAX_FRAME,
LINK_PAIR_URI_MAX,
} from "../contracts/spec/link.ts";
import { isPrivateAddress } from "../tools/pocket-link/fetch.ts";
import {
LinkFrameDecoder,
LinkProtocolError,
buildPairUri,
companionProof,
consoleProof,
decodeBeacon,
encodeBeacon,
encodeCtrl,
encodeData,
encodeFrame,
encodePreamble,
maskKey,
parsePairUri,
} from "../tools/pocket-link/protocol.ts";
import { byteCapacity, encodeQr, functionModules, rasterizeQr, type QrCode } from "../tools/pocket-link/qr.ts";
import { encodePNG } from "../tools/png.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "pocket-link-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let dirCount = 0;
const freshDir = (label: string) => {
  const dir = join(tmpRoot, `${label}-${dirCount++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// ---------------------------------------------------------------------------
// Protocol vectors
// ---------------------------------------------------------------------------

describe("protocol", () => {
  const h = {
    nD: "00112233445566778899aabbccddeeff",
    nC: "ffeeddccbbaa99887766554433221100",
    device: "0123456789abcdef",
    companion: "fedcba9876543210",
  };
  const key = "a".repeat(64);
  const hmac = (secret: string, message: string) => createHmac("sha256", Buffer.from(secret, "hex")).update(message).digest("hex");

  test("proofs are HMAC-SHA256 over the label strings from link.ts", () => {
    const tail = `\n${h.nD}\n${h.nC}\n${h.device}\n${h.companion}`;
    expect(companionProof(key, h)).toBe(hmac(key, `pocket-link/1/companion${tail}`));
    expect(consoleProof(key, h)).toBe(hmac(key, `pocket-link/1/console${tail}`));
    expect(companionProof(key, h)).not.toBe(consoleProof(key, h));
    // Pinned so a C or Rust implementation can check itself against the same vector.
    expect(companionProof(key, h)).toBe(hmac("aa".repeat(32), `pocket-link/1/companion${tail}`));
  });

  test("the pairing key travels masked with HMAC(secret, key label + nonces)", () => {
    const secret = "0f".repeat(16);
    const mask = Buffer.from(hmac(secret, `pocket-link/1/key\n${h.nD}\n${h.nC}`), "hex");
    const linkKey = "5a".repeat(32);
    const masked = maskKey(linkKey, secret, h.nD, h.nC);
    const expected = Buffer.from(linkKey, "hex").map((b, i) => b ^ mask[i]);
    expect(masked).toBe(Buffer.from(expected).toString("hex"));
    expect(maskKey(masked, secret, h.nD, h.nC)).toBe(linkKey);
  });

  test("beacon layout", () => {
    const bytes = encodeBeacon({ pairing: true, port: 8628, companion: h.companion, name: "Studio Mac" });
    expect(bytes.length).toBe(LINK_BEACON_BYTES);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PKLB");
    expect(bytes[4]).toBe(1);
    expect(bytes[5]).toBe(1);
    expect(bytes[6] | (bytes[7] << 8)).toBe(8628);
    expect(new TextDecoder().decode(bytes.subarray(8, 24))).toBe(h.companion);
    expect(new TextDecoder().decode(bytes.subarray(24, 34))).toBe("Studio Mac");
    expect([...bytes.subarray(34)].every((b) => b === 0)).toBe(true);
    expect(decodeBeacon(bytes)).toEqual({ version: 1, pairing: true, port: 8628, companion: h.companion, name: "Studio Mac" });
    // A long UTF-8 name is cut on a code point boundary inside its 40 bytes.
    const long = decodeBeacon(encodeBeacon({ pairing: false, port: 1, companion: h.companion, name: "的".repeat(20) }))!;
    expect(long.name).toBe("的".repeat(13));
    expect(decodeBeacon(new Uint8Array(64))).toBeNull();
  });

  test("preamble and frame header", () => {
    expect([...encodePreamble()]).toEqual([0x50, 0x4b, 0x4c, 0x4b, 1, 0, 0, 0]);
    const frame = encodeCtrl({ t: "catalog", id: 7 });
    expect(frame[0]).toBe(LINK_FRAME.ctrl);
    expect([...frame.subarray(1, 4)]).toEqual([0, 0, 0]);
    expect(new DataView(frame.buffer).getUint32(4, true)).toBe(frame.length - 8);
    const data = encodeData(0x01020304, new Uint8Array([9]));
    expect([...data]).toEqual([LINK_FRAME.data, 0, 0, 0, 5, 0, 0, 0, 4, 3, 2, 1, 9]);
  });

  test("the decoder reassembles split frames and guards the frame size", () => {
    const stream = new Uint8Array([
      ...encodePreamble(),
      ...encodeFrame(LINK_FRAME.ping),
      ...encodeCtrl({ t: "hello", v: 1 }),
      ...encodeFrame(0x7f, new Uint8Array(3)),
      ...encodeData(2, new Uint8Array(LINK_MAX_DATA).fill(1)),
    ]);
    let version = -1;
    const decoder = new LinkFrameDecoder({ preamble: true, onPreamble: (v) => (version = v) });
    const frames = [];
    for (let i = 0; i < stream.length; i += 997) frames.push(...decoder.push(stream.subarray(i, i + 997)));
    expect(version).toBe(1);
    expect(frames.map((f) => f.type)).toEqual(["ping", "ctrl", "unknown", "data"]);
    expect(frames[3].type === "data" && frames[3].bytes.length).toBe(LINK_MAX_DATA);

    const header = new Uint8Array(8);
    header[0] = LINK_FRAME.data;
    new DataView(header.buffer).setUint32(4, LINK_MAX_FRAME + 1, true);
    expect(() => new LinkFrameDecoder().push(header)).toThrow(LinkProtocolError);
    expect(() => new LinkFrameDecoder({ preamble: true }).push(new Uint8Array(8))).toThrow("bad preamble");
  });

  test("pairing URI", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const uri = buildPairUri({ companion: h.companion, hosts: ["192.168.8.159", "10.0.0.2"], port: 8628, secret, name: "Evan's Mac" });
    expect(uri).toBe(`pocketlink://pair?v=1&c=${h.companion}&h=192.168.8.159,10.0.0.2&p=8628&s=${secret}&n=Evan%27s%20Mac`);
    expect(parsePairUri(uri)).toEqual({ version: 1, companion: h.companion, hosts: ["192.168.8.159", "10.0.0.2"], port: 8628, secret, name: "Evan's Mac" });
    const long = buildPairUri({ companion: h.companion, hosts: ["192.168.100.200", "192.168.101.201", "192.168.102.202", "1.1.1.1"], port: 65535, secret, name: "的".repeat(40) });
    expect(Buffer.byteLength(long)).toBeLessThan(LINK_PAIR_URI_MAX);
    const parsed = parsePairUri(long)!;
    expect(parsed.hosts.length).toBe(3);
    expect("的".repeat(40).startsWith(parsed.name)).toBe(true);
    expect(parsePairUri(uri.replace("v=1", "v=2"))).toBeNull();
    expect(parsePairUri(uri.replace("192.168.8.159", "example.com"))).toBeNull();
  });

  test("destination policy", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.8.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "0.0.0.0", "255.255.255.255", "::1", "fe80::1", "fd00::1", "ff02::1", "::ffff:192.168.1.1", "::"]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    for (const a of ["1.1.1.1", "104.20.23.154", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(a)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

// ISO/IEC 18004 level-M block table and the published BCH words, typed out
// independently of tools/pocket-link/qr.ts.
const M_TABLE: Record<number, { ec: number; blocks: number[] }> = {
  1: { ec: 10, blocks: [16] },
  2: { ec: 16, blocks: [28] },
  3: { ec: 26, blocks: [44] },
  4: { ec: 18, blocks: [32, 32] },
  5: { ec: 24, blocks: [43, 43] },
  6: { ec: 16, blocks: [27, 27, 27, 27] },
  7: { ec: 18, blocks: [31, 31, 31, 31] },
  8: { ec: 22, blocks: [38, 38, 39, 39] },
  9: { ec: 22, blocks: [36, 36, 36, 37, 37] },
  10: { ec: 26, blocks: [43, 43, 43, 43, 44] },
};
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

const GF_EXP = new Array<number>(512);
const GF_LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
const gfMul = (a: number, b: number) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

/** Read a code back: format word, version word, unmask, de-interleave, RS
 *  syndromes, byte-mode payload. */
function readQr(qr: QrCode): string {
  const m = qr.modules;
  const size = qr.size;
  let format = 0;
  const fmt = [...Array(6).keys()].map((i) => [8, i]).concat([[8, 7], [8, 8], [7, 8]], [9, 10, 11, 12, 13, 14].map((i) => [14 - i, 8]));
  fmt.forEach(([x, y], i) => (format |= (m[y][x] ? 1 : 0) << i));
  const mask = FORMAT_M.indexOf(format);
  if (mask < 0) throw new Error(`format word ${format.toString(16)} is not level M`);
  if (qr.version >= 7) {
    let word = 0;
    for (let i = 0; i < 18; i++) word |= (m[Math.floor(i / 3)][size - 11 + (i % 3)] ? 1 : 0) << i;
    if (word !== VERSION_INFO[qr.version]) throw new Error("version word");
  }
  const fn = functionModules(qr.version);
  const MASKS = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_x: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x]) bits.push((m[y][x] !== MASKS[mask](x, y)) ? 1 : 0);
      }
    }
  }
  const { ec, blocks } = M_TABLE[qr.version];
  const total = blocks.reduce((a, b) => a + b, 0) + ec * blocks.length;
  const codewords: number[] = [];
  for (let i = 0; i < total; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((n, b) => (n << 1) | b, 0));
  const split = blocks.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...blocks); i++) blocks.forEach((len, b) => i < len && split[b].push(codewords[k++]));
  for (let i = 0; i < ec; i++) blocks.forEach((_len, b) => split[b].push(codewords[k++]));
  const data: number[] = [];
  split.forEach((block, b) => {
    for (let s = 0; s < ec; s++) {
      let acc = 0;
      for (const c of block) acc = gfMul(acc, GF_EXP[s]) ^ c;
      if (acc !== 0) throw new Error(`block ${b} syndrome ${s} = ${acc}`);
    }
    data.push(...block.slice(0, blocks[b]));
  });
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >> i) & 1));
  const read = (at: number, n: number) => stream.slice(at, at + n).reduce((v, b) => (v << 1) | b, 0);
  if (read(0, 4) !== 0b0100) throw new Error("not byte mode");
  const countBits = qr.version <= 9 ? 8 : 16;
  const count = read(4, countBits);
  const bytes = Uint8Array.from({ length: count }, (_, i) => read(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(bytes);
}

describe("qr", () => {
  const cases: string[] = [];
  for (let v = 1; v <= 10; v++) {
    const cap = byteCapacity(v);
    cases.push("p".repeat(cap));
  }
  cases.push(buildPairUri({ companion: "fedcba9876543210", hosts: ["192.168.8.159"], port: 8628, secret: "0123456789abcdef0123456789abcdef", name: "evan的MacBook Pro" }));

  test("capacities match level M byte mode", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(byteCapacity)).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
    expect(encodeQr("x".repeat(14)).version).toBe(1);
    expect(encodeQr("x".repeat(15)).version).toBe(2);
    expect(() => encodeQr("x".repeat(214))).toThrow();
  });

  test("every version and mask reads back with zero syndromes", () => {
    for (const [i, text] of cases.entries()) {
      for (let mask = 0; mask < 8; mask++) {
        const qr = encodeQr(text, { mask });
        expect(qr.version).toBe(i < 10 ? i + 1 : qr.version);
        expect(readQr(qr)).toBe(text);
      }
      expect(readQr(encodeQr(text))).toBe(text);
    }
  });

  const swiftc = process.platform === "darwin" ? Bun.which("swiftc") : null;
  test.skipIf(!swiftc)("CoreImage's detector decodes the codes (macOS)", () => {
    const dir = freshDir("qr");
    const decoder = join(dir, "qrdecode");
    writeFileSync(
      join(dir, "qrdecode.swift"),
      `import CoreImage
import Foundation
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
for path in CommandLine.arguments.dropFirst() {
  let image = CIImage(contentsOf: URL(fileURLWithPath: path))!
  let text = detector.features(in: image).compactMap { $0 as? CIQRCodeFeature }.first?.messageString ?? ""
  print(Data(text.utf8).base64EncodedString())
}
`,
    );
    const build = spawnSync(swiftc!, ["-O", join(dir, "qrdecode.swift"), "-o", decoder], { encoding: "utf8" });
    expect(build.status).toBe(0);
    const files = cases.map((text, i) => {
      const { width, pixels } = rasterizeQr(encodeQr(text), 6);
      const rgba = new Uint8Array(width * width * 4);
      for (let p = 0; p < pixels.length; p++) rgba.fill(pixels[p], p * 4, p * 4 + 3), (rgba[p * 4 + 3] = 255);
      const file = join(dir, `${i}.png`);
      writeFileSync(file, encodePNG(rgba, width, width));
      return file;
    });
    const run = spawnSync(decoder, files, { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n").map((line) => Buffer.from(line, "base64").toString())).toEqual(cases);
  });
});
