/*
 * Paired in-process development transport for Pocket Runtime.
 *
 * The main/render thread owns this bounded non-blocking pump. JSON control
 * frames feed the existing Pocket DevTools shim; `.pocket` uploads stream to
 * SD and screenshots stream from linear memory. Bulk bytes never enter JS.
 */

#include "devserver.h"

#include <3ds.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <malloc.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "dev_protocol.h"
#include "soc.h"

#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif

#define RX_BYTES (POCKET_RUNTIME_MAX_FRAME_BYTES + POCKET_RUNTIME_FRAME_HEADER_BYTES)
#define CTRL_IN_BYTES (4u * (POCKET_RUNTIME_MAX_CTRL_BYTES + 1u))
#define CTRL_OUT_BYTES (POCKET_RUNTIME_MAX_FRAME_BYTES + POCKET_RUNTIME_FRAME_HEADER_BYTES)
#define SCREENSHOT_CHUNK_BYTES (48u * 1024u)

static int server_fd = -1;
static int discovery_fd = -1;
static int client_fd = -1;
static bool initialized;
static bool authenticated;
static bool handshake_pending;
static bool handshake_accepted;
static uint8_t handshake_ack[POCKET_RUNTIME_ACK_BYTES];
static size_t handshake_ack_offset;
static uint64_t client_last_rx_ms;
static uint8_t pairing_token[POCKET_RUNTIME_TOKEN_BYTES];
static uint64_t device_id;

static uint8_t rx_buffer[RX_BYTES];
static size_t rx_length;
static uint8_t ctrl_input[CTRL_IN_BYTES];
static size_t ctrl_input_length;
static uint8_t tx_buffer[CTRL_OUT_BYTES];
static size_t tx_length;
static size_t tx_offset;
static bool pong_pending;
static uint8_t pong_payload[4];

static char hello_cache[1024];
static size_t hello_cache_length;

static FILE *upload_file;
static uint32_t upload_expected;
static uint32_t upload_received;
static uint64_t upload_hash;
static bool upload_ready;
static bool packages_allowed = true;

static bool screenshot_requested;
static bool screenshot_ready;
static uint8_t *screenshot_top;
static uint8_t *screenshot_auxiliary;
static uint32_t screenshot_top_bytes;
static uint32_t screenshot_auxiliary_bytes;
static uint32_t screenshot_frame;
static uint16_t screenshot_top_width;
static uint16_t screenshot_top_height;
static uint16_t screenshot_auxiliary_width;
static uint16_t screenshot_auxiliary_height;
static uint8_t screenshot_stage;
static uint8_t screenshot_surface;
static uint32_t screenshot_offset;

static PocketRuntimeState runtime_state;
static uint64_t running_hash;
static uint64_t variant_hash;
static uint32_t runtime_frame;
static char runtime_phase[32] = "starting";

static uint64_t rx_bytes;
static uint64_t tx_bytes;
static uint32_t connects;
static uint32_t auth_failures;
static uint32_t uploads;
static uint32_t screenshots;
static uint32_t timeouts;
static uint32_t discoveries;
static uint32_t frame_commands;
static uint32_t frame_vertices;
static uint32_t frame_dropped_vertices;
static char stats_json[1024];

/* Frame phase timing: the last complete 60-frame window's means and maxima,
 * plus a running count of frame intervals above 25 ms (1.5 vblanks at 60 Hz). */
enum { TIMING_PHASES = 5, TIMING_WINDOW = 60 };
static uint32_t timing_sum[TIMING_PHASES];
static uint32_t timing_max[TIMING_PHASES];
static uint32_t timing_count;
static uint32_t timing_mean_out[TIMING_PHASES];
static uint32_t timing_max_out[TIMING_PHASES];
static uint32_t timing_slow_frames;

static void set_error(char *out, size_t length, const char *format, ...) {
  if (out == NULL || length == 0) return;
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(out, length, format, arguments);
  va_end(arguments);
}

static bool would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

static void format_ip(char out[16]) {
  uint32_t ip = initialized ? gethostid() : 0;
  snprintf(
    out,
    16,
    "%lu.%lu.%lu.%lu",
    (unsigned long)(ip & 0xff),
    (unsigned long)((ip >> 8) & 0xff),
    (unsigned long)((ip >> 16) & 0xff),
    (unsigned long)((ip >> 24) & 0xff)
  );
}

static void close_upload(void) {
  if (upload_file != NULL) fclose(upload_file);
  upload_file = NULL;
  upload_expected = 0;
  upload_received = 0;
  upload_hash = 0;
}

void devserver_screenshot_cancel(void) {
  if (screenshot_top != NULL) linearFree(screenshot_top);
  if (screenshot_auxiliary != NULL) linearFree(screenshot_auxiliary);
  screenshot_top = NULL;
  screenshot_auxiliary = NULL;
  screenshot_top_bytes = 0;
  screenshot_auxiliary_bytes = 0;
  screenshot_ready = false;
  screenshot_stage = 0;
  screenshot_surface = 0;
  screenshot_offset = 0;
}

static void disconnect_client(void) {
  if (client_fd >= 0) close(client_fd);
  client_fd = -1;
  authenticated = false;
  handshake_pending = false;
  handshake_accepted = false;
  handshake_ack_offset = 0;
  rx_length = 0;
  ctrl_input_length = 0;
  tx_length = 0;
  tx_offset = 0;
  pong_pending = false;
  screenshot_requested = false;
  devserver_screenshot_cancel();
  if (upload_file != NULL && !upload_ready) close_upload();
}

static bool set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static int hex_digit(int value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static DevserverInitResult load_key(char *error, size_t error_length) {
  FILE *file = fopen(POCKET_RUNTIME_DEV_KEY, "rb");
  if (file == NULL) {
    if (errno == ENOENT) return DEVSERVER_DISABLED;
    set_error(error, error_length, "open %s failed (%d)", POCKET_RUNTIME_DEV_KEY, errno);
    return DEVSERVER_ERROR;
  }
  char hex[66] = {0};
  size_t length = fread(hex, 1, sizeof hex, file);
  int close_result = fclose(file);
  if (close_result != 0 || (length != 64 && length != 65) ||
      (length == 65 && hex[64] != '\n')) {
    set_error(error, error_length, "dev.key must contain exactly 64 hexadecimal characters");
    return DEVSERVER_ERROR;
  }
  for (size_t index = 0; index < POCKET_RUNTIME_TOKEN_BYTES; index += 1) {
    int high = hex_digit(hex[index * 2]);
    int low = hex_digit(hex[index * 2 + 1]);
    if (high < 0 || low < 0) {
      set_error(error, error_length, "dev.key contains a non-hexadecimal character");
      return DEVSERVER_ERROR;
    }
    pairing_token[index] = (uint8_t)((high << 4) | low);
  }
  device_id = pocket_runtime_device_id(pairing_token);
  return DEVSERVER_READY;
}

DevserverInitResult devserver_init(
  const PocketRuntimeState *state,
  char *error,
  size_t error_length
) {
  if (initialized) return DEVSERVER_READY;
  if (state != NULL) runtime_state = *state;
  DevserverInitResult key = load_key(error, error_length);
  if (key != DEVSERVER_READY) return key;

  if (!soc_ensure(error, error_length)) return DEVSERVER_ERROR;

  server_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (server_fd < 0) {
    set_error(error, error_length, "Pocket Runtime socket failed (%d)", errno);
    devserver_shutdown();
    return DEVSERVER_ERROR;
  }
  int reuse = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = INADDR_ANY;
  address.sin_port = htons(POCKET_RUNTIME_WIRE_PORT);
  if (bind(server_fd, (struct sockaddr *)&address, sizeof address) != 0 ||
      listen(server_fd, 1) != 0 || !set_nonblocking(server_fd)) {
    set_error(error, error_length, "Pocket Runtime listen on %u failed (%d)", POCKET_RUNTIME_WIRE_PORT, errno);
    devserver_shutdown();
    return DEVSERVER_ERROR;
  }

  discovery_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (discovery_fd >= 0) {
    setsockopt(discovery_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
    if (bind(discovery_fd, (struct sockaddr *)&address, sizeof address) != 0 ||
        !set_nonblocking(discovery_fd)) {
      close(discovery_fd);
      discovery_fd = -1;
    }
  }
  initialized = true;
  return DEVSERVER_READY;
}

void devserver_shutdown(void) {
  disconnect_client();
  close_upload();
  if (server_fd >= 0) close(server_fd);
  server_fd = -1;
  if (discovery_fd >= 0) close(discovery_fd);
  discovery_fd = -1;
  /* SOC itself is shared with the svc transport; main owns soc_shutdown. */
  initialized = false;
}

bool devserver_active(void) {
  return initialized;
}

bool devserver_connected(void) {
  return authenticated && client_fd >= 0;
}

void devserver_snapshot(DevserverSnapshot *out) {
  if (out == NULL) return;
  memset(out, 0, sizeof *out);
  out->enabled = initialized;
  out->discoverable = discovery_fd >= 0;
  out->connected = devserver_connected();
  format_ip(out->ip);
  snprintf(out->phase, sizeof out->phase, "%s", runtime_phase);
  out->port = POCKET_RUNTIME_WIRE_PORT;
  out->host_abi = POCKETJS_HOST_ABI;
  out->generation = runtime_state.generation;
  out->running_hash = running_hash;
  out->device_id = device_id;
  out->connects = connects;
  out->auth_failures = auth_failures;
  out->timeouts = timeouts;
  out->uploads = uploads;
  out->screenshots = screenshots;
}

static bool queue_frame(uint8_t type, uint8_t flags, const uint8_t *payload, size_t length) {
  if (length > POCKET_RUNTIME_MAX_FRAME_BYTES) return false;
  uint8_t header[POCKET_RUNTIME_FRAME_HEADER_BYTES];
  pocket_runtime_encode_frame_header(header, type, flags, (uint32_t)length);
  if (tx_offset > 0) {
    if (tx_offset < tx_length) {
      memmove(tx_buffer, tx_buffer + tx_offset, tx_length - tx_offset);
      tx_length -= tx_offset;
    } else {
      tx_length = 0;
    }
    tx_offset = 0;
  }
  if (sizeof header + length > sizeof tx_buffer - tx_length) return false;
  memcpy(tx_buffer + tx_length, header, sizeof header);
  tx_length += sizeof header;
  if (length > 0) {
    memcpy(tx_buffer + tx_length, payload, length);
    tx_length += length;
  }
  return true;
}

static size_t json_escape(char *out, size_t capacity, const char *text) {
  size_t written = 0;
  if (text == NULL) return 0;
  for (const unsigned char *at = (const unsigned char *)text; *at != 0; at += 1) {
    const char *escape = NULL;
    char unicode[7];
    if (*at == '"') escape = "\\\"";
    else if (*at == '\\') escape = "\\\\";
    else if (*at == '\n') escape = "\\n";
    else if (*at == '\r') escape = "\\r";
    else if (*at == '\t') escape = "\\t";
    else if (*at < 0x20) {
      snprintf(unicode, sizeof unicode, "\\u%04x", *at);
      escape = unicode;
    }
    if (escape != NULL) {
      size_t length = strlen(escape);
      if (written + length >= capacity) break;
      memcpy(out + written, escape, length);
      written += length;
    } else {
      if (written + 1 >= capacity) break;
      out[written++] = (char)*at;
    }
  }
  if (capacity > 0) out[written < capacity ? written : capacity - 1] = '\0';
  return written;
}

/*
 * On the way out a control record may be as large as a frame. tx_buffer is
 * sized for a whole frame and the screenshot path already pushes 48 KiB
 * through it, whereas MAX_CTRL_BYTES bounds what the TOOL sends — ctrl_input,
 * the inbound ring, is sized from it. Holding outgoing records to the inbound
 * bound cost the devtools tree dump: past a few hundred nodes it went over
 * 16 KiB and was discarded here without a word, which on the tool side is
 * indistinguishable from a hung device until the 15 s timeout expires.
 */
void devserver_send_ctrl(const char *line, size_t length) {
  if (line == NULL || length == 0) return;
  if (length > POCKET_RUNTIME_MAX_FRAME_BYTES) {
    /* Too large for any frame. Say so, so the caller waiting on this record
     * learns why it is never coming. */
    char notice[128];
    int written = snprintf(
      notice,
      sizeof notice,
      "{\"t\":\"ctrlDropped\",\"bytes\":%u,\"cap\":%u}",
      (unsigned)length,
      (unsigned)POCKET_RUNTIME_MAX_FRAME_BYTES
    );
    if (written > 0) {
      queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, (const uint8_t *)notice, (size_t)written);
    }
    return;
  }
  static const char hello_marker[] = "\"t\":\"hello\"";
  bool is_hello = false;
  if (length >= sizeof hello_marker - 1) {
    for (size_t offset = 0; offset + sizeof hello_marker - 1 <= length; offset += 1) {
      if (memcmp(line + offset, hello_marker, sizeof hello_marker - 1) == 0) {
        is_hello = true;
        break;
      }
    }
  }
  if (is_hello && length < sizeof hello_cache) {
    memcpy(hello_cache, line, length);
    hello_cache[length] = '\0';
    hello_cache_length = length;
  }
  queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, (const uint8_t *)line, length);
}

