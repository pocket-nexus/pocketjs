/*
 * tests/fixtures/link2-scenarios.c — deterministic scenarios against the
 * Pocket Link 2 C client on link2-sim.h's socket and clock, one per run:
 *
 *   link2-scenarios <number> [trace]
 *
 * Each scenario came from a finding of the independent review of the client
 * (2026-11-10) and prints what it saw; a line with "REPRODUCED" means the
 * client still has the defect. tests/pocket-link-2-scenarios.test.ts lists
 * the scenarios that must not reproduce.
 */
#include "link2-sim.h"

typedef struct {
  uint8_t type, flags;
  uint32_t id, length;
  char text[200];
} Cap;
#define CAPS 20000
static Cap caps[CAPS];
static int cap_n;
static bool auto_reply_cancel;

static void capture(uint8_t type, uint8_t flags, uint32_t id, const uint8_t *payload, uint32_t length) {
  if (cap_n < CAPS) {
    Cap *c = &caps[cap_n++];
    c->type = type;
    c->flags = flags;
    c->id = id;
    c->length = length;
    uint32_t skip = (flags & LINK2_FLAG_APP) != 0 && (type == 0x10 || type == 0x12) ? 4 : 0;
    uint32_t n = length - skip < sizeof c->text - 1 ? length - skip : sizeof c->text - 1;
    memcpy(c->text, payload + skip, n);
    c->text[n] = '\0';
  }
  if (type == LINK2_FRAME_CANCEL && auto_reply_cancel) hub_json(LINK2_FRAME_REPLY, LINK2_FLAG_ERROR, id, "{\"code\":\"cancelled\",\"message\":\"cancelled\"}");
}

/* The last captured frame of a type whose text holds `needle` (NULL for any), from index `from` on; -1 for none. */
static int find_cap(int from, uint8_t type, const char *needle) {
  for (int i = cap_n - 1; i >= from; i -= 1) {
    if (caps[i].type == type && (needle == NULL || strstr(caps[i].text, needle) != NULL)) return i;
  }
  return -1;
}
static int count_cap(int from, uint8_t type, uint32_t id, const char *needle) {
  int count = 0;
  for (int i = from; i < cap_n; i += 1) {
    if (caps[i].type == type && (id == 0xffffffffu || caps[i].id == id) && (needle == NULL || strstr(caps[i].text, needle) != NULL)) count += 1;
  }
  return count;
}

static void pump(int n, uint32_t dt) {
  for (int i = 0; i < n; i += 1) {
    vnow += dt;
    link2_pump(L);
  }
}

static void set_features(const char *first, ...) {
  static char ready[400];
  va_list args;
  va_start(args, first);
  sim_feature_count = 0;
  ready[0] = '\0';
  for (const char *f = first; f != NULL; f = va_arg(args, const char *)) {
    sim_features[sim_feature_count++] = f;
    snprintf(ready + strlen(ready), sizeof ready - strlen(ready), "%s\"%s\"", ready[0] ? "," : "", f);
  }
  va_end(args);
  ready_features = ready;
}

static void up(uint32_t offer, uint32_t channels) {
  on_device_frame = capture;
  L = sim_create(offer, channels);
  for (int i = 0; i < 600 && !linked_now; i += 1) pump(1, 16);
  if (!linked_now) {
    printf("the link did not come up\n");
    exit(5);
  }
  pump(3, 16);
}

/* Opens the applet's channel and returns its id on the wire. */
static uint32_t open_channel(int *handle) {
  *handle = link2_channel_open(L, "dev.example.map", "00000000000000cc");
  pump(3, 16);
  int at = find_cap(0, LINK2_FRAME_REQUEST, "channel.open");
  if (at < 0) {
    printf("no channel.open went out\n");
    exit(5);
  }
  uint32_t id = caps[at].id;
  hub_json(LINK2_FRAME_REPLY, 0, id, "{\"generation\":7}");
  info(id)->is_channel = true;
  info(id)->channel_open = true;
  hub_credit(id, 256);
  pump(3, 16);
  const char *reason = "";
  if (link2_channel_state(L, *handle, &reason) != LINK2_CHANNEL_OPEN) {
    printf("the channel did not open (%s)\n", reason);
    exit(5);
  }
  return id;
}

static size_t make_object(char *out, size_t capacity, const char *t, uint32_t size) {
  size_t n = (size_t)snprintf(out, capacity, "{\"t\":\"%s\",\"pad\":\"", t);
  while (n + 3 < capacity && n + 2 < size) out[n++] = 'a';
  out[n++] = '"';
  out[n++] = '}';
  out[n] = '\0';
  return n;
}

static char big[40000];
static uint8_t zeros[40000];

static const char *state_of(int handle) {
  const char *reason = "";
  static char out[80];
  int state = link2_channel_state(L, handle, &reason);
  snprintf(out, sizeof out, "%s%s%s", state == LINK2_CHANNEL_OPEN ? "open" : state == LINK2_CHANNEL_OPENING ? "opening" : "closed", reason[0] ? " " : "", reason);
  return out;
}

// --- S1: requests cancelled before the guest takes them stay in the inbox ---
static void s1(bool small) {
  int handle;
  set_features("channel", NULL);
  up(0, 1);
  uint32_t channel = open_channel(&handle);
  auto_reply_cancel = false;
  int pairs = 0;
  for (int k = 0; k < (small ? 3000 : 12); k += 1) {
    uint32_t id = hub_fresh_id();
    size_t n = small ? (size_t)snprintf(big, sizeof big, "{\"t\":\"a\"}") : make_object(big, sizeof big, "job.run", 8000);
    hub_app_request(id, channel, big, n, false);
    hub_frame(LINK2_FRAME_CANCEL, 0, id, NULL, 0);
    pump(2, 16);
    pairs += 1;
    if (link2_channel_state(L, handle, NULL) != LINK2_CHANNEL_OPEN) break;
  }
  int cancelled = count_cap(0, LINK2_FRAME_REPLY, 0xffffffffu, "cancelled");
  int close = find_cap(0, LINK2_FRAME_EVENT, "channel.close");
  printf("S1%s the guest takes nothing; Hub sends REQUEST APP (%s) then CANCEL, %d times: %d answered `cancelled`; channel is %s; device sent %s\n", small ? "b" : "a",
         small ? "9 bytes" : "8,000 bytes", pairs, cancelled, state_of(handle), close >= 0 ? caps[close].text : "no channel.close");
  printf("  => %s\n", close >= 0 ? "REPRODUCED: the channel closes with `overflow` though every event and request kept to its bound" : "not reproduced");
}

