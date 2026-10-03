DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
BUN ?= bun
HOSTCC ?= cc
include $(DEVKITPPC)/wii_rules

WORK ?= /tmp/pocketjs-wii-w14
QUICKJS_SRC ?= $(firstword $(wildcard $(HOME)/.cargo/git/checkouts/quickjs-rs-*/ba5bdd0/libquickjs-sys/embed/quickjs))
RUST_TARGET_DIR := $(WORK)/target
RUST_LIB := $(RUST_TARGET_DIR)/powerpc-gekko-eabi/release/libpocketjs_wii_core.a
QUICKJS_ARCHIVE := ../../../dist/wii/quickjs/libquickjs.a
GUEST_JS := $(WORK)/w14-guest.js
FIXTURE_PAK := $(WORK)/w14-fixture.pak
GUEST_HEADER := $(WORK)/guest.h
ELF := $(WORK)/w14-probe.elf
DOL := $(WORK)/w14-probe.dol
DOLPHIN_USER := $(WORK)-user
DOLPHIN_LOG := $(WORK)/dolphin.log
W15A_PACKAGE_HEADER := $(WORK)/w15a-packages.h
W15B_ELF := $(WORK)/w15b-probe.elf
W15B_DOL := $(WORK)/w15b-probe.dol
W15B_DOLPHIN_USER := $(WORK)-w15b-user
W15B_DOLPHIN_LOG := $(WORK)/w15b-dolphin.log
HOST_RUST_TARGET_DIR := $(WORK)/host-target
HOST_RUST_LIB := $(HOST_RUST_TARGET_DIR)/x86_64-unknown-linux-gnu/release/libpocketjs_wii_core.a
DESKTOP_QJS_BUILD := $(WORK)/quickjs
DESKTOP_QJS_OBJECTS := $(addprefix $(DESKTOP_QJS_BUILD)/desktop/,quickjs.o cutils.o libregexp.o libunicode.o dtoa.o)
W15B_DESKTOP_PROBE := $(WORK)/w15b-probe-desktop
W21_RENDERER_SOURCES := drawlist.c gx_solid.c texture_source.c gx_texture.c gx_textured.c gx_font.c
W21_RENDERER_OBJECTS := $(addprefix $(WORK)/,$(W21_RENDERER_SOURCES:.c=.o))
HOST_RENDERER_SOURCES := $(W21_RENDERER_SOURCES) ../check/gx_draw/mock_gx.c
WII_LIBRARY_ARCHIVE ?= ../../../dist/wii/libpocketjs_wii.a
WII_LIBRARY_OBJECTS := $(WORK)/pocket_wii.o $(WORK)/qjs.o $(W21_RENDERER_OBJECTS)

CFLAGS := -O2 -std=gnu11 -Wall -Wextra $(MACHDEP) -DJS_NO_NAN_BOXING -DPOCKETJS_NO_ATOMICS \
  -DPOCKETJS_TARGET_ID='"wii-dev"' -DPOCKETJS_HOST_ABI=7 \
  -fno-strict-aliasing -funsigned-char -ffunction-sections -fdata-sections \
  -I$(DEVKITPRO)/libogc/include -isystem $(QUICKJS_SRC) -I$(WORK) -I. -I../include
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined -Wl,-u,memset -Wl,-Map,$(WORK)/w14-probe.map
W15B_LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined -Wl,-u,memset -Wl,-u,pocket_wii_draw -Wl,-Map,$(WORK)/w15b-probe.map
LIBS := -lwiiuse -lbte -logc -lm
HOST_CFLAGS := -O2 -std=gnu11 -Wall -Wextra -DJS_NO_NAN_BOXING -DPOCKETJS_NO_ATOMICS \
  -DPOCKETJS_TARGET_ID='"wii-dev"' -DPOCKETJS_HOST_ABI=7 \
  -fno-strict-aliasing -funsigned-char -ffunction-sections -fdata-sections \
  -isystem $(QUICKJS_SRC) -I$(WORK) -I. -I../include

.PHONY: all check check-w15a check-w15b check-w21-native w21-build wii-library desktop-qjs clean
all: wii-library

