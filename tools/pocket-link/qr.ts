// A QR code encoder for the pairing URI: byte mode, error correction level M,
// versions 1–10 (ISO/IEC 18004). The smallest version that holds the data is
// chosen, then the mask with the lowest penalty score.

/** Level M block structure per version: [ec codewords per block, [blocks, data codewords per block]...]. */
const M_BLOCKS: readonly (readonly [number, readonly (readonly [number, number])[]])[] = [
  [0, []], // version 0 does not exist
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

export const QR_MAX_VERSION = 10;

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

export function dataCodewords(version: number): number {
  return M_BLOCKS[version][1].reduce((n, [blocks, per]) => n + blocks * per, 0);
}

/** Bytes a version holds in byte mode at level M. */
export function byteCapacity(version: number): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// --- GF(256) / Reed–Solomon ---------------------------------------------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

// --- codewords -------------------------------------------------------------------

function encodeCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLen, groups] = M_BLOCKS[version];
  const divisor = rsDivisor(ecLen);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let off = 0;
  for (const [count, per] of groups) {
    for (let b = 0; b < count; b++) {
      const chunk = data.slice(off, off + per);
      off += per;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, divisor) });
    }
  }
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ecLen; i++) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

// --- matrix ----------------------------------------------------------------------

class Matrix {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormat(m: Matrix, mask: number) {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(i));
  m.set(8, 7, bit(6));
  m.set(8, 8, bit(7));
  m.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.set(m.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.set(8, m.size - 15 + i, bit(i));
  m.set(8, m.size - 8, true); // the dark module
}

function drawFunctionPatterns(m: Matrix, version: number) {
  const { size } = m;
  for (let i = 0; i < size; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        m.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const positions = ALIGNMENT[version];
  const last = positions.length - 1;
  positions.forEach((py, i) =>
    positions.forEach((px, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  drawFormat(m, 0); // reserves the format areas; redrawn per mask
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.set(a, b, dark);
      m.set(b, a, dark);
    }
  }
}

function drawCodewords(m: Matrix, codewords: number[]) {
  let i = 0;
  const total = codewords.length * 8;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? m.size - 1 - vert : vert;
        if (m.isFunction[y][x]) continue;
        if (i < total) m.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++; // remainder bits stay light
      }
    }
  }
}

export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error(`mask ${mask}`);
  }
}

function applyMask(m: Matrix, mask: number) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y][x] && maskBit(mask, x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= size; i++) {
      for (const pattern of FINDER_LIKE) if (pattern.every((dark, k) => get(i + k) === dark)) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encode text (UTF-8, byte mode, level M). `mask` forces a mask (tests). */
export function encodeQr(text: string | Uint8Array, options: { minVersion?: number; mask?: number } = {}): QrCode {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let version = Math.max(1, options.minVersion ?? 1);
  while (version <= QR_MAX_VERSION && byteCapacity(version) < bytes.length) version++;
  if (version > QR_MAX_VERSION) throw new Error(`QR: ${bytes.length} bytes exceed version ${QR_MAX_VERSION}-M (${byteCapacity(QR_MAX_VERSION)} bytes)`);
  const size = 17 + 4 * version;
  const base = new Matrix(size);
  drawFunctionPatterns(base, version);
  drawCodewords(base, encodeCodewords(bytes, version));
  let best: { mask: number; modules: boolean[][]; score: number } | undefined;
  const masks = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
  for (const mask of masks) {
    const m = new Matrix(size);
    for (let y = 0; y < size; y++) {
      m.modules[y] = [...base.modules[y]];
      m.isFunction[y] = [...base.isFunction[y]];
    }
    applyMask(m, mask);
    drawFormat(m, mask);
    const score = penalty(m.modules);
    if (!best || score < best.score) best = { mask, modules: m.modules, score };
  }
  return { version, size, mask: best!.mask, modules: best!.modules };
}

/** Function-module map for a version (tests and decoders). */
export function functionModules(version: number): boolean[][] {
  const m = new Matrix(17 + 4 * version);
  drawFunctionPatterns(m, version);
  return m.isFunction;
}

/** Terminal rendering with Unicode half blocks: two module rows per text line,
 *  black on an explicit white background so the code scans on a dark terminal. */
export function renderQrTerminal(qr: QrCode, quiet = 4): string {
  const n = qr.size + quiet * 2;
  const dark = (x: number, y: number) => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx];
  };
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "\x1b[30;47m";
    for (let x = 0; x < n; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < n && dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

/** Gray8 pixels (0 = dark) at `scale` pixels per module with a quiet zone. */
export function rasterizeQr(qr: QrCode, scale = 8, quiet = 4): { width: number; pixels: Uint8Array } {
  const width = (qr.size + quiet * 2) * scale;
  const pixels = new Uint8Array(width * width).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + quiet) * scale + dy) * width + (x + quiet) * scale;
        pixels.fill(0, row, row + scale);
      }
    }
  }
  return { width, pixels };
}
