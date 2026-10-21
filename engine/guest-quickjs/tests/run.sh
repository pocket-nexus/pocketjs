#!/bin/sh
# Run against a caller-selected QuickJS-NG checkout; no network or source edits.
set -eu
qjs_dir=${1:?usage: run.sh QUICKJS_SOURCE_DIRECTORY [OUTPUT_DIRECTORY]}
build_dir=${2:-.pocket-build/validation/ui-bindings/quickjs-c}
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
mkdir -p "$build_dir"
cc=${CC:-cc}
# Keep vendor warnings separate from warnings in maintained adapter sources.
for source in quickjs dtoa libregexp libunicode; do
  "$cc" -std=c11 -D_GNU_SOURCE -O1 -I"$qjs_dir" -c "$qjs_dir/$source.c" -o "$build_dir/$source.o"
done
build_and_run() {
  name=$1
  shift
  "$cc" -std=c11 -Wall -Wextra -Werror "$@" -I"$repo_dir/engine/guest-quickjs/include" -I"$repo_dir/contracts/generated" -I"$qjs_dir" "$repo_dir/engine/guest-quickjs/src/guest.c" "$repo_dir/engine/guest-quickjs/tests/bindings.c" "$build_dir/quickjs.o" "$build_dir/dtoa.o" "$build_dir/libregexp.o" "$build_dir/libunicode.o" -lm -lpthread -o "$build_dir/$name"
  "$build_dir/$name"
}
build_and_run bindings
# The adapter's weak immutable API is absent in this link. Source ownership
# must still hold when JavaScript can write to its copied package buffer.
if [ "$(uname -s)" = Darwin ]; then
  build_and_run bindings-without-immutable -DJS_SetImmutableArrayBuffer=pocket_test_missing_immutable_api -Wl,-U,_pocket_test_missing_immutable_api
else
  build_and_run bindings-without-immutable -DJS_SetImmutableArrayBuffer=pocket_test_missing_immutable_api
fi