// --- S2: END of an empty response stream that arrives before the guest takes the head event ---
static void s2(bool poll_first) {
  int handle;
  uint32_t request = 0;
  Link2Message message;
  uint8_t buffer[256];
  set_features("channel", NULL);
  up(0, 1);
  uint32_t channel = open_channel(&handle);
  (void)channel;
  link2_channel_request(L, handle, "{\"t\":\"tile.get\"}", 16, false, &request);
  pump(2, 16);
  hub_json(LINK2_FRAME_EVENT, 0, request, "{\"t\":\"tile.head\",\"bytes\":0}");
  long last = 0;
  int replies = 0;
  uint32_t stream = 0;
  if (poll_first) {
    pump(1, 16);
    link2_channel_frame(L, handle);
    while (link2_channel_poll(L, handle, &message)) {
      if (message.stream != 0) stream = message.stream;
    }
    link2_stream_read(L, handle, stream, buffer, sizeof buffer);
  }
  hub_data(request, zeros, 0, true);
  hub_json(LINK2_FRAME_REPLY, 0, request, "{\"rev\":\"r42\"}");
  pump(1, 16);
  for (int frame = 0; frame < 2500; frame += 1) {
    link2_channel_frame(L, handle);
    while (link2_channel_poll(L, handle, &message)) {
      if (message.stream != 0) stream = message.stream;
      if (message.kind == LINK2_MESSAGE_REPLY) replies += 1;
    }
    if (stream != 0) {
      last = link2_stream_read(L, handle, stream, buffer, sizeof buffer);
      if (last != 0) break;
    }
    pump(1, 16);
  }
  printf("S2%s head event, empty DATA END, REPLY %s: reply handed over %d time(s); read on the response stream after 40 s: %s\n", poll_first ? "b" : "a",
         poll_first ? "(guest took the head first)" : "(all three arrive in one pump, before the guest's frame)", replies,
         last == LINK2_STREAM_END ? "STREAM_END" : last == 0 ? "still pending" : last == LINK2_MALFORMED ? "MALFORMED" : "other");
  if (!poll_first) printf("  => %s\n", last == 0 ? "REPRODUCED: the END was dropped; the read never completes and the stream keeps one of the channel's 4 places" : "not reproduced");
  printf("  inbound applet streams still held: %u; CREDIT frames the device sent for the dead stream: %d\n", (unsigned)count_in_streams(L, handle), count_cap(0, LINK2_FRAME_CREDIT, request, NULL));
}

// --- S3: a progress event without a string t is dropped without its units ---
static void s3(void) {
  int handle;
  uint32_t request = 0;
  Link2Message message;
  set_features("channel", NULL);
  up(0, 1);
  uint32_t channel = open_channel(&handle);
  link2_channel_request(L, handle, "{\"t\":\"tile.get\"}", 16, false, &request);
  pump(2, 16);
  int from = cap_n;
  for (int k = 0; k < 48; k += 1) hub_json(LINK2_FRAME_EVENT, 0, request, "{\"n\":1}");
  for (int frame = 0; frame < 20; frame += 1) {
    pump(1, 16);
    link2_channel_frame(L, handle);
    while (link2_channel_poll(L, handle, &message)) {
    }
  }
  uint32_t regranted = 0;
  for (int i = from; i < cap_n; i += 1) {
    if (caps[i].type == LINK2_FRAME_CREDIT && caps[i].id == channel) regranted += 1;
  }
  printf("S3 48 progress events without a string `t` on an applet request (each 1 unit to its sender): CREDIT frames on the channel afterwards: %u; the device still counts %u units outstanding for Hub\n", regranted,
         L->channels[handle].ev_outstanding);
  printf("  => %s\n", regranted == 0 ? "REPRODUCED: the events were dropped and no unit returned; a sender that counts them has 0 units for good" : "not reproduced");
}

// --- S4: an accepting REPLY that crosses the CANCEL of channel.open ---
static void s4(void) {
  set_features("channel", NULL);
  up(0, 1);
  int handle = link2_channel_open(L, "dev.example.map", "00000000000000cc");
  pump(3, 16);
  int at = find_cap(0, LINK2_FRAME_REQUEST, "channel.open");
  link2_channel_exit(L, handle);
  hub_json(LINK2_FRAME_REPLY, 0, caps[at].id, "{\"generation\":7}");
  pump(3, 16);
  const Link2Stats *stats = link2_stats(L);
  printf("S4 channel.open, link2_channel_exit, then the accepting REPLY: stats.channel_bytes = %u, channel_peak = %u\n", stats->channel_bytes, stats->channel_peak);
  printf("  => %s\n", stats->channel_bytes > 1000000000u ? "REPRODUCED: the counter went below 0 (34,816 subtracted that were never added)" : "not reproduced");
}

// --- S5: the outcome of a stalled applet request is lost when Hub's REPLY comes before the guest's poll ---
static void s5(void) {
  int handle;
  uint32_t request = 0;
  Link2Message message;
  set_features("channel", NULL);
  up(0, 1);
  open_channel(&handle);
  link2_channel_request(L, handle, "{\"t\":\"slow.job\"}", 16, false, &request);
  auto_reply_cancel = true; /* Hub answers the CANCEL at once (§5.4) */
  int from = cap_n;
  for (int s = 0; s < 45 * 4; s += 1) pump(1, 250); /* the guest is paused: no frame, no poll */
  int cancels = count_cap(from, LINK2_FRAME_CANCEL, request, NULL);
  int replies = 0;
  for (int frame = 0; frame < 200; frame += 1) {
    link2_channel_frame(L, handle);
    while (link2_channel_poll(L, handle, &message)) {
      if (message.kind == LINK2_MESSAGE_REPLY && message.id == request) replies += 1;
    }
    pump(1, 16);
  }
  printf("S5 an applet request gets no frame for 30 s while the guest is paused: CANCEL frames sent: %d; Hub answered `cancelled`; outcomes the guest got afterwards for the request: %d; the request is %s\n", cancels, replies,
         find_out(L, request) != NULL ? "still held" : "gone");
  printf("  => %s\n", replies == 0 ? "REPRODUCED: neither `timeout` nor Hub's reply reaches the guest; its call never settles" : "not reproduced");
}

// --- S6: one `members` buffer for the push reply and the screenshot head ---
static void s6(void) {
  set_features("runtime", NULL);
  commit_members = 1500;
  up(0, 1);
  hub_request(hub_fresh_id(), "{\"t\":\"runtime.logs\",\"on\":true}");
  uint32_t push = hub_fresh_id();
  hub_request(push, "{\"t\":\"runtime.push\",\"bytes\":10,\"hash\":\"00000000000000aa\"}");
  pump(4, 16);
  /* Hub stops reading; log lines fill the send buffer until 1,000 to 1,300 bytes are free outside the reserve. */
  accept_mode = 2;
  memset(big, 'l', 900);
  while (tx_room(L, false) > 2300) link2_log(L, "info", "guest", big, 900, 1);
  while (tx_room(L, false) > 1300) link2_log(L, "info", "guest", big, 40, 1);
  uint32_t room = tx_room(L, false);
  hub_data(push, zeros, 10, true);
  pump(2, 16);
  uint32_t shot = hub_fresh_id();
  hub_request(shot, "{\"t\":\"runtime.screenshot\"}");
  pump(2, 16);
  accept_mode = 0;
  pump(6, 16);
  int at = -1;
  for (int i = 0; i < cap_n; i += 1) {
    if (caps[i].type == LINK2_FRAME_REPLY && caps[i].id == push) at = i;
  }
  printf("S6 push committed while %u bytes of the send buffer are free, then runtime.screenshot is read: the push REPLY is %.120s...\n", room, at >= 0 ? caps[at].text : "(none)");
  printf("  => %s\n", at >= 0 && strstr(caps[at].text, "SHOTMEMBERS") != NULL ? "REPRODUCED: the push reply carries the screenshot head's members" : "not reproduced");
}

