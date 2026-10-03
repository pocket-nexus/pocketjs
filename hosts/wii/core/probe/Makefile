DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
NODE ?= node
include $(DEVKITPPC)/wii_rules

WORK ?= /tmp/pocketjs-wii-core-probe
RUST_TARGET_DIR := $(WORK)/target
RUST_LIB := $(RUST_TARGET_DIR)/powerpc-gekko-eabi/release/libpocketjs_wii_link_probe.a
ELF := $(WORK)/probe.elf
DOL := $(WORK)/probe.dol
DOLPHIN_USER := $(WORK)-user
DOLPHIN_LOG := $(WORK)/dolphin.log

CFLAGS := -O2 -Wall -Wextra $(MACHDEP) -I$(LIBOGC_INC) -I$(WORK) -ffunction-sections -fdata-sections
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined -Wl,-u,memset -Wl,-Map,$(WORK)/probe.map
LIBS := -lwiiuse -lbte -logc -lm

.PHONY: all check clean symbols
all: $(DOL) symbols

$(RUST_LIB): Cargo.toml Cargo.lock src/lib.rs w06a.pocket
	cd .. && PATH=$(DEVKITPPC)/bin:$(DEVKITPRO)/tools/bin:$$PATH DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC) cargo build --manifest-path probe/Cargo.toml --target-dir $(RUST_TARGET_DIR) --release --locked -Z json-target-spec

$(WORK):
	mkdir -p $@

# libogc clears BSS while the active stack is in it. Pull newlib's stackless
# memset before Rust's weak compiler_builtins implementation.
$(WORK)/w06b_fixture.h: w06b-fixture.ts | $(WORK)
	$(NODE) --experimental-strip-types $< $(WORK) > $(WORK)/w06b-desktop.out

$(WORK)/w06c_fixture.h: w06c-fixture.ts | $(WORK)
	$(NODE) --experimental-strip-types $< $(WORK) > $(WORK)/w06c-desktop.out

$(ELF): probe.c $(RUST_LIB) $(WORK)/w06b_fixture.h $(WORK)/w06c_fixture.h | $(WORK)
	$(CC) $(CFLAGS) $(LDFLAGS) $< -L$(LIBOGC_LIB) -lc $(RUST_LIB) $(LIBS) -o $@

$(DOL): $(ELF)
	elf2dol $< $@

symbols: $(RUST_LIB) $(ELF)
	@echo 'External undefined symbols in Rust staticlib:'
	$(NM) -u $(RUST_LIB) | awk '$$1 == "U" && $$2 !~ /^_R/ {print $$2}' | sort -u
	@echo 'Undefined symbols in final ELF (empty means linked):'
	$(NM) -u $(ELF)

check: $(DOL) $(WORK)/w06b_fixture.h $(WORK)/w06c_fixture.h
	$(NODE) --experimental-strip-types w06a-fixture.ts > $(WORK)/desktop.out
	cat $(WORK)/w06b-desktop.out >> $(WORK)/desktop.out
	cat $(WORK)/w06c-desktop.out >> $(WORK)/desktop.out
	mkdir -p $(DOLPHIN_USER)/Config
	set +e; timeout 20s flatpak run --filesystem=/tmp --command=dolphin-emu org.DolphinEmu.dolphin-emu --user=$(DOLPHIN_USER) --video_backend=Null --exec=$(DOL) -C Logger.Logs.OSREPORT=True -C Logger.Options.WriteToConsole=True > $(DOLPHIN_LOG) 2>&1; result=$$?; set -e; test $$result -eq 0 -o $$result -eq 124
	grep -aEo 'W06(A PASS target=|B PASS |C PASS ).*' $(DOLPHIN_LOG) | tr -d '\r' > $(WORK)/wii.out
	cmp $(WORK)/desktop.out $(WORK)/wii.out
	cat $(WORK)/desktop.out

clean:
	rm -rf $(WORK)
