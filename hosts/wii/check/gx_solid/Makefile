.SUFFIXES:
ifneq ($(filter check-native,$(MAKECMDGOALS)),check-native)
ifeq ($(strip $(DEVKITPPC)),)
$(error Set DEVKITPPC and DEVKITPRO before building the GX solid probe)
endif

include $(DEVKITPPC)/wii_rules
endif

TARGET := wii-gx-solid-probe
BUILD := build
SOURCES := source
INCLUDES := ../../src
PROBE_SOURCES := probe.c drawlist.c gx_solid.c
HOSTCC ?= cc
NATIVE_CHECK := /tmp/pocketjs-wii-gx-solid-check
LIBS := -logc -lm

ifneq ($(BUILD),$(notdir $(CURDIR)))
export OUTPUT := $(CURDIR)/$(TARGET)
export LD := $(CC)
export VPATH := $(CURDIR)/source $(CURDIR)/../../src
export DEPSDIR := $(CURDIR)/$(BUILD)
export CFILES := $(PROBE_SOURCES)
export OFILES := $(CFILES:.c=.o)
export INCLUDE := $(foreach dir,$(INCLUDES),-iquote $(CURDIR)/$(dir)) -I$(LIBOGC_INC)
export LIBPATHS := -L$(LIBOGC_LIB)
export CFLAGS := -O2 -Wall -Wextra -Werror $(MACHDEP) $(INCLUDE)
export LDFLAGS := -O2 $(MACHDEP) -Wl,--gc-sections

.PHONY: all clean check-native
all: $(BUILD)

check-native:
	$(HOSTCC) -std=c11 -Wall -Wextra -Werror \
	  -I$(CURDIR)/mock -I$(CURDIR)/../../src \
	  $(CURDIR)/../../src/gx_solid.c $(CURDIR)/../../src/drawlist.c \
	  $(CURDIR)/mock_gx.c $(CURDIR)/native_check.c -o $(NATIVE_CHECK)
	$(NATIVE_CHECK)

$(BUILD):
	mkdir -p $@
	$(MAKE) --no-print-directory -C $@ -f $(CURDIR)/Makefile

clean:
	rm -rf $(BUILD) $(OUTPUT).elf $(OUTPUT).dol
else
DEPENDS := $(OFILES:.o=.d)

$(OUTPUT).dol: $(OUTPUT).elf
$(OUTPUT).elf: $(OFILES)
%.o: %.c
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

-include $(DEPENDS)
endif
