# PocketJS Rockbox plugin rules, included by apps/plugins/plugins.make when
# hosts/rockbox/build.ts installs this directory as apps/plugins/pocketjs.
#
# Variables (build.ts passes them on the make command line):
#   POCKETJS_DIR  pocketjs checkout (default: sibling of the Rockbox tree)
#   PJS_APPS      space-separated <suffix>:<app dir> pairs; each builds
#                 pocketjs_<suffix>.rock from apps/<app dir>/app.tsx
#   PJS_PERF_HUD=1  compile the profiling strip into the plugins

PJSSRCDIR := $(APPSDIR)/plugins/pocketjs
PJSBUILDDIR := $(BUILDDIR)/apps/plugins/pocketjs

POCKETJS_DIR ?= $(ROOTDIR)/../pocketjs
PJS_CRATE := $(POCKETJS_DIR)/hosts/rockbox
PJS_APPS ?= ipod:ipod-video-demo

ifeq ($(APP_TYPE),sdl-sim)
  PJS_CARGO := cargo build --locked --release
  PJS_LIBPATH := release/libpocketjs_rockbox.a
else
  # ARM code to match Rockbox C, which builds without -mthumb-interwork.
  PJS_RUST_TARGET := armv4t-none-eabi
  PJS_CARGO := cargo +nightly-2026-07-01 build --locked --release \
               --target $(PJS_RUST_TARGET) -Z build-std=core,alloc
  PJS_LIBPATH := $(PJS_RUST_TARGET)/release/libpocketjs_rockbox.a
endif

PJS_SRC := $(PJSSRCDIR)/pocketjs.c
PJS_OBJ := $(call c2obj, $(PJS_SRC))
OTHER_SRC += $(PJS_SRC)

ifdef PJS_PERF_HUD
$(PJS_OBJ): PLUGINFLAGS += -DPJS_PERF_HUD
endif

PJS_RUST_SRC := $(wildcard $(PJS_CRATE)/src/*.rs) $(PJS_CRATE)/Cargo.toml

# $(1) = plugin suffix, $(2) = app directory. Fonts and images do not fit the
# plugin buffer; build.ts installs data/<app dir>/ as plugin data.
define PJS_APP
PJS_$(1)_GEN := $(PJSBUILDDIR)/gen/$(1)
PJS_$(1)_LIB := $(PJSBUILDDIR)/cargo-$(1)/$(PJS_LIBPATH)
ROCKS += $(PJSBUILDDIR)/pocketjs_$(1).rock

$$(PJS_$(1)_GEN)/include.rs: $(wildcard $(POCKETJS_DIR)/apps/$(2)/*.ts*) $(PJS_CRATE)/gen.ts
	$$(call PRINTS,MICROTS $(2))cd $(POCKETJS_DIR) && \
		bun ./hosts/rockbox/gen.ts apps/$(2)/app.tsx $$(PJS_$(1)_GEN) >/dev/null
	$(SILENT)rm -rf $(PJSBUILDDIR)/data/$(2) && mkdir -p $(PJSBUILDDIR)/data/$(2) && \
		cp $$(PJS_$(1)_GEN)/font-*.bin $(PJSBUILDDIR)/data/$(2)/ && \
		{ cp $$(PJS_$(1)_GEN)/*.rgba $(PJSBUILDDIR)/data/$(2)/ 2>/dev/null || true; }

$$(PJS_$(1)_LIB): $$(PJS_$(1)_GEN)/include.rs $(PJS_RUST_SRC)
	$$(call PRINTS,CARGO pocketjs_$(1))cd $(PJS_CRATE) && \
		POCKETJS_GEN=$$(PJS_$(1)_GEN) \
		CARGO_TARGET_DIR=$(PJSBUILDDIR)/cargo-$(1) $(PJS_CARGO)

$(PJSBUILDDIR)/pocketjs_$(1).rock: $(PJS_OBJ) $$(PJS_$(1)_LIB)
endef

$(foreach app,$(PJS_APPS),$(eval $(call PJS_APP,$(firstword $(subst :, ,$(app))),$(lastword $(subst :, ,$(app))))))
