/*
 * What a native host provides to the sources in engine/host-services. Each
 * host implements every function declared here once (the 3DS in
 * products/3ds/src/services_host.c, the M5Stack Tab5 in pocket-nexus/pocket-m5
 * programs/m5stack-tab5/components/pocket_system/src/services_host.c); the
 * shared sources never name a platform API themselves.
 */

#ifndef POCKETJS_HOST_SERVICES_H
#define POCKETJS_HOST_SERVICES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// ---------------------------------------------------------------------------
// clocks and randomness
// ---------------------------------------------------------------------------

/* Monotonic milliseconds and microseconds from an arbitrary origin. */
uint64_t services_host_ms(void);
uint64_t services_host_us(void);
/* The console's wall clock in milliseconds since 1970 (UTC); whatever the
 * console believes, set or not. */
uint64_t services_host_epoch_ms(void);
/* Fresh bytes for nonces and the device id. */
void services_host_random(uint8_t *out, size_t length);

// ---------------------------------------------------------------------------
// packages (launcher.c, link.c)
// ---------------------------------------------------------------------------

/* The facts the launcher reads from one package: its plan JSON, its icon
 * set (section 9; length 0 without one), the hash that names it (the
 * .pocket footer) and its size in bytes. */
typedef struct {
  const char *plan;
  size_t plan_length;
  const uint8_t *icon;
  size_t icon_length;
  uint64_t hash;
  uint64_t bytes;
} LauncherPackage;

/* The directory holding one subdirectory per app slot (16 lowercase hex
 * digits), and the path of `name` inside slot `slot` (the slot directory
 * itself when `name` is NULL). */
const char *launcher_host_apps_directory(void);
bool launcher_host_slot_path(const char *slot, const char *name, char *out, size_t capacity);
/* The hash of the slot's committed package; false when it has none. */
bool launcher_host_active_hash(const char *slot, uint64_t *hash);
/* Load the slot's committed package `hash`. `*held` keeps `out`'s bytes alive
 * until services_host_release. */
bool launcher_host_load(const char *slot, uint64_t hash, LauncherPackage *out, void **held);
void services_host_release(void *held);

// ---------------------------------------------------------------------------
// the Pocket Link (link.c)
// ---------------------------------------------------------------------------

/* The target id the console names in its hello (the catalog's filter). */
const char *link_host_target(void);
/* The console's owner-facing name and model. */
void link_host_identity(char *name, size_t name_capacity, char *model, size_t model_capacity);
/* The link's state directory; its parent exists. */
const char *link_host_directory(void);
/* Sockets work now (the network is up); may start bringing it up. */
bool link_host_net_ready(void);
/* The console's IPv4 address, "" without one. */
void link_host_address(char *out, size_t capacity);

/* The staging file an install of `slot` streams into; creates the slot
 * directory. */
bool link_host_staging_path(const char *slot, char *out, size_t capacity);
/* Admit the completed staging file as the slot's package (`hash` is the
 * footer the companion declared) and commit it. On success `out`/`held` are
 * the installed package's facts, as from launcher_host_load. */
bool link_host_install(
  const char *slot,
  const char *path,
  uint64_t hash,
  LauncherPackage *out,
  void **held,
  char *error,
  size_t error_capacity
);
/* Delete an installed slot (its package and data); false when it is absent
 * or cannot be removed. The launcher has refused the running and home
 * slots before this is called. */
bool link_host_remove(const char *slot);

/* The agent channel rides the link on hosts with an agent: the link reports
 * its state and offers every ctrl and data frame first. Hosts without one
 * return false from both. */
void link_host_linked(bool up);
bool link_host_ctrl(const char *json, size_t length);
bool link_host_data(uint32_t stream, const uint8_t *bytes, size_t length);

#endif
