#include "pocketjs/package.h"
#include "pocketjs/package_format.h"

#include <stdlib.h>
#include <string.h>

struct pocketjs_package {
  const uint8_t *bytes;
  size_t size;
  size_t manifest_size;
  size_t variants_offset;
  uint32_t variant_count;
};

static bool range_valid(size_t offset, size_t length, size_t total) {
  return offset <= total && length <= total - offset;
}

static bool read_u32(const uint8_t *bytes, size_t size, size_t offset,
                     uint32_t *out) {
  if (out == NULL || !range_valid(offset, 4U, size)) {
    return false;
  }
  *out = (uint32_t)bytes[offset] | ((uint32_t)bytes[offset + 1U] << 8U) |
         ((uint32_t)bytes[offset + 2U] << 16U) |
         ((uint32_t)bytes[offset + 3U] << 24U);
  return true;
}

static bool read_u64(const uint8_t *bytes, size_t size, size_t offset,
                     uint64_t *out) {
  uint32_t low = 0;
  uint32_t high = 0;
  if (out == NULL || !read_u32(bytes, size, offset, &low) ||
      !read_u32(bytes, size, offset + 4U, &high)) {
    return false;
  }
  *out = (uint64_t)low | ((uint64_t)high << 32U);
  return true;
}

static uint64_t fnv1a64(const uint8_t *bytes, size_t size) {
  uint64_t hash = UINT64_C(0xcbf29ce484222325);
  for (size_t index = 0; index < size; ++index) {
    hash ^= bytes[index];
    hash *= UINT64_C(0x100000001b3);
  }
  return hash;
}

static bool align16(size_t value, size_t *out) {
  if (out == NULL || value > SIZE_MAX - (POCKET_ALIGN - 1U)) {
    return false;
  }
  *out = (value + (POCKET_ALIGN - 1U)) & ~(size_t)(POCKET_ALIGN - 1U);
  return true;
}

static bool tables_valid(const uint8_t *bytes, size_t end, size_t table,
                         uint32_t count) {
  for (uint32_t i = 0; i < count; ++i) {
    const size_t entry = table + (size_t)i * POCKET_VARIANT_SIZE;
    if (bytes[entry] == 0U ||
        memchr(bytes + entry, 0, POCKET_TARGET_BYTES) == NULL)
      return false;
    uint32_t sections, offset;
    if (!read_u32(bytes, end, entry + OFFSET_VARIANT_SECTION_COUNT,
                  &sections) ||
        !read_u32(bytes, end, entry + OFFSET_VARIANT_SECTIONS_OFFSET,
                  &offset) ||
        sections > end / POCKET_SECTION_SIZE ||
        !range_valid(offset, (size_t)sections * POCKET_SECTION_SIZE, end))
      return false;
    for (uint32_t j = 0; j < sections; ++j) {
      const size_t section = offset + (size_t)j * POCKET_SECTION_SIZE;
      uint32_t data, length;
      if (!read_u32(bytes, end, section + OFFSET_SECTION_OFFSET, &data) ||
          !read_u32(bytes, end, section + OFFSET_SECTION_SIZE, &length) ||
          !range_valid(data, length, end))
        return false;
    }
  }
  return true;
}

