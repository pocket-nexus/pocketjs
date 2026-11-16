/*
 * `globalThis.link` on Pocket Link 2 (link2.h): the guest namespace that
 * version 1's link.c served itself, kept in its shape for packages built
 * against it (contracts/spec/link.ts LinkStatus and LinkEvent):
 *
 *   status()   one LinkStatus object
 *   forget(id) removes a pairing
 *   catalog()  one fetch of Hub's offer, every page gathered into one
 *              {"t":"catalog","id","apps"} event
 *   install(app) streams a package into the app's own slot and commits it:
 *              install.progress, install.done or error events
 *   remove(app)
 *   poll()     the events of this tick as one JSON array
 *
 * Pairing is written at the first install (docs/POCKET-LINK.md §3), so
 * `pair` has nothing to start: a host keeps the name and answers false.
 *
 * The host owns the client and binds it here. Without one (a capture or
 * offload build) the namespace reports an unpaired console and every request
 * is refused. link2_http.c serves the worker's HTTP stream (link_http.h) from
 * the same client.
 */

#ifndef POCKETJS_LINK2_GUEST_H
#define POCKETJS_LINK2_GUEST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "link2.h"

/* Fills the catalog, install and remove callbacks of `host`: Hub's
 * runtime.remove (docs/POCKET-LINK.md §6.2) takes the path of `remove(app)`. */
void link2_guest_host(Link2Host *host);
/* The client these calls ride; NULL before it exists and at shutdown. */
void link2_guest_bind(Link2 *link);
/* Guest switch: drops events and catalog waiters. An install keeps streaming
 * into storage; only its events stop. */
void link2_guest_reset(void);
/* Frees the buffers and closes every staging file. */
void link2_guest_shutdown(void);

/* Returned strings live until the next call of the same function. */
const char *link2_guest_status_json(void);
bool link2_guest_forget(const char *companion);
/* Pairing by a code (docs/POCKET-LINK.md §3.11), for a host whose device
 * shows it: `pairOpen()` makes a code and lists the Hubs on the network in
 * the status's `pair` member, `pairAsk(hub)` asks one of them, `pairClose()`
 * drops the code. */
bool link2_guest_pair_open(void);
bool link2_guest_pair_ask(const char *hub);
void link2_guest_pair_close(void);
int32_t link2_guest_catalog(void);
int32_t link2_guest_install(const char *app_id, size_t length);
bool link2_guest_remove(const char *app_id, size_t length);

/* What a removal did, for the guest's `remove(app)` (true for
 * LINK2_REMOVED alone) and for Hub's runtime.remove, which answers each other
 * outcome with its own error (docs/POCKET-LINK.md §6.2). */
typedef enum {
  LINK2_REMOVED,
  LINK2_REMOVE_HOME,       /* the launcher's slot: never removed */
  LINK2_REMOVE_RUNNING,    /* the running applet's slot */
  LINK2_REMOVE_NOT_FOUND,  /* no row of the launcher's table has the id */
  LINK2_REMOVE_INSTALLING, /* an install into the slot streams or waits to commit */
  LINK2_REMOVE_STORAGE,    /* link_host_remove failed */
} Link2RemoveOutcome;
Link2RemoveOutcome link2_guest_remove_app(const char *app_id, size_t length);
/* NULL when no event is waiting. */
const char *link2_guest_poll(void);
/* Once a pump, outside it: finishes an install whose last byte came before
 * its slot's folders existed (link_host_slot_ready). */
void link2_guest_service(void);

/* One line for a status page, e.g. "LINKED MACBOOK". */
void link2_guest_describe(char *out, size_t capacity);

/* The worker's HTTP stream (link2_http.c): fills the net.http callbacks of
 * `host`, and takes the client. link_http.h declares the worker's calls. */
void link2_http_host(Link2Host *host);
void link2_http_bind(Link2 *link);

#endif
