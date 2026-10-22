#!/bin/sh
set -eu

CACHE_ROOT=$1
REPOSITORY=$2
REVISION=$3
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SOURCE="$CACHE_ROOT/sources/synce-core"
BUILD="$CACHE_ROOT/build/synce-core-macos"
PREFIX="$CACHE_ROOT/host"

if [ ! -d "$SOURCE/.git" ]; then
  mkdir -p "$CACHE_ROOT/sources"
  git clone --filter=blob:none --no-checkout "$REPOSITORY" "$SOURCE"
  git -C "$SOURCE" checkout --detach "$REVISION"
fi
ACTUAL_REVISION=$(git -C "$SOURCE" rev-parse HEAD)
if [ "$ACTUAL_REVISION" != "$REVISION" ]; then
  echo "refusing unpinned SynCE checkout $ACTUAL_REVISION" >&2
  exit 1
fi
if git -C "$SOURCE" apply --check "$SCRIPT_DIR/synce-macos.patch" 2>/dev/null; then
  git -C "$SOURCE" apply "$SCRIPT_DIR/synce-macos.patch"
elif ! grep -q '^#if HAVE_GUDEV$' "$SOURCE/dccm/synce-device.c" || \
  ! grep -q 'rndis ? 990 : 5679' "$SOURCE/dccm/synce-device-manager.c"; then
  echo "SynCE macOS patch is neither applicable nor present" >&2
  exit 1
fi

(cd "$SOURCE" && autoreconf -fi)
mkdir -p "$BUILD" "$PREFIX/share/synce-core/rules.d" "$PREFIX/var/run"
if [ ! -f "$BUILD/Makefile" ] || \
  ! grep -q '^#define ENABLE_UDEV_SUPPORT 1$' "$BUILD/config.h" 2>/dev/null; then
  (
    cd "$BUILD"
    PKG_CONFIG_PATH="$(brew --prefix glib)/lib/pkgconfig:$(brew --prefix dbus)/lib/pkgconfig" \
      DHCLIENTPATH=/usr/bin/true \
      UDEVADMPATH=/usr/bin/true \
      UDEV_CFLAGS=-I/usr/include \
      UDEV_LIBS=-lc \
      "$SOURCE/configure" \
        --prefix="$PREFIX" \
        --disable-python-bindings \
        --enable-udev-support \
        --enable-dccm-file-support
  )
fi
PKG_CONFIG_PATH="$(brew --prefix glib)/lib/pkgconfig:$(brew --prefix dbus)/lib/pkgconfig" \
DHCLIENTPATH=/usr/bin/true \
UDEVADMPATH=/usr/bin/true \
UDEV_CFLAGS=-I/usr/include \
UDEV_LIBS=-lc \
make -C "$BUILD" -j4 \
  CFLAGS='-g -O2 -std=gnu89 -Wno-deprecated-declarations' \
  LIBS=-liconv
PKG_CONFIG_PATH="$(brew --prefix glib)/lib/pkgconfig:$(brew --prefix dbus)/lib/pkgconfig" \
DHCLIENTPATH=/usr/bin/true \
UDEVADMPATH=/usr/bin/true \
UDEV_CFLAGS=-I/usr/include \
UDEV_LIBS=-lc \
make -C "$BUILD" install \
  CFLAGS='-g -O2 -std=gnu89 -Wno-deprecated-declarations' \
  LIBS=-liconv \
  udevrulesdir="$PREFIX/share/synce-core/rules.d"
echo "PocketJS Meizu M8: SynCE RAPI tools -> $PREFIX/bin"
