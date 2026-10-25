// Shared JavaScript guest bindings; operation data comes from the UI contract.
import { POCKET_BINDING_GENERATION, UI_DESCRIPTORS } from "./ui-descriptors.js";
export { POCKET_BINDING_GENERATION };

// QuickJS exposes isolated UTF-16 surrogates as invalid three-byte WTF-8.
// Canonical bindings replace each invalid byte, matching from_utf8_lossy.
export function encodeUiString(value) {
  if (typeof value === "symbol") throw new TypeError("UI string cannot be a symbol");
  const text = String(value), bytes = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00; i++; }
    }
    if (code >= 0xd800 && code <= 0xdfff) { bytes.push(239, 191, 189, 239, 191, 189, 239, 191, 189); }
    else if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(bytes);
}

export function decodeUiString(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    let code = first, count = 0, minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) { code &= 31; count = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { code &= 15; count = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { code &= 7; count = 3; minimum = 0x10000; }
    else if (first >= 0x80) throw new TypeError("invalid UI UTF-8 result");
    if (i + count > bytes.length) throw new TypeError("truncated UI UTF-8 result");
    while (count--) {
      const byte = bytes[i++];
      if ((byte & 0xc0) !== 0x80) throw new TypeError("invalid UI UTF-8 result");
      code = (code << 6) | (byte & 63);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new TypeError("invalid UI UTF-8 result");
    text += String.fromCodePoint(code);
  }
  return text;
}

function bytesOf(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value);
  throw new TypeError("UI argument requires an ArrayBuffer or typed array");
}
function resultValue(expected, result) {
  if (expected === "none") return undefined;
  if ((expected === "optionalString" || expected === "optionalBytes") && result.kind === "none") return undefined;
  if (expected === "rect" && result.kind === "none") return null;
  if (expected === "boolean" && result.kind === "integer") return result.value !== 0;
  if ((expected === "integer" || expected === "real") && result.kind === expected) return result.value;
  if (result.kind !== "bytes") throw new TypeError("invalid UI result kind");
  const bytes = bytesOf(result.value);
  if (expected === "rect") {
    if (bytes.length !== 16) throw new TypeError("invalid UI rect result");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { x: view.getFloat32(0, true), y: view.getFloat32(4, true), w: view.getFloat32(8, true), h: view.getFloat32(12, true) };
  }
  if (expected === "string" || expected === "optionalString") return decodeUiString(bytes);
  if (expected === "bytes" || expected === "optionalBytes") return bytes.slice().buffer;
  if (expected === "u32Array") {
    if (bytes.length % 4) throw new TypeError("invalid UI array result");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), values = [];
    for (let i = 0; i < bytes.length; i += 4) values.push(view.getUint32(i, true));
    return values;
  }
  throw new TypeError("invalid UI result kind");
}

/** Transport owns synchronous dispatch and native memory. Conversion completes
 * before byte views are borrowed; returned byte results are copied before the
 * next native call. Dispose invalidates every function retained by the guest.
 * Returns { ui, dispose }; mounting sets global.ui and an owned global.__pak.
 */
export function mountUi(transport, environment, global = globalThis) {
  const hostAbi = environment?.hostAbi;
  if (hostAbi !== POCKET_BINDING_GENERATION) throw new TypeError(`Unsupported UI binding generation; expected ${POCKET_BINDING_GENERATION}`);
  if (global.ui !== undefined) throw new TypeError("ui is already mounted");
  if (environment.pak?.byteLength && global.__pak !== undefined) throw new TypeError("__pak is already mounted");
  let active = true;
  const ui = {};
  for (const descriptor of UI_DESCRIPTORS) {
    if (!transport.supportsOp(descriptor.id)) continue;
    const invoke = (...values) => {
      if (!active) throw new TypeError("UI guest has shut down");
      const args = new Array(descriptor.args.length);
      for (let pass = 0; pass < 2; pass++) {
        descriptor.args.forEach((argument, index) => {
          const { kind, optional } = argument;
          if (kind === "bytes" || (kind === "string") !== (pass === 1)) return;
          if (index >= values.length && !optional) throw new TypeError("missing UI argument");
          const value = values[index];
          if (kind === "string") args[index] = { kind: "bytes", value: encodeUiString(value) };
          else if (kind === "real") args[index] = { kind: "real", value: optional && value === undefined ? 0 : +value };
          else if (kind === "nonnegative") { const n = +value; args[index] = { kind: "integer", value: Number.isNaN(n) ? 0 : Math.trunc(Math.max(0, Math.min(0xffffffff, n))) }; }
          else args[index] = { kind: "integer", value: kind === "u32" ? (+value >>> 0) : (+value | 0) };
        });
      }
      descriptor.args.forEach((argument, index) => {
        if (argument.kind === "bytes") args[index] = { kind: "bytes", value: bytesOf(values[index]) };
      });
      // User coercion may call dispose. Never dispatch after that point.
      if (!active) throw new TypeError("UI guest has shut down");
      return resultValue(descriptor.result, transport.dispatch(descriptor.id, args));
    };
    Object.defineProperty(invoke, "name", { value: descriptor.name });
    Object.defineProperty(invoke, "length", { value: descriptor.args.length });
    ui[descriptor.name] = invoke;
  }
  Object.assign(ui, { __host: environment.host, __hostAbi: hostAbi, __tickHz: environment.tickHz, __viewport: { ...environment.viewport } });
  if (environment.auxiliary) ui.__auxiliarySurface = { ...environment.auxiliary };
  if (environment.textures !== undefined || environment.sprites !== undefined) {
    ui.__textures = Object.create(null); ui.__sprites = Object.create(null); ui.__surfaces = {};
    for (const texture of environment.textures ?? []) ui.__textures[texture.name] = texture.handle;
    for (const sprite of environment.sprites ?? []) ui.__sprites[sprite.name] = { handle: sprite.handle, frames: sprite.frames, cols: sprite.columns, step: sprite.step };
  }
  const pak = environment.pak?.byteLength ? bytesOf(environment.pak).slice().buffer : undefined;
  if (pak) global.__pak = pak;
  global.ui = ui;
  return { ui, dispose() { active = false; if (global.ui === ui) delete global.ui; if (pak && global.__pak === pak) delete global.__pak; } };
}
