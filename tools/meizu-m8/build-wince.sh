#!/bin/sh
set -eu

CC=/opt/cegcc-arm/bin/arm-mingw32ce-gcc
AR=/opt/cegcc-arm/bin/arm-mingw32ce-ar
OBJDUMP=/opt/cegcc-arm/bin/arm-mingw32ce-objdump
NM=/opt/cegcc-arm/bin/arm-mingw32ce-nm
COMMON="-std=gnu99 -mcpu=arm1136jf-s -marm -Os -fno-strict-aliasing -ffunction-sections -fdata-sections"

mkdir -p /build/objects/core /build/objects/qjs
for source in /build/core-asm/*.s; do
  name=$(basename "$source" .s)
  "$CC" -c -mcpu=arm1136jf-s -marm "$source" -o "/build/objects/core/$name.o"
done
"$AR" rcs /build/libpocketjs-core-wince.a /build/objects/core/*.o

"$CC" $COMMON -Wall -Wextra -Werror -Wno-unused-parameter \
  -DPOCKET_BUILD_ID=\"$POCKET_BUILD_ID\" \
  -DPOCKET_LOGICAL_WIDTH=$POCKET_LOGICAL_WIDTH \
  -DPOCKET_LOGICAL_HEIGHT=$POCKET_LOGICAL_HEIGHT \
  -I/src/engine/quickjs-c \
  -c /src/hosts/meizu-m8/runtime.c -o /build/objects/runtime.o
"$CC" $COMMON -Wall -Wextra -Werror -Wno-unused-parameter \
  -DPOCKET_RUNTIME_REPORT_BOOT_STAGE=1 \
  -DPOCKETJS_TARGET_ID=\"$POCKETJS_TARGET_ID\" \
  -include /build/pocket_host_profile.h \
  -DPOCKETJS_HOST_ABI=$POCKETJS_HOST_ABI \
  -I/src/engine/quickjs-c -I/src/engine/guest-quickjs/include -I/src/engine/ui-cabi/include \
  -I/src/contracts/generated -I/build/qjs \
  -c /src/engine/quickjs-c/pocket_runtime.c -o /build/objects/pocket_runtime.o
"$CC" $COMMON -Wall -Wextra -Werror -Wno-unused-parameter \
  -I/src/engine/guest-quickjs/include -I/src/contracts/generated -I/build/qjs \
  -c /src/engine/guest-quickjs/src/guest.c -o /build/objects/pocket_guest_quickjs.o
"$CC" $COMMON -Wall -Wextra -Werror \
  -c /src/hosts/meizu-m8/compat.c -o /build/objects/compat.o
"$CC" $COMMON -Wall -Wextra -Werror \
  -c /build/embedded.c -o /build/objects/embedded.o
"$CC" $COMMON -Wall -Wextra -Werror \
  /src/hosts/meizu-m8/stop-old.c -ltoolhelp -o /build/PocketJSStop.exe

for source in quickjs.c cutils.c dtoa.c libregexp.c libunicode.c; do
  name=$(basename "$source" .c)
  "$CC" $COMMON -Wall -Wextra -Wno-unused-parameter -Wno-sign-compare \
    -Wno-format -Wno-implicit-fallthrough \
    -D_WIN32_WCE=0x600 -DCONFIG_VERSION=\"$QUICKJS_VERSION\" \
    -I/build/qjs -c "/build/qjs/$source" -o "/build/objects/qjs/$name.o"
done

"$CC" -mcpu=arm1136jf-s -marm \
  -Wl,--gc-sections \
  -o /build/PocketJS.exe \
  /build/objects/runtime.o \
  /build/objects/pocket_runtime.o \
  /build/objects/pocket_guest_quickjs.o \
  /build/objects/compat.o \
  /build/objects/embedded.o \
  /build/objects/qjs/*.o \
  -Wl,--whole-archive /build/libpocketjs-core-wince.a -Wl,--no-whole-archive \
  -lm

"$OBJDUMP" -f -p /build/PocketJS.exe > /build/PocketJS.objdump.txt
"$NM" /build/PocketJS.exe > /build/PocketJS.symbols.txt
