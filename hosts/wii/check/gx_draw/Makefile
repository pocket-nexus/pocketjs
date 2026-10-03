HOSTCC ?= cc
WORK ?= /tmp/pocketjs-wii-gx-draw-check
WII_SRC := ../../src
NATIVE := $(WORK)/gx-draw-native
SOURCES := check.c mock_gx.c $(addprefix $(WII_SRC)/,pocket_wii.c drawlist.c gx_solid.c texture_source.c gx_texture.c gx_textured.c gx_font.c)
HEADERS := $(wildcard mock/ogc/*.h mock/*.h $(WII_SRC)/*.h ../../include/*.h)

.PHONY: all check-native clean
all: check-native

$(WORK):
	mkdir -p $@

$(NATIVE): $(SOURCES) $(HEADERS) | $(WORK)
	$(HOSTCC) -std=gnu11 -O2 -Wall -Wextra -Werror \
	  -Imock -I$(WII_SRC) -I../../include $(SOURCES) -o $@

check-native: $(NATIVE)
	$<

clean:
	rm -rf $(WORK)
