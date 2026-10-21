#!/usr/bin/env bash
set -euo pipefail

: "${POCKET_BUILD_ID:?missing POCKET_BUILD_ID}"
: "${POCKETJS_TARGET_ID:?missing POCKETJS_TARGET_ID}"
: "${POCKETJS_HOST_ABI:?missing POCKETJS_HOST_ABI}"
: "${POCKET_RASTER_DENSITY:?missing POCKET_RASTER_DENSITY}"
: "${POCKET_LOGICAL_WIDTH:?missing POCKET_LOGICAL_WIDTH}"
: "${POCKET_LOGICAL_HEIGHT:?missing POCKET_LOGICAL_HEIGHT}"
: "${QNX_COMPILER:?missing QNX_COMPILER}"
: "${QUICKJS_VERSION:?missing QUICKJS_VERSION}"

qcc="$QNX_HOST/usr/bin/qcc"
ar="$QNX_HOST/usr/bin/ntoarmv7-ar"
readelf="$QNX_HOST/usr/bin/ntoarmv7-readelf"
nm="$QNX_HOST/usr/bin/ntoarmv7-nm"
objects=/build/objects
quickjs_objects="$objects/quickjs"
staging=/build/staging
quickjs=/build/quickjs-rs/libquickjs-sys/embed/quickjs
static_functions=/build/quickjs-rs/libquickjs-sys/embed/static-functions.c

mkdir -p "$quickjs_objects" "$staging"

qnx_target=(-V"$QNX_COMPILER")
quickjs_flags=(
  "${qnx_target[@]}"
  -std=gnu11
  -O2
  -fPIC
  -funsigned-char
  -fno-strict-aliasing
  -ffunction-sections
  -fdata-sections
  -D_GNU_SOURCE
  -DCONFIG_VERSION=\""$QUICKJS_VERSION"\"
  -I"$quickjs"
  -Wno-unused-parameter
)

quickjs_object_paths=()
for source in cutils.c dtoa.c libregexp.c libunicode.c quickjs.c; do
  object="$quickjs_objects/${source%.c}.o"
  "$qcc" "${quickjs_flags[@]}" -c "$quickjs/$source" -o "$object"
  quickjs_object_paths+=("$object")
done
static_object="$quickjs_objects/static-functions.o"
"$qcc" "${quickjs_flags[@]}" -c "$static_functions" -o "$static_object"
quickjs_object_paths+=("$static_object")
"$ar" rcs /build/libquickjs.a "${quickjs_object_paths[@]}"

first_party_flags=(
  "${qnx_target[@]}"
  -std=gnu11
  -Os
  -fPIE
  -fno-strict-aliasing
  -ffunction-sections
  -fdata-sections
  -Wall
  -Wextra
  -Werror
  -Wno-unused-parameter
)

"$qcc" "${first_party_flags[@]}" \
  -DPOCKETJS_TARGET_ID=\""$POCKETJS_TARGET_ID"\" \
  -DPOCKETJS_HOST_ABI="$POCKETJS_HOST_ABI" \
  -DPOCKET_RASTER_DENSITY="$POCKET_RASTER_DENSITY" \
  -I/repo/engine/quickjs-c \
  -I/repo/engine/guest-quickjs/include -I/repo/engine/ui-cabi/include \
  -I/repo/contracts/generated \
  -I"$quickjs" \
  -c /repo/engine/quickjs-c/pocket_runtime.c \
  -o "$objects/pocket_runtime.o"

"$qcc" "${first_party_flags[@]}" \
  -I/repo/engine/guest-quickjs/include -I/repo/contracts/generated -I"$quickjs" \
  -c /repo/engine/guest-quickjs/src/guest.c -o "$objects/pocket_guest_quickjs.o"

"$qcc" "${first_party_flags[@]}" \
  -I/repo/hosts/blackberry-classic \
  -I/repo/contracts/generated \
  -c /repo/hosts/blackberry-classic/pocket_input.c \
  -o "$objects/pocket_input.o"

"$qcc" "${first_party_flags[@]}" \
  -DPOCKET_BUILD_ID=\""$POCKET_BUILD_ID"\" \
  -DPOCKET_LOGICAL_WIDTH="$POCKET_LOGICAL_WIDTH" \
  -DPOCKET_LOGICAL_HEIGHT="$POCKET_LOGICAL_HEIGHT" \
  -I/repo/engine/quickjs-c \
  -I/repo/hosts/blackberry-classic \
  -I/repo/contracts/generated \
  -c /repo/hosts/blackberry-classic-qnx/main.c \
  -o "$objects/main.o"

"$qcc" "${qnx_target[@]}" \
  -pie \
  -Wl,-z,relro \
  -Wl,-z,now \
  -Wl,--gc-sections \
  -Wl,--no-undefined \
  -o "$staging/pocketjs-classic" \
  "$objects/main.o" \
  "$objects/pocket_runtime.o" \
  "$objects/pocket_guest_quickjs.o" \
  "$objects/pocket_input.o" \
  /build/libquickjs.a \
  /build/libpocketjs_symbian_core.a \
  -lbps \
  -lscreen \
  -lEGL \
  -lGLESv2 \
  -lm

"$readelf" -h -l -A -d "$staging/pocketjs-classic" > /build/pocketjs-classic.readelf.txt
"$nm" -g "$staging/pocketjs-classic" > /build/pocketjs-classic.symbols.txt

cd "$staging"
blackberry-nativepackager \
  -package /build/pocketjs-blackberry-classic-hero.bar \
  -devMode \
  -configuration Device-Release \
  bar-descriptor.xml
