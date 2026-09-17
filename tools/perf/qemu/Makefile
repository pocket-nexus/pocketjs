QEMU_PREFIX ?= /opt/qemu
BUILD_DIR ?= build
HOST_CC ?= cc
ARM_CC ?= arm-linux-gnueabihf-gcc
AARCH64_CC ?= aarch64-linux-gnu-gcc
PKG_CONFIG ?= pkg-config

PLUGIN_CPPFLAGS = -I$(QEMU_PREFIX)/include \
	$(shell $(PKG_CONFIG) --cflags glib-2.0)
PLUGIN_CFLAGS := -std=gnu11 -O2 -g0 -fPIC -fvisibility=hidden \
	-Wall -Wextra -Werror -Wformat=2 -Wshadow -Wconversion
PLUGIN_LDLIBS = $(shell $(PKG_CONFIG) --libs glib-2.0)

ARM_FLAGS := -O2 -g0 -static -march=armv7-a -mthumb \
	-mfpu=vfpv3-d16 -mfloat-abi=hard -fno-ident \
	-fno-asynchronous-unwind-tables -fno-unwind-tables \
	-Wl,--build-id=none
AARCH64_FLAGS := -O2 -g0 -static -march=armv8-a -fno-ident \
	-fno-asynchronous-unwind-tables -fno-unwind-tables \
	-Wl,--build-id=none

.PHONY: all fixtures clean test test-parser

all: $(BUILD_DIR)/pocketjs-perf-counter.so fixtures

fixtures: \
	$(BUILD_DIR)/exact-armv7 \
	$(BUILD_DIR)/exact-aarch64 \
	$(BUILD_DIR)/marker-cases-armv7 \
	$(BUILD_DIR)/marker-cases-aarch64 \
	$(BUILD_DIR)/multivcpu-armv7 \
	$(BUILD_DIR)/multivcpu-aarch64

$(BUILD_DIR):
	mkdir -p $@

$(BUILD_DIR)/pocketjs-perf-counter.so: perf_counter.c | $(BUILD_DIR)
	$(HOST_CC) $(PLUGIN_CPPFLAGS) $(PLUGIN_CFLAGS) -shared -o $@ $< \
		$(PLUGIN_LDLIBS)

$(BUILD_DIR)/exact-armv7: fixtures/exact-armv7.S | $(BUILD_DIR)
	$(ARM_CC) $(ARM_FLAGS) -nostdlib -Wl,-e,_start -o $@ $<

$(BUILD_DIR)/exact-aarch64: fixtures/exact-aarch64.S | $(BUILD_DIR)
	$(AARCH64_CC) $(AARCH64_FLAGS) -nostdlib -Wl,-e,_start -o $@ $<

$(BUILD_DIR)/marker-cases-armv7: fixtures/marker-cases.c guest_marker.h | $(BUILD_DIR)
	$(ARM_CC) $(ARM_FLAGS) -Wall -Wextra -Werror -o $@ $<

$(BUILD_DIR)/marker-cases-aarch64: fixtures/marker-cases.c guest_marker.h | $(BUILD_DIR)
	$(AARCH64_CC) $(AARCH64_FLAGS) -Wall -Wextra -Werror -o $@ $<

$(BUILD_DIR)/multivcpu-armv7: fixtures/multivcpu.c guest_marker.h | $(BUILD_DIR)
	$(ARM_CC) $(ARM_FLAGS) -Wall -Wextra -Werror -pthread -o $@ $<

$(BUILD_DIR)/multivcpu-aarch64: fixtures/multivcpu.c guest_marker.h | $(BUILD_DIR)
	$(AARCH64_CC) $(AARCH64_FLAGS) -Wall -Wextra -Werror -pthread -o $@ $<

test-parser:
	python3 -m unittest discover -s tests -p 'test_*.py'

test: all test-parser
	./run-fixtures.sh

clean:
	rm -rf -- $(BUILD_DIR)
