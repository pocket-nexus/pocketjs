#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "pocket_runtime.h"
#ifdef __cplusplus
extern "C" {
#endif
/* What a program reads from an application before booting it
 * (programs/esp-idf/archive/src/package_facts.rs). Pointers borrow the
 * caller's bytes. app_id is the app id in UTF-8 without a terminator: the
 * bundle's identity, or the plan's app.id for stated sections.
 * package_hash and payload_hash are the bundle's footer and payload hashes,
 * 0 for stated sections. aux_width and aux_height are 0 without an auxiliary
 * surface. */
typedef struct {
  size_t struct_size;
  const uint8_t *javascript;
  size_t javascript_length;
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  const char *app_id;
  size_t app_id_length;
  uint64_t package_hash;
  uint64_t payload_hash;
  uint32_t view_width, view_height, raster_density, aux_width, aux_height;
} pocket_idf_package_facts;
/* Returns the POCKET_PACKAGE_OPEN_* codes of pocket_runtime.h.
 * POCKET_PACKAGE_OPEN_OK = admitted: the bundle's hashes, then its plan
 * against the exported profile facts (binding generation, raster density,
 * animation, rate, viewport, presentation, capabilities, auxiliary surface).
 * profile_hash is null or 32 bytes; admission does not compare it. The other
 * codes name a damaged bundle, the first failed admission item, a missing
 * identity or JavaScript section, a bad argument or a short record
 * (BAD_ARGUMENT), and a plan fact that cannot be read (PLAN_JSON,
 * PLAN_VIEWPORT, PLAN_AUXILIARY). Initialize out->struct_size. */
int32_t pocket_idf_package_open(const uint8_t *bytes, size_t length,
                                const pocket_profile_facts *facts,
                                uint32_t host_abi,
                                const uint8_t *profile_hash,
                                pocket_idf_package_facts *out);
/* The same facts for what a package source holds: a bundle, or the sections
 * its sections callback states (the app id is then the plan's app.id), read
 * as boot reads them without taking the source. SOURCE for a source that
 * does not supply its length, sections or bytes. javascript, pak, plan and
 * app_id borrow the bytes the source's all callback returned until the next
 * call on the source; a source without all is read through range into
 * memory this call releases, and the four pointers are NULL with their
 * lengths set. */
int32_t pocket_idf_package_open_source(const pocket_package_source_v1 *source,
                                       void *context,
                                       const pocket_profile_facts *facts,
                                       uint32_t host_abi,
                                       const uint8_t *profile_hash,
                                       pocket_idf_package_facts *out);
/* Whether the plan of an opened program turns the capability name on, a
 * registered id or one the host contract defines, compared as a string:
 * *enabled is true when the plan's features.<name> is true, false when it
 * is false or absent. Returns POCKET_PACKAGE_OPEN_OK with *enabled written;
 * BAD_ARGUMENT for a NULL or short record, a record whose plan is NULL, a
 * NULL or non-UTF-8 name, or a NULL enabled; PLAN_JSON, PLAN_VIEWPORT or
 * PLAN_AUXILIARY for plan bytes that cannot be read. name is NUL-terminated;
 * the plan bytes stay readable for the call. */
int32_t pocket_idf_package_feature(const pocket_idf_package_facts *facts,
                                   const char *name, bool *enabled);
#ifdef __cplusplus
}
#endif