static void send_status(void) {
  char message[640];
  char ip[16];
  format_ip(ip);
  snprintf(
    message,
    sizeof message,
    "{\"t\":\"runtime.status\",\"phase\":\"%s\",\"target\":\"%s\",\"hostAbi\":%u,"
    "\"ip\":\"%s\",\"port\":%u,\"generation\":%lu,"
    "\"active\":\"%016llx\",\"lastGood\":\"%016llx\",\"running\":\"%016llx\","
    "\"frame\":%lu}",
    runtime_phase,
    POCKETJS_TARGET_ID,
    (unsigned)POCKETJS_HOST_ABI,
    ip,
    (unsigned)POCKET_RUNTIME_WIRE_PORT,
    (unsigned long)runtime_state.generation,
    (unsigned long long)runtime_state.active_hash,
    (unsigned long long)runtime_state.last_good_hash,
    (unsigned long long)running_hash,
    (unsigned long)runtime_frame
  );
  devserver_send_ctrl(message, strlen(message));
}

void devserver_report_install(const char *phase, uint64_t hash, const char *message) {
  char escaped[384] = {0};
  char line[640];
  json_escape(escaped, sizeof escaped, message == NULL ? "" : message);
  snprintf(
    line,
    sizeof line,
    "{\"t\":\"runtime.install\",\"phase\":\"%s\",\"hash\":\"%016llx\","
    "\"generation\":%lu,\"message\":\"%s\"}",
    phase == NULL ? "unknown" : phase,
    (unsigned long long)hash,
    (unsigned long)runtime_state.generation,
    escaped
  );
  devserver_send_ctrl(line, strlen(line));
}