wii-library: $(WII_LIBRARY_ARCHIVE)

$(WII_LIBRARY_ARCHIVE): $(WII_LIBRARY_OBJECTS)
	mkdir -p $(dir $@)
	$(AR) rcsD $@ $^

$(WORK):
	mkdir -p $@

$(RUST_LIB): ../core/Cargo.toml ../core/Cargo.lock ../core/src/lib.rs ../core/src/alloc.rs
	cd ../core && PATH=$(DEVKITPPC)/bin:$(DEVKITPRO)/tools/bin:$$PATH DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC) cargo build --manifest-path Cargo.toml --target-dir $(RUST_TARGET_DIR) --release --locked -Z json-target-spec

$(QUICKJS_ARCHIVE):
	$(MAKE) -C ../quickjs $@ DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC) QUICKJS_SRC=$(QUICKJS_SRC)

$(GUEST_HEADER): build-w14.ts w14-app.tsx w14-pocket.json | $(WORK)
	$(BUN) build-w14.ts $(WORK)
	{ echo '#include <stdint.h>'; xxd -i -n w14_guest_js $(GUEST_JS); xxd -i -n w14_fixture_pak $(FIXTURE_PAK); } > $@

$(W15A_PACKAGE_HEADER): build-w15a.ts Makefile | $(WORK)
	$(BUN) build-w15a.ts $(WORK)
	{ echo '#include <stdint.h>'; \
	  xxd -i -n w15a_valid_pocket $(WORK)/w15a-valid.pocket; \
	  xxd -i -n w15a_wrong_target_pocket $(WORK)/w15a-wrong-target.pocket; \
	  xxd -i -n w15a_wrong_abi_pocket $(WORK)/w15a-wrong-abi.pocket; \
	  xxd -i -n w15a_bad_js_pocket $(WORK)/w15a-bad-js.pocket; \
	  xxd -i -n w16_frame_pocket $(WORK)/w16-frame.pocket; } > $@

$(WORK)/qjs.o: qjs.c qjs.h pocket_core.h Makefile $(QUICKJS_ARCHIVE) | $(WORK)
	$(CC) $(CFLAGS) -c $< -o $@

$(WORK)/probe.o: probe.c qjs.h pocket_core.h Makefile $(GUEST_HEADER) | $(WORK)
	$(CC) $(CFLAGS) -c $< -o $@

$(WORK)/pocket_wii.o: pocket_wii.c pocket_core.h qjs.h drawlist.h gx_font.h gx_solid.h gx_texture.h gx_textured.h ../include/pocket_wii.h Makefile $(QUICKJS_ARCHIVE) | $(WORK)
	$(CC) $(CFLAGS) -c $< -o $@

$(WORK)/%.o: %.c | $(WORK)
	$(CC) $(CFLAGS) -c $< -o $@

$(WORK)/w15b-probe.o: boot-probe.c ../include/pocket_wii.h Makefile $(W15A_PACKAGE_HEADER) | $(WORK)
	$(CC) $(CFLAGS) -c $< -o $@

$(ELF): $(WORK)/probe.o $(WORK)/qjs.o $(RUST_LIB) $(QUICKJS_ARCHIVE)
	$(CC) $(LDFLAGS) $(WORK)/probe.o $(WORK)/qjs.o -L$(LIBOGC_LIB) -lc $(RUST_LIB) $(QUICKJS_ARCHIVE) $(LIBS) -o $@

$(DOL): $(ELF)
	$(DEVKITPRO)/tools/bin/elf2dol $< $@

$(W15B_ELF): $(WORK)/w15b-probe.o $(WORK)/pocket_wii.o $(WORK)/qjs.o $(W21_RENDERER_OBJECTS) $(RUST_LIB) $(QUICKJS_ARCHIVE)
	$(CC) $(W15B_LDFLAGS) $(WORK)/w15b-probe.o $(WORK)/pocket_wii.o $(WORK)/qjs.o $(W21_RENDERER_OBJECTS) \
	  -L$(LIBOGC_LIB) -lc $(RUST_LIB) $(QUICKJS_ARCHIVE) $(LIBS) -o $@

$(W15B_DOL): $(W15B_ELF)
	$(DEVKITPRO)/tools/bin/elf2dol $< $@

