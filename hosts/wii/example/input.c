#include <ogc/pad.h>
#include <wiiuse/wpad.h>

#include "input.h"
#include "input_map.h"
#include "pocket_wii.h"

int pocket_wii_input_init(uint32_t *pad_init_result) {
  int wpad_result = WPAD_Init();
  *pad_init_result = PAD_Init();
  return wpad_result;
}

void pocket_wii_input_poll(pocket_wii_input_t *input) {
  uint32_t remote_held = 0;
  uint32_t nunchuk_held = 0;
  uint32_t classic_held = 0;
  uint32_t gamecube_held = 0;
  int analog_set = 0;

  WPAD_ScanPads();
  input->pad_scan_mask = PAD_ScanPads();
  input->pad1_probe = input->pad_scan_mask & (1u << PAD_CHAN0)
      ? PAD_ERR_NONE : PAD_ERR_NO_CONTROLLER;
  input->wpad_status = WPAD_GetStatus();
  for (int channel = WPAD_CHAN_0; channel <= WPAD_CHAN_3; ++channel) {
    uint32_t held = WPAD_ButtonsHeld(channel);
    uint32_t extension_held = held & UINT32_C(0xffff0000);
    uint32_t expansion = 0;
    int probe = WPAD_Probe(channel, &expansion);
    remote_held |= held & UINT32_C(0x0000ffff);
    input->wpad_probe[channel] = probe;
    if (probe != WPAD_ERR_NONE) continue;
    if (expansion == WPAD_EXP_NUNCHUK) nunchuk_held |= extension_held;
    if (expansion == WPAD_EXP_CLASSIC) classic_held |= extension_held;
    if (expansion == WPAD_EXP_NUNCHUK && !analog_set) {
      const WPADData *data = WPAD_Data(channel);
      if (data != NULL) {
        const joystick_t *stick = &data->exp.nunchuk.js;
        input->analog = pocket_wii_map_stick(
            stick->pos.x, stick->pos.y,
            stick->min.x, stick->center.x, stick->max.x,
            stick->min.y, stick->center.y, stick->max.y);
        analog_set = 1;
      }
    }
  }
  for (int channel = PAD_CHAN0; channel < PAD_CHANMAX; ++channel) {
    uint16_t held = PAD_ButtonsHeld(channel);
    if (channel == PAD_CHAN0) input->pad1_raw_held = held;
    gamecube_held |= held;
  }

  input->buttons = pocket_wii_map_buttons(
      remote_held, nunchuk_held, classic_held, gamecube_held);
  if (!analog_set) input->analog = POCKET_WII_ANALOG_CENTER;
}
