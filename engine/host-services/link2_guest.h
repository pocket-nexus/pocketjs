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

/* Fills the catalog and install callbacks of `host`. */
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
int32_t link2_guest_catalog(void);
int32_t link2_guest_install(const char *app_id, size_t length);
bool link2_guest_remove(const char *app_id, size_t length);
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
