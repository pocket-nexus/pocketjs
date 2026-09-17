/* SPDX-License-Identifier: MIT */
#include <pthread.h>
#include <stdint.h>

#include "../guest_marker.h"

static void *worker(void *argument)
{
    volatile uintptr_t value = (uintptr_t)argument;
    value++;
    return (void *)(uintptr_t)value;
}

int main(void)
{
    pthread_t thread;
    void *result = 0;

    if (pthread_create(&thread, 0, worker, (void *)(uintptr_t)6) != 0) {
        return 2;
    }
    if (pthread_join(thread, &result) != 0 || (uintptr_t)result != 7) {
        return 3;
    }

    pocketjs_perf_begin(19, 0);
    pocketjs_perf_end(19, 0);
    return 0;
}
