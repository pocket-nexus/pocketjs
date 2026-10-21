# pocket_runtime

**One `libpocket_idf_runtime.a` supplies the canonical C runtime and PPA factory.**
The component provides the six `pocket_host_*` hooks and a memory-backed
`PackageSource`. It does not create a task or include QuickJS.

Include `pocket_runtime.h` and register all guest, input, display, package and
renderer tables before `pocket_runtime_boot`. Destroy the runtime before its
registered contexts. The package bytes passed to `pocket_memory_package` stay
unchanged until runtime destruction.

`pocketjs_embed_package` and `pocketjs_compile_app` generate the package bytes,
legacy host contract and canonical runtime profile. The runtime profile has its
own hash; the existing package host-input hash is preserved.
