/*
 * Pocket Link 2 client (contracts/spec/link2.ts, docs/POCKET-LINK.md): the
 * device's one authenticated connection to a paired Hub, with everything the
 * device's endpoint does in C: discovery, the handshake from the pairing
 * files, keepalive, the request tables of both directions, byte streams with
 * credit, catalog and install, net.http, the runtime operations, the DevTools
 * stream and the host half of applet channels (§7.3).
 *
 * Version 1 (link.h) stays beside this file while the 3DS program speaks it.
 *
 * The client never blocks a frame: every socket is non-blocking and
 * link2_pump handles at most LINK2_RX_BUDGET received bytes per call. It
 * names no platform API: sockets, the clock and randomness come through
 * Link2Platform (link2_bsd.c fills the socket half from BSD sockets, which
 * POSIX and the 3DS both have), and the program supplies the rest through
 * Link2Host. Files go through stdio and dirent, as version 1's client does.
 *
 * Memory. link2_create allocates the fixed buffers once (§9): the receive
 * buffer (the payload limit it offers), the send buffer (12 + limit + 16 KiB,
 * of which LINK2_TX_RESERVE bytes serve PING, PONG and CLOSE alone), and with
 * the `devtools` feature the line ring (4 x (16 KiB + 1)) and the out buffer
 * (64 KiB). An applet channel allocates when it opens and frees when it
 * closes: its message queue (events under the event window, 24 KiB; daemon
 * requests waiting for the guest, 8 KiB), and, as they come into use, a
 * 16 KiB window per inbound stream (at most 4), a 4 KiB buffer per outbound
 * stream (at most 4) and one copy of each reply waiting for the guest (at
 * most 8 of LINK_APP_MSG).
 */

#ifndef POCKETJS_LINK2_H
#define POCKETJS_LINK2_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "link2_proto.h"

typedef struct Link2 Link2;

// ---------------------------------------------------------------------------
// The platform: sockets, the clock, randomness
// ---------------------------------------------------------------------------

typedef struct {
  void *context;
  /* Monotonic milliseconds from an arbitrary origin. */
  uint64_t (*now_ms)(void *context);
  void (*random)(void *context, uint8_t *out, size_t length);

  /* A non-blocking TCP connection: a handle of 0 or more, or -1. */
  int (*tcp_connect)(void *context, const char *address, uint16_t port);
  /* 1 connected, 0 still connecting, -1 failed. */
  int (*tcp_connected)(void *context, int handle);
  /* Bytes taken (0 when the socket takes none now), or -1 when it is gone. */
  long (*tcp_send)(void *context, int handle, const uint8_t *bytes, size_t length);
  /* Bytes read (0 when none wait), or -1 when the peer closed or it failed. */
  long (*tcp_recv)(void *context, int handle, uint8_t *into, size_t capacity);
  void (*tcp_close)(void *context, int handle);

  /* A UDP socket bound to `port` for beacons: a handle, or -1. */
  int (*udp_open)(void *context, uint16_t port);
  /* One datagram and its sender's IPv4 address; 0 when none waits. */
  long (*udp_recv)(void *context, int handle, uint8_t *into, size_t capacity, char address[16]);
  void (*udp_close)(void *context, int handle);
} Link2Platform;

/* The socket half of a platform from BSD sockets (link2_bsd.c). */
void link2_bsd_sockets(Link2Platform *platform);

// ---------------------------------------------------------------------------
// The host: what the program supplies
// ---------------------------------------------------------------------------

#define LINK2_CODE_BYTES 32u
#define LINK2_MESSAGE_BYTES 96u

/* How a host operation that can fail reports it: `code` is an error code of
 * §5.2 (empty reads as "internal"), `message` one status line. */
typedef struct {
  char code[LINK2_CODE_BYTES];
  char message[LINK2_MESSAGE_BYTES];
  /* Further members of the error reply, as JSON without braces and without a
   * leading comma (`"installed":true`, `"phase":"recovered"`); "" for none. */
  char members[48];
} Link2Failure;

