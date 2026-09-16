# PocketJS Nintendo 3DS host — run INSIDE the devkitpro/devkitarm container.
#
# tools/3ds.ts builds the Rust staticlib and QuickJS on macOS, then invokes
# this with CWD hosts/3ds and every path already translated to a container
# path. All inputs arrive as ENVIRONMENT variables, so the recipes below only
# ever read them:
#
#   POCKETJS_TARGET          target id to publish as ui.__host
#   POCKETJS_HOST_ABI        ABI number to publish as ui.__hostAbi
#   POCKETJS_LOGICAL_WIDTH   guest viewport, baked into the host
#   POCKETJS_LOGICAL_HEIGHT
#   POCKETJS_AUX_LOGICAL_WIDTH
#   POCKETJS_AUX_LOGICAL_HEIGHT
#   POCKETJS_AUX_PHYSICAL_WIDTH
#   POCKETJS_AUX_PHYSICAL_HEIGHT
#   POCKETJS_AUX_PRESENTATION
#   POCKETJS_AUX_RASTER_DENSITY
#   POCKETJS_RASTER_DENSITY  raster samples per logical pixel
#   POCKETJS_CORE_LIB        libpocketjs_3ds_core.a
#   POCKETJS_QUICKJS_DIR     directory holding quickjs.h and libquickjs.a
#   POCKETJS_APP_POCKET      target-thinned guest package to embed as recovery
#   POCKETJS_RUNTIME_SLOT    app-id-derived state directory below runtime/apps
#   POCKETJS_BUILD_DIR       scratch for objects, the .shbin, the .elf, romfs
#   POCKETJS_OUT_3DSX        the .3dsx to write
#   POCKETJS_SMDH_TITLE      SMDH metadata
#   POCKETJS_SMDH_AUTHOR
#   POCKETJS_SMDH_DESC
#   POCKETJS_CAPTURE         "1" builds the deterministic e2e binary
#   POCKETJS_CAPTURE_INPUT   baked input tape, "frame:mask,frame:mask"
#   POCKETJS_CAPTURE_TOUCH   baked touch tape, "frame:id,x,y@frame:-"
#   POCKETJS_CAP_START       first frame to dump
#   POCKETJS_CAP_N           how many frames to dump
#   POCKETJS_OUT_CIA         the .cia to write; empty leaves the goal off
#   POCKETJS_MAKEROM         the makerom binary tools/3ds.ts built and cached
#   POCKETJS_CIA_TITLE       exheader process name (8 bytes)
#   POCKETJS_CIA_PRODUCT     CTR-P-XXXX product code
#   POCKETJS_CIA_UNIQUE_ID   title id unique part, e.g. 0xFF3D0
#
# The tape and the capture window travel INSIDE the binary: a capture run never
# reads the emulator's filesystem for its input. Nothing is written outside
# POCKETJS_BUILD_DIR, POCKETJS_OUT_3DSX and POCKETJS_OUT_CIA.

DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM

SOURCE := $(CURDIR)/src
INCLUDE_DIR := $(CURDIR)/include
BUILD := $(POCKETJS_BUILD_DIR)
OUT := $(POCKETJS_OUT_3DSX)
# 3dsxtool reads the recovery guest out of a RomFS directory.
ROMFS := $(BUILD)/romfs
ICON ?= $(CURDIR)/icon.png
# Custom large icons keep smdhtool's automatic reduction unless their caller
# also supplies SMALL_ICON. The host default has a separate optical drawing.
SMALL_ICON ?= $(if $(filter $(CURDIR)/icon.png,$(ICON)),$(CURDIR)/icon-small.png,)
CIA := $(POCKETJS_OUT_CIA)
RSF := $(CURDIR)/app.rsf

CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
PICASSO := $(DEVKITPRO)/tools/bin/picasso
BIN2S := $(DEVKITPRO)/tools/bin/bin2s
SMDHTOOL := $(DEVKITPRO)/tools/bin/smdhtool
THREEDSXTOOL := $(DEVKITPRO)/tools/bin/3dsxtool

