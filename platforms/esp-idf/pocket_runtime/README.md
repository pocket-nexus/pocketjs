# pocket_runtime

**One `libpocket_idf_runtime.a` supplies the canonical C runtime and PPA factory.**
The component provides the six `pocket_host_*` hooks and a memory-backed
`PackageSource`. It does not create a task or include QuickJS.

Include `pocket_runtime.h` and register all guest, input, display, package and
renderer tables before `pocket_runtime_boot`. Destroy the runtime before its
registered contexts. The runtime reads the bytes of a `pocket_memory_package`
in place, so they stay unchanged until runtime destruction. A program that
verified the bundle itself (`pocket_idf_package_open`) sets `flags` to
`POCKET_MEMORY_PACKAGE_VERIFIED`, and the runtime admits it without a second
hash pass.

`pocketjs_embed_bundle` and `pocketjs_compile_app` generate the bundle bytes,
the admitted host contract (`pocketjs_bundle_host_contract_t`) and the runtime
profile. The runtime profile has its own hash; the bundle's host-input hash is
preserved.