typedef struct {
  void *context;

  /* Identity (§3.4) and configuration. */
  const char *name;
  const char *model;
  const char *target;
  uint32_t host_abi;
  /* The link directory: device.txt and companions/ (3DS: sdmc:/pocketjs/link). */
  const char *directory;
  /* The groups this device serves or uses at start (§6.1). */
  const char *const *features;
  size_t feature_count;
  /* 0 reads as LINK2_BEACON_PORT, LINK2_TCP_PAYLOAD and 1 channel. */
  uint16_t beacon_port;
  uint32_t max_payload;
  uint32_t max_channels;

  /* The link came up (`hub` is its name) or went down (`hub` is NULL and
   * `why` the close code's name or the reason). */
  void (*linked)(void *context, const char *hub, const char *why);

  /* --- runtime operations (§6.2); NULL answers `unsupported` ------------ */

  /* The members of runtime.status, without braces: "phase":…,"app":… */
  void (*runtime_status)(void *context, Link2Json *members);
  uint32_t (*runtime_generation)(void *context);
  /* The installed set, for runtime.apps: fills at most `capacity` rows whose
   * strings stay valid until the next call; returns the count. */
  size_t (*runtime_apps)(void *context, Link2InstalledApp *rows, size_t capacity);

  /* runtime.push: a staging file opens, takes the bytes in order, and the
   * whole package is admitted. `members` gets "generation":…,"message":…,
   * "app":{…} of the accepted reply. */
  bool (*push_begin)(void *context, uint32_t bytes, const char *hash, Link2Failure *failure);
  bool (*push_data)(void *context, const uint8_t *bytes, size_t length);
  bool (*push_commit)(void *context, Link2Json *members, Link2Failure *failure);
  void (*push_abort)(void *context);

  /* The deferred form of push_commit, for a program that admits a package at
   * its own frame boundary: when set it replaces push_commit. True when the
   * admission began; link2_push_staged and link2_push_result report it. */
  bool (*push_admit)(void *context, Link2Failure *failure);

  /* runtime.native.install: the same for a .3dsx whose length, CRC-32 and
   * magic the client checks; `crc32` and `launch` are the request's, for a
   * host whose own install code takes them at the start. `phase` gets
   * "installed", "staged" or "launching", `path` the file's path. */
  bool (*native_begin)(void *context, const char *name, uint32_t bytes, uint32_t crc32, bool launch, Link2Failure *failure);
  bool (*native_data)(void *context, const uint8_t *bytes, size_t length);
  bool (*native_commit)(void *context, const char *name, bool launch, char phase[16], char path[128], Link2Failure *failure);
  void (*native_abort)(void *context);

  /* runtime.launch: one of `native` and `app` is set. `members` gets the
   * reply's members; true in `*launching` when the program restarts into a
   * .3dsx (the client then sends CLOSE `restart` and calls `restart`). */
  bool (*launch)(void *context, const char *native, const char *app, Link2Json *members, bool *launching, Link2Failure *failure);
  /* The REPLY and CLOSE `restart` have left: exit into the file. */
  void (*restart)(void *context);

  /* runtime.remove (§6.2, group `runtime.remove`): delete the installed
   * applet whose manifest id is `id` (1 to 128 bytes), its package and its
   * data. False with `failure`: `not_found` when no installed applet has the
   * id; `rejected` with members "reason":"home" for the launcher or
   * "reason":"running" for the running applet; `busy` while an install of it
   * streams or waits to commit; `storage` when the slot could not be
   * deleted. The host calls link2_apps_changed after a removal. */
  bool (*remove)(void *context, const char *id, Link2Failure *failure);

  /* runtime.screenshot: capture now. `members` gets "frame":…,"format":…,
   * "surfaces":[…] of the head event; the pixels are then read in order. */
  bool (*screenshot_begin)(void *context, Link2Json *members, uint32_t *frame, uint32_t *bytes);
  size_t (*screenshot_read)(void *context, uint8_t *into, size_t capacity);
  void (*screenshot_end)(void *context);
  /* The deferred form of screenshot_begin: when set it replaces it. True when
   * a capture is due at the program's next frame boundary;
   * link2_screenshot_ready or link2_screenshot_failed reports it. */
  bool (*screenshot_request)(void *context);

  /* --- catalog and install (§6.4) --------------------------------------- */

  /* One page of Hub's offer: the JSON array of its rows. `first` starts a
   * fetch over (drop the rows held). */
  void (*catalog_page)(void *context, const char *rows, size_t length, bool first);
  /* The fetch ended: `error` is NULL when every page arrived. */
  void (*catalog_done)(void *context, const char *error);
  /* Hub's offer changed. */
  void (*catalog_changed)(void *context);
  bool (*install_begin)(void *context, uint32_t request, const char *app, const char *hash, uint32_t bytes);
  bool (*install_data)(void *context, uint32_t request, const uint8_t *bytes, size_t length);
  /* `error` is NULL when the whole file arrived. */
  void (*install_end)(void *context, uint32_t request, const char *error);

  /* --- net.http (§6.5): the worker's side -------------------------------- */

  /* The request body from `offset` on. */
  size_t (*http_body)(void *context, uint32_t request, size_t offset, uint8_t *into, size_t capacity);
  /* The `net.head` object. */
  void (*http_head)(void *context, uint32_t request, const char *json, size_t length);
  /* Response bytes, inside the window the worker returned with link2_http_consumed. */
  void (*http_data)(void *context, uint32_t request, const uint8_t *bytes, size_t length);
  void (*http_end)(void *context, uint32_t request, const char *error);

  /* --- other system events (the agent's messages, §6.6) ----------------- */

  /* An event with id 0 that the client does not consume itself. */
  void (*system_event)(void *context, const char *t, const char *json, size_t length);
  /* An event that opens a stream toward the device (agent.screen,
   * agent.glyphs): the bytes to grant, or 0 to refuse it. */
  uint32_t (*stream_open)(void *context, uint32_t id, const char *t, const char *json, size_t length);
  bool (*stream_data)(void *context, uint32_t id, const uint8_t *bytes, size_t length);
  /* `complete` is false for a reset or a length that differs from the grant. */
  void (*stream_end)(void *context, uint32_t id, bool complete);
} Link2Host;

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/* Allocates the fixed buffers and reads the pairing files. NULL without
 * memory. The platform and host structs are copied; the strings and lists
 * `host` points at must outlive the client. */