# The ARM11 in both console revisions: ARMv6K, MPCore tuning, hardware float,
# and the soft thread pointer libctru is built against. -mword-relocations is
# what keeps the 3dsx loader's relocation table expressible.
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft

# JS_NO_NAN_BOXING is not optional and not cosmetic: quickjs.h turns NaN boxing
# ON by default for any 32-bit target, which makes JSValue 8 bytes instead of
# 16. libquickjs.a is built with it defined (the Vita treatment in
# libquickjs-sys/build.rs), so a translation unit that includes quickjs.h
# without it links cleanly and then hands the library differently shaped
# values — the guest boots and QuickJS's GC walks garbage pointers.
CFLAGS := -Wall -Wextra -O2 -g -std=gnu11 -mword-relocations -ffunction-sections -fdata-sections \
  $(ARCH) -D__3DS__ -DJS_NO_NAN_BOXING \
  -DPOCKETJS_TARGET_ID='"$(POCKETJS_TARGET)"' \
  -DPOCKETJS_RUNTIME_SLOT='"$(POCKETJS_RUNTIME_SLOT)"' \
  -DPOCKETJS_HOST_ABI=$(POCKETJS_HOST_ABI) \
  -DPOCKETJS_VIEW_W=$(POCKETJS_LOGICAL_WIDTH) \
  -DPOCKETJS_VIEW_H=$(POCKETJS_LOGICAL_HEIGHT) \
  -DPOCKETJS_AUX_VIEW_W=$(POCKETJS_AUX_LOGICAL_WIDTH) \
  -DPOCKETJS_AUX_VIEW_H=$(POCKETJS_AUX_LOGICAL_HEIGHT) \
  -DPOCKETJS_RASTER_DENSITY=$(POCKETJS_RASTER_DENSITY) \
  -I$(INCLUDE_DIR) -I$(BUILD) -I$(POCKETJS_QUICKJS_DIR) \
  -I$(DEVKITPRO)/libctru/include

ifeq ($(POCKETJS_OFFLOAD),1)
CFLAGS += -DPOCKETJS_OFFLOAD -DPOCKETJS_OFFLOAD_KEY='"sdmc:/pocketjs/offload/$(POCKETJS_OFFLOAD_SLOT).key"'
endif

ifeq ($(POCKETJS_MEDIA),1)
CFLAGS += -DPOCKETJS_MEDIA
endif

ifeq ($(POCKETJS_CAPTURE),1)
CFLAGS += -DPOCKETJS_CAPTURE \
  -DPOCKETJS_CAPTURE_INPUT='"$(POCKETJS_CAPTURE_INPUT)"' \
  -DPOCKETJS_CAPTURE_TOUCH='"$(POCKETJS_CAPTURE_TOUCH)"' \
  -DPOCKETJS_CAP_START=$(POCKETJS_CAP_START) \
  -DPOCKETJS_CAP_N=$(POCKETJS_CAP_N)
endif

LDFLAGS := -specs=3dsx.specs $(ARCH) -Wl,--gc-sections -Wl,-Map,$(BUILD)/pocketjs-3ds.map
LIBPATHS := -L$(DEVKITPRO)/libctru/lib
LIBS := -lcitro3d -lctru -lm

OBJECTS := $(BUILD)/main.o $(BUILD)/media.o $(BUILD)/offload.o $(BUILD)/soc.o $(BUILD)/svcwire.o $(BUILD)/runtime.o $(BUILD)/dev_protocol.o $(BUILD)/devserver.o $(BUILD)/devmenu.o $(BUILD)/gfx.o $(BUILD)/qjs.o $(BUILD)/input.o $(BUILD)/vshader_shbin.o
ELF := $(BUILD)/pocketjs-3ds.elf
SMDH := $(BUILD)/pocketjs-3ds.smdh

.PHONY: all clean
all: $(OUT)
ifneq ($(CIA),)
all: $(CIA)
endif

$(BUILD) $(ROMFS):
	mkdir -p $@

# The PICA200 vertex shader is assembled and linked in as data; there is no
# fragment shader on this GPU (gfx.c drives TEV stages instead).
$(BUILD)/vshader.shbin: $(SOURCE)/vshader.v.pica | $(BUILD)
	$(PICASSO) -o $@ $<

