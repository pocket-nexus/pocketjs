DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM
CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
ROOT ?= /repo
BACKEND := $(ROOT)/engine/pocket3d/backends/citro3d
BUILD := $(ROOT)/dist/pocket3d-citro3d
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft
CFLAGS := $(ARCH) -O2 -Wall -Wextra -Werror -std=gnu11 -mword-relocations -ffunction-sections -fdata-sections -D__3DS__ -I$(DEVKITPRO)/libctru/include -I$(BACKEND) -I$(BUILD)
ifeq ($(CAPTURE),1)
CFLAGS += -DP3D_CAPTURE
endif
OBJECTS := $(BUILD)/main.o $(BUILD)/pocket3d.o $(BUILD)/color_shbin.o $(BUILD)/skin_shbin.o
all: $(BUILD)/rigid-skin.3dsx
$(BUILD):
	mkdir -p $@
$(BUILD)/%.shbin: $(BACKEND)/%.v.pica | $(BUILD)
	$(DEVKITPRO)/tools/bin/picasso -o $@ $<
$(BUILD)/%_shbin.s $(BUILD)/%_shbin.h &: $(BUILD)/%.shbin
	cd $(BUILD) && $(DEVKITPRO)/tools/bin/bin2s -a 4 -H $*_shbin.h $*.shbin > $*_shbin.s
$(BUILD)/%_shbin.o: $(BUILD)/%_shbin.s
	$(CC) $(ARCH) -c $< -o $@
$(BUILD)/main.o: $(BACKEND)/example/main.c $(BACKEND)/pocket3d.h $(BUILD)/color_shbin.h $(BUILD)/skin_shbin.h FORCE
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/pocket3d.o: $(BACKEND)/pocket3d.c $(BACKEND)/pocket3d.h | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/rigid-skin.elf: $(OBJECTS)
	$(CC) -specs=3dsx.specs $(ARCH) -Wl,--gc-sections $^ -L$(DEVKITPRO)/libctru/lib -lcitro2d -lcitro3d -lctru -lm -o $@
$(BUILD)/rigid-skin.3dsx: $(BUILD)/rigid-skin.elf
	$(DEVKITPRO)/tools/bin/3dsxtool $< $@
.PHONY: all FORCE
FORCE:
