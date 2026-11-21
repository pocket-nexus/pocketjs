fn main() {
    use pocket_driver_kit::check_package_source;
    use pocket_package::source::MemorySource;

    let expected = b"driver source bytes";
    let mut source = MemorySource(expected.as_slice());
    check_package_source(&mut source, expected).unwrap();
    // Replace MemorySource with the driver's real source in its conformance suite.
}
