/*
 * Pocket Link 2 client — see link2.h; byte layouts, limits and the rules of
 * each message come from contracts/spec/link2.ts and docs/POCKET-LINK.md
 * (link2_proto.c holds the socket-free half).
 *
 * One state machine, pumped once per frame by the main thread:
 *
 *   IDLE        nothing paired: no sockets
 *   SEARCH      listen for beacons of paired Hubs; after
 *               LINK2_SEARCH_DIRECT_MS without one, try a paired Hub's last
 *               address, one pairing per attempt in turn
 *   CONNECTING  non-blocking TCP connect in flight
 *   HANDSHAKE   preamble and hello sent; challenge, auth and ready follow
 *   LINKED      requests, events, streams, channels
 *   CLOSING     this side sent CLOSE; the send buffer drains for at most 1 s
 *   BACKOFF     after a failure, 1 s doubling to 8 s; beacons are drained
 *               and not followed
 *
 * Every table is fixed when the client is created. A frame that needs an
 * answer is read only when the send buffer has room for that answer (§8.2):
 * the frame stays in the receive buffer and the socket is left alone until
 * the buffer has drained. Credit owed is a counter per stream or channel and
 * goes out as one CREDIT when there is room.
 */

#include "link2.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "jscan.h"
#include "sha256.h"

// ---------------------------------------------------------------------------
// sizes
// ---------------------------------------------------------------------------

/* One socket read; a 3DS returns about one segment (1.5 KiB) per call. */
#define RX_CHUNK 4096u
/* RESET frames that can wait for room in the send buffer. */
#define RESETS_DUE 16u
/* How often a linked client reads its beacon socket. */
#define LINK2_BEACON_DRAIN_MS 1000u
/* Room the send buffer must have, outside the reserve, before a frame is
 * read: for an error REPLY to a REQUEST or a CANCEL, and for a RESET. */
#define ANSWER_REQUEST 640u
#define ANSWER_OTHER 64u
/* The members a state-changing reply or a screenshot head carries. */
#define MEMBERS_BYTES 2048u
#define SHOT_MEMBERS_BYTES 384u
#define HELLO_LINE_BYTES 1024u
/* A channel's message queue: events under the event window (48 units of
 * 512 bytes), daemon requests waiting for the guest (8 KiB), and a 16-byte
 * header per entry. */
#define INBOX_BYTES (LINK2_APP_EVENT_WINDOW * LINK2_APP_EVENT_UNIT + LINK2_APP_WAITING_REQUESTS + 2048u)
#define ENTRY_HEADER 16u
/* One outbound stream's buffer: 4 of them are LINK2_APP_OUTBOUND. */
#define WRITER_BYTES (LINK2_APP_OUTBOUND / LINK2_CHANNEL_STREAMS)

enum { PHASE_IDLE, PHASE_SEARCH, PHASE_CONNECTING, PHASE_HANDSHAKE, PHASE_LINKED, PHASE_CLOSING, PHASE_BACKOFF };
static const char *const PHASE_NAMES[] = {"idle", "search", "connecting", "handshake", "linked", "closing", "backoff"};

enum { OR_FREE, OR_CATALOG, OR_INSTALL, OR_HTTP, OR_DEVTOOLS, OR_CHANNEL_OPEN, OR_APP };
enum { IR_FREE, IR_STATUS, IR_LOGS, IR_PUSH, IR_NATIVE, IR_LAUNCH, IR_REMOVE, IR_SCREENSHOT, IR_APP };
enum {
  P_ERROR,           /* an error REPLY from `failure` is due */
  P_EVENT_RECEIVING, /* the `receiving` event, then the host opens its file */
  P_RECEIVING,       /* the body streams in */
  P_EVENT_RECEIVED,
  P_COMMIT,          /* the host admits what arrived */
  P_ADMITTING,       /* a deferred admission: the host reports its outcome */
  P_EVENT_STAGED,
  P_CAPTURING,       /* a deferred capture: the host reports the frame */
  P_HEAD,            /* a screenshot's head event is due */
  P_STREAMING,       /* a screenshot's pixels stream out */
  P_REPLY,           /* the REPLY is due */
  P_RESTART,         /* the REPLY left: CLOSE `restart` is due */
  P_QUEUED,          /* an applet's request waits for the guest */
  P_HANDED,          /* the guest has it */
};
enum { IS_FREE, IS_PUSH, IS_NATIVE, IS_INSTALL, IS_HTTP, IS_DEVTOOLS, IS_SYSTEM, IS_APP };
enum { OS_FREE, OS_SCREENSHOT, OS_HTTP_BODY, OS_DEVTOOLS, OS_SYSTEM, OS_APP };

typedef struct {
  uint32_t id;
  uint8_t kind;
  int8_t channel;
  bool replied;    /* an id that outlives its REPLY got it */
  bool outlives;
  bool cancelled;  /* CANCEL was sent */
  bool cancel_due; /* CANCEL goes out when the send buffer has room */
  bool settled;    /* the host or the guest has the outcome */
  bool timeout;    /* cancelled by the 30 s stall */
  bool head;       /* applet request: the response stream was handed over or refused */
  bool queued;     /* applet request: its outcome waits in the channel's queue for the guest */
  bool orphan_close; /* channel.open whose applet left: `channel.close` exit is owed for the id */
  bool early_end;  /* applet request: the response's END came before the guest took the head event */
  bool early_reset; /* the same for a RESET */
  bool reply_error;
  uint64_t last_frame_ms;
  uint64_t cancelled_ms;
  uint32_t early_credit;
  char *reply; /* applet request: the REPLY's JSON, held for the guest */
  uint32_t reply_length;
} OutRequest;

typedef struct {
  uint32_t id;
  uint8_t kind;
  int8_t channel;
  uint8_t phase;
  bool body;
  bool head;
  bool launch;
  bool restart;
  bool ending; /* applet request: its response stream was told to end */
  bool staged; /* the host holds an open staging file for it */
  bool staged_event_due; /* a deferred admission reported `staged` */
  bool captured;         /* a screenshot's pixels exist at the host */
  uint32_t total;
  uint32_t received;
  uint32_t crc;
  uint32_t want_crc;
  uint32_t frame;
  uint32_t early_credit;
  uint64_t last_data_ms;
  char name[LINK2_NATIVE_NAME_MAX + 1];
  char hash[LINK2_ID_HEX + 1];
  char native_phase[16];
  char native_path[128];
  Link2Failure failure;
} InRequest;

typedef struct {
  uint32_t id;
  uint8_t kind;
  int8_t channel;
  bool started;   /* automatic streams: the first grant was made */
  bool ended;     /* END arrived */
  bool failed;    /* reset by the peer */
  bool reserved;  /* applet stream: counted, not yet read by the guest */
  bool abandon_due; /* applet stream: given back while the request's body still goes out; its RESET waits for the body's end */
  bool has_total;
  uint32_t window;
  uint32_t total;
  uint32_t received;
  uint32_t outstanding;   /* granted (sent or pending) and not yet received */
  uint32_t unconsumed;    /* received and still held by the consumer (net.http) */
  uint32_t pending_grant; /* credit owed: goes out as one CREDIT */
  uint32_t read_frame;    /* applet stream: the channel's frame count at the guest's last read */
  /* applet streams */
  Link2AppWindow app;
  uint8_t *buffer;
  uint32_t head;  /* offset of the first byte not yet copied to the guest */
  uint32_t ready; /* bytes this frame's hand-over gave the pending read */
} InStream;

typedef struct {
  uint32_t id;
  uint8_t kind;
  int8_t channel;
  bool ending;
  bool end_sent;
  bool failed;
  bool has_total;
  uint32_t credit;
  uint32_t total;
  uint32_t sent;
  uint64_t tx_mark;    /* the stream's last chunk has left once tx_sent reaches this */
  uint64_t wait_since; /* bytes wait for credit since then; 0 for not waiting */
  uint8_t *buffer;     /* applet streams */
  uint32_t fill;
} OutStream;

typedef struct {
  bool used;
  uint8_t state;
  bool wanted;
  bool first_grant_due;
  bool close_due;
  bool cancel_open; /* the open was cancelled: an accepting REPLY closes at once */
  bool exiting;     /* the applet left: the handle is free once its close has gone out */
  char close_reason[12];
  char blocked[LINK2_CODE_BYTES];
  char reason[LINK2_CODE_BYTES];
  char app[LINK2_APP_ID_BYTES + 1];
  char hash[LINK2_ID_HEX + 1];
  uint32_t id;
  uint32_t generation;
  uint64_t next_open_ms;
  uint32_t busy_wait_ms;
  uint32_t units;          /* units Hub granted this side and it has not spent */
  uint32_t ev_outstanding; /* units Hub may still spend, as this side counts them */
  uint32_t ev_owed;        /* units to regrant */
  uint8_t *inbox;
  uint32_t in_head;
  uint32_t in_tail;
  uint32_t waiting_requests;
  uint32_t frame_messages;
  uint32_t frame_json;
  uint32_t frames;
  char *handed_reply;
  /* Response streams that ended clean and gave their place back when the
   * REPLY was handed over before the guest read them: a read of one says
   * END once (the last LINK2_CHANNEL_STREAMS ids). */
  uint32_t ended_streams[LINK2_CHANNEL_STREAMS];
  uint32_t ended_next;
} Channel;

struct Link2 {
  Link2Platform platform;
  Link2Host host;
  Link2Stats stats;

  /* identity and pairings */
  char device[LINK2_ID_HEX + 1];
  Link2Companions companions;
  uint64_t held_until[LINK2_MAX_COMPANIONS];
  char error[64];
  bool stopped;

  /* the phase machine */
  int phase;
  uint64_t phase_since;
  uint64_t backoff_until;
  uint32_t backoff_ms;
  size_t direct_turn;
  int udp;
  int tcp;
  size_t target; /* index into companions of the Hub being dialed or linked */
  char target_address[16];
  uint16_t target_port;
  bool restart_after_close;
  uint64_t close_deadline;
  char close_why[LINK2_CODE_BYTES];

  /* the handshake */
  uint8_t preamble[LINK2_PREAMBLE_BYTES];
  uint32_t preamble_fill;
  bool preamble_done;
  bool proved;
  char nonce[2 * LINK2_NONCE_BYTES + 1];

  /* the connection */
  uint32_t offer;
  uint32_t limit;
  char hub_name[LINK2_NAME_BYTES * 2 + 1];
  Link2Features local;
  Link2Features remote;
  Link2Features wanted_features;
  bool features_due;
  uint64_t features_sent_ms;
  int64_t clock_skew_ms;
  int32_t clock_offset_min;
  bool clock_known;
  Link2Keepalive alive;
  uint32_t ping_counter;
  uint64_t ping_sent_ms;
  uint32_t next_id;

  /* receive */
  Link2Reader reader;
  uint8_t *rx_buffer;
  uint8_t rx_chunk[RX_CHUNK];
  uint32_t rx_chunk_at;
  uint32_t rx_chunk_fill;
  Link2Frame held_frame;
  bool frame_held;

  /* send */
  uint8_t *tx;
  uint32_t tx_capacity;
  /* A frame is being built in place after tx_tail, perhaps with a host
   * callback inside it: nothing else is queued until it ends. tx_epoch
   * changes when the buffer's content was replaced under an open frame (a
   * CLOSE, a lost connection), and the open frame is then not committed. */
  bool building;
  uint32_t tx_epoch;
  struct {
    uint32_t id;
    uint32_t code;
  } resets[RESETS_DUE]; /* RESET frames that wait for room */
  uint32_t resets_due;
  uint32_t skipped_seen; /* the reader's count of skipped frames at the last pump */
  uint64_t udp_retry_ms; /* the beacon socket is not opened again before this */
  bool ids_spent;
  uint64_t beacons_ms; /* the last drain of the beacon socket */
  uint32_t tx_head;
  uint32_t tx_tail;
  uint64_t tx_queued;
  uint64_t tx_sent;

  /* tables */
  OutRequest *out;
  size_t out_count;
  InRequest *in;
  size_t in_count;
  InStream *in_streams;
  size_t in_stream_count;
  OutStream *out_streams;
  size_t out_stream_count;
  Channel *channels;
  size_t channel_count;

  /* runtime */
  bool state_busy;
  bool shot_busy;
  bool logs_on;
  bool status_due;
  uint32_t logs_dropped;
  char members[MEMBERS_BYTES];
  size_t members_length;
  /* A screenshot's head has members of its own: a state-changing request's
   * reply may wait in `members` while a capture is made. */
  char shot_members[SHOT_MEMBERS_BYTES];
  size_t shot_members_length;
  char push_note[LINK2_MESSAGE_BYTES];
  bool apps_dirty;
  bool apps_sending;
  uint64_t apps_sent_ms;
  uint32_t apps_set;
  size_t apps_at;
  Link2InstalledApp apps[LINK2_APPS_MAX_ROWS];

  /* DevTools */
  bool devtools;        /* the buffers exist */
  bool devtools_due;    /* `devtools.open` goes out when the send buffer has room */
  uint32_t devtools_id; /* the stream's id while it is open or opening, else 0 */
  bool devtools_listening;
  uint8_t *dt_in;
  uint32_t dt_in_head;
  uint32_t dt_in_tail;
  bool dt_skip;
  uint8_t *dt_out;
  uint32_t dt_out_fill;
  char dt_hello[HELLO_LINE_BYTES];
  uint32_t dt_hello_length;

  /* catalog */
  bool catalog_running;
  bool catalog_again;
  bool catalog_send_due;
  bool catalog_first;
  bool catalog_has_after;
  char catalog_after[LINK2_APP_ID_BYTES + 1];
  uint32_t catalog_rev;
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

static uint64_t now_ms(const Link2 *link) {
  return link->platform.now_ms(link->platform.context);
}

static void dropped(Link2 *link, const char *why);
static void close_link(Link2 *link, uint32_t code, const char *reason, bool restart);

static void copy_text(char *out, size_t capacity, const char *text) {
  size_t length = strlen(text);
  if (length >= capacity) length = capacity - 1;
  memcpy(out, text, length);
  out[length] = '\0';
}

static void fail_with(Link2Failure *failure, const char *code, const char *message) {
  copy_text(failure->code, sizeof failure->code, code);
  copy_text(failure->message, sizeof failure->message, message);
}

static bool local_has(const Link2 *link, const char *feature) {
  return link2_features_has(&link->local, feature);
}

bool link2_in_use(const Link2 *link, const char *feature) {
  return link->phase == PHASE_LINKED && local_has(link, feature) && link2_features_has(&link->remote, feature);
}

bool link2_linked(const Link2 *link) {
  return link->phase == PHASE_LINKED;
}

uint32_t link2_limit(const Link2 *link) {
  return link->phase == PHASE_LINKED ? link->limit : 0;
}

const char *link2_device_id(const Link2 *link) {
  return link->device;
}

const Link2Stats *link2_stats(const Link2 *link) {
  return &link->stats;
}

static void channel_bytes(Link2 *link, long delta) {
  link->stats.channel_bytes = (uint32_t)((long)link->stats.channel_bytes + delta);
  if (link->stats.channel_bytes > link->stats.channel_peak) link->stats.channel_peak = link->stats.channel_bytes;
}

// ---------------------------------------------------------------------------
// the send buffer (§8.2)
// ---------------------------------------------------------------------------

static uint32_t tx_used(const Link2 *link) {
  return link->tx_tail - link->tx_head;
}

/* Room for a frame: PING, PONG and CLOSE may use the whole buffer, every
 * other frame leaves LINK2_TX_RESERVE bytes free. */
static uint32_t tx_room(const Link2 *link, bool control) {
  uint32_t room = link->tx_capacity - tx_used(link);
  if (control) return room;
  /* An open frame owns the bytes after the tail: a call made from inside
   * the host callback that fills it finds no room, as with a full buffer. */
  if (link->building) return 0;
  return room > LINK2_TX_RESERVE ? room - LINK2_TX_RESERVE : 0;
}

/* Where the next frame is built: the bytes after the queued ones, moved to
 * the buffer's start when the tail has too little room. */
static uint8_t *tx_at(Link2 *link, uint32_t need) {
  if (link->tx_capacity - link->tx_tail < need) {
    memmove(link->tx, link->tx + link->tx_head, tx_used(link));
    link->tx_tail = tx_used(link);
    link->tx_head = 0;
  }
  return link->tx + link->tx_tail;
}

static void tx_commit(Link2 *link, uint32_t length) {
  link->tx_tail += length;
  link->tx_queued += length;
  if (tx_used(link) > link->stats.tx_peak) link->stats.tx_peak = tx_used(link);
}

static bool tx_put(Link2 *link, const uint8_t *frame, uint32_t length, bool control) {
  if (tx_room(link, control) < length) return false;
  /* A PING, PONG or CLOSE queued under an open frame takes its place: the
   * open frame is abandoned (frame_end and the data pump test the epoch). */
  if (link->building) link->tx_epoch += 1;
  memcpy(tx_at(link, length), frame, length);
  tx_commit(link, length);
  return true;
}

static bool send_credit(Link2 *link, uint32_t id, uint32_t amount) {
  uint8_t frame[LINK2_CREDIT_FRAME_BYTES];
  return tx_put(link, frame, (uint32_t)link2_write_credit(frame, id, amount), false);
}

static bool send_reset_now(Link2 *link, uint32_t id, uint32_t code) {
  uint8_t frame[LINK2_RESET_FRAME_BYTES];
  return tx_put(link, frame, (uint32_t)link2_write_reset(frame, id, code), false);
}

/* A RESET that finds no room waits here and leaves at a later pump: the
 * peer would otherwise keep the stream until its own 30 s without credit. */
static void send_reset(Link2 *link, uint32_t id, uint32_t code) {
  if (link->resets_due == 0 && send_reset_now(link, id, code)) return;
  if (link->resets_due == RESETS_DUE) {
    /* More than the table holds: the oldest gives way. */
    memmove(link->resets, link->resets + 1, (RESETS_DUE - 1) * sizeof link->resets[0]);
    link->resets_due -= 1;
  }
  link->resets[link->resets_due].id = id;
  link->resets[link->resets_due].code = code;
  link->resets_due += 1;
}

static void flush_resets(Link2 *link) {
  while (link->resets_due > 0 && send_reset_now(link, link->resets[0].id, link->resets[0].code)) {
    link->resets_due -= 1;
    memmove(link->resets, link->resets + 1, link->resets_due * sizeof link->resets[0]);
  }
}

static bool send_cancel(Link2 *link, uint32_t id) {
  uint8_t frame[LINK2_HEADER_BYTES];
  return tx_put(link, frame, (uint32_t)link2_write_cancel(frame, id), false);
}

/* A JSON frame built in place in the send buffer. */
typedef struct {
  Link2Json json;
  uint8_t *base;
  uint32_t prefix;
  uint32_t channel;
  uint32_t epoch;
} FrameWriter;

/* False when the buffer has no room for a frame now. `app` puts the channel
 * id before the object and bounds it by LINK_APP_MSG. */
static bool frame_begin(Link2 *link, FrameWriter *writer, bool app, uint32_t channel) {
  uint32_t prefix = app ? LINK2_APP_CHANNEL_PREFIX : 0;
  uint32_t room = tx_room(link, false); /* 0 while another frame is open */
  if (room < LINK2_HEADER_BYTES + prefix + 2) return false;
  uint32_t capacity = room - LINK2_HEADER_BYTES - prefix;
  uint32_t most = app ? link2_app_message_limit(link->limit) : link->limit;
  if (capacity > most) capacity = most;
  writer->base = tx_at(link, room);
  writer->prefix = prefix;
  writer->channel = channel;
  writer->epoch = link->tx_epoch;
  link->building = true;
  link2_json_init(&writer->json, (char *)writer->base + LINK2_HEADER_BYTES + prefix, capacity);
  return true;
}

/* The open frame is given up: every path that leaves frame_begin's frame
 * without frame_end calls this. */
static void frame_drop(Link2 *link, FrameWriter *writer) {
  (void)writer;
  link->building = false;
}

/* False when the object did not fit the room there was; nothing is queued. */
static bool frame_end(Link2 *link, FrameWriter *writer, uint8_t type, uint8_t flags, uint32_t id) {
  link->building = false;
  /* The buffer changed under the frame (a callback inside it closed the
   * link, or the connection went): the frame is not queued. */
  if (writer->epoch != link->tx_epoch) return false;
  if (writer->json.failed) return false;
  uint32_t length = writer->prefix + (uint32_t)writer->json.length;
  if (writer->prefix != 0) {
    flags |= LINK2_FLAG_APP;
    writer->base[LINK2_HEADER_BYTES + 0] = (uint8_t)writer->channel;
    writer->base[LINK2_HEADER_BYTES + 1] = (uint8_t)(writer->channel >> 8);
    writer->base[LINK2_HEADER_BYTES + 2] = (uint8_t)(writer->channel >> 16);
    writer->base[LINK2_HEADER_BYTES + 3] = (uint8_t)(writer->channel >> 24);
  }
  link2_write_header(writer->base, type, flags, length, id);
  tx_commit(link, LINK2_HEADER_BYTES + length);
  return true;
}

/* One whole JSON object as a frame, or false when it has no room now. */
static bool send_json(Link2 *link, uint8_t type, uint8_t flags, uint32_t id, const char *json, size_t length, bool app, uint32_t channel) {
  FrameWriter writer;
  if (!frame_begin(link, &writer, app, channel)) return false;
  link2_json_raw(&writer.json, json, length);
  return frame_end(link, &writer, type, flags, id);
}

/* The object `{` members `}` (or `{"t":"<t>",` members `}`) as a frame. */
static bool send_members(Link2 *link, uint8_t type, uint32_t id, const char *t, const char *members, size_t length) {
  FrameWriter writer;
  if (!frame_begin(link, &writer, false, 0)) return false;
  link2_json_text(&writer.json, "{");
  if (t != NULL) {
    link2_json_text(&writer.json, "\"t\":");
    link2_json_cstring(&writer.json, t);
    if (length > 0) link2_json_text(&writer.json, ",");
  }
  link2_json_raw(&writer.json, members, length);
  link2_json_text(&writer.json, "}");
  return frame_end(link, &writer, type, 0, id);
}

/* `members`: further members of the error object (Link2Failure.members), or NULL. */
static bool reply_error_with(Link2 *link, uint32_t id, const char *code, const char *message, const char *members) {
  FrameWriter writer;
  if (!frame_begin(link, &writer, false, 0)) return false;
  if (code[0] == '\0') code = "internal";
  link2_json_text(&writer.json, "{\"code\":");
  link2_json_cstring(&writer.json, code);
  link2_json_text(&writer.json, ",\"message\":");
  link2_json_string(&writer.json, message, link2_encoded_prefix(message, strlen(message), LINK2_ERROR_MESSAGE_BYTES));
  if (members != NULL && members[0] != '\0') {
    link2_json_text(&writer.json, ",");
    link2_json_text(&writer.json, members);
  }
  link2_json_text(&writer.json, "}");
  return frame_end(link, &writer, LINK2_FRAME_REPLY, LINK2_FLAG_ERROR, id);
}

static bool reply_error(Link2 *link, uint32_t id, const char *code, const char *message) {
  return reply_error_with(link, id, code, message, NULL);
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

static OutRequest *find_out(Link2 *link, uint32_t id) {
  for (size_t i = 0; i < link->out_count; i += 1) {
    if (link->out[i].kind != OR_FREE && link->out[i].id == id) return &link->out[i];
  }
  return NULL;
}

static InRequest *find_in(Link2 *link, uint32_t id) {
  for (size_t i = 0; i < link->in_count; i += 1) {
    if (link->in[i].kind != IR_FREE && link->in[i].id == id) return &link->in[i];
  }
  return NULL;
}

static InStream *find_in_stream(Link2 *link, uint32_t id) {
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    if (link->in_streams[i].kind != IS_FREE && link->in_streams[i].id == id) return &link->in_streams[i];
  }
  return NULL;
}

static OutStream *find_out_stream(Link2 *link, uint32_t id) {
  for (size_t i = 0; i < link->out_stream_count; i += 1) {
    if (link->out_streams[i].kind != OS_FREE && link->out_streams[i].id == id) return &link->out_streams[i];
  }
  return NULL;
}

static Channel *open_channel_by_id(Link2 *link, uint32_t id) {
  for (size_t i = 0; i < link->channel_count; i += 1) {
    if (link->channels[i].used && link->channels[i].state == LINK2_CHANNEL_OPEN && link->channels[i].id == id) return &link->channels[i];
  }
  return NULL;
}

static bool id_in_use(Link2 *link, uint32_t id) {
  return find_out(link, id) != NULL || find_in(link, id) != NULL || find_in_stream(link, id) != NULL || find_out_stream(link, id) != NULL ||
         open_channel_by_id(link, id) != NULL;
}

static uint32_t take_id(Link2 *link) {
  if (link->next_id > LINK2_ID_DEVICE_MAX) {
    /* §5.1: the pump closes the link with going_away; ids start again on the next. */
    link->ids_spent = true;
    return 0;
  }
  return link->next_id++;
}

static OutRequest *new_out(Link2 *link, uint8_t kind, int channel, bool outlives) {
  for (size_t i = 0; i < link->out_count; i += 1) {
    OutRequest *request = &link->out[i];
    if (request->kind != OR_FREE) continue;
    uint32_t id = take_id(link);
    if (id == 0) return NULL;
    memset(request, 0, sizeof *request);
    request->id = id;
    request->kind = kind;
    request->channel = (int8_t)channel;
    request->outlives = outlives;
    request->last_frame_ms = now_ms(link);
    return request;
  }
  return NULL;
}

static void free_out(Link2 *link, OutRequest *request) {
  if (request->reply != NULL) {
    channel_bytes(link, -(long)request->reply_length);
    free(request->reply);
  }
  memset(request, 0, sizeof *request);
}

static InRequest *new_in(Link2 *link, uint32_t id, uint8_t kind, int channel) {
  for (size_t i = 0; i < link->in_count; i += 1) {
    InRequest *request = &link->in[i];
    if (request->kind != IR_FREE) continue;
    memset(request, 0, sizeof *request);
    request->id = id;
    request->kind = kind;
    request->channel = (int8_t)channel;
    request->last_data_ms = now_ms(link);
    return request;
  }
  return NULL;
}

static InStream *new_in_stream(Link2 *link, uint32_t id, uint8_t kind, int channel) {
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    InStream *stream = &link->in_streams[i];
    if (stream->kind != IS_FREE) continue;
    memset(stream, 0, sizeof *stream);
    stream->id = id;
    stream->kind = kind;
    stream->channel = (int8_t)channel;
    return stream;
  }
  return NULL;
}

