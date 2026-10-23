/* KeyOS libc shim: the clock calls QuickJS makes for Date and timers. */
#ifndef POCKET_KEYOS_TIME_H
#define POCKET_KEYOS_TIME_H
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef long long time_t;
typedef int clockid_t;

struct timespec {
    time_t tv_sec;
    long tv_nsec;
};

struct tm {
    int tm_sec;
    int tm_min;
    int tm_hour;
    int tm_mday;
    int tm_mon;
    int tm_year;
    int tm_wday;
    int tm_yday;
    int tm_isdst;
    long tm_gmtoff;
    const char *tm_zone;
};

#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 1

int clock_gettime(clockid_t clock, struct timespec *ts);
struct tm *localtime_r(const time_t *restrict t, struct tm *restrict out);
struct tm *gmtime_r(const time_t *restrict t, struct tm *restrict out);
time_t time(time_t *out);

#ifdef __cplusplus
}
#endif
#endif
