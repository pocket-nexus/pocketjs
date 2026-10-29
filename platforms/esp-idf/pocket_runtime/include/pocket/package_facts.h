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
/* 0 = admitted: the first variant the exported profile facts satisfy
 * (binding generation, raster density, animation, rate, viewport,
 * presentation, capabilities, auxiliary surface). profile_hash is null or
 * 32 bytes and only orders variants. Non-zero codes: 1..5 a damaged file,
 * 6 no variant, 7 another binding generation, 8 no identity, 9 an unreadable
 * plan, 10..11 missing or unterminated JavaScript, 12 a bad argument,
 * 13..15 an unreadable plan fact, 17 a malformed layout, 18 a worker section
 * mismatch, 19..25 the first failed admission item (raster density,
 * animation, rate, viewport, presentation, capability, auxiliary).
 * Initialize out->struct_size. */
int32_t pocket_idf_package_open(const uint8_t *bytes, size_t length,
                                const pocket_profile_facts *facts,
                                uint32_t host_abi,
                                const uint8_t *profile_hash,
                                pocket_idf_package_facts *out);
#ifdef __cplusplus
}
#endif
