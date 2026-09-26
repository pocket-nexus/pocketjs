/* This worker owns every SD open/seek/read/inflate. The UI owns descriptors
 * and GPU uploads, and transfers fixed slots with release/acquire atomics. */
#include "asset_pack.h"
#include "asset_pack_format.h"
#include "gfx.h"
#include "pocket_core.h"
#include <3ds.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <zlib.h>
#ifndef POCKETJS_RUNTIME_SLOT
#define POCKETJS_RUNTIME_SLOT "default"
#endif
enum { FREE, QUEUED, READY, BORROWED };
typedef struct {
  _Atomic unsigned state;
  uint32_t generation, id, index, token, kind, width, height, length;
  unsigned write;
  char pack[49], error[80];
  uint8_t bytes[PACK_BYTES];
} Slot;
static Slot slots[8];
static _Atomic bool running;
static _Atomic unsigned generation = 1;
static _Atomic unsigned reads, io_us, decode_us, max_io_us, max_decode_us,
    failures, upload_us, max_upload_us, uploads;
static Thread worker;
static uint32_t sequence;
static unsigned submitted, taken, uploaded;
static unsigned take_cursor;
static void maximum(_Atomic unsigned *a, unsigned n) {
  unsigned old = atomic_load(a);
  while (n > old && !atomic_compare_exchange_weak(a, &old, n)) {
  };
}
static unsigned micros(u64 start) {
  return (unsigned)((svcGetSystemTick() - start) * 1000000 / SYSCLOCK_ARM11);
}
void asset_pack_frame(void) { submitted = taken = uploaded = 0; }
int asset_pack_session(void) {
  return atomic_load(&running) ? (int)atomic_load(&generation) : 0;
}
void asset_pack_stats(char *out, size_t size) {
  snprintf(out, size,
           "reads=%u ioUs=%u decodeUs=%u maxIoUs=%u maxDecodeUs=%u failures=%u "
           "uploads=%u uploadUs=%u maxUploadUs=%u",
           atomic_load(&reads), atomic_load(&io_us), atomic_load(&decode_us),
           atomic_load(&max_io_us), atomic_load(&max_decode_us),
           atomic_load(&failures), atomic_load(&uploads),
           atomic_load(&upload_us), atomic_load(&max_upload_us));
}
static bool enqueue(uint32_t id, const char *name, unsigned length,
                    uint32_t index, const uint8_t *bytes, unsigned size,
                    unsigned width, unsigned height, unsigned mode) {
  if (!asset_pack_session() || !id || !length || length > 48 ||
      index >= PACK_ENTRIES || submitted >= 1)
    return false;
  for (unsigned i = 0; i < length; i++)
    if (!((name[i] >= 'a' && name[i] <= 'z') ||
          (name[i] >= '0' && name[i] <= '9') || name[i] == '-'))
      return false;
  for (unsigned i = 0; i < 8; i++)
    if (atomic_load_explicit(&slots[i].state, memory_order_acquire) == FREE) {
      Slot *s = &slots[i];
      s->write = mode;
      s->kind = width ? 2 : 1;
      s->width = width; s->height = height; s->length = size;
      if (bytes) memcpy(s->bytes, bytes, size);
      s->id = id;
      s->index = index;
      s->generation = atomic_load(&generation);
      sequence = (sequence % 0x1fffffff) + 1;
      s->token = (sequence << 3) | i;
      memcpy(s->pack, name, length);
      s->pack[length] = 0;
      s->error[0] = 0;
      atomic_store_explicit(&s->state, QUEUED, memory_order_release);
      submitted++;
      return true;
    }
  return false;
}
bool asset_pack_submit(uint32_t id, const char *name, unsigned length, uint32_t index) {
  return enqueue(id, name, length, index, NULL, 0, 0, 0, 0);
}
bool asset_pack_cache(uint32_t id, const char *name, unsigned length, uint32_t index,
                      const uint8_t *bytes, unsigned size, unsigned width, unsigned height) {
  if (!bytes || !size || size > PACK_BYTES) return false;
  if (width || height) {
    if (width < 16 || width > 256 || (width & (width - 1)) ||
        height < 16 || height > 256 || (height & (height - 1)) || size != width * height * 2) return false;
  } else if (size > 2500) return false;
  return enqueue(id, name, length, index, bytes, size, width, height, 1);
}
bool asset_pack_remove(uint32_t id, const char *name, unsigned length) {
  return enqueue(id, name, length, 0, NULL, 0, 0, 0, 2);
}
bool asset_pack_take(AssetPackResult *out) {
  if (taken >= 1)
    return false;
  for (unsigned n = 0; n < 8; n++) {
    unsigned i = (take_cursor + n) & 7;
    if (atomic_load_explicit(&slots[i].state, memory_order_acquire) == READY) {
      Slot *s = &slots[i];
      if (s->generation != atomic_load(&generation)) {
        atomic_store_explicit(&s->state, FREE, memory_order_release);
        continue;
      }
      atomic_store_explicit(&s->state, BORROWED, memory_order_release);
      taken++;
      take_cursor = (i + 1) & 7;
      *out = (AssetPackResult){
          s->id,     s->token,  s->kind,  s->width,
          s->height, s->length, s->bytes, s->error[0] ? s->error : NULL};
      return true;
    }
  }
  return false;
}
void asset_pack_release(uint32_t token) {
  Slot *s = &slots[token & 7];
  if (atomic_load_explicit(&s->state, memory_order_acquire) == BORROWED &&
      s->token == token)
    atomic_store_explicit(&s->state, FREE, memory_order_release);
}
int32_t asset_pack_upload(uint32_t token) {
  Slot *s = &slots[token & 7];
  if (uploaded >= 1 ||
      atomic_load_explicit(&s->state, memory_order_acquire) != BORROWED ||
      s->token != token || s->kind != 2 || s->error[0])
    return -1;
  uploaded++;
  u64 at = svcGetSystemTick();
  int32_t handle = ui_register_external_texture(s->width, s->height);
  if (handle >= 0 && !gfx_stage_image(handle, s->bytes, s->width, s->height)) {
    ui_free_texture(handle);
    return -1;
  }
  if (handle >= 0) {
    unsigned duration = micros(at);
    atomic_fetch_add(&uploads, 1);
    atomic_fetch_add(&upload_us, duration);
    maximum(&max_upload_us, duration);
  }
  return handle;
}
void asset_pack_reset(void) {
  atomic_fetch_add(&generation, 1);
  for (unsigned i = 0; i < 8; i++) {
    unsigned s = atomic_load_explicit(&slots[i].state, memory_order_acquire);
    if (s == READY || s == BORROWED)
      atomic_store_explicit(&slots[i].state, FREE, memory_order_release);
  }
}
/* Four immutable file descriptors bound open-file memory. Entry indices are
 * read directly; neither the full directory nor whole pack enters RAM. */
