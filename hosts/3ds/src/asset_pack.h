#ifndef POCKET_ASSET_PACK_H
#define POCKET_ASSET_PACK_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef struct {
  uint32_t id, token, kind, width, height, length;
  const uint8_t *bytes;
  const char *error;
} AssetPackResult;
void asset_pack_start(void);
void asset_pack_stop(void);
void asset_pack_reset(void);
void asset_pack_frame(void);
bool asset_pack_submit(uint32_t id, const char *pack, unsigned length,
                       uint32_t entry);
/* Copy a bounded text record or linear offload image into worker-owned credit.
 * All preparation, CRC, compression and filesystem writes stay on the worker. */
bool asset_pack_cache(uint32_t id, const char *pack, unsigned length,
                      uint32_t entry, const uint8_t *bytes, unsigned size,
                      unsigned width, unsigned height);
bool asset_pack_remove(uint32_t id, const char *pack, unsigned length);
bool asset_pack_take(AssetPackResult *out);
void asset_pack_release(uint32_t token);
int32_t asset_pack_upload(uint32_t token);
int asset_pack_session(void);
void asset_pack_stats(char *out, size_t size);
#endif
