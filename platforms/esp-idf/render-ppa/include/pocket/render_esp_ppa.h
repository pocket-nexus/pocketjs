#pragma once
#include <stdbool.h>
#include "pocket_drivers.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Device-specific translation seam. Every callback is terminal, including
 * errors. UNSUPPORTED promises that it performed no writes. FAILED must stop
 * all hardware access and prevents software replay/display flush. */
typedef struct {
  size_t struct_size;
  void *context;
  int32_t (*fill)(void *, uint16_t *, size_t, uint32_t, uint32_t, pocket_rect, uint16_t);
  int32_t (*blend)(void *, uint16_t *, size_t, uint32_t, uint32_t, const uint8_t *, size_t, pocket_rect, uint8_t, uint8_t, uint8_t, uint8_t);
  int32_t (*srm)(void *, uint16_t *, size_t, uint32_t, uint32_t, const uint8_t *, size_t, uint32_t, uint32_t, pocket_rect, pocket_rect, uint32_t, bool, bool);
} pocket_ppa_ops;
typedef struct {
  size_t struct_size;
  uint32_t scale, min_fill_pixels, min_blend_pixels, min_srm_pixels;
  /* Maximum A8 payload bytes; aligned allocation adds at most 143 bytes.
   * Zero disables A8 acceleration while preserving fill/SRM and fallback. */
  size_t mask_budget;
} pocket_ppa_config;
typedef struct pocket_render_esp_ppa pocket_render_esp_ppa;
/* Config/ops are copied. The callback context must outlive this renderer.
 * Call destroy only after runtime destruction/unregistration. */
pocket_render_esp_ppa *pocket_render_esp_ppa_create(const pocket_ppa_config *, const pocket_ppa_ops *);
const pocket_renderer_v1 *pocket_render_esp_ppa_vtable(void);
void pocket_render_esp_ppa_destroy(pocket_render_esp_ppa *);
#ifdef __cplusplus
}
#endif
