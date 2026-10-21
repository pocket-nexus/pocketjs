#ifndef POCKET_LEGACY_INPUT_TYPES_H
#define POCKET_LEGACY_INPUT_TYPES_H
#include <stdint.h>

/* Compatibility input records for native program adapters. These are not the
 * public driver ABI. The adapter converts them into generated PocketInputFrame
 * facts before dispatch to the canonical runtime. */
typedef enum {
  POCKET_TOUCH_DOWN,
  POCKET_TOUCH_MOVE,
  POCKET_TOUCH_UP,
  POCKET_TOUCH_CANCEL
} PocketTouchPhase;

#define POCKET_RUNTIME_MAX_CONTACTS 8
typedef struct {
  int id;
  int x;
  int y;
  int hit;
} PocketRuntimeContact;
typedef struct {
  uint32_t buttons;
  unsigned int contact_count;
  PocketRuntimeContact contacts[POCKET_RUNTIME_MAX_CONTACTS];
  unsigned int cancelled_count;
  int cancelled[POCKET_RUNTIME_MAX_CONTACTS];
} PocketRuntimeContactsInput;
/* Bit 30 is a terminal CANCEL record, not an active contact. At most eight
 * active contacts and eight cancellations travel in one frame's touch words. */
#define POCKET_TOUCH_CANCEL_WORD 0x40000000U
static inline uint32_t pocket_legacy_runtime_pack_contact(const PocketRuntimeContact *contact) {
  uint32_t id = (uint32_t)(contact->id & 255);
  uint32_t x = (uint32_t)(contact->x < 0 ? 0 : contact->x > 1023 ? 1023 : contact->x);
  uint32_t y = (uint32_t)(contact->y < 0 ? 0 : contact->y > 1023 ? 1023 : contact->y);
  return x > 511 || y > 511 ? 0x80000000U | (id << 20) | (y << 10) | x : (id << 18) | (y << 9) | x;
}
static inline uint32_t pocket_legacy_runtime_pack_cancel(int id) {
  return POCKET_TOUCH_CANCEL_WORD | ((uint32_t)(id & 255) << 18);
}
#endif