static void free_in_stream(Link2 *link, InStream *stream) {
  if (stream->buffer != NULL) {
    channel_bytes(link, -(long)LINK2_APP_STREAM_WINDOW);
    free(stream->buffer);
  }
  memset(stream, 0, sizeof *stream);
}

static OutStream *new_out_stream(Link2 *link, uint32_t id, uint8_t kind, int channel) {
  for (size_t i = 0; i < link->out_stream_count; i += 1) {
    OutStream *stream = &link->out_streams[i];
    if (stream->kind != OS_FREE) continue;
    memset(stream, 0, sizeof *stream);
    stream->id = id;
    stream->kind = kind;
    stream->channel = (int8_t)channel;
    /* A grant may arrive in the same write as the request, ahead of the writer (§5.6). */
    OutRequest *out = find_out(link, id);
    InRequest *in = find_in(link, id);
    if (out != NULL) {
      stream->credit = out->early_credit;
      out->early_credit = 0;
    } else if (in != NULL) {
      stream->credit = in->early_credit;
      in->early_credit = 0;
    }
    return stream;
  }
  return NULL;
}

static void free_out_stream(Link2 *link, OutStream *stream) {
  if (stream->buffer != NULL) {
    channel_bytes(link, -(long)WRITER_BYTES);
    free(stream->buffer);
  }
  memset(stream, 0, sizeof *stream);
}

static size_t count_in_streams(const Link2 *link, int channel) {
  size_t count = 0;
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    if (link->in_streams[i].kind == IS_APP && link->in_streams[i].channel == channel) count += 1;
  }
  return count;
}

static size_t count_out_streams(const Link2 *link, int channel) {
  size_t count = 0;
  for (size_t i = 0; i < link->out_stream_count; i += 1) {
    if (link->out_streams[i].kind == OS_APP && link->out_streams[i].channel == channel) count += 1;
  }
  return count;
}

static int channel_index(const Link2 *link, const Channel *channel) {
  return (int)(channel - link->channels);
}

// ---------------------------------------------------------------------------
// the pairing files (§3.6)
// ---------------------------------------------------------------------------

/* The file's bytes, -1 when there is no such file, -2 when it is there and
 * could not be read whole (an error, or more bytes than `out` takes). */
#define READ_ABSENT (-1)
#define READ_FAILED (-2)
static long read_file(const char *path, char *out, size_t capacity) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return errno == ENOENT || errno == ENOTDIR ? READ_ABSENT : READ_FAILED;
  size_t length = fread(out, 1, capacity - 1, file);
  bool whole = !ferror(file) && (length < capacity - 1 || fgetc(file) == EOF);
  fclose(file);
  out[length] = '\0';
  return whole ? (long)length : READ_FAILED;
}

/* Every level of a directory path, as `mkdir -p`. */
static void make_directories(const char *path) {
  char partial[300];
  size_t length = strlen(path);
  if (length >= sizeof partial) return;
  for (size_t i = 1; i <= length; i += 1) {
    if (path[i] != '/' && path[i] != '\0') continue;
    /* A drive prefix such as "sdmc:" is not a directory. */
    if (i > 0 && path[i - 1] == ':') continue;
    memcpy(partial, path, i);
    partial[i] = '\0';
    mkdir(partial, 0755);
  }
}

static bool write_file(const char *path, const char *text, size_t length) {
  char temporary[320];
  snprintf(temporary, sizeof temporary, "%s.tmp", path);
  FILE *file = fopen(temporary, "wb");
  if (file == NULL) return false;
  bool ok = fwrite(text, 1, length, file) == length;
  ok = fclose(file) == 0 && ok;
  if (!ok) {
    remove(temporary);
    return false;
  }
  /* FAT's rename does not replace a file. */
  remove(path);
  return rename(temporary, path) == 0;
}

/* The device's id (§3.6). An id is minted only when the card has no
 * device.txt: a file that is there and cannot be read, or does not hold an
 * id, keeps the id this run already has (every pairing on the card names it)
 * and says so in the status. False when the status carries an error. */
static bool load_device_id(Link2 *link) {
  char path[300];
  char text[64];
  char id[LINK2_ID_HEX + 1];
  snprintf(path, sizeof path, "%s/device.txt", link->host.directory);
  long length = read_file(path, text, sizeof text);
  if (length >= 0 && link2_parse_device_file(text, (size_t)length, id)) {
    memcpy(link->device, id, sizeof id);
    return true;
  }
  if (length != READ_ABSENT) {
    copy_text(link->error, sizeof link->error, length == READ_FAILED ? "device.txt cannot be read" : "device.txt holds no device id");
    return false;
  }
  if (link->device[0] == '\0') {
    uint8_t bytes[LINK2_ID_HEX / 2];
    link->platform.random(link->platform.context, bytes, sizeof bytes);
    hex_encode(bytes, sizeof bytes, link->device);
  }
  make_directories(link->host.directory);
  snprintf(path, sizeof path, "%s/companions", link->host.directory);
  mkdir(path, 0755);
  snprintf(path, sizeof path, "%s/device.txt", link->host.directory);
  snprintf(text, sizeof text, "%s\n", link->device);
  if (!write_file(path, text, strlen(text))) {
    /* The id holds for this run; the next start mints another. */
    copy_text(link->error, sizeof link->error, "device.txt cannot be written");
    return false;
  }
  return true;
}

void link2_reload(Link2 *link) {
  char directory[300];
  char path[600];
  char text[1024];
  /* `target` is an index into the list this call replaces: the Hub it named
   * is looked up again by its id below. */
  char target_id[LINK2_ID_HEX + 1] = "";
  bool targeted = (link->phase == PHASE_CONNECTING || link->phase == PHASE_HANDSHAKE || link->phase == PHASE_LINKED || link->phase == PHASE_CLOSING) &&
                  link->target < link->companions.count;
  if (targeted) memcpy(target_id, link->companions.list[link->target].id, sizeof target_id);
  link->error[0] = '\0';
  bool id_ok = load_device_id(link);
  memset(&link->companions, 0, sizeof link->companions);
  memset(link->held_until, 0, sizeof link->held_until);
  snprintf(directory, sizeof directory, "%s/companions", link->host.directory);
  DIR *dir = opendir(directory);
  if (dir != NULL) {
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
      char id[LINK2_ID_HEX + 1];
      if (!link2_key_file_id(entry->d_name, id)) continue;
      snprintf(path, sizeof path, "%s/%s", directory, entry->d_name);
      long length = read_file(path, text, sizeof text);
      size_t before = link->companions.count;
      bool full = link->companions.overflow;
      if (length > 0) link2_companions_add(&link->companions, entry->d_name, text, (size_t)length);
      /* A key file that gives no pairing is named in the status, not passed over. */
      if (id_ok && link->error[0] == '\0' && link->companions.count == before && link->companions.overflow == full) {
        snprintf(link->error, sizeof link->error, "the pairing file %.16s.txt cannot be read", id);
      }
    }
    closedir(dir);
  }
  for (size_t i = 0; i < link->companions.count; i += 1) {
    snprintf(path, sizeof path, "%s/%s.last", directory, link->companions.list[i].id);
    long length = read_file(path, text, sizeof text);
    if (length > 0) link2_companions_last(&link->companions, link->companions.list[i].id, text, (size_t)length);
  }
  /* Without an id hello has nothing to carry: no pairing is tried. */
  if (link->device[0] == '\0') memset(&link->companions, 0, sizeof link->companions);
  if (link->companions.overflow && link->error[0] == '\0') copy_text(link->error, sizeof link->error, "more than 8 computers");
  if (targeted) {
    size_t found = link->companions.count;
    for (size_t i = 0; i < link->companions.count; i += 1) {
      if (strcmp(link->companions.list[i].id, target_id) == 0) found = i;
    }
    if (found < link->companions.count) {
      link->target = found;
    } else if (link->phase == PHASE_LINKED) {
      /* The pairing this link stands on left the card. */
      link->target = 0;
      close_link(link, LINK2_CLOSE_GOING_AWAY, "the pairing was removed", false);
    } else if (link->phase == PHASE_CONNECTING || link->phase == PHASE_HANDSHAKE) {
      link->target = 0;
      dropped(link, "the pairing was removed");
    }
  }
  if (link->phase == PHASE_IDLE && link->companions.count > 0 && !link->stopped) {
    link->phase = PHASE_SEARCH;
    link->phase_since = now_ms(link);
  }
}

/* What changed at a `ready` goes to the `.last` file; the key file is never
 * opened for writing. */
static void save_last(Link2 *link, Link2Companion *companion, const char *name, const char *address, uint16_t port) {
  char text[256];
  char path[600];
  char kept[LINK2_NAME_BYTES + 1];
  copy_text(kept, sizeof kept, name);
  if (strcmp(companion->name, kept) == 0 && strcmp(companion->address, address) == 0 && companion->port == port) return;
  size_t length = link2_format_last_file(text, sizeof text, kept, address, port);
  snprintf(path, sizeof path, "%s/companions/%s.last", link->host.directory, companion->id);
  if (length > 0) write_file(path, text, length);
  copy_text(companion->name, sizeof companion->name, kept);
  copy_text(companion->address, sizeof companion->address, address);
  companion->port = port;
}

// ---------------------------------------------------------------------------
// a channel's message queue
// ---------------------------------------------------------------------------

typedef struct {
  uint8_t kind;
  uint8_t flags;
  uint16_t cost;
  uint32_t id;
  uint32_t stream;
  uint32_t length;
  const char *json;
} Entry;

#define ENTRY_ERROR 1u
#define ENTRY_BODY 2u

static void put_u32(uint8_t *out, uint32_t value) {
  out[0] = (uint8_t)value;
  out[1] = (uint8_t)(value >> 8);
  out[2] = (uint8_t)(value >> 16);
  out[3] = (uint8_t)(value >> 24);
}

static bool inbox_push(Channel *channel, uint8_t kind, uint8_t flags, uint32_t cost, uint32_t id, uint32_t stream, const char *json, uint32_t length) {
  uint32_t need = ENTRY_HEADER + length;
  if (channel->inbox == NULL) return false;
  if (INBOX_BYTES - channel->in_tail < need) {
    uint32_t used = channel->in_tail - channel->in_head;
    if (INBOX_BYTES - used < need) return false;
    memmove(channel->inbox, channel->inbox + channel->in_head, used);
    channel->in_head = 0;
    channel->in_tail = used;
  }
  uint8_t *at = channel->inbox + channel->in_tail;
  at[0] = kind;
  at[1] = flags;
  at[2] = (uint8_t)cost;
  at[3] = (uint8_t)(cost >> 8);
  put_u32(at + 4, id);
  put_u32(at + 8, stream);
  put_u32(at + 12, length);
  if (length > 0) memcpy(at + ENTRY_HEADER, json, length);
  channel->in_tail += need;
  return true;
}

static bool inbox_peek(const Channel *channel, Entry *entry) {
  if (channel->inbox == NULL || channel->in_head == channel->in_tail) return false;
  const uint8_t *at = channel->inbox + channel->in_head;
  entry->kind = at[0];
  entry->flags = at[1];
  entry->cost = link2_read_u16(at + 2);
  entry->id = link2_read_u32(at + 4);
  entry->stream = link2_read_u32(at + 8);
  entry->length = link2_read_u32(at + 12);
  entry->json = (const char *)at + ENTRY_HEADER;
  return true;
}

static void inbox_pop(Channel *channel, const Entry *entry) {
  channel->in_head += ENTRY_HEADER + entry->length;
  if (channel->in_head == channel->in_tail) {
    channel->in_head = 0;
    channel->in_tail = 0;
  }
}

/* A queued request of the daemon is withdrawn by its CANCEL before the
 * guest saw it: its entry leaves the queue, so a paused guest's queue holds
 * no bytes of requests that no longer exist. */
static void inbox_withdraw(Channel *channel, uint32_t id) {
  uint32_t at = channel->in_head;
  while (channel->inbox != NULL && at < channel->in_tail) {
    uint8_t *entry = channel->inbox + at;
    uint32_t length = link2_read_u32(entry + 12);
    uint32_t size = ENTRY_HEADER + length;
    if (entry[0] == LINK2_MESSAGE_REQUEST && link2_read_u32(entry + 4) == id) {
      memmove(entry, entry + size, channel->in_tail - at - size);
      channel->in_tail -= size;
      if (channel->in_head == channel->in_tail) {
        channel->in_head = 0;
        channel->in_tail = 0;
      }
      channel->waiting_requests -= length;
      return;
    }
    at += size;
  }
}

// ---------------------------------------------------------------------------
// channels: open, close, end
// ---------------------------------------------------------------------------

/* The channel is over on this side: its requests, streams and queue go, and
 * no frame is sent for them (§7.5). */
static void channel_ended(Link2 *link, Channel *channel, const char *reason) {
  int index = channel_index(link, channel);
  for (size_t i = 0; i < link->out_count; i += 1) {
    if (link->out[i].kind != OR_FREE && link->out[i].channel == index) free_out(link, &link->out[i]);
  }
  for (size_t i = 0; i < link->in_count; i += 1) {
    if (link->in[i].kind != IR_FREE && link->in[i].channel == index) memset(&link->in[i], 0, sizeof link->in[i]);
  }
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    if (link->in_streams[i].kind != IS_FREE && link->in_streams[i].channel == index) free_in_stream(link, &link->in_streams[i]);
  }
  for (size_t i = 0; i < link->out_stream_count; i += 1) {
    if (link->out_streams[i].kind != OS_FREE && link->out_streams[i].channel == index) free_out_stream(link, &link->out_streams[i]);
  }
  if (channel->inbox != NULL) {
    channel_bytes(link, -(long)INBOX_BYTES);
    free(channel->inbox);
    channel->inbox = NULL;
  }
  free(channel->handed_reply);
  channel->handed_reply = NULL;
  channel->in_head = 0;
  channel->in_tail = 0;
  channel->waiting_requests = 0;
  memset(channel->ended_streams, 0, sizeof channel->ended_streams);
  channel->units = 0;
  channel->ev_outstanding = 0;
  channel->ev_owed = 0;
  channel->first_grant_due = false;
  channel->state = LINK2_CHANNEL_CLOSED;
  copy_text(channel->reason, sizeof channel->reason, reason);
}

/* This side closes an open channel: `channel.close` goes out (now, or when
 * the send buffer has room) and the channel ends at once in both directions. */
static void channel_close(Link2 *link, Channel *channel, const char *reason) {
  if (channel->state != LINK2_CHANNEL_OPEN) return;
  channel->close_due = true;
  copy_text(channel->close_reason, sizeof channel->close_reason, reason);
  channel_ended(link, channel, reason);
  /* After its own `overflow` the device opens the channel again when the
   * applet uses it, under the once-a-second rule (§7.5). */
  if (strcmp(reason, "overflow") == 0) {
    channel->wanted = false;
    channel->next_open_ms = now_ms(link) + LINK2_CHANNEL_REOPEN_MS;
  }
}

static void channel_flush_close(Link2 *link, Channel *channel) {
  FrameWriter writer;
  if (!channel->close_due || link->phase != PHASE_LINKED) return;
  if (!frame_begin(link, &writer, false, 0)) return;
  link2_json_text(&writer.json, "{\"t\":\"channel.close\",\"reason\":");
  link2_json_cstring(&writer.json, channel->close_reason);
  link2_json_text(&writer.json, "}");
  if (frame_end(link, &writer, LINK2_FRAME_EVENT, 0, channel->id)) channel->close_due = false;
}

/* The accepting REPLY of `channel.open`: the channel exists from this turn,
 * so the CREDIT Hub queues right behind the REPLY finds it (§7.1). */
static void channel_opened(Link2 *link, Channel *channel, uint32_t generation) {
  uint32_t waited = channel->busy_wait_ms;
  channel->inbox = malloc(INBOX_BYTES);
  if (channel->inbox != NULL) channel_bytes(link, (long)INBOX_BYTES);
  channel->state = LINK2_CHANNEL_OPEN;
  channel->generation = generation;
  channel->busy_wait_ms = 0;
  channel->reason[0] = '\0';
  channel->frame_messages = 0;
  channel->frame_json = 0;
  if (channel->inbox == NULL || channel->cancel_open) {
    /* No memory for its queue, or the open was cancelled and the REPLY crossed the CANCEL. */
    bool no_memory = channel->inbox == NULL;
    channel->cancel_open = false;
    channel_close(link, channel, "exit");
    if (no_memory) {
      /* Opened again as after `busy`, not once a second: each open starts a
       * daemon and takes a generation. */
      channel->busy_wait_ms = waited == 0 ? LINK2_CHANNEL_BUSY_RETRY_MIN_MS : waited * 2 > LINK2_CHANNEL_BUSY_RETRY_MAX_MS ? LINK2_CHANNEL_BUSY_RETRY_MAX_MS : waited * 2;
      channel->next_open_ms = now_ms(link) + channel->busy_wait_ms;
      copy_text(channel->reason, sizeof channel->reason, "memory");
    }
    return;
  }
  channel->ev_outstanding = LINK2_APP_EVENT_WINDOW;
  channel->first_grant_due = true;
}

/* An event of the channel arrived: its units leave the window. False when
 * the sender had none for it: the channel closes with `overflow`. */
static bool channel_event_cost(Link2 *link, Channel *channel, uint32_t json_bytes, uint32_t *cost) {
  *cost = link2_event_units(json_bytes);
  if (*cost > channel->ev_outstanding) {
    channel_close(link, channel, "overflow");
    return false;
  }
  channel->ev_outstanding -= *cost;
  return true;
}

/* Opens when the rules of §7.1 and §7.5 allow it. */
static void channel_pump(Link2 *link, Channel *channel) {
  FrameWriter writer;
  channel_flush_close(link, channel);
  if (channel->used && channel->exiting) {
    if (channel->state == LINK2_CHANNEL_CLOSED && (!channel->close_due || link->phase != PHASE_LINKED)) memset(channel, 0, sizeof *channel);
    return;
  }
  if (!channel->used || channel->state != LINK2_CHANNEL_CLOSED || !channel->wanted || channel->blocked[0] != '\0' || channel->close_due) return;
  if (!link2_in_use(link, "channel")) return;
  uint64_t now = now_ms(link);
  if (now < channel->next_open_ms) return;
  if (!frame_begin(link, &writer, false, 0)) return;
  OutRequest *request = new_out(link, OR_CHANNEL_OPEN, channel_index(link, channel), true);
  if (request == NULL) {
    frame_drop(link, &writer);
    return;
  }
  link2_json_text(&writer.json, "{\"t\":\"channel.open\",\"app\":");
  link2_json_cstring(&writer.json, channel->app);
  link2_json_text(&writer.json, ",\"hash\":");
  link2_json_cstring(&writer.json, channel->hash);
  link2_json_text(&writer.json, "}");
  if (!frame_end(link, &writer, LINK2_FRAME_REQUEST, 0, request->id)) {
    free_out(link, request);
    return;
  }
  channel->id = request->id;
  channel->state = LINK2_CHANNEL_OPENING;
  channel->cancel_open = false;
  channel->next_open_ms = now + LINK2_CHANNEL_REOPEN_MS;
}

