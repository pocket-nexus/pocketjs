#ifndef POCKET_ASSET_PACK_FORMAT_H
#define POCKET_ASSET_PACK_FORMAT_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#define PACK_HEADER 64u
#define PACK_ENTRY 24u
#define PACK_ENTRIES 65536u
#define PACK_BYTES 131072u
#define PACK_STORED (PACK_BYTES + 128u)
typedef struct {
  uint32_t count, length;
} PackHeader;
typedef struct {
  uint32_t offset, stored, raw, checksum, kind, width, height;
} PackEntry;
static inline uint32_t pack_u32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
         (uint32_t)p[3] << 24;
}
static inline bool pack_header(const uint8_t *p, uint32_t length,
                               PackHeader *h) {
  if (length < PACK_HEADER || length > 0x7fffffffu || memcmp(p, "PRP1", 4) ||
      pack_u32(p + 4) != 1 || pack_u32(p + 12) != length)
    return false;
  h->count = pack_u32(p + 8);
  h->length = length;
  if (!h->count || h->count > PACK_ENTRIES ||
      PACK_HEADER + h->count * PACK_ENTRY > length)
    return false;
  for (unsigned i = 16; i < PACK_HEADER; i++)
    if (p[i])
      return false;
  return true;
}
static inline bool pack_entry(const uint8_t *p, const PackHeader *h,
                              PackEntry *e) {
  e->offset = pack_u32(p);
  e->stored = pack_u32(p + 4);
  e->raw = pack_u32(p + 8);
  e->checksum = pack_u32(p + 12);
  e->kind = pack_u32(p + 16);
  e->width = p[20] | (unsigned)p[21] << 8;
  e->height = p[22] | (unsigned)p[23] << 8;
  if (e->offset < PACK_HEADER + h->count * PACK_ENTRY ||
      e->offset > h->length || !e->stored || e->stored > PACK_STORED ||
      e->stored > h->length - e->offset || !e->raw || e->raw > PACK_BYTES)
    return false;
  if (e->kind == 1)
    return e->raw <= 2500 && !e->width && !e->height;
  return e->kind == 2 && e->width >= 16 && e->height >= 16 && e->width <= 256 &&
         e->height <= 256 && !(e->width & (e->width - 1)) &&
         !(e->height & (e->height - 1)) && e->raw == e->width * e->height * 2;
}
#endif
