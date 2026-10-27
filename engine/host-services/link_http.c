#include "link_http.h"
#include "host_services.h"
#include "jscan.h"
#include "launcher.h"
#include "link.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

/* The header and terminal have storage independent from the data window. */
typedef struct {
  uint32_t id, head, count, credit;
  uint64_t received, deadline, max_bytes;
  bool headers, terminal, started;
  int32_t status;
  size_t header_length;
  uint8_t header[LINK_HTTP_CHUNK];
  struct {
    size_t length;
    uint8_t bytes[LINK_HTTP_CHUNK];
  } chunks[8];
} Http;
static Http requests[LINK_HTTP_SLOTS];
static Http *find(uint32_t id) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (requests[i].id == id && id)
      return &requests[i];
  return NULL;
}
static bool control(uint32_t id, const char *type, uint32_t bytes) {
  char message[96];
  int n = snprintf(message, sizeof message,
                   "{\"t\":\"%s\",\"id\":%" PRIu32 ",\"bytes\":%" PRIu32 "}",
                   type, id, bytes);
  return n > 0 && (size_t)n < sizeof message &&
         link_send_ctrl(message, (size_t)n);
}
static void finish(Http *r, int32_t status) {
  if (r->terminal)
    return;
  r->terminal = true;
  r->status = status;
}
bool link_http_validate(const uint8_t *descriptor, size_t length) {
  if (!descriptor || !length || length > LINK_HTTP_CHUNK)
    return false;
  JsonSpan object = json_span((const char *)descriptor, length), value;
  char text[LINK_HTTP_CHUNK + 1];
  uint64_t number;
  if (!json_is_object(object) || !json_find(object, "url", &value))
    return false;
  long size = json_string_strict(value, text, sizeof text);
  if (size < 1 || memchr(text, 0, (size_t)size) ||
      (strncmp(text, "https://", 8) && strncmp(text, "http://", 7)))
    return false;
  if (json_find(object, "method", &value)) {
    if (json_string_strict(value, text, sizeof text) < 1 ||
        (strcmp(text, "GET") && strcmp(text, "HEAD") && strcmp(text, "POST") &&
         strcmp(text, "PUT") && strcmp(text, "PATCH") &&
         strcmp(text, "DELETE") && strcmp(text, "OPTIONS")))
      return false;
  }
  if (json_find(object, "headers", &value) && !json_is_object(value))
    return false;
  if (json_find(object, "body", &value) &&
      json_string_strict(value, text, sizeof text) < 0)
    return false;
  if (json_find(object, "timeoutMs", &value) &&
      (!json_u64(value, &number) || !number || number > 120000))
    return false;
  if (json_find(object, "maxBytes", &value) &&
      (!json_u64(value, &number) || number > 262144))
    return false;
  return true;
}
int32_t link_http_start(const uint8_t *descriptor, size_t length) {
  if (!link_http_validate(descriptor, length) || !link_http_available())
    return -1;
  Http *r = NULL;
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (!requests[i].id) {
      r = &requests[i];
      break;
    }
  if (!r)
    return -1;
  JsonSpan object = json_span((const char *)descriptor, length), url, method,
           headers;
  if (!json_is_object(object) || !json_find(object, "url", &url) ||
      url.length < 2 || url.start[0] != '"')
    return -1;
  bool has_method = json_find(object, "method", &method),
       has_headers = json_find(object, "headers", &headers);
  char body[LINK_HTTP_CHUNK + 1] = "";
  JsonSpan body_span;
  long decoded_body = 0;
  if (json_find(object, "body", &body_span)) {
    decoded_body = json_string_strict(body_span, body, sizeof body);
    if (decoded_body < 0)
      return -1;
  }
  size_t body_length = (size_t)decoded_body;
  uint64_t timeout = 30000, max_bytes = 256u * 1024u;
  if (json_find(object, "timeoutMs", &body_span) &&
      (!json_find_u64(object, "timeoutMs", &timeout) || !timeout ||
       timeout > 120000))
    return -1;
  if (json_find(object, "maxBytes", &body_span) &&
      (!json_find_u64(object, "maxBytes", &max_bytes) ||
       max_bytes > 256u * 1024u))
    return -1;
  JsonBuffer out = {.limit = LINK_HTTP_CHUNK + 256};
  uint32_t id = link_new_stream();
  if (!id)
    return -1;
  jbuf_text(&out, "{\"t\":\"net\",\"stream\":true,\"credit\":8192,\"id\":");
  jbuf_u64(&out, id);
  jbuf_text(&out, ",\"app\":");
  jbuf_cstring(&out, launcher_current_app_id());
  jbuf_text(&out, ",\"url\":");
  jbuf_raw(&out, url.start, url.length);
  if (has_method) {
    jbuf_text(&out, ",\"method\":");
    jbuf_raw(&out, method.start, method.length);
  }
  if (has_headers) {
    jbuf_text(&out, ",\"headers\":");
    jbuf_raw(&out, headers.start, headers.length);
  }
  jbuf_text(&out, ",\"timeoutMs\":");
  jbuf_u64(&out, timeout);
  jbuf_text(&out, ",\"maxBytes\":");
  jbuf_u64(&out, max_bytes);
  jbuf_text(&out, ",\"bytes\":");
  jbuf_u64(&out, body_length);
  jbuf_text(&out, "}");
  const char *text = jbuf_cstr(&out);
  bool accepted = text && link_send_ctrl(text, out.length);
  jbuf_free(&out);
  if (!accepted)
    return -1;
  memset(r, 0, sizeof *r);
  r->id = id;
  r->max_bytes = max_bytes;
  r->deadline = services_host_ms() + timeout + 5000;
  if (body_length && !link_send_data(id, (const uint8_t *)body, body_length)) {
    control(id, "net.cancel", 0);
    finish(r, -3);
  }
  return (int32_t)id;
}
bool link_http_ctrl(const char *type, uint32_t id, const char *json,
                    size_t length) {
  Http *r = find(id);
  if (!r)
    return false;
  if (r->terminal)
    return true;
  JsonSpan object = json_span(json, length);
  if (!strcmp(type, "net.head")) {
    uint64_t status = 0;
    JsonSpan headers, url;
    if (r->started || !json_find_u64(object, "status", &status) ||
        status < 100 || status > 599 || !json_find(object, "url", &url) ||
        !json_find(object, "headers", &headers) || !json_is_object(headers)) {
      finish(r, -1);
      control(id, "net.cancel", 0);
      return true;
    }
    JsonBuffer head = {.limit = LINK_HTTP_CHUNK};
    jbuf_text(&head, "{\"status\":");
    jbuf_u64(&head, status);
    jbuf_text(&head, ",\"url\":");
    jbuf_raw(&head, url.start, url.length);
    jbuf_text(&head, ",\"headers\":");
    jbuf_raw(&head, headers.start, headers.length);
    jbuf_text(&head, "}");
    if (!jbuf_cstr(&head)) {
      jbuf_free(&head);
      finish(r, -1);
      control(id, "net.cancel", 0);
      return true;
    }
    memcpy(r->header, head.data, head.length);
    r->header_length = head.length;
    r->headers = true;
    r->started = true;
    jbuf_free(&head);
  } else if (!strcmp(type, "net.end")) {
    uint64_t bytes;
    finish(r, r->started && json_find_u64(object, "bytes", &bytes) &&
                      bytes == r->received
                  ? 0
                  : -1);
  } else if (!strcmp(type, "net.error")) {
    finish(r, -3);
  }
  return true;
}
bool link_http_data(uint32_t id, const uint8_t *bytes, size_t length) {
  Http *r = find(id);
  if (!r)
    return false;
  if (r->terminal)
    return true;
  if (!r->started || !length || length > LINK_HTTP_CHUNK ||
      length > r->max_bytes - r->received) {
    finish(r, -1);
    control(id, "net.cancel", 0);
    return true;
  }
  size_t at = 0;
  while (at < length) {
    size_t slot = (r->head + r->count) % 8;
    if (r->count &&
        r->chunks[(r->head + r->count - 1) % 8].length < LINK_HTTP_CHUNK) {
      slot = (r->head + r->count - 1) % 8;
    } else {
      if (r->count == 8) {
        finish(r, -1);
        control(id, "net.cancel", 0);
        return true;
      }
      r->chunks[slot].length = 0;
      ++r->count;
    }
    size_t room = LINK_HTTP_CHUNK - r->chunks[slot].length;
    size_t take = length - at < room ? length - at : room;
    memcpy(r->chunks[slot].bytes + r->chunks[slot].length, bytes + at, take);
    r->chunks[slot].length += take;
    r->received += take;
    at += take;
  }
  return true;
}
bool link_http_peek(uint32_t id, LinkHttpFact *fact) {
  Http *r = find(id);
  if (!r || !fact)
    return false;
  *fact = (LinkHttpFact){0};
  if (r->headers) {
    fact->kind = LINK_HTTP_HEADERS;
    fact->bytes = r->header;
    fact->length = r->header_length;
    return true;
  }
  if (r->count) {
    uint64_t waiting = 0;
    for (uint32_t i = 0; i < r->count; ++i)
      waiting += r->chunks[(r->head + i) % 8].length;
    fact->kind = LINK_HTTP_DATA;
    fact->bytes = r->chunks[r->head].bytes;
    fact->length = r->chunks[r->head].length;
    fact->offset = r->received - waiting;
    return true;
  }
  if (r->terminal) {
    fact->kind = LINK_HTTP_END;
    fact->status = r->status;
    fact->offset = r->received;
    return true;
  }
  return false;
}
void link_http_consume(uint32_t id) {
  Http *r = find(id);
  if (!r)
    return;
  if (r->headers)
    r->headers = false;
  else if (r->count) {
    r->credit += (uint32_t)r->chunks[r->head].length;
    r->head = (r->head + 1) % 8;
    --r->count;
  } else if (r->terminal)
    memset(r, 0, sizeof *r);
}
void link_http_close(uint32_t id) {
  Http *r = find(id);
  if (!r)
    return;
  if (!r->terminal)
    control(id, "net.cancel", 0);
  memset(r, 0, sizeof *r);
}
void link_http_pump(void) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i) {
    Http *r = &requests[i];
    if (!r->id || r->terminal)
      continue;
    if (services_host_ms() > r->deadline) {
      control(r->id, "net.cancel", 0);
      finish(r, -3);
    } else if (r->credit && control(r->id, "net.credit", r->credit))
      r->credit = 0;
  }
}
void link_http_disconnected(void) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (requests[i].id)
      finish(&requests[i], -3);
}
void link_http_reset(void) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    link_http_close(requests[i].id);
}