// ---------------------------------------------------------------------------
// the link's life
// ---------------------------------------------------------------------------

static void enter(Link2 *link, int phase) {
  link->phase = phase;
  link->phase_since = now_ms(link);
}

/* Every open request, stream and channel ends as at a connection loss. */
static void teardown(Link2 *link) {
  for (size_t i = 0; i < link->channel_count; i += 1) {
    Channel *channel = &link->channels[i];
    if (!channel->used) continue;
    if (channel->state != LINK2_CHANNEL_CLOSED) channel_ended(link, channel, "connection");
    channel->close_due = false;
    if (channel->exiting) {
      memset(channel, 0, sizeof *channel);
      continue;
    }
    /* The next `ready` opens it again while the applet runs. */
    channel->wanted = true;
    channel->blocked[0] = '\0';
    channel->busy_wait_ms = 0;
    channel->next_open_ms = 0;
  }
  for (size_t i = 0; i < link->out_count; i += 1) {
    OutRequest *request = &link->out[i];
    if (request->kind == OR_FREE) continue;
    if (!request->settled) {
      if (request->kind == OR_INSTALL && link->host.install_end != NULL) link->host.install_end(link->host.context, request->id, "closed");
      if (request->kind == OR_HTTP && link->host.http_end != NULL) link->host.http_end(link->host.context, request->id, "closed");
    }
    free_out(link, request);
  }
  if (link->catalog_running && link->host.catalog_done != NULL) link->host.catalog_done(link->host.context, "closed");
  link->catalog_running = false;
  link->catalog_again = false;
  link->catalog_send_due = false;
  for (size_t i = 0; i < link->in_count; i += 1) {
    InRequest *request = &link->in[i];
    if (request->kind == IR_PUSH && request->staged && link->host.push_abort != NULL) link->host.push_abort(link->host.context);
    if (request->kind == IR_NATIVE && request->staged && link->host.native_abort != NULL) link->host.native_abort(link->host.context);
    if (request->kind == IR_SCREENSHOT && request->captured && link->host.screenshot_end != NULL) link->host.screenshot_end(link->host.context);
    memset(request, 0, sizeof *request);
  }
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    InStream *stream = &link->in_streams[i];
    if (stream->kind == IS_SYSTEM && link->host.stream_end != NULL) link->host.stream_end(link->host.context, stream->id, false);
    if (stream->kind != IS_FREE) free_in_stream(link, stream);
  }
  for (size_t i = 0; i < link->out_stream_count; i += 1) {
    if (link->out_streams[i].kind != OS_FREE) free_out_stream(link, &link->out_streams[i]);
  }
  link->state_busy = false;
  link->shot_busy = false;
  link->logs_on = false;
  link->status_due = false;
  link->apps_sending = false;
  link->devtools_id = 0;
  link->devtools_due = false;
  link->devtools_listening = false;
  link->dt_in_head = 0;
  link->dt_in_tail = 0;
  link->dt_skip = false;
  link->dt_out_fill = 0;
  /* A features change that waited for its second is not lost: the next hello carries the list. */
  link->local = link->wanted_features;
  link->features_due = false;
  link->resets_due = 0;
  link->ids_spent = false;
  link->frame_held = false;
  link->rx_chunk_at = 0;
  link->rx_chunk_fill = 0;
}

static void socket_gone(Link2 *link) {
  if (link->tcp >= 0) link->platform.tcp_close(link->platform.context, link->tcp);
  link->tcp = -1;
  /* A frame open in the buffer is gone with it. */
  link->tx_epoch += 1;
  link->building = false;
  /* What the buffer still held is gone with the socket: the count of bytes
   * sent catches up, so a later stream's one-chunk mark can be reached. */
  link->tx_head = 0;
  link->tx_tail = 0;
  link->tx_sent = link->tx_queued;
}

static void back_off(Link2 *link) {
  link->backoff_until = now_ms(link) + link->backoff_ms;
  link->backoff_ms = link->backoff_ms * 2 > LINK2_BACKOFF_MAX_MS ? LINK2_BACKOFF_MAX_MS : link->backoff_ms * 2;
  enter(link, PHASE_BACKOFF);
}

/* A connection attempt or a handshake failed. */
static void dropped(Link2 *link, const char *why) {
  socket_gone(link);
  /* A list set during the handshake goes into the next hello. */
  link->local = link->wanted_features;
  link->features_due = false;
  copy_text(link->close_why, sizeof link->close_why, why);
  if (link->host.linked != NULL) link->host.linked(link->host.context, NULL, why);
  back_off(link);
}

/* The link is down: by the peer's CLOSE, by the carrier, or after this
 * side's CLOSE has left. */
static void link_down(Link2 *link, const char *why, bool restart) {
  bool was_linked = link->phase == PHASE_LINKED;
  /* The phase leaves `linked` first: a host callback of the teardown that
   * calls back (a worker that retries its request at http_end, a host that
   * asks for the catalog at linked(NULL)) is refused as on a link that is
   * down, and leaves nothing in the tables this connection's ids named. */
  if (was_linked) {
    link->phase = PHASE_CLOSING;
    teardown(link);
  }
  socket_gone(link);
  copy_text(link->close_why, sizeof link->close_why, why);
  if (link->host.linked != NULL) link->host.linked(link->host.context, NULL, why);
  if (restart && link->host.restart != NULL) link->host.restart(link->host.context);
  if (link->stopped) {
    enter(link, PHASE_IDLE);
  } else if (restart) {
    enter(link, PHASE_SEARCH);
  } else {
    back_off(link);
  }
}

/* This side ends the link with CLOSE (§4.8): the frame is queued inside the
 * reserve, the tables end now, and the socket closes once the send buffer
 * has drained or after 1 s. */
static void close_link(Link2 *link, uint32_t code, const char *reason, bool restart) {
  uint8_t frame[LINK2_CLOSE_FRAME_MAX];
  if (link->phase != PHASE_LINKED && link->phase != PHASE_HANDSHAKE) return;
  bool was_linked = link->phase == PHASE_LINKED;
  /* As in link_down: not linked before the tables end. */
  link->phase = PHASE_CLOSING;
  if (was_linked) teardown(link);
  /* With its reason the CLOSE may not fit what the reserve has left beside
   * a PING: the code alone does. */
  if (!tx_put(link, frame, (uint32_t)link2_write_close(frame, code, reason), true)) tx_put(link, frame, (uint32_t)link2_write_close(frame, code, NULL), true);
  copy_text(link->close_why, sizeof link->close_why, link2_close_name(code));
  link->restart_after_close = restart;
  link->close_deadline = now_ms(link) + LINK2_CLOSE_DRAIN_MS;
  link->phase = PHASE_CLOSING;
}

// ---------------------------------------------------------------------------
// credit this side grants
// ---------------------------------------------------------------------------

/* An automatic stream's next grant: the window less what is granted and not
 * yet received and what the consumer still holds, one grant per half window. */
static void auto_grant(InStream *stream) {
  if (!stream->started || stream->ended || stream->failed) return;
  uint32_t busy = stream->outstanding + stream->unconsumed;
  if (busy >= stream->window) return;
  uint32_t room = stream->window - busy;
  bool last = false;
  if (stream->has_total) {
    uint32_t arrived = stream->received + stream->outstanding;
    uint32_t left = stream->total > arrived ? stream->total - arrived : 0;
    if (room >= left) {
      room = left;
      last = true;
    }
  }
  if (room == 0) return;
  if (stream->outstanding > 0 && room < stream->window / 2 && !last) return;
  stream->outstanding += room;
  stream->pending_grant += room;
}

/* Credit owed goes out as one CREDIT per stream and per channel when the
 * send buffer has room; until then it stays a counter (§8.2). */