Link2 *link2_create(const Link2Platform *platform, const Link2Host *host);
void link2_destroy(Link2 *link);
/* Reads device.txt and companions/ again, as the program does when it starts. */
void link2_reload(Link2 *link);
/* Once per frame. */
void link2_pump(Link2 *link);
/* Ends the link with CLOSE `going_away` and stops searching. */
void link2_stop(Link2 *link);

bool link2_linked(const Link2 *link);
/* A group is in use: both sides list it (§6.1). */
bool link2_in_use(const Link2 *link, const char *feature);
/* The payload limit of the connection, 0 without one. */
uint32_t link2_limit(const Link2 *link);
/* The device id, 16 hex digits. */
const char *link2_device_id(const Link2 *link);
/* Hub's clock at `ready` moved to now: epoch ms (UTC) and its zone's offset. */
bool link2_clock(const Link2 *link, int64_t *utc_ms, int32_t *offset_min);
/* {"phase":…,"device":…,"hub":…,"paired":[…],"limit":…,"error":…} */
void link2_status_json(const Link2 *link, Link2Json *json);
/* Removes a pairing: its key file and its .last file; a link to that Hub closes. */
bool link2_forget(Link2 *link, const char *companion);
/* This device's list changes on a live link: at most one `features` event a second.
 * `devtools` can be listed later only when the list given to link2_create had
 * it: the client allocates the DevTools buffers there and nowhere else. */
void link2_set_features(Link2 *link, const char *const *features, size_t count);

/* --- pairing by a code (§3.11) ------------------------------------------ */

