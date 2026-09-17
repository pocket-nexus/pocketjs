/* SPDX-License-Identifier: MIT */
#include <stdint.h>
#include <string.h>
#include <sys/random.h>

#include "../guest_marker.h"

static volatile uint32_t value = 1;

static int marker_ok(int64_t result)
{
    return result == 0 ? 0 : 2;
}

static int request_random_byte(void)
{
    uint8_t byte;
    return getrandom(&byte, sizeof(byte), 0) == (ssize_t)sizeof(byte) ? 0 : 3;
}

int main(int argc, char **argv)
{
    const char *mode = argc > 1 ? argv[1] : "valid";

    if (strcmp(mode, "valid") == 0) {
        if (marker_ok(pocketjs_perf_begin(11, 3)) != 0) {
            return 2;
        }
        value = value * 3 + 1;
        return marker_ok(pocketjs_perf_end(11, 3));
    }
    if (strcmp(mode, "valid-loop") == 0) {
        uint32_t i;
        if (marker_ok(pocketjs_perf_begin(11, 3)) != 0) {
            return 2;
        }
        for (i = 0; i < 20000; i++) {
            value = value * 3 + i;
        }
        return marker_ok(pocketjs_perf_end(11, 3));
    }
    if (strcmp(mode, "getrandom-before") == 0) {
        if (request_random_byte() != 0 ||
            marker_ok(pocketjs_perf_begin(11, 3)) != 0) {
            return 3;
        }
        value = value * 3 + 1;
        return marker_ok(pocketjs_perf_end(11, 3));
    }
    if (strcmp(mode, "getrandom-active") == 0) {
        if (marker_ok(pocketjs_perf_begin(11, 3)) != 0 ||
            request_random_byte() != 0) {
            return 3;
        }
        return marker_ok(pocketjs_perf_end(11, 3));
    }
    if (strcmp(mode, "nested") == 0) {
        pocketjs_perf_begin(11, 3);
        pocketjs_perf_begin(11, 3);
        pocketjs_perf_end(11, 3);
        return 0;
    }
    if (strcmp(mode, "mismatch") == 0) {
        pocketjs_perf_begin(11, 3);
        pocketjs_perf_end(12, 3);
        return 0;
    }
    if (strcmp(mode, "unexpected-end") == 0) {
        pocketjs_perf_end(11, 3);
        return 0;
    }
    if (strcmp(mode, "missing-end") == 0) {
        pocketjs_perf_begin(11, 3);
        return 0;
    }
    if (strcmp(mode, "none") == 0) {
        return 0;
    }
    return 64;
}
