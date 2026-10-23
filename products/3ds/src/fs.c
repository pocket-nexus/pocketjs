/* The fs module on the SD card (fs.h, contracts/spec/fs.ts). */

#include "fs.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "jscan.h"

/* contracts/spec/fs.ts */
#define FS_MAX_SEGMENT_BYTES 64
#define FS_MAX_PATH_BYTES 160
#define FS_MAX_IO_BYTES 65536
#define FS_MAX_DIR_ENTRIES 256
#define FS_WRITE_TRUNCATE 0
#define FS_WRITE_APPEND 1

/* root + "/" + a path, with room for the sidecar's names. */
#define FULL_BYTES 400

#ifdef FS_TEST_HOOKS
/* tests/fixtures/3ds-fs.c: take FAT's rename path on the computer, and stop
 * a replacement after the old file is gone, as a power loss would. */
int fs_test_no_replace;
int fs_test_crash_after_unlink;
#endif

static bool bound;
static char root_dir[FULL_BYTES];
static char temp_dir[FULL_BYTES];
static char staged_path[FULL_BYTES];
static char sidecar_path[FULL_BYTES];
static uint64_t quota_bytes;
static bool used_known;
static uint64_t used_bytes;
static char last_error[FS_MAX_PATH_BYTES + 48];
static JsonBuffer line;

// ---------------------------------------------------------------------------
// errors and results
// ---------------------------------------------------------------------------

static int ok_int(void) {
  last_error[0] = '\0';
  return 0;
}

static int fail_int(const char *message) {
  snprintf(last_error, sizeof last_error, "%s", message);
  return 1;
}

static int fail_path(const char *message, const char *path, size_t length) {
  snprintf(last_error, sizeof last_error, "%s: %.*s", message, (int)length, path);
  return 1;
}

static const char *fail_line(const char *message) {
  fail_int(message);
  jbuf_reset(&line);
  jbuf_text(&line, "{\"error\":");
  jbuf_cstring(&line, message);
  jbuf_text(&line, "}");
  return jbuf_cstr(&line);
}

static const char *ok_line(void) {
  last_error[0] = '\0';
  const char *text = jbuf_cstr(&line);
  return text != NULL ? text : fail_line("out of memory");
}

// ---------------------------------------------------------------------------
// the path grammar (fsValidPath)
// ---------------------------------------------------------------------------

/* Decode one UTF-8 scalar at `at`; 0 for ill-formed input (overlong,
 * surrogate, out of range, truncated) — the WTF-8 a lone surrogate becomes
 * in QuickJS is ill-formed here, as fsValidSegment refuses it. */
static size_t utf8_scalar(const unsigned char *text, size_t length, size_t at, uint32_t *out) {
  unsigned char lead = text[at];
  if (lead < 0x80) {
    *out = lead;
    return 1;
  }
  size_t count;
  uint32_t code;
  uint32_t minimum;
  if ((lead & 0xe0) == 0xc0) {
    count = 2;
    code = lead & 0x1f;
    minimum = 0x80;
  } else if ((lead & 0xf0) == 0xe0) {
    count = 3;
    code = lead & 0x0f;
    minimum = 0x800;
  } else if ((lead & 0xf8) == 0xf0) {
    count = 4;
    code = lead & 0x07;
    minimum = 0x10000;
  } else {
    return 0;
  }
  if (at + count > length) return 0;
  for (size_t i = 1; i < count; i += 1) {
    unsigned char next = text[at + i];
    if ((next & 0xc0) != 0x80) return 0;
    code = (code << 6) | (next & 0x3f);
  }
  if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
  *out = code;
  return count;
}

static bool valid_segment(const char *segment, size_t length) {
  if (length == 0 || length > FS_MAX_SEGMENT_BYTES) return false;
  if ((length == 1 && segment[0] == '.') || (length == 2 && segment[0] == '.' && segment[1] == '.')) return false;
  const unsigned char *text = (const unsigned char *)segment;
  for (size_t at = 0; at < length;) {
    uint32_t code = 0;
    size_t step = utf8_scalar(text, length, at, &code);
    if (step == 0 || code < 0x20 || code == 0x7f) return false;
    at += step;
  }
  return true;
}

static bool valid_path(const char *path, size_t length) {
  if (path == NULL || length == 0 || length > FS_MAX_PATH_BYTES) return false;
  size_t segments = 0;
  size_t start = 0;
  for (size_t at = 0; at <= length; at += 1) {
    if (at < length && path[at] != '/') continue;
    if (!valid_segment(path + start, at - start)) return false;
    segments += 1;
    start = at + 1;
  }
  return segments <= FS_MAX_DEPTH;
}

