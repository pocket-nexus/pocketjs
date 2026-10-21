# Package admission fuzz target

**The target calls the runtime's Rust package loader.** It checks all variant
readers with and without footer verification, then compares memory and
seven-byte range sources under an 8 KiB package limit.

Run from `engine/package` with cargo-fuzz and a nightly Rust compiler. Keep
the writable corpus, crashes and instrumented build in ignored output:

```sh
cargo install cargo-fuzz --locked
mkdir -p ../../.pocket-build/validation/package-fuzz/run-1/corpus
cp ../../tests/fixtures/packages/corpus/* ../../.pocket-build/validation/package-fuzz/run-1/corpus/
CARGO_TARGET_DIR=../../.pocket-build/validation/package-fuzz/target cargo +nightly fuzz run admission ../../.pocket-build/validation/package-fuzz/run-1/corpus -- -runs=10000 -max_len=8192 -artifact_prefix=../../.pocket-build/validation/package-fuzz/run-1/
```

cargo-fuzz instruments the Rust parser with AddressSanitizer and coverage.
Promote a reproducer into the maintained corpus when a regression test consumes
it; per-run discoveries remain outside Git.
