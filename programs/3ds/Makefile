# Minimal program: default Runtime archive, canonical guest, PICA and HID.
# Product camera/Link/launcher/recovery sources are not build inputs.
DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM
POCKETJS_ROOT ?= $(CURDIR)/../..
PLATFORM := $(POCKETJS_ROOT)/platforms/3ds
PICA := $(POCKETJS_ROOT)/devices/3ds/pocket-3ds-pica
GUEST := $(POCKETJS_ROOT)/engine/guest-quickjs
CONTRACTS := $(POCKETJS_ROOT)/contracts/generated
BUILD := $(POCKETJS_BUILD_DIR)
ELF := $(BUILD)/pocketjs-3ds.elf
SMDH := $(BUILD)/pocketjs-3ds.smdh
OUT := $(POCKETJS_OUT_3DSX)
ICON ?= $(CURDIR)/icon.png
SMALL_ICON ?= $(CURDIR)/icon-small.png
CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft
CFLAGS := -Wall -Wextra -Werror -O2 -g -std=gnu11 -mword-relocations -ffunction-sections -fdata-sections $(ARCH) -D__3DS__ -DJS_NO_NAN_BOXING -DPOCKET_QJS_BELLARD \
  -I$(BUILD) -I$(CONTRACTS) -I$(PLATFORM) -I$(PICA)/include -I$(GUEST)/include -isystem $(POCKETJS_QUICKJS_DIR) -isystem $(DEVKITPRO)/libctru/include
LDFLAGS := -specs=3dsx.specs $(ARCH) -Wl,--gc-sections -Wl,-Map,$(BUILD)/pocketjs-3ds.map
OBJECTS := $(addprefix $(BUILD)/,main.o package_source.o hooks.o input.o input_source.o pica_driver.o canonical_guest.o vshader_shbin.o)
FLAGS_STAMP := $(BUILD)/cflags.stamp
.PHONY: $(FLAGS_STAMP).probe
$(FLAGS_STAMP).probe: | $(BUILD)
	@printf '%s\n' "$(CFLAGS)" "$(LDFLAGS)" > $(FLAGS_STAMP).new
	@cmp -s $(FLAGS_STAMP).new $(FLAGS_STAMP) || mv $(FLAGS_STAMP).new $(FLAGS_STAMP)
	@rm -f $(FLAGS_STAMP).new
$(FLAGS_STAMP): $(FLAGS_STAMP).probe ;

.DEFAULT_GOAL := all
.PHONY: all
all: $(OUT)
$(BUILD):
	mkdir -p $@
$(BUILD)/vshader.shbin: $(PICA)/src/vshader.v.pica | $(BUILD)
	$(DEVKITPRO)/tools/bin/picasso -o $@ $<
$(BUILD)/vshader_shbin.s $(BUILD)/vshader_shbin.h &: $(BUILD)/vshader.shbin
	cd $(BUILD) && $(DEVKITPRO)/tools/bin/bin2s -a 4 -H vshader_shbin.h vshader.shbin > vshader_shbin.s
$(BUILD)/vshader_shbin.o: $(BUILD)/vshader_shbin.s $(FLAGS_STAMP)
	$(CC) $(ARCH) -c $< -o $@
$(BUILD)/%.o: $(CURDIR)/%.c $(wildcard $(CURDIR)/*.h) $(wildcard $(CONTRACTS)/*.h) $(BUILD)/pocket_profile.h $(BUILD)/vshader_shbin.h $(FLAGS_STAMP) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/%.o: $(PLATFORM)/%.c $(wildcard $(PLATFORM)/*.h) $(wildcard $(CONTRACTS)/*.h) $(FLAGS_STAMP) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/pica_driver.o: $(PICA)/src/driver.c $(wildcard $(PICA)/include/*.h) $(wildcard $(CONTRACTS)/*.h) $(FLAGS_STAMP) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/canonical_guest.o: $(GUEST)/src/guest.c $(wildcard $(GUEST)/src/*.h) $(wildcard $(GUEST)/include/*.h) $(wildcard $(CONTRACTS)/*.h) $(FLAGS_STAMP) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(ELF): $(OBJECTS) $(POCKETJS_RUNTIME_LIB) $(POCKETJS_QUICKJS_DIR)/libquickjs.a
	$(CC) $(LDFLAGS) $(OBJECTS) $(POCKETJS_RUNTIME_LIB) $(POCKETJS_QUICKJS_DIR)/libquickjs.a -L$(DEVKITPRO)/libctru/lib -lcitro3d -lctru -lm -o $@
$(SMDH): $(ICON) $(SMALL_ICON) | $(BUILD)
	$(DEVKITPRO)/tools/bin/smdhtool --create "PocketJS Runtime" "File-loaded PocketJS program" "PocketJS" $(ICON) $@ $(SMALL_ICON)
$(OUT): $(ELF) $(SMDH)
	mkdir -p $(dir $(OUT))
	$(DEVKITPRO)/tools/bin/3dsxtool $(ELF) $@ --smdh=$(SMDH)