/* root + "/" + path; the root itself for an empty path. */
static bool full_path(const char *path, size_t length, char *out) {
  int written = length == 0 ? snprintf(out, FULL_BYTES, "%s", root_dir)
                            : snprintf(out, FULL_BYTES, "%s/%.*s", root_dir, (int)length, path);
  return written > 0 && written < FULL_BYTES;
}

/* 0 missing, 1 file, 2 directory; the size of a file in `size`. */
static int kind_of(const char *full, uint64_t *size) {
  struct stat info;
  if (stat(full, &info) != 0) return 0;
  if (S_ISDIR(info.st_mode)) return 2;
  if (size != NULL) *size = (uint64_t)info.st_size;
  return 1;
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

static uint64_t tree_bytes(const char *directory_path, unsigned depth) {
  if (depth > FS_MAX_DEPTH) return 0;
  DIR *directory = opendir(directory_path);
  if (directory == NULL) return 0;
  uint64_t total = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    char child[FULL_BYTES];
    int written = snprintf(child, sizeof child, "%s/%s", directory_path, entry->d_name);
    if (written <= 0 || (size_t)written >= sizeof child) continue;
    uint64_t size = 0;
    int kind = kind_of(child, &size);
    if (kind == 1) total += size;
    else if (kind == 2) total += tree_bytes(child, depth + 1);
  }
  closedir(directory);
  return total;
}

static uint64_t usage_now(void) {
  if (!used_known) {
    used_bytes = tree_bytes(root_dir, 0);
    used_known = true;
  }
  return used_bytes;
}

// ---------------------------------------------------------------------------
// directories
// ---------------------------------------------------------------------------

/* Create every missing ancestor of `path` (and `path` itself when `self`);
 * fails naming the first one that is a file. */
static int make_directories(const char *path, size_t length, bool self) {
  for (size_t at = 1; at <= length; at += 1) {
    if (at < length && path[at] != '/') continue;
    if (at == length && !self) break;
    char full[FULL_BYTES];
    if (!full_path(path, at, full)) return fail_int("path too long");
    int kind = kind_of(full, NULL);
    if (kind == 1) return fail_path("not a directory", path, at);
    if (kind == 0 && mkdir(full, 0777) != 0 && errno != EEXIST) return fail_path("mkdir failed", path, at);
  }
  return 0;
}

static bool ensure_directory(const char *path) {
  char partial[FULL_BYTES];
  size_t length = strlen(path);
  if (length == 0 || length >= sizeof partial) return false;
  memcpy(partial, path, length + 1);
  for (size_t at = 1; at <= length; at += 1) {
    if (at < length && partial[at] != '/') continue;
    char saved = partial[at];
    partial[at] = '\0';
    /* "sdmc:" is the device, not a directory. */
    if (partial[at - 1] != ':') mkdir(partial, 0777);
    partial[at] = saved;
  }
  struct stat info;
  return stat(path, &info) == 0 && S_ISDIR(info.st_mode);
}

static bool remove_tree(const char *full, unsigned depth, unsigned max_depth) {
  struct stat info;
  if (stat(full, &info) != 0) return errno == ENOENT;
  if (!S_ISDIR(info.st_mode)) return remove(full) == 0;
  if (depth > max_depth) return false;
  DIR *directory = opendir(full);
  if (directory == NULL) return false;
  bool ok = true;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    char child[FULL_BYTES];
    int written = snprintf(child, sizeof child, "%s/%s", full, entry->d_name);
    if (written <= 0 || (size_t)written >= sizeof child || !remove_tree(child, depth + 1, max_depth)) ok = false;
  }
  closedir(directory);
  return rmdir(full) == 0 && ok;
}

bool fs_remove_tree(const char *path, unsigned max_depth) {
  return remove_tree(path, 0, max_depth);
}

static bool directory_empty(const char *full) {
  DIR *directory = opendir(full);
  if (directory == NULL) return false;
  bool empty = true;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
      empty = false;
      break;
    }
  }
  closedir(directory);
  return empty;
}

// ---------------------------------------------------------------------------
// replacing a file
// ---------------------------------------------------------------------------

static bool write_whole(const char *full, const uint8_t *bytes, size_t length) {
  FILE *file = fopen(full, "wb");
  if (file == NULL) return false;
  bool ok = length == 0 || fwrite(bytes, 1, length, file) == length;
  if (fclose(file) != 0) ok = false;
  return ok;
}