void devserver_report_log(const char *level, const char *message) {
  char escaped[448] = {0};
  char line[560];
  json_escape(escaped, sizeof escaped, message == NULL ? "" : message);
  snprintf(
    line,
    sizeof line,
    "{\"t\":\"log\",\"level\":\"%s\",\"args\":[\"%s\"]}",
    level == NULL ? "info" : level,
    escaped
  );
  devserver_send_ctrl(line, strlen(line));
}

void devserver_set_runtime(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase,
  uint32_t frame
) {
  if (state != NULL) runtime_state = *state;
  running_hash = package == NULL ? 0 : package->guest.package_hash;
  variant_hash = package == NULL ? 0 : package->guest.variant_hash;
  runtime_frame = frame;
  snprintf(runtime_phase, sizeof runtime_phase, "%s", phase == NULL ? "unknown" : phase);
}

void devserver_set_frame_timing(
  uint32_t js_us,
  uint32_t tick_us,
  uint32_t draw_us,
  uint32_t gpu_us,
  uint32_t frame_us
) {
  const uint32_t values[TIMING_PHASES] = { js_us, tick_us, draw_us, gpu_us, frame_us };
  for (int i = 0; i < TIMING_PHASES; i += 1) {
    timing_sum[i] += values[i];
    if (values[i] > timing_max[i]) timing_max[i] = values[i];
  }
  /* 1.5 frames at 60 Hz: the frame missed its vblank */
  if (frame_us > 25000) timing_slow_frames += 1;
  timing_count += 1;
  if (timing_count == TIMING_WINDOW) {
    for (int i = 0; i < TIMING_PHASES; i += 1) {
      timing_mean_out[i] = timing_sum[i] / TIMING_WINDOW;
      timing_max_out[i] = timing_max[i];
      timing_sum[i] = 0;
      timing_max[i] = 0;
    }
    timing_count = 0;
  }
}

void devserver_set_frame_stats(
  uint32_t frame,
  uint32_t commands,
  uint32_t vertices,
  uint32_t dropped_vertices
) {
  runtime_frame = frame;
  frame_commands = commands;
  frame_vertices = vertices;
  frame_dropped_vertices = dropped_vertices;
}

