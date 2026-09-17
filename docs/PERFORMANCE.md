# Local performance regression checks

PocketJS compares a baseline checkout with the tracked contents of the current
checkout. The comparison uses versioned scenarios, input tapes, receipts and
budgets under `tools/perf/`.

## Commands

```sh
bun perf doctor
bun perf run --executor native --suite quick
bun perf run --executor qemu-armv7-thumb2 --suite quick
bun perf run --executor qemu-aarch64 --suite quick
bun perf compare --base <receipt-or-directory> --candidate <receipt-or-directory>
bun perf local --base <git-ref>
```

`doctor` reports missing tools and artifacts without installing or building
anything. Build the pinned QEMU image with:

```sh
tools/perf/qemu/docker.sh build
```

`run` writes a `run.json` summary. QEMU writes one receipt per measured phase;
Native writes one scenario receipt with its measured phases aggregated. Pass
`--out-dir` to retain them at a known path. New summaries store receipt paths
relative to that output directory, so a complete run directory remains
portable; comparison also safely relocates absolute paths written by earlier
version 1 summaries. `compare` accepts either two receipt files or two
directories containing matching receipt identities. When a
directory tree contains `run.json`, comparison requires every summary to be
schema-valid and successful, requires baseline and candidate executor/suite
runs to match, and verifies that the summaries list every receipt exactly once.
An invalid summary, malformed receipt, missing listed receipt or unlisted stale
receipt makes the whole comparison `invalid`. A directory comparison requires
this inventory on both sides; use two receipt file paths when intentionally
comparing one receipt pair.

`local` creates detached baseline and candidate worktrees below the system
temporary directory. It applies `git diff HEAD` to the candidate worktree,
then runs `bun install --frozen-lockfile` independently in each worktree. Bun's
global download cache may be shared, but baseline and candidate never share a
`node_modules` tree: each dependency graph comes from that snapshot's own
package manifest and lockfile. All generated artifacts remain inside the two
worktrees. The versioned workload sources under
`tools/perf/apps` are staged from the current benchmark harness into both
worktrees, so both revisions compile the same fixture against their own
framework and Core. **Other untracked files are neither copied into the
candidate nor included in its source hash.** Both temporary worktrees are
removed after the comparison.

The benchmark guest and its diagnostic hooks come from the current harness.
The measured QuickJS, framework, `UiSurface`, Core, bundles and assets come from
each source worktree, so a baseline does not need to contain the performance
runner itself.

## Executors

Native runs the framework, `UiSurface`, WASM core and software renderer. It
provides deterministic correctness results, bundle and PAK sizes, plus host wall
time as a diagnostic. **Native wall time is not a regression gate.** The
versioned measurement host comes from the current checkout, while the measured
WASM, bundle and PAK come from the source worktree.

Receipts record both the scenario's declared gate metrics and the subset that
an executor cannot observe. Native must declare every unavailable gate
explicitly. A Native comparison reports those metrics as unsupported only when
the selected budget does not apply to Native; an applicable Native budget with
no observation makes the comparison `invalid`.

Each Native scenario runs in a fresh Bun process. This prevents framework or
oracle globals from one app changing a later scenario while retaining two
independent worlds for its correctness and measurement replays.

QEMU uses pinned QEMU 11.0.3 linux-user and a plugin built from the same source.
A controlled guest syscall marks the beginning and end of each phase. Missing,
nested, mismatched or unclosed markers make the run `invalid`. The plugin counts:

- dispatched guest instructions;
- dynamic guest instruction bytes;
- 16-bit and 32-bit instruction counts;
- successful guest load and store events.

Every ARM and AArch64 invocation includes `-seed 1`, which fixes the entropy
QEMU supplies through the ELF `AT_RANDOM` auxiliary vector. **QEMU's seed does
not intercept a guest `getrandom(2)` syscall.** The QuickJS benchmark guest
therefore defines a benchmark-only `getrandom` symbol that supplies Rust
`RandomState` with a fixed, call-indexed nonzero byte stream. The plugin rejects
any raw `getrandom` syscall observed while a measurement marker is active, so a
future workload cannot silently restore entropy-dependent instruction paths.
The receipt profile records this as `seed-1+guest-shim-v1`; a profile change
requires a new baseline.

The guest also records allocation calls, allocated bytes, current bytes, the
peak increase above the phase-start allocation level, and QuickJS live memory
after forced collection. Artifact collection records bundle, PAK and ELF
`.text + .rodata` sizes where the subject produces them.

The QEMU guest preallocates one RGBA framebuffer and executes Core's
deterministic software rasterizer inside every measured frame. Its separate
correctness replay hashes every raw framebuffer into the same full-trace digest
as Native, and writes the declared raw framebuffer checkpoints and final frame
outside all markers. The host requires the full trace, each checkpoint and the
final frame to equal the Native replay. Hashing, file output and DevTools/effect
probes do not run inside a measurement interval.