// --- S7: a host callback that logs while a frame is being built in the send buffer ---
static void log_inside(void) {
  static char line[600];
  memset(line, 'L', sizeof line);
  link2_log(L, "info", "host", line, 560, 1);
}
static void s7(bool nearly_full) {
  set_features("runtime", NULL);
  up(0, 1);
  hub_request(hub_fresh_id(), "{\"t\":\"runtime.logs\",\"on\":true}");
  pump(3, 16);
  if (nearly_full) {
    accept_mode = 2;
    memset(big, 'l', 900);
    while (tx_room(L, false) > 2000) link2_log(L, "info", "guest", big, 900, 1);
    while (tx_room(L, false) > 760) link2_log(L, "info", "guest", big, 20, 1);
    status_pad = 560;
  }
  printf("S7%s runtime_status calls link2_log (logs are on); %u bytes free in the send buffer before\n", nearly_full ? "b" : "a", tx_room(L, false));
  fflush(stdout);
  reenter_status = log_inside;
  hub_request(hub_fresh_id(), "{\"t\":\"runtime.status\"}");
  pump(1, 16);
  printf("  send buffer after: head=%u tail=%u capacity=%u%s\n", L->tx_head, L->tx_tail, L->tx_capacity, L->tx_tail > L->tx_capacity ? "  => REPRODUCED: the tail is past the buffer's end" : "");
  fflush(stdout);
  reenter_status = NULL;
  accept_mode = 0;
  if (nearly_full) {
    /* The next frame is written where the tail points. */
    link2_log(L, "info", "guest", big, 900, 1);
    link2_log(L, "info", "guest", big, 900, 1);
  }
  pump(3, 16);
  printf("  => not reproduced (the peer read a well-formed stream)\n");
}

// --- S8: a worker that retries from http_end while the tables are torn down ---
static int retries;
static void retry_http(void) {
  Link2HttpRequest request = {"dev.example.a", "http://example.test/x", "GET", NULL, 0, 0, 0, 0};
  if (retries++ < 3) link2_http(L, &request);
}
static void s8(void) {
  set_features("net.http", NULL);
  up(0, 1);
  Link2HttpRequest request = {"dev.example.a", "http://example.test/x", "GET", NULL, 0, 0, 0, 0};
  /* Two requests; the first is cancelled so its slot is free again below the second. */
  uint32_t a = link2_http(L, &request);
  uint32_t b = link2_http(L, &request);
  pump(2, 16);
  hub_json(LINK2_FRAME_REPLY, 0, a, "{}");
  pump(2, 16);
  reenter_http_end = retry_http;
  uint8_t close[4] = {1, 0, 0, 0};
  hub_frame(LINK2_FRAME_CLOSE, 0, 0, close, 4);
  pump(1, 16);
  reenter_http_end = NULL;
  int stale = 0;
  for (size_t i = 0; i < L->out_count; i += 1) stale += L->out[i].kind != OR_FREE;
  printf("S8 http_end(\"closed\") starts a new net.http (ids %u, %u open before): phase after the CLOSE is %s; requests left in the table: %d\n", a, b, PHASE_NAMES[L->phase], stale);
  printf("  => %s\n", stale > 0 ? "REPRODUCED: a request of the dead connection survives; its id will be issued again after the next ready" : "not reproduced");
}

// --- S9: a DevTools line longer than the ring ---
static void s9(void) {
  set_features("devtools", NULL);
  up(0, 1);
  int at = find_cap(0, LINK2_FRAME_REQUEST, "devtools.open");
  uint32_t id = caps[at].id;
  hub_json(LINK2_FRAME_REPLY, 0, id, "{}");
  pump(2, 16);
  memset(big, 'a', sizeof big);
  uint32_t sent = 0;
  for (int k = 0; k < 400 && sent < LINK2_DEVTOOLS_RING; k += 1) {
    uint32_t n = (uint32_t)info(id)->cr_from_dev;
    if (n > 16384) n = 16384;
    if (n > 0 && hub_data(id, (const uint8_t *)big, n, false)) sent += n;
    pump(1, 16);
    size_t length;
    while (link2_devtools_poll(L, &length) != NULL) {
    }
  }
  int from = cap_n;
  size_t length = 0;
  const char *line = NULL;
  for (int k = 0; k < 4000 && line == NULL; k += 1) {
    pump(1, 16);
    line = link2_devtools_poll(L, &length);
  }
  printf("S9 Hub sends %u bytes of one DevTools line without a newline: credit left for Hub: %llu; CREDIT frames in the next 64 s: %d; lines the shim got: %d; ring holds %u of %u\n", sent,
         (unsigned long long)info(id)->cr_from_dev, count_cap(from, LINK2_FRAME_CREDIT, id, NULL), line != NULL, L->dt_in_tail - L->dt_in_head, (unsigned)LINK2_DEVTOOLS_RING);
  printf("  => %s\n", info(id)->cr_from_dev == 0 && line == NULL ? "REPRODUCED: the ring is full of a line that cannot end; no credit returns, the stream is wedged until a guest switch or a reconnect" : "not reproduced");
}

// --- S10: a cancelled applet request whose REPLY never comes ---
static void s10(void) {
  int handle;
  uint32_t request = 0;
  Link2Message message;
  set_features("channel", NULL);
  up(0, 1);
  open_channel(&handle);
  link2_channel_request(L, handle, "{\"t\":\"slow.job\"}", 16, false, &request);
  pump(2, 16);
  link2_channel_cancel(L, handle, request);
  int replies = 0;
  for (int frame = 0; frame < 900; frame += 1) {
    pump(1, 16);
    link2_channel_frame(L, handle);
    while (link2_channel_poll(L, handle, &message)) {
      if (message.kind == LINK2_MESSAGE_REPLY && message.id == request) replies += 1;
    }
  }
  printf("S10 the guest cancels its request and Hub never replies: after 14 s the request is %s; outcomes handed to the guest: %d\n", find_out(L, request) != NULL ? "still held" : "freed", replies);
  printf("  => %s\n", replies == 0 && find_out(L, request) == NULL ? "REPRODUCED: the id is freed after the 10 s grace and nothing reports `cancelled` to the guest (§5.4)" : "not reproduced");
}

// --- S11: the linked Hub's index after a reload ---
static void s11(void) {
  char path[400], text[400], key[65], status[2048];
  Link2Json json;
  set_features("runtime", NULL);
  hex_encode(HUB_KEY, 32, key);
  snprintf(text, sizeof text, "key=%s\nname=Other\naddress=10.0.0.3\nport=8628\n", key);
  /* Decoys until one sorts ahead of the Hub in directory order. A directory lists its
   * entries by name, by a hash of the name seeded per file system, oldest first or
   * newest first: 64 names are tried, each written after the Hub's file and then
   * before it, so one comes first whatever the order is. */
  static char decoy_name[17];
  const char *decoy = NULL;
  char hub_path[400], hub_text[400];
  snprintf(hub_path, sizeof hub_path, "%s/companions/%s.txt", sim_dir, HUB_ID);
  snprintf(hub_text, sizeof hub_text, "key=%s\nname=Sim Hub\naddress=10.0.0.2\nport=8628\n", key);
  for (int hub_last = 0; hub_last < 2 && decoy == NULL; hub_last += 1) {
    for (unsigned k = 0; k < 64 && decoy == NULL; k += 1) {
      snprintf(decoy_name, sizeof decoy_name, "%016llx", (unsigned long long)(0x1000u + k) * 0x9e3779b97f4a7c15ULL);
      if (strcmp(decoy_name, HUB_ID) == 0) continue;
      snprintf(path, sizeof path, "%s/companions/%s.txt", sim_dir, decoy_name);
      if (hub_last) remove(hub_path);
      write_text(path, text);
      if (hub_last) write_text(hub_path, hub_text);
      Link2 *probe = sim_create(0, 1);
      if (probe->companions.count == 2 && strcmp(probe->companions.list[0].id, decoy_name) == 0) decoy = decoy_name;
      link2_destroy(probe);
      if (decoy == NULL) remove(path);
    }
  }
  if (decoy == NULL) {
    printf("S11 no decoy sorts ahead of the Hub in this directory's order: not run\n");
    return;
  }
  up(0, 1);
  link2_json_init(&json, status, sizeof status);
  link2_status_json(L, &json);
  status[json.length] = '\0';
  char before[120];
  snprintf(before, sizeof before, "%.60s", strstr(status, "\"hub\":"));
  bool removed = link2_forget(L, decoy);
  link2_json_init(&json, status, sizeof status);
  link2_status_json(L, &json);
  status[json.length] = '\0';
  printf("S11 linked to %s (index %u of 2); link2_forget(\"%s\") = %d; status before: %s | after: %.60s\n", HUB_ID, (unsigned)L->target, decoy, (int)removed, before, strstr(status, "\"hub\":"));
  printf("  => %s\n", strstr(strstr(status, "\"hub\":"), HUB_ID) == NULL || strstr(status, "\"hub\":{\"id\":\"\"") != NULL ? "REPRODUCED: the link is up and the status names another (or no) Hub: `target` is an index into a list that was reloaded" : "not reproduced");
}