#define LINK2_PAIR_IDLE 0   /* no code */
#define LINK2_PAIR_OPEN 1   /* a code is shown and no Hub is asked */
#define LINK2_PAIR_ASKING 2 /* a Hub is asked: its owner has the code to enter */
#define LINK2_PAIR_PAIRED 3 /* the last code ended with a pairing */
#define LINK2_PAIR_FAILED 4 /* it ended without one: `error` says why */

typedef struct {
  char id[LINK2_ID_HEX + 1];
  char name[LINK2_BEACON_NAME_BYTES + 1];
} Link2PairHub;

typedef struct {
  int state;
  /* The code to show, "" outside LINK2_PAIR_OPEN and LINK2_PAIR_ASKING. */
  char code[LINK2_PAIR_CODE_DIGITS + 1];
  /* What is left of the code's time, and of the offers with a wrong proof it takes. */
  uint32_t left_ms;
  uint32_t tries;
  /* The Hub asked, or the Hub the last code paired with; "" for none. */
  char hub[LINK2_ID_HEX + 1];
  char hub_name[LINK2_NAME_BYTES * 2 + 1];
  char error[64];
  /* While a code is shown: the Hubs whose beacons arrived in the last 3 s. */
  Link2PairHub hubs[LINK2_PAIR_MAX_SEEN];
  size_t hub_count;
} Link2PairStatus;

/* Makes a code and starts listing the Hubs on the network; a link that is
 * up stays up. False once link2_stop was called. */
bool link2_pair_open(Link2 *link);
/* Asks `hub`, an id of the list: a link to another Hub ends, and the device
 * connects to this one and waits for its owner to enter the code. False
 * without a code, for a Hub that is not in the list, and when the device
 * holds 8 pairings of other Hubs. */
bool link2_pair_ask(Link2 *link, const char *hub);
/* Drops the code. */
void link2_pair_close(Link2 *link);
void link2_pair_status(const Link2 *link, Link2PairStatus *out);

/* --- runtime (§6.2) ----------------------------------------------------- */

/* The runtime's phase changed: the unsolicited runtime.status event. */
void link2_status_changed(Link2 *link);
/* The installed set changed: a runtime.apps report follows, one a second at most. */
void link2_apps_changed(Link2 *link);
/* One log line while runtime.logs is on. False when it was not sent; a line
 * that found no room in the send buffer is counted as dropped. */
bool link2_log(Link2 *link, const char *level, const char *source, const char *text, size_t length, uint32_t frame);

/* runtime.push after push_admit: the package booted and waits for its first
 * retired frame, the `staged` event. */
void link2_push_staged(Link2 *link, const char *message);
/* The admission's outcome: `members` as push_commit's when accepted, else
 * `failure` (NULL reads as `rejected`). Ignored when no push waits for it. */
void link2_push_result(Link2 *link, bool accepted, const char *members, size_t length, const Link2Failure *failure);
/* runtime.screenshot after screenshot_request: `members` as
 * screenshot_begin's. False when no request waits for the capture (the link
 * dropped): the program frees it. After true, screenshot_end frees it. */
bool link2_screenshot_ready(Link2 *link, const char *members, size_t length, uint32_t frame, uint32_t bytes);
void link2_screenshot_failed(Link2 *link, const char *code, const char *message);

/* --- DevTools (§6.3) ---------------------------------------------------- */

/* devtools.listen: the shim's `listening()`. */
bool link2_devtools_listening(const Link2 *link);
/* One line toward Hub, without its newline (`ui.__dbgSend`). False when the
 * out buffer has no room for it; a line over 64 KiB goes as `ctrlDropped`. */
bool link2_devtools_send(Link2 *link, const char *line, size_t length);
/* The next whole line Hub sent (`ui.__dbgPoll`), without its newline, valid
 * until the next call into the client; NULL when none waits. */
const char *link2_devtools_poll(Link2 *link, size_t *length);
/* The host tears a guest down: the `guest.end` line goes out behind the old
 * guest's lines and undelivered lines toward it are dropped. */
void link2_guest_switch(Link2 *link, const char *app, const char *output);

/* --- catalog, install, net.http ----------------------------------------- */

