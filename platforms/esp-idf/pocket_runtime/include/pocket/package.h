#pragma once
#include "pocket_runtime.h"
typedef struct {
  const uint8_t *data;
  size_t size;
} pocketjs_embedded_package_t;
typedef enum {
  POCKETJS_PRESENTATION_FILL,
  POCKETJS_PRESENTATION_FIT,
  POCKETJS_PRESENTATION_INTEGER_FIT,
  POCKETJS_PRESENTATION_NATIVE,
  POCKETJS_PRESENTATION_STRETCH
} pocketjs_presentation_t;
/* Compiler-owned host facts. Runtime performs package admission. */
typedef struct {
  size_t struct_size;
  const char *target_id;
  uint32_t host_abi, tick_hz, logical_width, logical_height, physical_width,
      physical_height, raster_density;
  pocketjs_presentation_t presentation;
  uint8_t profile_hash[32];
} pocketjs_package_host_contract_t;
