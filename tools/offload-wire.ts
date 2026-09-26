import { OFFLOAD, OFFLOAD_IMAGE, type OffloadImage } from "../contracts/spec/offload.ts";

export function encodeOffloadImage(id: number, image: OffloadImage): Buffer {
  const valid = (n: number) => Number.isInteger(n) && n >= 16 && n <= OFFLOAD_IMAGE.maxSide && (n & (n - 1)) === 0;
  if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff || !valid(image.width) || !valid(image.height) ||
      image.format !== "r5g6b5" || !(image.pixels instanceof Uint8Array) || image.pixels.byteLength !== image.width * image.height * 2)
    throw new Error("Invalid offload image envelope");
  const bytes = Buffer.allocUnsafe(4 + OFFLOAD_IMAGE.headerBytes + image.pixels.byteLength);
  bytes.writeUInt32BE((OFFLOAD_IMAGE.flag + bytes.length - 4) >>> 0);
  bytes.write("PIMG", 4); bytes.writeUInt32LE(id, 8);
  bytes.writeUInt16LE(image.width, 12); bytes.writeUInt16LE(image.height, 14); bytes.writeUInt32LE(0, 16);
  bytes.set(image.pixels, 20); return bytes;
}

export function encodeOffloadRecord(record: string): Buffer {
  const payload = Buffer.from(record);
  if (!payload.length || payload.length > OFFLOAD.recordBytes) throw new Error("Offload record budget exceeded");
  const out = Buffer.allocUnsafe(payload.length + 4);
  out.writeUInt32BE(payload.length); payload.copy(out, 4);
  return out;
}
/** Fixed allocation, including partial headers and arbitrarily split UTF-8. */
export class OffloadDecoder {
  private bytes = Buffer.alloc(OFFLOAD.recordBytes + 4);
  private have = 0;
  private want = 4;
  /** A false continueReading pauses after a complete record. The caller retains
   * the unconsumed suffix and resumes it when downstream credit returns. */
  push(chunk: Uint8Array, deliver: (record: string) => void, continueReading?: () => boolean): number {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(chunk.length - offset, this.want - this.have);
      this.bytes.set(chunk.subarray(offset, offset + n), this.have);
      this.have += n; offset += n;
      if (this.have !== this.want) continue;
      if (this.want === 4) {
        const size = this.bytes.readUInt32BE();
        if (!size || size > OFFLOAD.recordBytes) throw new Error("Invalid offload frame length");
        this.want = size + 4;
      } else {
        const record = this.bytes.toString("utf8", 4, this.want);
        this.have = 0; this.want = 4;
        deliver(record);
        if (continueReading && !continueReading()) break;
      }
    }
    return offset;
  }
}