const char *devserver_debug_stats(void) {
  snprintf(
    stats_json,
    sizeof stats_json,
    "{\"target\":\"%s\",\"hostAbi\":%u,\"package\":\"%016llx\","
    "\"variant\":\"%016llx\",\"generation\":%lu,\"frame\":%lu,"
    "\"gfx\":{\"commands\":%lu,\"vertices\":%lu,\"droppedVertices\":%lu},"
    "\"net\":{\"connected\":%s,\"rxBytes\":%llu,\"txBytes\":%llu,"
    "\"connects\":%lu,\"authFailures\":%lu,\"timeouts\":%lu,"
    "\"discoveries\":%lu,\"uploads\":%lu,\"screenshots\":%lu},"
    "\"timingUs\":{\"js\":[%lu,%lu],\"tick\":[%lu,%lu],\"draw\":[%lu,%lu],"
    "\"gpu\":[%lu,%lu],\"frame\":[%lu,%lu],\"slowFrames\":%lu}}",
    POCKETJS_TARGET_ID,
    (unsigned)POCKETJS_HOST_ABI,
    (unsigned long long)running_hash,
    (unsigned long long)variant_hash,
    (unsigned long)runtime_state.generation,
    (unsigned long)runtime_frame,
    (unsigned long)frame_commands,
    (unsigned long)frame_vertices,
    (unsigned long)frame_dropped_vertices,
    devserver_connected() ? "true" : "false",
    (unsigned long long)rx_bytes,
    (unsigned long long)tx_bytes,
    (unsigned long)connects,
    (unsigned long)auth_failures,
    (unsigned long)timeouts,
    (unsigned long)discoveries,
    (unsigned long)uploads,
    (unsigned long)screenshots,
    (unsigned long)timing_mean_out[0], (unsigned long)timing_max_out[0],
    (unsigned long)timing_mean_out[1], (unsigned long)timing_max_out[1],
    (unsigned long)timing_mean_out[2], (unsigned long)timing_max_out[2],
    (unsigned long)timing_mean_out[3], (unsigned long)timing_max_out[3],
    (unsigned long)timing_mean_out[4], (unsigned long)timing_max_out[4],
    (unsigned long)timing_slow_frames
  );
  return stats_json;
}

static void accept_client(void) {
  if (client_fd >= 0 || server_fd < 0) return;
  int fd = accept(server_fd, NULL, NULL);
  if (fd < 0) return;
  if (!set_nonblocking(fd)) {
    close(fd);
    return;
  }
  client_fd = fd;
  authenticated = false;
  handshake_pending = false;
  handshake_accepted = false;
  handshake_ack_offset = 0;
  rx_length = 0;
  ctrl_input_length = 0;
  tx_length = 0;
  tx_offset = 0;
  pong_pending = false;
  client_last_rx_ms = osGetTime();
}

static void poll_discovery(void) {
  if (discovery_fd < 0) return;
  for (uint32_t attempt = 0; attempt < 4; attempt += 1) {
    uint8_t request[POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES];
    struct sockaddr_in sender;
    socklen_t sender_length = sizeof sender;
    ssize_t length = recvfrom(
      discovery_fd,
      request,
      sizeof request,
      0,
      (struct sockaddr *)&sender,
      &sender_length
    );
    if (length < 0 && would_block()) return;
    if (length <= 0) return;
    if (!pocket_runtime_is_discovery_request(request, (size_t)length)) continue;

    uint8_t reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES];
    pocket_runtime_encode_discovery_reply(
      reply,
      POCKETJS_HOST_ABI,
      POCKET_RUNTIME_WIRE_PORT,
      devserver_connected() ? 1u : 0u,
      runtime_state.generation,
      runtime_state.active_hash,
      device_id,
      POCKETJS_TARGET_ID,
      "PocketJS 3DS"
    );
    if (sendto(
          discovery_fd,
          reply,
          sizeof reply,
          0,
          (struct sockaddr *)&sender,
          sender_length
        ) == (ssize_t)sizeof reply) {
      discoveries += 1;
    }
  }
}

static bool append_ctrl_input(const uint8_t *bytes, size_t length) {
  if (length == 0 || length + 1 > sizeof ctrl_input - ctrl_input_length) return false;
  memcpy(ctrl_input + ctrl_input_length, bytes, length);
  ctrl_input_length += length;
  ctrl_input[ctrl_input_length++] = '\n';
  return true;
}

