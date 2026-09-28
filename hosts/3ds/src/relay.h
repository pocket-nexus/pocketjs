#ifndef POCKET_RELAY_H
#define POCKET_RELAY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The complete-record L0 lane in contracts/spec/relay-channel.ts. The
 * caller owns its input until send returns and its output after take returns. */
bool relay_start(void);
bool relay_available(void);
void relay_stop(void);
void relay_reset(void);
void relay_frame(void);
int relay_session(void);
bool relay_send(const uint8_t *record, size_t length);
size_t relay_take(uint8_t *into, size_t capacity);
void relay_stats(char *into, size_t capacity);

#endif
