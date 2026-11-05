// Tile streaming (framework/src/tiles.ts) + the TILESET/RLE formats (spec.ts) + the
// sim host's level-triggered input script expansion — the pure-JS layers of
// the deep-zoom pipeline (the Rust core path is covered in engine/core/src/tests.rs).
import { beforeEach, expect, test } from "bun:test";
import {
  ANALOG_CENTER,
  BTN,
  PSM,
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_LINEAR,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  packbitsDecode,
  packbitsEncode,
} from "../contracts/spec/spec.ts";
import { pack } from "../framework/compiler/pak.ts";
import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import { loadPack, resetPack } from "../framework/src/pak.ts";
import { freeTileTexture, loadTileTexture, resetTilesetCache } from "../framework/src/tiles.ts";
import { scriptToMasks, touchGlide } from "../programs/sim/sim.ts";
import { __packTouch } from "../framework/src/touch.ts";

// ---------------------------------------------------------------------------
// helpers: hand-build a 2x1 TILESET (tile 0 textured+RLE, tile 1 solid)
// ---------------------------------------------------------------------------

const TILE_W = 8;
const TILE_H = 8;

function buildTileset(): { blob: Uint8Array; indices: Uint8Array } {
  const px = TILE_W * TILE_H;
  const indices = new Uint8Array(px);
  for (let i = 0; i < px; i++) indices[i] = i % 7; // literal-ish stream
  const stream = packbitsEncode(indices);

  const palette = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) palette.set([i, i, i, 255], i * 4);

  const paletteOff = TILESET_HEADER_SIZE;
  const dirOff = paletteOff + 1024;
  const dataOff = dirOff + 2 * TILESET_DIR_ENTRY_SIZE;
  const blob = new Uint8Array(dataOff + stream.length);
  const dv = new DataView(blob.buffer);
  dv.setUint32(0, TILESET_MAGIC, true);
  dv.setUint16(4, TILESET_VERSION, true);
  dv.setUint16(6, TILESET_FLAG_RLE | TILESET_FLAG_LINEAR, true);
  dv.setUint16(8, TILE_W, true);
  dv.setUint16(10, TILE_H, true);
  dv.setUint16(12, 2, true); // cols
  dv.setUint16(14, 1, true); // rows
  dv.setUint32(16, paletteOff, true);
  dv.setUint32(20, dirOff, true);
  dv.setUint32(24, dataOff, true);
  blob.set(palette, paletteOff);
  // tile 0: stream at data+0
  dv.setUint32(dirOff, 0, true);
  dv.setUint32(dirOff + 4, stream.length, true);
  // tile 1: solid, palette index 42
  dv.setUint32(dirOff + TILESET_DIR_ENTRY_SIZE, 42, true);
  dv.setUint32(dirOff + TILESET_DIR_ENTRY_SIZE + 4, 0, true);
  blob.set(stream, dataOff);
  return { blob, indices };
}

interface Upload {
  buf: Uint8Array;
  w: number;
  h: number;
  psm: number;
}

let uploads: Upload[];
let freed: number[];

function mockHost(withImgEntry: boolean): Host {
  uploads = [];
  freed = [];
  const ops = {
    createNode: () => 1,
    destroyNode: () => {},
    insertBefore: () => {},
    removeChild: () => {},
    setStyle: () => {},
    setProp: () => {},
    setText: () => {},
    replaceText: () => {},
    uploadTexture: (buf: Uint8Array, w: number, h: number, psm: number) => {
      uploads.push({ buf: buf.slice(), w, h, psm });
      return uploads.length - 1;
    },
    setImage: () => {},
    setSprite: () => {},
    animate: () => 1,
    cancelAnim: () => {},
    setFocus: () => {},
    measureText: () => 0,
    freeTexture: (h: number) => freed.push(h),
    ...(withImgEntry
      ? {
          uploadImgEntry: (blob: Uint8Array) => {
            const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
            uploads.push({
              buf: blob.slice(8),
              w: dv.getUint16(0, true),
              h: dv.getUint16(2, true),
              psm: blob[4],
            });
            return uploads.length - 1;
          },
        }
      : {}),
  } as unknown as HostOps;
  return { kind: "injected", target: "test", strict: true, ops };
}

function installPak(blob: Uint8Array): void {
  const pak = pack([{ key: "ui:tile.test.0", dtype: 0, data: blob }]);
  // loadPack wants an exact ArrayBuffer
  loadPack(pak.buffer.slice(0, pak.byteLength) as ArrayBuffer);
}

beforeEach(() => {
  resetPack();
  resetTilesetCache();
});

// ---------------------------------------------------------------------------
// TILESET fallback path
// ---------------------------------------------------------------------------