typedef struct {
  char name[49];
  FILE *file;
  PackHeader header;
  unsigned used;
} OpenPack;
/* Cache records use a one-entry PRP, so offline reads use the same validator.
 * Immutable rendition names isolate updates; a failed write never replaces a
 * readable record. Mutable catalog pointers use a recoverable backup on FAT. */
static void put32(uint8_t *b, uint32_t v) {
  b[0] = v; b[1] = v >> 8; b[2] = v >> 16; b[3] = v >> 24;
}
static void cache_path(char *out, size_t size, const Slot *s) {
  snprintf(out, size, "sdmc:/pocketjs/assets/%s/cache/%s/%u.prp",
           POCKETJS_RUNTIME_SLOT, s->pack, (unsigned)s->index);
}
static bool cache_write(Slot *s, uint8_t *scratch) {
  char dir[192], path[224], partial[240], backup[240];
  mkdir("sdmc:/pocketjs", 0777); mkdir("sdmc:/pocketjs/assets", 0777);
  snprintf(dir, sizeof dir, "sdmc:/pocketjs/assets/%s", POCKETJS_RUNTIME_SLOT); mkdir(dir, 0777);
  snprintf(dir, sizeof dir, "sdmc:/pocketjs/assets/%s/cache", POCKETJS_RUNTIME_SLOT); mkdir(dir, 0777);
  snprintf(dir, sizeof dir, "sdmc:/pocketjs/assets/%s/cache/%s", POCKETJS_RUNTIME_SLOT, s->pack); mkdir(dir, 0777);
  cache_path(path, sizeof path, s);
  snprintf(partial, sizeof partial, "%s.partial", path);
  snprintf(backup, sizeof backup, "%s.bak", path);
  if (s->kind == 2) {
    /* Linear core R5G6B5 -> vertically flipped PICA Morton RGB565. */
    for (unsigned y = 0; y < s->height; y++) for (unsigned x = 0; x < s->width; x++) {
      unsigned source = ((s->height - 1 - y) * s->width + x) * 2;
      unsigned v = s->bytes[source] | (s->bytes[source + 1] << 8), mx = x & 7, my = y & 7;
      unsigned morton = (mx & 1) | ((my & 1) << 1) | ((mx & 2) << 1) | ((my & 2) << 2) | ((mx & 4) << 2) | ((my & 4) << 3);
      unsigned at = (((y >> 3) * (s->width >> 3) + (x >> 3)) * 64 + morton) * 2;
      unsigned pixel = ((v & 31) << 11) | (v & 0x7e0) | ((v >> 11) & 31);
      scratch[at] = pixel; scratch[at + 1] = pixel >> 8;
    }
    memcpy(s->bytes, scratch, s->length);
  }
  uLongf stored = PACK_STORED;
  if (compress2(scratch, &stored, s->bytes, s->length, 3) != Z_OK) return false;
  uint8_t header[88] = {0};
  memcpy(header, "PRP1", 4); put32(header + 4, 1); put32(header + 8, 1);
  put32(header + 12, 88 + stored); put32(header + 64, 88);
  put32(header + 68, stored); put32(header + 72, s->length);
  put32(header + 76, crc32(0, s->bytes, s->length)); put32(header + 80, s->kind);
  header[84] = s->width; header[85] = s->width >> 8;
  header[86] = s->height; header[87] = s->height >> 8;
  FILE *f = fopen(partial, "wb");
  if (!f) return false;
  bool ok = fwrite(header, 1, 88, f) == 88 && fwrite(scratch, 1, stored, f) == stored && fflush(f) == 0;
  if (fclose(f)) ok = false;
  if (!ok) { remove(partial); return false; }
  /* POSIX replaces in one rename; FAT may require moving the old record. */
  if (rename(partial, path)) {
    remove(backup);
    if (rename(path, backup) || rename(partial, path)) { rename(backup, path); remove(partial); return false; }
  }
  remove(backup);
  return true;
}
static bool cache_remove(const Slot *s) {
  char path[224];
  snprintf(path, sizeof path, "sdmc:/pocketjs/assets/%s/cache/%s", POCKETJS_RUNTIME_SLOT, s->pack);
  DIR *dir = opendir(path);
  if (!dir) return errno == ENOENT;
  struct dirent *entry; bool ok = true;
  while ((entry = readdir(dir))) {
    if (entry->d_name[0] == '.') continue;
    char *tail; unsigned long index = strtoul(entry->d_name, &tail, 10);
    if (index >= PACK_ENTRIES || tail == entry->d_name ||
        (strcmp(tail, ".prp") && strcmp(tail, ".prp.partial") && strcmp(tail, ".prp.bak"))) { ok = false; continue; }
    char file[256];
    int size = snprintf(file, sizeof file, "%s/%s", path, entry->d_name);
    if (size < 0 || (unsigned)size >= sizeof file || remove(file)) ok = false;
  }
  closedir(dir);
  if (ok && remove(path)) ok = false;
  return ok;
}
static void serve(void *unused) {
  (void)unused;
  OpenPack files[4] = {0};
  unsigned clock = 0;
  uint8_t *compressed = malloc(PACK_STORED);
  if (!compressed) {
    atomic_store(&running, false);
    return;
  }
  while (atomic_load(&running)) {
    bool worked = false;
    for (unsigned i = 0; i < 8; i++) {
      Slot *s = &slots[i];
      if (atomic_load_explicit(&s->state, memory_order_acquire) != QUEUED)
        continue;
      worked = true;
      if (s->generation != atomic_load(&generation)) {
        atomic_store_explicit(&s->state, FREE, memory_order_release);
        continue;
      }
      u64 at = svcGetSystemTick();
      OpenPack *p = NULL, cached = {0};
      uint32_t entry_index = s->index;
      bool cache_attempt = false;
      if (s->write) {
        if (!(s->write == 2 ? cache_remove(s) : cache_write(s, compressed))) snprintf(s->error, sizeof s->error, "Cache write failed; check SD space");
        s->kind = 1; s->width = s->height = 0; s->length = 2; memcpy(s->bytes, "{}", 2);
        goto done;
      }
      uint8_t header[PACK_HEADER];
      PackEntry e;
      bool needs_header = false;
      char cached_path[240]; cache_path(cached_path, sizeof cached_path, s);
      cached.file = fopen(cached_path, "rb");
      if (!cached.file) {
        char backup[256]; snprintf(backup, sizeof backup, "%s.bak", cached_path);
        cached.file = fopen(backup, "rb");
      }
      if (cached.file) { p = &cached; entry_index = 0; needs_header = true; cache_attempt = true; }
    installed:
      for (unsigned j = 0; !p && j < 4; j++)
        if (files[j].file && !strcmp(files[j].name, s->pack)) p = &files[j];
      if (!p) {
        p = &files[0];
        for (unsigned j = 0; j < 4; j++)
          if (!files[j].file || files[j].used < p->used) p = &files[j];
        if (p->file) fclose(p->file);
        memset(p, 0, sizeof *p);
        char path[192];
        snprintf(path, sizeof path, "sdmc:/pocketjs/assets/%s/%s.prp", POCKETJS_RUNTIME_SLOT, s->pack);
        p->file = fopen(path, "rb");
        if (!p->file) { snprintf(s->error, sizeof s->error, "Resource pack not installed"); goto done; }
        needs_header = true;
      }
      if (needs_header) {
        if (fseek(p->file, 0, SEEK_END) || ftell(p->file) < 64L) {
          snprintf(s->error, sizeof s->error, "Invalid resource pack size");
          goto invalid;
        }
        long length = ftell(p->file);
        if (fseek(p->file, 0, SEEK_SET) ||
            fread(header, 1, PACK_HEADER, p->file) != PACK_HEADER ||
            !pack_header(header, (uint32_t)length, &p->header)) {
          snprintf(s->error, sizeof s->error, "Invalid resource pack header");
          goto invalid;
        }
        strcpy(p->name, s->pack);
      }
      p->used = ++clock;
      if (entry_index >= p->header.count) {
        snprintf(s->error, sizeof s->error, "Resource pack entry out of range");
        goto done;
      }
      if (fseek(p->file, PACK_HEADER + entry_index * PACK_ENTRY, SEEK_SET) ||
          fread(header, 1, PACK_ENTRY, p->file) != PACK_ENTRY ||
          !pack_entry(header, &p->header, &e)) {
        snprintf(s->error, sizeof s->error, "Invalid resource pack entry");
        goto done;
      }
      if (fseek(p->file, e.offset, SEEK_SET) ||
          fread(compressed, 1, e.stored, p->file) != e.stored) {
        snprintf(s->error, sizeof s->error, "Resource pack read failed");
        goto invalid;
      }
      unsigned duration = micros(at);
      atomic_fetch_add(&io_us, duration);
      maximum(&max_io_us, duration);
      at = svcGetSystemTick();
      uLongf size = e.raw;
      if (uncompress(s->bytes, &size, compressed, e.stored) != Z_OK ||
          size != e.raw || crc32(0, s->bytes, size) != e.checksum) {
        snprintf(s->error, sizeof s->error,
                 "Resource pack checksum or codec failure");
        goto done;
      }
      duration = micros(at);
      atomic_fetch_add(&decode_us, duration);
      maximum(&max_decode_us, duration);
      atomic_fetch_add(&reads, 1);
      s->kind = e.kind;
      s->width = e.width;
      s->height = e.height;
      s->length = e.raw;
      goto done;
    invalid:
      if (p && p->file) {
        fclose(p->file);
        p->file = NULL;
      }
    done:
      if (cache_attempt && s->error[0]) {
        // A damaged network cache must not hide a valid installed SD record.
        if (cached.file) fclose(cached.file);
        cached.file = NULL; p = NULL; needs_header = false;
        cache_attempt = false; entry_index = s->index; s->error[0] = 0;
        goto installed;
      }
      if (cached.file) fclose(cached.file);
      if (s->error[0])
        atomic_fetch_add(&failures, 1);
      atomic_store_explicit(&s->state, READY, memory_order_release);
    }
    if (!worked)
      svcSleepThread(1000000);
  }
  for (unsigned j = 0; j < 4; j++)
    if (files[j].file)
      fclose(files[j].file);
  free(compressed);
}
void asset_pack_start(void) {
  if (atomic_exchange(&running, true))
    return;
  worker = threadCreate(serve, NULL, 32 * 1024, 0x3f, -2, false);
  if (!worker)
    atomic_store(&running, false);
}
void asset_pack_stop(void) {
  atomic_store(&running, false);
  if (worker) {
    threadJoin(worker, U64_MAX);
    threadFree(worker);
    worker = NULL;
  }
}
