DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
HOSTCC ?= cc
WORK ?= /tmp/pocketjs-wii-gx-font-check
NATIVE := $(WORK)/gx-font-native

ifneq ($(filter wii,$(MAKECMDGOALS)),)
include $(DEVKITPPC)/wii_rules
WII_WORK ?= $(WORK)-wii
ELF := $(WII_WORK)/gx-font.elf
DOL := $(WII_WORK)/gx-font.dol
CFLAGS := -std=gnu11 -O2 -Wall -Wextra -Werror $(MACHDEP) -I$(LIBOGC_INC) -I../../src -ffunction-sections -fdata-sections
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined
LIBS := -logc -lm
endif

.PHONY: all check-native wii clean
all: check-native

$(WORK):
	mkdir -p $@

$(NATIVE): check.c ../../src/gx_font.c ../../src/gx_font.h ../../src/drawlist.h ../../src/gx_solid.h | $(WORK)
	$(HOSTCC) -std=gnu11 -O2 -Wall -Wextra -Werror -DPOCKET_WII_GX_FONT_MOCK -Imock -I../../src check.c ../../src/gx_font.c -o $@

check-native: $(NATIVE)
	$<

wii: $(DOL)

$(WII_WORK):
	mkdir -p $@

$(ELF): probe.c ../../src/gx_font.c ../../src/gx_font.h ../../src/drawlist.h ../../src/gx_solid.h | $(WII_WORK)
	$(CC) $(CFLAGS) $(LDFLAGS) probe.c ../../src/gx_font.c -L$(LIBOGC_LIB) -lc $(LIBS) -o $@

$(DOL): $(ELF)
	$(DEVKITPRO)/tools/bin/elf2dol $< $@

clean:
	rm -rf $(WORK) $(WORK)-wii
