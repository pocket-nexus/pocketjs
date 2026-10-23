/* KeyOS libc shim: QuickJS runs on one thread here, and cutils.h wraps these
 * calls for Atomics.wait, worker threads and one-time init. The once guard
 * runs its callback, the lock and condition calls do nothing, and thread
 * creation fails with EAGAIN. */
#ifndef POCKET_KEYOS_PTHREAD_H
#define POCKET_KEYOS_PTHREAD_H
#include <time.h>

typedef int pthread_once_t;
typedef int pthread_mutex_t;
typedef int pthread_cond_t;
typedef int pthread_condattr_t;
typedef int pthread_attr_t;
typedef unsigned long pthread_t;

#define PTHREAD_ONCE_INIT 0
#define PTHREAD_CREATE_JOINABLE 0
#define PTHREAD_CREATE_DETACHED 1

static inline int pthread_once(pthread_once_t *guard, void (*callback)(void)) {
    if (!*guard) {
        *guard = 1;
        callback();
    }
    return 0;
}
static inline int pthread_mutex_init(pthread_mutex_t *m, const void *attr) { (void)m; (void)attr; return 0; }
static inline int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
static inline int pthread_condattr_init(pthread_condattr_t *a) { (void)a; return 0; }
static inline int pthread_condattr_setclock(pthread_condattr_t *a, clockid_t c) { (void)a; (void)c; return 0; }
static inline int pthread_condattr_destroy(pthread_condattr_t *a) { (void)a; return 0; }
static inline int pthread_cond_init(pthread_cond_t *c, const pthread_condattr_t *a) { (void)c; (void)a; return 0; }
static inline int pthread_cond_destroy(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_cond_signal(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_cond_broadcast(pthread_cond_t *c) { (void)c; return 0; }
static inline int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) { (void)c; (void)m; return 0; }
static inline int pthread_cond_timedwait(pthread_cond_t *c, pthread_mutex_t *m, const struct timespec *t) {
    (void)c; (void)m; (void)t;
    return 110; /* ETIMEDOUT */
}
static inline int pthread_attr_init(pthread_attr_t *a) { (void)a; return 0; }
static inline int pthread_attr_destroy(pthread_attr_t *a) { (void)a; return 0; }
static inline int pthread_attr_setstacksize(pthread_attr_t *a, size_t size) { (void)a; (void)size; return 0; }
static inline int pthread_attr_setdetachstate(pthread_attr_t *a, int state) { (void)a; (void)state; return 0; }
static inline int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*start)(void *), void *arg) {
    (void)t; (void)a; (void)start; (void)arg;
    return 11; /* EAGAIN */
}
static inline int pthread_join(pthread_t t, void **result) { (void)t; (void)result; return 0; }
#endif
