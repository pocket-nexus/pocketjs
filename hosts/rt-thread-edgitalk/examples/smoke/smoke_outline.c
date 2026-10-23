/*
 * Headless RGB565 smoke outline for RT-Thread / Edgi-Talk (PSoC E84 M55).
 *
 * OUTLINE ONLY — not wired into a board image or host CI yet.
 * Mirrors hosts/esp-idf/examples/smoke/main/main.c:
 *   package open/select → guest + ui_core + ui_qjs → one ui_turn →
 *   rgb565 prepare / render_strip / commit into a RAM strip, fake present.
 *
 * Build later via product/BSP SCons that includes
 * hosts/rt-thread-edgitalk/native/SConscript. Requires RT-Thread + QuickJS +
 * embedded package symbols (see native/generated/).
 *
 * Do not expect this file to compile on a plain Linux host without the BSP.
 */

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* PocketJS shared ESP-component headers (via SCons include paths). */
#include "pocketjs/guest.h"
#include "pocketjs/package.h"
#include "pocketjs/render_rgb565.h"
#include "pocketjs/ui_core.h"
#include "pocketjs/ui_qjs.h"

/* Product/embed supplies these in a real image; placeholders for the outline. */
extern const uint8_t pocketjs_smoke_package_bytes[];
extern const size_t pocketjs_smoke_package_size;
extern const pocketjs_package_host_contract_t pocketjs_smoke_host_contract;

/* Fake present: copy strip into a full-frame RAM buffer (no LCD). */
static uint16_t *g_fb;
static uint32_t g_fb_w;
static uint32_t g_fb_h;

static void fake_present_strip(uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                               const uint16_t *strip) {
  (void)x;
  for (uint32_t row = 0; row < h; ++row) {
    memcpy(g_fb + (size_t)(y + row) * g_fb_w, strip + (size_t)row * w,
           (size_t)w * sizeof(uint16_t));
  }
}

/*
 * Entry name is illustrative. A real RT-Thread app would use INIT_APP_EXPORT
 * or a product main that calls into the host loop / board hooks instead.
 */
void pocketjs_rtt_smoke_outline(void) {
  pocketjs_package_t *package = NULL;
  if (pocketjs_package_open(pocketjs_smoke_package_bytes,
                            pocketjs_smoke_package_size, 0, &package) != 0) {
    return;
  }

  pocketjs_package_variant_t app = {.struct_size = sizeof(app)};
  if (pocketjs_package_select(package, &pocketjs_smoke_host_contract, &app) !=
      0) {
    pocketjs_package_close(package);
    return;
  }

  pocketjs_guest_config_t guest_config;
  pocketjs_guest_config_defaults(&guest_config);
  /* Product typically sets prefer_psram + large heap; outline leaves defaults. */
  pocketjs_guest_t *guest = NULL;
  if (pocketjs_guest_create(&guest_config, &guest) != 0) {
    pocketjs_package_close(package);
    return;
  }

  pocketjs_ui_core_config_t core_config;
  pocketjs_ui_core_config_defaults(&core_config);
  core_config.logical_width = pocketjs_smoke_host_contract.logical_width;
  core_config.logical_height = pocketjs_smoke_host_contract.logical_height;
  core_config.raster_density = pocketjs_smoke_host_contract.raster_density;
  core_config.tick_hz = pocketjs_smoke_host_contract.tick_hz;
  pocketjs_ui_core_t *core = NULL;
  if (pocketjs_ui_core_create(&core_config, &core) != 0) {
    pocketjs_guest_destroy(guest);
    pocketjs_package_close(package);
    return;
  }

  const pocketjs_ui_qjs_config_t binding_config = {
      .struct_size = sizeof(binding_config),
      .target_id = pocketjs_smoke_host_contract.target_id,
      .host_abi = pocketjs_smoke_host_contract.host_abi,
  };
  pocketjs_ui_qjs_t *binding = NULL;
  if (pocketjs_ui_qjs_create(guest, core, &binding_config, &binding) != 0) {
    pocketjs_ui_core_destroy(core);
    pocketjs_guest_destroy(guest);
    pocketjs_package_close(package);
    return;
  }

  /* Mount + eval omitted in outline — see IDF smoke / pocketjs_host_loop.c. */

  pocketjs_ui_frame_view_t frame = {.struct_size = sizeof(frame)};
  pocketjs_ui_input_t input = {.struct_size = sizeof(input)};
  (void)pocketjs_ui_turn(binding, &input, &frame);

  pocketjs_rgb565_renderer_config_t renderer_config;
  pocketjs_rgb565_renderer_config_defaults(&renderer_config);
  renderer_config.scale = pocketjs_smoke_host_contract.raster_density;
  pocketjs_rgb565_renderer_t *renderer = NULL;
  pocketjs_rgb565_target_t *target = NULL;
  if (pocketjs_rgb565_renderer_create(&renderer_config, &renderer) != 0 ||
      pocketjs_rgb565_target_create(&target) != 0) {
    goto cleanup;
  }

  g_fb_w = frame.logical_width * pocketjs_smoke_host_contract.raster_density;
  g_fb_h = frame.logical_height * pocketjs_smoke_host_contract.raster_density;
  /* Real image: allocate via heap_caps (HyperRAM). Outline leaves NULL-safe. */
  g_fb = NULL;

  pocketjs_rgb565_damage_plan_t plan = {.struct_size = sizeof(plan)};
  if (pocketjs_rgb565_prepare(renderer, target, &frame, &plan) != 0) {
    goto cleanup_renderer;
  }

  for (uint32_t i = 0; i < plan.region_count; ++i) {
    const pocketjs_rgb565_rect_t region = plan.regions[i];
    const size_t pixels = (size_t)frame.logical_width * region.height *
                          pocketjs_smoke_host_contract.raster_density;
    uint16_t *strip = NULL; /* allocate in real BSP build */
    (void)pixels;
    (void)strip;
    (void)fake_present_strip;
    /* pocketjs_rgb565_render_strip(...); fake_present_strip(...); */
  }
  (void)pocketjs_rgb565_commit(renderer, target, &frame);

  /* TODO(board-CI): log FNV frame hash like IDF smoke PASS line. */

cleanup_renderer:
  pocketjs_rgb565_target_destroy(target);
  pocketjs_rgb565_renderer_destroy(renderer);
cleanup:
  pocketjs_ui_qjs_destroy(binding);
  pocketjs_ui_core_destroy(core);
  pocketjs_guest_destroy(guest);
  pocketjs_package_close(package);
}
