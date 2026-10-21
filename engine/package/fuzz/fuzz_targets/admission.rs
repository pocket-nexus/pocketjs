#![no_main]
use libfuzzer_sys::fuzz_target;
use pocket_drivers::{PackageSource, SourceError};
use pocket_package::{
    package::{select_guest, Package},
    source::{LoadedPackage, MemorySource},
};

struct Chunks<'a>(&'a [u8]);
impl PackageSource for Chunks<'_> {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.0.len())
    }
    fn range(&mut self, offset: usize, out: &mut [u8]) -> Result<usize, SourceError> {
        let remaining = self.0.get(offset..).ok_or(SourceError::OutOfBounds)?;
        let length = remaining.len().min(out.len()).min(7);
        out[..length].copy_from_slice(&remaining[..length]);
        Ok(length)
    }
}
fuzz_target!(|data: &[u8]| {
    for skip_hash in [false, true] {
        if let Ok(package) = Package::parse(data, skip_hash) {
            let _ = package.manifest();
            for i in 0..package.variant_count() {
                if let Ok(variant) = package.variant(i) {
                    let _ = variant.identity();
                    let _ = select_guest(
                        data,
                        variant.target,
                        variant.host_abi,
                        &[0x11; 32],
                        skip_hash,
                    );
                }
            }
        }
    }
    let memory = LoadedPackage::load(&mut MemorySource(data), "psp", 1, &[0x11; 32], 8192);
    let range = LoadedPackage::load(&mut Chunks(data), "psp", 1, &[0x11; 32], 8192);
    assert_eq!(memory.is_ok(), range.is_ok());
    if let (Ok(memory), Ok(range)) = (memory, range) {
        assert_eq!(memory.bytes(), range.bytes());
        assert_eq!(memory.javascript(), range.javascript());
        assert_eq!(memory.pak(), range.pak());
    }
});
