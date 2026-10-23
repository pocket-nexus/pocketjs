#ifndef POCKET_KEYOS_SYS_TIME_H
#define POCKET_KEYOS_SYS_TIME_H
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef long suseconds_t;
struct timeval {
    time_t tv_sec;
    suseconds_t tv_usec;
};
int gettimeofday(struct timeval *restrict tv, void *restrict tz);

#ifdef __cplusplus
}
#endif
#endif
