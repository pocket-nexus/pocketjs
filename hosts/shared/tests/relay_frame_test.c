/* Host harness for hosts/shared/relay_frame.c, driven by
 * tests/relay-frame-c.test.ts. It reads one wire record from a file and
 * prints what the C frame layer made of it, so the TypeScript side can
 * compare the result against the shared byte vectors under
 * tests/fixtures/relay/vectors byte for byte.
 *
 * Modes:
 *   decode <file> [options]            one record, report or error code
 *   bench  <file> <iterations> [opts]  decode the record N times, report ms
 *   queue                              bounded queue behaviour, no file
 *   prefix                             length-prefix checks, no file
 *   constants                          compiled header offsets and limits
 *
 * Options: --max-wire N  --max-meta N  --codecs a,b,c  --session <16 hex>
 *
 * Standard C11 only, matching the library: no POSIX call appears here. Exit
 * status is 0 when the harness ran, 1 when a self-test failed, and 2 on a
 * usage or I/O error; a rejected record is a result, not a harness failure. */
#include "../relay_frame.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_CODECS 64

typedef struct {
  RelayFrameLimits limits;
  uint16_t codecs[MAX_CODECS];
} Options;

static int parse_options(int argc, char **argv, int first, Options *options) {
  options->limits = relay_frame_limits_default();
  options->limits.max_wire_bytes = 0;
  options->limits.max_meta_bytes = 0;
  for (int i = first; i < argc; i++) {
    const char *flag = argv[i];
    if (i + 1 >= argc) return 0;
    const char *value = argv[++i];
    if (!strcmp(flag, "--max-wire")) {
      options->limits.max_wire_bytes = (uint32_t)strtoul(value, NULL, 10);
    } else if (!strcmp(flag, "--max-meta")) {
      options->limits.max_meta_bytes = (uint32_t)strtoul(value, NULL, 10);
    } else if (!strcmp(flag, "--session")) {
      options->limits.session = (uint64_t)strtoull(value, NULL, 16);
      options->limits.session_pinned = true;
    } else if (!strcmp(flag, "--codecs")) {
      size_t count = 0;
      const char *p = value;
      while (*p != '\0') {
        if (count >= MAX_CODECS) return 0;
        char *end = NULL;
        unsigned long codec = strtoul(p, &end, 10);
        if (end == p || codec > 0xffffu) return 0;
        options->codecs[count++] = (uint16_t)codec;
        p = end;
        if (*p == ',') p++;
      }
      options->limits.codecs = options->codecs;
      options->limits.codec_count = count;
    } else {
      return 0;
    }
  }
  return 1;
}

static unsigned char *read_file(const char *path, size_t *length) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long size = ftell(file);
  if (size < 0) {
    fclose(file);
    return NULL;
  }
  rewind(file);
  /* One spare byte keeps malloc(0) out of the empty-file case. */
  unsigned char *bytes = malloc((size_t)size + 1u);
  if (bytes == NULL) {
    fclose(file);
    return NULL;
  }
  if (fread(bytes, 1, (size_t)size, file) != (size_t)size) {
    free(bytes);
    fclose(file);
    return NULL;
  }
  fclose(file);
  *length = (size_t)size;
  return bytes;
}

static int print_hex(const char *label, const unsigned char *bytes, uint32_t length) {
  static const char digits[] = "0123456789abcdef";
  char *text = malloc((size_t)length * 2u + 1u);
  if (text == NULL) return 0;
  for (uint32_t i = 0; i < length; i++) {
    text[i * 2u] = digits[bytes[i] >> 4];
    text[i * 2u + 1u] = digits[bytes[i] & 0x0fu];
  }
  text[length * 2u] = '\0';
  printf("%s=%s\n", label, text);
  free(text);
  return 1;
}

static int run_decode(const unsigned char *record, size_t length, const Options *options) {
  RelayFrame frame;
  RelayFrameStatus status = relay_frame_decode(record, length, &options->limits, &frame);
  if (status != RELAY_FRAME_OK) {
    printf("err %s\n", relay_frame_status_name(status));
    return 0;
  }
  printf("ok type=%lu codec=%lu session=%016" PRIx64 " seq=%lu stream=%lu correlation=%lu"
         " metaBytes=%lu dataBytes=%lu metaOffset=%lu dataOffset=%lu\n",
         (unsigned long)frame.type, (unsigned long)frame.codec, frame.session,
         (unsigned long)frame.seq, (unsigned long)frame.stream, (unsigned long)frame.correlation,
         (unsigned long)frame.metadata_bytes, (unsigned long)frame.data_bytes,
         (unsigned long)(size_t)(frame.metadata - record), (unsigned long)(size_t)(frame.data - record));
  if (!print_hex("meta", frame.metadata, frame.metadata_bytes)) return 2;
  if (!print_hex("data", frame.data, frame.data_bytes)) return 2;
  return 0;
}

