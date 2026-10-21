#!/bin/sh
# Run against a caller-selected QuickJS source; no network or source edits.
set -eu
qjs_dir=${1:?usage: run.sh QUICKJS_SOURCE_DIRECTORY [OUTPUT_DIRECTORY]}
build_dir=${2:-.pocket-build/validation/ui-bindings/quickjs-c}
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
mkdir -p "$build_dir"
cc=${CC:-cc}
engine=${3:-ng}
engine_flags=""
sources="quickjs dtoa libregexp libunicode"
if [ "$engine" = bellard ]; then
  engine_flags='-DPOCKET_QJS_BELLARD -DJS_NO_NAN_BOXING'
  sources="$sources cutils"
elif [ "$engine" != ng ]; then
  echo "unknown QuickJS engine: $engine" >&2
  exit 2
fi
# Keep vendor warnings separate from warnings in maintained adapter sources.
objects=""
for source in $sources; do
  "$cc" -std=gnu11 -D_GNU_SOURCE -DCONFIG_VERSION=\"test\" $engine_flags -O1 -I"$qjs_dir" -c "$qjs_dir/$source.c" -o "$build_dir/$source.o"
  objects="$objects $build_dir/$source.o"
done
link_flags=""
build_and_run() {
  name=$1
  shift
  # Instrument only adapter scratch allocations, not the engine's bytecode,
  # string, or heap allocations. The fixture supplies these libc wrappers.
  "$cc" -std=c11 -Wall -Wextra -Werror $engine_flags "$@" -Dmalloc=pocket_test_malloc -Dfree=pocket_test_free -I"$repo_dir/engine/guest-quickjs/include" -I"$repo_dir/contracts/generated" -isystem "$qjs_dir" -c "$repo_dir/engine/guest-quickjs/src/guest.c" -o "$build_dir/guest-$name.o"
  "$cc" -std=c11 -Wall -Wextra -Werror $engine_flags "$@" -I"$repo_dir/engine/guest-quickjs/include" -I"$repo_dir/contracts/generated" -isystem "$qjs_dir" "$repo_dir/engine/guest-quickjs/tests/bindings.c" "$build_dir/guest-$name.o" $objects $link_flags -lm -lpthread -o "$build_dir/$name"
  "$build_dir/$name"
}
build_and_run bindings
# The adapter's weak immutable API is absent in this link. Source ownership
# must still hold when JavaScript can write to its copied package buffer.
if [ "$(uname -s)" = Darwin ]; then
  link_flags='-Wl,-U,_pocket_test_missing_immutable_api'
  build_and_run bindings-without-immutable -DJS_SetImmutableArrayBuffer=pocket_test_missing_immutable_api
else
  build_and_run bindings-without-immutable -DJS_SetImmutableArrayBuffer=pocket_test_missing_immutable_api
fi
