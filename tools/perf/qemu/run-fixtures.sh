#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD_DIR=${BUILD_DIR:-"$SCRIPT_DIR/build"}
QEMU_PREFIX=${QEMU_PREFIX:-/opt/qemu}
PLUGIN=${PLUGIN:-"$BUILD_DIR/pocketjs-perf-counter.so"}
PYTHON=${PYTHON:-python3}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pocketjs-qemu-fixtures.XXXXXX")

cleanup() {
    rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

require_version() {
    emulator=$1
    version=$($emulator --version | sed -n '1p')
    case "$version" in
        *"version 11.0.3"*) ;;
        *)
            echo "expected QEMU 11.0.3, got: $version" >&2
            exit 2
            ;;
    esac
}

run_guest() {
    name=$1
    emulator=$2
    binary=$3
    shift 3
    if [ "$emulator" = "$QEMU_ARM" ]; then
        "$emulator" -cpu "cortex-a9,neon=off,vfp-d32=off" \
            -seed 1 \
            -d plugin -plugin "$PLUGIN" "$binary" "$@" \
            >"$TMP_DIR/$name.log" 2>&1
    else
        "$emulator" -cpu cortex-a53 \
            -seed 1 \
            -d plugin -plugin "$PLUGIN" "$binary" "$@" \
            >"$TMP_DIR/$name.log" 2>&1
    fi
}

assert_output() {
    "$PYTHON" "$SCRIPT_DIR/tests/assert_output.py" "$@"
}

QEMU_ARM="$QEMU_PREFIX/bin/qemu-arm"
QEMU_AARCH64="$QEMU_PREFIX/bin/qemu-aarch64"
require_version "$QEMU_ARM"
require_version "$QEMU_AARCH64"

attempt=1
while [ "$attempt" -le 20 ]; do
    run_guest "exact-armv7-$attempt" "$QEMU_ARM" "$BUILD_DIR/exact-armv7"
    assert_output "$TMP_DIR/exact-armv7-$attempt.log" --complete --target arm \
        --metrics "$SCRIPT_DIR/tests/expected/exact-armv7.json"

    run_guest "exact-aarch64-$attempt" "$QEMU_AARCH64" "$BUILD_DIR/exact-aarch64"
    assert_output "$TMP_DIR/exact-aarch64-$attempt.log" --complete --target aarch64 \
        --metrics "$SCRIPT_DIR/tests/expected/exact-aarch64.json"
    attempt=$((attempt + 1))
done

for architecture in armv7 aarch64; do
    if [ "$architecture" = armv7 ]; then
        emulator=$QEMU_ARM
    else
        emulator=$QEMU_AARCH64
    fi
    binary="$BUILD_DIR/marker-cases-$architecture"

    run_guest "valid-$architecture" "$emulator" "$binary" valid
    assert_output "$TMP_DIR/valid-$architecture.log" --complete

    run_guest "valid-loop-$architecture" "$emulator" "$binary" valid-loop
    assert_output "$TMP_DIR/valid-loop-$architecture.log" --complete
    "$PYTHON" "$SCRIPT_DIR/tests/assert_metric_delta.py" \
        "$TMP_DIR/valid-$architecture.log" \
        "$TMP_DIR/valid-loop-$architecture.log" \
        --metric guest_insn_dispatched --minimum-delta 10000

    run_guest "getrandom-before-$architecture" "$emulator" "$binary" \
        getrandom-before
    assert_output "$TMP_DIR/getrandom-before-$architecture.log" --complete

    run_guest "getrandom-active-$architecture" "$emulator" "$binary" \
        getrandom-active
    assert_output "$TMP_DIR/getrandom-active-$architecture.log" \
        --error getrandom_during_measurement

    run_guest "nested-$architecture" "$emulator" "$binary" nested
    assert_output "$TMP_DIR/nested-$architecture.log" --error nested_begin

    run_guest "mismatch-$architecture" "$emulator" "$binary" mismatch
    assert_output "$TMP_DIR/mismatch-$architecture.log" --error marker_mismatch

    run_guest "unexpected-end-$architecture" "$emulator" "$binary" unexpected-end
    assert_output "$TMP_DIR/unexpected-end-$architecture.log" --error unexpected_end

    run_guest "missing-end-$architecture" "$emulator" "$binary" missing-end
    assert_output "$TMP_DIR/missing-end-$architecture.log" --error missing_end

    run_guest "missing-begin-$architecture" "$emulator" "$binary" none
    assert_output "$TMP_DIR/missing-begin-$architecture.log" --error missing_begin

    run_guest "multivcpu-$architecture" "$emulator" \
        "$BUILD_DIR/multivcpu-$architecture"
    assert_output "$TMP_DIR/multivcpu-$architecture.log" --error multiple_vcpus
done

echo "QEMU perf plugin fixtures passed"
