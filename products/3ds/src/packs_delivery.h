#ifndef POCKET3D_PACKS_DELIVERY_H
#define POCKET3D_PACKS_DELIVERY_H

#include <stdbool.h>
#include <stddef.h>

/* A game's packs brought to this console over the LAN, one piece a request
 * (tools/pocket3d-delivery.ts, docs/POCKET3D-PACKS.md). The computer sends one
 * control line a step over the paired connection, {"t":"pocket3d.packs",...}:
 *
 *   "piece"     fetch <name>.bin, unless a file of that name and size is there
 *   "manifest"  fetch the list and write it as pocket.packs
 *   "prune"     remove the pieces the list does not name
 *
 * The bytes come from a temporary HTTP endpoint on the computer that serves
 * the named pieces and nothing else. A step is handled to its end here: the
 * caller's frame loop waits, and the paired connection is pumped meanwhile (a
 * disconnect, or L+R+START, cancels and removes the partial file). SOC must
 * be initialized: the dev server did it.
 *
 * Returns false when `line` is not the delivery's. Otherwise writes the
 * answer's line to `reply` (send it with devserver_send_ctrl) and sets
 * `changed` when pocket.packs was replaced: the list of packs the program
 * read is stale, and the packs it holds may be. */
bool p3d_delivery(const char *line, const char *directory, char *reply,
                  size_t capacity, bool *changed);

#endif