static void abort_upload(const char *message) {
  uint64_t rejected = upload_hash;
  close_upload();
  upload_ready = false;
  devserver_report_install("transfer-error", rejected, message);
}

static void handle_package_begin(const uint8_t *payload, size_t length) {
  PocketRuntimePackageBegin begin;
  if (!pocket_runtime_parse_package_begin(payload, length, &begin)) {
    abort_upload("invalid package begin frame");
    return;
  }
  if (!packages_allowed) {
    devserver_report_install("rejected", begin.footer_hash, "This native host does not accept .pocket guest packages");
    return;
  }
  close_upload();
  upload_ready = false;
  upload_file = fopen(POCKET_RUNTIME_UPLOAD, "wb");
  if (upload_file == NULL) {
    devserver_report_install("transfer-error", begin.footer_hash, "open network staging file failed");
    return;
  }
  upload_expected = begin.length;
  upload_received = 0;
  upload_hash = begin.footer_hash;
  devserver_report_install("receiving", upload_hash, "binary package transfer started");
}

void devserver_allow_packages(bool allowed) {
  packages_allowed = allowed;
  if (!allowed && (upload_file != NULL || upload_ready))
    abort_upload("guest package admission disabled by host");
}

static void handle_package_chunk(const uint8_t *payload, size_t length) {
  if (upload_file == NULL || length <= 4) {
    abort_upload("package chunk arrived without an active transfer");
    return;
  }
  uint32_t offset = pocket_runtime_read_u32(payload);
  size_t bytes = length - 4;
  if (upload_received > upload_expected || offset != upload_received ||
      bytes > upload_expected - upload_received ||
      fwrite(payload + 4, 1, bytes, upload_file) != bytes) {
    abort_upload("package chunk offset, length, or SD write failed");
    return;
  }
  upload_received += (uint32_t)bytes;
}

static void handle_package_commit(void) {
  if (upload_file == NULL || upload_received != upload_expected) {
    abort_upload("package commit arrived before every declared byte");
    return;
  }
  bool written = fflush(upload_file) == 0 && fsync(fileno(upload_file)) == 0;
  if (fclose(upload_file) != 0) written = false;
  upload_file = NULL;
  if (!written) {
    abort_upload("flush network package staging file failed");
    return;
  }
  upload_ready = true;
  uploads += 1;
  devserver_report_install("received", upload_hash, "binary package transfer complete");
}

static void handle_frame(uint8_t type, uint8_t flags, const uint8_t *payload, size_t length) {
  if (flags != 0) {
    disconnect_client();
    return;
  }
  switch (type) {
    case POCKET_RUNTIME_MSG_PING:
      if (length == sizeof pong_payload) {
        memcpy(pong_payload, payload, sizeof pong_payload);
        pong_pending = true;
      }
      break;
    case POCKET_RUNTIME_MSG_CTRL:
      if (length <= POCKET_RUNTIME_MAX_CTRL_BYTES &&
          memchr(payload, '\n', length) == NULL &&
          memchr(payload, '\r', length) == NULL &&
          append_ctrl_input(payload, length)) break;
      disconnect_client();
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_BEGIN:
      handle_package_begin(payload, length);
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_CHUNK:
      handle_package_chunk(payload, length);
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_COMMIT:
      if (length == 0) handle_package_commit();
      else abort_upload("package commit payload must be empty");
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_ABORT:
      abort_upload("host aborted package transfer");
      break;
    case POCKET_RUNTIME_MSG_STATUS_REQUEST:
      if (length == 0) send_status();
      break;
    default:
      /* Unknown length-framed messages are skipped for forward compatibility. */
      break;
  }
}