/* Move the staged file to `full`, replacing it. */
static bool replace_with_staged(const char *full) {
#ifdef FS_TEST_HOOKS
  if (!fs_test_no_replace)
#endif
    if (rename(staged_path, full) == 0) return true;
  if (kind_of(full, NULL) == 0) return rename(staged_path, full) == 0;
  /* FAT: record the destination, drop the old file, move the new one in. */
  if (!write_whole(sidecar_path, (const uint8_t *)full, strlen(full))) return false;
  if (remove(full) != 0) {
    remove(sidecar_path);
    return false;
  }
#ifdef FS_TEST_HOOKS
  if (fs_test_crash_after_unlink) return false;
#endif
  bool moved = rename(staged_path, full) == 0;
  remove(sidecar_path);
  return moved;
}

/* A replacement a power loss interrupted: the sidecar names the destination
 * and the staged file holds its new content. */
static void finish_replacement(void) {
  FILE *file = fopen(sidecar_path, "rb");
  if (file == NULL) {
    remove(staged_path);
    return;
  }
  char full[FULL_BYTES];
  size_t length = fread(full, 1, sizeof full - 1, file);
  fclose(file);
  full[length] = '\0';
  size_t root_length = strlen(root_dir);
  bool inside = length > root_length + 1 && strncmp(full, root_dir, root_length) == 0 && full[root_length] == '/';
  if (inside && kind_of(staged_path, NULL) == 1) {
    if (kind_of(full, NULL) == 1) remove(full);
    rename(staged_path, full);
  }
  remove(sidecar_path);
  remove(staged_path);
}

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

static int base64_value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

/* Base64 into `out` (capacity length * 3 / 4); -1 when malformed. */
static long base64_decode(const char *text, size_t length, uint8_t *out) {
  size_t used = 0;
  uint32_t bits = 0;
  int count = 0;
  size_t padding = 0;
  for (size_t at = 0; at < length; at += 1) {
    char c = text[at];
    if (c == '=') {
      padding += 1;
      continue;
    }
    if (padding > 0) return -1;
    int value = base64_value(c);
    if (value < 0) return -1;
    bits = (bits << 6) | (uint32_t)value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[used++] = (uint8_t)(bits >> count);
    }
  }
  if (padding > 2) return -1;
  return (long)used;
}

static const char BASE64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void base64_append(JsonBuffer *buffer, const uint8_t *bytes, size_t length) {
  char chunk[256];
  size_t used = 0;
  for (size_t at = 0; at < length; at += 3) {
    uint32_t group = (uint32_t)bytes[at] << 16;
    if (at + 1 < length) group |= (uint32_t)bytes[at + 1] << 8;
    if (at + 2 < length) group |= bytes[at + 2];
    chunk[used++] = BASE64[(group >> 18) & 63];
    chunk[used++] = BASE64[(group >> 12) & 63];
    chunk[used++] = at + 1 < length ? BASE64[(group >> 6) & 63] : '=';
    chunk[used++] = at + 2 < length ? BASE64[group & 63] : '=';
    if (used + 4 > sizeof chunk) {
      jbuf_raw(buffer, chunk, used);
      used = 0;
    }
  }
  if (used > 0) jbuf_raw(buffer, chunk, used);
}

/* A JSON string's UTF-8 bytes into `out` (capacity >= the span's length);
 * -1 when it is not a well-formed string (json_string_strict) or its raw
 * bytes are not UTF-8. */
static long json_text(JsonSpan value, uint8_t *out) {
  long used = json_string_strict(value, (char *)out, value.length);
  for (long at = 0; at < used;) {
    uint32_t scalar = 0;
    size_t step = utf8_scalar(out, (size_t)used, (size_t)at, &scalar);
    if (step == 0) return -1;
    at += (long)step;
  }
  return used;
}