// --- S12: ready.clock at the edge of 64 bits ---
static bool wild_clock(void) {
  hub_json(LINK2_FRAME_HANDSHAKE, 0, 0, "{\"t\":\"ready\",\"name\":\"x\",\"features\":[\"runtime\"],\"maxPayload\":16384,\"clock\":{\"utc\":18446744073709551615,\"local\":9223372036854775807}}");
  return true;
}
static void s12(void) {
  set_features("runtime", NULL);
  auth_hook = wild_clock;
  printf("S12 ready with clock.utc = 2^64 - 1 and clock.local = 2^63 - 1 (UBSan reports below when the subtraction overflows)\n");
  fflush(stdout);
  on_device_frame = capture;
  L = sim_create(0, 1);
  for (int i = 0; i < 600 && !linked_now && device_closes == 0; i += 1) pump(1, 16);
  if (linked_now) {
    int64_t utc;
    int32_t offset;
    link2_clock(L, &utc, &offset);
    printf("  linked; link2_clock gives utc=%lld offset=%d\n", (long long)utc, offset);
  } else {
    printf("  the device refused that ready: CLOSE frames %u (code %u)\n", (unsigned)device_closes, (unsigned)device_close_code);
  }
  printf("  => %s\n", linked_now ? "REPRODUCED: a clock past 2^53 ms is taken into the device's signed arithmetic" : "not reproduced");
}

// --- S13: replies of the applet's requests larger than LINK_APP_MSG ---
static void s13(void) {
  int handle;
  uint32_t ids8[8];
  set_features("channel", NULL);
  ready_payload = 32768;
  up(32768, 1);
  open_channel(&handle);
  for (int k = 0; k < 8; k += 1) link2_channel_request(L, handle, "{\"t\":\"tile.get\"}", 16, false, &ids8[k]);
  pump(2, 16);
  uint32_t before = link2_stats(L)->channel_bytes;
  for (int k = 0; k < 8; k += 1) {
    size_t n = make_object(big, sizeof big, "r", hub_limit);
    hub_frame(LINK2_FRAME_REPLY, 0, ids8[k], big, n);
    pump(2, 16);
  }
  uint32_t held = link2_stats(L)->channel_bytes - before;
  printf("S13 payload limit %u: 8 replies of %u bytes to the applet's 8 requests, guest not polling: the client holds %u bytes of replies (the page's bound: 8 x LINK_APP_MSG = %u)\n", hub_limit, hub_limit, held,
         8 * link2_app_message_limit(hub_limit));
  printf("  => %s\n", held > 8 * link2_app_message_limit(hub_limit) ? "REPRODUCED: a REPLY over LINK_APP_MSG is kept whole" : "not reproduced");
}

// --- S14: a screenshot head that fits no frame ---
static void s14(void) {
  set_features("runtime", NULL);
  ready_payload = 1024;
  shot_members = 1500;
  up(0, 1);
  uint32_t shot = hub_fresh_id();
  hub_request(shot, "{\"t\":\"runtime.screenshot\"}");
  hub_credit(shot, 65536);
  for (int s = 0; s < 25 * 4; s += 1) pump(1, 250);
  InRequest *request = find_in(L, shot);
  printf("S14 payload limit 1,024 and a head of %u bytes: after 25 s the request is %s, frames sent for it: %d, capture open: %d\n", (unsigned)L->members_length, request != NULL ? "still open in P_HEAD" : "gone",
         count_cap(0, LINK2_FRAME_EVENT, shot, NULL) + count_cap(0, LINK2_FRAME_REPLY, shot, NULL), shot_open);
  printf("  => %s\n", request != NULL && shot_open ? "REPRODUCED: nothing is ever sent; the capture stays open until Hub's own CANCEL" : "not reproduced");
}

// --- S15: a REQUEST waits behind this side's own DATA on a slow link ---
static void s15(uint32_t trickle) {
  set_features("runtime", NULL);
  up(0, 1);
  uint32_t shot = hub_fresh_id();
  hub_request(shot, "{\"t\":\"runtime.screenshot\"}");
  hub_credit(shot, 2 * 1024 * 1024);
  pump(3, 16);
  accept_mode = 1;
  accept_trickle = trickle;
  uint32_t status = hub_fresh_id();
  pump(30, 16);
  uint64_t asked = vnow;
  hub_request(status, "{\"t\":\"runtime.status\"}");
  uint64_t answered = 0;
  int pings = 0;
  for (int frame = 0; frame < 1200 && linked_now; frame += 1) {
    if (frame % 60 == 0) {
      uint8_t p[4] = {9, 9, 9, 9};
      hub_frame(LINK2_FRAME_PING, 0, 0, p, 4);
      pings += 1;
    }
    pump(1, 16);
    if (answered == 0 && count_cap(0, LINK2_FRAME_REPLY, status, NULL) > 0) answered = vnow;
  }
  printf("S15 Hub reads %u bytes a pump (%u KB/s at 60 Hz) during a screenshot and sends runtime.status with a PING a second (%d sent): ", trickle, trickle * 60 / 1000, pings);
  if (answered != 0) printf("answered after %llu ms; link %s\n", (unsigned long long)(answered - asked), linked_now ? "up" : "down");
  else printf("never answered; link %s (%s); read pauses %u; device CLOSE %s\n", linked_now ? "up" : "down", last_why, link2_stats(L)->read_pauses, device_sent_close ? link2_close_name(device_close_code) : "-");
  if (trickle < 640) printf("  => %s\n", answered == 0 && !linked_now ? "REPRODUCED: the held REQUEST never finds 640 free bytes because the stream refills the buffer each pump; nothing is read for 10 s and the device closes with `silence`" : "not reproduced");
}

// --- S16: the link drops between a screenshot's last chunk and its REPLY ---
static void s16(void) {
  set_features("runtime", NULL);
  shot_bytes = 40000;
  up(0, 1);
  uint32_t shot = hub_fresh_id();
  hub_request(shot, "{\"t\":\"runtime.screenshot\"}");
  hub_credit(shot, 262144);
  bool dropped_in_window = false;
  for (int frame = 0; frame < 200 && linked_now; frame += 1) {
    pump(1, 16);
    InRequest *request = find_in(L, shot);
    if (request != NULL && request->phase == P_REPLY && !dropped_in_window) {
      sock_fail = true;
      dropped_in_window = true;
    }
  }
  printf("S16 the carrier drops in the pump after the last pixel chunk was queued (request in P_REPLY): link %s; screenshot_end called: %s\n", linked_now ? "up" : "down", shot_open ? "no" : "yes");
  printf("  => %s\n", dropped_in_window && shot_open ? "REPRODUCED: the host's capture is never ended (teardown tests P_STREAMING, free_in tests `head`)" : "not reproduced");
  shot_open = 0;
}

