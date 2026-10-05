DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
HOSTCC ?= cc
include $(DEVKITPPC)/wii_rules

WORK ?= /tmp/pocketjs-wii-texture-source-check
ELF := $(WORK)/texture-source.elf
DOL := $(WORK)/texture-source.dol
DESKTOP := $(WORK)/texture-source-desktop
DOLPHIN_USER := $(WORK)-user
DOLPHIN_LOG := $(WORK)/dolphin.log

CFLAGS := -std=gnu11 -O2 -Wall -Wextra -Werror $(MACHDEP) -I$(LIBOGC_INC) -I../../src -ffunction-sections -fdata-sections
LDFLAGS := $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined -Wl,-u,memset
LIBS := -lwiiuse -lbte -logc -lm

.PHONY: all desktop check clean
all: $(DOL)

$(WORK):
	mkdir -p $@

$(ELF): check.c ../../src/texture_source.c ../../src/texture_source.h | $(WORK)
	$(CC) $(CFLAGS) $(LDFLAGS) check.c ../../src/texture_source.c -L$(LIBOGC_LIB) -lc $(LIBS) -o $@

$(DOL): $(ELF)
	elf2dol $< $@

$(DESKTOP): check.c ../../src/texture_source.c ../../src/texture_source.h | $(WORK)
	$(HOSTCC) -std=c11 -O2 -Wall -Wextra -Werror -I../../src check.c ../../src/texture_source.c -o $@

desktop: $(DESKTOP)
	$< > $(WORK)/desktop.out

check: $(DOL) desktop
	mkdir -p $(DOLPHIN_USER)/Config
	set +e; timeout 20s flatpak run --filesystem=/tmp --command=dolphin-emu org.DolphinEmu.dolphin-emu --user=$(DOLPHIN_USER) --video_backend=Null --exec=$(DOL) -C Logger.Logs.OSREPORT=True -C Logger.Options.WriteToConsole=True > $(DOLPHIN_LOG) 2>&1; result=$$?; set -e; test $$result -eq 0 -o $$result -eq 124
	grep -aEo 'W19A PASS.*' $(DOLPHIN_LOG) | tr -d '\r' > $(WORK)/wii.out
	test -s $(WORK)/wii.out
	cmp $(WORK)/desktop.out $(WORK)/wii.out
	cat $(WORK)/wii.out

clean:
	rm -rf $(WORK)
