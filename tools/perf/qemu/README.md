# PocketJS QEMU guest counters

This directory contains the deterministic QEMU side of the local performance
runner. **It targets QEMU 11.0.3 linux-user and plugin API 6.** It does not
estimate guest cycles, cache behavior, device frame rate, GPU cost, or power.

## Marker ABI

ARM32 and AArch64 guests issue syscall `4096` with these arguments:

| syscall argument | value |
| --- | --- |
| `a1` | magic `0x504a424d` |
| `a2` | version in bits 15..8 and opcode in bits 7..0 |
| `a3` | unsigned 32-bit phase ID |
| `a4` | unsigned 32-bit iteration |
| `a5` | cookie `0xc001c0de` |

Protocol version is `1`; opcode `1` is BEGIN and opcode `2` is END. Include
`guest_marker.h` and call `pocketjs_perf_begin(phase, iteration)` and
`pocketjs_perf_end(phase, iteration)`. Both calls return zero when the plugin
filters the marker. **A BEGIN/END pair must match phase, iteration, and vCPU.**
Nested markers, missing markers, a mismatched END, and more than one linux-user
vCPU make the result invalid. A guest `getrandom(2)` syscall while a marker is
active also makes the result invalid because entropy can change the dynamic
instruction path.

The BEGIN syscall instruction is outside the snapshot. The END syscall
instruction is inside it because QEMU invokes the syscall filter after
dispatching that guest instruction. Compiler-generated argument setup before
END is therefore also measured. The assembly fixtures pin this boundary with
exact expected counts.

## Output

The plugin writes prefixed NDJSON through QEMU's plugin log. Consumers only
parse lines beginning with `POCKETJS_PERF_QEMU `. A successful run contains one
or more `measurement` records followed by one `complete` sentinel. An invalid
run ends with one `error` sentinel. Every sentinel contains the schema and
version, so absence or truncation cannot be accepted as a result.

**Every direct QEMU invocation must include `-d plugin`.** Without that flag,
`qemu_plugin_outs()` records are disabled and a consumer must reject the run as
missing its terminal sentinel.

Each measurement reports one vCPU snapshot with these metrics:

- `guest_insn_dispatched`
- `guest_instruction_bytes`
- `guest_insn_size_2`
- `guest_insn_size_4`
- `guest_load_events`
- `guest_store_events`

The instruction byte count is the sum of QEMU's translated guest instruction
sizes. Load and store values count guest memory-access events reported by the
plugin API, not bytes transferred.

## Fixed local toolchain

Run all build and behavioral checks with Docker:

```sh
tools/perf/qemu/docker.sh test
```

The image pins the Debian base manifest and archive snapshot, QEMU source
version and SHA-256, QEMU plugin API, Rust 1.93.0, and both GNU cross
toolchains. QEMU is built only for `arm-linux-user` and
`aarch64-linux-user`.

The ARM32 fixture flags are:

```text
-march=armv7-a -mthumb -mfpu=vfpv3-d16 -mfloat-abi=hard
```

All ARM32 runs use `-cpu cortex-a9,neon=off,vfp-d32=off`; all AArch64 runs use
`-cpu cortex-a53`. Both use `-seed 1`. Fixing the CPU model keeps linux-user
hardware capability bits and dynamic library dispatch stable. The seed fixes
QEMU-provided `AT_RANDOM`; it does not intercept the guest `getrandom(2)`
syscall. The QuickJS performance guest supplies Rust `RandomState` through its
own fingerprinted deterministic shim, while this plugin rejects raw entropy
syscalls inside a measured phase. The ARM32 reference environment does not
expose NEON.

The corresponding Rust lane uses `armv7-unknown-linux-gnueabihf` with
`-C target-feature=+thumb-mode`; QuickJS C sources use the flags above. This
directory deliberately performs no ELF instruction-mode inspection.

For an already prepared Linux host, set `QEMU_PREFIX` to a QEMU 11.0.3 install
that includes `qemu-plugin.h`, then run:

```sh
make -C tools/perf/qemu all
make -C tools/perf/qemu test
```

`run-fixtures.sh` first rejects any QEMU version other than 11.0.3. It then
checks the exact ARMv7 and AArch64 instruction/memory counts twenty times,
verifies an injected loop increases the instruction count by more than 10,000,
and exercises valid, nested, mismatched, missing, active-phase entropy, and
multithreaded marker cases. Parser-only tests need only Python 3:

```sh
make -C tools/perf/qemu test-parser
```

The fixture checks are local only; this directory does not define a remote
workflow.