static int run_bench(const unsigned char *record, size_t length, unsigned long iterations,
                     const Options *options) {
  RelayFrame frame;
  RelayFrameStatus status = relay_frame_decode(record, length, &options->limits, &frame);
  if (status != RELAY_FRAME_OK) {
    printf("err %s\n", relay_frame_status_name(status));
    return 1;
  }
  /* Accumulating a field of every decode keeps the loop from being elided. */
  uint64_t checksum = 0;
  struct timespec start, end;
  if (timespec_get(&start, TIME_UTC) != TIME_UTC) return 2;
  for (unsigned long i = 0; i < iterations; i++) {
    if (relay_frame_decode(record, length, &options->limits, &frame) != RELAY_FRAME_OK) return 1;
    checksum += frame.metadata_bytes + frame.data_bytes + frame.seq;
  }
  if (timespec_get(&end, TIME_UTC) != TIME_UTC) return 2;
  double ms = (double)(end.tv_sec - start.tv_sec) * 1000.0
              + (double)(end.tv_nsec - start.tv_nsec) / 1000000.0;
  printf("frames=%lu wireBytes=%lu ms=%.3f checksum=%" PRIu64 "\n",
         iterations, (unsigned long)length, ms, checksum);
  return 0;
}

/* A minimal record the frame layer accepts: PUSH, codec 0, no data. The
 * metadata is never parsed here, only measured and UTF-8 checked. */
static const char queue_metadata[] = "{\"op\":\"relay.ping\"}";

static uint32_t build_record(unsigned char *out, uint32_t seq) {
  uint32_t meta_bytes = (uint32_t)(sizeof queue_metadata - 1u);
  uint32_t frame_bytes = RELAY_FRAME_HEADER_BODY_BYTES + meta_bytes;
  memset(out, 0, RELAY_FRAME_HEADER_BYTES);
  out[RELAY_OFF_FRAME_BYTES] = (unsigned char)(frame_bytes & 0xffu);
  out[RELAY_OFF_FRAME_BYTES + 1] = (unsigned char)((frame_bytes >> 8) & 0xffu);
  out[RELAY_OFF_MAGIC] = 'P';
  out[RELAY_OFF_MAGIC + 1] = 'R';
  out[RELAY_OFF_MAGIC + 2] = 'L';
  out[RELAY_OFF_MAGIC + 3] = 'Y';
  out[RELAY_OFF_MAJOR] = RELAY_FRAME_MAJOR;
  out[RELAY_OFF_MINOR] = RELAY_FRAME_MINOR;
  out[RELAY_OFF_TYPE] = (unsigned char)RELAY_TYPE_PUSH;
  out[RELAY_OFF_HEADER_BYTES] = (unsigned char)RELAY_FRAME_HEADER_BYTES;
  out[RELAY_OFF_SEQ] = (unsigned char)(seq & 0xffu);
  out[RELAY_OFF_META_BYTES] = (unsigned char)(meta_bytes & 0xffu);
  memcpy(out + RELAY_FRAME_HEADER_BYTES, queue_metadata, meta_bytes);
  return RELAY_FRAME_HEADER_BYTES + meta_bytes;
}

