#ifndef POCKET_LINK2_CHANNEL_QJS_H
#define POCKET_LINK2_CHANNEL_QJS_H

/*
 * `globalThis.link.channel` for a QuickJS guest (docs/POCKET-LINK.md §7.3): one
 * call per operation, over link2.h's channel and stream calls.
 *
 * A handle the guest holds for a request or a stream is a number: the wire id
 * in its low 32 bits and the channel's generation (its low 21 bits) above
 * them. Wire ids start again at every connection, so an id alone would name
 * another request after a reconnect; a handle of an earlier generation is
 * refused with LINK2_STALE and reaches nothing of the channel that is open
 * now. The state's `generation` is the whole number Hub assigned.
 */

#include <quickjs.h>
#include <stddef.h>

#include "link2.h"

typedef enum {
  LINK2_QJS_STATE,    /* state() -> JSON string */
  LINK2_QJS_POLL,     /* poll() -> JSON string, or undefined */
  LINK2_QJS_REQUEST,  /* request(json, body) -> handle, or a code */
  LINK2_QJS_CANCEL,   /* cancel(handle) -> code */
  LINK2_QJS_EMIT,     /* emit(json, stream) -> 0 or the stream's handle, or a code */
  LINK2_QJS_PROGRESS, /* progress(handle, json) -> code */
  LINK2_QJS_REPLY,    /* reply(handle, json, error) -> code */
  LINK2_QJS_READ,     /* read(handle, into) -> bytes, 0 while pending, or a code */
  LINK2_QJS_WRITE,    /* write(handle, bytes) -> bytes taken, or a code */
  LINK2_QJS_END,      /* end(handle) -> code */
  LINK2_QJS_CLOSE,    /* close(handle, outbound): the inbound stream, or the outbound one */
} Link2QjsOperation;

/* A polled message is at most LINK_APP_MSG plus this head. */
#define LINK2_QJS_SCRATCH_BYTES (8192u + 128u)

/* `client` NULL or `channel` below 0: the guest has no channel now. `scratch`
 * holds one polled message. No call leaves an exception pending: a value that
 * does not convert gives LINK2_MALFORMED. */
JSValue link2_channel_qjs(JSContext *ctx, Link2 *client, int channel, Link2QjsOperation operation,
                          int argc, JSValueConst *argv, char *scratch, size_t scratch_bytes);

#endif
