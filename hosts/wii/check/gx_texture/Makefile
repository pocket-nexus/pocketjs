DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
HOSTCC ?= cc
WORK ?= /tmp/pocketjs-wii-gx-texture-check
NATIVE := $(WORK)/gx-texture-native

ifneq ($(filter wii,$(MAKECMDGOALS)),)
include $(DEVKITPPC)/wii_rules
WII_WORK ?= $(WORK)-wii
ELF := $(WII_WORK)/gx-texture.elf
DOL := $(WII_WORK)/gx-texture.dol
CFLAGS := -std=gnu11 -O2 -Wall -Wextra -Werror $(MACHDEP) -I$(LIBOGC_INC) -I../../src -ffunction-sections -fdata-sections
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined
LIBS := -lwiiuse -lbte -logc -lm
endif

.PHONY: all check-native wii clean
all: check-native

$(WORK):
	mkdir -p $@

$(NATIVE): check.c native_check.c ../../src/gx_texture.c ../../src/gx_texture.h ../../src/texture_source.c ../../src/texture_source.h | $(WORK)
	$(HOSTCC) -std=gnu11 -O2 -Wall -Wextra -Werror -DPOCKET_WII_GX_TEXTURE_MOCK -Imock -I../../src check.c native_check.c ../../src/gx_texture.c ../../src/texture_source.c -o $@

check-native: $(NATIVE)
	$<

wii: $(DOL)

$(WII_WORK):
	mkdir -p $@

$(ELF): check.c ../../src/gx_texture.c ../../src/gx_texture.h ../../src/texture_source.c ../../src/texture_source.h | $(WII_WORK)
	$(CC) $(CFLAGS) $(LDFLAGS) check.c ../../src/gx_texture.c ../../src/texture_source.c -L$(LIBOGC_LIB) -lc $(LIBS) -o $@

$(DOL): $(ELF)
	elf2dol $< $@

clean:
	rm -rf $(WORK) $(WORK)-wii