// --- S18: an event that opens a stream and does not fit a frame ---
static void s18(void) {
  set_features("agent", NULL);
  ready_payload = 1024;
  up(0, 1);
  size_t n = make_object(big, sizeof big, "agent.audio", 2000);
  int from = cap_n;
  uint32_t id = link2_event_stream(L, big, n);
  pump(2, 16);
  printf("S18 link2_event_stream with a 2,000-byte object at a payload limit of 1,024: returned id %u; EVENT frames sent: %d; the stream is %s\n", id, count_cap(from, LINK2_FRAME_EVENT, 0xffffffffu, "agent.audio"),
         find_out_stream(L, id) != NULL ? "open" : "absent");
  printf("  => %s\n", id != 0 && count_cap(from, LINK2_FRAME_EVENT, 0xffffffffu, "agent.audio") == 0 ? "REPRODUCED: an id comes back for a stream whose opening event never went out" : "not reproduced");
}

// --- S20: devtools.open that Hub never answers ---
static void s20(void) {
  set_features("devtools", NULL);
  up(0, 1);
  for (int s = 0; s < 200 * 4; s += 1) pump(1, 250);
  printf("S20 Hub never answers devtools.open: devtools.open requests in 200 s: %d, CANCEL frames: %d, link %s, devtools id now %u\n", count_cap(0, LINK2_FRAME_REQUEST, 0xffffffffu, "devtools.open"),
         count_cap(0, LINK2_FRAME_CANCEL, 0xffffffffu, NULL), linked_now ? "up" : "down", L->devtools_id);
  printf("  => %s\n", count_cap(0, LINK2_FRAME_REQUEST, 0xffffffffu, "devtools.open") == 1 && L->devtools_id == 0 ? "REPRODUCED: after the stall and the grace the stream is never asked for again on this connection" : "not reproduced");
}

// --- S23: this side drops a group: the order of CANCEL and the features event ---
static void s23(void) {
  set_features("runtime", "install", "catalog", NULL);
  up(0, 1);
  uint32_t install = link2_install(L, "dev.example.a");
  pump(2, 16);
  int from = cap_n;
  static const char *const LIST[] = {"runtime"};
  for (int s = 0; s < 8; s += 1) pump(1, 250);
  link2_set_features(L, LIST, 1);
  pump(4, 16);
  int cancel = -1, features = -1;
  for (int i = from; i < cap_n; i += 1) {
    if (caps[i].type == LINK2_FRAME_CANCEL && caps[i].id == install && cancel < 0) cancel = i;
    if (caps[i].type == LINK2_FRAME_EVENT && strstr(caps[i].text, "\"features\"") != NULL && features < 0) features = i;
  }
  printf("S23 the device drops `install` with request %u open: frame order: features event at %d, CANCEL at %d\n", install, features - from, cancel - from);
  printf("  => %s\n", features >= 0 && cancel > features ? "REPRODUCED: the CANCEL is queued after the features event (§6.1 wants it before)" : "not reproduced");
}

// --- S24: a guest closes a stream while the send buffer is full ---
static void s24(void) {
  int handle;
  Link2Message message;
  uint8_t buffer[64];
  set_features("runtime", "channel", NULL);
  up(0, 1);
  uint32_t channel = open_channel(&handle);
  hub_request(hub_fresh_id(), "{\"t\":\"runtime.logs\",\"on\":true}");
  uint32_t stream = hub_fresh_id();
  hub_app_json(LINK2_FRAME_EVENT, 0, stream, channel, "{\"t\":\"tail\"}", 12);
  pump(2, 16);
  link2_channel_frame(L, handle);
  uint32_t got = 0;
  while (link2_channel_poll(L, handle, &message)) got = message.stream != 0 ? message.stream : got;
  link2_stream_read(L, handle, got, buffer, sizeof buffer);
  pump(2, 16);
  accept_mode = 2;
  memset(big, 'l', 900);
  for (int k = 0; k < 200; k += 1) link2_log(L, "info", "guest", big, 900, 1);
  for (int k = 0; k < 200; k += 1) link2_log(L, "info", "guest", big, 1, 1);
  for (int k = 0; k < 20; k += 1) link2_event(L, "{}", 2);
  int from = cap_n;
  uint32_t room = tx_room(L, false);
  link2_stream_close(L, handle, got, LINK2_STREAM_IN);
  accept_mode = 0;
  pump(10, 16);
  printf("S24 link2_stream_close on inbound stream %08x with %u bytes free in the send buffer: RESET frames for it afterwards: %d; the stream is %s on this side\n", got, room, count_cap(from, LINK2_FRAME_RESET, got, NULL),
         find_in_stream(L, got) != NULL ? "held" : "freed");
  printf("  => %s\n", count_cap(from, LINK2_FRAME_RESET, got, NULL) == 0 ? "REPRODUCED: the RESET was dropped; the sender keeps the stream until its own 30 s without credit" : "not reproduced");
}

// --- S25: device.txt that cannot be read ---
static void s25(void) {
  char path[400], before[17], text[64];
  set_features("runtime", NULL);
  up(0, 1);
  snprintf(before, sizeof before, "%s", link2_device_id(L));
  snprintf(path, sizeof path, "%s/device.txt", sim_dir);
  chmod(path, 0);
  link2_reload(L);
  chmod(path, 0644);
  long n = read_file(path, text, sizeof text);
  printf("S25 device.txt unreadable for one link2_reload (it exists, with id %s): the client's id is now %s; the file now holds %.16s; phase %s\n", before, link2_device_id(L), n > 0 ? text : "(nothing)", PHASE_NAMES[L->phase]);
  printf("  => %s\n", strcmp(before, link2_device_id(L)) != 0 ? "REPRODUCED: a read that fails is taken for a missing file; a new id replaces the paired one on the card, on a live link" : "not reproduced");
}

// --- S26: key files the reader does not take ---
static void s26(void) {
  char path[400], text[2000], key[65];
  hex_encode(HUB_KEY, 32, key);
  snprintf(path, sizeof path, "%s/companions/%s.txt", sim_dir, HUB_ID);
  /* 600 bytes of other lines ahead of the key. */
  size_t n = 0;
  for (int k = 0; k < 12; k += 1) n += (size_t)snprintf(text + n, sizeof text - n, "note=%044d\n", k);
  snprintf(text + n, sizeof text - n, "key=%s\naddress=10.0.0.2\nport=8628\n", key);
  write_text(path, text);
  set_features("runtime", NULL);
  L = sim_create(0, 1);
  printf("S26a a key file of %u bytes whose key= line starts at byte %u: pairings loaded: %u, error: \"%s\", phase %s\n", (unsigned)strlen(text), (unsigned)n, (unsigned)L->companions.count, L->error, PHASE_NAMES[L->phase]);
  printf("  => %s\n", L->companions.count == 0 ? "REPRODUCED: the file is cut at 511 bytes and the pairing is dropped without a word in the status" : "not reproduced");
  link2_destroy(L);
  /* CRLF, a BOM, upper-case hex. */
  snprintf(text, sizeof text, "\xef\xbb\xbfkey=%s\r\nname=PC\r\naddress=10.0.0.2\r\nport=8628\r\n", key);
  write_text(path, text);
  L = sim_create(0, 1);
  printf("S26b the same file with a UTF-8 byte-order mark ahead of key=: pairings loaded: %u\n", (unsigned)L->companions.count);
  link2_destroy(L);
  snprintf(text, sizeof text, "name=PC\r\nkey=%s\r\naddress=10.0.0.2\r\nport=8628", key);
  write_text(path, text);
  L = sim_create(0, 1);
  printf("S26c CRLF lines, no final newline: pairings loaded: %u, address %s, port %u\n", (unsigned)L->companions.count, L->companions.list[0].address, (unsigned)L->companions.list[0].port);
  link2_destroy(L);
  /* device.txt damaged. */
  snprintf(path, sizeof path, "%s/device.txt", sim_dir);
  write_text(path, "1111222233334444\r\n# my 3DS\r\n");
  L = sim_create(0, 1);
  long got = read_file(path, text, 64);
  printf("S26d device.txt with a second line: the client's id is %s; the file now holds %.16s (%ld bytes)\n", link2_device_id(L), text, got);
  printf("  status error: \"%s\", phase %s\n", L->error, PHASE_NAMES[L->phase]);
  printf("  => %s\n", got != 28 || L->error[0] == '\0' || L->phase != PHASE_IDLE ? "REPRODUCED: a device.txt that holds no id is replaced by a new id, or the status says nothing" : "not reproduced");
  link2_destroy(L);
  L = NULL;
}

