# Cross-version candidate C consumer

`bun tools/test-runtime-cabi-compat.ts` builds the immutable stage-4 candidate
`9cf1347295b9f9bfeffa4496f67a65c5b2b449db` from a Git archive outside the checkout.
It exports the current SDK and compiles this consumer in both directions:

- Old generated headers with the current no_std runtime archive.
- Current exported headers with the old no_std runtime archive.

Both executables use the entry points present in the old candidate. They check
prefix bounds, extended op arguments, guest op reentry, range-only short reads,
software raster output, terminal display errors, retry, and resource cleanup.
A control executable calls the new `pocket_draw_list_visit` entry point using the
current headers and archive. The same source must fail to link against the old
archive with that symbol unresolved. This is an additive API boundary, not a
claim that new entry points exist in old archives.

**The old archive requires one compatibility shim:** stage 4 omitted the
`rust_eh_personality` support symbol. The runner defines
`POCKET_OLD_CANDIDATE_PERSONALITY` only for historical-archive links. The current
archive uses the six documented host hooks without this shim. The old snapshot
is not patched.

The runner checks both exit status and signal termination. It aborts a control
process to prove that SIGABRT cannot pass even if Bun reports exit code zero.
Headers, archive hashes, compiler identities, commands, raw logs, and a result
receipt remain in ignored `.pocket-build/validation/runtime-cabi-compat/`.

**The ABI remains a candidate.** These cases compare two development revisions;
they do not assert a released compatibility promise or freeze the ABI.
