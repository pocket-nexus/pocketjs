#!/bin/bash
# vapor/tests/harness/sdcc_shim.sh — stand in for sdcc during GB build tests.
#
# Placed on PATH under the name `sdcc` by gb-build.test.ts. It records when
# each invocation starts and ends (so a test can see whether the three
# translation units overlap in time) and can fail a chosen unit on demand
# (so a test can see whether that failure reaches the caller).
#
#   VP_SDCC_REAL  path to the real sdcc                        (required)
#   VP_SDCC_LOG   append "S|E <basename> <epoch-ms>" per run   (optional)
#   VP_SDCC_FAIL  comma-separated source basenames to fail     (optional)
#   VP_SDCC_FAIL_OUTPUT  1 = leave partial -o before failing    (optional)
#   VP_SDCC_FAIL_STDOUT  comma-separated failures using stdout  (optional)
#   VP_SDCC_STUB  1 = don't really compile; just touch -o      (optional)
#   VP_SDCC_DELAY_<UNIT> seconds to wait before that unit exits (optional)
#
# Only `-c` compiles are shimmed by name; the link invocation has no -c and
# no source basename, so it always falls through to the real sdcc.

src=""
out=""
compiling=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) out="$arg" ;;
  esac
  case "$arg" in
    -c) compiling=1 ;;
    *.c) src="$arg" ;;
  esac
  prev="$arg"
done
unit="${src##*/}"

now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }
log() { [ -n "${VP_SDCC_LOG:-}" ] && echo "$1 ${unit:-link} $(now_ms)" >> "$VP_SDCC_LOG"; }

delay=""
case "$unit" in
  vapor_core.c) delay="${VP_SDCC_DELAY_VAPOR_CORE:-}" ;;
  vapor_gb.c) delay="${VP_SDCC_DELAY_VAPOR_GB:-}" ;;
  gen_app.c) delay="${VP_SDCC_DELAY_GEN_APP:-}" ;;
esac
log S
status=0
if [ -n "$compiling" ] && [ -n "$unit" ] && [[ ",${VP_SDCC_FAIL:-}," == *",$unit,"* ]]; then
  [ -n "${VP_SDCC_FAIL_OUTPUT:-}" ] && [ -n "$out" ] && printf 'sdcc_shim partial output\n' > "$out"
  if [[ ",${VP_SDCC_FAIL_STDOUT:-}," == *",$unit,"* ]]; then
    echo "sdcc_shim: injected failure for $unit"
  else
    echo "sdcc_shim: injected failure for $unit" >&2
  fi
  status=1
elif [ -n "$compiling" ] && [ -n "${VP_SDCC_STUB:-}" ]; then
  # Stubbed success: a non-empty file at -o that is not a valid .rel, so a
  # link that wrongly proceeds on it fails loudly rather than silently.
  [ -n "$out" ] && printf 'sdcc_shim stub\n' > "$out"
  sleep "${VP_SDCC_STUB_DELAY:-0}"
else
  "$VP_SDCC_REAL" "$@"
  status=$?
fi
[ -n "$delay" ] && sleep "$delay"
log E
exit $status
