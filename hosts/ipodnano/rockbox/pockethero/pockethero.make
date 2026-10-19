# PocketJS MicroTS Hero: launch.rock loads pockethero.ovl, which links the
# Rust staticlib POCKETHERO_LIB built by hosts/ipodnano/build.ts.

POCKETHERO_SRCDIR := $(APPSDIR)/plugins/pockethero
POCKETHERO_BUILDDIR := $(BUILDDIR)/apps/plugins/pockethero
POCKETHERO_OUTLDS := $(POCKETHERO_BUILDDIR)/pockethero.link
POCKETHERO_OVLFLAGS := -Wl,--gc-sections -Wl,-Map,$(POCKETHERO_BUILDDIR)/pockethero.map $(GLOBAL_LDOPTS)

ROCKS += $(POCKETHERO_BUILDDIR)/pockethero.rock
ROCKS += $(POCKETHERO_BUILDDIR)/pockethero.ovl

POCKETHERO_SRC := $(call preprocess, $(POCKETHERO_SRCDIR)/SOURCES)
OTHER_SRC += $(POCKETHERO_SRC)

$(POCKETHERO_BUILDDIR)/pockethero.rock: $(POCKETHERO_BUILDDIR)/launch.o

$(POCKETHERO_BUILDDIR)/pockethero.refmap: $(POCKETHERO_BUILDDIR)/pockethero.o $(POCKETHERO_LIB)

$(POCKETHERO_OUTLDS): $(PLUGIN_LDS) $(POCKETHERO_BUILDDIR)/pockethero.refmap
	$(call PRINTS,PP $(@F))$(call preprocess2file,$<,$@,-DPLUGIN -DOVERLAY_OFFSET=$(shell \
		$(TOOLSDIR)/ovl_offset.pl $(POCKETHERO_BUILDDIR)/pockethero.refelf))

$(POCKETHERO_BUILDDIR)/pockethero.ovl: $(POCKETHERO_BUILDDIR)/pockethero.o $(POCKETHERO_LIB) $(POCKETHERO_OUTLDS)
	$(SILENT)$(CC) $(PLUGINFLAGS) -o $(basename $@).elf \
		$(filter %.o, $^) \
		$(filter %.a, $+) \
		-lgcc -T$(POCKETHERO_OUTLDS) $(POCKETHERO_OVLFLAGS)
	$(call PRINTS,LD $(@F))$(call objcopy_plugin,$(basename $@).elf,$@)