/* The payload's bytes (malloc'd) in `*out`; -1 when malformed. */
static long decode_payload(const char *data, size_t length, uint8_t **out) {
  *out = NULL;
  JsonSpan span = json_span(data, length);
  while (span.length > 0 && (span.start[0] == ' ' || span.start[0] == '\n' || span.start[0] == '\t' || span.start[0] == '\r')) {
    span.start += 1;
    span.length -= 1;
  }
  while (span.length > 0) {
    char c = span.start[span.length - 1];
    if (c != ' ' && c != '\n' && c != '\t' && c != '\r') break;
    span.length -= 1;
  }
  if (span.length == 0) return -1;
  uint8_t *bytes = malloc(span.length + 1);
  if (bytes == NULL) return -1;
  long used = -1;
  if (span.start[0] == '"') {
    used = json_text(span, bytes);
  } else if (span.start[0] == '{') {
    JsonSpan value;
    if (json_find(span, "$b", &value)) {
      long text_length = json_text(value, bytes);
      if (text_length >= 0) used = base64_decode((const char *)bytes, (size_t)text_length, bytes);
    }
  }
  if (used < 0) {
    free(bytes);
    return -1;
  }
  *out = bytes;
  return used;
}

// ---------------------------------------------------------------------------
// binding
// ---------------------------------------------------------------------------

bool fs_bind(const char *root, const char *temp, uint64_t quota) {
  fs_unbind();
  if (snprintf(root_dir, sizeof root_dir, "%s", root) >= (int)sizeof root_dir) return false;
  if (snprintf(temp_dir, sizeof temp_dir, "%s", temp) >= (int)sizeof temp_dir) return false;
  if (snprintf(staged_path, sizeof staged_path, "%s/write.tmp", temp) >= (int)sizeof staged_path) return false;
  if (snprintf(sidecar_path, sizeof sidecar_path, "%s/write.dest", temp) >= (int)sizeof sidecar_path) return false;
  if (!ensure_directory(root_dir) || !ensure_directory(temp_dir)) return false;
  finish_replacement();
  quota_bytes = quota;
  used_known = false;
  last_error[0] = '\0';
  line.limit = 0;
  bound = true;
  return true;
}

void fs_unbind(void) {
  bound = false;
  used_known = false;
  jbuf_free(&line);
}

bool fs_bound(void) {
  return bound;
}

uint64_t fs_plan_quota(const char *plan, size_t plan_length) {
  JsonSpan root = json_span(plan, plan_length);
  JsonSpan applet;
  JsonSpan store;
  uint64_t bytes = 0;
  if (json_find(root, "applet", &applet) && json_find(applet, "store", &store) && json_find_u64(store, "maxBytes", &bytes) &&
      bytes > 0) {
    return bytes;
  }
  return FS_DEFAULT_QUOTA_BYTES;
}

// ---------------------------------------------------------------------------
// the ops
// ---------------------------------------------------------------------------

const char *fs_read(const char *path, size_t path_length, double offset, double max_bytes) {
  if (!bound) return fail_line("fs is not mounted");
  if (!valid_path(path, path_length)) return fail_line("invalid path");
  if (!(max_bytes >= 1 && max_bytes <= FS_MAX_IO_BYTES)) return fail_line("read maxBytes out of range");
  if (!(offset >= 0)) return fail_line("read offset out of range");
  char full[FULL_BYTES];
  if (!full_path(path, path_length, full)) return fail_line("invalid path");
  uint64_t size = 0;
  int kind = kind_of(full, &size);
  if (kind == 0) return fail_line("not found");
  if (kind == 2) return fail_line("is a directory");
  uint64_t start = offset > (double)size ? size : (uint64_t)offset;
  size_t want = (size_t)max_bytes;
  if (start + want > size) want = (size_t)(size - start);
  uint8_t *bytes = want > 0 ? malloc(want) : NULL;
  if (want > 0 && bytes == NULL) return fail_line("out of memory");
  size_t got = 0;
  if (want > 0) {
    FILE *file = fopen(full, "rb");
    if (file == NULL || fseek(file, (long)start, SEEK_SET) != 0) {
      if (file != NULL) fclose(file);
      free(bytes);
      return fail_line("read failed");
    }
    got = fread(bytes, 1, want, file);
    fclose(file);
  }
  jbuf_reset(&line);
  jbuf_text(&line, "{\"data\":{\"$b\":\"");
  base64_append(&line, bytes, got);
  jbuf_text(&line, "\"},\"size\":");
  jbuf_u64(&line, size);
  jbuf_text(&line, start + got >= size ? ",\"eof\":true}" : ",\"eof\":false}");
  free(bytes);
  return ok_line();
}

