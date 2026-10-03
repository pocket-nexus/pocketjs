DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
NODE ?= node
include $(DEVKITPPC)/wii_rules

WORK ?= /tmp/pocketjs-wii-ui-check
RUST_TARGET_DIR := $(WORK)/target
RUST_LIB := $(RUST_TARGET_DIR)/powerpc-gekko-eabi/release/libpocketjs_wii_core.a
FIXTURE := $(WORK)/fixture.h
ELF := $(WORK)/ui-check.elf
DOL := $(WORK)/ui-check.dol
DOLPHIN_USER := $(WORK)-user
DOLPHIN_LOG := $(WORK)/dolphin.log

CFLAGS := -O2 -Wall -Wextra $(MACHDEP) -I$(LIBOGC_INC) -I$(WORK) -ffunction-sections -fdata-sections
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined -Wl,-u,memset -Wl,-Map,$(WORK)/ui-check.map
LIBS := -lwiiuse -lbte -logc -lm

.PHONY: all check clean
all: $(DOL)

$(WORK):
	mkdir -p $@

$(FIXTURE): fixture.ts | $(WORK)
	$(NODE) --experimental-strip-types $< $(WORK)

$(RUST_LIB): ../Cargo.toml ../Cargo.lock ../src/lib.rs ../src/alloc.rs
	cd .. && PATH=$(DEVKITPPC)/bin:$(DEVKITPRO)/tools/bin:$$PATH DEVKITPRO=$(DEVKITPRO) DEVKITPPC=$(DEVKITPPC) cargo build --manifest-path Cargo.toml --target-dir $(RUST_TARGET_DIR) --release --locked -Z json-target-spec

$(ELF): probe.c $(RUST_LIB) $(FIXTURE) | $(WORK)
	$(CC) $(CFLAGS) $(LDFLAGS) $< -L$(LIBOGC_LIB) -lc $(RUST_LIB) $(LIBS) -o $@

$(DOL): $(ELF)
	elf2dol $< $@

check: $(DOL)
	mkdir -p $(DOLPHIN_USER)/Config
	set +e; timeout 20s flatpak run --filesystem=/tmp --command=dolphin-emu org.DolphinEmu.dolphin-emu --user=$(DOLPHIN_USER) --video_backend=Null --exec=$(DOL) -C Logger.Logs.OSREPORT=True -C Logger.Options.WriteToConsole=True > $(DOLPHIN_LOG) 2>&1; result=$$?; set -e; test $$result -eq 0 -o $$result -eq 124
	grep -aEo 'W13B PASS.*' $(DOLPHIN_LOG) | tr -d '\r' > $(WORK)/wii.out
	test -s $(WORK)/wii.out
	cat $(WORK)/wii.out

clean:
	rm -rf $(WORK)
