#ifndef POCKET_TEST_3DS_H
#define POCKET_TEST_3DS_H
#include <stdint.h>
#include <stdlib.h>
#include <pthread.h>
#include <time.h>
typedef uint64_t u64;
#define U64_MAX UINT64_MAX
typedef struct TestThread { pthread_t id; void (*run)(void *); void *data; } *Thread;
static inline uint64_t osGetTime(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static inline void svcSleepThread(int64_t ns) { struct timespec t = { ns / 1000000000, ns % 1000000000 }; nanosleep(&t, NULL); }
static inline void *test_thread_start(void *p) { Thread t = p; t->run(t->data); return NULL; }
static inline Thread threadCreate(void (*run)(void *), void *data, size_t stack, int priority, int core, int detached) {
  (void)stack; (void)priority; (void)core; (void)detached;
  Thread t = calloc(1, sizeof *t); t->run = run; t->data = data;
  if (pthread_create(&t->id, NULL, test_thread_start, t)) { free(t); return NULL; } return t;
}
static inline void threadJoin(Thread t, uint64_t timeout) { (void)timeout; pthread_join(t->id, NULL); }
static inline void threadFree(Thread t) { free(t); }
#endif
