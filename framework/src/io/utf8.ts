/** UTF-8 without the Web TextEncoder and TextDecoder globals, which QuickJS
 *  does not provide. A lone surrogate encodes as U+FFFD. */
export function utf8(text: string): Uint8Array {
  const values: number[] = [];
  for (const char of text) {
    let cp = char.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) values.push(cp);
    else if (cp < 0x800) values.push(0xc0 | cp >> 6, 0x80 | cp & 63);
    else if (cp < 0x10000) values.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
    else values.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
  }
  return Uint8Array.from(values);
}

/** Decodes UTF-8; each malformed or truncated sequence becomes U+FFFD. */
export function utf8Text(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i]!;
    const extra = lead < 0x80 ? 0 : lead >= 0xc2 && lead < 0xe0 ? 1 : lead >= 0xe0 && lead < 0xf0 ? 2 : lead >= 0xf0 && lead < 0xf5 ? 3 : -1;
    if (extra < 0 || i + extra >= bytes.length) { text += "�"; ++i; continue; }
    let cp = extra ? lead & (0x3f >> extra) : lead, valid = true;
    for (let k = 1; k <= extra; ++k) {
      const next = bytes[i + k]!;
      if ((next & 0xc0) !== 0x80) { valid = false; break; }
      cp = cp << 6 | next & 0x3f;
    }
    const min = [0, 0x80, 0x800, 0x10000][extra]!;
    if (!valid || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { text += "�"; ++i; continue; }
    text += String.fromCodePoint(cp);
    i += extra + 1;
  }
  return text;
}
