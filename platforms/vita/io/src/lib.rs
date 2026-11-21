//! File-backed package ranges. Runtime owns decoding and admission.
use pocket_drivers::{PackageSource, SourceError};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
pub struct FileSource {
    file: File,
    length: usize,
}
impl FileSource {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, SourceError> {
        let file = File::open(path).map_err(|_| SourceError::Failed)?;
        let length = usize::try_from(file.metadata().map_err(|_| SourceError::Failed)?.len())
            .map_err(|_| SourceError::OutOfBounds)?;
        Ok(Self { file, length })
    }
}
impl PackageSource for FileSource {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.length)
    }
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
        if offset > self.length {
            return Err(SourceError::OutOfBounds);
        }
        let count = buffer.len().min(self.length - offset).min(1 << 20);
        if count == 0 {
            return Ok(0);
        }
        self.file
            .seek(SeekFrom::Start(offset as u64))
            .map_err(|_| SourceError::Failed)?;
        self.file
            .read(&mut buffer[..count])
            .map_err(|_| SourceError::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_are_bounded_seekable_and_do_not_cache_a_second_package() {
        let path = std::env::temp_dir().join(format!("pocket-vita-source-{}", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        let mut source = FileSource::open(&path).unwrap();
        let mut out = [0xaa; 8];
        assert_eq!(source.length(), Ok(10));
        assert_eq!(source.range(7, &mut out), Ok(3));
        assert_eq!(&out[..3], b"789");
        assert_eq!(&out[3..], &[0xaa; 5]);
        assert_eq!(source.range(1, &mut out[..2]), Ok(2));
        assert_eq!(&out[..2], b"12");
        assert_eq!(source.range(10, &mut out), Ok(0));
        assert_eq!(source.range(11, &mut out), Err(SourceError::OutOfBounds));
        drop(source);
        std::fs::remove_file(path).unwrap();
    }
}