int fs_write(const char *path, size_t path_length, const char *data, size_t data_length, int mode) {
  if (!bound) return fail_int("fs is not mounted");
  if (!valid_path(path, path_length)) return fail_int("invalid path");
  if (mode != FS_WRITE_TRUNCATE && mode != FS_WRITE_APPEND) return fail_int("invalid write mode");
  uint8_t *bytes = NULL;
  long length = decode_payload(data, data_length, &bytes);
  if (length < 0) return fail_int("malformed payload: a JSON string or {\"$b\": base64}");
  if (length > FS_MAX_IO_BYTES) {
    free(bytes);
    return fail_int("write exceeds FS_MAX_IO_BYTES");
  }
  char full[FULL_BYTES];
  if (!full_path(path, path_length, full)) {
    free(bytes);
    return fail_int("invalid path");
  }
  uint64_t existing = 0;
  int kind = kind_of(full, &existing);
  if (kind == 2) {
    free(bytes);
    return fail_int("is a directory");
  }
  if (make_directories(path, path_length, false) != 0) {
    free(bytes);
    return 1;
  }
  uint64_t next = (mode == FS_WRITE_APPEND ? existing : 0) + (uint64_t)length;
  if (quota_bytes > 0 && usage_now() - existing + next > quota_bytes) {
    free(bytes);
    return fail_int("quota exceeded");
  }
  bool written;
  if (mode == FS_WRITE_APPEND) {
    FILE *file = fopen(full, "ab");
    written = file != NULL && (length == 0 || fwrite(bytes, 1, (size_t)length, file) == (size_t)length);
    if (file != NULL && fclose(file) != 0) written = false;
  } else {
    written = write_whole(staged_path, bytes, (size_t)length) && replace_with_staged(full);
  }
  free(bytes);
  if (!written) {
    used_known = false;
    return fail_int("write failed");
  }
  if (used_known) used_bytes = used_bytes - existing + next;
  return ok_int();
}

int fs_remove(const char *path, size_t path_length, int recursive) {
  if (!bound) return fail_int("fs is not mounted");
  if (!valid_path(path, path_length)) return fail_int("invalid path");
  char full[FULL_BYTES];
  if (!full_path(path, path_length, full)) return fail_int("invalid path");
  uint64_t size = 0;
  int kind = kind_of(full, &size);
  if (kind == 0) return fail_int("not found");
  if (kind == 1) {
    if (remove(full) != 0) return fail_int("remove failed");
    if (used_known) used_bytes -= size;
    return ok_int();
  }
  if (!directory_empty(full) && recursive != 1) return fail_int("directory not empty");
  used_known = false;
  if (!remove_tree(full, 0, FS_MAX_DEPTH)) return fail_int("remove failed");
  return ok_int();
}

typedef struct {
  char **names;
  size_t count;
  size_t capacity;
} NameList;

static int compare_names(const void *a, const void *b) {
  /* Byte order of UTF-8 is code point order. */
  return strcmp(*(char *const *)a, *(char *const *)b);
}

static void free_names(NameList *list) {
  for (size_t i = 0; i < list->count; i += 1) free(list->names[i]);
  free(list->names);
}

const char *fs_list(const char *path, size_t path_length, double offset) {
  if (!bound) return fail_line("fs is not mounted");
  if (path_length != 0 && !valid_path(path, path_length)) return fail_line("invalid path");
  char full[FULL_BYTES];
  if (!full_path(path, path_length, full)) return fail_line("invalid path");
  int kind = kind_of(full, NULL);
  if (kind == 1) return fail_line("not a directory");
  if (kind == 0) return fail_line("not found");
  DIR *directory = opendir(full);
  if (directory == NULL) return fail_line("list failed");
  NameList list = {0};
  struct dirent *entry;
  bool failed = false;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (list.count == list.capacity) {
      size_t capacity = list.capacity == 0 ? 16 : list.capacity * 2;
      char **names = realloc(list.names, capacity * sizeof *names);
      if (names == NULL) {
        failed = true;
        break;
      }
      list.names = names;
      list.capacity = capacity;
    }
    list.names[list.count] = strdup(entry->d_name);
    if (list.names[list.count] == NULL) {
      failed = true;
      break;
    }
    list.count += 1;
  }
  closedir(directory);
  if (failed) {
    free_names(&list);
    return fail_line("out of memory");
  }
  if (list.count > 1) qsort(list.names, list.count, sizeof *list.names, compare_names);
  size_t start = offset > 0 ? (offset >= (double)list.count ? list.count : (size_t)offset) : 0;
  size_t end = start + FS_MAX_DIR_ENTRIES < list.count ? start + FS_MAX_DIR_ENTRIES : list.count;
  jbuf_reset(&line);
  jbuf_text(&line, "{\"entries\":[");
  for (size_t i = start; i < end; i += 1) {
    char child[FULL_BYTES];
    uint64_t size = 0;
    int child_kind = 0;
    int written = snprintf(child, sizeof child, "%s/%s", full, list.names[i]);
    if (written > 0 && (size_t)written < sizeof child) child_kind = kind_of(child, &size);
    if (i > start) jbuf_text(&line, ",");
    jbuf_text(&line, "{\"name\":");
    jbuf_cstring(&line, list.names[i]);
    jbuf_text(&line, child_kind == 2 ? ",\"kind\":\"dir\",\"size\":0}" : ",\"kind\":\"file\",\"size\":");
    if (child_kind != 2) {
      jbuf_u64(&line, size);
      jbuf_text(&line, "}");
    }
  }
  jbuf_text(&line, end >= list.count ? "],\"eof\":true}" : "],\"eof\":false}");
  free_names(&list);
  return ok_line();
}

