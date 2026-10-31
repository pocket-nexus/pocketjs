#pragma once
#include <stddef.h>
#include <stdint.h>
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
/* 0 = admitted for target, host_abi and the expected profile hash (32
 * bytes). Non-zero codes: 1..5 a damaged file, 6 no variant for the target,
 * 7 another binding generation, 8..11 a variant missing its identity, plan
 * or JavaScript, 12 a bad argument, 13..15 an unreadable plan, 16 another
 * profile, 17 a malformed layout. Initialize out->struct_size. */
int32_t pocket_idf_package_open(const uint8_t *bytes, size_t length,
                                const uint8_t *target, size_t target_length,
                                uint32_t host_abi,
                                const uint8_t *expected_profile_hash,
                                pocket_idf_package_facts *out);
#ifdef __cplusplus
}
#endif
