#ifndef POCKET_WII_H
#define POCKET_WII_H

#include <stddef.h>
#include <stdint.h>

/* PocketJS Wii host. One guest may be active at a time. */

#define POCKET_WII_BTN_SELECT   UINT32_C(0x0001)
#define POCKET_WII_BTN_START    UINT32_C(0x0008)
#define POCKET_WII_BTN_UP       UINT32_C(0x0010)
#define POCKET_WII_BTN_RIGHT    UINT32_C(0x0020)
#define POCKET_WII_BTN_DOWN     UINT32_C(0x0040)
#define POCKET_WII_BTN_LEFT     UINT32_C(0x0080)
#define POCKET_WII_BTN_LTRIGGER UINT32_C(0x0100)
#define POCKET_WII_BTN_RTRIGGER UINT32_C(0x0200)
#define POCKET_WII_BTN_TRIANGLE UINT32_C(0x1000)
#define POCKET_WII_BTN_CIRCLE   UINT32_C(0x2000)
#define POCKET_WII_BTN_CROSS    UINT32_C(0x4000)
#define POCKET_WII_BTN_SQUARE   UINT32_C(0x8000)
#define POCKET_WII_ANALOG_CENTER UINT32_C(0x8080)

/*
 * All operations that return int32_t use 0 for success and nonzero for
 * failure. On failure, pocket_wii_last_error() contains a NUL-terminated
 * message. Its library-owned string remains valid until the next boot, tick,
 * draw, or shutdown call; querying it does not invalidate the string.
 */

/*
 * Verify and boot one .pocket guest. On success, package_bytes is borrowed
 * unchanged until pocket_wii_shutdown(); the caller must keep it readable
 * for that whole time. A failed boot leaves no package buffer retained.
 */
int32_t pocket_wii_boot(const uint8_t *package_bytes, size_t package_length);

/*
 * Advance one fixed simulation step (exactly 1/60 second). buttons uses the
 * PocketJS BTN mask above. analog packs raw 0..255 axes as (x << 8) | y;
 * each axis value 128 is centered, so no stick is POCKET_WII_ANALOG_CENTER.
 */
int32_t pocket_wii_tick(uint32_t buttons, uint32_t analog);

/*
 * Emit the guest's DrawList into the current caller-owned GX frame. The
 * destination rectangle is in GX target pixel coordinates; the guest's
 * logical surface is 480x272. Width and height must be nonzero. The caller
 * owns GX initialization, frame begin/end, copy, swap, and vblank, and must
 * rebind any GX state it needs after this call.
 */
int32_t pocket_wii_draw(
  int32_t x,
  int32_t y,
  uint32_t width,
  uint32_t height
);

/* Returns the most recent error message, or an empty string if there is none. */
const char *pocket_wii_last_error(void);

/* Release the guest, core, and GX resources. Safe when no guest is active. */
void pocket_wii_shutdown(void);

#endif
