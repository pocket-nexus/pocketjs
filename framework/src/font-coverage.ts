import { FONT_MAGIC, FONT_HEADER_SIZE, FONT_CMAP_ENTRY_SIZE } from "../../contracts/spec/spec.ts";
import { entries, get } from "./pak.ts";

/** Read each slot's baked cmap once, without copying its coverage pixels.
 * Coverage is a property of the shipped atlas, not Unicode's ASCII range. */
export function createBakedFontCoverage() {
  const slots = new Map<number, Set<number>>();
  return (scalar: string, slot: number): boolean => {
    let coverage = slots.get(slot);
    if (!coverage) {
      coverage = new Set<number>();
      const key = `ui:font.${slot}`;
      if (entries(key).includes(key)) {
        const header = new DataView(get(key, 0, FONT_HEADER_SIZE).buffer);
        const version = header.getUint16(4, true), count = header.getUint16(6, true);
        if (header.getUint32(0, true) === FONT_MAGIC && (version === 2 || version === 3) && header.getUint8(12) === slot) {
          const cmap = new DataView(get(key, FONT_HEADER_SIZE, FONT_HEADER_SIZE + count * FONT_CMAP_ENTRY_SIZE).buffer);
          for (let i = 0; i < count; i++) {
            const offset = i * FONT_CMAP_ENTRY_SIZE;
            if (cmap.getUint16(offset + 4, true) !== 0) coverage.add(cmap.getUint32(offset, true));
          }
        }
      }
      slots.set(slot, coverage);
    }
    return coverage.has(scalar.codePointAt(0)!);
  };
}
