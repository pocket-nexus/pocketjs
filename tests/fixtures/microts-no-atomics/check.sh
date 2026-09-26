#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$fixture_dir/../../.." && pwd)"
run_dir="${1:-$repo_root/.pocket-build/validation/microts-no-atomics/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
toolchain="${MICROTS_ATOMIC_TOOLCHAIN:-nightly-2026-07-01}"
mkdir -p "$run_dir"
export CARGO_ENCODED_RUSTFLAGS=$'-C\x1flink-arg=--entry=_start'

build=(cargo "+$toolchain" build --locked --release
    --manifest-path "$fixture_dir/Cargo.toml"
    --target thumbv4t-none-eabi -Zbuild-std=core,alloc
    -Zbuild-std-features=compiler-builtins-mem
    --target-dir "$run_dir/target")

for backend in critical-section-impl single-core; do
    echo "Linking thumbv4t-none-eabi with $backend"
    "${build[@]}" --features "$backend" >"$run_dir/$backend.log" 2>&1 || {
        cat "$run_dir/$backend.log"
        exit 1
    }
    cp "$run_dir/target/thumbv4t-none-eabi/release/microts-no-atomics-link" "$run_dir/$backend.elf"
done

echo "Checking that a missing host critical-section implementation fails to link"
if "${build[@]}" --features critical-section >"$run_dir/missing-provider.log" 2>&1; then
    echo "Expected a link failure without critical_section::set_impl!" >&2
    exit 1
fi
if ! grep -q '_critical_section_1_0_acquire' "$run_dir/missing-provider.log"; then
    cat "$run_dir/missing-provider.log"
    echo "The missing-provider build failed for an unexpected reason" >&2
    exit 1
fi
echo "Atomic backend link checks passed; output: $run_dir"