static void flush_grants(Link2 *link) {
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    InStream *stream = &link->in_streams[i];
    if (stream->kind == IS_FREE || stream->pending_grant == 0) continue;
    if (!send_credit(link, stream->id, stream->pending_grant)) return;
    stream->pending_grant = 0;
  }
  for (size_t i = 0; i < link->channel_count; i += 1) {
    Channel *channel = &link->channels[i];
    if (!channel->used || channel->state != LINK2_CHANNEL_OPEN) continue;
    if (channel->first_grant_due) {
      if (!send_credit(link, channel->id, LINK2_APP_EVENT_WINDOW)) return;
      channel->first_grant_due = false;
    }
    if (channel->ev_owed > 0) {
      if (!send_credit(link, channel->id, channel->ev_owed)) return;
      channel->ev_outstanding += channel->ev_owed;
      channel->ev_owed = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Hub's requests: the runtime operations (§6.2)
// ---------------------------------------------------------------------------

static void in_fail(InRequest *request, const char *code, const char *message) {
  fail_with(&request->failure, code, message);
  request->failure.members[0] = '\0';
  request->phase = P_ERROR;
}

/* The host's own failure, with the members it adds to the error reply. */
static void in_fail_host(InRequest *request, const Link2Failure *failure, const char *fallback) {
  in_fail(request, failure->code[0] != '\0' ? failure->code : fallback, failure->message);
  copy_text(request->failure.members, sizeof request->failure.members, failure->members);
}

static void free_in(Link2 *link, InRequest *request) {
  InStream *in = find_in_stream(link, request->id);
  OutStream *out = find_out_stream(link, request->id);
  if (request->kind == IR_PUSH || request->kind == IR_NATIVE || request->kind == IR_LAUNCH || request->kind == IR_REMOVE) link->state_busy = false;
  if (request->kind == IR_SCREENSHOT) {
    if (request->captured && link->host.screenshot_end != NULL) link->host.screenshot_end(link->host.context);
    link->shot_busy = false;
  }
  if (request->staged) {
    if (request->kind == IR_PUSH && link->host.push_abort != NULL) link->host.push_abort(link->host.context);
    if (request->kind == IR_NATIVE && link->host.native_abort != NULL) link->host.native_abort(link->host.context);
  }
  if (in != NULL) free_in_stream(link, in);
  if (out != NULL) free_out_stream(link, out);
  memset(request, 0, sizeof *request);
}

static bool send_install_event(Link2 *link, InRequest *request, const char *phase) {
  FrameWriter writer;
  if (!frame_begin(link, &writer, false, 0)) return false;
  if (request->kind == IR_PUSH) {
    link2_json_text(&writer.json, "{\"t\":\"runtime.install\",\"phase\":");
    link2_json_cstring(&writer.json, phase);
    link2_json_text(&writer.json, ",\"hash\":");
    link2_json_cstring(&writer.json, request->hash);
    link2_json_text(&writer.json, ",\"generation\":");
    link2_json_u64(&writer.json, link->host.runtime_generation != NULL ? link->host.runtime_generation(link->host.context) : 0);
    link2_json_text(&writer.json, ",\"message\":");
    link2_json_cstring(&writer.json, strcmp(phase, "staged") == 0 ? link->push_note : "");
    link2_json_text(&writer.json, "}");
  } else {
    link2_json_text(&writer.json, "{\"t\":\"runtime.native\",\"phase\":");
    link2_json_cstring(&writer.json, phase);
    link2_json_text(&writer.json, ",\"name\":");
    link2_json_cstring(&writer.json, request->name);
    link2_json_text(&writer.json, "}");
  }
  return frame_end(link, &writer, LINK2_FRAME_EVENT, 0, request->id);
}

static bool send_reply(Link2 *link, InRequest *request) {
  FrameWriter writer;
  if (!frame_begin(link, &writer, false, 0)) return false;
  Link2Json *json = &writer.json;
  switch (request->kind) {
    case IR_STATUS:
      link2_json_text(json, "{");
      link->host.runtime_status(link->host.context, json);
      link2_json_text(json, "}");
      break;
    case IR_PUSH:
      link2_json_text(json, "{\"phase\":\"accepted\",\"hash\":");
      link2_json_cstring(json, request->hash);
      link2_json_text(json, ",");
      link2_json_raw(json, link->members, link->members_length);
      link2_json_text(json, "}");
      break;
    case IR_NATIVE:
      link2_json_text(json, "{\"phase\":");
      link2_json_cstring(json, request->native_phase);
      link2_json_text(json, ",\"name\":");
      link2_json_cstring(json, request->name);
      link2_json_text(json, ",\"path\":");
      link2_json_cstring(json, request->native_path);
      link2_json_text(json, "}");
      break;
    case IR_LAUNCH:
    case IR_REMOVE:
      link2_json_text(json, "{");
      link2_json_raw(json, link->members, link->members_length);
      link2_json_text(json, "}");
      break;
    case IR_SCREENSHOT:
      link2_json_text(json, "{\"frame\":");
      link2_json_u64(json, request->frame);
      link2_json_text(json, "}");
      break;
    default:
      link2_json_text(json, "{}");
      break;
  }
  if (frame_end(link, &writer, LINK2_FRAME_REPLY, 0, request->id)) return true;
  /* An object that does not fit an empty send buffer never will. */
  if (tx_used(link) == 0) in_fail(request, "internal", "the reply does not fit a frame");
  return false;
}

/* Moves one of Hub's requests as far as the send buffer lets it go. */
static void advance_request(Link2 *link, InRequest *request) {
  for (;;) {
    switch (request->phase) {
      case P_ERROR:
        if (!reply_error_with(link, request->id, request->failure.code, request->failure.message, request->failure.members)) return;
        free_in(link, request);
        return;
      case P_EVENT_RECEIVING: {
        bool push = request->kind == IR_PUSH;
        if (!send_install_event(link, request, "receiving")) return;
        Link2Failure failure = {"storage", "the staging file did not open", ""};
        bool opened = push ? link->host.push_begin(link->host.context, request->total, request->hash, &failure)
                           : link->host.native_begin(link->host.context, request->name, request->total, request->want_crc, request->launch, &failure);
        if (!opened) {
          in_fail_host(request, &failure, "internal");
          break;
        }
        request->staged = true;
        InStream *stream = new_in_stream(link, request->id, push ? IS_PUSH : IS_NATIVE, -1);
        if (stream == NULL) {
          in_fail(request, "internal", "no stream is free");
          break;
        }
        stream->window = LINK2_WINDOW_BULK;
        stream->total = request->total;
        stream->has_total = true;
        stream->started = true;
        auto_grant(stream);
        request->last_data_ms = now_ms(link);
        request->phase = P_RECEIVING;
        return;
      }
      case P_EVENT_RECEIVED:
        if (!send_install_event(link, request, "received")) return;
        request->phase = P_COMMIT;
        break;
      case P_COMMIT: {
        Link2Failure failure = {"rejected", "", ""};
        request->staged = false;
        if (request->kind == IR_PUSH && link->host.push_admit != NULL) {
          link->push_note[0] = '\0';
          if (!link->host.push_admit(link->host.context, &failure)) {
            in_fail_host(request, &failure, "internal");
            break;
          }
          request->phase = P_ADMITTING;
          return;
        }
        if (request->kind == IR_PUSH) {
          Link2Json members;
          link->push_note[0] = '\0';
          link2_json_init(&members, link->members, sizeof link->members);
          if (!link->host.push_commit(link->host.context, &members, &failure) || members.failed) {
            in_fail_host(request, &failure, "internal");
            break;
          }
          link->members_length = members.length;
          request->phase = P_EVENT_STAGED;
        } else {
          if (!link->host.native_commit(link->host.context, request->name, request->launch, request->native_phase, request->native_path, &failure)) {
            in_fail_host(request, &failure, "internal");
            break;
          }
          request->restart = strcmp(request->native_phase, "launching") == 0;
          request->phase = P_REPLY;
        }
        break;
      }
      case P_EVENT_STAGED:
        if (!send_install_event(link, request, "staged")) return;
        request->phase = P_REPLY;
        break;
      case P_ADMITTING:
        /* The host's link2_push_staged and link2_push_result move it on. */
        if (request->staged_event_due && send_install_event(link, request, "staged")) request->staged_event_due = false;
        return;
      case P_CAPTURING:
        return;
      case P_HEAD: {
        if (!request->head && link->host.screenshot_request != NULL) {
          if (!link->host.screenshot_request(link->host.context)) {
            in_fail(request, "storage", "the capture could not start");
            break;
          }
          request->phase = P_CAPTURING;
          return;
        }
        if (!request->head) {
          Link2Json members;
          uint32_t bytes = 0;
          link2_json_init(&members, link->shot_members, sizeof link->shot_members);
          if (!link->host.screenshot_begin(link->host.context, &members, &request->frame, &bytes) || members.failed) {
            in_fail(request, "internal", "the capture failed");
            break;
          }
          request->head = true;
          request->captured = true;
          request->total = bytes;
          link->shot_members_length = members.length;
        }
        if (!send_members(link, LINK2_FRAME_EVENT, request->id, "runtime.screenshot", link->shot_members, link->shot_members_length)) return;
        OutStream *stream = new_out_stream(link, request->id, OS_SCREENSHOT, -1);
        if (stream == NULL) {
          in_fail(request, "internal", "no stream is free");
          break;
        }
        stream->total = request->total;
        stream->has_total = true;
        stream->ending = true;
        request->phase = P_STREAMING;
        return;
      }
      case P_REPLY:
        if (!send_reply(link, request)) {
          if (request->phase == P_ERROR) break;
          return;
        }
        if (request->restart) {
          request->phase = P_RESTART;
          break;
        }
        free_in(link, request);
        return;
      case P_RESTART:
        /* The REPLY, then CLOSE `restart`; the device exits into the file. */
        close_link(link, LINK2_CLOSE_RESTART, "starting a .3dsx", true);
        return;
      default:
        return;
    }
  }
}

static bool span_is(JsonSpan value, const char *text) {
  size_t length = strlen(text);
  while (value.length > 0 && (value.start[0] == ' ' || value.start[0] == '\n' || value.start[0] == '\t' || value.start[0] == '\r')) {
    value.start += 1;
    value.length -= 1;
  }
  return value.length >= length && memcmp(value.start, text, length) == 0;
}

static size_t count_system_requests(const Link2 *link) {
  size_t count = 0;
  for (size_t i = 0; i < link->in_count; i += 1) {
    if (link->in[i].kind != IR_FREE && link->in[i].kind != IR_APP) count += 1;
  }
  return count;
}

/* A REQUEST without APP: one of the runtime operations, or `unknown_message`. */
static void system_request(Link2 *link, uint32_t id, JsonSpan object, const char *t) {
  static const struct {
    const char *t;
    uint8_t kind;
    const char *feature;
  } KINDS[] = {
    {"runtime.status", IR_STATUS, "runtime"},   {"runtime.logs", IR_LOGS, "runtime"},     {"runtime.push", IR_PUSH, "runtime"},
    {"runtime.native.install", IR_NATIVE, "runtime.native"}, {"runtime.launch", IR_LAUNCH, "runtime"}, {"runtime.screenshot", IR_SCREENSHOT, "runtime"},
    {"runtime.remove", IR_REMOVE, "runtime.remove"},
  };
  uint8_t kind = IR_FREE;
  const char *feature = "";
  for (size_t i = 0; i < sizeof KINDS / sizeof KINDS[0]; i += 1) {
    if (strcmp(t, KINDS[i].t) == 0) {
      kind = KINDS[i].kind;
      feature = KINDS[i].feature;
    }
  }
  if (kind == IR_FREE) {
    reply_error(link, id, "unknown_message", "unknown request");
    return;
  }
  if (!link2_in_use(link, feature)) {
    reply_error(link, id, "unsupported", "the group is not in use");
    return;
  }
  InRequest *request = count_system_requests(link) >= LINK2_HUB_REQUESTS ? NULL : new_in(link, id, kind, -1);
  if (request == NULL) {
    reply_error(link, id, "busy", "8 requests are open");
    return;
  }
  const Link2Host *host = &link->host;
  uint64_t number = 0;
  JsonSpan value;
  switch (kind) {
    case IR_STATUS:
      if (host->runtime_status == NULL) in_fail(request, "unsupported", "no runtime");
      else request->phase = P_REPLY;
      break;
    case IR_LOGS:
      link->logs_on = json_find(object, "on", &value) && span_is(value, "true");
      request->phase = P_REPLY;
      break;
    case IR_PUSH:
    case IR_NATIVE: {
      bool push = kind == IR_PUSH;
      if (link->state_busy) {
        /* The slot belongs to the request that holds it: this one takes none. */
        request->kind = IR_STATUS;
        in_fail(request, "busy", "a state-changing request is open");
        break;
      }
      link->state_busy = true;
      if (push ? (host->push_begin == NULL || host->push_data == NULL || (host->push_commit == NULL && host->push_admit == NULL))
               : (host->native_begin == NULL || host->native_data == NULL || host->native_commit == NULL)) {
        in_fail(request, "unsupported", "this device accepts none");
        break;
      }
      bool sized = json_find_u64(object, "bytes", &number);
      bool named = push ? (json_find_string(object, "hash", request->hash, sizeof request->hash) && link2_valid_id(request->hash, strlen(request->hash)))
                        : (json_find_string(object, "name", request->name, sizeof request->name) && link2_valid_native_name(request->name, strlen(request->name)));
      uint64_t crc = 0;
      if (!sized || !named || (!push && !json_find_u64(object, "crc32", &crc))) {
        in_fail(request, "malformed", "a field is missing or has the wrong type");
        break;
      }
      if (number < (push ? 1u : LINK2_NATIVE_MIN_BYTES) || number > (push ? LINK2_PUSH_MAX_BYTES : LINK2_NATIVE_MAX_BYTES)) {
        in_fail(request, "too_large", "the size is outside the limits");
        break;
      }
      request->total = (uint32_t)number;
      request->want_crc = (uint32_t)crc;
      request->launch = json_find(object, "launch", &value) && span_is(value, "true");
      request->phase = P_EVENT_RECEIVING;
      break;
    }
    case IR_LAUNCH: {
      char native[LINK2_NATIVE_NAME_MAX + 2];
      char app[LINK2_APP_ID_BYTES + 2];
      if (link->state_busy) {
        request->kind = IR_STATUS;
        in_fail(request, "busy", "a state-changing request is open");
        break;
      }
      link->state_busy = true;
      bool has_native = json_find(object, "native", &value) && link2_is_string(value) && json_string(value, native, sizeof native);
      bool has_app = json_find(object, "app", &value) && link2_is_string(value) && json_string(value, app, sizeof app);
      if (host->launch == NULL) {
        in_fail(request, "unsupported", "this device launches nothing");
      } else if (has_native == has_app) {
        in_fail(request, "malformed", "one of native and app");
      } else if (has_native && !link2_in_use(link, "runtime.native")) {
        in_fail(request, "unsupported", "runtime.native is not in use");
      } else if (has_native && !link2_valid_native_name(native, strlen(native))) {
        in_fail(request, "malformed", "not a .3dsx name");
      } else {
        Link2Json members;
        Link2Failure failure = {"rejected", "", ""};
        bool launching = false;
        link2_json_init(&members, link->members, sizeof link->members);
        if (!host->launch(host->context, has_native ? native : NULL, has_app ? app : NULL, &members, &launching, &failure) || members.failed) {
          in_fail_host(request, &failure, "internal");
        } else {
          link->members_length = members.length;
          request->restart = launching;
          request->phase = P_REPLY;
        }
      }
      break;
    }
    case IR_REMOVE: {
      /* The limit counts encoded bytes (§6.2). A decoded id is never longer
       * than its encoding, and one byte over the limit still decodes here, so
       * an id over 128 bytes is told apart from one at the limit. */
      char id[LINK2_APP_ID_BYTES + 2];
      if (link->state_busy) {
        request->kind = IR_STATUS;
        in_fail(request, "busy", "a state-changing request is open");
        break;
      }
      /* The state-changing slot also owns `members`, where the reply waits. */
      link->state_busy = true;
      bool named = json_find(object, "id", &value) && link2_is_string(value) && json_string(value, id, sizeof id);
      size_t length = named ? strlen(id) : 0;
      if (host->remove == NULL) {
        in_fail(request, "unsupported", "this device removes nothing");
      } else if (length == 0 || link2_encoded_bytes(id, length) > LINK2_APP_ID_BYTES) {
        in_fail(request, "malformed", "id is not a string of 1 to 128 bytes");
      } else {
        Link2Json members;
        Link2Failure failure = {"storage", "the slot could not be deleted", ""};
        link2_json_init(&members, link->members, sizeof link->members);
        link2_json_text(&members, "\"id\":");
        link2_json_string(&members, id, length);
        if (!host->remove(host->context, id, &failure)) {
          in_fail_host(request, &failure, "internal");
        } else {
          /* §6.2: the reply names the id removed, after the slot is gone. */
          link->members_length = members.length;
          request->phase = P_REPLY;
        }
      }
      break;
    }
    case IR_SCREENSHOT:
      if ((host->screenshot_begin == NULL && host->screenshot_request == NULL) || host->screenshot_read == NULL) {
        request->kind = IR_STATUS;
        in_fail(request, "unsupported", "this device captures nothing");
      } else if (link->shot_busy) {
        request->kind = IR_STATUS;
        in_fail(request, "busy", "one screenshot at a time");
      } else {
        link->shot_busy = true;
        request->phase = P_HEAD;
      }
      break;
    default:
      break;
  }
  advance_request(link, request);
}

/* DATA of a push or a .3dsx: into the host's staging file, the CRC-32 and the
 * magic checked on the way. */
static void body_data(Link2 *link, InStream *stream, InRequest *request, const uint8_t *bytes, uint32_t length, bool end) {
  bool push = request->kind == IR_PUSH;
  if (length > 0) {
    if (!push) {
      static const uint8_t MAGIC[4] = {'3', 'D', 'S', 'X'};
      for (uint32_t i = 0; i < length && request->received + i < 4; i += 1) {
        if (bytes[i] != MAGIC[request->received + i]) request->head = true; /* not a 3DSX file */
      }
      request->crc = link2_crc32(request->crc, bytes, length);
    }
    bool stored = push ? link->host.push_data(link->host.context, bytes, length) : link->host.native_data(link->host.context, bytes, length);
    if (!stored) {
      send_reset(link, stream->id, LINK2_RESET_STORAGE);
      stream->failed = true;
      in_fail(request, "storage", "the staging file took no more bytes");
      return;
    }
    request->received += length;
    request->last_data_ms = now_ms(link);
  }
  if (!end) {
    auto_grant(stream);
    return;
  }
  stream->ended = true;
  if (request->received != request->total) {
    in_fail(request, "transfer", "the stream ended short of its declared length");
  } else if (!push && request->crc != request->want_crc) {
    in_fail(request, "rejected", "the CRC-32 does not match");
  } else if (!push && request->head) {
    in_fail(request, "rejected", "not a 3DSX file");
  } else {
    request->phase = push ? P_EVENT_RECEIVED : P_COMMIT;
  }
}

// ---------------------------------------------------------------------------
// deferred admission and capture: the host reports at its frame boundary
// ---------------------------------------------------------------------------

static InRequest *waiting_request(Link2 *link, uint8_t kind, uint8_t phase) {
  for (size_t i = 0; i < link->in_count; i += 1) {
    if (link->in[i].kind == kind && link->in[i].phase == phase) return &link->in[i];
  }
  return NULL;
}

void link2_push_staged(Link2 *link, const char *message) {
  InRequest *request = waiting_request(link, IR_PUSH, P_ADMITTING);
  if (request == NULL) return;
  snprintf(link->push_note, sizeof link->push_note, "%s", message == NULL ? "" : message);
  request->staged_event_due = true;
  advance_request(link, request);
}

void link2_push_result(Link2 *link, bool accepted, const char *members, size_t length, const Link2Failure *failure) {
  InRequest *request = waiting_request(link, IR_PUSH, P_ADMITTING);
  if (request == NULL) return;
  if (!accepted) {
    if (failure != NULL) in_fail_host(request, failure, "rejected");
    else in_fail(request, "rejected", "");
  } else if (members == NULL || length > sizeof link->members) {
    in_fail(request, "internal", "the reply does not fit");
  } else {
    memcpy(link->members, members, length);
    link->members_length = length;
    /* A `staged` that found no room goes out ahead of the REPLY. */
    request->phase = request->staged_event_due ? P_EVENT_STAGED : P_REPLY;
    request->staged_event_due = false;
  }
  advance_request(link, request);
}

bool link2_screenshot_ready(Link2 *link, const char *members, size_t length, uint32_t frame, uint32_t bytes) {
  InRequest *request = waiting_request(link, IR_SCREENSHOT, P_CAPTURING);
  if (request == NULL) return false;
  /* From here the host's pixels are the request's: screenshot_end frees them. */
  request->captured = true;
  if (members == NULL || length > sizeof link->shot_members || bytes == 0) {
    in_fail(request, "internal", "the capture failed");
  } else {
    memcpy(link->shot_members, members, length);
    link->shot_members_length = length;
    request->head = true;
    request->frame = frame;
    request->total = bytes;
    request->phase = P_HEAD;
  }
  advance_request(link, request);
  return true;
}

void link2_screenshot_failed(Link2 *link, const char *code, const char *message) {
  InRequest *request = waiting_request(link, IR_SCREENSHOT, P_CAPTURING);
  if (request == NULL) return;
  in_fail(request, code != NULL && code[0] != '\0' ? code : "storage", message != NULL ? message : "");
  advance_request(link, request);
}

// ---------------------------------------------------------------------------
// runtime events the device sends
// ---------------------------------------------------------------------------

void link2_status_changed(Link2 *link) {
  if (link2_in_use(link, "runtime") && link->host.runtime_status != NULL) link->status_due = true;
}

void link2_apps_changed(Link2 *link) {
  link->apps_dirty = true;
}

static void pump_runtime_events(Link2 *link) {
  if (link->status_due) {
    FrameWriter writer;
    if (frame_begin(link, &writer, false, 0)) {
      link2_json_text(&writer.json, "{\"t\":\"runtime.status\",");
      link->host.runtime_status(link->host.context, &writer.json);
      link2_json_text(&writer.json, "}");
      if (frame_end(link, &writer, LINK2_FRAME_EVENT, 0, 0) || tx_used(link) == 0) link->status_due = false;
    }
  }
  /* One report a second at most; a change inside the second goes out at its end (§6.2). */
  if (link->apps_dirty && !link->apps_sending && link->host.runtime_apps != NULL && link2_in_use(link, "apps") &&
      now_ms(link) - link->apps_sent_ms >= LINK2_APPS_INTERVAL_MS) {
    link->apps_dirty = false;
    link->apps_sending = true;
    link->apps_sent_ms = now_ms(link);
    link->apps_set += 1;
    link->apps_at = 0;
  }
  while (link->apps_sending) {
    FrameWriter writer;
    /* A page waits for room without asking the host for its rows at every pump. */
    if (tx_room(link, false) < LINK2_HEADER_BYTES + LINK2_MIN_PAYLOAD) return;
    size_t count = link->host.runtime_apps(link->host.context, link->apps, LINK2_APPS_MAX_ROWS);
    size_t at = link->apps_at;
    if (!frame_begin(link, &writer, false, 0)) return;
    bool page = link2_write_apps_page(&writer.json, link->apps, count, &at, link->apps_set, link->limit);
    if (!page) frame_drop(link, &writer);
    if (!page || !frame_end(link, &writer, LINK2_FRAME_EVENT, 0, 0)) {
      /* No room for this page now; a row that fits no frame ends the report. */
      if (tx_used(link) == 0) link->apps_sending = false;
      return;
    }
    link->apps_at = at;
    if (at >= count) link->apps_sending = false;
  }
}

bool link2_log(Link2 *link, const char *level, const char *source, const char *text, size_t length, uint32_t frame) {
  FrameWriter writer;
  if (!link->logs_on || !link2_in_use(link, "runtime")) return false;
  if (frame_begin(link, &writer, false, 0)) {
    link2_write_log(&writer.json, level, source, text, length, frame, link->logs_dropped, link->limit);
    if (frame_end(link, &writer, LINK2_FRAME_EVENT, 0, 0)) {
      link->logs_dropped = 0;
      return true;
    }
  }
  /* A log event that finds no room is dropped and counted (§8.2). */
  link->logs_dropped += 1;
  link->stats.logs_dropped += 1;
  return false;
}

// ---------------------------------------------------------------------------
// DevTools (§6.3)
// ---------------------------------------------------------------------------

static void devtools_close(Link2 *link) {
  OutRequest *request = link->devtools_id != 0 ? find_out(link, link->devtools_id) : NULL;
  InStream *in = link->devtools_id != 0 ? find_in_stream(link, link->devtools_id) : NULL;
  OutStream *out = link->devtools_id != 0 ? find_out_stream(link, link->devtools_id) : NULL;
  if (request != NULL) free_out(link, request);
  if (in != NULL) free_in_stream(link, in);
  if (out != NULL) free_out_stream(link, out);
  link->devtools_id = 0;
  link->dt_in_head = 0;
  link->dt_in_tail = 0;
  link->dt_out_fill = 0;
  link->dt_skip = false;
}

/* `devtools.open`: the request's id is the stream's id for both directions,
 * and the device grants credit for the free bytes of its line ring in the
 * same write. */
static void devtools_open(Link2 *link) {
  static const char OPEN[] = "{\"t\":\"devtools.open\"}";
  if (!link->devtools || link->devtools_id != 0 || !link2_in_use(link, "devtools")) {
    link->devtools_due = false;
    return;
  }
  link->devtools_due = true;
  if (tx_room(link, false) < LINK2_HEADER_BYTES + sizeof OPEN + LINK2_CREDIT_FRAME_BYTES) return;
  OutRequest *request = new_out(link, OR_DEVTOOLS, -1, true);
  InStream *stream = request != NULL ? new_in_stream(link, request->id, IS_DEVTOOLS, -1) : NULL;
  if (stream == NULL) {
    if (request != NULL) free_out(link, request);
    return;
  }
  send_json(link, LINK2_FRAME_REQUEST, 0, request->id, OPEN, sizeof OPEN - 1, false, 0);
  link->devtools_due = false;
  link->devtools_id = request->id;
  stream->window = LINK2_DEVTOOLS_RING;
  stream->started = true;
  auto_grant(stream);
  flush_grants(link);
}

static bool devtools_append(Link2 *link, const char *line, size_t length) {
  if (length + 1 > LINK2_DEVTOOLS_LINE_OUT - link->dt_out_fill) return false;
  memcpy(link->dt_out + link->dt_out_fill, line, length);
  link->dt_out[link->dt_out_fill + length] = '\n';
  link->dt_out_fill += (uint32_t)length + 1;
  return true;
}

bool link2_devtools_listening(const Link2 *link) {
  return link->devtools_listening;
}

bool link2_devtools_send(Link2 *link, const char *line, size_t length) {
  char dropped_line[96];
  char t[16];
  if (link->devtools_id == 0 || find_out_stream(link, link->devtools_id) == NULL) return false;
  if (length > LINK2_DEVTOOLS_LINE_OUT - 1) {
    /* A line over the limit goes as a `ctrlDropped` line of its size. */
    int n = snprintf(dropped_line, sizeof dropped_line, "{\"t\":\"ctrlDropped\",\"bytes\":%zu,\"cap\":%u}", length, (unsigned)LINK2_DEVTOOLS_LINE_OUT);
    line = dropped_line;
    length = (size_t)n;
  } else if (length < sizeof link->dt_hello && json_find_string(json_span(line, length), "t", t, sizeof t) && strcmp(t, "hello") == 0) {
    /* The first line on a new stream is the shim's last `hello` line. */
    memcpy(link->dt_hello, line, length);
    link->dt_hello_length = (uint32_t)length;
  }
  return devtools_append(link, line, length);
}

const char *link2_devtools_poll(Link2 *link, size_t *length) {
  InStream *stream = link->devtools_id != 0 ? find_in_stream(link, link->devtools_id) : NULL;
  for (uint32_t at = link->dt_in_head; at < link->dt_in_tail; at += 1) {
    if (link->dt_in[at] != '\n') continue;
    const char *line = (const char *)link->dt_in + link->dt_in_head;
    *length = at - link->dt_in_head;
    link->dt_in_head = at + 1;
    /* The line's credit returns now that the shim has it. */
    if (stream != NULL) {
      stream->unconsumed = link->dt_in_tail - link->dt_in_head;
      auto_grant(stream);
    }
    return line;
  }
  return NULL;
}

void link2_guest_switch(Link2 *link, const char *app, const char *output) {
  char line[400];
  Link2Json json;
  InStream *stream = link->devtools_id != 0 ? find_in_stream(link, link->devtools_id) : NULL;
  if (link->devtools_id == 0) return;
  link2_json_init(&json, line, sizeof line);
  link2_json_text(&json, "{\"t\":\"guest.end\",\"app\":");
  link2_json_cstring(&json, app);
  link2_json_text(&json, ",\"output\":");
  link2_json_cstring(&json, output);
  link2_json_text(&json, "}");
  if (!json.failed && find_out_stream(link, link->devtools_id) != NULL) devtools_append(link, line, json.length);
  /* Undelivered lines are dropped; a line cut by the switch is discarded up to its newline. */
  if (link->dt_in_tail > link->dt_in_head && link->dt_in[link->dt_in_tail - 1] != '\n') link->dt_skip = true;
  link->dt_in_head = 0;
  link->dt_in_tail = 0;
  link->dt_hello_length = 0;
  if (stream != NULL) {
    stream->unconsumed = 0;
    auto_grant(stream);
  }
}

/* Bytes of the Hub-to-device stream into the line ring. */
static void devtools_data(Link2 *link, InStream *stream, const uint8_t *bytes, uint32_t length) {
  if (link->dt_in_head > 0) {
    memmove(link->dt_in, link->dt_in + link->dt_in_head, link->dt_in_tail - link->dt_in_head);
    link->dt_in_tail -= link->dt_in_head;
    link->dt_in_head = 0;
  }
  for (uint32_t i = 0; i < length; i += 1) {
    if (link->dt_skip) {
      if (bytes[i] == '\n') link->dt_skip = false;
      continue;
    }
    if (link->dt_in_tail < LINK2_DEVTOOLS_RING) link->dt_in[link->dt_in_tail++] = bytes[i];
  }
  /* A line is at most LINK2_DEVTOOLS_LINE_IN bytes: bytes with no newline
   * past that would hold the ring, and its credit, for good. They are
   * dropped, and the rest of that line with them up to its newline. */
  uint32_t tail = link->dt_in_tail;
  while (tail > link->dt_in_head && link->dt_in[tail - 1] != '\n') tail -= 1;
  if (link->dt_in_tail - tail > LINK2_DEVTOOLS_LINE_IN) {
    link->dt_in_tail = tail;
    link->dt_skip = true;
  }
  stream->unconsumed = link->dt_in_tail - link->dt_in_head;
  auto_grant(stream);
}

// ---------------------------------------------------------------------------
// catalog and install (§6.4)
// ---------------------------------------------------------------------------

static size_t count_out(const Link2 *link, uint8_t kind) {
  size_t count = 0;
  for (size_t i = 0; i < link->out_count; i += 1) {
    if (link->out[i].kind == kind) count += 1;
  }
  return count;
}

bool link2_catalog(Link2 *link) {
  if (!link2_in_use(link, "catalog")) return false;
  if (link->catalog_running) {
    link->catalog_again = true;
    return true;
  }
  link->catalog_running = true;
  link->catalog_first = true;
  link->catalog_has_after = false;
  link->catalog_send_due = true;
  return true;
}

/* One page per request; the next is asked for after the one before was consumed. */
static void catalog_pump(Link2 *link) {
  FrameWriter writer;
  if (!link->catalog_send_due || !frame_begin(link, &writer, false, 0)) return;
  OutRequest *request = new_out(link, OR_CATALOG, -1, false);
  if (request == NULL) {
    frame_drop(link, &writer);
    return;
  }
  link2_json_text(&writer.json, "{\"t\":\"catalog\"");
  if (link->catalog_has_after) {
    link2_json_text(&writer.json, ",\"after\":");
    link2_json_cstring(&writer.json, link->catalog_after);
    link2_json_text(&writer.json, ",\"rev\":");
    link2_json_u64(&writer.json, link->catalog_rev);
  }
  link2_json_text(&writer.json, "}");
  if (!frame_end(link, &writer, LINK2_FRAME_REQUEST, 0, request->id)) {
    free_out(link, request);
    return;
  }
  link->catalog_send_due = false;
}

static void catalog_finish(Link2 *link, const char *error) {
  link->catalog_running = false;
  if (link->host.catalog_done != NULL) link->host.catalog_done(link->host.context, error);
  if (link->catalog_again) {
    link->catalog_again = false;
    link2_catalog(link);
  }
}

static void catalog_reply(Link2 *link, JsonSpan object, bool error) {
  JsonSpan rows, element, last = {NULL, 0};
  char code[LINK2_CODE_BYTES] = "internal";
  uint64_t rev = 0;
  size_t at = 0;
  bool malformed = false;
  if (error) {
    json_find_string(object, "code", code, sizeof code);
    if (strcmp(code, "changed") == 0) {
      /* The offer changed and no snapshot covers it: the pages held go, and the fetch starts over. */
      link->catalog_first = true;
      link->catalog_has_after = false;
      link->catalog_send_due = true;
      return;
    }
    catalog_finish(link, code);
    return;
  }
  if (!json_find(object, "apps", &rows) || !json_is_array(rows) || !json_find_u64(object, "rev", &rev)) {
    catalog_finish(link, "malformed");
    return;
  }
  while (link2_array_next(rows, &at, &element, &malformed)) last = element;
  if (link->host.catalog_page != NULL) link->host.catalog_page(link->host.context, rows.start, rows.length, link->catalog_first);
  link->catalog_first = false;
  JsonSpan more;
  if (json_find(object, "more", &more) && span_is(more, "true") && last.start != NULL && json_find_string(last, "id", link->catalog_after, sizeof link->catalog_after)) {
    link->catalog_has_after = true;
    link->catalog_rev = (uint32_t)rev;
    link->catalog_send_due = true;
    return;
  }
  catalog_finish(link, NULL);
}

uint32_t link2_install(Link2 *link, const char *app) {
  FrameWriter writer;
  if (!link2_in_use(link, "install") || count_out(link, OR_INSTALL) + count_out(link, OR_CATALOG) >= LINK2_MAX_CATALOG_REQUESTS) return 0;
  if (!frame_begin(link, &writer, false, 0)) return 0;
  OutRequest *request = new_out(link, OR_INSTALL, -1, false);
  if (request == NULL) {
    frame_drop(link, &writer);
    return 0;
  }
  link2_json_text(&writer.json, "{\"t\":\"install\",\"app\":");
  link2_json_cstring(&writer.json, app);
  link2_json_text(&writer.json, "}");
  if (!frame_end(link, &writer, LINK2_FRAME_REQUEST, 0, request->id)) {
    free_out(link, request);
    return 0;
  }
  return request->id;
}

/* The host or the worker learns how a request of the device ended, once. */
static void settle_out(Link2 *link, OutRequest *request, const char *error) {
  if (request->settled) return;
  request->settled = true;
  if (request->kind == OR_INSTALL && link->host.install_end != NULL) link->host.install_end(link->host.context, request->id, error);
  if (request->kind == OR_HTTP && link->host.http_end != NULL) link->host.http_end(link->host.context, request->id, error);
  if (request->kind == OR_CATALOG) catalog_finish(link, error);
}

/* `install.head`: the staging file opens and the 64 KiB window starts. */
static void install_head(Link2 *link, OutRequest *request, JsonSpan object) {
  char app[LINK2_APP_ID_BYTES + 2];
  char hash[LINK2_ID_HEX + 2];
  uint64_t bytes = 0;
  if (find_in_stream(link, request->id) != NULL) return;
  bool valid = json_find_string(object, "app", app, sizeof app) && json_find_string(object, "hash", hash, sizeof hash) &&
               json_find_u64(object, "bytes", &bytes) && bytes <= LINK2_INSTALL_MAX_BYTES;
  InStream *stream = valid ? new_in_stream(link, request->id, IS_INSTALL, -1) : NULL;
  if (stream == NULL || link->host.install_begin == NULL || !link->host.install_begin(link->host.context, request->id, app, hash, (uint32_t)bytes)) {
    if (stream != NULL) free_in_stream(link, stream);
    request->cancel_due = true;
    settle_out(link, request, valid ? "storage" : "malformed");
    return;
  }
  stream->window = LINK2_WINDOW_BULK;
  stream->total = (uint32_t)bytes;
  stream->has_total = true;
  stream->started = true;
  auto_grant(stream);
}

// ---------------------------------------------------------------------------
// net.http (§6.5)
// ---------------------------------------------------------------------------

uint32_t link2_http(Link2 *link, const Link2HttpRequest *http) {
  FrameWriter writer;
  if (!link2_in_use(link, "net.http") || link->limit < LINK2_HTTP_MIN_PAYLOAD || count_out(link, OR_HTTP) >= LINK2_HTTP_MAX_OPEN) return 0;
  if (link2_encoded_bytes(http->url, strlen(http->url)) > LINK2_HTTP_URL_BYTES || http->headers_length > LINK2_HTTP_HEADERS_BYTES || http->body_bytes > LINK2_HTTP_MAX_BODY) return 0;
  if (!frame_begin(link, &writer, false, 0)) return 0;
  OutRequest *request = new_out(link, OR_HTTP, -1, false);
  InStream *in = request != NULL ? new_in_stream(link, request->id, IS_HTTP, -1) : NULL;
  OutStream *out = in != NULL ? new_out_stream(link, request->id, OS_HTTP_BODY, -1) : NULL;
  Link2Json *json = &writer.json;
  link2_json_text(json, "{\"t\":\"net.http\",\"app\":");
  link2_json_cstring(json, http->app);
  link2_json_text(json, ",\"url\":");
  link2_json_cstring(json, http->url);
  link2_json_text(json, ",\"method\":");
  link2_json_cstring(json, http->method);
  link2_json_text(json, ",\"headers\":");
  if (http->headers != NULL && http->headers_length > 0) link2_json_raw(json, http->headers, http->headers_length);
  else link2_json_text(json, "{}");
  if (http->timeout_ms != 0) {
    link2_json_text(json, ",\"timeoutMs\":");
    link2_json_u64(json, http->timeout_ms);
  }
  if (http->max_bytes != 0) {
    link2_json_text(json, ",\"maxBytes\":");
    link2_json_u64(json, http->max_bytes);
  }
  link2_json_text(json, ",\"bytes\":");
  link2_json_u64(json, http->body_bytes);
  link2_json_text(json, "}");
  if (out == NULL) frame_drop(link, &writer);
  if (out == NULL || !frame_end(link, &writer, LINK2_FRAME_REQUEST, 0, request->id)) {
    if (out != NULL) free_out_stream(link, out);
    if (in != NULL) free_in_stream(link, in);
    if (request != NULL) free_out(link, request);
    return 0;
  }
  /* The device grants its 8 KiB window in the same write as the request. */
  in->window = LINK2_WINDOW_HTTP;
  in->started = true;
  auto_grant(in);
  flush_grants(link);
  out->total = http->body_bytes;
  out->has_total = true;
  out->ending = true;
  return request->id;
}

void link2_http_consumed(Link2 *link, uint32_t id, uint32_t bytes) {
  InStream *stream = find_in_stream(link, id);
  if (stream == NULL || stream->kind != IS_HTTP) return;
  stream->unconsumed = bytes > stream->unconsumed ? 0 : stream->unconsumed - bytes;
  auto_grant(stream);
}

void link2_http_cancel(Link2 *link, uint32_t id) {
  OutRequest *request = find_out(link, id);
  if (request == NULL || request->kind != OR_HTTP || request->cancelled) return;
  request->cancel_due = true;
  request->settled = true;
}

// ---------------------------------------------------------------------------
// other system events and their streams (the agent)
// ---------------------------------------------------------------------------

bool link2_event(Link2 *link, const char *json, size_t length) {
  return link->phase == PHASE_LINKED && send_json(link, LINK2_FRAME_EVENT, 0, 0, json, length, false, 0);
}

uint32_t link2_new_id(Link2 *link) {
  return link->phase == PHASE_LINKED ? take_id(link) : 0;
}

bool link2_event_stream_as(Link2 *link, uint32_t id, const char *json, size_t length) {
  if (link->phase != PHASE_LINKED || id == 0 || tx_room(link, false) < LINK2_HEADER_BYTES + length) return false;
  /* An id of this side that nothing holds yet. */
  if ((id & 0x80000000u) != 0 || find_out(link, id) != NULL || find_out_stream(link, id) != NULL) return false;
  OutStream *stream = new_out_stream(link, id, OS_SYSTEM, -1);
  if (stream == NULL) return false;
  if (!send_json(link, LINK2_FRAME_EVENT, 0, id, json, length, false, 0)) {
    /* The event fits no frame now (an object over the payload limit never will): no stream. */
    free_out_stream(link, stream);
    return false;
  }
  return true;
}

uint32_t link2_event_stream(Link2 *link, const char *json, size_t length) {
  uint32_t id = link2_new_id(link);
  return id != 0 && link2_event_stream_as(link, id, json, length) ? id : 0;
}

/* One DATA frame of a stream, built in the send buffer: `fill` writes the
 * bytes. False when the one-chunk rule, the credit or the room forbids it. */
static bool data_room(Link2 *link, OutStream *stream, uint32_t available, uint32_t *bytes) {
  /* Each stream has one chunk in the send buffer at a time (§8.2). */
  if (link->tx_sent < stream->tx_mark) return false;
  uint32_t room = tx_room(link, false);
  if (room < LINK2_HEADER_BYTES + 1) return false;
  uint32_t n = available;
  if (n > stream->credit) n = stream->credit;
  if (n > link->limit) n = link->limit;
  if (n > room - LINK2_HEADER_BYTES) n = room - LINK2_HEADER_BYTES;
  *bytes = n;
  return n > 0;
}

static void data_commit(Link2 *link, OutStream *stream, uint8_t *frame, uint32_t bytes, bool end) {
  link2_write_header(frame, LINK2_FRAME_DATA, end ? LINK2_FLAG_END : 0, bytes, stream->id);
  tx_commit(link, LINK2_HEADER_BYTES + bytes);
  stream->credit -= bytes;
  stream->sent += bytes;
  stream->tx_mark = link->tx_queued;
  stream->wait_since = 0;
  if (end) stream->end_sent = true;
}

size_t link2_event_stream_send(Link2 *link, uint32_t id, const uint8_t *bytes, size_t length, bool end) {
  OutStream *stream = find_out_stream(link, id);
  uint32_t n = 0;
  if (stream == NULL || stream->kind != OS_SYSTEM || stream->end_sent) return 0;
  if (length == 0) {
    if (!end || link->tx_sent < stream->tx_mark || tx_room(link, false) < LINK2_HEADER_BYTES) return 0;
    data_commit(link, stream, tx_at(link, LINK2_HEADER_BYTES), 0, true);
    free_out_stream(link, stream);
    return 0;
  }
  if (!data_room(link, stream, length > UINT32_MAX ? UINT32_MAX : (uint32_t)length, &n)) {
    if (stream->credit == 0 && stream->wait_since == 0) stream->wait_since = now_ms(link);
    return 0;
  }
  uint8_t *frame = tx_at(link, LINK2_HEADER_BYTES + n);
  memcpy(frame + LINK2_HEADER_BYTES, bytes, n);
  bool last = end && n == length;
  data_commit(link, stream, frame, n, last);
  if (last) free_out_stream(link, stream);
  return n;
}

bool link2_event_stream_live(Link2 *link, uint32_t id) {
  OutStream *stream = find_out_stream(link, id);
  return stream != NULL && stream->kind == OS_SYSTEM && !stream->end_sent;
}

bool link2_event_stream_end(Link2 *link, uint32_t id) {
  OutStream *stream = find_out_stream(link, id);
  if (stream == NULL || stream->kind != OS_SYSTEM || stream->end_sent) return true;
  if (link->tx_sent < stream->tx_mark || tx_room(link, false) < LINK2_HEADER_BYTES) return false;
  data_commit(link, stream, tx_at(link, LINK2_HEADER_BYTES), 0, true);
  free_out_stream(link, stream);
  return true;
}

// ---------------------------------------------------------------------------
// streams this side sends
// ---------------------------------------------------------------------------

/* A stream this side sends ended without its END: reset by Hub, or given up. */
static void out_stream_dead(Link2 *link, OutStream *stream) {
  InRequest *in = find_in(link, stream->id);
  switch (stream->kind) {
    case OS_SCREENSHOT:
      /* A refused stream's request still gets its REPLY (§5.6). */
      if (in != NULL && in->phase == P_STREAMING) in->phase = P_REPLY;
      free_out_stream(link, stream);
      break;
    case OS_DEVTOOLS:
      devtools_close(link);
      break;
    case OS_APP:
      /* The guest learns it at its next write. */
      stream->failed = true;
      stream->fill = 0;
      break;
    default:
      free_out_stream(link, stream);
      break;
  }
}

static void pump_out_streams(Link2 *link) {
  uint64_t now = now_ms(link);
  for (size_t i = 0; i < link->out_stream_count; i += 1) {
    OutStream *stream = &link->out_streams[i];
    if (stream->kind == OS_SYSTEM) {
      /* Its owner sends the bytes; without credit for 30 s the stream is abandoned (§5.5). */
      if (stream->wait_since != 0 && now - stream->wait_since >= LINK2_REQUEST_STALL_MS && send_reset_now(link, stream->id, LINK2_RESET_CANCELLED)) free_out_stream(link, stream);
      continue;
    }
    if (stream->kind == OS_FREE || stream->end_sent || stream->failed) continue;
    uint32_t available = stream->has_total ? stream->total - stream->sent : stream->kind == OS_DEVTOOLS ? link->dt_out_fill : stream->fill;
    uint32_t n = 0;
    if (available == 0) {
      stream->wait_since = 0;
      if (!stream->ending || link->tx_sent < stream->tx_mark || tx_room(link, false) < LINK2_HEADER_BYTES) continue;
      data_commit(link, stream, tx_at(link, LINK2_HEADER_BYTES), 0, true);
    } else if (!data_room(link, stream, available, &n)) {
      /* Bytes that wait for credit: the sender gives up after 30 s (§5.5); the DevTools stream is exempt. */
      if (stream->credit == 0 && stream->kind != OS_DEVTOOLS) {
        if (stream->wait_since == 0) stream->wait_since = now;
        else if (now - stream->wait_since >= LINK2_REQUEST_STALL_MS) {
          InRequest *in = find_in(link, stream->id);
          OutRequest *out = find_out(link, stream->id);
          if (stream->kind == OS_SCREENSHOT && in != NULL) in_fail(in, "timeout", "no credit for the response in 30 s");
          else if (out != NULL && !out->cancelled) out->cancel_due = true;
          if (stream->kind == OS_APP && in == NULL && out == NULL) send_reset(link, stream->id, LINK2_RESET_CANCELLED);
          out_stream_dead(link, stream);
        }
      }
      continue;
    } else {
      uint8_t *frame = tx_at(link, LINK2_HEADER_BYTES + n);
      uint8_t *payload = frame + LINK2_HEADER_BYTES;
      bool end = false;
      /* The host fills the frame in place: it is open across the callback. */
      uint32_t epoch = link->tx_epoch;
      link->building = true;
      switch (stream->kind) {
        case OS_SCREENSHOT:
          n = (uint32_t)link->host.screenshot_read(link->host.context, payload, n);
          break;
        case OS_HTTP_BODY:
          n = link->host.http_body != NULL ? (uint32_t)link->host.http_body(link->host.context, stream->id, stream->sent, payload, n) : 0;
          break;
        case OS_DEVTOOLS:
          memcpy(payload, link->dt_out, n);
          memmove(link->dt_out, link->dt_out + n, link->dt_out_fill - n);
          link->dt_out_fill -= n;
          break;
        default:
          memcpy(payload, stream->buffer, n);
          memmove(stream->buffer, stream->buffer + n, stream->fill - n);
          stream->fill -= n;
          end = stream->ending && stream->fill == 0;
          break;
      }
      link->building = false;
      /* The callback ended the link: its tables are gone with this frame. */
      if (epoch != link->tx_epoch) return;
      if (n == 0) {
        /* The source has fewer bytes than it declared: the stream is abandoned. */
        send_reset(link, stream->id, LINK2_RESET_LENGTH);
        out_stream_dead(link, stream);
        continue;
      }
      if (stream->has_total) end = stream->sent + n == stream->total;
      data_commit(link, stream, frame, n, end);
    }
    if (!stream->end_sent) continue;
    InRequest *in = find_in(link, stream->id);
    if (stream->kind == OS_SCREENSHOT && in != NULL) in->phase = P_REPLY;
    free_out_stream(link, stream);
  }
}

// ---------------------------------------------------------------------------
// features (§6.1)
// ---------------------------------------------------------------------------

/* A group came into use: its connection-start steps run. */
static void group_came(Link2 *link, const char *feature, bool at_ready) {
  if (strcmp(feature, "runtime") == 0 && at_ready && link->host.runtime_status != NULL) link->status_due = true;
  if (strcmp(feature, "apps") == 0) {
    link->apps_dirty = link->host.runtime_apps != NULL;
    link->apps_sent_ms = 0;
  }
  if (strcmp(feature, "devtools") == 0) devtools_open(link);
  if (strcmp(feature, "channel") == 0) {
    for (size_t i = 0; i < link->channel_count; i += 1) {
      Channel *channel = &link->channels[i];
      if (!channel->used || channel->state != LINK2_CHANNEL_CLOSED) continue;
      channel->blocked[0] = '\0';
      channel->busy_wait_ms = 0;
      channel->next_open_ms = 0;
      channel->wanted = true;
    }
  }
}

/* A group left use because Hub dropped it: Hub ended its part before it said
 * so, and this side's part ends without a frame. */
static void group_left(Link2 *link, const char *feature) {
  if (strcmp(feature, "devtools") == 0) {
    devtools_close(link);
    link->devtools_listening = false;
  }
  if (strcmp(feature, "channel") == 0) {
    for (size_t i = 0; i < link->channel_count; i += 1) {
      Channel *channel = &link->channels[i];
      if (channel->used && channel->state != LINK2_CHANNEL_CLOSED) channel_ended(link, channel, "feature");
    }
  }
  if (strcmp(feature, "runtime") == 0) link->logs_on = false;
}

static void remote_features(Link2 *link, const Link2Features *next) {
  Link2Features before = link->remote;
  link->remote = *next;
  for (size_t i = 0; i < link->local.count; i += 1) {
    const char *feature = link->local.features[i];
    bool was = link2_features_has(&before, feature);
    bool is = link2_features_has(next, feature);
    if (!was && is) group_came(link, feature, false);
    if (was && !is) group_left(link, feature);
  }
}

void link2_set_features(Link2 *link, const char *const *features, size_t count) {
  link->wanted_features.count = 0;
  for (size_t i = 0; i < count && i < LINK2_MAX_FEATURES; i += 1) {
    copy_text(link->wanted_features.features[i], sizeof link->wanted_features.features[i], features[i]);
    link->wanted_features.count += 1;
  }
  /* Linked, or with hello on its way: Hub holds the list hello carried, so
   * the change goes out as a features event (after `ready`). */
  if (link->phase == PHASE_LINKED || link->phase == PHASE_HANDSHAKE) link->features_due = true;
  else link->local = link->wanted_features;
}

/* This side drops a group: it ends its own part in it first, and queues all
 * of that before its `features` event. */
static void drop_group(Link2 *link, const char *feature) {
  for (size_t i = 0; i < link->in_count; i += 1) {
    InRequest *request = &link->in[i];
    const char *group = request->kind == IR_NATIVE ? "runtime.native" : request->kind == IR_REMOVE ? "runtime.remove" : "runtime";
    if (request->kind == IR_FREE || request->kind == IR_APP) continue;
    if (strcmp(feature, group) != 0) continue;
    in_fail(request, "unsupported", "the group left use");
    advance_request(link, request);
  }
  for (size_t i = 0; i < link->out_count; i += 1) {
    OutRequest *request = &link->out[i];
    const char *group = request->kind == OR_CATALOG ? "catalog" : request->kind == OR_INSTALL ? "install" : request->kind == OR_HTTP ? "net.http" : "";
    if (request->kind == OR_FREE || strcmp(group, feature) != 0 || request->cancelled) continue;
    /* The CANCEL leaves before the features event (§6.1): features_pump saw room for it. */
    if (send_cancel(link, request->id)) {
      request->cancelled = true;
      request->cancelled_ms = now_ms(link);
    } else {
      request->cancel_due = true;
    }
    settle_out(link, request, "unsupported");
  }
  if (strcmp(feature, "agent") == 0) {
    /* The agent's streams in both directions end with RESET. */
    for (size_t i = 0; i < link->in_stream_count; i += 1) {
      InStream *stream = &link->in_streams[i];
      if (stream->kind != IS_SYSTEM) continue;
      send_reset(link, stream->id, LINK2_RESET_CANCELLED);
      if (link->host.stream_end != NULL) link->host.stream_end(link->host.context, stream->id, false);
      free_in_stream(link, stream);
    }
    for (size_t i = 0; i < link->out_stream_count; i += 1) {
      OutStream *stream = &link->out_streams[i];
      if (stream->kind != OS_SYSTEM) continue;
      if (!stream->end_sent) send_reset(link, stream->id, LINK2_RESET_CANCELLED);
      free_out_stream(link, stream);
    }
  }
  if (strcmp(feature, "devtools") == 0 && link->devtools_id != 0) {
    send_reset(link, link->devtools_id, LINK2_RESET_CANCELLED);
    devtools_close(link);
  }
  if (strcmp(feature, "channel") == 0) {
    for (size_t i = 0; i < link->channel_count; i += 1) {
      Channel *channel = &link->channels[i];
      if (!channel->used) continue;
      if (channel->state == LINK2_CHANNEL_OPEN) {
        channel_close(link, channel, "feature");
        channel_flush_close(link, channel);
      } else if (channel->state == LINK2_CHANNEL_OPENING) {
        OutRequest *open = find_out(link, channel->id);
        if (open != NULL) open->cancel_due = true;
        channel->cancel_open = true;
      }
    }
  }
}

/* At most one `features` event a second (§6.1). */
static void features_pump(Link2 *link) {
  FrameWriter writer;
  uint64_t now = now_ms(link);
  if (!link->features_due || now - link->features_sent_ms < LINK2_FEATURES_INTERVAL_MS) return;
  if (tx_room(link, false) < 2048) return;
  Link2Features before = link->local;
  for (size_t i = 0; i < before.count; i += 1) {
    if (!link2_features_has(&link->wanted_features, before.features[i]) && link2_features_has(&link->remote, before.features[i])) drop_group(link, before.features[i]);
  }
  link->local = link->wanted_features;
  link->features_due = false;
  link->features_sent_ms = now;
  if (!frame_begin(link, &writer, false, 0)) return;
  link2_json_text(&writer.json, "{\"t\":\"features\",\"features\":[");
  for (size_t i = 0; i < link->local.count; i += 1) {
    if (i > 0) link2_json_text(&writer.json, ",");
    link2_json_cstring(&writer.json, link->local.features[i]);
  }
  link2_json_text(&writer.json, "]}");
  frame_end(link, &writer, LINK2_FRAME_EVENT, 0, 0);
  for (size_t i = 0; i < link->local.count; i += 1) {
    const char *feature = link->local.features[i];
    if (!link2_features_has(&before, feature) && link2_features_has(&link->remote, feature)) group_came(link, feature, false);
  }
}

// ---------------------------------------------------------------------------
// reading frames (§5)
// ---------------------------------------------------------------------------

static bool hold_channel_request(void *context, uint32_t id) {
  Link2 *link = context;
  OutRequest *out = find_out(link, id);
  InRequest *in = find_in(link, id);
  return (out != NULL && out->kind == OR_APP && !out->replied) || (in != NULL && in->kind == IR_APP);
}

static bool hold_own_request(void *context, uint32_t id) {
  OutRequest *out = find_out(context, id);
  return out != NULL && !out->replied;
}

static bool hold_channel(void *context, uint32_t id) {
  return open_channel_by_id(context, id) != NULL;
}

static bool hold_in_use(void *context, uint32_t id) {
  return id_in_use(context, id);
}

/* A REQUEST with APP: into the channel's queue, or refused `busy` (§7.3). */
static void app_request(Link2 *link, const Link2Frame *frame, Channel *channel, const char *json, uint32_t length) {
  int index = channel_index(link, channel);
  size_t open = 0;
  for (size_t i = 0; i < link->in_count; i += 1) {
    if (link->in[i].kind == IR_APP && link->in[i].channel == index) open += 1;
  }
  if (open >= LINK2_CHANNEL_REQUESTS) {
    reply_error(link, frame->id, "busy", "8 requests are open on the channel");
    return;
  }
  if (channel->waiting_requests > 0 && channel->waiting_requests + length > LINK2_APP_WAITING_REQUESTS) {
    reply_error(link, frame->id, "busy", "8 KiB of requests wait for the applet");
    return;
  }
  InRequest *request = new_in(link, frame->id, IR_APP, index);
  if (request == NULL) {
    reply_error(link, frame->id, "busy", "no request slot is free");
    return;
  }
  request->phase = P_QUEUED;
  uint32_t stream_id = 0;
  if ((frame->flags & LINK2_FLAG_BODY) != 0) {
    InStream *stream = count_in_streams(link, index) >= LINK2_CHANNEL_STREAMS ? NULL : new_in_stream(link, frame->id, IS_APP, index);
    if (stream == NULL) {
      send_reset(link, frame->id, LINK2_RESET_REFUSED);
    } else {
      stream->reserved = true;
      stream->app.window = LINK2_APP_STREAM_WINDOW;
      request->body = true;
      stream_id = frame->id;
    }
  }
  if (!inbox_push(channel, LINK2_MESSAGE_REQUEST, request->body ? ENTRY_BODY : 0, 0, frame->id, stream_id, json, length)) {
    channel_close(link, channel, "overflow");
    return;
  }
  channel->waiting_requests += length;
}

static void on_request(Link2 *link, const Link2Frame *frame) {
  char t[LINK2_APP_NAME_BYTES + 2];
  const char *json = (const char *)frame->payload;
  uint32_t length = frame->length;
  if (link2_id_range(frame->id) != LINK2_RANGE_HUB || id_in_use(link, frame->id)) {
    close_link(link, LINK2_CLOSE_PROTOCOL, "a REQUEST id is not a fresh id of its sender", false);
    return;
  }
  if ((frame->flags & LINK2_FLAG_APP) != 0) {
    Channel *channel = open_channel_by_id(link, link2_read_u32(frame->payload));
    json += LINK2_APP_CHANNEL_PREFIX;
    length -= LINK2_APP_CHANNEL_PREFIX;
    JsonSpan object = json_span(json, length);
    if (channel == NULL) reply_error(link, frame->id, "no_channel", "no such channel");
    else if (length > link2_app_message_limit(link->limit)) reply_error(link, frame->id, "too_large", "an object over LINK_APP_MSG");
    else if (!json_is_object(object) || !json_find_string(object, "t", t, sizeof t)) reply_error(link, frame->id, "malformed", "not a JSON object with a string t");
    else app_request(link, frame, channel, json, length);
    return;
  }
  JsonSpan object = json_span(json, length);
  if (!json_is_object(object) || !json_find_string(object, "t", t, sizeof t)) {
    reply_error(link, frame->id, "malformed", "not a JSON object with a string t");
    return;
  }
  system_request(link, frame->id, object, t);
}

/* An outcome this side makes for an applet's request (the 30 s stall, a
 * CANCEL that got no REPLY, a REPLY over LINK_APP_MSG): held for the guest
 * as a REPLY is. The request may be gone on return: a queue with no room
 * closes the channel. */
static void app_local_outcome(Link2 *link, OutRequest *request, const char *code, const char *message) {
  Channel *channel = &link->channels[request->channel];
  char json[LINK2_CODE_BYTES + LINK2_ERROR_MESSAGE_BYTES + 32];
  int length = snprintf(json, sizeof json, "{\"code\":\"%s\",\"message\":\"%s\"}", code, message);
  if (request->reply != NULL) {
    channel_bytes(link, -(long)request->reply_length);
    free(request->reply);
  }
  request->reply = length > 0 && (size_t)length < sizeof json ? malloc((size_t)length + 1) : NULL;
  if (request->reply != NULL) {
    memcpy(request->reply, json, (size_t)length + 1);
    request->reply_length = (uint32_t)length;
    channel_bytes(link, (long)request->reply_length);
  } else {
    request->reply_length = 0;
  }
  request->reply_error = true;
  request->settled = true;
  request->queued = true;
  if (!inbox_push(channel, LINK2_MESSAGE_REPLY, ENTRY_ERROR, 0, request->id, 0, NULL, 0)) channel_close(link, channel, "overflow");
}

/* A REPLY for a request of an applet: held for the guest, behind the
 * progress events that came before it (§7.3). */
static void app_reply(Link2 *link, OutRequest *request, const Link2Frame *frame) {
  Channel *channel = &link->channels[request->channel];
  if (request->settled) {
    /* This side already made the outcome (the 30 s stall): the REPLY frees
     * the id, and the request stays while its outcome waits for the guest. */
    if (request->queued) request->replied = true;
    else free_out(link, request);
    return;
  }
  request->replied = true;
  if (frame->length > link2_app_message_limit(link->limit)) {
    /* Over LINK_APP_MSG: the guest gets `too_large` in its place (§7.2). */
    app_local_outcome(link, request, "too_large", "the reply is over the channel's message limit");
    return;
  }
  request->reply_error = (frame->flags & LINK2_FLAG_ERROR) != 0;
  request->reply = malloc(frame->length + 1);
  if (request->reply != NULL) {
    memcpy(request->reply, frame->payload, frame->length);
    request->reply_length = frame->length;
    channel_bytes(link, (long)frame->length);
  } else {
    request->reply_length = 0;
    request->reply_error = true;
  }
  request->queued = true;
  if (!inbox_push(channel, LINK2_MESSAGE_REPLY, request->reply_error ? ENTRY_ERROR : 0, 0, request->id, 0, NULL, 0)) channel_close(link, channel, "overflow");
}

static void channel_open_reply(Link2 *link, OutRequest *request, JsonSpan object, bool error) {
  if (request->channel < 0) {
    /* The applet left while its open was in flight (link2_channel_exit). An
     * accepting REPLY that crossed the CANCEL opened a channel nobody holds:
     * it is closed at once with `exit` (§7.1). */
    if (error) {
      free_out(link, request);
    } else {
      request->replied = true;
      request->orphan_close = true;
    }
    return;
  }
  Channel *channel = &link->channels[request->channel];
  uint64_t generation = 0;
  if (!error) {
    json_find_u64(object, "generation", &generation);
    /* The id outlives its REPLY as the channel's id. */
    request->replied = true;
    channel_opened(link, channel, (uint32_t)generation);
    return;
  }
  char code[LINK2_CODE_BYTES] = "internal";
  json_find_string(object, "code", code, sizeof code);
  free_out(link, request);
  channel->state = LINK2_CHANNEL_CLOSED;
  channel->cancel_open = false;
  copy_text(channel->reason, sizeof channel->reason, code);
  if (strcmp(code, "busy") == 0) {
    channel->busy_wait_ms = channel->busy_wait_ms == 0 ? LINK2_CHANNEL_BUSY_RETRY_MIN_MS
                          : channel->busy_wait_ms * 2 > LINK2_CHANNEL_BUSY_RETRY_MAX_MS ? LINK2_CHANNEL_BUSY_RETRY_MAX_MS : channel->busy_wait_ms * 2;
    channel->next_open_ms = now_ms(link) + channel->busy_wait_ms;
  } else if (strcmp(code, "cancelled") != 0 && strcmp(code, "timeout") != 0) {
    /* no_daemon, rejected, malformed: not during this applet run. unsupported: until `channel` is in use again. */
    copy_text(channel->blocked, sizeof channel->blocked, code);
  }
}

static void on_reply(Link2 *link, const Link2Frame *frame) {
  OutRequest *request = find_out(link, frame->id);
  bool error = (frame->flags & LINK2_FLAG_ERROR) != 0;
  JsonSpan object = json_span((const char *)frame->payload, frame->length);
  char code[LINK2_CODE_BYTES] = "internal";
  /* A request ends with one REPLY: a second one, or one for an id not awaiting it, is ignored. */
  if (request == NULL || request->replied) return;
  if (error) json_find_string(object, "code", code, sizeof code);
  InStream *in = find_in_stream(link, frame->id);
  OutStream *out = find_out_stream(link, frame->id);
  switch (request->kind) {
    case OR_CATALOG: {
      bool settled = request->settled;
      free_out(link, request);
      if (!settled) catalog_reply(link, object, error);
      break;
    }
    case OR_INSTALL:
      if (error) settle_out(link, request, code);
      else settle_out(link, request, in != NULL && in->ended && !in->failed && in->received == in->total ? NULL : "transfer");
      if (in != NULL) free_in_stream(link, in);
      free_out(link, request);
      break;
    case OR_HTTP:
      settle_out(link, request, error ? code : (in != NULL && in->failed) ? "transfer" : NULL);
      if (in != NULL) free_in_stream(link, in);
      if (out != NULL) free_out_stream(link, out);
      free_out(link, request);
      break;
    case OR_DEVTOOLS:
      if (error) {
        devtools_close(link);
        break;
      }
      request->replied = true;
      if (new_out_stream(link, request->id, OS_DEVTOOLS, -1) == NULL) devtools_close(link);
      else if (link->dt_hello_length > 0) devtools_append(link, link->dt_hello, link->dt_hello_length);
      break;
    case OR_CHANNEL_OPEN:
      channel_open_reply(link, request, object, error);
      break;
    case OR_APP:
      app_reply(link, request, frame);
      break;
    default:
      break;
  }
}

static void system_event(Link2 *link, const Link2Frame *frame, JsonSpan object, const char *t, bool opens_stream) {
  const char *json = (const char *)frame->payload;
  JsonSpan value;
  if (strcmp(t, "features") == 0) {
    Link2Features next;
    if (!json_find(object, "features", &value) || !link2_parse_features(value, &next)) {
      close_link(link, LINK2_CLOSE_PROTOCOL, "a features event without a valid list", false);
      return;
    }
    remote_features(link, &next);
    return;
  }
  if (strcmp(t, "channel.close") == 0) {
    Channel *channel = open_channel_by_id(link, frame->id);
    char reason[LINK2_CODE_BYTES] = "closed";
    json_find_string(object, "reason", reason, sizeof reason);
    if (channel != NULL) {
      channel_ended(link, channel, reason);
      /* A close that leaves the applet running: it opens again when the applet uses the channel. */
      channel->wanted = false;
    }
    return;
  }
  if (frame->id != 0 && !opens_stream) {
    /* Progress on a request of this side. */
    OutRequest *request = find_out(link, frame->id);
    if (request == NULL) return;
    request->last_frame_ms = now_ms(link);
    if (request->cancelled || request->settled) return;
    if (request->kind == OR_INSTALL && strcmp(t, "install.head") == 0) install_head(link, request, object);
    if (request->kind == OR_HTTP && strcmp(t, "net.head") == 0 && link->host.http_head != NULL) link->host.http_head(link->host.context, request->id, json, frame->length);
    return;
  }
  if (opens_stream) {
    /* agent.screen, agent.glyphs: the host grants the declared bytes, or the stream is refused. */
    uint32_t bytes = link2_in_use(link, "agent") && link->host.stream_open != NULL ? link->host.stream_open(link->host.context, frame->id, t, json, frame->length) : 0;
    InStream *stream = bytes > 0 && bytes <= LINK2_MAX_CREDIT ? new_in_stream(link, frame->id, IS_SYSTEM, -1) : NULL;
    if (stream == NULL) {
      send_reset(link, frame->id, LINK2_RESET_REFUSED);
      /* The host took the stream and this side has no place for it: the host is told. */
      if (bytes > 0 && link->host.stream_end != NULL) link->host.stream_end(link->host.context, frame->id, false);
      return;
    }
    stream->window = bytes;
    stream->total = bytes;
    stream->has_total = true;
    stream->started = true;
    auto_grant(stream);
    return;
  }
  if (strcmp(t, "devtools.listen") == 0) {
    if (link2_in_use(link, "devtools")) link->devtools_listening = json_find(object, "on", &value) && span_is(value, "true");
  } else if (strcmp(t, "catalog.changed") == 0) {
    if (link2_in_use(link, "catalog") && link->host.catalog_changed != NULL) link->host.catalog_changed(link->host.context);
  } else if (strncmp(t, "agent.", 6) == 0) {
    if (link2_in_use(link, "agent") && link->host.system_event != NULL) link->host.system_event(link->host.context, t, json, frame->length);
  }
}

static void on_event(Link2 *link, const Link2Frame *frame) {
  char t[LINK2_APP_NAME_BYTES + 2];
  bool app = (frame->flags & LINK2_FLAG_APP) != 0;
  const char *json = (const char *)frame->payload + (app ? LINK2_APP_CHANNEL_PREFIX : 0);
  uint32_t length = frame->length - (app ? LINK2_APP_CHANNEL_PREFIX : 0);
  JsonSpan object = json_span(json, length);
  bool named = json_is_object(object) && json_find_string(object, "t", t, sizeof t);
  Link2Holdings holds = {hold_channel_request, hold_own_request, hold_channel, hold_in_use, link};
  bool opens_stream = false;
  switch (link2_read_event(frame->id, app, named ? t : NULL, &holds, &opens_stream)) {
    case LINK2_EVENT_CLOSE:
      close_link(link, LINK2_CLOSE_PROTOCOL, "an event's id breaks its rule", false);
      return;
    case LINK2_EVENT_IGNORE:
      link->stats.late_events += 1;
      return;
    case LINK2_EVENT_RESET_REFUSED:
      send_reset(link, frame->id, LINK2_RESET_REFUSED);
      return;
    case LINK2_EVENT_APP_PROGRESS: {
      /* Progress on an applet's request, whatever its `t` (§5.3 step 1). */
      OutRequest *request = find_out(link, frame->id);
      if (request == NULL || request->kind != OR_APP) return;
      Channel *channel = &link->channels[request->channel];
      uint32_t cost = 0;
      request->last_frame_ms = now_ms(link);
      /* The sender spent the event's units whatever it holds: they are
       * counted first, and return when the event is discarded. */
      if (!channel_event_cost(link, channel, length, &cost)) return;
      if (!named || length > link2_app_message_limit(link->limit) || request->cancelled || request->settled) {
        /* No name, over LINK_APP_MSG, or its request was cancelled: discarded, and its units return (§5.6). */
        channel->ev_owed += cost;
      } else if (!inbox_push(channel, LINK2_MESSAGE_PROGRESS, 0, cost, frame->id, 0, json, length)) {
        channel_close(link, channel, "overflow");
      }
      return;
    }
    case LINK2_EVENT_APP: {
      Channel *channel = open_channel_by_id(link, link2_read_u32(frame->payload));
      uint32_t cost = 0;
      uint32_t stream_id = 0;
      if (channel == NULL) {
        if (opens_stream) send_reset(link, frame->id, LINK2_RESET_REFUSED);
        return;
      }
      if (!channel_event_cost(link, channel, length, &cost)) return;
      if (length > link2_app_message_limit(link->limit) || !named) {
        /* Dropped, and its units return: the sender spent them. */
        channel->ev_owed += cost;
        if (opens_stream) send_reset(link, frame->id, LINK2_RESET_REFUSED);
        return;
      }
      if (opens_stream) {
        int index = channel_index(link, channel);
        InStream *stream = count_in_streams(link, index) >= LINK2_CHANNEL_STREAMS ? NULL : new_in_stream(link, frame->id, IS_APP, index);
        if (stream == NULL) {
          send_reset(link, frame->id, LINK2_RESET_REFUSED);
        } else {
          stream->reserved = true;
          stream->app.window = LINK2_APP_STREAM_WINDOW;
          stream_id = frame->id;
        }
      }
      if (!inbox_push(channel, LINK2_MESSAGE_EVENT, 0, cost, 0, stream_id, json, length)) channel_close(link, channel, "overflow");
      return;
    }
    case LINK2_EVENT_SYSTEM:
      system_event(link, frame, object, t, opens_stream);
      return;
    default:
      return;
  }
}

static void on_cancel(Link2 *link, uint32_t id) {
  InRequest *request = find_in(link, id);
  if (request == NULL) return;
  if (request->kind == IR_APP) {
    /* The endpoint next to the responder answers the CANCEL itself (§5.4). */
    Channel *channel = &link->channels[request->channel];
    InStream *in = find_in_stream(link, id);
    OutStream *out = find_out_stream(link, id);
    if (request->phase == P_QUEUED) inbox_withdraw(channel, id);
    else inbox_push(channel, LINK2_MESSAGE_CANCEL, 0, 0, id, 0, NULL, 0);
    if (in != NULL) free_in_stream(link, in);
    if (out != NULL) free_out_stream(link, out);
    memset(request, 0, sizeof *request);
    reply_error(link, id, "cancelled", "cancelled");
    return;
  }
  reply_error(link, id, "cancelled", "cancelled");
  free_in(link, request);
}

static void on_data(Link2 *link, const Link2Frame *frame) {
  OutRequest *out = find_out(link, frame->id);
  InStream *stream = find_in_stream(link, frame->id);
  bool end = (frame->flags & LINK2_FLAG_END) != 0;
  if (out != NULL) {
    out->last_frame_ms = now_ms(link);
    /* Cancelled, or about to be (the CANCEL waits for room): its bytes go nowhere. */
    if (out->cancelled || out->cancel_due) return;
    /* An applet response's END can reach this side before the guest took
     * the head event that hands the stream over: an empty response, with
     * its head, END and REPLY in one write. It is kept for the hand-over. */
    if (stream == NULL && out->kind == OR_APP && !out->head && end && frame->length == 0) out->early_end = true;
  }
  if (stream == NULL || stream->ended || stream->failed) return;
  uint32_t *outstanding = stream->kind == IS_APP ? &stream->app.outstanding : &stream->outstanding;
  if (!link2_credit_received(outstanding, frame->length)) {
    close_link(link, LINK2_CLOSE_FLOW, "DATA past credit", false);
    return;
  }
  stream->received += frame->length;
  switch (stream->kind) {
    case IS_PUSH:
    case IS_NATIVE: {
      InRequest *request = find_in(link, frame->id);
      if (request == NULL) return;
      stream->received -= frame->length; /* body_data counts on the request */
      body_data(link, stream, request, frame->payload, frame->length, end);
      advance_request(link, request);
      return;
    }
    case IS_INSTALL:
      if (frame->length > 0 && (link->host.install_data == NULL || !link->host.install_data(link->host.context, stream->id, frame->payload, frame->length))) {
        send_reset(link, stream->id, LINK2_RESET_STORAGE);
        stream->failed = true;
        if (out != NULL) {
          out->cancel_due = true;
          settle_out(link, out, "storage");
        }
        return;
      }
      break;
    case IS_HTTP:
      stream->unconsumed += frame->length;
      if (frame->length > 0 && link->host.http_data != NULL) link->host.http_data(link->host.context, stream->id, frame->payload, frame->length);
      break;
    case IS_DEVTOOLS:
      devtools_data(link, stream, frame->payload, frame->length);
      if (end) devtools_close(link);
      return;
    case IS_SYSTEM:
      if (frame->length > 0 && (link->host.stream_data == NULL || !link->host.stream_data(link->host.context, stream->id, frame->payload, frame->length))) {
        send_reset(link, stream->id, LINK2_RESET_STORAGE);
        if (link->host.stream_end != NULL) link->host.stream_end(link->host.context, stream->id, false);
        free_in_stream(link, stream);
        return;
      }
      if (end) {
        if (link->host.stream_end != NULL) link->host.stream_end(link->host.context, stream->id, stream->received == stream->total);
        free_in_stream(link, stream);
        return;
      }
      break;
    case IS_APP: {
      /* Inside its window by the credit check; the bytes wait for the guest's read. */
      uint32_t used = stream->ready + stream->app.held;
      if (frame->length > 0 && stream->buffer != NULL) {
        if (stream->head + used + frame->length > LINK2_APP_STREAM_WINDOW) {
          memmove(stream->buffer, stream->buffer + stream->head, used);
          stream->head = 0;
        }
        memcpy(stream->buffer + stream->head + used, frame->payload, frame->length);
        stream->app.held += frame->length;
      }
      if (end) stream->ended = true;
      return;
    }
    default:
      break;
  }
  if (end) stream->ended = true;
  else auto_grant(stream);
}

static void on_credit(Link2 *link, const Link2Frame *frame) {
  uint32_t amount = link2_read_u32(frame->payload);
  Channel *channel = open_channel_by_id(link, frame->id);
  OutRequest *out = find_out(link, frame->id);
  InRequest *in = find_in(link, frame->id);
  OutStream *stream = find_out_stream(link, frame->id);
  if (channel != NULL) {
    /* Units of the channel's event window (§5.6); a grant past what a u32 holds is a flow error. */
    if (amount > UINT32_MAX - channel->units) {
      close_link(link, LINK2_CLOSE_FLOW, "event units past 2^32", false);
      return;
    }
    channel->units += amount;
    return;
  }
  if (out != NULL) out->last_frame_ms = now_ms(link);
  uint32_t *credit = stream != NULL ? &stream->credit : out != NULL ? &out->early_credit : in != NULL ? &in->early_credit : NULL;
  if (credit == NULL) return;
  if (!link2_credit_grant(credit, amount)) {
    close_link(link, LINK2_CLOSE_FLOW, "a grant over 16 MiB outstanding", false);
    return;
  }
  if (stream != NULL) stream->wait_since = 0;
}

static void on_reset(Link2 *link, const Link2Frame *frame) {
  InStream *in = find_in_stream(link, frame->id);
  OutStream *out = find_out_stream(link, frame->id);
  if (in == NULL) {
    /* As for an early END: the response stream is not handed over yet. */
    OutRequest *own = find_out(link, frame->id);
    if (own != NULL && own->kind == OR_APP && !own->head) own->early_reset = true;
  }
  if (in != NULL) {
    InRequest *request = find_in(link, frame->id);
    switch (in->kind) {
      case IS_PUSH:
      case IS_NATIVE:
        if (request != NULL) {
          in->failed = true;
          in_fail(request, "transfer", "the stream was reset");
          advance_request(link, request);
        }
        break;
      case IS_DEVTOOLS:
        devtools_close(link);
        return;
      case IS_SYSTEM:
        if (link->host.stream_end != NULL) link->host.stream_end(link->host.context, in->id, false);
        free_in_stream(link, in);
        break;
      case IS_APP:
        /* A stream the guest never read frees its place; one it reads learns at its next read. */
        if (in->reserved) free_in_stream(link, in);
        else in->failed = true;
        break;
      default:
        in->failed = true;
        break;
    }
  }
  if (out != NULL) out_stream_dead(link, out);
}

static void dispatch(Link2 *link, const Link2Frame *frame) {
  uint8_t pong[LINK2_PING_FRAME_BYTES];
  switch (frame->type) {
    case LINK2_FRAME_PING:
      tx_put(link, pong, (uint32_t)link2_write_pong(pong, frame->payload), true);
      break;
    case LINK2_FRAME_PONG:
      if (link->ping_sent_ms != 0 && link2_read_u32(frame->payload) == link->ping_counter) link->stats.rtt_ms = (uint32_t)(now_ms(link) - link->ping_sent_ms);
      break;
    case LINK2_FRAME_CLOSE:
      link_down(link, link2_close_name(link2_read_u16(frame->payload)), false);
      break;
    case LINK2_FRAME_REQUEST: on_request(link, frame); break;
    case LINK2_FRAME_REPLY: on_reply(link, frame); break;
    case LINK2_FRAME_EVENT: on_event(link, frame); break;
    case LINK2_FRAME_CANCEL: on_cancel(link, frame->id); break;
    case LINK2_FRAME_DATA: on_data(link, frame); break;
    case LINK2_FRAME_CREDIT: on_credit(link, frame); break;
    case LINK2_FRAME_RESET: on_reset(link, frame); break;
    default: break;
  }
}

/* Room the send buffer must have before a frame of this type is handled. */
static bool answer_room(const Link2 *link, uint8_t type) {
  switch (type) {
    case LINK2_FRAME_PING: return tx_room(link, true) >= LINK2_PING_FRAME_BYTES;
    case LINK2_FRAME_REQUEST:
    case LINK2_FRAME_CANCEL: return tx_room(link, false) >= ANSWER_REQUEST;
    case LINK2_FRAME_PONG:
    case LINK2_FRAME_CLOSE:
    case LINK2_FRAME_CREDIT: return true;
    default: return tx_room(link, false) >= ANSWER_OTHER;
  }
}

// ---------------------------------------------------------------------------
// discovery and the handshake (§2.3, §3.3)
// ---------------------------------------------------------------------------

static bool tx_flush(Link2 *link) {
  while (tx_used(link) > 0) {
    long n = link->platform.tcp_send(link->platform.context, link->tcp, link->tx + link->tx_head, tx_used(link));
    if (n < 0) return false;
    if (n == 0) break;
    link->tx_head += (uint32_t)n;
    link->tx_sent += (uint64_t)n;
  }
  if (link->tx_head == link->tx_tail) {
    link->tx_head = 0;
    link->tx_tail = 0;
  }
  return true;
}

static bool held(Link2 *link, size_t companion) {
  return now_ms(link) < link->held_until[companion];
}

static void dial(Link2 *link, size_t companion, const char *address, uint16_t port) {
  link->target = companion;
  copy_text(link->target_address, sizeof link->target_address, address);
  link->target_port = port;
  link->tcp = link->platform.tcp_connect(link->platform.context, address, port);
  if (link->tcp < 0) {
    dropped(link, "connect failed");
    return;
  }
  enter(link, PHASE_CONNECTING);
}

/* A device whose range is one version sends its preamble and its hello in
 * the same write (§4.1). */
static void start_handshake(Link2 *link) {
  const Link2Companion *companion = &link->companions.list[link->target];
  const char *features[LINK2_MAX_FEATURES];
  uint8_t nonce[LINK2_NONCE_BYTES];
  char json_text[LINK2_MAX_HANDSHAKE];
  uint8_t frame[LINK2_PREAMBLE_BYTES + LINK2_HEADER_BYTES];
  Link2Json json;
  link->platform.random(link->platform.context, nonce, sizeof nonce);
  hex_encode(nonce, sizeof nonce, link->nonce);
  for (size_t i = 0; i < link->local.count; i += 1) features[i] = link->local.features[i];
  Link2Hello hello = {link->device, companion->id, link->nonce, link->host.name, link->host.model, link->host.target,
                      link->host.host_abi, features, link->local.count, link->offer};
  link2_json_init(&json, json_text, sizeof json_text);
  link2_write_hello(&json, &hello);
  link2_reader_init(&link->reader, link->rx_buffer, link->offer);
  link->preamble_fill = 0;
  link->preamble_done = false;
  link->proved = false;
  link->rx_chunk_at = 0;
  link->rx_chunk_fill = 0;
  link->frame_held = false;
  link->tx_head = 0;
  link->tx_tail = 0;
  link2_write_preamble(frame);
  link2_write_header(frame + LINK2_PREAMBLE_BYTES, LINK2_FRAME_HANDSHAKE, 0, (uint32_t)json.length, 0);
  tx_put(link, frame, sizeof frame, true);
  tx_put(link, (const uint8_t *)json_text, (uint32_t)json.length, true);
  enter(link, PHASE_HANDSHAKE);
}

/* The handshake failed with a CLOSE of this side: the frame goes out before
 * the socket closes. */
static void handshake_close(Link2 *link, uint32_t code, const char *why) {
  uint8_t frame[LINK2_CLOSE_FRAME_MAX];
  tx_put(link, frame, (uint32_t)link2_write_close(frame, code, ""), true);
  tx_flush(link);
  dropped(link, why);
}

static void link_up(Link2 *link, const Link2Ready *ready) {
  Link2Companion *companion = &link->companions.list[link->target];
  uint64_t now = now_ms(link);
  link->limit = link2_payload_limit(link->offer, ready->max_payload);
  link2_reader_ready(&link->reader, link->limit);
  link->backoff_ms = LINK2_BACKOFF_MIN_MS;
  link->stats.links += 1;
  copy_text(link->hub_name, sizeof link->hub_name, ready->name);
  link->clock_skew_ms = (int64_t)ready->clock_utc - (int64_t)now;
  link->clock_offset_min = (int32_t)((ready->clock_local - (int64_t)ready->clock_utc) / 60000);
  link->clock_known = true;
  link->remote = ready->features;
  link->next_id = 1;
  link->ping_counter = 0;
  link->ping_sent_ms = 0;
  link->features_sent_ms = 0;
  link2_keepalive_init(&link->alive, now);
  save_last(link, companion, ready->name, link->target_address, link->target_port);
  enter(link, PHASE_LINKED);
  if (link->host.linked != NULL) link->host.linked(link->host.context, link->hub_name, NULL);
  for (size_t i = 0; i < link->local.count; i += 1) {
    if (link2_features_has(&link->remote, link->local.features[i])) group_came(link, link->local.features[i], true);
  }
}

static void handshake_frame(Link2 *link, const Link2Frame *frame) {
  const Link2Companion *companion = &link->companions.list[link->target];
  JsonSpan object = json_span((const char *)frame->payload, frame->length);
  char code[LINK2_CODE_BYTES];
  char why[64];
  Link2Challenge challenge;
  static Link2Ready ready;
  if (frame->type == LINK2_FRAME_CLOSE) {
    dropped(link, "Hub closed the handshake");
    return;
  }
  if (frame->type != LINK2_FRAME_HANDSHAKE) return;
  if (link2_parse_refused(object, code, sizeof code)) {
    /* Every refusal is an answer: the device holds that Hub for 30 s (§3.8). */
    link->held_until[link->target] = now_ms(link) + LINK2_REFUSED_HOLD_MS;
    snprintf(why, sizeof why, "refused: %s", code);
    dropped(link, why);
    return;
  }
  if (!link->proved && link2_parse_challenge(object, &challenge)) {
    uint8_t expected[32];
    uint8_t mine[32];
    char proof[65];
    char text[128];
    uint8_t header[LINK2_HEADER_BYTES];
    Link2Json json;
    link2_proof(companion->key, LINK2_LABEL_COMPANION, link->nonce, challenge.nonce, link->device, companion->id, expected);
    if (!constant_time_equal(expected, challenge.proof, sizeof expected)) {
      /* The Hub at that address does not hold this device's key. */
      link->held_until[link->target] = now_ms(link) + LINK2_REFUSED_HOLD_MS;
      handshake_close(link, LINK2_CLOSE_AUTH, "auth");
      return;
    }
    link->proved = true;
    link2_proof(companion->key, LINK2_LABEL_CONSOLE, link->nonce, challenge.nonce, link->device, companion->id, mine);
    hex_encode(mine, sizeof mine, proof);
    link2_json_init(&json, text, sizeof text);
    link2_write_auth(&json, proof);
    link2_write_header(header, LINK2_FRAME_HANDSHAKE, 0, (uint32_t)json.length, 0);
    tx_put(link, header, sizeof header, true);
    tx_put(link, (const uint8_t *)text, (uint32_t)json.length, true);
    return;
  }
  if (link->proved && link2_parse_ready(object, &ready)) {
    link_up(link, &ready);
    return;
  }
  handshake_close(link, LINK2_CLOSE_PROTOCOL, "an unexpected handshake message");
}

/* Reads what the socket holds into the chunk when the chunk is used up.
 * False when the connection is gone. */
static bool rx_fill(Link2 *link, uint32_t *budget) {
  if (link->rx_chunk_at < link->rx_chunk_fill || *budget == 0) return true;
  uint32_t want = *budget < RX_CHUNK ? *budget : RX_CHUNK;
  long n = link->platform.tcp_recv(link->platform.context, link->tcp, link->rx_chunk, want);
  if (n < 0) return false;
  link->rx_chunk_at = 0;
  link->rx_chunk_fill = (uint32_t)n;
  *budget -= (uint32_t)n;
  return true;
}

static void pump_handshake(Link2 *link) {
  uint32_t budget = LINK2_RX_BUDGET;
  if (!tx_flush(link)) {
    dropped(link, "closed in the handshake");
    return;
  }
  if (now_ms(link) - link->phase_since >= LINK2_HANDSHAKE_TIMEOUT_MS) {
    handshake_close(link, LINK2_CLOSE_HANDSHAKE_TIMEOUT, "handshake timeout");
    return;
  }
  while (link->phase == PHASE_HANDSHAKE) {
    if (!rx_fill(link, &budget)) {
      dropped(link, "closed in the handshake");
      return;
    }
    if (link->rx_chunk_at == link->rx_chunk_fill) break;
    if (!link->preamble_done) {
      while (link->preamble_fill < LINK2_PREAMBLE_BYTES && link->rx_chunk_at < link->rx_chunk_fill) {
        link->preamble[link->preamble_fill++] = link->rx_chunk[link->rx_chunk_at++];
      }
      if (link->preamble_fill < LINK2_PREAMBLE_BYTES) continue;
      if (link2_accept_preamble(link->preamble) == 0) {
        copy_text(link->error, sizeof link->error, "Hub speaks no common Pocket Link version");
        dropped(link, "no common version");
        return;
      }
      link->preamble_done = true;
      continue;
    }
    size_t consumed = 0;
    Link2Frame frame;
    uint32_t close = 0;
    int state = link2_reader_push(&link->reader, link->rx_chunk + link->rx_chunk_at, link->rx_chunk_fill - link->rx_chunk_at, &consumed, &frame, &close);
    link->rx_chunk_at += (uint32_t)consumed;
    if (state == LINK2_READ_ERROR) {
      handshake_close(link, close, "a bad frame in the handshake");
      return;
    }
    if (state == LINK2_READ_FRAME) handshake_frame(link, &frame);
  }
  if (link->tcp >= 0 && !tx_flush(link)) dropped(link, "closed in the handshake");
}

/* Beacons are drained in every phase and followed while searching. */
static void pump_beacons(Link2 *link) {
  uint8_t datagram[128];
  char address[16];
  if (link->udp < 0) return;
  for (int i = 0; i < 8; i += 1) {
    long n = link->platform.udp_recv(link->platform.context, link->udp, datagram, sizeof datagram, address);
    Link2Beacon beacon;
    if (n < 0) {
      /* The socket is gone (the radio went off under it): the next pump opens another. */
      link->platform.udp_close(link->platform.context, link->udp);
      link->udp = -1;
      link->udp_retry_ms = now_ms(link) + LINK2_BEACON_DRAIN_MS;
      return;
    }
    if (n == 0) return;
    if (link->phase != PHASE_SEARCH || !link2_parse_beacon(datagram, (size_t)n, &beacon)) continue;
    for (size_t c = 0; c < link->companions.count; c += 1) {
      if (strcmp(link->companions.list[c].id, beacon.companion) != 0 || held(link, c)) continue;
      dial(link, c, address, beacon.port);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// the linked pump
// ---------------------------------------------------------------------------

static void pump_requests(Link2 *link) {
  uint64_t now = now_ms(link);
  for (size_t i = 0; i < link->in_count; i += 1) {
    InRequest *request = &link->in[i];
    if (request->kind == IR_FREE || request->kind == IR_APP) continue;
    /* A body that sends no byte for 30 s ends the request (§5.5). */
    if (request->phase == P_RECEIVING && now - request->last_data_ms >= LINK2_REQUEST_STALL_MS) in_fail(request, "timeout", "30 s without a byte of the request's stream");
    advance_request(link, request);
    if (link->phase != PHASE_LINKED) return;
  }
  for (size_t i = 0; i < link->out_count; i += 1) {
    OutRequest *request = &link->out[i];
    if (request->kind == OR_CHANNEL_OPEN && request->orphan_close) {
      static const char CLOSE_EXIT[] = "{\"t\":\"channel.close\",\"reason\":\"exit\"}";
      if (send_json(link, LINK2_FRAME_EVENT, 0, request->id, CLOSE_EXIT, sizeof CLOSE_EXIT - 1, false, 0)) free_out(link, request);
      continue;
    }
    if (request->kind == OR_FREE || request->replied) continue;
    if (!request->cancelled && !request->cancel_due && now - request->last_frame_ms >= LINK2_REQUEST_STALL_MS) {
      /* 30 s without a frame for the request: CANCEL, and this side has its outcome (§5.5). */
      request->cancel_due = true;
      request->timeout = true;
      if (request->kind == OR_APP && !request->settled) {
        app_local_outcome(link, request, "timeout", "30 s without a frame for the request");
        if (request->kind == OR_FREE) continue; /* the channel closed under it */
      } else {
        settle_out(link, request, "timeout");
      }
    }
    if (request->cancel_due && !request->cancelled && send_cancel(link, request->id)) {
      request->cancel_due = false;
      request->cancelled = true;
      request->cancelled_ms = now;
    }
    if (request->cancelled && now - request->cancelled_ms >= LINK2_CANCEL_GRACE_MS) {
      /* No REPLY followed the CANCEL: the id is free. */
      uint8_t kind = request->kind;
      int channel = request->channel;
      InStream *in = find_in_stream(link, request->id);
      OutStream *out = find_out_stream(link, request->id);
      if (kind == OR_APP) {
        /* The applet's call ends `cancelled` (§5.4), unless the stall gave it `timeout` already. */
        if (!request->settled) app_local_outcome(link, request, "cancelled", "no reply followed the CANCEL");
        if (request->kind == OR_FREE) continue;
        if (request->queued) request->replied = true; /* the guest has yet to take its outcome */
        else free_out(link, request);
        continue;
      }
      settle_out(link, request, request->timeout ? "timeout" : "cancelled");
      if (kind == OR_DEVTOOLS) {
        devtools_close(link);
        /* Asked for again on this connection while the group is in use. */
        link->devtools_due = true;
        continue;
      }
      if (in != NULL && in->kind != IS_APP) free_in_stream(link, in);
      if (out != NULL && out->kind != OS_APP) free_out_stream(link, out);
      if (kind == OR_CHANNEL_OPEN && channel >= 0) {
        link->channels[channel].state = LINK2_CHANNEL_CLOSED;
        copy_text(link->channels[channel].reason, sizeof link->channels[channel].reason, "timeout");
      }
      if (request->reply == NULL) free_out(link, request);
      else request->replied = true; /* the guest has yet to take its outcome */
    }
  }
}

static void pump_linked(Link2 *link) {
  uint32_t budget = LINK2_RX_BUDGET;
  bool paused = false;
  if (link->ids_spent) {
    close_link(link, LINK2_CLOSE_GOING_AWAY, "this connection's ids are used up", false);
    return;
  }
  if (!tx_flush(link)) {
    link_down(link, "carrier", false);
    return;
  }
  flush_resets(link);
  for (;;) {
    if (link->frame_held) {
      /* A frame is handled when the send buffer has room for its answer (§8.2). */
      if (!answer_room(link, link->held_frame.type)) {
        paused = true;
        break;
      }
      link->frame_held = false;
      dispatch(link, &link->held_frame);
      if (link->phase != PHASE_LINKED) return;
      continue;
    }
    if (!rx_fill(link, &budget)) {
      link_down(link, "carrier", false);
      return;
    }
    if (link->rx_chunk_at == link->rx_chunk_fill) break;
    size_t consumed = 0;
    uint32_t close = 0;
    int state = link2_reader_push(&link->reader, link->rx_chunk + link->rx_chunk_at, link->rx_chunk_fill - link->rx_chunk_at, &consumed, &link->held_frame, &close);
    link->rx_chunk_at += (uint32_t)consumed;
    if (state == LINK2_READ_ERROR) {
      close_link(link, close, "a frame broke the framing rules", false);
      return;
    }
    if (state == LINK2_READ_FRAME) {
      link2_keepalive_received(&link->alive, now_ms(link));
      link->frame_held = true;
    }
    /* A frame of a type this side does not know is skipped, and is a frame for the 10 s rule. */
    if (link->reader.skipped != link->skipped_seen) {
      link->skipped_seen = link->reader.skipped;
      link2_keepalive_received(&link->alive, now_ms(link));
    }
  }
  if (paused) link->stats.read_pauses += 1;

  switch (link2_keepalive_tick(&link->alive, now_ms(link))) {
    case LINK2_ALIVE_SILENCE:
      close_link(link, LINK2_CLOSE_SILENCE, "10 s without a frame", false);
      return;
    case LINK2_ALIVE_PING: {
      uint8_t ping[LINK2_PING_FRAME_BYTES];
      link->ping_counter += 1;
      if (tx_put(link, ping, (uint32_t)link2_write_ping(ping, link->ping_counter), true)) link->ping_sent_ms = now_ms(link);
      break;
    }
    default:
      break;
  }
  pump_requests(link);
  if (link->phase != PHASE_LINKED) return;
  features_pump(link);
  if (link->devtools_due) devtools_open(link);
  catalog_pump(link);
  pump_runtime_events(link);
  for (size_t i = 0; i < link->channel_count; i += 1) channel_pump(link, &link->channels[i]);
  pump_out_streams(link);
  flush_grants(link);
  if (!tx_flush(link)) link_down(link, "carrier", false);
}

void link2_pump(Link2 *link) {
  if (link->udp < 0 && link->companions.count > 0 && !link->stopped && now_ms(link) >= link->udp_retry_ms) {
    link->udp = link->platform.udp_open(link->platform.context, link->host.beacon_port != 0 ? link->host.beacon_port : LINK2_BEACON_PORT);
    /* A socket that does not open, or one that failed, is tried again once a second. */
    if (link->udp < 0) link->udp_retry_ms = now_ms(link) + LINK2_BEACON_DRAIN_MS;
  }
  /* Beacons matter while searching. Linked, the socket is drained once a
   * second: a host that pumps twice a frame pays no datagram call for it. */
  if (link->phase != PHASE_LINKED || now_ms(link) - link->beacons_ms >= LINK2_BEACON_DRAIN_MS) {
    link->beacons_ms = now_ms(link);
    pump_beacons(link);
  }
  /* Read after the beacons: a dial they start stamps the phase with a later time. */
  uint64_t now = now_ms(link);
  switch (link->phase) {
    case PHASE_SEARCH: {
      /* The direct try: a paired Hub's last address, one pairing per attempt in turn. */
      if (now - link->phase_since < LINK2_SEARCH_DIRECT_MS) break;
      for (size_t step = 0; step < link->companions.count; step += 1) {
        size_t c = (link->direct_turn + step) % link->companions.count;
        const Link2Companion *companion = &link->companions.list[c];
        if (companion->address[0] == '\0' || held(link, c)) continue;
        link->direct_turn = c + 1;
        dial(link, c, companion->address, companion->port);
        break;
      }
      break;
    }
    case PHASE_CONNECTING: {
      int state = link->platform.tcp_connected(link->platform.context, link->tcp);
      if (state > 0) start_handshake(link);
      else if (state < 0) dropped(link, "connect failed");
      else if (now - link->phase_since >= LINK2_CONNECT_TIMEOUT_MS) dropped(link, "connect timeout");
      break;
    }
    case PHASE_HANDSHAKE:
      pump_handshake(link);
      break;
    case PHASE_LINKED:
      pump_linked(link);
      break;
    case PHASE_CLOSING:
      if (!tx_flush(link) || tx_used(link) == 0 || now >= link->close_deadline) {
        char why[LINK2_CODE_BYTES];
        copy_text(why, sizeof why, link->close_why);
        link_down(link, why, link->restart_after_close);
      }
      break;
    case PHASE_BACKOFF:
      if (now >= link->backoff_until) enter(link, link->companions.count == 0 ? PHASE_IDLE : PHASE_SEARCH);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// create, stop, status
// ---------------------------------------------------------------------------

Link2 *link2_create(const Link2Platform *platform, const Link2Host *host) {
  Link2 *link = calloc(1, sizeof *link);
  if (link == NULL) return NULL;
  link->platform = *platform;
  link->host = *host;
  link->udp = -1;
  link->tcp = -1;
  link->backoff_ms = LINK2_BACKOFF_MIN_MS;
  link->offer = host->max_payload != 0 ? host->max_payload : LINK2_TCP_PAYLOAD;
  if (link->offer < LINK2_MIN_PAYLOAD) link->offer = LINK2_MIN_PAYLOAD;
  if (link->offer > LINK2_PAYLOAD_CEILING) link->offer = LINK2_PAYLOAD_CEILING;
  link->channel_count = host->max_channels != 0 ? host->max_channels : 1;
  if (link->channel_count > LINK2_MAX_CHANNELS) link->channel_count = LINK2_MAX_CHANNELS;
  for (size_t i = 0; i < host->feature_count && i < LINK2_MAX_FEATURES; i += 1) {
    copy_text(link->local.features[i], sizeof link->local.features[i], host->features[i]);
    link->local.count += 1;
  }
  link->wanted_features = link->local;
  link->devtools = local_has(link, "devtools");

  /* Hub's requests open here: 8, and 8 per channel. This side's: catalog and
   * install (4), net.http (8), devtools.open, one channel.open and 8 requests
   * per channel. Streams: one per request that carries one, the DevTools pair,
   * the agent's, and 4 each way per channel. */
  link->in_count = LINK2_HUB_REQUESTS + LINK2_CHANNEL_REQUESTS * link->channel_count;
  link->out_count = LINK2_MAX_CATALOG_REQUESTS + LINK2_HTTP_MAX_OPEN + 1 + (1 + LINK2_CHANNEL_REQUESTS) * link->channel_count;
  link->in_stream_count = LINK2_MAX_CATALOG_REQUESTS + LINK2_HTTP_MAX_OPEN + 2 + 4 + LINK2_CHANNEL_STREAMS * link->channel_count;
  link->out_stream_count = LINK2_HTTP_MAX_OPEN + 2 + 4 + LINK2_CHANNEL_STREAMS * link->channel_count;
  link->tx_capacity = LINK2_HEADER_BYTES + link->offer + 16u * 1024u;
  link->rx_buffer = malloc(link->offer);
  link->tx = malloc(link->tx_capacity);
  link->in = calloc(link->in_count, sizeof *link->in);
  link->out = calloc(link->out_count, sizeof *link->out);
  link->in_streams = calloc(link->in_stream_count, sizeof *link->in_streams);
  link->out_streams = calloc(link->out_stream_count, sizeof *link->out_streams);
  link->channels = calloc(link->channel_count, sizeof *link->channels);
  link->stats.fixed_bytes = link->offer + link->tx_capacity;
  if (link->devtools) {
    link->dt_in = malloc(LINK2_DEVTOOLS_RING);
    link->dt_out = malloc(LINK2_DEVTOOLS_LINE_OUT);
    link->stats.fixed_bytes += LINK2_DEVTOOLS_RING + LINK2_DEVTOOLS_LINE_OUT;
  }
  if (link->rx_buffer == NULL || link->tx == NULL || link->in == NULL || link->out == NULL || link->in_streams == NULL || link->out_streams == NULL ||
      link->channels == NULL || (link->devtools && (link->dt_in == NULL || link->dt_out == NULL))) {
    link2_destroy(link);
    return NULL;
  }
  link->phase = PHASE_IDLE;
  link2_reload(link);
  return link;
}

void link2_destroy(Link2 *link) {
  if (link == NULL) return;
  if (link->out != NULL && link->in != NULL && link->in_streams != NULL && link->out_streams != NULL && link->channels != NULL) {
    link->host.linked = NULL;
    link->host.install_end = NULL;
    link->host.http_end = NULL;
    link->host.catalog_done = NULL;
    link->host.stream_end = NULL;
    teardown(link);
    for (size_t i = 0; i < link->channel_count; i += 1) free(link->channels[i].handed_reply);
  }
  if (link->tcp >= 0) link->platform.tcp_close(link->platform.context, link->tcp);
  if (link->udp >= 0) link->platform.udp_close(link->platform.context, link->udp);
  free(link->rx_buffer);
  free(link->tx);
  free(link->in);
  free(link->out);
  free(link->in_streams);
  free(link->out_streams);
  free(link->channels);
  free(link->dt_in);
  free(link->dt_out);
  free(link);
}

void link2_stop(Link2 *link) {
  link->stopped = true;
  if (link->phase == PHASE_LINKED) {
    close_link(link, LINK2_CLOSE_GOING_AWAY, "the device stops", false);
    tx_flush(link);
  } else if (link->phase != PHASE_CLOSING) {
    socket_gone(link);
    enter(link, PHASE_IDLE);
  }
  if (link->udp >= 0) link->platform.udp_close(link->platform.context, link->udp);
  link->udp = -1;
}

bool link2_clock(const Link2 *link, int64_t *utc_ms, int32_t *offset_min) {
  if (!link->clock_known) return false;
  *utc_ms = (int64_t)now_ms(link) + link->clock_skew_ms;
  *offset_min = link->clock_offset_min;
  return true;
}

void link2_status_json(const Link2 *link, Link2Json *json) {
  link2_json_text(json, "{\"phase\":");
  link2_json_cstring(json, PHASE_NAMES[link->phase]);
  link2_json_text(json, ",\"device\":");
  link2_json_cstring(json, link->device);
  link2_json_text(json, ",\"hub\":");
  if (link->phase == PHASE_LINKED) {
    link2_json_text(json, "{\"id\":");
    link2_json_cstring(json, link->companions.list[link->target].id);
    link2_json_text(json, ",\"name\":");
    link2_json_cstring(json, link->hub_name);
    link2_json_text(json, "}");
  } else {
    link2_json_text(json, "null");
  }
  link2_json_text(json, ",\"paired\":[");
  for (size_t i = 0; i < link->companions.count; i += 1) {
    const Link2Companion *companion = &link->companions.list[i];
    if (i > 0) link2_json_text(json, ",");
    link2_json_text(json, "{\"id\":");
    link2_json_cstring(json, companion->id);
    link2_json_text(json, ",\"name\":");
    link2_json_cstring(json, companion->name);
    link2_json_text(json, ",\"address\":");
    link2_json_cstring(json, companion->address);
    link2_json_text(json, ",\"port\":");
    link2_json_u64(json, companion->port);
    link2_json_text(json, "}");
  }
  link2_json_text(json, "],\"limit\":");
  link2_json_u64(json, link2_limit(link));
  link2_json_text(json, ",\"links\":");
  link2_json_u64(json, link->stats.links);
  link2_json_text(json, ",\"last\":");
  link2_json_cstring(json, link->close_why);
  link2_json_text(json, ",\"error\":");
  if (link->error[0] != '\0') link2_json_cstring(json, link->error);
  else link2_json_text(json, "null");
  link2_json_text(json, "}");
}

bool link2_forget(Link2 *link, const char *companion) {
  char path[600];
  bool known = false;
  for (size_t i = 0; i < link->companions.count; i += 1) {
    if (strcmp(link->companions.list[i].id, companion) != 0) continue;
    known = true;
    if (link->phase == PHASE_LINKED && link->target == i) close_link(link, LINK2_CLOSE_GOING_AWAY, "the pairing was removed", false);
    else if ((link->phase == PHASE_CONNECTING || link->phase == PHASE_HANDSHAKE) && link->target == i) dropped(link, "the pairing was removed");
  }
  if (!known || !link2_valid_id(companion, strlen(companion))) return false;
  snprintf(path, sizeof path, "%s/companions/%s.txt", link->host.directory, companion);
  remove(path);
  snprintf(path, sizeof path, "%s/companions/%s.last", link->host.directory, companion);
  remove(path);
  link2_reload(link);
  return true;
}

// ---------------------------------------------------------------------------
// applet channels: the calls of §7.3
// ---------------------------------------------------------------------------

static Channel *channel_at(Link2 *link, int index) {
  if (index < 0 || (size_t)index >= link->channel_count || !link->channels[index].used || link->channels[index].exiting) return NULL;
  return &link->channels[index];
}

/* The channel when it is open. The applet using a closed channel is what
 * opens it again (§7.5). */
static Channel *open_channel_at(Link2 *link, int index) {
  Channel *channel = channel_at(link, index);
  if (channel == NULL) return NULL;
  if (channel->state == LINK2_CHANNEL_OPEN) return channel;
  channel->wanted = true;
  return NULL;
}

/* An applet's object: one JSON object whose `t` is 1 to 64 bytes of [a-z0-9._-]. */
static int check_object(const Link2 *link, const char *json, size_t length) {
  char t[LINK2_APP_NAME_BYTES + 2];
  JsonSpan object = json_span(json, length);
  if (length > link2_app_message_limit(link->limit)) return LINK2_TOO_LARGE;
  if (!json_is_object(object) || !json_find_string(object, "t", t, sizeof t) || !link2_valid_app_name(t, strlen(t))) return LINK2_MALFORMED;
  return LINK2_OK;
}

static OutStream *new_writer(Link2 *link, uint32_t id, int channel) {
  uint8_t *buffer = count_out_streams(link, channel) >= LINK2_CHANNEL_STREAMS ? NULL : malloc(WRITER_BYTES);
  OutStream *stream = buffer != NULL ? new_out_stream(link, id, OS_APP, channel) : NULL;
  if (stream == NULL) {
    free(buffer);
    return NULL;
  }
  stream->buffer = buffer;
  channel_bytes(link, (long)WRITER_BYTES);
  return stream;
}

int link2_channel_open(Link2 *link, const char *app, const char *hash) {
  for (size_t i = 0; i < link->channel_count; i += 1) {
    Channel *channel = &link->channels[i];
    if (channel->used) continue;
    memset(channel, 0, sizeof *channel);
    channel->used = true;
    channel->wanted = true;
    copy_text(channel->app, sizeof channel->app, app);
    copy_text(channel->hash, sizeof channel->hash, hash);
    return (int)i;
  }
  return -1;
}

/* An open in flight is cancelled; an accepting REPLY that crosses the CANCEL
 * closes the new channel at once (§7.1). */
static void cancel_opening(Link2 *link, Channel *channel) {
  OutRequest *request = find_out(link, channel->id);
  if (channel->state != LINK2_CHANNEL_OPENING || request == NULL) return;
  if (!request->cancelled) request->cancel_due = true;
  channel->cancel_open = true;
}

void link2_channel_exit(Link2 *link, int index) {
  Channel *channel = channel_at(link, index);
  if (channel == NULL) return;
  if (channel->state == LINK2_CHANNEL_OPENING) {
    /* The open in flight is cancelled and no longer holds the channel's
     * place: the next applet takes it now, not after the REPLY or the grace. */
    OutRequest *request = find_out(link, channel->id);
    if (request != NULL) {
      if (!request->cancelled) request->cancel_due = true;
      request->channel = -1;
    }
    memset(channel, 0, sizeof *channel);
    return;
  }
  cancel_opening(link, channel);
  channel_close(link, channel, "exit");
  channel->wanted = false;
  channel->exiting = true;
  channel_pump(link, channel);
}

void link2_channel_reset(Link2 *link, int index) {
  Channel *channel = channel_at(link, index);
  if (channel == NULL) return;
  cancel_opening(link, channel);
  channel_close(link, channel, "reset");
  channel->blocked[0] = '\0';
  channel->busy_wait_ms = 0;
  channel->next_open_ms = 0;
  channel->wanted = true;
  channel_pump(link, channel);
}

int link2_channel_state(const Link2 *link, int index, const char **reason) {
  if (index < 0 || (size_t)index >= link->channel_count || !link->channels[index].used) {
    if (reason != NULL) *reason = "";
    return LINK2_CHANNEL_CLOSED;
  }
  const Channel *channel = &link->channels[index];
  if (reason != NULL) *reason = channel->blocked[0] != '\0' ? channel->blocked : channel->reason;
  return channel->state;
}

uint32_t link2_channel_generation(const Link2 *link, int index) {
  if (index < 0 || (size_t)index >= link->channel_count || link->channels[index].state != LINK2_CHANNEL_OPEN) return 0;
  return link->channels[index].generation;
}

void link2_channel_frame(Link2 *link, int index) {
  Channel *channel = channel_at(link, index);
  InStream *waiting[LINK2_CHANNEL_STREAMS];
  size_t count = 0;
  if (channel == NULL || channel->state != LINK2_CHANNEL_OPEN) return;
  free(channel->handed_reply);
  channel->handed_reply = NULL;
  channel->frame_messages = 0;
  channel->frame_json = 0;
  /* A response the applet gave back while its request's body went out:
   * the body has ended, so the RESET no longer costs it anything. */
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    InStream *stream = &link->in_streams[i];
    if (stream->kind != IS_APP || stream->channel != index || !stream->abandon_due) continue;
    OutStream *body = find_out_stream(link, stream->id);
    if (body != NULL && body->kind == OS_APP && !body->end_sent && !body->failed) continue;
    if (!stream->ended && !stream->failed) send_reset(link, stream->id, stream->reserved ? LINK2_RESET_REFUSED : LINK2_RESET_CANCELLED);
    free_in_stream(link, stream);
  }
  /* At most 16 KiB of stream bytes a frame, shared in turn among the streams
   * with a pending read: the stream served first changes each frame. */
  for (size_t i = 0; i < link->in_stream_count && count < LINK2_CHANNEL_STREAMS; i += 1) {
    InStream *stream = &link->in_streams[i];
    if (stream->kind == IS_APP && stream->channel == index && stream->buffer != NULL && stream->app.wanted > 0 && stream->app.held > 0) waiting[count++] = stream;
  }
  uint32_t left = LINK2_APP_FRAME_STREAM;
  for (size_t step = 0; step < count && left > 0; step += 1) {
    InStream *stream = waiting[(channel->frames + step) % count];
    uint32_t n = link2_app_window_take(&stream->app, left);
    stream->ready += n;
    left -= n;
  }
  channel->frames += 1;
  for (size_t i = 0; i < link->in_stream_count; i += 1) {
    InStream *stream = &link->in_streams[i];
    if (stream->kind == IS_APP && stream->channel == index && stream->buffer != NULL && stream->ready == 0 && !stream->ended && !stream->failed) {
      stream->pending_grant += link2_app_window_grant(&stream->app);
    }
  }
  flush_grants(link);
}

bool link2_channel_poll(Link2 *link, int index, Link2Message *message) {
  Channel *channel = channel_at(link, index);
  Entry entry;
  /* An applet that polls a closed channel is listening on it: that asks for
   * the channel as a request or an event does (§7.5), so an applet that only
   * registers handlers gets its channel back after Hub closed it. */
  if (channel != NULL && channel->state == LINK2_CHANNEL_CLOSED && !channel->exiting) channel->wanted = true;
  if (channel == NULL || channel->state != LINK2_CHANNEL_OPEN) return false;
  /* The message handed at the last poll was valid until this call. */
  free(channel->handed_reply);
  channel->handed_reply = NULL;
  memset(message, 0, sizeof *message);
  while (inbox_peek(channel, &entry)) {
    OutRequest *out = entry.kind == LINK2_MESSAGE_PROGRESS || entry.kind == LINK2_MESSAGE_REPLY ? find_out(link, entry.id) : NULL;
    uint32_t bytes = entry.kind == LINK2_MESSAGE_REPLY && out != NULL ? out->reply_length : entry.length;
    if (entry.kind == 0) {
      /* A request withdrawn by its CANCEL before the guest saw it. */
      inbox_pop(channel, &entry);
      continue;
    }
    if (channel->frame_messages >= LINK2_APP_FRAME_MESSAGES) return false;
    if (channel->frame_messages > 0 && channel->frame_json + bytes > LINK2_APP_FRAME_JSON) return false;
    message->kind = entry.kind;
    message->id = entry.id;
    message->json = entry.json;
    message->length = entry.length;
    switch (entry.kind) {
      case LINK2_MESSAGE_EVENT:
        channel->ev_owed += entry.cost;
        message->id = 0;
        message->stream = entry.stream;
        break;
      case LINK2_MESSAGE_PROGRESS:
        if (out == NULL || out->settled || out->cancelled) {
          /* Its request ended meanwhile: discarded, and its units return. */
          channel->ev_owed += entry.cost;
          inbox_pop(channel, &entry);
          continue;
        }
        if (!out->head) {
          /* The head step: the response stream is handed over at the first progress event (§7.2). */
          InStream *stream = count_in_streams(link, index) >= LINK2_CHANNEL_STREAMS ? NULL : new_in_stream(link, entry.id, IS_APP, index);
          if (stream == NULL) {
            if (!send_reset_now(link, entry.id, LINK2_RESET_REFUSED)) return false;
          } else {
            stream->reserved = true;
            stream->app.window = LINK2_APP_STREAM_WINDOW;
            /* What ended the stream before this hand-over (on_data, on_reset). */
            if (out->early_end) stream->ended = true;
            if (out->early_reset) stream->failed = true;
            message->stream = entry.id;
          }
          out->head = true;
        }
        channel->ev_owed += entry.cost;
        break;
      case LINK2_MESSAGE_REPLY: {
        InStream *stream = find_in_stream(link, entry.id);
        if (out == NULL) {
          inbox_pop(channel, &entry);
          continue;
        }
        /* The REPLY is the trailer: it reaches the applet after the response's
         * bytes while the applet reads them. The window is granted whole, so
         * bytes can wait here between two reads: a stream the guest read in
         * this frame or the one before keeps the REPLY behind what it still
         * holds; one the guest stopped reading does not. */
        if (stream != NULL && stream->kind == IS_APP && !stream->reserved && (stream->ready > 0 || stream->app.held > 0) &&
            channel->frames - stream->read_frame <= 1) {
          return false;
        }
        if (stream != NULL && stream->kind == IS_APP && stream->reserved && (stream->ended || stream->failed)) {
          if (!stream->failed) {
            channel->ended_streams[channel->ended_next % LINK2_CHANNEL_STREAMS] = stream->id;
            channel->ended_next += 1;
          }
          free_in_stream(link, stream);
        }
        channel->handed_reply = out->reply;
        message->json = out->reply != NULL ? out->reply : "{\"code\":\"internal\",\"message\":\"no memory for the reply\"}";
        message->length = out->reply != NULL ? out->reply_length : strlen(message->json);
        message->error = (entry.flags & ENTRY_ERROR) != 0;
        channel_bytes(link, -(long)out->reply_length);
        out->reply = NULL;
        out->reply_length = 0;
        out->queued = false;
        /* A reply this side made for a stalled request: the id stays until Hub's REPLY or the grace ends. */
        if (out->replied) free_out(link, out);
        break;
      }
      case LINK2_MESSAGE_REQUEST: {
        InRequest *in = find_in(link, entry.id);
        channel->waiting_requests -= entry.length;
        if (in == NULL) {
          inbox_pop(channel, &entry);
          continue;
        }
        in->phase = P_HANDED;
        message->stream = entry.stream;
        break;
      }
      default:
        break;
    }
    inbox_pop(channel, &entry);
    channel->frame_messages += 1;
    channel->frame_json += bytes;
    return true;
  }
  return false;
}

int link2_channel_request(Link2 *link, int index, const char *json, size_t length, bool body, uint32_t *id) {
  Channel *channel = open_channel_at(link, index);
  if (channel == NULL) return LINK2_NO_CHANNEL;
  int bad = check_object(link, json, length);
  if (bad != LINK2_OK) return bad;
  if (tx_room(link, false) < LINK2_HEADER_BYTES + LINK2_APP_CHANNEL_PREFIX + length) return LINK2_FULL;
  if (body && count_out_streams(link, index) >= LINK2_CHANNEL_STREAMS) return LINK2_FULL;
  OutRequest *request = new_out(link, OR_APP, index, false);
  if (request == NULL) return LINK2_FULL;
  if (body && new_writer(link, request->id, index) == NULL) {
    free_out(link, request);
    return LINK2_FULL;
  }
  send_json(link, LINK2_FRAME_REQUEST, body ? LINK2_FLAG_BODY : 0, request->id, json, length, true, channel->id);
  *id = request->id;
  return LINK2_OK;
}

int link2_channel_cancel(Link2 *link, int index, uint32_t id) {
  OutRequest *request = find_out(link, id);
  if (channel_at(link, index) == NULL || request == NULL || request->kind != OR_APP || request->channel != index) return LINK2_MALFORMED;
  if (!request->replied && !request->cancelled) request->cancel_due = true;
  return LINK2_OK;
}

int link2_channel_emit(Link2 *link, int index, const char *json, size_t length, uint32_t *stream) {
  Channel *channel = open_channel_at(link, index);
  if (channel == NULL) return LINK2_NO_CHANNEL;
  int bad = check_object(link, json, length);
  if (bad != LINK2_OK) return bad;
  uint32_t cost = link2_event_units((uint32_t)length);
  /* A sender with too few units keeps the event on its own side (§5.6). */
  if (cost > channel->units || tx_room(link, false) < LINK2_HEADER_BYTES + LINK2_APP_CHANNEL_PREFIX + length) return LINK2_FULL;
  uint32_t id = 0;
  if (stream != NULL) {
    if (count_out_streams(link, index) >= LINK2_CHANNEL_STREAMS) return LINK2_FULL;
    id = take_id(link);
    if (id == 0 || new_writer(link, id, index) == NULL) return LINK2_FULL;
    *stream = id;
  }
  send_json(link, LINK2_FRAME_EVENT, 0, id, json, length, true, channel->id);
  channel->units -= cost;
  return LINK2_OK;
}

static InRequest *handed_request(Link2 *link, int index, uint32_t id) {
  InRequest *request = find_in(link, id);
  return request != NULL && request->kind == IR_APP && request->channel == index && request->phase == P_HANDED ? request : NULL;
}

int link2_channel_progress(Link2 *link, int index, uint32_t id, const char *json, size_t length) {
  Channel *channel = open_channel_at(link, index);
  if (channel == NULL) return LINK2_NO_CHANNEL;
  InRequest *request = handed_request(link, index, id);
  if (request == NULL) return LINK2_MALFORMED;
  int bad = check_object(link, json, length);
  if (bad != LINK2_OK) return bad;
  uint32_t cost = link2_event_units((uint32_t)length);
  /* A progress event of a channel's request counts against the event window, and it carries no APP flag: its id says whose it is. */
  if (cost > channel->units || !send_json(link, LINK2_FRAME_EVENT, 0, id, json, length, false, 0)) return LINK2_FULL;
  channel->units -= cost;
  request->head = true;
  return LINK2_OK;
}

int link2_channel_reply(Link2 *link, int index, uint32_t id, const char *json, size_t length, bool error) {
  if (open_channel_at(link, index) == NULL) return LINK2_NO_CHANNEL;
  InRequest *request = handed_request(link, index, id);
  if (request == NULL) return LINK2_MALFORMED;
  if (length > link2_app_message_limit(link->limit)) return LINK2_TOO_LARGE;
  OutStream *out = find_out_stream(link, id);
  if (out != NULL && out->failed) {
    /* A reset stream: the request still ends with its REPLY (§5.6). */
    free_out_stream(link, out);
    out = NULL;
  }
  if (out != NULL) {
    /* The responder queues the REPLY after every DATA frame of the request. */
    out->ending = true;
    return LINK2_FULL;
  }
  if (!send_json(link, LINK2_FRAME_REPLY, error ? LINK2_FLAG_ERROR : 0, id, json, length, false, 0)) return LINK2_FULL;
  InStream *in = find_in_stream(link, id);
  if (in != NULL) free_in_stream(link, in);
  memset(request, 0, sizeof *request);
  return LINK2_OK;
}

long link2_stream_read(Link2 *link, int index, uint32_t id, uint8_t *into, size_t capacity) {
  InStream *stream = find_in_stream(link, id);
  Channel *channel = channel_at(link, index);
  if (channel != NULL && stream == NULL && id != 0) {
    /* A stream that ended before its first read, and left at its REPLY. */
    for (size_t i = 0; i < LINK2_CHANNEL_STREAMS; i += 1) {
      if (channel->ended_streams[i] != id) continue;
      channel->ended_streams[i] = 0;
      return LINK2_STREAM_END;
    }
  }
  if (channel == NULL || stream == NULL || stream->kind != IS_APP || stream->channel != index || capacity == 0) return LINK2_MALFORMED;
  if (stream->failed) {
    free_in_stream(link, stream);
    return LINK2_STREAM_FAILED;
  }
  if (stream->reserved) {
    /* The window is allocated when the guest takes the stream; one that cannot be is refused (§9). */
    stream->buffer = stream->ended ? NULL : malloc(LINK2_APP_STREAM_WINDOW);
    if (stream->buffer == NULL) {
      bool ended = stream->ended;
      if (!ended) send_reset(link, id, LINK2_RESET_REFUSED);
      free_in_stream(link, stream);
      return ended ? LINK2_STREAM_END : LINK2_STREAM_FAILED;
    }
    channel_bytes(link, (long)LINK2_APP_STREAM_WINDOW);
    stream->reserved = false;
  }
  stream->read_frame = channel->frames;
  if (stream->ready > 0) {
    uint32_t n = stream->ready < capacity ? stream->ready : (uint32_t)capacity;
    memcpy(into, stream->buffer + stream->head, n);
    stream->head += n;
    stream->ready -= n;
    if (stream->ready == 0 && stream->app.held == 0) stream->head = 0;
    return (long)n;
  }
  if (stream->ended && stream->app.held == 0) {
    free_in_stream(link, stream);
    return LINK2_STREAM_END;
  }
  /* The read is pending: the stream's window is granted while it is. */
  stream->app.wanted = capacity < LINK2_APP_STREAM_WINDOW ? (uint32_t)capacity : LINK2_APP_STREAM_WINDOW;
  if (!stream->ended) {
    stream->pending_grant += link2_app_window_grant(&stream->app);
    flush_grants(link);
  }
  return 0;
}

long link2_stream_write(Link2 *link, int index, uint32_t id, const uint8_t *bytes, size_t length) {
  OutStream *stream = find_out_stream(link, id);
  if (open_channel_at(link, index) == NULL) return LINK2_NO_CHANNEL;
  if (stream == NULL) {
    /* A response's stream opens at its first byte, after the head step (§7.2). */
    InRequest *request = handed_request(link, index, id);
    if (request == NULL) return LINK2_MALFORMED;
    if (!request->head) return LINK2_NO_HEAD;
    stream = new_writer(link, id, index);
    if (stream == NULL) return LINK2_FULL;
  }
  if (stream->kind != OS_APP || stream->channel != index || stream->ending) return LINK2_MALFORMED;
  if (stream->failed) {
    if (find_in(link, id) == NULL && find_out(link, id) == NULL) free_out_stream(link, stream);
    return LINK2_STREAM_FAILED;
  }
  uint32_t room = WRITER_BYTES - stream->fill;
  uint32_t n = length < room ? (uint32_t)length : room;
  memcpy(stream->buffer + stream->fill, bytes, n);
  stream->fill += n;
  return (long)n;
}

int link2_stream_end(Link2 *link, int index, uint32_t id) {
  OutStream *stream = find_out_stream(link, id);
  if (channel_at(link, index) == NULL || stream == NULL || stream->kind != OS_APP || stream->channel != index) return LINK2_MALFORMED;
  stream->ending = true;
  return LINK2_OK;
}

void link2_stream_close(Link2 *link, int index, uint32_t id, int sides) {
  InStream *in = (sides & LINK2_STREAM_IN) != 0 ? find_in_stream(link, id) : NULL;
  OutStream *out = (sides & LINK2_STREAM_OUT) != 0 ? find_out_stream(link, id) : NULL;
  if (channel_at(link, index) == NULL) return;
  if (in != NULL && in->kind == IS_APP && in->channel == index) {
    OutStream *body = (sides & LINK2_STREAM_OUT) == 0 ? find_out_stream(link, id) : NULL;
    if (body != NULL && body->kind == OS_APP && body->channel == index && !body->end_sent && !body->failed) {
      /* A RESET abandons both directions of an id (§5.6): sent now, it would
       * cut the request's body. The response waits unread, holding no credit
       * and no bytes, and is given back when the body has ended
       * (link2_channel_frame). */
      in->abandon_due = true;
    } else {
      if (!in->ended && !in->failed) send_reset(link, id, in->reserved ? LINK2_RESET_REFUSED : LINK2_RESET_CANCELLED);
      free_in_stream(link, in);
    }
  }
  if (out != NULL && out->kind == OS_APP && out->channel == index) {
    if (!out->end_sent && !out->failed) send_reset(link, id, LINK2_RESET_CANCELLED);
    free_out_stream(link, out);
  }
}
