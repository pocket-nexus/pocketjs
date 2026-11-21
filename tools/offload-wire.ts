import { OFFLOAD } from "../contracts/spec/offload.ts";

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
  push(chunk: Uint8Array, deliver: (record: string) => void) {
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
        this.have = 0; this.want = 4; deliver(record);
      }
    }
  }
}
