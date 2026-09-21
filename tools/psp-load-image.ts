// prxgen merges PT_LOAD records but does not repack their file alignment gaps.
// Validate the loader image, since ELF section tables alone can look correct
// while the PSP loads module info and import stubs at the wrong addresses.
export function validatePspLoadImage(bytes: Uint8Array): void {
  const fail = (reason: string): never => { throw new Error(`Invalid PSP load image: ${reason}`); };
  if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c ||
      bytes[3] !== 0x46 || bytes[4] !== 1 || bytes[5] !== 1) fail("expected ELF32 little endian");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => data.getUint16(offset, true);
  const u32 = (offset: number) => data.getUint32(offset, true);
  if (u16(18) !== 8) fail("expected MIPS machine");
  const type = u16(16);
  if (type !== 2 && type !== 0xffa0) fail("expected executable ELF or PSP PRX");
  const phoff = u32(28), shoff = u32(32);
  const phsize = u16(42), phcount = u16(44), shsize = u16(46), shcount = u16(48), namesIndex = u16(50);
  if (phsize < 32 || shsize < 40 || namesIndex >= shcount ||
      phoff + phsize * phcount > bytes.length || shoff + shsize * shcount > bytes.length) {
    fail("invalid header tables");
  }
  const loads = Array.from({ length: phcount }, (_, index) => phoff + index * phsize)
    .filter((offset) => u32(offset) === 1);
  if (loads.length !== 1) fail(`expected one PT_LOAD, found ${loads.length}`);
  const load = loads[0], base = u32(load + 4), address = u32(load + 8);
  const fileSize = u32(load + 16), memorySize = u32(load + 20);
  if (address !== 0 || fileSize > memorySize || base + fileSize > bytes.length) fail("invalid PT_LOAD range");
  const names = shoff + namesIndex * shsize, namesOffset = u32(names + 16), namesSize = u32(names + 20);
  if (namesOffset + namesSize > bytes.length) fail("invalid section names");
  let moduleInfo = false;
  for (let index = 0; index < shcount; index++) {
    const section = shoff + index * shsize;
    if ((u32(section + 8) & 2) === 0) continue; // SHF_ALLOC
    const relative = u32(section + 12), offset = u32(section + 16), size = u32(section + 20);
    if (relative + size > memorySize) fail(`section ${index} exceeds PT_LOAD memory`);
    if (u32(section + 4) === 8) continue; // SHT_NOBITS occupies memory, not file data.
    if (offset !== base + relative || relative + size > fileSize) {
      fail(`section ${index} has a file/address alignment gap`);
    }
    const nameOffset = u32(section);
    if (nameOffset >= namesSize) fail("invalid allocated section name");
    const remaining = bytes.subarray(namesOffset + nameOffset, namesOffset + namesSize);
    const nul = remaining.indexOf(0);
    if (nul < 0) fail("unterminated section name");
    if (new TextDecoder().decode(remaining.subarray(0, nul)) === ".rodata.sceModuleInfo") {
      moduleInfo = true;
      if (type === 0xffa0 && (u32(load + 12) & 0x7fffffff) !== offset) fail("module info pointer disagrees with load image");
    }
  }
  if (!moduleInfo) fail("missing allocated module info");
}
