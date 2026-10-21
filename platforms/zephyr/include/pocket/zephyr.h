#pragma once
#include "pocket_runtime.h"
#include <stdbool.h>
#include <zephyr/device.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Microsecond monotonic clock. Context is unused. */
const pocket_clock_v1 *pocket_zephyr_clock(void);

typedef struct pocket_zephyr_display pocket_zephyr_display;
typedef struct {
  size_t struct_size;
  const struct device *device;
  uint32_t role, strip_rows;
  size_t frame_buffer_budget;
} pocket_zephyr_display_config;
/* The product configures pixel format/orientation before creation. RGB565 and
 * ARGB8888 are accepted. display_write must obey Zephyr's synchronous buffer
 * lifetime: return ends every access to the supplied buffer, including errors.
 * Creation, runtime calls, invalidate and destroy run on the same thread.
 */
pocket_zephyr_display *pocket_zephyr_display_create(const pocket_zephyr_display_config *);
const pocket_display_output_v1 *pocket_zephyr_display_vtable(void);
size_t pocket_zephyr_display_buffer_bytes(const pocket_zephyr_display *);
void pocket_zephyr_display_invalidate(pocket_zephyr_display *);
void pocket_zephyr_display_destroy(pocket_zephyr_display *);

typedef struct pocket_zephyr_input pocket_zephyr_input;
typedef struct { uint16_t code; uint32_t buttons; } pocket_zephyr_key;
typedef struct {
  size_t struct_size;
  const struct device *device;
  const pocket_zephyr_key *keys;
  size_t key_count;
  bool touch;
  uint32_t surface;
  float scale_x, scale_y;
} pocket_zephyr_input_config;
/* Copies up to 32 key mappings. ABS_X/ABS_Y + BTN_TOUCH form one contact (id 0).
 * Values become visible at the input subsystem's sync boundary. Input callbacks
 * may run on another thread; poll/reset/destroy must be serialized by the host.
 */
pocket_zephyr_input *pocket_zephyr_input_create(const pocket_zephyr_input_config *);
const pocket_input_source_v1 *pocket_zephyr_input_vtable(void);
void pocket_zephyr_input_cancel(pocket_zephyr_input *);
void pocket_zephyr_input_destroy(pocket_zephyr_input *);
#ifdef __cplusplus
}
#endif
