/** A view of host bytes that expires with the turn or frame that produced it.
 *  Only copy() produces bytes that survive. */
export class ByteView {
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array, private readonly valid: () => void) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number { this.valid(); return this.bytes.length; }
  u8(offset: number): number { this.valid(); return this.view.getUint8(offset); }
  i8(offset: number): number { this.valid(); return this.view.getInt8(offset); }
  u16le(offset: number): number { this.valid(); return this.view.getUint16(offset, true); }
  u16be(offset: number): number { this.valid(); return this.view.getUint16(offset, false); }
  i16le(offset: number): number { this.valid(); return this.view.getInt16(offset, true); }
  i16be(offset: number): number { this.valid(); return this.view.getInt16(offset, false); }
  u24(offset: number): number { this.valid(); return this.view.getUint16(offset, true) + this.view.getUint8(offset + 2) * 65536; }
  i24(offset: number): number { const value = this.u24(offset); return value >= 0x800000 ? value - 0x1000000 : value; }
  u32(offset: number): number { this.valid(); return this.view.getUint32(offset, true); }
  f32(offset: number): number { this.valid(); return this.view.getFloat32(offset, true); }
  copy(): Uint8Array { this.valid(); return this.bytes.slice(); }
}