static void receive_client(void) {
  if (client_fd < 0) return;
  if (handshake_pending) return;
  while (rx_length < sizeof rx_buffer) {
    ssize_t read = recv(client_fd, rx_buffer + rx_length, sizeof rx_buffer - rx_length, 0);
    if (read > 0) {
      rx_length += (size_t)read;
      rx_bytes += (uint64_t)read;
      client_last_rx_ms = osGetTime();
      continue;
    }
    if (read == 0) {
      disconnect_client();
      return;
    }
    if (would_block()) break;
    disconnect_client();
    return;
  }

  if (!authenticated) {
    if (rx_length < POCKET_RUNTIME_HELLO_BYTES) return;
    bool accepted = pocket_runtime_verify_hello(
      rx_buffer,
      POCKET_RUNTIME_HELLO_BYTES,
      pairing_token
    );
    pocket_runtime_encode_ack(
      handshake_ack,
      accepted ? 0 : 2,
      POCKETJS_HOST_ABI,
      runtime_state.generation,
      initialized ? 1u : 0u,
      runtime_state.active_hash
    );
    memmove(rx_buffer, rx_buffer + POCKET_RUNTIME_HELLO_BYTES, rx_length - POCKET_RUNTIME_HELLO_BYTES);
    rx_length -= POCKET_RUNTIME_HELLO_BYTES;
    handshake_pending = true;
    handshake_accepted = accepted;
    handshake_ack_offset = 0;
    if (!accepted) auth_failures += 1;
    return;
  }

  while (authenticated && rx_length >= POCKET_RUNTIME_FRAME_HEADER_BYTES) {
    PocketRuntimeFrameHeader header;
    if (!pocket_runtime_parse_frame_header(rx_buffer, rx_length, &header)) {
      disconnect_client();
      return;
    }
    size_t total = POCKET_RUNTIME_FRAME_HEADER_BYTES + (size_t)header.length;
    if (rx_length < total) break;
    handle_frame(
      header.type,
      header.flags,
      rx_buffer + POCKET_RUNTIME_FRAME_HEADER_BYTES,
      header.length
    );
    if (client_fd < 0) return;
    memmove(rx_buffer, rx_buffer + total, rx_length - total);
    rx_length -= total;
  }
  if (rx_length == sizeof rx_buffer) disconnect_client();
}

static void queue_screenshot_frame(void) {
  if (!screenshot_ready || tx_length != tx_offset) return;
  if (screenshot_stage == 0) {
    uint8_t begin[POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES];
    pocket_runtime_encode_screenshot_begin(
      begin,
      screenshot_frame,
      screenshot_top_width,
      screenshot_top_height,
      screenshot_auxiliary_width,
      screenshot_auxiliary_height,
      screenshot_top_bytes,
      screenshot_auxiliary_bytes
    );
    if (queue_frame(POCKET_RUNTIME_MSG_SCREENSHOT_BEGIN, 0, begin, sizeof begin)) {
      screenshot_stage = 1;
    }
    return;
  }
  if (screenshot_stage == 1) {
    uint8_t *surface = screenshot_surface == 0 ? screenshot_top : screenshot_auxiliary;
    uint32_t bytes = screenshot_surface == 0 ? screenshot_top_bytes : screenshot_auxiliary_bytes;
    if (screenshot_offset < bytes) {
      uint32_t amount = bytes - screenshot_offset;
      if (amount > SCREENSHOT_CHUNK_BYTES) amount = SCREENSHOT_CHUNK_BYTES;
      uint8_t payload[4 + SCREENSHOT_CHUNK_BYTES];
      pocket_runtime_write_u32(payload, screenshot_offset);
      memcpy(payload + 4, surface + screenshot_offset, amount);
      if (queue_frame(
            POCKET_RUNTIME_MSG_SCREENSHOT_CHUNK,
            screenshot_surface,
            payload,
            4 + amount
          )) {
        screenshot_offset += amount;
      }
      return;
    }
    if (screenshot_surface == 0) {
      screenshot_surface = 1;
      screenshot_offset = 0;
      return;
    }
    screenshot_stage = 2;
  }
  if (screenshot_stage == 2) {
    uint8_t end[4];
    pocket_runtime_write_u32(end, screenshot_frame);
    if (queue_frame(POCKET_RUNTIME_MSG_SCREENSHOT_END, 0, end, sizeof end)) {
      screenshot_stage = 3;
    }
    return;
  }
  if (screenshot_stage == 3) {
    screenshots += 1;
    devserver_screenshot_cancel();
  }
}