// --- S27: bytes of a net.http the worker has cancelled ---
static void s27(void) {
  set_features("net.http", NULL);
  ready_payload = 16384;
  up(0, 1);
  Link2HttpRequest request = {"dev.example.a", "http://example.test/x", "GET", NULL, 0, 0, 0, 0};
  uint32_t id = link2_http(L, &request);
  pump(2, 16);
  hub_json(LINK2_FRAME_EVENT, 0, id, "{\"t\":\"net.head\",\"status\":200,\"url\":\"http://x/\",\"headers\":{},\"truncated\":false}");
  pump(1, 16);
  hub_data(id, zeros, 1000, false); /* in flight when the worker cancels */
  uint32_t before = ev_http_data;
  link2_http_cancel(L, id);
  pump(2, 16);
  printf("S27 link2_http_cancel(%u), then a DATA frame that was already on its way: http_data callbacks after the cancel: %u; CANCEL frames: %d\n", id, ev_http_data - before, count_cap(0, LINK2_FRAME_CANCEL, id, NULL));
  printf("  => %s\n", ev_http_data > before ? "REPRODUCED: the worker gets bytes for a request it has cancelled (on_data tests `cancelled`, which is set only once the CANCEL frame is queued)" : "not reproduced");
}

// --- S28: a features change still waiting for its second when the link drops ---
static void s28(void) {
  static const char *const SECOND[] = {"runtime"};
  static const char *const THIRD[] = {"runtime", "catalog"};
  set_features("runtime", "catalog", "install", NULL);
  up(0, 1);
  link2_set_features(L, SECOND, 1);
  pump(2, 16); /* this one goes out */
  link2_set_features(L, THIRD, 2);
  pump(2, 16); /* this one waits for the second to end */
  sock_fail = true;
  pump(1, 16);
  int from = cap_n;
  for (int i = 0; i < 1200 && !linked_now; i += 1) pump(1, 16);
  int hello = find_cap(from, LINK2_FRAME_HANDSHAKE, "hello");
  const char *features = hello >= 0 ? strstr(caps[hello].text, "\"features\"") : NULL;
  for (int s = 0; s < 12; s += 1) pump(1, 250);
  int events = count_cap(from, LINK2_FRAME_EVENT, 0, "\"t\":\"features\"");
  (void)features;
  char local[200] = "", wanted[200] = "";
  for (size_t i = 0; i < L->local.count; i += 1) snprintf(local + strlen(local), sizeof local - strlen(local), "%s%s", i ? "," : "", L->local.features[i]);
  for (size_t i = 0; i < L->wanted_features.count; i += 1) snprintf(wanted + strlen(wanted), sizeof wanted - strlen(wanted), "%s%s", i ? "," : "", L->wanted_features.features[i]);
  printf("S28 link2_set_features([runtime,catalog]) 32 ms before the link drops; linked again: %d; the list in force is [%s], the list the host asked for is [%s]; features events in the 3 s after ready: %d; link2_in_use(catalog) = %d\n",
         linked_now, local, wanted, events, (int)link2_in_use(L, "catalog"));
  printf("  => %s\n", strcmp(local, wanted) != 0 && events == 0 ? "REPRODUCED: the pending list is dropped; hello carried the list before it and no features event follows" : "not reproduced");
}

// --- S29: agent streams the host accepts when no stream slot is free ---
static void s29(void) {
  set_features("agent", NULL);
  up(0, 1);
  int resets_before = count_cap(0, LINK2_FRAME_RESET, 0xffffffffu, NULL);
  for (int k = 0; k < 30; k += 1) {
    hub_json(LINK2_FRAME_EVENT, 0, hub_fresh_id(), "{\"t\":\"agent.screen\",\"bytes\":1000}");
    pump(1, 16);
  }
  int held = 0;
  for (size_t i = 0; i < L->in_stream_count; i += 1) held += L->in_streams[i].kind == IS_SYSTEM;
  printf("S29 30 agent.screen events, each accepted by the host: the host holds %d streams, the client %d of %u slots; RESET refused sent: %d\n", sys_streams_open, held, (unsigned)L->in_stream_count,
         count_cap(0, LINK2_FRAME_RESET, 0xffffffffu, NULL) - resets_before);
  Link2HttpRequest request = {"dev.example.a", "http://example.test/x", "GET", NULL, 0, 0, 0, 0};
  printf("  => %s\n", sys_streams_open > held ? "REPRODUCED: stream_open said yes, no slot was free, and stream_end never tells the host" : "not reproduced");
  (void)request;
}

// --- S30: this side's CLOSE when the reserve holds a PING ---
static void s30(void) {
  set_features("runtime", NULL);
  up(0, 1);
  hub_request(hub_fresh_id(), "{\"t\":\"runtime.logs\",\"on\":true}");
  pump(3, 16);
  accept_mode = 2;
  hub_mute = true;
  memset(big, 'l', 900);
  for (int k = 0; k < 200; k += 1) link2_log(L, "info", "guest", big, 900, 1);
  for (int k = 0; k < 200; k += 1) link2_log(L, "info", "guest", big, 1, 1);
  for (int k = 0; k < 20; k += 1) link2_event(L, "{}", 2);
  for (int k = 0; k < 14; k += 1) {
    /* Hub keeps the link from going silent; the device's own PING lands in the reserve. */
    hub_json(LINK2_FRAME_EVENT, 0, 0, "{\"t\":\"agent.turn\"}");
    pump(1, 250);
  }
  uint32_t free_all = tx_room(L, true), free_other = tx_room(L, false);
  int from = cap_n;
  hub_json(LINK2_FRAME_REQUEST, 0, 5, "{\"t\":\"runtime.status\"}"); /* an id of the device's range: CLOSE protocol with a 44-byte reason */
  pump(1, 16);
  accept_mode = 0;
  hub_rx_fill = 0;
  pump(80, 16);
  printf("S30 send buffer full (%u bytes free in all, %u outside the reserve) when a frame breaks a rule: phase after is %s (%s); CLOSE frames the device queued: %d\n", free_all, free_other, PHASE_NAMES[L->phase], last_why,
         (int)device_closes);
  printf("  => %s\n", device_closes == 0 || device_close_code != LINK2_CLOSE_PROTOCOL ? "REPRODUCED: the CLOSE with its reason did not fit what the reserve had left and was dropped; the peer sees the socket close with no code" : "not reproduced");
}

