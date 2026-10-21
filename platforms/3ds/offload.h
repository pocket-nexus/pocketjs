#ifndef POCKET_OFFLOAD_H
#define POCKET_OFFLOAD_H
#include <stdbool.h>
#include <stddef.h>
bool offload_start(void);
void offload_stop(void);
void offload_frame(void);
void offload_measure(unsigned microseconds);
int offload_session(void);
bool offload_submit(const char *bytes, size_t length);
size_t offload_take(char *out);
#endif