static void send_client(void) {
  if (client_fd < 0) return;
  if (handshake_pending) {
    ssize_t sent = send(
      client_fd,
      handshake_ack + handshake_ack_offset,
      sizeof handshake_ack - handshake_ack_offset,
      0
    );
    if (sent > 0) {
      handshake_ack_offset += (size_t)sent;
      tx_bytes += (uint64_t)sent;
      if (handshake_ack_offset == sizeof handshake_ack) {
        bool accepted = handshake_accepted;
        handshake_pending = false;
        handshake_ack_offset = 0;
        if (!accepted) {
          disconnect_client();
          return;
        }
        authenticated = true;
        connects += 1;
        if (hello_cache_length > 0) {
          queue_frame(
            POCKET_RUNTIME_MSG_CTRL,
            0,
            (const uint8_t *)hello_cache,
            hello_cache_length
          );
        }
        send_status();
      }
      return;
    }
    if (sent < 0 && would_block()) return;
    disconnect_client();
    return;
  }
  if (!devserver_connected()) return;
  if (pong_pending && tx_length == tx_offset &&
      queue_frame(POCKET_RUNTIME_MSG_PONG, 0, pong_payload, sizeof pong_payload)) {
    pong_pending = false;
  }
  queue_screenshot_frame();
  if (tx_offset >= tx_length) return;
  ssize_t sent = send(client_fd, tx_buffer + tx_offset, tx_length - tx_offset, 0);
  if (sent > 0) {
    tx_offset += (size_t)sent;
    tx_bytes += (uint64_t)sent;
    if (tx_offset == tx_length) {
      tx_offset = 0;
      tx_length = 0;
    }
    return;
  }
  if (sent < 0 && would_block()) return;
  disconnect_client();
}

void devserver_poll(void) {
  if (!initialized) return;
  poll_discovery();
  accept_client();
  receive_client();
  if (client_fd >= 0 && osGetTime() - client_last_rx_ms > 15u * 1000u) {
    timeouts += 1;
    disconnect_client();
    return;
  }
  send_client();
}

size_t devserver_recv_ctrl(char *out, size_t capacity) {
  if (out == NULL || capacity <= 1 || ctrl_input_length == 0) return 0;
  size_t length = ctrl_input_length < capacity - 1 ? ctrl_input_length : capacity - 1;
  /* Every accepted control frame has a synthetic newline. Never hand QuickJS
   * a partial JSON record when several queued frames approach its poll cap. */
  while (length > 0 && ctrl_input[length - 1] != '\n') length -= 1;
  if (length == 0) return 0;
  memcpy(out, ctrl_input, length);
  out[length] = '\0';
  memmove(ctrl_input, ctrl_input + length, ctrl_input_length - length);
  ctrl_input_length -= length;
  return length;
}

bool devserver_take_upload(uint64_t *declared_hash) {
  if (!upload_ready) return false;
  upload_ready = false;
  if (declared_hash != NULL) *declared_hash = upload_hash;
  upload_expected = 0;
  upload_received = 0;
  upload_hash = 0;
  return true;
}

bool devserver_request_screenshot(void) {
  if (!devserver_connected() || screenshot_requested || screenshot_ready) return false;
  screenshot_requested = true;
  return true;
}

bool devserver_take_screenshot_request(void) {
  if (!screenshot_requested) return false;
  screenshot_requested = false;
  return true;
}

bool devserver_screenshot_begin(
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint8_t **top,
  uint8_t **auxiliary
) {
  if (top == NULL || auxiliary == NULL || screenshot_ready || screenshot_top != NULL) return false;
  uint32_t top_bytes = (uint32_t)top_width * top_height * 3u;
  uint32_t auxiliary_bytes = (uint32_t)auxiliary_width * auxiliary_height * 3u;
  screenshot_top = linearAlloc(top_bytes);
  screenshot_auxiliary = linearAlloc(auxiliary_bytes);
  if (screenshot_top == NULL || screenshot_auxiliary == NULL) {
    devserver_screenshot_cancel();
    return false;
  }
  screenshot_frame = frame;
  screenshot_top_width = top_width;
  screenshot_top_height = top_height;
  screenshot_auxiliary_width = auxiliary_width;
  screenshot_auxiliary_height = auxiliary_height;
  screenshot_top_bytes = top_bytes;
  screenshot_auxiliary_bytes = auxiliary_bytes;
  *top = screenshot_top;
  *auxiliary = screenshot_auxiliary;
  return true;
}

void devserver_screenshot_ready(void) {
  if (screenshot_top == NULL || screenshot_auxiliary == NULL) return;
  screenshot_ready = true;
  screenshot_stage = 0;
  screenshot_surface = 0;
  screenshot_offset = 0;
}
