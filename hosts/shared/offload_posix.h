#ifndef POCKET_OFFLOAD_POSIX_H
#define POCKET_OFFLOAD_POSIX_H
#include <stddef.h>
#include <stdint.h>
/* The worker owns sockets and key-file reads. Guest calls only copy queues. */
void pocket_offload_start(const char *key_path, unsigned port);
void pocket_offload_stop(void);
unsigned pocket_offload_session(void);
int pocket_offload_submit(const char *bytes, size_t length);
size_t pocket_offload_take(char *bytes);
#endif