const char *fs_stat(const char *path, size_t path_length) {
  if (!bound) return fail_line("fs is not mounted");
  jbuf_reset(&line);
  if (path_length == 0) {
    jbuf_text(&line, "{\"kind\":\"dir\",\"size\":0}");
    return ok_line();
  }
  if (!valid_path(path, path_length)) return fail_line("invalid path");
  char full[FULL_BYTES];
  if (!full_path(path, path_length, full)) return fail_line("invalid path");
  uint64_t size = 0;
  int kind = kind_of(full, &size);
  if (kind == 0) return fail_line("not found");
  if (kind == 2) {
    jbuf_text(&line, "{\"kind\":\"dir\",\"size\":0}");
  } else {
    jbuf_text(&line, "{\"kind\":\"file\",\"size\":");
    jbuf_u64(&line, size);
    jbuf_text(&line, "}");
  }
  return ok_line();
}

int fs_mkdir(const char *path, size_t path_length) {
  if (!bound) return fail_int("fs is not mounted");
  if (!valid_path(path, path_length)) return fail_int("invalid path");
  if (make_directories(path, path_length, true) != 0) return 1;
  return ok_int();
}

/* The parent of a relative path ("" for a top-level name). */
static size_t parent_length(const char *path, size_t length) {
  for (size_t at = length; at > 0; at -= 1) {
    if (path[at - 1] == '/') return at - 1;
  }
  return 0;
}

int fs_rename(const char *from, size_t from_length, const char *to, size_t to_length) {
  if (!bound) return fail_int("fs is not mounted");
  if (!valid_path(from, from_length) || !valid_path(to, to_length)) return fail_int("invalid path");
  if (from_length == to_length && memcmp(from, to, from_length) == 0) return ok_int();
  char from_full[FULL_BYTES];
  char to_full[FULL_BYTES];
  char parent_full[FULL_BYTES];
  if (!full_path(from, from_length, from_full) || !full_path(to, to_length, to_full) ||
      !full_path(to, parent_length(to, to_length), parent_full)) {
    return fail_int("invalid path");
  }
  if (kind_of(parent_full, NULL) != 2) return fail_int("not found");
  int to_kind = kind_of(to_full, NULL);
  if (to_kind == 2) return fail_int("destination exists");
  int from_kind = kind_of(from_full, NULL);
  if (from_kind == 0) return fail_int("not found");
  if (from_kind == 1) {
    /* FAT refuses a rename onto an existing name: drop the old file first. */
    if (rename(from_full, to_full) != 0) {
      if (to_kind != 1 || remove(to_full) != 0 || rename(from_full, to_full) != 0) {
        used_known = false;
        return fail_int("rename failed");
      }
    }
    used_known = false;
    return ok_int();
  }
  if (to_kind == 1) return fail_int("destination exists");
  if (to_length > from_length && memcmp(to, from, from_length) == 0 && to[from_length] == '/') {
    return fail_int("cannot rename into own subtree");
  }
  if (rename(from_full, to_full) != 0) return fail_int("rename failed");
  return ok_int();
}

const char *fs_usage(void) {
  if (!bound) return fail_line("fs is not mounted");
  jbuf_reset(&line);
  jbuf_text(&line, "{\"usedBytes\":");
  jbuf_u64(&line, usage_now());
  jbuf_text(&line, ",\"quotaBytes\":");
  jbuf_u64(&line, quota_bytes);
  jbuf_text(&line, "}");
  return ok_line();
}

const char *fs_last_error(void) {
  return last_error;
}
