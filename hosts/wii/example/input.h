#ifndef POCKET_WII_EXAMPLE_INPUT_H
#define POCKET_WII_EXAMPLE_INPUT_H

#include <stdint.h>

#define POCKET_WII_WPAD_CHANNELS 4

typedef struct {
  uint32_t buttons;
  uint32_t analog;
  uint32_t pad_scan_mask;
  uint16_t pad1_raw_held;
  int pad1_probe;
  int wpad_status;
  int wpad_probe[POCKET_WII_WPAD_CHANNELS];
} pocket_wii_input_t;

int pocket_wii_input_init(uint32_t *pad_init_result);
void pocket_wii_input_poll(pocket_wii_input_t *input);

#endif
