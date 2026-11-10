/*
 * The Pocket Link 2 wire layer (engine/host-services/link2_proto.c) as a
 * line-driven probe for tests/pocket-link-2-c.test.ts: one command per line
 * on stdin, its fields separated by tabs, one result line on stdout. Text and
 * byte fields travel as hex ("-" for empty).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "link2_proto.h"
#include "sha256.h"

#define MAX_FIELDS 400
#define LINE_BYTES (4u * 1024u * 1024u)

static char *fields[MAX_FIELDS];
static size_t field_count;

static uint8_t *unhex(const char *text, size_t *length) {
  size_t n = strcmp(text, "-") == 0 ? 0 : strlen(text) / 2;
  uint8_t *out = malloc(n + 1);
  if (n > 0 && !hex_decode(text, n * 2, out, n)) {
    fprintf(stderr, "bad hex field\n");
    exit(3);
  }
  out[n] = 0;
  *length = n;
  return out;
}

static void put_hex(const uint8_t *bytes, size_t length) {
  static const char HEX[] = "0123456789abcdef";
  for (size_t i = 0; i < length; i += 1) {
    putchar(HEX[bytes[i] >> 4]);
    putchar(HEX[bytes[i] & 15]);
  }
}

static bool hold_bits[4];
static bool hold_channel_request(void *context, uint32_t id) { (void)context; (void)id; return hold_bits[0]; }
static bool hold_own_request(void *context, uint32_t id) { (void)context; (void)id; return hold_bits[1]; }
static bool hold_channel(void *context, uint32_t id) { (void)context; (void)id; return hold_bits[2]; }
static bool hold_in_use(void *context, uint32_t id) { (void)context; (void)id; return hold_bits[3]; }

static const char *range_name(int range) {
  return range == LINK2_RANGE_DEVICE ? "device" : range == LINK2_RANGE_HUB ? "hub" : "none";
}

static void command(void) {
  const char *name = fields[0];
  size_t n = 0;
  if (strcmp(name, "beacon") == 0) {
    uint8_t *bytes = unhex(fields[1], &n);
    Link2Beacon beacon;
    if (link2_parse_beacon(bytes, n, &beacon)) {
      printf("%u|%s|", (unsigned)beacon.port, beacon.companion);
      put_hex((const uint8_t *)beacon.name, strlen(beacon.name));
    } else {
      printf("refused");
    }
    free(bytes);
  } else if (strcmp(name, "preamble") == 0) {
    uint8_t out[LINK2_PREAMBLE_BYTES];
    link2_write_preamble(out);
    put_hex(out, sizeof out);
  } else if (strcmp(name, "accept") == 0) {
    uint8_t *bytes = unhex(fields[1], &n);
    printf("%u", n == LINK2_PREAMBLE_BYTES ? link2_accept_preamble(bytes) : 0u);
    free(bytes);
  } else if (strcmp(name, "frames") == 0) {
    /* frames <limit> <linked> <chunk> <hex>: fed `chunk` bytes at a time. */
    uint32_t limit = (uint32_t)strtoul(fields[1], NULL, 10);
    bool linked = fields[2][0] == '1';
    size_t chunk = strtoul(fields[3], NULL, 10);
    uint8_t *bytes = unhex(fields[4], &n);
    uint8_t *buffer = malloc(LINK2_PAYLOAD_CEILING);
    Link2Reader reader;
    link2_reader_init(&reader, buffer, LINK2_PAYLOAD_CEILING);
    if (linked && !link2_reader_ready(&reader, limit)) printf("badlimit ");
    size_t at = 0;
    const char *end = "ok";
    while (at < n) {
      size_t give = n - at < chunk ? n - at : chunk;
      size_t consumed = 0;
      Link2Frame frame;
      uint32_t close = 0;
      int state = link2_reader_push(&reader, bytes + at, give, &consumed, &frame, &close);
      at += consumed;
      if (state == LINK2_READ_FRAME) {
        printf("%u:%u:%u:", (unsigned)frame.type, (unsigned)frame.flags, (unsigned)frame.id);
        if (frame.length == 0) putchar('-');
        put_hex(frame.payload, frame.length);
        putchar(' ');
      } else if (state == LINK2_READ_ERROR) {
        end = link2_close_name(close);
        break;
      }
    }
    printf("%s", end);
    free(buffer);
    free(bytes);
  } else if (strcmp(name, "header") == 0) {
    uint8_t out[LINK2_HEADER_BYTES];
    link2_write_header(out, (uint8_t)strtoul(fields[1], NULL, 10), (uint8_t)strtoul(fields[2], NULL, 10), (uint32_t)strtoul(fields[3], NULL, 10), (uint32_t)strtoul(fields[4], NULL, 10));
    put_hex(out, sizeof out);
  } else if (strcmp(name, "check") == 0) {
    uint32_t code = link2_check_frame((uint8_t)strtoul(fields[1], NULL, 10), (uint8_t)strtoul(fields[2], NULL, 10), (uint32_t)strtoul(fields[3], NULL, 10), (uint32_t)strtoul(fields[4], NULL, 10));
    printf("%s", code == 0 ? "ok" : link2_close_name(code));
  } else if (strcmp(name, "ping") == 0) {
    uint8_t out[LINK2_PING_FRAME_BYTES];
    put_hex(out, link2_write_ping(out, (uint32_t)strtoul(fields[1], NULL, 10)));
  } else if (strcmp(name, "pong") == 0) {
    uint8_t out[LINK2_PING_FRAME_BYTES];
    uint8_t *payload = unhex(fields[1], &n);
    put_hex(out, link2_write_pong(out, payload));
    free(payload);
  } else if (strcmp(name, "close") == 0) {
    uint8_t out[LINK2_CLOSE_FRAME_MAX];
    uint8_t *reason = unhex(fields[2], &n);
    put_hex(out, link2_write_close(out, (uint32_t)strtoul(fields[1], NULL, 10), (const char *)reason));
    free(reason);
  } else if (strcmp(name, "closename") == 0) {
    printf("%s", link2_close_name((uint32_t)strtoul(fields[1], NULL, 10)));
  } else if (strcmp(name, "credit") == 0) {
    uint8_t out[LINK2_CREDIT_FRAME_BYTES];
    put_hex(out, link2_write_credit(out, (uint32_t)strtoul(fields[1], NULL, 10), (uint32_t)strtoul(fields[2], NULL, 10)));
  } else if (strcmp(name, "reset") == 0) {
    uint8_t out[LINK2_RESET_FRAME_BYTES];
    put_hex(out, link2_write_reset(out, (uint32_t)strtoul(fields[1], NULL, 10), (uint32_t)strtoul(fields[2], NULL, 10)));
  } else if (strcmp(name, "cancel") == 0) {
    uint8_t out[LINK2_HEADER_BYTES];
    put_hex(out, link2_write_cancel(out, (uint32_t)strtoul(fields[1], NULL, 10)));
  } else if (strcmp(name, "proof") == 0) {
    uint8_t *key = unhex(fields[1], &n);
    uint8_t digest[32];
    link2_proof(key, strcmp(fields[2], "companion") == 0 ? LINK2_LABEL_COMPANION : LINK2_LABEL_CONSOLE, fields[3], fields[4], fields[5], fields[6], digest);
    put_hex(digest, 32);
    free(key);
  } else if (strcmp(name, "hello") == 0) {
    /* hello device companion nonce name model target hostAbi maxPayload feature… */
    size_t a, b, c;
    uint8_t *who = unhex(fields[4], &a);
    uint8_t *model = unhex(fields[5], &b);
    uint8_t *target = unhex(fields[6], &c);
    const char *features[LINK2_MAX_FEATURES];
    size_t count = 0;
    for (size_t i = 9; i < field_count && count < LINK2_MAX_FEATURES; i += 1) features[count++] = fields[i];
    Link2Hello hello = {fields[1], fields[2], fields[3], (const char *)who, (const char *)model, (const char *)target,
                        (uint32_t)strtoul(fields[7], NULL, 10), features, count, (uint32_t)strtoul(fields[8], NULL, 10)};
    char text[LINK2_MAX_HANDSHAKE];
    Link2Json json;
    link2_json_init(&json, text, sizeof text);
    link2_write_hello(&json, &hello);
    if (json.failed) printf("failed");
    else put_hex((const uint8_t *)text, json.length);
    free(who);
    free(model);
    free(target);
  } else if (strcmp(name, "auth") == 0) {
    char text[128];
    Link2Json json;
    link2_json_init(&json, text, sizeof text);
    link2_write_auth(&json, fields[1]);
    put_hex((const uint8_t *)text, json.length);
  } else if (strcmp(name, "challenge") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    Link2Challenge challenge;
    if (link2_parse_challenge(json_span((const char *)text, n), &challenge)) {
      printf("%s|", challenge.nonce);
      put_hex(challenge.proof, 32);
    } else {
      printf("null");
    }
    free(text);
  } else if (strcmp(name, "ready") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    static Link2Ready ready;
    if (link2_parse_ready(json_span((const char *)text, n), &ready)) {
      put_hex((const uint8_t *)ready.name, strlen(ready.name));
      printf("|%u|%llu|%lld|", (unsigned)ready.max_payload, (unsigned long long)ready.clock_utc, (long long)ready.clock_local);
      for (size_t i = 0; i < ready.features.count; i += 1) printf("%s%s", i > 0 ? "," : "", ready.features.features[i]);
    } else {
      printf("close");
    }
    free(text);
  } else if (strcmp(name, "refused") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    char code[32];
    printf("%s", link2_parse_refused(json_span((const char *)text, n), code, sizeof code) ? code : "null");
    free(text);
  } else if (strcmp(name, "limit") == 0) {
    printf("%u", link2_payload_limit(strtoull(fields[1], NULL, 10), strtoull(fields[2], NULL, 10)));
  } else if (strcmp(name, "features") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    static Link2Features list;
    if (link2_parse_features(json_span((const char *)text, n), &list)) {
      printf("ok:%zu", list.count);
      for (size_t i = 0; i < list.count; i += 1) printf(":%s", list.features[i]);
    } else {
      printf("protocol");
    }
    free(text);
  } else if (strcmp(name, "range") == 0) {
    printf("%s", range_name(link2_id_range((uint32_t)strtoul(fields[1], NULL, 10))));
  } else if (strcmp(name, "event") == 0) {
    /* event id app t|- channelRequest ownRequest channel inUse */
    for (int i = 0; i < 4; i += 1) hold_bits[i] = fields[4 + i][0] == '1';
    Link2Holdings holds = {hold_channel_request, hold_own_request, hold_channel, hold_in_use, NULL};
    bool opens = false;
    int reading = link2_read_event((uint32_t)strtoul(fields[1], NULL, 10), fields[2][0] == '1', strcmp(fields[3], "-") == 0 ? NULL : fields[3], &holds, &opens);
    static const char *const NAMES[] = {"?", "app-progress", "app", "ignore", "system", "reset-refused", "close"};
    printf("%s%s", NAMES[reading], opens ? ":stream" : "");
  } else if (strcmp(name, "units") == 0) {
    printf("%u", link2_event_units((uint32_t)strtoul(fields[1], NULL, 10)));
  } else if (strcmp(name, "appmsg") == 0) {
    printf("%u", link2_app_message_limit((uint32_t)strtoul(fields[1], NULL, 10)));
  } else if (strcmp(name, "devicefile") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    char id[LINK2_ID_HEX + 1];
    printf("%s", link2_parse_device_file((const char *)text, n, id) ? id : "null");
    free(text);
  } else if (strcmp(name, "load") == 0) {
    /* load (name texthex)…: the entries of companions/ in directory order. */
    static Link2Companions set;
    memset(&set, 0, sizeof set);
    for (size_t i = 1; i + 1 < field_count; i += 2) {
      uint8_t *text = unhex(fields[i + 1], &n);
      link2_companions_add(&set, fields[i], (const char *)text, n);
      free(text);
    }
    for (size_t i = 1; i + 1 < field_count; i += 2) {
      size_t length = strlen(fields[i]);
      if (length != LINK2_ID_HEX + 5 || strcmp(fields[i] + LINK2_ID_HEX, ".last") != 0) continue;
      char id[LINK2_ID_HEX + 1];
      memcpy(id, fields[i], LINK2_ID_HEX);
      id[LINK2_ID_HEX] = '\0';
      uint8_t *text = unhex(fields[i + 1], &n);
      link2_companions_last(&set, id, (const char *)text, n);
      free(text);
    }
    printf("%s", set.overflow ? "overflow" : "ok");
    for (size_t i = 0; i < set.count; i += 1) {
      printf(" %s|", set.list[i].id);
      put_hex(set.list[i].key, LINK2_KEY_BYTES);
      putchar('|');
      put_hex((const uint8_t *)set.list[i].name, strlen(set.list[i].name));
      printf("|%s|%u", set.list[i].address, (unsigned)set.list[i].port);
    }
  } else if (strcmp(name, "formatlast") == 0) {
    uint8_t *who = unhex(fields[1], &n);
    char out[256];
    size_t length = link2_format_last_file(out, sizeof out, (const char *)who, fields[2], (uint16_t)strtoul(fields[3], NULL, 10));
    put_hex((const uint8_t *)out, length);
    free(who);
  } else if (strcmp(name, "keepalive") == 0) {
    /* keepalive until received…: ticks every 100 ms; prints silenceAt|pings. */
    uint64_t until = strtoull(fields[1], NULL, 10);
    Link2Keepalive alive;
    link2_keepalive_init(&alive, 0);
    long silence = -1;
    unsigned pings = 0;
    for (uint64_t ms = 100; ms <= until && silence < 0; ms += 100) {
      for (size_t i = 2; i < field_count; i += 1) {
        if (strtoull(fields[i], NULL, 10) == ms) link2_keepalive_received(&alive, ms);
      }
      int tick = link2_keepalive_tick(&alive, ms);
      if (tick == LINK2_ALIVE_SILENCE) silence = (long)ms;
      if (tick == LINK2_ALIVE_PING) pings += 1;
    }
    printf("%ld|%u", silence, pings);
  } else if (strcmp(name, "apps") == 0) {
    /* apps limit set (id output version hash home)…: each page's JSON as hex. */
    static Link2InstalledApp rows[LINK2_APPS_MAX_ROWS];
    uint32_t limit = (uint32_t)strtoul(fields[1], NULL, 10);
    uint32_t set = (uint32_t)strtoul(fields[2], NULL, 10);
    size_t count = 0;
    for (size_t i = 3; i + 4 < field_count && count < LINK2_APPS_MAX_ROWS; i += 5) {
      rows[count].id = fields[i];
      rows[count].output = fields[i + 1];
      rows[count].version = fields[i + 2];
      rows[count].hash = fields[i + 3];
      rows[count].home = fields[i + 4][0] == '1';
      count += 1;
    }
    char *text = malloc(LINK2_PAYLOAD_CEILING);
    size_t at = 0;
    do {
      Link2Json json;
      link2_json_init(&json, text, LINK2_PAYLOAD_CEILING);
      if (!link2_write_apps_page(&json, rows, count, &at, set, limit)) {
        printf("row-too-large");
        break;
      }
      put_hex((const uint8_t *)text, json.length);
      putchar(' ');
    } while (at < count);
    free(text);
  } else if (strcmp(name, "log") == 0) {
    /* log limit level source text frame dropped */
    uint8_t *text = unhex(fields[4], &n);
    char out[LINK2_LOG_TEXT_BYTES + 256];
    Link2Json json;
    link2_json_init(&json, out, sizeof out);
    link2_write_log(&json, fields[2], fields[3], (const char *)text, n, (uint32_t)strtoul(fields[5], NULL, 10), (uint32_t)strtoul(fields[6], NULL, 10), (uint32_t)strtoul(fields[1], NULL, 10));
    put_hex((const uint8_t *)out, json.length);
    free(text);
  } else if (strcmp(name, "nativename") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    printf("%d", link2_valid_native_name((const char *)text, n) ? 1 : 0);
    free(text);
  } else if (strcmp(name, "appname") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    printf("%d", link2_valid_app_name((const char *)text, n) ? 1 : 0);
    free(text);
  } else if (strcmp(name, "crc") == 0) {
    uint8_t *bytes = unhex(fields[1], &n);
    size_t half = n / 2;
    printf("%u", link2_crc32(link2_crc32(0, bytes, half), bytes + half, n - half));
    free(bytes);
  } else if (strcmp(name, "encoded") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    printf("%zu|%zu", link2_encoded_bytes((const char *)text, n), link2_encoded_prefix((const char *)text, n, strtoul(fields[2], NULL, 10)));
    free(text);
  } else if (strcmp(name, "string") == 0) {
    uint8_t *text = unhex(fields[1], &n);
    char *out = malloc(n * 6 + 2);
    Link2Json json;
    link2_json_init(&json, out, n * 6 + 2);
    link2_json_string(&json, (const char *)text, n);
    put_hex((const uint8_t *)out, json.length);
    free(out);
    free(text);
  } else if (strcmp(name, "grant") == 0) {
    /* grant bytes…: grants on a stream this side sends on, from 0. */
    uint32_t available = 0;
    const char *end = "ok";
    for (size_t i = 1; i < field_count; i += 1) {
      if (!link2_credit_grant(&available, (uint32_t)strtoul(fields[i], NULL, 10))) end = "flow";
    }
    printf("%s", end);
  } else if (strcmp(name, "received") == 0) {
    uint32_t outstanding = (uint32_t)strtoul(fields[1], NULL, 10);
    printf("%s", link2_credit_received(&outstanding, (uint32_t)strtoul(fields[2], NULL, 10)) ? "ok" : "flow");
  } else if (strcmp(name, "window") == 0) {
    /* window size op…: r<n> read, g grant, d<n> data, t<n> take; prints each g and t result and each d's verdict. */
    Link2AppWindow window = {(uint32_t)strtoul(fields[1], NULL, 10), 0, 0, 0};
    for (size_t i = 2; i < field_count; i += 1) {
      uint32_t value = (uint32_t)strtoul(fields[i] + 1, NULL, 10);
      switch (fields[i][0]) {
        case 'r': window.wanted = value; break;
        case 'g': printf("g%u ", link2_app_window_grant(&window)); break;
        case 'd':
          if (link2_credit_received(&window.outstanding, value)) window.held += value;
          else printf("flow ");
          break;
        case 't': printf("t%u ", link2_app_window_take(&window, value)); break;
        default: break;
      }
    }
    printf("o%u", window.outstanding + window.held);
  } else {
    printf("unknown-command");
  }
}

int main(void) {
  char *line = malloc(LINE_BYTES);
  while (fgets(line, (int)LINE_BYTES, stdin) != NULL) {
    size_t length = strlen(line);
    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = '\0';
    field_count = 0;
    char *at = line;
    while (field_count < MAX_FIELDS) {
      fields[field_count++] = at;
      char *tab = strchr(at, '\t');
      if (tab == NULL) break;
      *tab = '\0';
      at = tab + 1;
    }
    command();
    putchar('\n');
    fflush(stdout);
  }
  free(line);
  return 0;
}