# bin2s writes both files in one invocation. `&:` tells parallel make they are
# one grouped output; an ordinary multi-target rule can run this recipe twice
# concurrently and race while truncating the same .s/.h files.
$(BUILD)/vshader_shbin.s $(BUILD)/vshader_shbin.h &: $(BUILD)/vshader.shbin
	cd $(BUILD) && $(BIN2S) -a 4 -H vshader_shbin.h vshader.shbin > vshader_shbin.s

$(BUILD)/vshader_shbin.o: $(BUILD)/vshader_shbin.s
	$(CC) $(ARCH) -c $< -o $@

# The capture window, the input tape and the viewport reach the C sources as -D
# defines, so a rebuild driven by source mtimes alone would keep a previous
# run's values — a stale tape or a short capture window produces a plausible
# .3dsx that dumps the wrong frames. Objects therefore depend on a stamp
# carrying the flags themselves, rewritten only when they actually change (the
# make-side counterpart of cargo:rerun-if-env-changed).
FLAGS_STAMP := $(BUILD)/cflags.stamp
.PHONY: $(FLAGS_STAMP).probe
$(FLAGS_STAMP).probe: | $(BUILD)
	@printf '%s\n' "$(CFLAGS)" > $(FLAGS_STAMP).new
	@cmp -s $(FLAGS_STAMP).new $(FLAGS_STAMP) || mv $(FLAGS_STAMP).new $(FLAGS_STAMP)
	@rm -f $(FLAGS_STAMP).new
$(FLAGS_STAMP): $(FLAGS_STAMP).probe ;

$(BUILD)/%.o: $(SOURCE)/%.c $(BUILD)/vshader_shbin.h $(FLAGS_STAMP) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/offload.o: $(SOURCE)/offload.h $(SOURCE)/offload_queue.h
$(BUILD)/qjs.o: $(SOURCE)/offload.h $(SOURCE)/offload_coverage.h
$(BUILD)/media.o: $(SOURCE)/media.h $(SOURCE)/media_wire.h $(SOURCE)/media_adpcm.h
$(BUILD)/main.o $(BUILD)/qjs.o $(BUILD)/gfx.o: $(SOURCE)/media.h

$(ELF): $(OBJECTS) $(POCKETJS_CORE_LIB) $(POCKETJS_QUICKJS_DIR)/libquickjs.a
	$(CC) $(LDFLAGS) $(OBJECTS) $(POCKETJS_CORE_LIB) $(POCKETJS_QUICKJS_DIR)/libquickjs.a \
	  $(LIBPATHS) $(LIBS) -o $@

# A prerequisite's pathname is not part of make's freshness model. Check the
# bytes on every invocation so --skip-build or a replaced plan cannot reuse a
# newer staging file that came from another artifact path; preserve the mtime
# when content is unchanged so packaging remains incremental.
.PHONY: romfs-inputs
romfs-inputs:

ROMFS_LAYOUT_STAMP := $(BUILD)/romfs-layout.stamp
.PHONY: $(ROMFS_LAYOUT_STAMP).probe
$(ROMFS_LAYOUT_STAMP).probe: | $(BUILD) $(ROMFS)
	@changed=0; \
	for stale in $(ROMFS)/app.js $(ROMFS)/app.pak; do \
	  if test -e "$$stale"; then rm -f "$$stale"; changed=1; fi; \
	done; \
	if test $$changed -eq 1 || test ! -e $(ROMFS_LAYOUT_STAMP); then touch $(ROMFS_LAYOUT_STAMP); fi
$(ROMFS_LAYOUT_STAMP): $(ROMFS_LAYOUT_STAMP).probe ;

$(ROMFS)/app.pocket: $(POCKETJS_APP_POCKET) romfs-inputs $(ROMFS_LAYOUT_STAMP) | $(ROMFS)
	@cp "$<" "$@.new"
	@cmp -s "$@.new" "$@" || mv "$@.new" "$@"
	@rm -f "$@.new"

