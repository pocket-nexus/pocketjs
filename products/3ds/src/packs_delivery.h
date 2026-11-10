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
 * caller's frame loop waits, and the connection that brought the line is
 * pumped meanwhile through `p3d_delivery_pump` (a disconnect, or L+R+START,
 * cancels and removes the partial file). SOC must be initialized.
 *
 * The delivery's control lines rode the development connection, which is
 * gone; Pocket Link 2 carries none yet (docs/POCKET-LINK.md §11), so no
 * program calls this today. A program that does supplies the pump.
 *
 * Returns false when `line` is not the delivery's. Otherwise writes the
 * answer's line to `reply` (the caller sends it back) and sets
 * `changed` when pocket.packs was replaced: the list of packs the program
 * read is stale, and the packs it holds may be. */
/* Supplied by the program on a 3DS: pumps the connection the line came over
 * and says whether its peer is still there. */
bool p3d_delivery_pump(void);

bool p3d_delivery(const char *line, const char *directory, char *reply,
                  size_t capacity, bool *changed);

#endif