// --- S31: the id counter at its end ---
static void s31(void) {
  int handle;
  uint32_t id = 0;
  set_features("channel", "catalog", NULL);
  up(0, 1);
  open_channel(&handle);
  L->next_id = LINK2_ID_DEVICE_MAX;
  int first = link2_channel_request(L, handle, "{\"t\":\"a\"}", 9, false, &id);
  uint32_t last = id;
  int second = link2_channel_request(L, handle, "{\"t\":\"a\"}", 9, false, &id);
  link2_catalog(L);
  int from = cap_n;
  for (int s = 0; s < 100; s += 1) pump(1, 250);
  printf("S31 next id 0x7fffffff: request -> %d (id %08x); the one after -> %d; 25 s later: link %s, CLOSE frames %d, catalog requests sent %d, catalog_done calls %u\n", first, last, second, linked_now ? "up" : "down",
         count_cap(from, LINK2_FRAME_CLOSE, 0xffffffffu, NULL), count_cap(from, LINK2_FRAME_REQUEST, 0xffffffffu, "catalog"), ev_catalog_done);
  /* The link closes with going_away and comes up again with ids from 1. */
  printf("  closes the device sent: %u (last code %u); linked again: %d; the next id is %08x\n", (unsigned)device_closes, (unsigned)device_close_code, (int)linked_now, (unsigned)L->next_id);
  printf("  => %s\n", device_closes == 0 || device_close_code != LINK2_CLOSE_GOING_AWAY || !linked_now || L->next_id > 1000 ? "REPRODUCED: with its ids used up the client stays linked and every new request reports `full` for good; §5.1 closes with going_away and reconnects" : "not reproduced");
}

// --- S32: a link directory whose parent does not exist ---
static void s32(void) {
  char first[17], second[17], path[400];
  snprintf(sim_dir, sizeof sim_dir, "/tmp/l2r-sim-missing-%d/pocketjs/link", (int)getpid());
  set_features("runtime", NULL);
  L = sim_create(0, 1);
  snprintf(first, sizeof first, "%s", link2_device_id(L));
  link2_reload(L);
  snprintf(second, sizeof second, "%s", link2_device_id(L));
  snprintf(path, sizeof path, "%s/device.txt", sim_dir);
  printf("S32 link directory %s (its parent does not exist): id after create %s, after link2_reload %s; device.txt exists: %s; error text: \"%s\"\n", sim_dir, first, second, access(path, F_OK) == 0 ? "yes" : "no", L->error);
  printf("  => %s\n", strcmp(first, second) != 0 ? "REPRODUCED: no file could be written, nothing says so, and the device id changes at every load" : "not reproduced");
}

// --- S33: the applet leaves while channel.open is in flight, the next applet starts ---
static void s33(void) {
  set_features("channel", NULL);
  up(0, 1);
  int first = link2_channel_open(L, "dev.example.map", "00000000000000cc");
  pump(3, 16);
  link2_channel_exit(L, first);
  int second = link2_channel_open(L, "dev.example.other", "00000000000000dd");
  int tries = 0, got = second;
  uint64_t begun = vnow;
  while (got < 0 && tries < 2000) {
    pump(1, 16);
    got = link2_channel_open(L, "dev.example.other", "00000000000000dd");
    tries += 1;
  }
  printf("S33 one channel slot; exit while channel.open is unanswered, then link2_channel_open for the next applet: %d at once; a handle after %llu ms\n", second, (unsigned long long)(vnow - begun));
  printf("  => %s\n", second < 0 ? "REPRODUCED: the slot stays taken until the CANCEL's reply or the 10 s grace; the caller gets -1 and no later notice" : "not reproduced");
}

// --- S34: no memory for a channel's queue ---
static void s34(void) {
  set_features("channel", NULL);
  up(0, 1);
  int handle = link2_channel_open(L, "dev.example.map", "00000000000000cc");
  int opens = 0, closes = 0;
  for (int frame = 0; frame < 625; frame += 1) {
    int from = cap_n;
    pump(1, 16);
    for (int i = from; i < cap_n; i += 1) {
      if (caps[i].type == LINK2_FRAME_REQUEST && strstr(caps[i].text, "channel.open") != NULL) {
        opens += 1;
        hub_json(LINK2_FRAME_REPLY, 0, caps[i].id, "{\"generation\":7}");
        fz_fail_rate = 1; /* the inbox cannot be allocated */
        pump(1, 1);
        fz_fail_rate = 0;
      }
      if (caps[i].type == LINK2_FRAME_EVENT && strstr(caps[i].text, "channel.close") != NULL) closes += 1;
    }
  }
  printf("S34 the channel's 34,816-byte queue cannot be allocated: in 10 s the device sent %d channel.open and %d channel.close; state %s\n", opens, closes, state_of(handle));
  printf("  => %s\n", opens >= 5 ? "REPRODUCED: it opens and closes the channel once a second (a daemon start and a new generation each time) for as long as memory is short" : "not reproduced");
}

// --- S35: link2_set_features between hello and ready ---
static bool hold_hello(void) { return true; }
static void s35(void) {
  static const char *const LIST[] = {"runtime"};
  set_features("runtime", "catalog", "install", NULL);
  hello_hook = hold_hello;
  on_device_frame = capture;
  L = sim_create(0, 1);
  for (int i = 0; i < 600 && hub_state < 2; i += 1) pump(1, 16);
  link2_set_features(L, LIST, 1);
  hub_send_challenge(true);
  for (int i = 0; i < 200 && !linked_now; i += 1) pump(1, 16);
  for (int s = 0; s < 12; s += 1) pump(1, 250);
  printf("S35 link2_set_features([runtime]) after hello [runtime,catalog,install] left and before ready: linked %d; features events sent: %d; the device's own list now has %u entries; link2_in_use(catalog) = %d\n", linked_now,
         count_cap(0, LINK2_FRAME_EVENT, 0, "\"t\":\"features\""), (unsigned)L->local.count, (int)link2_in_use(L, "catalog"));
  printf("  => %s\n", linked_now && L->local.count == 1 && count_cap(0, LINK2_FRAME_EVENT, 0, "\"t\":\"features\"") == 0 ? "REPRODUCED: Hub was told three groups, the device uses one, and no features event corrects it" : "not reproduced");
}

// --- S36: a grant of event units past what a u32 holds ---
static void s36(void) {
  int handle;
  set_features("channel", NULL);
  up(0, 1);
  uint32_t channel = open_channel(&handle);
  pump(3, 16);
  uint32_t before = L->channels[0].units;
  hub_credit(channel, 0xffffffffu);
  hub_credit(channel, 0xffffffffu);
  pump(3, 16);
  printf("S36 two CREDIT frames of 4,294,967,295 units on a channel that holds %u: link %s, units now %u, CLOSE frames the device sent %u (code %u)\n", (unsigned)before, linked_now ? "up" : "down",
         (unsigned)L->channels[0].units, (unsigned)device_closes, (unsigned)device_close_code);
  printf("  => %s\n", device_closes == 0 || device_close_code != LINK2_CLOSE_FLOW ? "REPRODUCED: the unit count wrapped and the link stayed" : "not reproduced");
}

// --- S37: frames of a type this version does not know, and the 10 s rule ---
static void s37(void) {
  set_features("runtime", NULL);
  up(0, 1);
  hub_mute = true;
  for (int k = 0; k < 60 && linked_now; k += 1) {
    hub_frame(0x7e, 0, 0, "", 0);
    pump(1, 250);
  }
  printf("S37 15 s in which Hub sends frames of an unknown type alone and answers no PING: link %s; CLOSE frames the device sent %u (code %u)\n", linked_now ? "up" : "down", (unsigned)device_closes,
         (unsigned)device_close_code);
  printf("  => %s\n", !linked_now || device_closes != 0 ? "REPRODUCED: a skipped frame does not count as a frame received, and the device closes with silence" : "not reproduced");
}

