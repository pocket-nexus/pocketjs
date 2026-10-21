# Independent Rust consumer

`bun tools/test-out-of-tree-rust.ts` copies this fixture and the package corpus
outside the checkout. It creates a manifest with **git dependencies at one
fixed revision**, checks Cargo metadata, and runs the consumer tests. The runner
resolves the repository's current `HEAD` to a full commit hash at the start of
each run. `--revision <full-commit>` replays an older revision. The generated
manifest and receipt record the immutable hash used for that run. Version 1
package revisions use the maintained v1 consumer and the corpus from that
revision; current revisions use the v2 admission API and profile hash. It uses
no path dependencies, Cargo patches, internal engine modules, or direct core
dependency. Logs, resolved metadata, the generated lockfile, and the result
receipt go under `.pocket-build/validation/out-of-tree-rust/`.

The tests exercise public runtime registration, software drawing, input wire
encoding, short-read package sources, delayed device rendering, two displays
sharing texture storage, reversed completion, terminal errors, and destruction.
The mock renderer uses `TextureCache` and copies uploaded pixel bytes into its
own storage; its release callback rejects freeing a referenced texture.

The coordinator completes all submissions before returning from `present`.
The test that changes a resource revision while an older version remains in
flight therefore calls the public renderer/display traits directly. It does
not claim the runtime supports submissions that span multiple frames.

These tests cover the Rust and development-machine portions of migration
stage 5. **They do not freeze the ABI** or replace the independent ESP-IDF and
PPA device checks.
