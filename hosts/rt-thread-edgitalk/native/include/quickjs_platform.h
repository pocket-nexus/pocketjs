/*
 * Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/include/quickjs_platform.h
 * Force-include for quickjs-ng on RT-Thread (clock_gettime shim).
 */
#pragma once

#include <rtthread.h>
#include <time.h>

#ifndef CLOCK_MONOTONIC
#define CLOCK_MONOTONIC 4
#endif

static inline int pocketjs_clock_gettime(int clock_id, struct timespec *value)
{
    const rt_uint32_t milliseconds = rt_tick_get_millisecond();

    (void)clock_id;
    value->tv_sec = milliseconds / 1000U;
    value->tv_nsec = (long)(milliseconds % 1000U) * 1000000L;
    return 0;
}

#define clock_gettime pocketjs_clock_gettime
