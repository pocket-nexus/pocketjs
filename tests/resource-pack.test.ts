import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import {
  createResourcePack,
  crc32,
  prepareTiledRGB565,
} from "../apps/manga/pack-format.ts";

test("prepared RGB565 preserves channels, vertical origin and Morton texel locations", () => {
  const source = Buffer.alloc(16 * 16 * 2);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      source.writeUInt16LE(
        (x & 31) | ((y & 63) << 5) | (7 << 11),
        (y * 16 + x) * 2,
      );
  const tiled = prepareTiledRGB565(source, 16, 16);
  // Independent deinterleaving of the destination Morton index.
  for (let block = 0; block < 4; block++)
    for (let n = 0; n < 64; n++) {
      let x = 0,
        y = 0;
      for (let b = 0; b < 3; b++) {
        x |= ((n >>> (2 * b)) & 1) << b;
        y |= ((n >>> (2 * b + 1)) & 1) << b;
      }
      x += (block % 2) * 8;
      y += Math.floor(block / 2) * 8;
      expect(tiled.readUInt16LE((block * 64 + n) * 2)).toBe(
        (x << 11) | ((15 - y) << 5) | 7,
      );
    }
  expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
});

test("desktop pack bake and actual native worker agree on bounds, CRC and ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-pack-"));
  try {
    const root = join(directory, "sdmc:/pocketjs/assets/test");
    mkdirSync(root, { recursive: true });
    const path = join(root, "valid.prp"),
      pack = createResourcePack(path, 2);
    pack.add(Buffer.from("{}"));
    pack.add(Buffer.alloc(512, 42), { width: 16, height: 16 });
    pack.finish();
    const bytes = readFileSync(path),
      at = bytes.readUInt32LE(88),
      length = bytes.readUInt32LE(92);
    expect(inflateSync(bytes.subarray(at, at + length))).toEqual(
      Buffer.alloc(512, 42),
    );
    const checksum = Buffer.from(bytes);
    checksum.writeUInt32LE(0, 100);
    writeFileSync(join(root, "checksum.prp"), checksum);
    const offset = Buffer.from(bytes);
    offset.writeUInt32LE(0xffffffff, 88);
    writeFileSync(join(root, "offset.prp"), offset);
    writeFileSync(join(root, "truncated.prp"), bytes.subarray(0, 72));
    const noise = Buffer.alloc(131072);
    let seed = 1;
    for (let n = 0; n < noise.length; n++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      noise[n] = seed & 255;
    }
    const noisy = createResourcePack(join(root, "noise.prp"), 1);
    noisy.add(noise, { width: 256, height: 256 });
    noisy.finish();
    const full = readFileSync(join(root, "noise.prp"));
    expect(full.readUInt32LE(68)).toBeGreaterThan(131072);
    const binary = join(directory, "worker");
    const compile = Bun.spawnSync(
      [
        "cc",
        "-std=c11",
        "-O1",
        "-pthread",
        "-fsanitize=address,undefined",
        '-DPOCKETJS_RUNTIME_SLOT="test"',
        "-I" + resolve("tests/fixtures/resource-pack"),
        "-I" + resolve("hosts/3ds/include"),
        resolve("tests/fixtures/resource-pack/main.c"),
        "-lz",
        "-o",
        binary,
      ],
      { timeout: 20000 },
    );
    if (compile.exitCode !== 0) throw Error(compile.stderr.toString());
    const run = Bun.spawnSync([binary], { cwd: directory, timeout: 10000 });
    if (run.exitCode !== 0) throw Error(run.stderr.toString());
    expect(run.stdout.toString()).toContain("stalled-read UI verified");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
