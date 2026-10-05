ifneq ($(strip $(DEVKITPPC)),)
include $(DEVKITPPC)/wii_rules
else
$(error Set DEVKITPPC and DEVKITPRO before building QuickJS for Wii)
endif

QUICKJS_REV := ba5bdd0dc013518768e76cd9e05cd30ed53dd35b
QUICKJS_SRC ?= $(firstword $(wildcard $(HOME)/.cargo/git/checkouts/quickjs-rs-*/ba5bdd0/libquickjs-sys/embed/quickjs))
BUILD ?= ../../../dist/wii/quickjs
SOURCES := quickjs.c cutils.c libregexp.c libunicode.c dtoa.c
OBJECTS := $(addprefix $(BUILD)/,$(SOURCES:.c=.o))
ARCHIVE := $(BUILD)/libquickjs.a
PROBE := $(BUILD)/quickjs-probe.elf
PROBE_DOL := $(BUILD)/quickjs-probe.dol
ELF2DOL ?= $(DEVKITPRO)/tools/bin/elf2dol
HOSTCC ?= cc
DESKTOP_BUILD := $(BUILD)/desktop
DESKTOP_PROBE := $(DESKTOP_BUILD)/quickjs-probe
QUICKJS_NO_ATOMICS := $(BUILD)/quickjs-no-atomics.c

# Keep JSValue in QuickJS and the C caller on the same 16-byte, non-NaN-boxed
# layout. These are the Wii counterparts of the QuickJS flags in tools/3ds.ts.
# ponytail: keep Atomics off until devkitPPC provides its required 64-bit atomic symbols.
CFLAGS := -O2 -std=gnu11 $(MACHDEP) \
  -D_GNU_SOURCE -DJS_NO_NAN_BOXING -D__TM_GMTOFF=tm_gmtoff \
  -DCONFIG_VERSION='"pocketjs-wii"' -include malloc.h \
  -DPOCKETJS_NO_ATOMICS \
  -fno-strict-aliasing -funsigned-char -Wno-incompatible-pointer-types \
  -Wno-implicit-function-declaration -ffunction-sections -fdata-sections \
  -I$(QUICKJS_SRC)
LDFLAGS := -O2 $(MACHDEP) -Wl,--gc-sections
LIBPATHS := -L$(LIBOGC_LIB)
LIBS := -logc -lm
DESKTOP_CFLAGS := -O2 -std=gnu11 -D_GNU_SOURCE -DJS_NO_NAN_BOXING \
  -DCONFIG_VERSION='"pocketjs-wii"' -DPOCKETJS_NO_ATOMICS \
  -fno-strict-aliasing -funsigned-char \
  -I$(QUICKJS_SRC)

.PHONY: all clean check-quickjs check desktop
all: $(ARCHIVE) $(PROBE) $(PROBE_DOL)

desktop: $(DESKTOP_PROBE)

check: $(DESKTOP_PROBE)
	$(DESKTOP_PROBE)

$(OBJECTS) $(BUILD)/probe.o: Makefile

check-quickjs:
	@test -n "$(QUICKJS_SRC)" || { echo 'QuickJS checkout missing; run cargo fetch --manifest-path hosts/psp/Cargo.toml' >&2; exit 1; }
	@test "$$(git -C '$(QUICKJS_SRC)/../../..' rev-parse HEAD)" = '$(QUICKJS_REV)' || { echo 'QuickJS checkout does not match hosts/psp/Cargo.toml pin' >&2; exit 1; }

$(BUILD):
	mkdir -p $@

$(QUICKJS_NO_ATOMICS): $(QUICKJS_SRC)/quickjs.c | check-quickjs $(BUILD)
	@grep -q '^#define CONFIG_ATOMICS$$' $<
	awk '{ if ($$0 == "#define CONFIG_ATOMICS") { print "#if !defined(POCKETJS_NO_ATOMICS)"; print; print "#endif" } else print }' $< > $@

$(BUILD)/quickjs.o: $(QUICKJS_NO_ATOMICS) | check-quickjs $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/%.o: $(QUICKJS_SRC)/%.c | check-quickjs $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/probe.o: probe.c $(QUICKJS_SRC)/quickjs.h | check-quickjs $(BUILD)
	$(CC) $(CFLAGS) -I$(DEVKITPRO)/libogc/include -DPOCKETJS_WII_PROBE -c $< -o $@

$(ARCHIVE): $(OBJECTS)
	$(AR) rcsD $@ $^

$(PROBE): $(BUILD)/probe.o $(ARCHIVE)
	$(CC) $(LDFLAGS) $< $(ARCHIVE) $(LIBPATHS) $(LIBS) -o $@

$(PROBE_DOL): $(PROBE)
	$(ELF2DOL) $< $@

$(DESKTOP_BUILD):
	mkdir -p $@

$(DESKTOP_BUILD)/quickjs.o: $(QUICKJS_NO_ATOMICS) | check-quickjs $(DESKTOP_BUILD)
	$(HOSTCC) $(DESKTOP_CFLAGS) -c $< -o $@

$(DESKTOP_BUILD)/%.o: $(QUICKJS_SRC)/%.c | check-quickjs $(DESKTOP_BUILD)
	$(HOSTCC) $(DESKTOP_CFLAGS) -c $< -o $@

$(DESKTOP_BUILD)/probe.o: probe.c $(QUICKJS_SRC)/quickjs.h | check-quickjs $(DESKTOP_BUILD)
	$(HOSTCC) $(DESKTOP_CFLAGS) -c $< -o $@

$(DESKTOP_PROBE): $(addprefix $(DESKTOP_BUILD)/,$(SOURCES:.c=.o)) $(DESKTOP_BUILD)/probe.o
	$(HOSTCC) $^ -lm -ldl -o $@

clean:
	rm -rf $(BUILD)
