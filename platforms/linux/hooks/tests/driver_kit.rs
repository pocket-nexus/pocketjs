//! pocket-driver-kit package source conformance for the file-backed source.
use pocket_driver_kit::{check_package_source, check_package_transfer};
use pocket_linux_hooks::FileSource;

#[test]
fn file_ranges_match_trusted_bytes_through_short_reads_and_eof() {
    let path = std::env::temp_dir().join(format!("pocket-linux-source-{}", std::process::id()));
    let bytes: Vec<u8> = (0..4099u32).map(|i| (i * 31 % 251) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    let mut source = FileSource::open(&path).unwrap();
    check_package_source(&mut source, &bytes).unwrap();
    check_package_transfer(&mut source, &bytes).unwrap();
    let mut empty = FileSource::open(&path).unwrap();
    assert!(check_package_source(&mut empty, &bytes[..10]).is_err());
    drop((source, empty));
    std::fs::remove_file(path).unwrap();
}
