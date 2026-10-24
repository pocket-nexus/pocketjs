#pragma once
#include "esp_err.h"
#include "pocket/render_esp_ppa.h"
#ifdef __cplusplus
extern "C" {
#endif
/* One Renderer over two PPA renderers that split every strip at a row: the
 * runtime's task renders the upper rows, a helper task pinned to
 * `helper_core` the lower ones, at the same time. The split follows the
 * strip's damaged rows and lands on a multiple of `row_alignment` raster
 * rows, so both halves keep the strip's DMA alignment. The two renderers
 * read the frame's resources concurrently; each needs its own PPA device.
 * Destroy this before either renderer, after runtime destruction. */
typedef struct pocketjs_esp32p4_ppa_lanes pocketjs_esp32p4_ppa_lanes_t;
esp_err_t pocketjs_esp32p4_ppa_lanes_create(pocket_render_esp_ppa *upper,
                                            pocket_render_esp_ppa *lower,
                                            int helper_core,
                                            uint32_t row_alignment,
                                            pocketjs_esp32p4_ppa_lanes_t **out);
const pocket_renderer_v1 *pocketjs_esp32p4_ppa_lanes_vtable(void);
void pocketjs_esp32p4_ppa_lanes_destroy(pocketjs_esp32p4_ppa_lanes_t *lanes);
#ifdef __cplusplus
}
#endif
