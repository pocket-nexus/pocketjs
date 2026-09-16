/** Font archive v1: immutable scalar cmap + packed coverage on external storage.
 * All integers LE. Header: 64 bytes (magic, version, total, strike count,
 * SHA256 identity at 16). Each 32-byte strike stores slot,w,h,baseline,lineHeight,
 * advance,density,flags, then u32 count,indexOffset,dataOffset,dataBytes.
 * Sorted 12-byte cmap entries: u32 scalar,u16 gid,u8 advance,u8 xoff,u32 FNV1a.
 * Cells are row-major 2-bit alpha, high bits first; fixed ceil(w*h/4) bytes.
 * No archive pixels or complete cmap need to be resident on the device. */
export const FONT_ARCHIVE = Object.freeze({
  magic: 0x41464a50,
  version: 1,
  headerBytes: 64,
  strikeBytes: 32,
  entryBytes: 12,
  maxStrikes: 24,
  maxPixels: 4096,
  maxBatch: 4,
  maxGlyphs: 65535,
  maxBytes: 128 * 1024 * 1024,
  // PFS1 config: u16 capacity at 16, reserved zero at 18.
  configMagic: 0x31534650,
  glyphMagic: 0x31474650,
  batchMagic: 0x31424650,
  maxResidentEntries: 4096,
  maxBatches: 32,
  maxTextLength: 65536,
  maxResidentBytes: 2 * 1024 * 1024,
});
export interface ArchiveStrike {
  slot: number;
  width: number;
  height: number;
  baseline: number;
  lineHeight: number;
  advance: number;
  density: number;
  count: number;
}
export interface ArchiveFace {
  generation: number;
  identity: string;
  strikes: ArchiveStrike[];
}

/** Compact font.open reply keeps all 24 strike descriptors within one record. */
export function decodeArchiveFace(text: string): ArchiveFace {
  const raw = JSON.parse(text);
  if (
    !Number.isInteger(raw.generation) ||
    raw.generation <= 0 ||
    raw.generation > 0xffffffff ||
    typeof raw.identity !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.identity) ||
    !Array.isArray(raw.strikes) ||
    !raw.strikes.length ||
    raw.strikes.length > FONT_ARCHIVE.maxStrikes
  )
    throw new Error("Invalid font descriptor");
  const seen = new Set<number>();
  const strikes = raw.strikes.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 8 || !row.every(Number.isInteger))
      throw new Error("Invalid strike descriptor");
    const [slot, width, height, baseline, lineHeight, advance, density, count] =
      row;
    if (
      slot < 0 ||
      slot >= 24 ||
      seen.has(slot) ||
      width < 1 ||
      width > 255 ||
      height < 1 ||
      height > 255 ||
      width * height > FONT_ARCHIVE.maxPixels ||
      baseline < 0 ||
      baseline > height ||
      lineHeight < 1 ||
      lineHeight > 255 ||
      advance < 1 ||
      advance > 255 ||
      density !== 1 ||
      count < 1 ||
      count > 65535
    )
      throw new Error("Invalid strike geometry");
    seen.add(slot);
    return {
      slot,
      width,
      height,
      baseline,
      lineHeight,
      advance,
      density,
      count,
    };
  });
  return { generation: raw.generation, identity: raw.identity, strikes };
}
