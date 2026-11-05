#pragma once
#include <stddef.h>
#include <stdint.h>
#include "pocket_runtime.h"
#ifdef __cplusplus
extern "C" {
#endif
/* What a launcher program reads from a stored .pocket before booting it
 * (programs/esp-idf/archive/src/package_facts.rs). Pointers borrow the
 * caller's bytes. aux_width and aux_height are 0 without an auxiliary
 * surface; slot is the first 16 hex digits of SHA-256 of the app id,
 * NUL-terminated. */
typedef struct {
  size_t struct_size;
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint64_t variant_hash;
  uint32_t view_width, view_height, raster_density, aux_width, aux_height;
  uint32_t features;
  char slot[17];
} pocket_idf_package_facts;
#define POCKET_IDF_FEATURE_FS 1U
#define POCKET_IDF_FEATURE_CAMERA_QR 2U
#define POCKET_IDF_FEATURE_CAMERA_PHOTO 4U
#define POCKET_IDF_FEATURE_MEDIA 8U
#define POCKET_IDF_FEATURE_AUDIO_PCM 16U
#define POCKET_IDF_FEATURE_AUDIO_CAPTURE 32U
#define POCKET_IDF_FEATURE_DEVICE 64U
/* Returns the POCKET_PACKAGE_OPEN_* codes of pocket_runtime.h.
 * POCKET_PACKAGE_OPEN_OK = admitted: the first variant the exported profile
 * facts satisfy (binding generation, raster density, animation, rate,
 * viewport, presentation, capabilities, auxiliary surface). profile_hash is
 * null or 32 bytes and only orders variants. The other codes name a damaged
 * file, a package without a variant, the first failed admission item, a
 * missing identity or JavaScript section, a bad argument or a short record
 * (BAD_ARGUMENT), and a plan fact that cannot be read (PLAN_JSON,
 * PLAN_VIEWPORT, PLAN_AUXILIARY). Initialize out->struct_size. */
int32_t pocket_idf_package_open(const uint8_t *bytes, size_t length,
                                const pocket_profile_facts *facts,
                                uint32_t host_abi,
                                const uint8_t *profile_hash,
                                pocket_idf_package_facts *out);
#ifdef __cplusplus
}
#endif
