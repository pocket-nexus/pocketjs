/* A slot's bundle bytecode on the SD card (bytecode.h). */

#include "bytecode.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A bytecode file larger than this is not ours. */
#define BYTECODE_MAX_BYTES (16u * 1024u * 1024u)
#define BYTECODE_MAGIC "PQBC"
#define BYTECODE_VERSION 1u

typedef struct {
  char magic[4];
  uint32_t version;
  uint64_t package_hash;
  uint64_t quickjs_stamp;
  uint32_t length;
  /* FNV-1a over the bytecode. */
  uint32_t checksum;
} BytecodeHeader;

static uint32_t checksum(const uint8_t *bytes, size_t length) {
  uint32_t hash = 2166136261u;
  for (size_t index = 0; index < length; index += 1) {
    hash ^= bytes[index];
    hash *= 16777619u;
  }
  return hash;
}

uint8_t *bytecode_load(const char *path, uint64_t package_hash, size_t *length) {
#ifdef POCKETJS_QUICKJS_STAMP
  if (path == NULL || path[0] == '\0') return NULL;
  FILE *file = fopen(path, "rb");
  if (file == NULL) return NULL;
  BytecodeHeader header;
  uint8_t *bytes = NULL;
  if (fread(&header, sizeof header, 1, file) == 1 &&
      memcmp(header.magic, BYTECODE_MAGIC, sizeof header.magic) == 0 &&
      header.version == BYTECODE_VERSION &&
      header.package_hash == package_hash &&
      header.quickjs_stamp == (uint64_t)POCKETJS_QUICKJS_STAMP &&
      header.length > 0 && header.length <= BYTECODE_MAX_BYTES) {
    bytes = malloc(header.length);
    if (bytes != NULL &&
        (fread(bytes, 1, header.length, file) != header.length ||
         checksum(bytes, header.length) != header.checksum)) {
      free(bytes);
      bytes = NULL;
    }
  }
  fclose(file);
  if (bytes != NULL) *length = header.length;
  return bytes;
#else
  (void)path;
  (void)package_hash;
  (void)length;
  return NULL;
#endif
}

void bytecode_store(const char *path, uint64_t package_hash, const uint8_t *bytes, size_t length) {
#ifdef POCKETJS_QUICKJS_STAMP
  if (path == NULL || path[0] == '\0' || bytes == NULL || length == 0 || length > BYTECODE_MAX_BYTES) return;
  char temporary[192];
  if (snprintf(temporary, sizeof temporary, "%s.new", path) >= (int)sizeof temporary) return;
  BytecodeHeader header;
  memcpy(header.magic, BYTECODE_MAGIC, sizeof header.magic);
  header.version = BYTECODE_VERSION;
  header.package_hash = package_hash;
  header.quickjs_stamp = (uint64_t)POCKETJS_QUICKJS_STAMP;
  header.length = (uint32_t)length;
  header.checksum = checksum(bytes, length);
  FILE *file = fopen(temporary, "wb");
  if (file == NULL) return;
  bool written = fwrite(&header, sizeof header, 1, file) == 1 && fwrite(bytes, 1, length, file) == length;
  if (fclose(file) != 0 || !written) {
    remove(temporary);
    return;
  }
  /* sdmc renames refuse an existing target. */
  remove(path);
  if (rename(temporary, path) != 0) remove(temporary);
#else
  (void)path;
  (void)package_hash;
  (void)bytes;
  (void)length;
#endif
}
