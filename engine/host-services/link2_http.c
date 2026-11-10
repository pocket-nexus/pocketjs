/*
 * The worker's HTTP stream (link_http.h) on Pocket Link 2: `net.http` of
 * link2.h in place of version 1's `net` messages. The worker provider calls
 * validate, start, peek, consume and close as before; the client's callbacks
 * fill the same bounded facts: one header block, a window of
 * LINK_HTTP_WINDOW response bytes in LINK_HTTP_CHUNK blocks, one terminal.
 *
 * A consumed block returns its bytes to the client (link2_http_consumed),
 * which grants them to Hub again, so the window the worker reads from is the
 * stream's whole credit and no byte waits anywhere else.
 */

#include "link_http.h"

#include <string.h>

#include "host_services.h"
#include "jscan.h"
#include "launcher.h"
#include "link2_guest.h"

#define HTTP_BLOCKS (LINK_HTTP_WINDOW / LINK_HTTP_CHUNK)

typedef struct {
  /* `id` is what the worker holds: a number of this file's own counter. `wire`
   * is the request's id on the link, 0 before it is known and after the
   * connection it belonged to is gone: the next connection's ids start again,
   * and a slot the worker has not finished reading must not take them. */
  uint32_t id, wire, head, count;
  uint64_t received, deadline, max_bytes;
  bool headers, terminal, started, taken;
  int32_t status;
  size_t header_length;
  uint8_t header[LINK_HTTP_CHUNK];
  size_t body_length;
  uint8_t body[LINK_HTTP_CHUNK];
  struct {
    size_t length;
    uint8_t bytes[LINK_HTTP_CHUNK];
  } chunks[HTTP_BLOCKS];
} Http;

static Link2 *bound;
static Http requests[LINK_HTTP_SLOTS];
/* The slot whose request is being sent: the client may ask for its body
 * before link2_http returns the id. */
static Http *starting;

static uint32_t next_handle;

/* The worker's handle. */
static Http *find(uint32_t id) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (requests[i].taken && requests[i].id == id && id)
      return &requests[i];
  return NULL;
}

/* The client's id of a request on the connection that is up. */
static Http *find_wire(uint32_t wire) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (requests[i].taken && requests[i].wire == wire && wire)
      return &requests[i];
  return starting != NULL && starting->wire == 0 ? starting : NULL;
}

static uint32_t new_handle(void) {
  for (;;) {
    next_handle = next_handle >= (uint32_t)INT32_MAX ? 1 : next_handle + 1;
    if (find(next_handle) == NULL)
      return next_handle;
  }
}

static void finish(Http *r, int32_t status) {
  if (r->terminal)
    return;
  r->terminal = true;
  r->status = status;
}

static void cancel(Http *r) {
  if (bound != NULL && r->wire != 0)
    link2_http_cancel(bound, r->wire);
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
  if (bound == NULL || !link_http_validate(descriptor, length))
    return -1;
  Http *r = NULL;
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (!requests[i].taken) {
      r = &requests[i];
      break;
    }
  if (!r)
    return -1;
  JsonSpan object = json_span((const char *)descriptor, length), value,
           headers = {0};
  char url[LINK_HTTP_CHUNK + 1], method[16] = "GET";
  if (!json_find(object, "url", &value) ||
      json_string_strict(value, url, sizeof url) < 1)
    return -1;
  if (json_find(object, "method", &value) &&
      json_string_strict(value, method, sizeof method) < 1)
    return -1;
  bool has_headers = json_find(object, "headers", &headers);
  memset(r, 0, sizeof *r);
  if (json_find(object, "body", &value)) {
    long decoded = json_string_strict(value, (char *)r->body, sizeof r->body);
    if (decoded < 0)
      return -1;
    r->body_length = (size_t)decoded;
  }
  uint64_t timeout = 30000, max_bytes = 256u * 1024u;
  if (json_find(object, "timeoutMs", &value) &&
      (!json_u64(value, &timeout) || !timeout || timeout > 120000))
    return -1;
  if (json_find(object, "maxBytes", &value) &&
      (!json_u64(value, &max_bytes) || max_bytes > 256u * 1024u))
    return -1;
  Link2HttpRequest request = {
      .app = launcher_current_app_id(),
      .url = url,
      .method = method,
      .headers = has_headers ? headers.start : NULL,
      .headers_length = has_headers ? headers.length : 0,
      .body_bytes = (uint32_t)r->body_length,
      .timeout_ms = (uint32_t)timeout,
      .max_bytes = (uint32_t)max_bytes,
  };
  starting = r;
  uint32_t id = link2_http(bound, &request);
  starting = NULL;
  if (id == 0) {
    memset(r, 0, sizeof *r);
    return -1;
  }
  r->wire = id;
  r->id = new_handle();
  r->taken = true;
  r->max_bytes = max_bytes;
  r->deadline = services_host_ms() + timeout + 5000;
  return (int32_t)r->id;
}

// ---------------------------------------------------------------------------
// the client's callbacks
// ---------------------------------------------------------------------------

static size_t on_body(void *context, uint32_t request, size_t offset,
                      uint8_t *into, size_t capacity) {
  (void)context;
  Http *r = find_wire(request);
  if (!r || offset >= r->body_length)
    return 0;
  size_t take = r->body_length - offset;
  if (take > capacity)
    take = capacity;
  memcpy(into, r->body + offset, take);
  return take;
}

