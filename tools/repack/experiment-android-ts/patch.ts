// Experiment: patch aapt2's binary AndroidManifest.xml and resources.arsc in TypeScript.
const RES_STRING_POOL = 0x0001, RES_XML_START_ELEMENT = 0x0102, RES_TABLE_PACKAGE = 0x0200;

interface Pool { strings: string[]; utf8: boolean; flags: number; size: number }

function readPool(b: Uint8Array, at: number): Pool {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint16(at, true) !== RES_STRING_POOL) throw new Error("not a string pool");
  const header = v.getUint16(at + 2, true), size = v.getUint32(at + 4, true);
  const count = v.getUint32(at + 8, true), styles = v.getUint32(at + 12, true), flags = v.getUint32(at + 16, true);
  const stringsStart = v.getUint32(at + 20, true);
  if (styles) throw new Error("styled pools are outside this experiment");
  const utf8 = (flags & 0x100) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    let o = at + stringsStart + v.getUint32(at + header + i * 4, true);
    if (utf8) {
      if (b[o++] & 0x80) o++;
      let len = b[o++];
      if (len & 0x80) len = ((len & 0x7f) << 8) | b[o++];
      strings.push(new TextDecoder().decode(b.subarray(o, o + len)));
    } else {
      let len = v.getUint16(o, true); o += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | v.getUint16(o, true); o += 2; }
      strings.push(new TextDecoder("utf-16le").decode(b.subarray(o, o + len * 2)));
    }
  }
  return { strings, utf8, flags, size };
}

function encodePool(pool: Pool): Uint8Array {
  const data: number[] = [];
  const offsets: number[] = [];
  for (const s of pool.strings) {
    offsets.push(data.length);
    if (pool.utf8) {
      const bytes = new TextEncoder().encode(s);
      const u16 = s.length;
      if (u16 > 0x7f) data.push(0x80 | (u16 >> 8), u16 & 0xff); else data.push(u16);
      if (bytes.length > 0x7f) data.push(0x80 | (bytes.length >> 8), bytes.length & 0xff); else data.push(bytes.length);
      data.push(...bytes, 0);
    } else {
      if (s.length > 0x7fff) throw new Error("long string");
      data.push(s.length & 0xff, s.length >> 8);
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); data.push(c & 0xff, c >> 8); }
      data.push(0, 0);
    }
  }
  while (data.length % 4) data.push(0);
  const header = 28, stringsStart = header + offsets.length * 4;
  const out = new Uint8Array(stringsStart + data.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, RES_STRING_POOL, true);
  v.setUint16(2, header, true);
  v.setUint32(4, out.length, true);
  v.setUint32(8, pool.strings.length, true);
  v.setUint32(12, 0, true);
  v.setUint32(16, pool.flags, true);
  v.setUint32(20, stringsStart, true);
  v.setUint32(24, 0, true);
  offsets.forEach((o, i) => v.setUint32(header + i * 4, o, true));
  out.set(data, stringsStart);
  return out;
}

function replacePool(file: Uint8Array, at: number, map: (s: string) => string): Uint8Array {
  const pool = readPool(file, at);
  const fresh = encodePool({ ...pool, strings: pool.strings.map(map) });
  const out = new Uint8Array(file.length - pool.size + fresh.length);
  out.set(file.subarray(0, at));
  out.set(fresh, at);
  out.set(file.subarray(at + pool.size), at + fresh.length);
  new DataView(out.buffer).setUint32(4, out.length, true); // the file chunk's size
  return out;
}

/** The binary manifest with its package name, versionCode and versionName replaced. */
export function patchManifest(axml: Uint8Array, from: { packageName: string; versionName: string }, to: { packageName: string; versionCode: number; versionName: string }): Uint8Array {
  const out = replacePool(axml, 8, (s) => (s === from.packageName ? to.packageName : s === from.versionName ? to.versionName : s));
  const pool = readPool(out, 8);
  const v = new DataView(out.buffer);
  const versionCode = pool.strings.indexOf("versionCode");
  let at = 8 + pool.size;
  let patched = false;
  while (at < out.length) {
    const type = v.getUint16(at, true), size = v.getUint32(at + 4, true);
    if (type === RES_XML_START_ELEMENT) {
      const name = v.getUint32(at + 20, true);
      if (pool.strings[name] === "manifest") {
        const attrStart = v.getUint16(at + 24, true), attrSize = v.getUint16(at + 26, true), count = v.getUint16(at + 28, true);
        for (let i = 0; i < count; i++) {
          const a = at + 16 + attrStart + i * attrSize;
          if (v.getUint32(a + 4, true) === versionCode) { v.setUint32(a + 16, to.versionCode, true); patched = true; }
        }
      }
    }
    at += size;
  }
  if (!patched) throw new Error("no versionCode attribute");
  return out;
}

/** The resource table with its package name and label replaced. */
export function patchResources(arsc: Uint8Array, from: { label: string }, to: { packageName: string; label: string }): Uint8Array {
  const out = replacePool(arsc, 12, (s) => (s === from.label ? to.label : s));
  const v = new DataView(out.buffer);
  const pkg = 12 + readPool(out, 12).size;
  if (v.getUint16(pkg, true) !== RES_TABLE_PACKAGE) throw new Error("no package chunk after the global pool");
  if (to.packageName.length > 127) throw new Error("package name too long");
  for (let i = 0; i < 128; i++) v.setUint16(pkg + 12 + i * 2, i < to.packageName.length ? to.packageName.charCodeAt(i) : 0, true);
  return out;
}