# 3dsxtool refuses to embed a RomFS without SMDH metadata, so one is always
# built, from the app's own strings over the host's icon. The strings affect
# the artifact but are not files, so a content stamp invalidates the SMDH when
# a manifest title/id changes. Recipes expand the environment in the shell,
# inside quotes: manifest text never becomes shell syntax through make.
SMDH_STAMP := $(BUILD)/smdh.stamp
.PHONY: $(SMDH_STAMP).probe
$(SMDH_STAMP).probe: | $(BUILD)
	@printf '%s\n%s\n%s\n' "$$POCKETJS_SMDH_TITLE" "$$POCKETJS_SMDH_DESC" \
	  "$$POCKETJS_SMDH_AUTHOR" > $(SMDH_STAMP).new
	@cmp -s $(SMDH_STAMP).new $(SMDH_STAMP) || mv $(SMDH_STAMP).new $(SMDH_STAMP)
	@rm -f $(SMDH_STAMP).new
$(SMDH_STAMP): $(SMDH_STAMP).probe ;

$(SMDH): $(ICON) $(SMALL_ICON) $(SMDH_STAMP) | $(BUILD)
	$(SMDHTOOL) --create "$$POCKETJS_SMDH_TITLE" "$$POCKETJS_SMDH_DESC" \
	  "$$POCKETJS_SMDH_AUTHOR" $(ICON) $@ $(SMALL_ICON)

$(OUT): $(ELF) $(SMDH) $(ROMFS)/app.pocket $(ROMFS_LAYOUT_STAMP)
	mkdir -p $(dir $(OUT))
	$(THREEDSXTOOL) $(ELF) $@ --romfs=$(ROMFS) --smdh=$(SMDH)

ifneq ($(CIA),)
# The CIA's identity arrives as -D substitutions, not in a file, and make cannot
# see a changed environment variable — the same trap FLAGS_STAMP covers for
# CFLAGS. A stamp carrying the three values makes a renamed or re-issued title
# rebuild the .cia.
CIA_ARGS := $(POCKETJS_CIA_TITLE) $(POCKETJS_CIA_PRODUCT) $(POCKETJS_CIA_UNIQUE_ID)
CIA_STAMP := $(BUILD)/cia.stamp
.PHONY: $(CIA_STAMP).probe
$(CIA_STAMP).probe: | $(BUILD)
	@printf '%s\n' "$(CIA_ARGS)" > $(CIA_STAMP).new
	@cmp -s $(CIA_STAMP).new $(CIA_STAMP) || mv $(CIA_STAMP).new $(CIA_STAMP)
	@rm -f $(CIA_STAMP).new
$(CIA_STAMP): $(CIA_STAMP).probe ;

# makerom, not 3dsxtool: a CIA is its own installed title, so it carries the
# exheader that asks for the 64MB application memory region (app.rsf), which a
# .3dsx cannot do — it inherits whatever the Homebrew Launcher was given.
#
# The romfs is the SAME staged directory the .3dsx embeds, and makerom builds
# the image itself from RomFs.RootPath. It rejects a prebuilt raw romfs binary
# (the container format 3dsxtool takes) with "Invalid RomFS Binary", so there is
# nothing to share but the directory.
#
# -target t is the test target: makerom signs with the fixed test keys rather
# than Nintendo's retail ones, which is what Azahar installs. No banner is
# passed — makerom needs one only for a title that plays an animated banner in
# HOME Menu, and the SMDH already carries the icon and the title strings.
$(CIA): $(ELF) $(SMDH) $(ROMFS)/app.pocket $(ROMFS_LAYOUT_STAMP) $(RSF) $(CIA_STAMP)
	mkdir -p $(dir $(CIA))
	$(POCKETJS_MAKEROM) -f cia -o $@ -rsf $(RSF) -target t -exefslogo \
	  -DAPP_TITLE="$(POCKETJS_CIA_TITLE)" \
	  -DAPP_PRODUCT_CODE="$(POCKETJS_CIA_PRODUCT)" \
	  -DAPP_UNIQUE_ID=$(POCKETJS_CIA_UNIQUE_ID) \
	  -DAPP_ROMFS=$(ROMFS) \
	  -elf $(ELF) -icon $(SMDH)
endif

clean:
	rm -rf $(BUILD) $(OUT) $(CIA)
