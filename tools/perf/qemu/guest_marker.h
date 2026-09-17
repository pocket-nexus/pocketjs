/* SPDX-License-Identifier: MIT */
#ifndef POCKETJS_PERF_GUEST_MARKER_H
#define POCKETJS_PERF_GUEST_MARKER_H

#include <stdint.h>

#define POCKETJS_PERF_MARKER_SYSCALL 4096U
#define POCKETJS_PERF_MARKER_MAGIC UINT32_C(0x504a424d)
#define POCKETJS_PERF_MARKER_COOKIE UINT32_C(0xc001c0de)
#define POCKETJS_PERF_MARKER_VERSION UINT32_C(1)
#define POCKETJS_PERF_MARKER_BEGIN UINT32_C(1)
#define POCKETJS_PERF_MARKER_END UINT32_C(2)

/* bits 15..8: protocol version; bits 7..0: opcode; bits 31..16: zero */
#define POCKETJS_PERF_MARKER_PACK(opcode) \
    ((POCKETJS_PERF_MARKER_VERSION << 8) | (opcode))

#if defined(__arm__) && !defined(__aarch64__)

static __attribute__((always_inline)) inline int32_t
pocketjs_perf_marker(uint32_t opcode, uint32_t phase_id, uint32_t iteration)
{
    register uint32_t r0 __asm__("r0") = POCKETJS_PERF_MARKER_MAGIC;
    register uint32_t r1 __asm__("r1") = POCKETJS_PERF_MARKER_PACK(opcode);
    register uint32_t r2 __asm__("r2") = phase_id;
    register uint32_t r3 __asm__("r3") = iteration;
    register uint32_t r4 __asm__("r4") = POCKETJS_PERF_MARKER_COOKIE;
    register uint32_t r7 __asm__("r7") = POCKETJS_PERF_MARKER_SYSCALL;

    __asm__ volatile("svc #0"
                     : "+r"(r0)
                     : "r"(r1), "r"(r2), "r"(r3), "r"(r4), "r"(r7)
                     : "memory", "cc");
    return (int32_t)r0;
}

#elif defined(__aarch64__)

static __attribute__((always_inline)) inline int64_t
pocketjs_perf_marker(uint32_t opcode, uint32_t phase_id, uint32_t iteration)
{
    register uint64_t x0 __asm__("x0") = POCKETJS_PERF_MARKER_MAGIC;
    register uint64_t x1 __asm__("x1") = POCKETJS_PERF_MARKER_PACK(opcode);
    register uint64_t x2 __asm__("x2") = phase_id;
    register uint64_t x3 __asm__("x3") = iteration;
    register uint64_t x4 __asm__("x4") = POCKETJS_PERF_MARKER_COOKIE;
    register uint64_t x8 __asm__("x8") = POCKETJS_PERF_MARKER_SYSCALL;

    __asm__ volatile("svc #0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x8)
                     : "memory", "cc");
    return (int64_t)x0;
}

#else
#error "PocketJS QEMU perf markers support only ARM32 and AArch64 guests"
#endif

static __attribute__((always_inline)) inline int64_t
pocketjs_perf_begin(uint32_t phase_id, uint32_t iteration)
{
    return pocketjs_perf_marker(POCKETJS_PERF_MARKER_BEGIN,
                                phase_id, iteration);
}

static __attribute__((always_inline)) inline int64_t
pocketjs_perf_end(uint32_t phase_id, uint32_t iteration)
{
    return pocketjs_perf_marker(POCKETJS_PERF_MARKER_END,
                                phase_id, iteration);
}

#endif