#define CHECK(condition)                                            \
  do {                                                              \
    if (!(condition)) {                                             \
      printf("check failed line %d: %s\n", __LINE__, #condition);   \
      return 1;                                                     \
    }                                                               \
  } while (0)

static int run_queue(void) {
  static RelayFrameQueue queue;
  static RelayFrameRecord popped;
  unsigned char record[RELAY_FRAME_HEADER_BYTES + sizeof queue_metadata];
  uint32_t length = build_record(record, 1);

  uint32_t accepted = 0;
  while (relay_frame_queue_push(&queue, record, length, accepted + 1u)) accepted++;
  CHECK(accepted > 0);
  CHECK(relay_frame_queue_queued_bytes(&queue) == accepted * length);

  /* Popping hands the frame over and frees its slot; the window bytes stay
   * charged until the consumer releases them. [R5-P09] */
  for (uint32_t i = 0; i < accepted; i++) {
    CHECK(relay_frame_queue_pop(&queue, &popped));
    CHECK(popped.length == length);
    CHECK(popped.generation == i + 1u);
    CHECK(memcmp(popped.bytes, record, length) == 0);
  }
  CHECK(!relay_frame_queue_pop(&queue, &popped));
  CHECK(relay_frame_queue_queued_bytes(&queue) == accepted * length);

  relay_frame_queue_release(&queue, accepted * length);
  CHECK(relay_frame_queue_queued_bytes(&queue) == 0);

  /* Admission validates before it enqueues, and a rejected record leaves the
   * queue untouched. */
  RelayFrameStatus status = RELAY_FRAME_OK;
  CHECK(relay_frame_admit(&queue, record, length, NULL, &status, NULL) == RELAY_ADMIT_ACCEPTED);
  CHECK(status == RELAY_FRAME_OK);
  CHECK(relay_frame_queue_queued_bytes(&queue) == length);

  unsigned char broken[sizeof record];
  memcpy(broken, record, length);
  broken[RELAY_OFF_MAGIC] = 'X';
  CHECK(relay_frame_admit(&queue, broken, length, NULL, &status, NULL) == RELAY_ADMIT_REJECTED);
  CHECK(status == RELAY_FRAME_BAD_MAGIC);
  CHECK(relay_frame_queue_queued_bytes(&queue) == length);

  /* A full queue answers busy and keeps the frames it already holds. */
  while (relay_frame_queue_push(&queue, record, length, 1)) { /* fill */ }
  CHECK(relay_frame_admit(&queue, record, length, NULL, &status, NULL) == RELAY_ADMIT_BUSY);
  CHECK(status == RELAY_FRAME_OK);

  printf("queue slots=%d windowBytes=%d recordBytes=%lu accepted=%lu\n",
         RELAY_FRAME_QUEUE_SLOTS, RELAY_FRAME_QUEUE_WINDOW_BYTES,
         (unsigned long)length, (unsigned long)accepted);
  return 0;
}

/* The reassembly path reads the declared length from a prefix before it has
 * the rest of the record; it must refuse a short or undersized prefix. */
static int run_prefix(void) {
  unsigned char record[RELAY_FRAME_HEADER_BYTES + sizeof queue_metadata];
  uint32_t length = build_record(record, 1);
  CHECK(relay_frame_declared_wire_bytes(record, length) == length);
  CHECK(relay_frame_declared_wire_bytes(record, RELAY_FRAME_LENGTH_PREFIX_BYTES) == length);
  for (size_t short_length = 0; short_length < RELAY_FRAME_LENGTH_PREFIX_BYTES; short_length++) {
    CHECK(relay_frame_declared_wire_bytes(record, short_length) == 0);
  }
  /* A prefix below the 44-byte header body is refused before it is trusted. */
  record[RELAY_OFF_FRAME_BYTES] = (unsigned char)(RELAY_FRAME_HEADER_BODY_BYTES - 1u);
  CHECK(relay_frame_declared_wire_bytes(record, length) == 0);
  printf("prefix ok\n");
  return 0;
}

static int run_constants(void) {
  printf("headerBytes=%lu headerBodyBytes=%lu lengthPrefixBytes=%lu major=%d minor=%d\n",
         (unsigned long)RELAY_FRAME_HEADER_BYTES, (unsigned long)RELAY_FRAME_HEADER_BODY_BYTES,
         (unsigned long)RELAY_FRAME_LENGTH_PREFIX_BYTES, RELAY_FRAME_MAJOR, RELAY_FRAME_MINOR);
  printf("offsets frameBytes=%lu magic=%lu major=%lu minor=%lu type=%lu flags=%lu"
         " headerBytes=%lu codec=%lu session=%lu seq=%lu stream=%lu correlation=%lu"
         " metaBytes=%lu dataBytes=%lu reserved=%lu\n",
         (unsigned long)RELAY_OFF_FRAME_BYTES, (unsigned long)RELAY_OFF_MAGIC,
         (unsigned long)RELAY_OFF_MAJOR, (unsigned long)RELAY_OFF_MINOR,
         (unsigned long)RELAY_OFF_TYPE, (unsigned long)RELAY_OFF_FLAGS,
         (unsigned long)RELAY_OFF_HEADER_BYTES, (unsigned long)RELAY_OFF_CODEC,
         (unsigned long)RELAY_OFF_SESSION, (unsigned long)RELAY_OFF_SEQ,
         (unsigned long)RELAY_OFF_STREAM, (unsigned long)RELAY_OFF_CORRELATION,
         (unsigned long)RELAY_OFF_META_BYTES, (unsigned long)RELAY_OFF_DATA_BYTES,
         (unsigned long)RELAY_OFF_RESERVED);
  printf("defaults maxWireBytes=%lu maxMetaBytes=%lu\n",
         (unsigned long)RELAY_DEFAULT_MAX_WIRE_BYTES, (unsigned long)RELAY_DEFAULT_MAX_META_BYTES);
  for (int status = RELAY_FRAME_OK; status <= RELAY_FRAME_BAD_METADATA; status++) {
    printf("status %d %s\n", status, relay_frame_status_name((RelayFrameStatus)status));
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: relay_frame_test decode|bench|queue|prefix|constants ...\n");
    return 2;
  }
  if (!strcmp(argv[1], "queue")) return run_queue();
  if (!strcmp(argv[1], "constants")) return run_constants();
  if (!strcmp(argv[1], "prefix")) return run_prefix();

  int is_bench = !strcmp(argv[1], "bench");
  if ((!is_bench && strcmp(argv[1], "decode")) || argc < 3) {
    fprintf(stderr, "usage: relay_frame_test decode|bench|queue|prefix|constants ...\n");
    return 2;
  }
  unsigned long iterations = 0;
  int first_option = 3;
  if (is_bench) {
    if (argc < 4) return 2;
    iterations = strtoul(argv[3], NULL, 10);
    first_option = 4;
  }
  Options options;
  if (!parse_options(argc, argv, first_option, &options)) {
    fprintf(stderr, "bad options\n");
    return 2;
  }
  size_t length = 0;
  unsigned char *record = read_file(argv[2], &length);
  if (record == NULL) {
    fprintf(stderr, "cannot read %s\n", argv[2]);
    return 2;
  }
  int code = is_bench ? run_bench(record, length, iterations, &options)
                      : run_decode(record, length, &options);
  free(record);
  return code;
}
