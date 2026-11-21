#include <sys/time.h>
#include <time.h>
/* Link-only fixture. Board programs supply their own clock policy. */
int clock_gettime(clockid_t clock, struct timespec *value) {
    (void)clock; value->tv_sec = 0; value->tv_nsec = 0; return 0;
}
int _gettimeofday(struct timeval *value, void *zone) {
    (void)zone; value->tv_sec = 0; value->tv_usec = 0; return 0;
}
