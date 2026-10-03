DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
HOSTCC ?= cc
include $(DEVKITPPC)/wii_rules

ROOT := $(abspath ../../..)
DIST := $(ROOT)/dist/wii
POCKET_WII_ARCHIVE := $(DIST)/libpocketjs_wii.a
QUICKJS_ARCHIVE := $(DIST)/quickjs/libquickjs.a
RUST_ARCHIVE := $(DIST)/core/powerpc-gekko-eabi/release/libpocketjs_wii_core.a
POCKET_WII_HEADER := $(DIST)/pocket_wii.h
GUEST_PACKAGE ?= $(DIST)/guest/hero-main.pocket
BUILD ?= $(CURDIR)/build

ELF := $(BUILD)/boot.elf
DOL := $(BUILD)/boot.dol
PACKAGE_HEADER := $(BUILD)/hero_package.h
OBJECT := $(BUILD)/main.o
INPUT_OBJECT := $(BUILD)/input.o
LIBS := -lfat -lwiiuse -lbte -logc -lm
CFLAGS := -O2 -std=gnu11 -Wall -Wextra $(MACHDEP) -I$(DIST) -I$(BUILD) -I$(LIBOGC_INC) \
  -ffunction-sections -fdata-sections
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined \
  -Wl,-u,memset -Wl,-u,memcpy -Wl,-Map,$(BUILD)/boot.map

.PHONY: all check check-schedule clean
all: $(DOL)

check: check-schedule

check-schedule: | $(BUILD)
	$(HOSTCC) -std=gnu11 -Wall -Wextra -Werror -DPOCKET_WII_SCHEDULE_CHECK main.c -o $(BUILD)/schedule-check
	$(BUILD)/schedule-check

$(BUILD):
	mkdir -p $@

$(PACKAGE_HEADER): $(GUEST_PACKAGE) | $(BUILD)
	xxd -i -n hero_main_pocket $< > $@

$(OBJECT): main.c $(POCKET_WII_HEADER) $(PACKAGE_HEADER) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(INPUT_OBJECT): input.c input.h input_map.h $(POCKET_WII_HEADER) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(ELF): $(OBJECT) $(INPUT_OBJECT)
	test -s $(POCKET_WII_ARCHIVE) -a -s $(QUICKJS_ARCHIVE) -a -s $(RUST_ARCHIVE)
	$(CC) $(LDFLAGS) $(OBJECT) $(INPUT_OBJECT) -L$(LIBOGC_LIB) -lc $(POCKET_WII_ARCHIVE) \
	  $(QUICKJS_ARCHIVE) $(RUST_ARCHIVE) $(LIBS) -o $@

$(DOL): $(ELF)
	$(DEVKITPRO)/tools/bin/elf2dol $< $@

clean:
	rm -rf $(BUILD)