w21-build: $(W15B_DOL)

check-w21-native:
	$(MAKE) -C ../check/gx_draw check-native HOSTCC=$(HOSTCC) WORK=$(WORK)/gx-draw-check

$(HOST_RUST_LIB): ../core/Cargo.toml ../core/Cargo.lock ../core/src/lib.rs ../core/src/alloc.rs
	cd ../core && cargo build --manifest-path Cargo.toml --target x86_64-unknown-linux-gnu --target-dir $(HOST_RUST_TARGET_DIR) --release --locked

desktop-qjs:
	$(MAKE) -C ../quickjs desktop BUILD=$(DESKTOP_QJS_BUILD) HOSTCC=$(HOSTCC) QUICKJS_SRC=$(QUICKJS_SRC)

$(WORK)/host-qjs.o: qjs.c qjs.h pocket_core.h Makefile | $(WORK)
	$(HOSTCC) $(HOST_CFLAGS) -c $< -o $@

$(WORK)/host-pocket_wii.o: pocket_wii.c pocket_core.h qjs.h ../include/pocket_wii.h Makefile | $(WORK)
	$(HOSTCC) $(HOST_CFLAGS) -c $< -o $@

$(WORK)/host-boot-probe.o: boot-probe.c ../include/pocket_wii.h Makefile $(W15A_PACKAGE_HEADER) | $(WORK)
	$(HOSTCC) $(HOST_CFLAGS) -c $< -o $@

$(W15B_DESKTOP_PROBE): $(WORK)/host-boot-probe.o $(WORK)/host-pocket_wii.o $(WORK)/host-qjs.o $(HOST_RUST_LIB) $(HOST_RENDERER_SOURCES) | desktop-qjs
	$(HOSTCC) $(HOST_CFLAGS) -I../check/gx_draw/mock $(WORK)/host-boot-probe.o $(WORK)/host-pocket_wii.o $(WORK)/host-qjs.o \
	  $(HOST_RENDERER_SOURCES) \
	  $(HOST_RUST_LIB) $(DESKTOP_QJS_OBJECTS) -lm -ldl -pthread -o $@

check: $(DOL)
	mkdir -p $(DOLPHIN_USER)/Config
	set +e; timeout 25s flatpak run --filesystem=/tmp --command=dolphin-emu org.DolphinEmu.dolphin-emu --user=$(DOLPHIN_USER) --video_backend=Null --exec=$(DOL) -C Logger.Logs.OSREPORT=True -C Logger.Options.WriteToConsole=True > $(DOLPHIN_LOG) 2>&1; result=$$?; set -e; test $$result -eq 0 -o $$result -eq 124
	grep -aEo 'W14 PASS.*' $(DOLPHIN_LOG) | tr -d '\r' > $(WORK)/wii.out
	test -s $(WORK)/wii.out
	cat $(WORK)/wii.out

check-w15a: check-w15b

check-w15b: $(W15B_DOL) $(W15B_DESKTOP_PROBE)
	$(W15B_DESKTOP_PROBE)
	mkdir -p $(W15B_DOLPHIN_USER)/Config
	set +e; timeout 25s flatpak run --filesystem=/tmp --command=dolphin-emu org.DolphinEmu.dolphin-emu --user=$(W15B_DOLPHIN_USER) --video_backend=Null --exec=$(W15B_DOL) -C Logger.Logs.OSREPORT=True -C Logger.Options.WriteToConsole=True > $(W15B_DOLPHIN_LOG) 2>&1; result=$$?; set -e; test $$result -eq 0 -o $$result -eq 124
	grep -aEo 'W15B PASS.*' $(W15B_DOLPHIN_LOG) | tr -d '\r' > $(WORK)/w15b-wii.out
	test -s $(WORK)/w15b-wii.out
	cat $(WORK)/w15b-wii.out
	grep -aEo 'W16 PASS.*' $(W15B_DOLPHIN_LOG) | tr -d '\r' > $(WORK)/w16-wii.out
	test -s $(WORK)/w16-wii.out
	cat $(WORK)/w16-wii.out

clean:
	rm -rf $(WORK)