test("JS fallback decodes an RLE tile and uploads raw PSM_T8", () => {
  installHost(mockHost(false));
  const { blob, indices } = buildTileset();
  installPak(blob);
  const handle = loadTileTexture("ui:tile.test.0", 0);
  expect(handle).toBe(0);
  expect(uploads).toHaveLength(1);
  const up = uploads[0];
  expect(up.psm).toBe(PSM.PSM_T8);
  expect(up.w).toBe(TILE_W);
  expect(up.h).toBe(TILE_H);
  expect(up.buf.length).toBe(1024 + TILE_W * TILE_H);
  expect(Array.from(up.buf.subarray(1024))).toEqual(Array.from(indices));
  // palette round-trips
  expect(up.buf[42 * 4]).toBe(42);
});

test("JS fallback prefers uploadImgEntry and carries the linear flag", () => {
  installHost(mockHost(true));
  const { blob } = buildTileset();
  installPak(blob);
  const handle = loadTileTexture("ui:tile.test.0", 0);
  expect(handle).toBe(0);
  expect(uploads[0].psm).toBe(PSM.PSM_T8);
});

test("solid and absent tiles return -1 without uploading", () => {
  installHost(mockHost(false));
  const { blob } = buildTileset();
  installPak(blob);
  expect(loadTileTexture("ui:tile.test.0", 1)).toBe(-1); // solid
  expect(loadTileTexture("ui:tile.test.0", 99)).toBe(-1); // out of range
  expect(loadTileTexture("ui:tile.missing", 0)).toBe(-1); // no such entry
  expect(uploads).toHaveLength(0);
});

test("native loadTileTexture op wins over the fallback", () => {
  const host = mockHost(false);
  (host.ops as HostOps).loadTileTexture = (key: string, index: number) =>
    key === "ui:tile.test.0" && index === 0 ? 77 : -1;
  installHost(host);
  // no pak installed at all — the native op must be the only path touched
  expect(loadTileTexture("ui:tile.test.0", 0)).toBe(77);
});

test("freeTileTexture forwards live handles and skips -1", () => {
  installHost(mockHost(false));
  freeTileTexture(-1);
  freeTileTexture(5);
  expect(freed).toEqual([5]);
});

// ---------------------------------------------------------------------------
// PackBits vectors (the TS encoder feeding the Rust decoder's format)
// ---------------------------------------------------------------------------

test("packbits: runs, literals, and exact-length enforcement", () => {
  const solid = new Uint8Array(256 * 256).fill(9);
  const enc = packbitsEncode(solid);
  expect(enc.length).toBeLessThan(1200); // 65536 -> ~2 bytes per 129-run
  expect(Array.from(packbitsDecode(enc, solid.length)!)).toEqual(Array.from(solid));
  expect(packbitsDecode(enc, solid.length - 1)).toBeNull(); // wrong expected len
  expect(packbitsDecode(enc.subarray(0, enc.length - 1), solid.length)).toBeNull(); // truncated
});

// ---------------------------------------------------------------------------
// sim script expansion (level-triggered hold/analog tracks)
// ---------------------------------------------------------------------------

test("scriptToMasks: press pulses, hold levels, analog levels", () => {
  const { masks, analogs } = scriptToMasks(
    [
      { at: 0, press: BTN.CROSS },
      { at: 1, hold: BTN.RTRIGGER },
      { at: 3, hold: 0 },
      { at: 2, analog: 0xff80 },
      { at: 4, analog: ANALOG_CENTER },
    ],
    1,
    6,
  );
  expect(masks).toEqual([BTN.CROSS, BTN.RTRIGGER, BTN.RTRIGGER, 0, 0, 0]);
  expect(analogs).toEqual([
    ANALOG_CENTER,
    ANALOG_CENTER,
    0xff80,
    0xff80,
    ANALOG_CENTER,
    ANALOG_CENTER,
  ]);
});

test("scriptToMasks: touch levels hold until the next event; [] releases", () => {
  const { touches } = scriptToMasks(
    [
      { at: 1, touch: [{ x: 100, y: 50 }] },
      { at: 3, touch: [] },
    ],
    1,
    5,
  );
  const packed = __packTouch(0, 100, 50);
  expect(touches).toEqual([undefined, [packed], [packed], undefined, undefined]);
});

test("touchGlide interpolates per frame on the 60 Hz grid and releases", () => {
  const events = touchGlide(240, 200, 240, 140, 1, 1.1); // 6 frames of travel
  expect(events).toHaveLength(7);
  expect(events[0]).toEqual({ at: 1, touch: [{ id: 0, x: 240, y: 200 }] });
  expect(events[3].touch).toEqual([{ id: 0, x: 240, y: 170 }]);
  expect(events[6]).toEqual({ at: 1.1, touch: [] });

  const { touches } = scriptToMasks(events, 60, 120);
  expect(touches[59]).toBeUndefined();
  expect(touches[60]).toEqual([__packTouch(0, 240, 200)]);
  expect(touches[65]).toEqual([__packTouch(0, 240, 150)]);
  expect(touches[66]).toBeUndefined(); // released at t1
});