esp_err_t pocketjs_package_open(const void *data, size_t size, uint32_t flags,
                                pocketjs_package_t **out_package) {
  if (data == NULL || out_package == NULL ||
      (flags & ~POCKETJS_PACKAGE_OPEN_SKIP_HASH) != 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_package = NULL;
  if (size < POCKET_HEADER_SIZE + POCKET_FOOTER_SIZE) {
    return ESP_ERR_INVALID_SIZE;
  }
  const uint8_t *bytes = data;
  uint32_t magic = 0;
  uint32_t version = 0;
  uint32_t manifest_size = 0;
  uint32_t variant_count = 0;
  if (!read_u32(bytes, size, 0, &magic) || magic != POCKET_MAGIC ||
      !read_u32(bytes, size, 4, &version) || version != POCKET_VERSION ||
      !read_u32(bytes, size, 8, &manifest_size) ||
      !read_u32(bytes, size, 12, &variant_count)) {
    return ESP_ERR_INVALID_RESPONSE;
  }
  if ((flags & POCKETJS_PACKAGE_OPEN_SKIP_HASH) == 0U) {
    uint64_t expected = 0;
    if (!read_u64(bytes, size, size - POCKET_FOOTER_SIZE, &expected) ||
        fnv1a64(bytes, size - POCKET_FOOTER_SIZE) != expected) {
      return ESP_ERR_INVALID_CRC;
    }
  }
  size_t variants_offset = 0;
  if (!range_valid(POCKET_HEADER_SIZE, manifest_size,
                   size - POCKET_FOOTER_SIZE) ||
      !align16(POCKET_HEADER_SIZE + (size_t)manifest_size, &variants_offset) ||
      variant_count > (size - POCKET_FOOTER_SIZE) / POCKET_VARIANT_SIZE ||
      !range_valid(variants_offset, (size_t)variant_count * POCKET_VARIANT_SIZE,
                   size - POCKET_FOOTER_SIZE) ||
      !tables_valid(bytes, size - POCKET_FOOTER_SIZE, variants_offset,
                    variant_count)) {
    return ESP_ERR_INVALID_SIZE;
  }
  pocketjs_package_t *package = calloc(1, sizeof(*package));
  if (package == NULL) {
    return ESP_ERR_NO_MEM;
  }
  package->bytes = bytes;
  package->size = size;
  package->manifest_size = manifest_size;
  package->variants_offset = variants_offset;
  package->variant_count = variant_count;
  *out_package = package;
  return ESP_OK;
}

void pocketjs_package_close(pocketjs_package_t *package) { free(package); }

pocketjs_bytes_t pocketjs_package_manifest(const pocketjs_package_t *package) {
  if (package == NULL) {
    return (pocketjs_bytes_t){0};
  }
  return (pocketjs_bytes_t){
      .data = package->bytes + POCKET_HEADER_SIZE,
      .size = package->manifest_size,
  };
}

static bool target_matches(const uint8_t *field, const char *target) {
  size_t length = 0;
  while (length < POCKETJS_PACKAGE_TARGET_BYTES && target[length] != '\0') {
    ++length;
  }
  if (length == 0U || length >= POCKETJS_PACKAGE_TARGET_BYTES) {
    return false;
  }
  return memcmp(field, target, length) == 0 && field[length] == 0;
}

static esp_err_t section_at(const pocketjs_package_t *package,
                            size_t sections_offset, uint32_t section_count,
                            uint32_t wanted, pocketjs_bytes_t *out) {
  *out = (pocketjs_bytes_t){0};
  if (section_count >
          (package->size - POCKET_FOOTER_SIZE) / POCKET_SECTION_SIZE ||
      !range_valid(sections_offset, (size_t)section_count * POCKET_SECTION_SIZE,
                   package->size - POCKET_FOOTER_SIZE)) {
    return ESP_ERR_INVALID_SIZE;
  }
  for (uint32_t index = 0; index < section_count; ++index) {
    const size_t entry = sections_offset + (size_t)index * POCKET_SECTION_SIZE;
    uint32_t kind = 0;
    uint32_t offset = 0;
    uint32_t length = 0;
    if (!read_u32(package->bytes, package->size, entry, &kind) ||
        !read_u32(package->bytes, package->size, entry + OFFSET_SECTION_OFFSET,
                  &offset) ||
        !read_u32(package->bytes, package->size, entry + OFFSET_SECTION_SIZE,
                  &length) ||
        !range_valid(offset, length, package->size - POCKET_FOOTER_SIZE)) {
      return ESP_ERR_INVALID_SIZE;
    }
    if (kind == wanted) {
      out->data = package->bytes + offset;
      out->size = length;
      return ESP_OK;
    }
  }
  return ESP_ERR_NOT_FOUND;
}

static bool
host_inputs_match(const pocketjs_bytes_t inputs,
                  const pocketjs_package_host_contract_t *contract,
                  uint8_t out_plan_hash[POCKETJS_PACKAGE_HASH_BYTES]) {
  if (inputs.size != HOST_INPUTS_SIZE) {
    return false;
  }
  uint32_t fields[10] = {0};
  for (size_t index = 0; index < 10U; ++index) {
    if (!read_u32(inputs.data, inputs.size, index * 4U, &fields[index])) {
      return false;
    }
  }
  if (fields[0] != HOST_INPUTS_MAGIC || fields[1] != HOST_INPUTS_VERSION ||
      fields[2] != contract->host_abi || fields[3] != contract->tick_hz ||
      fields[4] != contract->logical_width ||
      fields[5] != contract->logical_height ||
      fields[6] != contract->physical_width ||
      fields[7] != contract->physical_height ||
      fields[8] != contract->raster_density ||
      fields[9] != (uint32_t)contract->presentation ||
      memcmp(inputs.data + OFFSET_HOST_INPUTS_PROFILE_HASH,
             contract->profile_hash, POCKETJS_PACKAGE_HASH_BYTES) != 0) {
    return false;
  }
  memcpy(out_plan_hash, inputs.data + OFFSET_HOST_INPUTS_PLAN_HASH,
         POCKETJS_PACKAGE_HASH_BYTES);
  return true;
}

esp_err_t
pocketjs_package_select(const pocketjs_package_t *package,
                        const pocketjs_package_host_contract_t *contract,
                        pocketjs_package_variant_t *out_variant) {
  if (package == NULL || contract == NULL || out_variant == NULL ||
      contract->struct_size < sizeof(*contract) ||
      out_variant->struct_size < sizeof(*out_variant) ||
      contract->target_id == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  const size_t output_size = out_variant->struct_size;
  memset(out_variant, 0, sizeof(*out_variant));
  out_variant->struct_size = output_size;
  for (uint32_t index = 0; index < package->variant_count; ++index) {
    const size_t entry =
        package->variants_offset + (size_t)index * POCKET_VARIANT_SIZE;
    if (!target_matches(package->bytes + entry, contract->target_id)) {
      continue;
    }
    uint32_t host_abi = 0;
    uint32_t section_count = 0;
    uint32_t sections_offset = 0;
    if (!read_u32(package->bytes, package->size,
                  entry + OFFSET_VARIANT_HOST_ABI, &host_abi) ||
        !read_u32(package->bytes, package->size,
                  entry + OFFSET_VARIANT_SECTION_COUNT, &section_count) ||
        !read_u32(package->bytes, package->size,
                  entry + OFFSET_VARIANT_SECTIONS_OFFSET, &sections_offset) ||
        !read_u64(package->bytes, package->size, entry + OFFSET_VARIANT_HASH,
                  &out_variant->variant_hash)) {
      return ESP_ERR_INVALID_SIZE;
    }
    if (host_abi != contract->host_abi) {
      return ESP_ERR_INVALID_VERSION;
    }
    pocketjs_bytes_t host_inputs = {0};
    esp_err_t result = section_at(package, sections_offset, section_count,
                                  SECTION_HOST_INPUTS, &host_inputs);
    if (result != ESP_OK ||
        !host_inputs_match(host_inputs, contract, out_variant->plan_hash)) {
      return ESP_ERR_INVALID_STATE;
    }
    result = section_at(package, sections_offset, section_count, SECTION_JS,
                        &out_variant->javascript);
    if (result != ESP_OK || out_variant->javascript.size < 1U ||
        out_variant->javascript.data[out_variant->javascript.size - 1U] != 0U) {
      return ESP_ERR_INVALID_RESPONSE;
    }
    result = section_at(package, sections_offset, section_count, SECTION_PAK,
                        &out_variant->pak);
    if (result != ESP_OK) {
      return result;
    }
    result = section_at(package, sections_offset, section_count, SECTION_PLAN,
                        &out_variant->plan_json);
    return result;
  }
  return ESP_ERR_NOT_FOUND;
}