/* Starts a fetch of Hub's offer; one runs at a time, and a call made while
 * one runs is served by a fetch that starts after it. False without the
 * `catalog` group. */
bool link2_catalog(Link2 *link);
/* Streams one app of the offer: the request's id, or 0 when it cannot start now. */
uint32_t link2_install(Link2 *link, const char *app);

typedef struct {
  const char *app;
  const char *url;
  const char *method;
  /* The headers as one JSON object, at most 8 KiB encoded; NULL for {}. */
  const char *headers;
  size_t headers_length;
  uint32_t body_bytes;
  /* 0 leaves the field out. */
  uint32_t timeout_ms;
  uint32_t max_bytes;
} Link2HttpRequest;
/* The request's id, or 0 when net.http is not in use on this connection
 * (the group, or a payload limit under 12,288), a limit is broken, 8 are
 * open, or the send buffer has no room now. */
uint32_t link2_http(Link2 *link, const Link2HttpRequest *request);
/* The worker consumed response bytes: their credit returns. */
void link2_http_consumed(Link2 *link, uint32_t request, uint32_t bytes);
void link2_http_cancel(Link2 *link, uint32_t request);

/* --- system events and their streams (the agent, §6.6) ------------------ */

/* An event with id 0. False when the send buffer has no room now. */
bool link2_event(Link2 *link, const char *json, size_t length);
/* An event that opens a stream toward Hub: the stream's id, or 0. */
uint32_t link2_event_stream(Link2 *link, const char *json, size_t length);
/* The same for an event whose JSON names its stream (agent.audio, agent.shot,
 * §6.6): link2_new_id gives a fresh id of this side's range (0 without a
 * link), and the event then opens the stream under it. */
uint32_t link2_new_id(Link2 *link);
bool link2_event_stream_as(Link2 *link, uint32_t id, const char *json, size_t length);
/* Bytes of that stream inside its credit and the send buffer's room; the
 * count taken. `end` closes the stream once every byte is taken. */
size_t link2_event_stream_send(Link2 *link, uint32_t id, const uint8_t *bytes, size_t length, bool end);
/* Closes the stream with an empty END frame. True when the END is queued or
 * the stream is already gone; false when it has to be asked again. */
bool link2_event_stream_end(Link2 *link, uint32_t id);
/* The stream is open: false once its END left, Hub reset it or the link dropped. */
bool link2_event_stream_live(Link2 *link, uint32_t id);

// ---------------------------------------------------------------------------
// Applet channels: the host half of §7.3
// ---------------------------------------------------------------------------

#define LINK2_CHANNEL_CLOSED 0
#define LINK2_CHANNEL_OPENING 1
#define LINK2_CHANNEL_OPEN 2

/* What a call that cannot go ahead returns. */
#define LINK2_OK 0
#define LINK2_FULL (-1)        /* no room, units or credit now: try again in a later frame */
#define LINK2_NO_CHANNEL (-2)  /* the channel is not open */
#define LINK2_TOO_LARGE (-3)   /* an object over LINK_APP_MSG */
#define LINK2_MALFORMED (-4)   /* not an object with a valid `t`, or an unknown id */
#define LINK2_NO_HEAD (-5)     /* response bytes before a progress event (§7.2) */
#define LINK2_STREAM_END (-6)  /* the stream ended and every byte was taken */
#define LINK2_STREAM_FAILED (-7) /* the stream was reset */
#define LINK2_STALE (-8)       /* a handle of an earlier generation of the channel (link2_channel_qjs.h) */

/* The running applet's channel: opened now when the link is up, and again
 * after every `ready` while the applet runs. `hash` is the running package's
 * footer hash, 16 hex digits. The channel's handle, or -1 when every slot is
 * taken. */
int link2_channel_open(Link2 *link, const char *app, const char *hash);
/* The applet exits or is switched away: channel.close `exit`; the handle is free. */
void link2_channel_exit(Link2 *link, int channel);
/* The applet's realm was reset: channel.close `reset`, then a new channel.open. */
void link2_channel_reset(Link2 *link, int channel);
/* LINK2_CHANNEL_*; `reason` gets the last close reason or refusal, "" for none. */
int link2_channel_state(const Link2 *link, int channel, const char **reason);
uint32_t link2_channel_generation(const Link2 *link, int channel);

