// Byte codecs shared by the module SDKs (db, fs, net). Internal — not a
// framework subpath. QuickJS has no btoa/Buffer/TextEncoder/TextDecoder, so
// the codecs are spelled out.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

const B64_INV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INV[B64[i]] = i;

export function base64ToBytes(s: string): Uint8Array {
  while (s.endsWith("=")) s = s.slice(0, -1);
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (B64_INV[s[i]] << 18) |
      ((B64_INV[s[i + 1]] ?? 0) << 12) |
      ((B64_INV[s[i + 2]] ?? 0) << 6) |
      (B64_INV[s[i + 3]] ?? 0);
    out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/** UTF-8 encode. Lone surrogates become U+FFFD, so the output is always
 *  well-formed UTF-8 (the byte shape every module boundary requires). */
export function stringToUtf8(s: string): Uint8Array {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out[o++] = code;
    else if (code < 0x800) {
      out[o++] = 0xc0 | (code >> 6);
      out[o++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[o++] = 0xe0 | (code >> 12);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    } else {
      out[o++] = 0xf0 | (code >> 18);
      out[o++] = 0x80 | ((code >> 12) & 0x3f);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/** Bytes per String.fromCharCode.apply: each one is an argument. */
const DECODE_CHUNK = 8192;
const HIGH_BYTE = /[\x80-\xff]/;

/** UTF-8 decode, strict: malformed sequences throw (a file that fails
 *  .text() is a bytes file — read it with .bytes()).
 *
 *  Built-ins do the per-byte work. In QuickJS on an Old 3DS a JS loop costs
 *  about 8 µs a byte, and appending one character at a time copies the whole
 *  string every time: 2.7 s for a 48 KB response. Here each chunk becomes a
 *  Latin-1 string (String.fromCharCode), and a chunk with high bytes goes
 *  through escape(), which spells them %XX, and decodeURIComponent, which
 *  decodes them as UTF-8 and throws on malformed, overlong, surrogate and
 *  out-of-range sequences: 60-130 ms for the same response. A chunk ends
 *  before a sequence's continuation bytes. */
export function utf8ToString(bytes: Uint8Array): string {
  let out = "";
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + DECODE_CHUNK, bytes.length);
    for (let back = 0; back < 3 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80; back++) end--;
    const latin1 = String.fromCharCode.apply(null, bytes.subarray(start, end) as unknown as number[]);
    if (!HIGH_BYTE.test(latin1)) {
      out += latin1;
    } else {
      try {
        out += decodeURIComponent(escape(latin1));
      } catch {
        throw new Error("invalid UTF-8");
      }
    }
    start = end;
  }
  return out;
}
