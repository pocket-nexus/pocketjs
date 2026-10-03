DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
include $(DEVKITPPC)/wii_rules

DIST := $(abspath ../../dist/wii)
CORE_TARGET_DIR := $(DIST)/core
CORE_ARCHIVE := $(CORE_TARGET_DIR)/powerpc-gekko-eabi/release/libpocketjs_wii_core.a
QUICKJS_ARCHIVE := ../../../dist/wii/quickjs/libquickjs.a
BRIDGE_ARCHIVE := $(DIST)/libpocketjs_wii.a
PUBLIC_HEADER := $(DIST)/pocket_wii.h
LIBRARY_WORK ?= /tmp/pocketjs-wii-library

.PHONY: all library rust-library quickjs-library
all: library

library: rust-library quickjs-library $(PUBLIC_HEADER)
	$(MAKE) -C src wii-library WORK=$(LIBRARY_WORK) WII_LIBRARY_ARCHIVE=$(BRIDGE_ARCHIVE) \
		DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC)

rust-library:
	cd core && PATH=$(DEVKITPPC)/bin:$(DEVKITPRO)/tools/bin:$$PATH \
		DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC) \
		cargo build --manifest-path Cargo.toml --target-dir $(CORE_TARGET_DIR) \
		--release --locked -Z json-target-spec
	test -f $(CORE_ARCHIVE)

quickjs-library:
	$(MAKE) -C quickjs $(QUICKJS_ARCHIVE) DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC)

$(PUBLIC_HEADER): include/pocket_wii.h
	mkdir -p $(DIST)
	cp $< $@
