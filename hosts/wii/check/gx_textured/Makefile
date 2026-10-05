DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
HOSTCC ?= cc
WORK ?= /tmp/pocketjs-wii-gx-textured-check
NATIVE := $(WORK)/gx-textured-native

ifneq ($(filter wii,$(MAKECMDGOALS)),)
include $(DEVKITPPC)/wii_rules
WII_WORK ?= $(WORK)-wii
ELF := $(WII_WORK)/gx-textured.elf
DOL := $(WII_WORK)/gx-textured.dol
CFLAGS := -std=gnu11 -O2 -Wall -Wextra -Werror $(MACHDEP) -I$(LIBOGC_INC) -I../../src -ffunction-sections -fdata-sections
LDFLAGS := -Wl,--gc-sections -Wl,--no-undefined
LIBS := -lc -logc -lm
endif

.PHONY: all check-native wii clean
all: check-native

$(WORK):
	mkdir -p $@

$(NATIVE): check.c mock_gx.c ../../src/drawlist.h ../../src/gx_solid.h ../../src/gx_textured.c ../../src/gx_textured.h ../../src/gx_texture.c ../../src/gx_texture.h ../../src/texture_source.c ../../src/texture_source.h | $(WORK)
	$(HOSTCC) -std=gnu11 -O2 -Wall -Wextra -Werror -Imock -I../../src check.c mock_gx.c ../../src/gx_textured.c ../../src/gx_texture.c ../../src/texture_source.c -o $@

check-native: $(NATIVE)
	$<

wii: $(DOL)

$(WII_WORK):
	mkdir -p $@

$(ELF): probe.c ../../src/gx_solid.h ../../src/gx_textured.c ../../src/gx_textured.h ../../src/gx_texture.c ../../src/gx_texture.h ../../src/texture_source.c ../../src/texture_source.h | $(WII_WORK)
	$(CC) $(CFLAGS) $(LDFLAGS) probe.c ../../src/gx_textured.c ../../src/gx_texture.c ../../src/texture_source.c -L$(LIBOGC_LIB) $(LIBS) -o $@

$(DOL): $(ELF)
	elf2dol $< $@

clean:
	rm -rf $(WORK) $(WORK)-wii
