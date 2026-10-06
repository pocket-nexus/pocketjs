// PARAM.SFO (PSF 1.1): the key/value table a PSP EBOOT.PBP and a PS Vita
// VPK (sce_sys/param.sfo) carry. Layout: a 20-byte header ("\0PSF", version
// 0x0101, key table offset, data table offset, entry count), 16-byte index
// rows {u16 key offset, u16 format, u32 used, u32 room, u32 data offset}, the
// NUL-terminated key names padded to 4 bytes, then the values. Entries are
// written sorted by key (the firmware looks keys up in order, and mksfo
// writes them so).

export const SFO_FORMAT = {
  /** UTF-8 without a terminator (the Vita's special strings). */
  utf8Special: 0x0004,
  /** UTF-8 with a NUL terminator. */
  utf8: 0x0204,
  integer: 0x0404,
} as const;

export interface SfoEntry {
  readonly key: string;
  readonly value: string | number;
  /**
   * Bytes reserved for a string value (its "max length"), at least the
   * UTF-8 length plus the NUL. Default: that length rounded up to 4.
   */
  readonly room?: number;
}

export function writeSfo(entries: readonly SfoEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.key === sorted[i - 1]!.key) throw new Error(`sfo: duplicate key ${sorted[i]!.key}`);
  }
  const values = sorted.map((entry) => {
    if (!/^[A-Z0-9_]+$/.test(entry.key)) throw new Error(`sfo: invalid key ${entry.key}`);
    if (typeof entry.value === "number") {
      if (!Number.isInteger(entry.value) || entry.value < 0 || entry.value > 0xffffffff) {
        throw new Error(`sfo: ${entry.key} must be a u32`);
      }
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, entry.value, true);
      return { format: SFO_FORMAT.integer, used: 4, bytes };
    }
    const text = new TextEncoder().encode(entry.value);
    if (text.includes(0)) throw new Error(`sfo: ${entry.key} contains NUL`);
    const used = text.length + 1;
    const room = entry.room ?? Math.ceil(used / 4) * 4;
    if (room < used || room % 4 !== 0) throw new Error(`sfo: ${entry.key} needs ${used} bytes; room is ${room}`);
    const bytes = new Uint8Array(room);
    bytes.set(text);
    return { format: SFO_FORMAT.utf8, used, bytes };
  });
  const names = new TextEncoder().encode(sorted.map((entry) => `${entry.key}\0`).join(""));
  const keyTable = 20 + sorted.length * 16;
  const dataTable = keyTable + Math.ceil(names.length / 4) * 4;
  const out = new Uint8Array(dataTable + values.reduce((sum, v) => sum + v.bytes.length, 0));
  const view = new DataView(out.buffer);
  out.set([0, 0x50, 0x53, 0x46]); // "\0PSF"
  view.setUint32(4, 0x0101, true);
  view.setUint32(8, keyTable, true);
  view.setUint32(12, dataTable, true);
  view.setUint32(16, sorted.length, true);
  let nameAt = 0;
  let dataAt = 0;
  sorted.forEach((entry, i) => {
    const row = 20 + i * 16;
    const value = values[i]!;
    view.setUint16(row, nameAt, true);
    view.setUint16(row + 2, value.format, true);
    view.setUint32(row + 4, value.used, true);
    view.setUint32(row + 8, value.bytes.length, true);
    view.setUint32(row + 12, dataAt, true);
    out.set(value.bytes, dataTable + dataAt);
    nameAt += new TextEncoder().encode(entry.key).length + 1;
    dataAt += value.bytes.length;
  });
  out.set(names, keyTable);
  return out;
}

export interface SfoValue {
  readonly key: string;
  readonly format: number;
  readonly value: string | number;
  readonly used: number;
  readonly room: number;
}

/** Every entry of a PARAM.SFO, in table order. */
export function readSfo(bytes: Uint8Array): SfoValue[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, false) !== 0x00505346) throw new Error("sfo: not a PARAM.SFO");
  const keyTable = view.getUint32(8, true);
  const dataTable = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  const out: SfoValue[] = [];
  for (let i = 0; i < count; i++) {
    const row = 20 + i * 16;
    const keyAt = keyTable + view.getUint16(row, true);
    const keyEnd = bytes.indexOf(0, keyAt);
    const key = new TextDecoder().decode(bytes.subarray(keyAt, keyEnd));
    const format = view.getUint16(row + 2, true);
    const used = view.getUint32(row + 4, true);
    const room = view.getUint32(row + 8, true);
    const at = dataTable + view.getUint32(row + 12, true);
    const value = format === SFO_FORMAT.integer
      ? view.getUint32(at, true)
      : new TextDecoder().decode(bytes.subarray(at, at + used)).replace(/\0+$/, "");
    out.push({ key, format, value, used, room });
  }
  return out;
}
