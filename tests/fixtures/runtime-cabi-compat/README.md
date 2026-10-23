# Cross-version candidate C consumer

`bun tools/test-runtime-cabi-compat.ts` runs before a release; CI does not run
it. It builds revision `4c82eee5ec9afc46eb7fce57191e0ace1ab6b855` from a Git
archive outside the checkout. That revision is the first whose
`pocket_runtime_config` points at `pocket_profile_facts`; its headers and archive
are the oldest a current configuration links against. **The revision must be
present in the clone:** after its branch is deleted, run
`git fetch origin refs/pull/603/head`.

The tool exports the current SDK and compiles this consumer in both directions:

- Old generated headers with the current no_std runtime archive.
- Current exported headers with the old no_std runtime archive.

The consumer fills `pocket_profile_facts` and `pocket_profile_display` by member
name from the fixture header's macros, so one source fills the record each header
revision declares; `struct_size` reports that revision's prefix. The current
archive receives a package from the current encoder. The old archive receives
bytes from the old revision's encoder, tagged with that revision's binding
generation. **Package version compatibility is separate from C ABI
compatibility.**

Both executables use the entry points present in the old revision. They check
prefix bounds, extended op arguments, guest op reentry, range-only short reads,
software raster output, terminal display errors, retry, and resource cleanup.

The runner checks both exit status and signal termination. It aborts a control
process to prove that SIGABRT cannot pass even if Bun reports exit code zero.
Headers, archive hashes, compiler identities, commands, raw logs, and a result
receipt remain in ignored `.pocket-build/validation/runtime-cabi-compat/`.

**The ABI remains a candidate.** These cases compare two development revisions;
they do not assert a released compatibility promise or freeze the ABI.
