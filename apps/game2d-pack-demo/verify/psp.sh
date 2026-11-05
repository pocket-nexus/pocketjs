#!/bin/bash
# Build one PSP EBOOT of the demo and run it in PPSSPPHeadless with an isolated HOME.
#   verify/psp.sh <run-name> <capture|bench|plain> [layout] [cap-start] [cap-n]
# layout: beside   data beside the EBOOT (PPSSPP's umd0:/ current directory)
#         game     EBOOT and data in ms0:/PSP/GAME/game2d-pack-demo/
#         fallback EBOOT elsewhere, data only in ms0:/PSP/GAME/game2d-pack-demo/
#         none     no data anywhere
# Env: POCKET_NEXUS_CACHE_DIR (PSP toolchain), PPSSPP_HOME (ms0: = $PPSSPP_HOME/.ppsspp),
#      PPSSPP_HEADLESS (default ~/ppsspp-src/build/PPSSPPHeadless).
# Output lands in .pocket-build/validation/game2d-pack-demo/<run-name>/. Timings are PPSSPP's model.
set -euo pipefail
APP=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$APP/../.." && pwd)
RUN=$1; MODE=$2; LAYOUT=${3:-beside}; START=${4:-120}; N=${5:-2}
HEADLESS=${PPSSPP_HEADLESS:-$HOME/ppsspp-src/build/PPSSPPHeadless}
PH=${PPSSPP_HOME:?isolated HOME for PPSSPP}
OUT=$ROOT/.pocket-build/validation/game2d-pack-demo/$RUN
GAME=$PH/.ppsspp/PSP/GAME/game2d-pack-demo
rm -rf "$OUT" "$PH/.ppsspp/dc_cap" "$GAME" "$PH/.ppsspp/PSP/SAVEDATA/POCKETJS/game2d-pack-demo" "$PH/.ppsspp/PocketJS-bench.jsonl"
mkdir -p "$OUT" "$PH/.ppsspp"
[ -f "$APP/gen/data/demo/tiles.pack" ] || bun "$APP/gen-assets.ts"

FLAGS=(--release)
case "$MODE" in
  capture) FLAGS+=(--capture); DUMP=1 ;;
  bench) FLAGS+=(--bench); DUMP=0 ;;
  plain) DUMP=0 ;;
  *) echo "mode: capture|bench|plain" >&2; exit 2 ;;
esac
cd "$ROOT"
POCKETJS_CAPTURE_INPUT="0:0" POCKETJS_CAP_START="$START" POCKETJS_CAP_N="$N" POCKETJS_BENCH_DUMP_FRAMES="$DUMP" \
  bun tools/psp.ts game2d-pack-demo "${FLAGS[@]}" > "$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; exit 1; }

case "$LAYOUT" in
  beside) DIR=$OUT/eboot; mkdir -p "$DIR"; cp -R "$APP/gen/data/demo" "$DIR/demo" ;;
  game) DIR=$GAME; mkdir -p "$DIR"; cp -R "$APP/gen/data/demo" "$DIR/demo" ;;
  fallback) DIR=$OUT/eboot; mkdir -p "$DIR" "$GAME"; cp -R "$APP/gen/data/demo" "$GAME/demo" ;;
  none) DIR=$OUT/eboot; mkdir -p "$DIR" ;;
  *) echo "layout: beside|game|fallback|none" >&2; exit 2 ;;
esac
cp programs/psp/target/mipsel-sony-psp/release/EBOOT.PBP "$DIR/EBOOT.PBP"
ls -la "$DIR/EBOOT.PBP" | awk '{print "eboot bytes", $5}' | tee "$OUT/eboot.txt"
if [ -z "${SDL:-}" ]; then
  (cd "$OUT" && HOME="$PH" "$HEADLESS" --graphics=software --timeout="${PPSSPP_TIMEOUT:-300}" "$DIR/EBOOT.PBP" > "$OUT/ppsspp.log" 2>&1) || true
  [ -d "$PH/.ppsspp/dc_cap" ] && cp -R "$PH/.ppsspp/dc_cap" "$OUT/dc_cap"
  [ -f "$PH/.ppsspp/PocketJS-bench.jsonl" ] && cp "$PH/.ppsspp/PocketJS-bench.jsonl" "$OUT/bench.jsonl"
  [ -f "$DIR/PocketJS-bench.jsonl" ] && cp "$DIR/PocketJS-bench.jsonl" "$OUT/bench.jsonl"
  [ -f "$PH/.ppsspp/PSP/SAVEDATA/POCKETJS/game2d-pack-demo/report.json" ] && cp "$PH/.ppsspp/PSP/SAVEDATA/POCKETJS/game2d-pack-demo/report.json" "$OUT/report.json"
fi
echo "out: $OUT"
ls "$OUT"
