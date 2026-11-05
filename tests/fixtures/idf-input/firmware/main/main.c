#include "pocket/input_touch.h"
#include "pocket/input_gpio.h"
#include "pocket_runtime.h"
#include <assert.h>
void app_main(void) {
  assert(!pocket_input_touch_create(NULL));
  assert(!pocket_input_gpio_create(NULL));
  pocket_tick_schedule *clock=pocket_tick_schedule_create(60,0,1000000);
  assert(clock); pocket_tick_schedule_destroy(clock);
}
