# Link the MicroTS ARM9 staticlib and package a bootable NDS ROM. The caller
# builds Rust for armv5te-none-eabi with target-cpu=arm946e-s and supplies paths.
DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM
BUILD := $(POCKETJS_BUILD_DIR)
OUT := $(POCKETJS_OUT_NDS)
CORE := $(POCKETJS_CORE_LIB)

ifeq ($(strip $(BUILD)),)
$(error POCKETJS_BUILD_DIR must name a build directory)
endif
ifeq ($(strip $(OUT)),)
$(error POCKETJS_OUT_NDS must name the output ROM)
endif
ifeq ($(strip $(CORE)),)
$(error POCKETJS_CORE_LIB must name libpocketjs_nds_core.a)
endif

CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
NM := $(DEVKITARM)/bin/arm-none-eabi-nm
SIZE := $(DEVKITARM)/bin/arm-none-eabi-size
NDSTOOL := $(DEVKITPRO)/tools/bin/ndstool
ARCH := -march=armv5te -mtune=arm946e-s -mthumb -mfloat-abi=soft
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -ffunction-sections -fdata-sections \
  -DARM9 -D__NDS__ \
  -I$(CURDIR)/include -I$(DEVKITPRO)/libnds/include
LIBPATHS := -L$(DEVKITPRO)/libnds/lib
LIBS := -lnds9 -lm

# libnds 2.x uses Calico; 1.x carries ds_arm9.specs and the default ARM7 image.
ifneq ($(wildcard $(DEVKITPRO)/calico/share/ds9.specs),)
SPECS := $(DEVKITPRO)/calico/share/ds9.specs
ARM7 := $(DEVKITPRO)/calico/bin/ds7_maine.elf
CFLAGS += -I$(DEVKITPRO)/calico/include
LIBPATHS += -L$(DEVKITPRO)/calico/lib
LIBS += -lcalico_ds9
else
SPECS := ds_arm9.specs
ARM7 := $(DEVKITPRO)/libnds/default.elf
endif

ELF := $(BUILD)/pocketjs-nds.elf
LDFLAGS := $(ARCH) -specs=$(SPECS) -Wl,--gc-sections -Wl,-Map,$(BUILD)/pocketjs-nds.map

.PHONY: all clean force
all: $(OUT)

$(BUILD):
	mkdir -p "$@"

# Changed compiler flags must invalidate the C object too.
$(BUILD)/flags: force | $(BUILD)
	@printf '%s\n' '$(CFLAGS)' '$(LDFLAGS)' > "$@.new"
	@cmp -s "$@.new" "$@" || mv "$@.new" "$@"
	@rm -f "$@.new"

$(BUILD)/main.o: src/main.c include/pocket_nds.h include/pocket_nds_present.h $(BUILD)/flags | $(BUILD)
	$(CC) $(CFLAGS) -c "$<" -o "$@"

$(ELF): $(BUILD)/main.o $(CORE)
	$(CC) $(LDFLAGS) $(LIBPATHS) $(BUILD)/main.o $(CORE) $(LIBS) -o "$@"
	$(NM) -n "$@" > "$(BUILD)/pocketjs-nds.sym"
	$(SIZE) "$@"

$(OUT): $(ELF) $(ARM7)
	mkdir -p "$(dir $(OUT))"
	$(NDSTOOL) -c "$@" -9 "$(ELF)" -7 "$(ARM7)"

clean:
	rm -rf "$(BUILD)" "$(OUT)"
