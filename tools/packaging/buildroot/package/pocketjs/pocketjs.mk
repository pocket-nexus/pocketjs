################################################################################
# PocketJS: the prepared source.mk and .hash bind a release revision and its
# vendored archive. Neither an application compiler nor Bun runs on the target.
################################################################################
ifeq ($(BR2_PACKAGE_POCKETJS),y)
ifeq ($(wildcard $(BR2_EXTERNAL_POCKETJS_PATH)/package/pocketjs/source.mk),)
$(error Prepare the PocketJS external tree with tools/packaging/buildroot/prepare.py)
endif
include $(BR2_EXTERNAL_POCKETJS_PATH)/package/pocketjs/source.mk
endif
POCKETJS_LICENSE = MIT
POCKETJS_LICENSE_FILES = LICENSE
POCKETJS_SUBDIR = programs/linux-kms
POCKETJS_PROGRAM = $(call qstrip,$(BR2_PACKAGE_POCKETJS_PROGRAM))
POCKETJS_CARGO_BUILD_OPTS = --package $(POCKETJS_PROGRAM)
ifeq ($(BR2_PACKAGE_POCKETJS_ALSA),y)
POCKETJS_DEPENDENCIES += alsa-lib
POCKETJS_CARGO_BUILD_OPTS += --features alsa
endif
POCKETJS_DEPENDENCIES += host-python3
# The directory `pocket profile export --out` wrote: pocket-profile.json is
# checked before the build and pocket_profile.rs is compiled into the program
# by its build.rs (pocket_profile_build::emit reads POCKETJS_PROFILE_RS).
POCKETJS_PROFILE_DIR = $(call qstrip,$(BR2_PACKAGE_POCKETJS_PROFILE))
POCKETJS_CARGO_ENV = POCKETJS_PROFILE_RS=$(POCKETJS_PROFILE_DIR)/pocket_profile.rs

# Buildroot's cargo-package sets offline/locked mode and the cross linker.
define POCKETJS_CHECK_INPUTS
	$(HOST_DIR)/bin/python3 $(BR2_EXTERNAL_POCKETJS_PATH)/validate_profile.py "$(POCKETJS_PROFILE_DIR)/pocket-profile.json" $(POCKETJS_BINDING_GENERATION)
endef
POCKETJS_PRE_BUILD_HOOKS += POCKETJS_CHECK_INPUTS

define POCKETJS_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/target/$(RUSTC_TARGET_NAME)/$(if $(BR2_ENABLE_DEBUG),debug,release)/$(POCKETJS_PROGRAM) $(TARGET_DIR)/usr/bin/pocket-linux-kms
endef

define POCKETJS_INSTALL_INIT_SYSV
	$(INSTALL) -D -m 0755 $(BR2_EXTERNAL_POCKETJS_PATH)/package/pocketjs/S90pocketjs $(TARGET_DIR)/etc/init.d/S90pocketjs
endef
$(eval $(cargo-package))
