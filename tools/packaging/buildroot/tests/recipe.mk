# Integration harness: execute Buildroot's real cargo-package build macro and
# our install macros against a prepared source tree. It does not build firmware
# or replace validation of Buildroot's external cross toolchain/sysroot.
qstrip = $(strip $(subst ",,$(1)))
UPPERCASE = $(shell echo $(1) | tr 'a-z-' 'A-Z_')
pkgname = pocketjs
inner-generic-package =
include $(BUILDROOT_SOURCE)/package/pkg-cargo.mk
BR2_PACKAGE_POCKETJS = y
BR2_PACKAGE_POCKETJS_PROGRAM = pocket-linux-kms
BR2_PACKAGE_POCKETJS_ALSA = y
BR2_ENABLE_DEBUG = y
PKG = POCKETJS
HOST_DIR = /usr
TARGET_CROSS = aarch64-linux-gnu-
RUSTC_TARGET_NAME = aarch64-unknown-linux-gnu
POCKETJS_SRCDIR = $(SOURCE)/programs/linux-kms
TARGET_MAKE_ENV = CARGO_TARGET_DIR=$(SOURCE)/target
INSTALL = install
include $(BR2_EXTERNAL_POCKETJS_PATH)/package/pocketjs/pocketjs.mk
# The app package's generic macro is independent of the cargo-package macro.
generic-package =
include $(BR2_EXTERNAL_POCKETJS_PATH)/package/pocketjs-app/pocketjs-app.mk
.PHONY: all
all: $(SOURCE)/.recipe-smoke
$(SOURCE)/.recipe-smoke:
	$(POCKETJS_CHECK_INPUTS)
	$(POCKETJS_BUILD_CMDS)
	$(POCKETJS_INSTALL_TARGET_CMDS)
	$(POCKETJS_APP_INSTALL_TARGET_CMDS)
	$(POCKETJS_INSTALL_INIT_SYSV)
	$(TARGET_DIR)/usr/bin/pocket-linux-kms --headless --frames 3 --package $(TARGET_DIR)/usr/share/pocketjs/app.pocket
	$(TARGET_DIR)/usr/bin/pocket-linux-kms --pcm-test null
