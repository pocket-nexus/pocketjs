DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
NODE ?= node
include $(DEVKITPPC)/wii_rules

WORK ?= /tmp/pocketjs-wii-admission
SOURCE ?= $(abspath ../probe/w06a.pocket)
RUST_TARGET_DIR := $(WORK)/target
WII_LIB := $(RUST_TARGET_DIR)/powerpc-gekko-eabi/release/libpocketjs_wii_core.a
HOST_LIB := $(RUST_TARGET_DIR)/x86_64-unknown-linux-gnu/release/libpocketjs_wii_core.a
HEADER := $(WORK)/fixtures.h
ELF := $(WORK)/admission.elf
DOL := $(WORK)/admission.dol
DOLPHIN_LOG := $(WORK)/dolphin.log

CFLAGS := -O2 -Wall -Wextra $(MACHDEP) -I$(LIBOGC_INC) -I$(WORK) -ffunction-sections -fdata-sections
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined -Wl,-u,memset
LIBS := -lwiiuse -lbte -logc -lm

.PHONY: desktop dolphin all
all: $(DOL)

$(WORK):
	mkdir -p $@

$(HEADER): fixtures.ts $(SOURCE) | $(WORK)
	cd .. && node --experimental-strip-types admission-check/fixtures.ts $(SOURCE) $(WORK)
	: > $@
	xxd -i -n valid_pocket $(WORK)/valid.pocket >> $@
	xxd -i -n wrong_target_pocket $(WORK)/wrong-target.pocket >> $@
	xxd -i -n wrong_abi_pocket $(WORK)/wrong-abi.pocket >> $@

$(WII_LIB): ../Cargo.toml ../Cargo.lock ../src/lib.rs ../src/alloc.rs
	cd .. && PATH=$(DEVKITPPC)/bin:$(DEVKITPRO)/tools/bin:$$PATH DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC) cargo build --manifest-path Cargo.toml --target-dir $(WORK)/target --release --locked -Z json-target-spec

$(HOST_LIB): ../Cargo.toml ../Cargo.lock ../src/lib.rs ../src/alloc.rs
	cd .. && cargo build --manifest-path Cargo.toml --target x86_64-unknown-linux-gnu --target-dir $(WORK)/target --release --locked

$(ELF): check.c $(WII_LIB) $(HEADER) | $(WORK)
	$(CC) $(CFLAGS) $(LDFLAGS) $< -L$(LIBOGC_LIB) -lc $(WII_LIB) $(LIBS) -o $@

$(DOL): $(ELF)
	elf2dol $< $@

desktop: $(HOST_LIB) $(HEADER)
	cc -O2 -Wall -Wextra -I$(WORK) check.c $(HOST_LIB) -o $(WORK)/admission-desktop
	$(WORK)/admission-desktop

dolphin: $(DOL)
	mkdir -p $(WORK)/dolphin-user/Config
	set +e; timeout 20s flatpak run --filesystem=/tmp --command=dolphin-emu org.DolphinEmu.dolphin-emu --user=$(WORK)/dolphin-user --video_backend=Null --exec=$(DOL) -C Logger.Logs.OSREPORT=True -C Logger.Options.WriteToConsole=True > $(DOLPHIN_LOG) 2>&1; result=$$?; set -e; test $$result -eq 0 -o $$result -eq 124
	grep -a 'W13A PASS valid package admitted; wrong target=6 wrong ABI=7' $(DOLPHIN_LOG)
