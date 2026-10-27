import { WORKER_LIMITS } from "../../../contracts/spec/worker.ts";

export interface FieldEncoding { readonly encoding: string; readonly size: number }
function field(encoding: string, size: number): FieldEncoding { return Object.freeze({ encoding, size }); }
export const u8 = field("u8", 1), i8 = field("i8", 1);
export const u16le = field("u16le", 2), u16be = field("u16be", 2);
export const i16le = field("i16le", 2), i16be = field("i16be", 2);
/** Unqualified multibyte encodings are little endian. */
export const u24 = field("u24", 3), i24 = field("i24", 3);
export const u32 = field("u32", 4), f32 = field("f32", 4);
export function bytes(size: number): FieldEncoding {
  integer(size, 1, WORKER_LIMITS.payloadBytes, "byte count");
  return field("bytes", size);
}
export interface ReadStep<L extends readonly FieldEncoding[] = readonly FieldEncoding[]> {
  readonly op: "read"; readonly register: number; readonly layout: L;
}
export interface WriteStep { readonly op: "write"; readonly register: number; readonly data: Uint8Array }
export type I2CStep = ReadStep | WriteStep;
export function read<const L extends readonly FieldEncoding[]>(register: number, layout: L): ReadStep<L> {
  integer(register, 0, 255, "register");
  if (!layout.length || layout.some(item => !Number.isInteger(item.size) || item.size < 1)) throw new RangeError("Invalid I2C read layout");
  return { op: "read", register, layout };
}
export function write(register: number, ...values: (number | Uint8Array | readonly number[])[]): WriteStep {
  integer(register, 0, 255, "register");
  const flat: number[] = [];
  for (const value of values) {
    if (typeof value === "number") flat.push(value);
    else flat.push(...value);
  }
  if (flat.length > WORKER_LIMITS.payloadBytes) throw new RangeError("I2C write exceeds resource payload limit");
  flat.forEach(value => integer(value, 0, 255, "write byte"));
  return { op: "write", register, data: Uint8Array.from(flat) };
}
export function integer(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in ${min}..${max}`);
}
export function encodeI2CScript(script: readonly I2CStep[], timeoutMillis = 100): { payload: Uint8Array; resultBytes: number } {
  integer(script.length, 1, 255, "I2C step count");
  integer(timeoutMillis, 1, 65535, "I2C timeoutMillis");
  let total = 4, resultBytes = 0;
  for (const step of script) {
    integer(step.register, 0, 255, "register");
    const length = step.op === "read" ? step.layout.reduce((sum, item) => sum + item.size, 0) : step.data.length;
    integer(length, step.op === "read" ? 1 : 0, WORKER_LIMITS.payloadBytes, "I2C transfer length");
    total += 4 + (step.op === "write" ? length : 0);
    if (step.op === "read") resultBytes += length;
  }
  if (total > WORKER_LIMITS.payloadBytes || resultBytes > WORKER_LIMITS.payloadBytes) throw new RangeError("I2C script exceeds resource payload limit");
  const payload = new Uint8Array(total), view = new DataView(payload.buffer);
  payload[0] = 1; payload[1] = script.length; view.setUint16(2, timeoutMillis, true);
  let offset = 4;
  for (const step of script) {
    const length = step.op === "read" ? step.layout.reduce((sum, item) => sum + item.size, 0) : step.data.length;
    payload[offset] = step.op === "read" ? 1 : 2; payload[offset + 1] = step.register;
    view.setUint16(offset + 2, length, true); offset += 4;
    if (step.op === "write") { payload.set(step.data, offset); offset += length; }
  }
  return { payload, resultBytes };
}
