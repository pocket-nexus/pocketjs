#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
out=${2:-"$repo/.pocket-build/validation/worker/native"}
mkdir -p "$out"
cc=${CC:-cc}
"$cc" -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -I"$repo/engine/worker/include" "$repo/engine/worker/src/worker.c" "$repo/engine/worker/tests/core.c" -lpthread -o "$out/core"
"$out/core"
if [ -n "${1:-}" ]; then
  qjs=$1
  engine=${3:-ng}
  engine_flags=""
  sources="quickjs dtoa libregexp libunicode"
  if [ "$engine" = bellard ]; then
    engine_flags="-DPOCKET_QJS_BELLARD -DJS_NO_NAN_BOXING"
    sources="$sources cutils"
  elif [ "$engine" != ng ]; then
    echo "unknown QuickJS engine: $engine" >&2
    exit 2
  fi
  objects=""
  for source in $sources; do
    "$cc" -std=gnu11 -D_GNU_SOURCE -DCONFIG_VERSION=\"test\" $engine_flags -O1 -I"$qjs" -c "$qjs/$source.c" -o "$out/$source.o"
    objects="$objects $out/$source.o"
  done
  "$cc" -std=c11 -Wall -Wextra -Werror $engine_flags -I"$repo/engine/worker/include" -isystem "$qjs" "$repo/engine/worker/src/worker.c" "$repo/engine/worker/src/quickjs.c" "$repo/engine/worker/src/quickjs_ui.c" "$repo/engine/worker/tests/quickjs.c" $objects -lm -lpthread -o "$out/quickjs-test"
  "$out/quickjs-test"
fi
