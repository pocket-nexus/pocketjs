#ifndef POCKET_3DS_HID_H
#define POCKET_3DS_HID_H
#include <stddef.h>
#include <stdint.h>
/* Call hidScanInput once before this frame's reads. No keys are reserved. */
void pocket_3ds_hid_init(void);
void pocket_3ds_hid_shutdown(void);
int32_t pocket_3ds_hid_buttons(void);
int32_t pocket_3ds_hid_analog(void);
int32_t pocket_3ds_hid_right_analog(void);
size_t pocket_3ds_hid_touch(uint32_t *packed);
#endif