**These QEMU counters describe one executed instruction path.** They do not
represent cycles, cache traffic, power use or device frame rate.

The ARMv7 executor uses:

```text
Rust target: armv7-unknown-linux-gnueabihf
Rust flags:  -C target-feature=+thumb-mode
QuickJS C:   -mthumb -march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard
QEMU CPU:    cortex-a9,neon=off,vfp-d32=off
```

The AArch64 executor fixes its QEMU CPU to `cortex-a53`. The ARMv7 reference
configuration does not expose NEON to the guest. The build configuration and
CPU model are recorded in every receipt; no ELF instruction-mode check is part
of the normal suite. ARMv7 Thumb-2 and AArch64 receipts are compared only with
receipts from the same executor, CPU model, toolchain, sysroot, build profile
and QEMU image.

## Replay and correctness

Every scenario has two executions. The correctness execution hashes the
framebuffer trace, DrawList, final state and effects. The measurement execution
replays the same input and excludes hash, PNG and diagnostic serialization from
the marked intervals. A replay mismatch makes the receipt `invalid` before any
metric threshold is considered.

The quick suite contains framework startup and first frame for Solid, Vue Vapor
and Octane, an idle screen, fixed-size text updates, list mutation, paint and
layout updates, timers and animation, damage regions, touch input, a generated-C
Vapor reactive grid, and DeepZoom tile uploads. Scenario manifests carry a
total cold-run estimate, and the command rejects a suite above the configured
`--max-estimated-seconds` ceiling. The default ceiling is 1,500 seconds.

For the generated-C Vapor grid, `correctness.framebuffer` is the full trace of
the character-and-palette presentation buffer. The guest produces that trace
after its generated state has matched the independent Vue Vapor oracle.

## Budgets

A relative threshold and its absolute floor must both be exceeded. Equality is
within budget.

| Metric | Warning | Regression |
| --- | ---: | ---: |
| Guest instructions | >0.5% and >5,000 | >1% and >10,000 |
| Dynamic instruction bytes | >0.5% and >10 KiB | >1% and >20 KiB |
| Load and store events | >1% and >10,000 | >2% and >20,000 |
| Allocated bytes | >1% and >4 KiB | >2% and >8 KiB |
| QuickJS live bytes after GC | >1% and >32 KiB | >2% and >64 KiB |
| Bundle bytes | >1% and >2 KiB | >3% and >4 KiB |
| ELF `.text + .rodata` | >0.5% and >2 KiB | >1% and >4 KiB |

The generated-C Vapor grid has a scenario-specific `memory.allocations`
`hardMax` of zero. Instruction-width distribution, separate load/store counts,
current and peak allocation gauges, and Native wall time remain diagnostics.
The budget schema rejects those diagnostic metrics, including in
scenario-specific overrides, so a custom budget cannot silently turn them into
regression gates.

`params.gateMetrics` is the scenario's required regression-observation list.
Each gate must be a non-diagnostic catalog metric. A supported gate must be
present in the receipt and have a budget applicable to the receipt's executor
and scenario. An executor may instead declare the gate unsupported only when
the metric has a configured budget that does not apply to that executor.
Missing observations, silent omissions and missing budgets make a comparison
`invalid`. A metric outside `gateMetrics` is still checked when the receipt
emits it and the selected budget applies; this keeps shared counters such as
dynamic instruction bytes covered without requiring every scenario to repeat
the full metric catalog.

`pass` means no applicable, supported budget was exceeded. The comparison and
receipts retain the explicit unsupported-gate list. `warn` reports a warning
threshold or an inconclusive sampled regression. `regression` reports a
conclusive regression or a hard-limit violation. `invalid` reports incomparable
provenance, correctness drift, missing required observations or protocol errors.
The command exits with 0 for `pass` and `warn`, 1 for `regression`, and 2 for
invalid input or execution.

PPSSPP will use the same receipt and comparison formats after the deterministic
QEMU paths have completed local calibration. PSP receipts will compare only with
PSP baselines.

## GitHub validation

`.github/workflows/perf.yml` runs the versioned harness on an Ubuntu runner when
performance-sensitive paths change, and it can also be started manually. The
workflow runs the JavaScript, WASM-host and Rust harness checks plus an isolated
Native A/A comparison. Two parallel jobs independently build the pinned QEMU
image from its verified source archive; one verifies the marker/plugin fixtures,
and both run the complete quick suite twice for their ARMv7 Thumb-2 or AArch64
target. **The workflow has read-only repository permissions and contains no
publish or deployment step.** Receipts, comparison reports and failure logs are
retained for 7 days.
