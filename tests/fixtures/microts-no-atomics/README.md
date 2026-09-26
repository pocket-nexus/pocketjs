# MicroTS atomic backend link fixture

This `no_std` binary calls the real MicroTS region allocator and heapless SPSC
queue on `thumbv4t-none-eabi`, which has no native compare-and-swap instruction.
**The check links an ELF; it does not execute firmware.** The fixture has no
vector table or startup code and does not verify interrupt behavior on hardware.

Run from the repository root:

```sh
rustup toolchain install nightly-2026-07-01 --profile minimal --component rust-src
bash tests/fixtures/microts-no-atomics/check.sh
```

The script builds two host policies in separate Cargo invocations:

- `critical-section-impl` enables `microts/critical-section` and supplies a
  single-core, privileged ARM implementation. It saves CPSR, masks IRQ and FIQ,
  and restores the saved state when the section exits.
- `single-core` selects `portable-atomic/unsafe-assume-single-core` and
  `portable-atomic/disable-fiq` through the host dependency. It has no
  critical-section dependency or implementation.

The `critical-section` build omits the host implementation. It must fail to link
with an unresolved `_critical_section_1_0_acquire` symbol. This check ensures
that calls survive dead-code removal and that a compile check cannot conceal a
missing provider.

The script places ELF files, logs, and Cargo output under the ignored
`.pocket-build/validation/microts-no-atomics/<run>/` directory. Pass an output
directory as the first argument or set `MICROTS_ATOMIC_TOOLCHAIN` to override
the toolchain. `check.sh` contains the complete Cargo command and linker flags.
