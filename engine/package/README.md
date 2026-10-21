# pocket-package

Package readers enforce the container format, footer and variant hashes,
selected target, binding generation and the program's expected profile hash.
The expected profile hash comes from the program's build inputs.

`LoadedPackage::load` retains stable bytes through guest shutdown. **The source
storage mode does not bypass admission or the package byte limit.**

- `MemorySource<B>` exposes an ordinary borrowed slice. `all()` expires at the
  next mutable source call, so loading copies it. Range-only sources also load
  into one owned allocation.
- `OwnedMemorySource::new(bytes)` transfers its `Box<[u8]>` through the optional
  Rust `PackageSource::take_bytes` method. The returned allocation belongs to
  `LoadedPackage`; the source retains no mutable alias. Once transferred, reads
  and repeated loads fail with `SourceError::Failed`, including after failed
  admission. A byte-limit failure precedes transfer and leaves the source intact.
- `StaticMemorySource(bytes)` accepts only `&'static [u8]`. Loading retains this
  immutable reference and requires no package-sized allocation. Dropping the
  source cannot invalidate the package. Repeated loads use the same static bytes.

Custom Rust sources may return `PackageBytes::Owned` or `PackageBytes::Static`
from `take_bytes`. The returned length must equal the preceding `length()`;
a mismatch fails admission. The default returns `Unsupported` and leaves the
source available for borrowed or range reads. **The C source ABI is unchanged**:
its pointers carry no transferable ownership or static lifetime, so its bytes
still copy into runtime-owned storage.

Raw JS/pak embedders can use `embedded::encode`, which writes one container and
its JavaScript terminator without a script-sized temporary buffer. Product
builders should link their compiled `.pocket` into a `StaticMemorySource`
instead of reconstructing it during startup.

Package retention does not make a JavaScript ArrayBuffer immutable. Guest
engines without a verified immutable-buffer API must still copy bytes exposed
to JavaScript. Removing that copy would let guest writes mutate Rust-borrowed
package data; it is separate from the source ownership optimization.
