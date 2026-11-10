/*
 * Pocket Link 2 wire facts — see link2_proto.h. No sockets, no clock, no
 * allocation: every function works on the caller's memory.
 */

#include "link2_proto.h"

#include <string.h>

#include "sha256.h"

// ---------------------------------------------------------------------------
// little-endian fields
// ---------------------------------------------------------------------------

uint32_t link2_read_u32(const uint8_t *b) {
  return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}

uint16_t link2_read_u16(const uint8_t *b) {
  return (uint16_t)((uint16_t)b[0] | ((uint16_t)b[1] << 8));
}

static void write_u32(uint8_t *out, uint32_t value) {
  out[0] = (uint8_t)value;
  out[1] = (uint8_t)(value >> 8);
  out[2] = (uint8_t)(value >> 16);
  out[3] = (uint8_t)(value >> 24);
}

static void write_u16(uint8_t *out, uint16_t value) {
  out[0] = (uint8_t)value;
  out[1] = (uint8_t)(value >> 8);
}

static bool lower_hex(const char *text, size_t length) {
  for (size_t i = 0; i < length; i += 1) {
    char c = text[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool link2_valid_id(const char *text, size_t length) {
  return length == LINK2_ID_HEX && lower_hex(text, length);
}

const char *link2_close_name(uint32_t code) {
  switch (code) {
    case LINK2_CLOSE_PROTOCOL: return "protocol";
    case LINK2_CLOSE_TOO_LARGE: return "too_large";
    case LINK2_CLOSE_SILENCE: return "silence";
    case LINK2_CLOSE_FLOW: return "flow";
    case LINK2_CLOSE_AUTH: return "auth";
    case LINK2_CLOSE_REPLACED: return "replaced";
    case LINK2_CLOSE_FORGOTTEN: return "forgotten";
    case LINK2_CLOSE_RESTART: return "restart";
    case LINK2_CLOSE_HANDSHAKE_TIMEOUT: return "handshake_timeout";
    default: return "going_away";
  }
}

// ---------------------------------------------------------------------------
// beacon, preamble
// ---------------------------------------------------------------------------

bool link2_parse_beacon(const uint8_t *datagram, size_t length, Link2Beacon *out) {
  if (length != LINK2_BEACON_BYTES) return false;
  if (link2_read_u32(datagram) != LINK2_BEACON_MAGIC || datagram[4] != LINK2_VERSION) return false;
  out->port = link2_read_u16(datagram + 6);
  if (out->port == 0) return false;
  if (!link2_valid_id((const char *)datagram + 8, LINK2_ID_HEX)) return false;
  memcpy(out->companion, datagram + 8, LINK2_ID_HEX);
  out->companion[LINK2_ID_HEX] = '\0';
  size_t end = 0;
  while (end < LINK2_BEACON_NAME_BYTES && datagram[24 + end] != 0) end += 1;
  memcpy(out->name, datagram + 24, end);
  out->name[end] = '\0';
  return true;
}

void link2_write_preamble(uint8_t out[LINK2_PREAMBLE_BYTES]) {
  write_u32(out, LINK2_MAGIC);
  out[4] = LINK2_VERSION; /* highest */
  out[5] = LINK2_VERSION; /* lowest */
  out[6] = 0;             /* selected: the device sends 0 */
  out[7] = 0;
}

uint32_t link2_accept_preamble(const uint8_t bytes[LINK2_PREAMBLE_BYTES]) {
  if (link2_read_u32(bytes) != LINK2_MAGIC) return 0;
  /* The reserved byte is not checked: a later version may use it. */
  return bytes[6] == LINK2_VERSION ? LINK2_VERSION : 0;
}

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

void link2_write_header(uint8_t out[LINK2_HEADER_BYTES], uint8_t type, uint8_t flags, uint32_t length, uint32_t id) {
  out[0] = type;
  out[1] = flags;
  out[2] = 0;
  out[3] = 0;
  write_u32(out + 4, length);
  write_u32(out + 8, id);
}

int link2_id_range(uint32_t id) {
  if (id == 0 || id == LINK2_ID_HUB_BIT) return LINK2_RANGE_NONE;
  return id > LINK2_ID_DEVICE_MAX ? LINK2_RANGE_HUB : LINK2_RANGE_DEVICE;
}

/* The flags a known type defines; -1 for an unknown type. */
static int known_flags(uint8_t type) {
  switch (type) {
    case LINK2_FRAME_PING:
    case LINK2_FRAME_PONG:
    case LINK2_FRAME_CLOSE:
    case LINK2_FRAME_HANDSHAKE:
    case LINK2_FRAME_CANCEL:
    case LINK2_FRAME_CREDIT:
    case LINK2_FRAME_RESET:
      return 0;
    case LINK2_FRAME_REQUEST: return LINK2_FLAG_APP | LINK2_FLAG_BODY;
    case LINK2_FRAME_REPLY: return LINK2_FLAG_ERROR;
    case LINK2_FRAME_EVENT: return LINK2_FLAG_APP;
    case LINK2_FRAME_DATA: return LINK2_FLAG_END;
    default: return -1;
  }
}

uint32_t link2_check_frame(uint8_t type, uint8_t flags, uint32_t id, uint32_t length) {
  int known = known_flags(type);
  if (known < 0) return 0;
  if ((flags & ~(uint32_t)known) != 0) return LINK2_CLOSE_PROTOCOL;
  if (type == LINK2_FRAME_REQUEST && (flags & LINK2_FLAG_BODY) != 0 && (flags & LINK2_FLAG_APP) == 0) return LINK2_CLOSE_PROTOCOL;
  bool named = link2_id_range(id) != LINK2_RANGE_NONE;
  switch (type) {
    case LINK2_FRAME_PING:
    case LINK2_FRAME_PONG:
      if (id != 0 || length != LINK2_PING_BYTES) return LINK2_CLOSE_PROTOCOL;
      break;
    case LINK2_FRAME_CLOSE:
      if (id != 0 || length < 4 || length > 4 + LINK2_CLOSE_REASON_BYTES) return LINK2_CLOSE_PROTOCOL;
      break;
    case LINK2_FRAME_HANDSHAKE:
      if (id != 0) return LINK2_CLOSE_PROTOCOL;
      if (length > LINK2_MAX_HANDSHAKE) return LINK2_CLOSE_TOO_LARGE;
      break;
    case LINK2_FRAME_REQUEST:
    case LINK2_FRAME_REPLY:
      if (!named) return LINK2_CLOSE_PROTOCOL;
      break;
    case LINK2_FRAME_CANCEL:
      if (!named || length != 0) return LINK2_CLOSE_PROTOCOL;
      break;
    case LINK2_FRAME_EVENT:
      if (id == LINK2_ID_HUB_BIT) return LINK2_CLOSE_PROTOCOL;
      break;
    case LINK2_FRAME_DATA:
      if (!named) return LINK2_CLOSE_PROTOCOL;
      if (length == 0 && (flags & LINK2_FLAG_END) == 0) return LINK2_CLOSE_PROTOCOL;
      break;
    case LINK2_FRAME_CREDIT:
    case LINK2_FRAME_RESET:
      if (!named || length != 4) return LINK2_CLOSE_PROTOCOL;
      break;
    default:
      break;
  }
  if ((type == LINK2_FRAME_REQUEST || type == LINK2_FRAME_EVENT) && (flags & LINK2_FLAG_APP) != 0 && length < LINK2_APP_CHANNEL_PREFIX) {
    return LINK2_CLOSE_PROTOCOL;
  }
  return 0;
}

void link2_reader_init(Link2Reader *reader, uint8_t *buffer, uint32_t capacity) {
  memset(reader, 0, sizeof *reader);
  reader->buffer = buffer;
  reader->capacity = capacity;
  reader->limit = LINK2_MAX_HANDSHAKE < capacity ? LINK2_MAX_HANDSHAKE : capacity;
}

bool link2_reader_ready(Link2Reader *reader, uint32_t limit) {
  if (limit < LINK2_MIN_PAYLOAD || limit > LINK2_PAYLOAD_CEILING || limit > reader->capacity) return false;
  reader->limit = limit;
  reader->linked = true;
  return true;
}

static int reader_fail(Link2Reader *reader, uint32_t code, uint32_t *close) {
  reader->dead = true;
  *close = code;
  return LINK2_READ_ERROR;
}

/* A whole payload is in the buffer: the checks that read it. */
static int reader_finish(Link2Reader *reader, Link2Frame *frame, uint32_t *close) {
  uint8_t type = reader->header[0];
  reader->in_payload = false;
  if (type == LINK2_FRAME_CREDIT && link2_read_u32(reader->buffer) == 0) return reader_fail(reader, LINK2_CLOSE_PROTOCOL, close);
  if ((type == LINK2_FRAME_CLOSE || type == LINK2_FRAME_RESET) && link2_read_u16(reader->buffer + 2) != 0) {
    return reader_fail(reader, LINK2_CLOSE_PROTOCOL, close);
  }
  frame->type = type;
  frame->flags = reader->header[1];
  frame->id = link2_read_u32(reader->header + 8);
  frame->payload = reader->buffer;
  frame->length = reader->want;
  return LINK2_READ_FRAME;
}

int link2_reader_push(Link2Reader *reader, const uint8_t *bytes, size_t length, size_t *consumed, Link2Frame *frame, uint32_t *close) {
  size_t at = 0;
  *consumed = 0;
  if (reader->dead) {
    *close = LINK2_CLOSE_PROTOCOL;
    return LINK2_READ_ERROR;
  }
  while (at < length) {
    if (reader->skip > 0) {
      size_t n = length - at < reader->skip ? length - at : reader->skip;
      reader->skip -= (uint32_t)n;
      at += n;
      continue;
    }
    if (reader->in_payload) {
      size_t n = length - at;
      if (n > reader->want - reader->fill) n = reader->want - reader->fill;
      memcpy(reader->buffer + reader->fill, bytes + at, n);
      reader->fill += (uint32_t)n;
      at += n;
      if (reader->fill < reader->want) break;
      *consumed = at;
      return reader_finish(reader, frame, close);
    }
    size_t n = length - at;
    if (n > LINK2_HEADER_BYTES - reader->header_fill) n = LINK2_HEADER_BYTES - reader->header_fill;
    memcpy(reader->header + reader->header_fill, bytes + at, n);
    reader->header_fill += (uint32_t)n;
    at += n;
    if (reader->header_fill < LINK2_HEADER_BYTES) break;

    uint8_t type = reader->header[0];
    uint8_t flags = reader->header[1];
    uint32_t payload = link2_read_u32(reader->header + 4);
    uint32_t id = link2_read_u32(reader->header + 8);
    bool before_ready = type == LINK2_FRAME_PING || type == LINK2_FRAME_PONG || type == LINK2_FRAME_CLOSE || type == LINK2_FRAME_HANDSHAKE;
    *consumed = at;
    if (link2_read_u16(reader->header + 2) != 0) return reader_fail(reader, LINK2_CLOSE_PROTOCOL, close);
    if (!reader->linked && !before_ready) return reader_fail(reader, LINK2_CLOSE_PROTOCOL, close);
    if (reader->linked && type == LINK2_FRAME_HANDSHAKE) return reader_fail(reader, LINK2_CLOSE_PROTOCOL, close);
    if (payload > reader->limit) return reader_fail(reader, LINK2_CLOSE_TOO_LARGE, close);
    reader->header_fill = 0;
    if (known_flags(type) < 0) {
      reader->skip = payload;
      continue;
    }
    uint32_t bad = link2_check_frame(type, flags, id, payload);
    if (bad != 0) return reader_fail(reader, bad, close);
    reader->want = payload;
    reader->fill = 0;
    if (payload == 0) return reader_finish(reader, frame, close);
    reader->in_payload = true;
  }
  *consumed = at;
  return LINK2_READ_MORE;
}

size_t link2_write_ping(uint8_t *out, uint32_t counter) {
  link2_write_header(out, LINK2_FRAME_PING, 0, LINK2_PING_BYTES, 0);
  write_u32(out + LINK2_HEADER_BYTES, counter);
  return LINK2_PING_FRAME_BYTES;
}

size_t link2_write_pong(uint8_t *out, const uint8_t ping_payload[LINK2_PING_BYTES]) {
  link2_write_header(out, LINK2_FRAME_PONG, 0, LINK2_PING_BYTES, 0);
  memcpy(out + LINK2_HEADER_BYTES, ping_payload, LINK2_PING_BYTES);
  return LINK2_PING_FRAME_BYTES;
}

/* The length of the longest prefix of at most `max` bytes that ends on a
 * UTF-8 code point. */
static size_t utf8_prefix(const char *text, size_t length, size_t max) {
  if (length <= max) return length;
  size_t end = max;
  while (end > 0 && ((uint8_t)text[end] & 0xc0u) == 0x80u) end -= 1;
  return end;
}

size_t link2_write_close(uint8_t *out, uint32_t code, const char *reason) {
  size_t length = reason == NULL ? 0 : utf8_prefix(reason, strlen(reason), LINK2_CLOSE_REASON_BYTES);
  link2_write_header(out, LINK2_FRAME_CLOSE, 0, (uint32_t)(4 + length), 0);
  write_u16(out + LINK2_HEADER_BYTES, (uint16_t)code);
  write_u16(out + LINK2_HEADER_BYTES + 2, 0);
  if (length > 0) memcpy(out + LINK2_HEADER_BYTES + 4, reason, length);
  return LINK2_HEADER_BYTES + 4 + length;
}

size_t link2_write_credit(uint8_t *out, uint32_t id, uint32_t amount) {
  link2_write_header(out, LINK2_FRAME_CREDIT, 0, 4, id);
  write_u32(out + LINK2_HEADER_BYTES, amount);
  return LINK2_CREDIT_FRAME_BYTES;
}

size_t link2_write_reset(uint8_t *out, uint32_t id, uint32_t code) {
  link2_write_header(out, LINK2_FRAME_RESET, 0, 4, id);
  write_u16(out + LINK2_HEADER_BYTES, (uint16_t)code);
  write_u16(out + LINK2_HEADER_BYTES + 2, 0);
  return LINK2_RESET_FRAME_BYTES;
}

size_t link2_write_cancel(uint8_t *out, uint32_t id) {
  link2_write_header(out, LINK2_FRAME_CANCEL, 0, 0, id);
  return LINK2_HEADER_BYTES;
}

uint32_t link2_app_message_limit(uint32_t payload_limit) {
  uint32_t room = payload_limit - LINK2_APP_CHANNEL_PREFIX;
  return room < LINK2_APP_MSG_CEILING ? room : LINK2_APP_MSG_CEILING;
}

uint32_t link2_event_units(uint32_t json_bytes) {
  uint32_t units = (json_bytes + LINK2_APP_EVENT_UNIT - 1) / LINK2_APP_EVENT_UNIT;
  return units == 0 ? 1 : units;
}

static bool valid_offer(uint64_t value) {
  return value >= LINK2_MIN_PAYLOAD && value <= LINK2_PAYLOAD_CEILING;
}

uint32_t link2_payload_limit(uint64_t hello_max, uint64_t ready_max) {
  if (!valid_offer(hello_max) || !valid_offer(ready_max)) return 0;
  return (uint32_t)(hello_max < ready_max ? hello_max : ready_max);
}

// ---------------------------------------------------------------------------
// JSON writer
// ---------------------------------------------------------------------------

void link2_json_init(Link2Json *json, char *out, size_t capacity) {
  json->out = out;
  json->capacity = capacity;
  json->length = 0;
  json->failed = false;
}

void link2_json_raw(Link2Json *json, const char *text, size_t length) {
  if (json->failed) return;
  if (length > json->capacity - json->length) {
    json->failed = true;
    return;
  }
  memcpy(json->out + json->length, text, length);
  json->length += length;
}

void link2_json_text(Link2Json *json, const char *text) {
  link2_json_raw(json, text, strlen(text));
}

/* What JSON.stringify writes for one byte of a string; the escape's length. */
static size_t escape_byte(uint8_t c, char out[6]) {
  static const char HEX[] = "0123456789abcdef";
  char simple = 0;
  switch (c) {
    case '"': simple = '"'; break;
    case '\\': simple = '\\'; break;
    case '\b': simple = 'b'; break;
    case '\f': simple = 'f'; break;
    case '\n': simple = 'n'; break;
    case '\r': simple = 'r'; break;
    case '\t': simple = 't'; break;
    default: break;
  }
  if (simple != 0) {
    out[0] = '\\';
    out[1] = simple;
    return 2;
  }
  if (c < 0x20) {
    out[0] = '\\';
    out[1] = 'u';
    out[2] = '0';
    out[3] = '0';
    out[4] = HEX[c >> 4];
    out[5] = HEX[c & 15u];
    return 6;
  }
  out[0] = (char)c;
  return 1;
}

void link2_json_string(Link2Json *json, const char *text, size_t length) {
  link2_json_raw(json, "\"", 1);
  size_t run = 0;
  for (size_t i = 0; i < length; i += 1) {
    char escaped[6];
    size_t n = escape_byte((uint8_t)text[i], escaped);
    if (n == 1) continue;
    link2_json_raw(json, text + run, i - run);
    link2_json_raw(json, escaped, n);
    run = i + 1;
  }
  link2_json_raw(json, text + run, length - run);
  link2_json_raw(json, "\"", 1);
}

void link2_json_cstring(Link2Json *json, const char *text) {
  link2_json_string(json, text, strlen(text));
}

void link2_json_u64(Link2Json *json, uint64_t value) {
  char digits[20];
  size_t n = 0;
  do {
    digits[n++] = (char)('0' + value % 10);
    value /= 10;
  } while (value != 0);
  char text[20];
  for (size_t i = 0; i < n; i += 1) text[i] = digits[n - 1 - i];
  link2_json_raw(json, text, n);
}

size_t link2_encoded_bytes(const char *text, size_t length) {
  size_t bytes = 0;
  char escaped[6];
  for (size_t i = 0; i < length; i += 1) bytes += escape_byte((uint8_t)text[i], escaped);
  return bytes;
}

size_t link2_encoded_prefix(const char *text, size_t length, size_t max) {
  size_t used = 0;
  size_t at = 0;
  char escaped[6];
  while (at < length) {
    /* One code point: a lead byte and its continuation bytes. */
    size_t next = at + 1;
    while (next < length && ((uint8_t)text[next] & 0xc0u) == 0x80u) next += 1;
    size_t cost = 0;
    for (size_t i = at; i < next; i += 1) cost += escape_byte((uint8_t)text[i], escaped);
    if (used + cost > max) break;
    used += cost;
    at = next;
  }
  return at;
}

// ---------------------------------------------------------------------------
// JSON reading beyond jscan: arrays
// ---------------------------------------------------------------------------

static size_t skip_space(const char *text, size_t length, size_t at) {
  while (at < length && (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r')) at += 1;
  return at;
}

/* The index after the value that starts at `at`, or 0 when it is malformed. */
static size_t skip_value(const char *text, size_t length, size_t at) {
  if (at >= length) return 0;
  char c = text[at];
  if (c == '"') {
    at += 1;
    while (at < length) {
      if (text[at] == '\\') at += 2;
      else if (text[at] == '"') return at + 1;
      else at += 1;
    }
    return 0;
  }
  if (c == '{' || c == '[') {
    size_t depth = 0;
    while (at < length) {
      char d = text[at];
      if (d == '"') {
        at = skip_value(text, length, at);
        if (at == 0) return 0;
        continue;
      }
      if (d == '{' || d == '[') depth += 1;
      if (d == '}' || d == ']') {
        depth -= 1;
        if (depth == 0) return at + 1;
      }
      at += 1;
    }
    return 0;
  }
  size_t start = at;
  while (at < length && text[at] != ',' && text[at] != ']' && text[at] != '}' && text[at] != ' ' && text[at] != '\n' && text[at] != '\r' && text[at] != '\t') at += 1;
  return at > start ? at : 0;
}

bool link2_array_next(JsonSpan array, size_t *at, JsonSpan *element, bool *malformed) {
  const char *text = array.start;
  size_t length = array.length;
  size_t i = *at;
  *malformed = false;
  if (i == 0) {
    i = skip_space(text, length, 0);
    if (i >= length || text[i] != '[') {
      *malformed = true;
      return false;
    }
    i = skip_space(text, length, i + 1);
    if (i < length && text[i] == ']') return false;
  } else {
    i = skip_space(text, length, i);
    if (i < length && text[i] == ']') return false;
    if (i >= length || text[i] != ',') {
      *malformed = true;
      return false;
    }
    i = skip_space(text, length, i + 1);
  }
  size_t end = skip_value(text, length, i);
  if (end == 0) {
    *malformed = true;
    return false;
  }
  element->start = text + i;
  element->length = end - i;
  *at = end;
  return true;
}

bool link2_is_string(JsonSpan value) {
  size_t at = skip_space(value.start, value.length, 0);
  return at < value.length && value.start[at] == '"';
}

// ---------------------------------------------------------------------------
// handshake
// ---------------------------------------------------------------------------

void link2_proof(
  const uint8_t key[LINK2_KEY_BYTES],
  const char *label,
  const char *device_nonce,
  const char *companion_nonce,
  const char *device,
  const char *companion,
  uint8_t out[32]
) {
  HmacSha256 context;
  hmac_sha256_init(&context, key, LINK2_KEY_BYTES);
  const char *parts[5] = {label, device_nonce, companion_nonce, device, companion};
  for (size_t i = 0; i < 5; i += 1) {
    if (i > 0) hmac_sha256_update(&context, "\n", 1);
    hmac_sha256_update(&context, parts[i], strlen(parts[i]));
  }
  hmac_sha256_final(&context, out);
}

static void write_features(Link2Json *json, const char *const *features, size_t count) {
  link2_json_text(json, "[");
  for (size_t i = 0; i < count; i += 1) {
    if (i > 0) link2_json_text(json, ",");
    link2_json_cstring(json, features[i]);
  }
  link2_json_text(json, "]");
}

void link2_write_hello(Link2Json *json, const Link2Hello *hello) {
  link2_json_text(json, "{\"t\":\"hello\",\"device\":");
  link2_json_cstring(json, hello->device);
  link2_json_text(json, ",\"companion\":");
  link2_json_cstring(json, hello->companion);
  link2_json_text(json, ",\"nonce\":");
  link2_json_cstring(json, hello->nonce);
  link2_json_text(json, ",\"name\":");
  link2_json_string(json, hello->name, link2_encoded_prefix(hello->name, strlen(hello->name), LINK2_NAME_BYTES));
  link2_json_text(json, ",\"model\":");
  link2_json_string(json, hello->model, link2_encoded_prefix(hello->model, strlen(hello->model), LINK2_MODEL_BYTES));
  link2_json_text(json, ",\"target\":");
  link2_json_cstring(json, hello->target);
  link2_json_text(json, ",\"hostAbi\":");
  link2_json_u64(json, hello->host_abi);
  link2_json_text(json, ",\"features\":");
  write_features(json, hello->features, hello->feature_count);
  link2_json_text(json, ",\"maxPayload\":");
  link2_json_u64(json, hello->max_payload);
  link2_json_text(json, "}");
}

void link2_write_auth(Link2Json *json, const char proof_hex[65]) {
  link2_json_text(json, "{\"t\":\"auth\",\"proof\":");
  link2_json_cstring(json, proof_hex);
  link2_json_text(json, "}");
}

static bool t_is(JsonSpan object, const char *name) {
  char t[32];
  return json_is_object(object) && json_find_string(object, "t", t, sizeof t) && strcmp(t, name) == 0;
}

bool link2_parse_challenge(JsonSpan object, Link2Challenge *out) {
  char proof[80];
  char nonce[48];
  if (!t_is(object, "challenge")) return false;
  if (!json_find_string(object, "nonce", nonce, sizeof nonce) || strlen(nonce) != 2 * LINK2_NONCE_BYTES || !lower_hex(nonce, strlen(nonce))) return false;
  if (!json_find_string(object, "proof", proof, sizeof proof) || strlen(proof) != 64 || !lower_hex(proof, 64)) return false;
  memcpy(out->nonce, nonce, 2 * LINK2_NONCE_BYTES + 1);
  return hex_decode(proof, 64, out->proof, 32);
}

bool link2_parse_features(JsonSpan array, Link2Features *out) {
  size_t at = 0;
  bool malformed = false;
  JsonSpan element;
  out->count = 0;
  if (!json_is_array(array)) return false;
  while (link2_array_next(array, &at, &element, &malformed)) {
    char name[LINK2_FEATURE_BYTES * 2 + 2];
    if (out->count == LINK2_MAX_FEATURES) return false;
    if (!link2_is_string(element)) return false;
    long length = json_string_strict(element, name, sizeof name);
    if (length <= 0 || (size_t)length != strlen(name)) return false;
    if (link2_encoded_bytes(name, (size_t)length) > LINK2_FEATURE_BYTES) return false;
    memcpy(out->features[out->count], name, (size_t)length + 1);
    out->count += 1;
  }
  return !malformed;
}

bool link2_features_has(const Link2Features *list, const char *name) {
  for (size_t i = 0; i < list->count; i += 1) {
    if (strcmp(list->features[i], name) == 0) return true;
  }
  return false;
}

bool link2_parse_ready(JsonSpan object, Link2Ready *out) {
  JsonSpan value, clock;
  uint64_t number = 0;
  if (!t_is(object, "ready")) return false;
  if (!json_find(object, "name", &value) || !link2_is_string(value)) return false;
  long length = json_string_strict(value, out->name, sizeof out->name);
  if (length < 0 || link2_encoded_bytes(out->name, (size_t)length) > LINK2_NAME_BYTES) return false;
  if (!json_find(object, "features", &value) || !link2_parse_features(value, &out->features)) return false;
  if (!json_find_u64(object, "maxPayload", &number) || !valid_offer(number)) return false;
  out->max_payload = (uint32_t)number;
  if (!json_find(object, "clock", &clock) || !json_is_object(clock)) return false;
  if (!json_find_u64(clock, "utc", &out->clock_utc)) return false;
  if (!json_find_u64(clock, "local", &number)) return false;
  out->clock_local = (int64_t)number;
  return true;
}

bool link2_parse_refused(JsonSpan object, char *code, size_t capacity) {
  static const char *const CODES[] = {"unknown_device", "bad_proof", "malformed", "busy"};
  if (!t_is(object, "refused") || !json_find_string(object, "code", code, capacity)) return false;
  for (size_t i = 0; i < sizeof CODES / sizeof CODES[0]; i += 1) {
    if (strcmp(code, CODES[i]) == 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// pairing files
// ---------------------------------------------------------------------------

bool link2_parse_device_file(const char *text, size_t length, char id[LINK2_ID_HEX + 1]) {
  while (length > 0 && (text[length - 1] == '\n' || text[length - 1] == '\r' || text[length - 1] == ' ')) length -= 1;
  if (!link2_valid_id(text, length)) return false;
  memcpy(id, text, LINK2_ID_HEX);
  id[LINK2_ID_HEX] = '\0';
  return true;
}

bool link2_key_file_id(const char *name, char id[LINK2_ID_HEX + 1]) {
  if (strlen(name) != LINK2_ID_HEX + 4 || strcmp(name + LINK2_ID_HEX, ".txt") != 0) return false;
  if (!link2_valid_id(name, LINK2_ID_HEX)) return false;
  memcpy(id, name, LINK2_ID_HEX);
  id[LINK2_ID_HEX] = '\0';
  return true;
}

/* The value of the last `key=` line of a file of `key=value` lines; a line's
 * final '\r' is not part of its value. */
static bool file_field(const char *text, size_t length, const char *key, const char **value, size_t *value_length) {
  size_t key_length = strlen(key);
  bool found = false;
  size_t at = 0;
  while (at <= length) {
    size_t end = at;
    while (end < length && text[end] != '\n') end += 1;
    size_t line = end - at;
    if (line > 0 && text[at + line - 1] == '\r') line -= 1;
    if (line > key_length && memcmp(text + at, key, key_length) == 0 && text[at + key_length] == '=') {
      *value = text + at + key_length + 1;
      *value_length = line - key_length - 1;
      found = true;
    }
    at = end + 1;
  }
  return found;
}

static bool ipv4(const char *text, size_t length) {
  size_t at = 0;
  for (int part = 0; part < 4; part += 1) {
    size_t digits = 0;
    unsigned value = 0;
    while (at < length && text[at] >= '0' && text[at] <= '9' && digits < 4) {
      value = value * 10 + (unsigned)(text[at] - '0');
      at += 1;
      digits += 1;
    }
    if (digits == 0 || digits > 3 || value > 255) return false;
    if (digits > 1 && text[at - digits] == '0') return false;
    if (part < 3) {
      if (at >= length || text[at] != '.') return false;
      at += 1;
    }
  }
  return at == length;
}

static void read_address(const char *text, size_t length, char out[16]) {
  const char *value;
  size_t n;
  out[0] = '\0';
  if (!file_field(text, length, "address", &value, &n) || n > 15 || !ipv4(value, n)) return;
  memcpy(out, value, n);
  out[n] = '\0';
}

static uint16_t read_port(const char *text, size_t length) {
  const char *value;
  size_t n;
  unsigned port = 0;
  if (!file_field(text, length, "port", &value, &n) || n == 0 || n > 5) return 0;
  for (size_t i = 0; i < n; i += 1) {
    if (value[i] < '0' || value[i] > '9') return 0;
    port = port * 10 + (unsigned)(value[i] - '0');
  }
  return port >= 1 && port <= 65535 ? (uint16_t)port : 0;
}

static void read_name(const char *text, size_t length, char out[LINK2_NAME_BYTES + 1]) {
  const char *value;
  size_t n;
  out[0] = '\0';
  if (!file_field(text, length, "name", &value, &n)) return;
  n = utf8_prefix(value, n, LINK2_NAME_BYTES);
  memcpy(out, value, n);
  out[n] = '\0';
}

bool link2_parse_companion_file(const char *text, size_t length, Link2Companion *out) {
  const char *value;
  size_t n;
  if (!file_field(text, length, "key", &value, &n) || n != 2 * LINK2_KEY_BYTES || !lower_hex(value, n)) return false;
  if (!hex_decode(value, n, out->key, LINK2_KEY_BYTES)) return false;
  read_name(text, length, out->name);
  read_address(text, length, out->address);
  out->port = read_port(text, length);
  if (out->port == 0) out->port = LINK2_PORT;
  return true;
}

bool link2_parse_last_file(const char *text, size_t length, Link2Companion *into) {
  char address[16];
  uint16_t port = read_port(text, length);
  read_address(text, length, address);
  if (address[0] == '\0' || port == 0) return false;
  read_name(text, length, into->name);
  memcpy(into->address, address, sizeof address);
  into->port = port;
  return true;
}

void link2_companions_add(Link2Companions *set, const char *file_name, const char *text, size_t length) {
  Link2Companion parsed;
  if (!link2_key_file_id(file_name, parsed.id) || !link2_parse_companion_file(text, length, &parsed)) return;
  if (set->count == LINK2_MAX_COMPANIONS) {
    set->overflow = true;
    return;
  }
  set->list[set->count++] = parsed;
}

void link2_companions_last(Link2Companions *set, const char *id, const char *text, size_t length) {
  for (size_t i = 0; i < set->count; i += 1) {
    if (strcmp(set->list[i].id, id) == 0) link2_parse_last_file(text, length, &set->list[i]);
  }
}

size_t link2_format_last_file(char *out, size_t capacity, const char *name, const char *address, uint16_t port) {
  Link2Json writer;
  link2_json_init(&writer, out, capacity);
  link2_json_text(&writer, "name=");
  for (const char *c = name; *c != '\0'; c += 1) {
    char one = (*c == '\n' || *c == '\r') ? ' ' : *c;
    link2_json_raw(&writer, &one, 1);
  }
  link2_json_text(&writer, "\naddress=");
  link2_json_text(&writer, address);
  link2_json_text(&writer, "\nport=");
  link2_json_u64(&writer, port);
  link2_json_text(&writer, "\n");
  return writer.failed ? 0 : writer.length;
}

// ---------------------------------------------------------------------------
// reading an EVENT (§5.3)
// ---------------------------------------------------------------------------

#define RULE_ZERO 1
#define RULE_REQUEST 2
#define RULE_CHANNEL 3
#define RULE_STREAM 4
#define RULE_SCREENSHOT 5

static int system_rule(const char *t) {
  static const struct {
    const char *t;
    int rule;
  } RULES[] = {
    {"features", RULE_ZERO},        {"catalog.changed", RULE_ZERO},  {"runtime.status", RULE_ZERO},
    {"runtime.apps", RULE_ZERO},    {"log", RULE_ZERO},              {"devtools.listen", RULE_ZERO},
    {"agent.hello", RULE_ZERO},     {"agent.turn", RULE_ZERO},       {"agent.audio.end", RULE_ZERO},
    {"agent.cancel", RULE_ZERO},    {"agent.reset", RULE_ZERO},      {"agent.result", RULE_ZERO},
    {"agent.state", RULE_ZERO},     {"agent.transcript", RULE_ZERO}, {"agent.request", RULE_ZERO},
    {"agent.delta", RULE_ZERO},     {"agent.step", RULE_ZERO},       {"agent.tool", RULE_ZERO},
    {"agent.usage", RULE_ZERO},     {"agent.done", RULE_ZERO},       {"agent.error", RULE_ZERO},
    {"runtime.install", RULE_REQUEST}, {"runtime.native", RULE_REQUEST}, {"install.head", RULE_REQUEST},
    {"net.head", RULE_REQUEST},     {"channel.close", RULE_CHANNEL}, {"agent.audio", RULE_STREAM},
    {"agent.shot", RULE_STREAM},    {"agent.screen", RULE_STREAM},   {"agent.glyphs", RULE_STREAM},
    {"runtime.screenshot", RULE_SCREENSHOT},
  };
  for (size_t i = 0; i < sizeof RULES / sizeof RULES[0]; i += 1) {
    if (strcmp(t, RULES[i].t) == 0) return RULES[i].rule;
  }
  return 0;
}

int link2_read_event(uint32_t id, bool app, const char *t, const Link2Holdings *holds, bool *opens_stream) {
  int range = link2_id_range(id);
  *opens_stream = false;
  if (id != 0 && range == LINK2_RANGE_NONE) return LINK2_EVENT_CLOSE;
  /* Step 1: an open request of an applet channel. */
  if (id != 0 && holds->channel_request(holds->context, id)) return LINK2_EVENT_APP_PROGRESS;
  /* Step 2: the APP flag. */
  if (app) {
    if (id == 0) return LINK2_EVENT_APP;
    if (range != LINK2_RANGE_HUB || holds->in_use(holds->context, id)) return LINK2_EVENT_CLOSE;
    *opens_stream = true;
    return LINK2_EVENT_APP;
  }
  /* Step 3: a non-zero id of the device's own range that names nothing held. */
  if (id != 0 && range == LINK2_RANGE_DEVICE && !holds->in_use(holds->context, id)) return LINK2_EVENT_IGNORE;
  /* Step 4: a system event; `t` defines what the id means. */
  bool fresh = id != 0 && range == LINK2_RANGE_HUB && !holds->in_use(holds->context, id);
  int rule = t == NULL ? 0 : system_rule(t);
  switch (rule) {
    case RULE_ZERO:
      return id == 0 ? LINK2_EVENT_SYSTEM : LINK2_EVENT_CLOSE;
    case RULE_REQUEST:
      return holds->own_request(holds->context, id) ? LINK2_EVENT_SYSTEM : LINK2_EVENT_CLOSE;
    case RULE_CHANNEL:
      if (holds->channel(holds->context, id)) return LINK2_EVENT_SYSTEM;
      /* A close that crossed another: the channel is already closed. */
      return fresh ? LINK2_EVENT_IGNORE : LINK2_EVENT_CLOSE;
    case RULE_STREAM:
      if (!fresh) return LINK2_EVENT_CLOSE;
      *opens_stream = true;
      return LINK2_EVENT_SYSTEM;
    case RULE_SCREENSHOT:
      if (holds->own_request(holds->context, id)) return LINK2_EVENT_SYSTEM;
      if (!fresh) return LINK2_EVENT_CLOSE;
      *opens_stream = true;
      return LINK2_EVENT_SYSTEM;
    default:
      return fresh ? LINK2_EVENT_RESET_REFUSED : LINK2_EVENT_IGNORE;
  }
}

// ---------------------------------------------------------------------------
// keepalive, credit
// ---------------------------------------------------------------------------

void link2_keepalive_init(Link2Keepalive *alive, uint64_t now) {
  alive->last_received = now;
  alive->last_ping = now;
}

void link2_keepalive_received(Link2Keepalive *alive, uint64_t now) {
  alive->last_received = now;
}

int link2_keepalive_tick(Link2Keepalive *alive, uint64_t now) {
  if (now - alive->last_received >= LINK2_SILENCE_MS) return LINK2_ALIVE_SILENCE;
  if (now - alive->last_ping >= LINK2_PING_MS) {
    alive->last_ping = now;
    return LINK2_ALIVE_PING;
  }
  return LINK2_ALIVE_OK;
}

bool link2_credit_grant(uint32_t *available, uint32_t bytes) {
  if ((uint64_t)*available + bytes > LINK2_MAX_CREDIT) return false;
  *available += bytes;
  return true;
}

bool link2_credit_received(uint32_t *outstanding, uint32_t bytes) {
  if (bytes > *outstanding) return false;
  *outstanding -= bytes;
  return true;
}

uint32_t link2_app_window_grant(Link2AppWindow *window) {
  uint32_t occupied = window->outstanding + window->held;
  /* While a read is pending the whole window is granted, not the read's
   * size alone: the bytes of the next reads are in flight while the guest
   * takes this one's. A stream nobody reads is granted nothing. */
  if (window->wanted == 0 || occupied >= window->window) return 0;
  uint32_t due = window->window - occupied;
  window->outstanding += due;
  return due;
}

uint32_t link2_app_window_take(Link2AppWindow *window, uint32_t budget) {
  uint32_t n = window->held;
  if (n > window->wanted) n = window->wanted;
  if (n > budget) n = budget;
  if (n == 0) return 0;
  window->held -= n;
  window->wanted = 0;
  return n;
}

// ---------------------------------------------------------------------------
// runtime.apps pages, log, names, CRC-32
// ---------------------------------------------------------------------------

static void write_app_row(Link2Json *json, const Link2InstalledApp *row) {
  link2_json_text(json, "{\"id\":");
  link2_json_cstring(json, row->id);
  link2_json_text(json, ",\"output\":");
  link2_json_cstring(json, row->output);
  link2_json_text(json, ",\"version\":");
  link2_json_cstring(json, row->version);
  link2_json_text(json, ",\"hash\":");
  link2_json_cstring(json, row->hash);
  if (row->home) link2_json_text(json, ",\"home\":true");
  link2_json_text(json, "}");
}

bool link2_write_apps_page(Link2Json *json, const Link2InstalledApp *rows, size_t count, size_t *at, uint32_t set, uint32_t payload_limit) {
  /* A page is sized for `"more":false`, the longer form, so it never grows
   * past the limit when it turns out to be the last. */
  static const char TAIL_FALSE[] = "],\"more\":false}";
  size_t start = json->length;
  size_t first = *at;
  link2_json_text(json, "{\"t\":\"runtime.apps\",\"set\":");
  link2_json_u64(json, set);
  link2_json_text(json, ",\"at\":");
  link2_json_u64(json, first);
  link2_json_text(json, ",\"apps\":[");
  size_t i = first;
  while (i < count) {
    size_t before = json->length;
    if (i > first) link2_json_text(json, ",");
    write_app_row(json, &rows[i]);
    if (json->failed || json->length - start + sizeof TAIL_FALSE - 1 > payload_limit) {
      if (i == first) return false;
      json->length = before;
      json->failed = false;
      break;
    }
    i += 1;
  }
  link2_json_text(json, i < count ? "],\"more\":true}" : TAIL_FALSE);
  *at = i;
  return !json->failed;
}

void link2_write_log(Link2Json *json, const char *level, const char *source, const char *text, size_t length, uint32_t frame, uint32_t dropped, uint32_t payload_limit) {
  size_t max = payload_limit - LINK2_LOG_OVERHEAD;
  if (max > LINK2_LOG_TEXT_BYTES) max = LINK2_LOG_TEXT_BYTES;
  link2_json_text(json, "{\"t\":\"log\",\"level\":");
  link2_json_cstring(json, level);
  link2_json_text(json, ",\"source\":");
  link2_json_cstring(json, source);
  link2_json_text(json, ",\"text\":");
  link2_json_string(json, text, link2_encoded_prefix(text, length, max));
  link2_json_text(json, ",\"frame\":");
  link2_json_u64(json, frame);
  if (dropped != 0) {
    link2_json_text(json, ",\"dropped\":");
    link2_json_u64(json, dropped);
  }
  link2_json_text(json, "}");
}

static bool name_char(char c, bool upper) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' || (upper && c >= 'A' && c <= 'Z');
}

bool link2_valid_native_name(const char *name, size_t length) {
  if (length < LINK2_NATIVE_NAME_MIN || length > LINK2_NATIVE_NAME_MAX || name[0] == '.') return false;
  if (memcmp(name + length - 5, ".3dsx", 5) != 0) return false;
  for (size_t i = 0; i < length; i += 1) {
    if (!name_char(name[i], true)) return false;
  }
  return true;
}

bool link2_valid_app_name(const char *name, size_t length) {
  if (length == 0 || length > LINK2_APP_NAME_BYTES) return false;
  for (size_t i = 0; i < length; i += 1) {
    if (!name_char(name[i], false)) return false;
  }
  return true;
}

uint32_t link2_crc32(uint32_t crc, const uint8_t *bytes, size_t length) {
  static const uint32_t NIBBLE[16] = {
    0x00000000u, 0x1db71064u, 0x3b6e20c8u, 0x26d930acu, 0x76dc4190u, 0x6b6b51f4u, 0x4db26158u, 0x5005713cu,
    0xedb88320u, 0xf00f9344u, 0xd6d6a3e8u, 0xcb61b38cu, 0x9b64c2b0u, 0x86d3d2d4u, 0xa00ae278u, 0xbdbdf21cu,
  };
  crc = ~crc;
  for (size_t i = 0; i < length; i += 1) {
    crc ^= bytes[i];
    crc = NIBBLE[crc & 15u] ^ (crc >> 4);
    crc = NIBBLE[crc & 15u] ^ (crc >> 4);
  }
  return ~crc;
}