#define LINK2_MESSAGE_EVENT 1    /* an event of the daemon; `stream` when it opens one */
#define LINK2_MESSAGE_PROGRESS 2 /* progress on the applet's request `id`; `stream` at the head step */
#define LINK2_MESSAGE_REPLY 3    /* the REPLY of the applet's request `id`; `error` for an error reply */
#define LINK2_MESSAGE_REQUEST 4  /* a request of the daemon; `stream` when it carries a body */
#define LINK2_MESSAGE_CANCEL 5   /* the daemon cancelled its request `id` */

typedef struct {
  int kind;
  uint32_t id;
  /* The JSON object, valid until the next call into the client. */
  const char *json;
  size_t length;
  /* A stream this message hands over, 0 for none: read it, or close it. */
  uint32_t stream;
  bool error;
} Link2Message;

/* One frame of the applet's loop begins: the per-frame budgets start again,
 * streams with a pending read get their share of 16 KiB of bytes in turn,
 * and the credit that became due is sent. */
void link2_channel_frame(Link2 *link, int channel);
/* The next message, inside the frame's budget of 4 messages or 8 KiB of JSON
 * (a first message whatever its size). False when none is due this frame. */
bool link2_channel_poll(Link2 *link, int channel, Link2Message *message);

/* A request of the applet: `json` is the whole object, {"t":…,…}. Its id in
 * `*id`. With `body`, bytes follow through link2_stream_write on that id. */
int link2_channel_request(Link2 *link, int channel, const char *json, size_t length, bool body, uint32_t *id);
/* CANCEL for a request of the applet. */
int link2_channel_cancel(Link2 *link, int channel, uint32_t id);
/* An event of the applet. With `stream` not NULL it opens a stream toward
 * the daemon, whose id `*stream` gets. */
int link2_channel_emit(Link2 *link, int channel, const char *json, size_t length, uint32_t *stream);
/* Progress on a request of the daemon; the first one is the head step that
 * opens its response stream. */
int link2_channel_progress(Link2 *link, int channel, uint32_t id, const char *json, size_t length);
/* The REPLY of a request of the daemon. LINK2_FULL while its response
 * stream still holds bytes: call again in a later frame. */
int link2_channel_reply(Link2 *link, int channel, uint32_t id, const char *json, size_t length, bool error);

/* Up to `capacity` bytes of an inbound stream. The count; 0 when the read is
 * pending (credit goes out for it); LINK2_STREAM_END; LINK2_STREAM_FAILED. */
long link2_stream_read(Link2 *link, int channel, uint32_t id, uint8_t *into, size_t capacity);
/* Bytes onto an outbound stream (a request's body, an event's stream, a
 * response after its head step): the count taken, 0 when its buffer is full,
 * or a negative code. */
long link2_stream_write(Link2 *link, int channel, uint32_t id, const uint8_t *bytes, size_t length);
/* No more bytes on an outbound stream. */
int link2_stream_end(Link2 *link, int channel, uint32_t id);
/* Abandons the streams of `id` on the sides named, each with RESET. A request's
 * id carries its body outbound and its response inbound: the applet that drops
 * a response it does not read keeps sending its body. */
#define LINK2_STREAM_IN 1
#define LINK2_STREAM_OUT 2
void link2_stream_close(Link2 *link, int channel, uint32_t id, int sides);

/* Counters for a status page and for tests. */
typedef struct {
  uint32_t links;
  uint32_t late_events;
  uint32_t logs_dropped;
  uint32_t read_pauses;
  uint32_t rtt_ms;
  uint32_t tx_peak;
  uint32_t fixed_bytes;   /* the buffers link2_create allocated */
  uint32_t channel_bytes; /* what open channels hold now */
  uint32_t channel_peak;
} Link2Stats;
const Link2Stats *link2_stats(const Link2 *link);

#endif
