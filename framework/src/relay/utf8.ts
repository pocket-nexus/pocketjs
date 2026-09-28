/** UTF-8 wire size without browser globals or a temporary byte buffer.
 * Like the frame encoder, lone UTF-16 surrogates become U+FFFD. */
export function utf8Length(value: string): number {
  let length = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return length;
}