// --- S38: the beacon socket fails under the client ---
static void s38(void) {
  set_features("runtime", NULL);
  on_device_frame = capture;
  L = sim_create(0, 1);
  pump(10, 16);
  int opens = udp_opens;
  udp_fail_next = 1;
  for (int s = 0; s < 16; s += 1) pump(1, 250);
  printf("S38 udp_recv reports a failed socket once: sockets opened before %d, after %d; a socket is open now: %d\n", opens, udp_opens, (int)udp_open_now);
  printf("  => %s\n", udp_opens == opens || !udp_open_now ? "REPRODUCED: the failure reads as no datagram and the dead socket is kept" : "not reproduced");
}

// --- S39: an apps page that waits for room ---
static void s39(void) {
  set_features("runtime", "apps", NULL);
  up(0, 1);
  hub_request(hub_fresh_id(), "{\"t\":\"runtime.logs\",\"on\":true}");
  for (int s = 0; s < 8; s += 1) pump(1, 250);
  accept_mode = 2;
  memset(big, 'l', 900);
  for (int k = 0; k < 200; k += 1) link2_log(L, "info", "guest", big, 900, 1);
  for (int k = 0; k < 200; k += 1) link2_log(L, "info", "guest", big, 1, 1);
  uint32_t before = apps_calls;
  link2_apps_changed(L);
  for (int k = 0; k < 120; k += 1) {
    hub_json(LINK2_FRAME_EVENT, 0, 0, "{\"t\":\"agent.turn\"}");
    pump(1, 16);
  }
  uint32_t waiting = apps_calls - before;
  accept_mode = 0;
  hub_rx_fill = 0;
  pump(200, 16);
  printf("S39 an apps report is due with the send buffer full for 120 pumps: runtime_apps calls while it waited: %u; once room came back: %u\n", (unsigned)waiting, (unsigned)(apps_calls - before));
  printf("  => %s\n", waiting > 4 || apps_calls == before ? "REPRODUCED: the host lists its apps at every pump while the page waits for room" : "not reproduced");
}

// --- S40: the device drops `agent` with streams open in both directions ---
static void s40(void) {
  static const char *const LIST[] = {"runtime"};
  static const char OPEN[] = "{\"t\":\"agent.audio\"}";
  set_features("runtime", "agent", NULL);
  up(0, 1);
  uint32_t in_id = hub_fresh_id();
  hub_json(LINK2_FRAME_EVENT, 0, in_id, "{\"t\":\"agent.screen\",\"bytes\":1000}");
  pump(2, 16);
  uint32_t out_id = link2_event_stream(L, OPEN, sizeof OPEN - 1);
  for (int s = 0; s < 8; s += 1) pump(1, 250);
  int from = cap_n, reset_in = -1, reset_out = -1, features = -1;
  int held = sys_streams_open;
  link2_set_features(L, LIST, 1);
  pump(4, 16);
  for (int i = from; i < cap_n; i += 1) {
    if (caps[i].type == LINK2_FRAME_RESET && caps[i].id == in_id && reset_in < 0) reset_in = i;
    if (caps[i].type == LINK2_FRAME_RESET && caps[i].id == out_id && reset_out < 0) reset_out = i;
    if (caps[i].type == LINK2_FRAME_EVENT && strstr(caps[i].text, "\"features\"") != NULL && features < 0) features = i;
  }
  printf("S40 the device drops `agent` holding an inbound stream %u and an outbound stream %u (the host held %d): features event at %d, RESET of the inbound at %d, of the outbound at %d; the host holds %d now\n",
         (unsigned)in_id, (unsigned)out_id, held, features - from, reset_in - from, reset_out - from, sys_streams_open);
  printf("  => %s\n", out_id == 0 || held != 1 ? "the scenario did not set up" : features < 0 || reset_in < 0 || reset_out < 0 || reset_in > features || reset_out > features || sys_streams_open != 0
                          ? "REPRODUCED: the agent's streams of a dropped group get no RESET ahead of the features event"
                          : "not reproduced");
}

// --- S41: the device's own `overflow` close, and when it opens the channel again ---
static void s41(void) {
  int handle;
  uint32_t id = 0;
  set_features("channel", NULL);
  up(0, 1);
  uint32_t channel = open_channel(&handle);
  pump(3, 16);
  int from = cap_n;
  /* 60 events against the device's 48 units, and no guest that takes them. */
  for (int k = 0; k < 60; k += 1) hub_app_json(LINK2_FRAME_EVENT, 0, 0, channel, "{\"t\":\"tick\"}", 12);
  pump(4, 16);
  int closes = count_cap(from, LINK2_FRAME_EVENT, 0xffffffffu, "overflow");
  for (int s = 0; s < 20; s += 1) pump(1, 250);
  int opens_idle = count_cap(from, LINK2_FRAME_REQUEST, 0xffffffffu, "channel.open");
  link2_channel_request(L, handle, "{\"t\":\"a\"}", 9, false, &id);
  for (int s = 0; s < 8; s += 1) pump(1, 250);
  int opens_used = count_cap(from, LINK2_FRAME_REQUEST, 0xffffffffu, "channel.open") - opens_idle;
  printf("S41 60 events past the device's 48 units: channel.close overflow sent %d; channel.open sent in the next 5 s with the applet idle: %d; after the applet used the channel: %d\n", closes, opens_idle, opens_used);
  printf("  => %s\n", closes == 0 ? "the scenario did not set up" : opens_idle > 0 ? "REPRODUCED: after its own overflow close the device opens the channel again without the applet using it" : opens_used != 1 ? "REPRODUCED: the applet's use did not open the channel" : "not reproduced");
}

int main(int argc, char **argv) {
  int which = argc > 1 ? atoi(argv[1]) : 0;
  sim_trace = argc > 2;
  sim_files();
  hostility = 1; /* the scenarios send frames past the tracker's bookkeeping */
  switch (which) {
    case 1: s1(false); break;
    case 101: s1(true); break;
    case 2: s2(false); break;
    case 102: s2(true); break;
    case 3: s3(); break;
    case 4: s4(); break;
    case 5: s5(); break;
    case 6: s6(); break;
    case 7: s7(false); break;
    case 107: s7(true); break;
    case 8: s8(); break;
    case 9: s9(); break;
    case 10: s10(); break;
    case 11: s11(); break;
    case 12: s12(); break;
    case 13: s13(); break;
    case 14: s14(); break;
    case 15: s15(400); break;
    case 115: s15(700); break;
    case 16: s16(); break;
    case 18: s18(); break;
    case 20: s20(); break;
    case 23: s23(); break;
    case 24: s24(); break;
    case 25: s25(); break;
    case 26: s26(); break;
    case 27: s27(); break;
    case 28: s28(); break;
    case 29: s29(); break;
    case 30: s30(); break;
    case 32: s32(); break;
    case 33: s33(); break;
    case 34: s34(); break;
    case 35: s35(); break;
    case 31: s31(); break;
    case 36: s36(); break;
    case 37: s37(); break;
    case 38: s38(); break;
    case 39: s39(); break;
    case 40: s40(); break;
    case 41: s41(); break;
    default: printf("no such scenario\n"); return 2;
  }
  fflush(stdout);
  return 0;
}