static void on_head(void *context, uint32_t request, const char *json,
                    size_t length) {
  (void)context;
  Http *r = find_wire(request);
  if (!r || r->terminal)
    return;
  JsonSpan object = json_span(json, length), headers, url;
  uint64_t status = 0;
  if (r->started || !json_find_u64(object, "status", &status) ||
      status < 100 || status > 599 || !json_find(object, "url", &url) ||
      !json_find(object, "headers", &headers) || !json_is_object(headers)) {
    finish(r, POCKET_WORKER_FAILED);
    cancel(r);
    return;
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
    /* A header block over one worker event: the stream fails, as in version 1. */
    jbuf_free(&head);
    finish(r, POCKET_WORKER_FAILED);
    cancel(r);
    return;
  }
  memcpy(r->header, head.data, head.length);
  r->header_length = head.length;
  r->headers = true;
  r->started = true;
  jbuf_free(&head);
}

static void on_data(void *context, uint32_t request, const uint8_t *bytes,
                    size_t length) {
  (void)context;
  Http *r = find_wire(request);
  if (!r || r->terminal)
    return;
  if (!r->started || length > r->max_bytes - r->received) {
    finish(r, POCKET_WORKER_FAILED);
    cancel(r);
    return;
  }
  size_t at = 0;
  while (at < length) {
    size_t slot = (r->head + r->count) % HTTP_BLOCKS;
    if (r->count && r->chunks[(r->head + r->count - 1) % HTTP_BLOCKS].length <
                        LINK_HTTP_CHUNK) {
      slot = (r->head + r->count - 1) % HTTP_BLOCKS;
    } else {
      if (r->count == HTTP_BLOCKS) {
        /* More than the window the client granted. */
        finish(r, POCKET_WORKER_FAILED);
        cancel(r);
        return;
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
}

static void on_end(void *context, uint32_t request, const char *error) {
  (void)context;
  Http *r = find_wire(request);
  if (!r)
    return;
  finish(r, error == NULL && r->started ? POCKET_WORKER_OK
            : error == NULL             ? POCKET_WORKER_FAILED
                                        : POCKET_WORKER_UNKNOWN);
}

void link2_http_host(Link2Host *host) {
  host->http_body = on_body;
  host->http_head = on_head;
  host->http_data = on_data;
  host->http_end = on_end;
}

void link2_http_bind(Link2 *link) { bound = link; }

// ---------------------------------------------------------------------------
// the worker provider's calls
// ---------------------------------------------------------------------------

bool link_http_peek(uint32_t id, LinkHttpFact *fact) {
  Http *r = find(id);
  if (!r || !fact)
    return false;
  *fact = (LinkHttpFact){0};
  if (r->headers) {
    fact->kind = POCKET_WORKER_HEADERS;
    fact->bytes = r->header;
    fact->length = r->header_length;
    return true;
  }
  if (r->count) {
    uint64_t waiting = 0;
    for (uint32_t i = 0; i < r->count; ++i)
      waiting += r->chunks[(r->head + i) % HTTP_BLOCKS].length;
    fact->kind = POCKET_WORKER_DATA;
    fact->bytes = r->chunks[r->head].bytes;
    fact->length = r->chunks[r->head].length;
    fact->offset = r->received - waiting;
    return true;
  }
  if (r->terminal) {
    fact->kind = POCKET_WORKER_END;
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
    uint32_t bytes = (uint32_t)r->chunks[r->head].length;
    r->head = (r->head + 1) % HTTP_BLOCKS;
    --r->count;
    if (bound != NULL && !r->terminal && r->wire != 0)
      link2_http_consumed(bound, r->wire, bytes);
  } else if (r->terminal)
    memset(r, 0, sizeof *r);
}

void link_http_close(uint32_t id) {
  Http *r = find(id);
  if (!r)
    return;
  if (!r->terminal)
    cancel(r);
  memset(r, 0, sizeof *r);
}

void link_http_pump(void) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i) {
    Http *r = &requests[i];
    if (!r->taken || r->terminal)
      continue;
    if (services_host_ms() > r->deadline) {
      cancel(r);
      finish(r, POCKET_WORKER_UNKNOWN);
    }
  }
}

void link_http_disconnected(void) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (requests[i].taken) {
      finish(&requests[i], POCKET_WORKER_UNKNOWN);
      /* What the worker has not read yet stays for it; the wire id is the
       * next connection's to give out again. */
      requests[i].wire = 0;
    }
}

void link_http_reset(void) {
  for (size_t i = 0; i < LINK_HTTP_SLOTS; ++i)
    if (requests[i].taken)
      link_http_close(requests[i].id);
}

/* Version 1's transport hooks have no caller on Link 2: the client hands
 * net.head, the bytes and the end to the callbacks above. */
bool link_http_ctrl(const char *type, uint32_t id, const char *json,
                    size_t length) {
  (void)type;
  (void)id;
  (void)json;
  (void)length;
  return false;
}

bool link_http_data(uint32_t id, const uint8_t *bytes, size_t length) {
  (void)id;
  (void)bytes;
  (void)length;
  return false;
}
