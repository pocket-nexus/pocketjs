/** Check the flat image consumed by the PSP kernel before shipping a PRX. */
export function verifyPspPrx(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (reason: string): never => { throw new Error(`Invalid PSP PRX: ${reason}`); };
  const range = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) fail("truncated ELF");
  };
  range(0, 52);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  if (u32(0) !== 0x464c457f || bytes[4] !== 1 || bytes[5] !== 1 ||
      u16(16) !== 0xffa0 || u16(18) !== 8) fail("expected a little-endian MIPS PRX");
  const phoff = u32(28), shoff = u32(32);
  const phsize = u16(42), phcount = u16(44), shsize = u16(46), shcount = u16(48);
  if (phsize !== 32 || phcount !== 1 || shsize !== 40 || shcount === 0) fail("expected one load segment and section headers");
  range(phoff, phsize);
  range(shoff, shsize * shcount);
  const start = u32(phoff + 4), address = u32(phoff + 8);
  const filesz = u32(phoff + 16), memsz = u32(phoff + 20);
  if (u32(phoff) !== 1 || address !== 0 || filesz > memsz) fail("invalid flat load segment");
  range(start, filesz);
  for (let i = 0; i < shcount; i++) {
    const section = shoff + i * shsize;
    if (!(u32(section + 8) & 2)) continue; // SHF_ALLOC
    const addr = u32(section + 12), offset = u32(section + 16), size = u32(section + 20);
    if (addr + size > memsz) fail(`section ${i} exceeds loaded memory`);
    if (u32(section + 4) === 8 || size === 0) continue; // SHT_NOBITS
    range(offset, size);
    if (offset !== start + addr || addr + size > filesz) {
      fail(`section ${i} file offset does not match its load address; rebuild with the PocketJS PSP target`);
    }
  }
}
